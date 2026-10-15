import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as undiciRequest } from 'undici';
import Busboy from 'busboy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AyaError,
  AyaErrors,
  SseUsageStreamParser,
  extractUsage,
  newRequestId,
  type BackendConfig,
  type ModelConfig,
  type ProxyConfig,
  type RequestLog,
  type Usage,
} from '@aya/core';
import type { BackendManager, Lease } from '../backend/manager.js';
import { runCli, type CliRunOptions } from '../backend/cli-runner.js';
import type { StatsWriter } from '../stats/writer.js';
import type { VoiceStore } from '../voices/store.js';
import { logger } from '../log.js';
import type { PeekedRequest } from './peek.js';
import { sanitizeRaw } from './peek.js';
import { estimateTokens } from './estimate.js';

export interface ForwardContext {
  endpoint: string; // chat | completion | embedding | image | asr | tts
  req: FastifyRequest;
  reply: FastifyReply;
  manager: BackendManager;
  stats: StatsWriter;
  proxyCfg: ProxyConfig;
  keyId?: string;
  voices?: VoiceStore;
}

// content-length 在转发时按客户端声明重新显式带上（见 forward 内的说明），
// 这里先摘掉再由业务代码决定是否回填
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'content-length', 'host',
]);

/** 转发响应头白名单（其余透传） */
const DROP_RESP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

/**
 * 核心转发：透传请求体流 → 上游；响应按类型分流回传（SSE/二进制/JSON）。
 * 记录 TTFT / usage / 字节数，组装 RequestLog 异步落库。
 */
export async function forward(
  ctx: ForwardContext,
  model: ModelConfig,
  backend: BackendConfig,
  peeked: PeekedRequest,
): Promise<void> {
  const { req, reply, manager, stats, endpoint } = ctx;
  const requestId = newRequestId();
  const tsStart = Date.now();
  reply.header('X-Aya-Request-Id', requestId);

  const clientAddr =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || '';

  let lease: Lease | undefined;
  let queueMs = 0;
  let usage: Usage | undefined;
  let ttftMs: number | undefined;
  let statusCode = 500;
  let errorMsg: string | undefined;
  let isStream = false;
  let reqSummary: Record<string, unknown> = {};
  let reqBytes = 0;
  let respBytes = 0;
  let backendMs = 0;
  let backendTtfb = 0;
  let tokensEstimated = false;
  // 失败排障：请求体头部（peek 阶段捕获）+ 上游错误响应头部（observer 捕获）
  const rawCfg = ctx.proxyCfg.log_raw_on_error ? ctx.proxyCfg.raw_log_max_bytes : 0;
  let reqRaw = rawCfg ? peeked.rawHead : undefined;
  let respRaw: string | undefined;
  const respHead: Buffer[] = [];
  let respHeadSize = 0;

  const finish = (code: number, err?: string): void => {
    const tsEnd = Date.now();
    const failed = !(code >= 200 && code < 400);
    const log: RequestLog = {
      request_id: requestId,
      ts_start: tsStart,
      ts_end: tsEnd,
      client_addr: clientAddr,
      key_id: ctx.keyId,
      endpoint,
      model: model.name,
      backend: backend.name,
      is_stream: isStream,
      status_code: code,
      ok: code >= 200 && code < 400,
      error: err,
      latency_ms: tsEnd - tsStart,
      backend_ms: backendMs,
      ttft_ms: ttftMs,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      cached_tokens: usage?.cached_tokens,
      tokens_estimated: tokensEstimated,
      req_bytes: reqBytes,
      resp_bytes: respBytes,
      req_summary: reqSummary,
      req_raw: failed && reqRaw ? reqRaw.slice(0, rawCfg || undefined) : undefined,
      resp_raw: failed && respRaw ? respRaw : undefined,
      timeline: { queue: queueMs, backend_start: 0, backend_ttfb: backendTtfb, total: tsEnd - tsStart },
    };
    stats.enqueue(log);
  };

  try {
    // 1. 使用路由层已窥探的结果（model/stream/摘要 + 可转发流）
    isStream = peeked.stream === true;
    reqSummary = peeked.fields;
    const upstreamBody = peeked.body;

    // 2. 租约（可能触发冷启动，请求在此等待就绪）
    const tAcquire0 = Date.now();
    lease = await manager.acquire(backend.name);
    queueMs = Date.now() - tAcquire0;

    // 3. 转发
    const targetUrl = upstreamUrl(backend, req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (v !== undefined) headers[lk] = Array.isArray(v) ? v.join(', ') : v;
    }
    // Content-Length 必须显式带上（它在 HOP_BY_HOP 里被丢掉了）：
    // undici 只有在 body 流「已全部缓冲且已 end」时才推得出长度，否则退化成
    // Transfer-Encoding: chunked。而 gufo 不实现 chunked 请求体，收到该头直接
    // 400 malformed request（gufo src/cli/serve/http_server.cpp ParseContentLength）。
    // body 是逐字节透传的，客户端声明的长度就是上游要读的长度。
    const rawClientLen = req.headers['content-length'];
    const clientLen = Array.isArray(rawClientLen) ? rawClientLen[0] : rawClientLen;
    if (clientLen) {
      headers['content-length'] = clientLen;
      reqBytes = Number(clientLen) || 0;
    }
    if (backend.auth) headers[backend.auth.header] = backend.auth.value;

    const abort = new AbortController();
    const tBackend0 = Date.now();
    let upstreamRes;
    try {
      upstreamRes = await undiciRequest(targetUrl, {
        method: req.method as never,
        headers,
        body: upstreamBody as unknown as Readable,
        signal: abort.signal,
        headersTimeout: Math.min(backend.start_timeout_ms, 300_000),
        bodyTimeout: ctx.proxyCfg.idle_response_timeout_ms,
      });
    } catch (e) {
      backendMs = Date.now() - tBackend0;
      const msg = (e as Error).message;
      if (msg.includes('connect') || msg.includes('ECONNREFUSED') || msg.includes('socket hang up')) {
        throw AyaErrors.backendStartFailed(backend.name, `upstream unreachable: ${msg}`);
      }
      throw AyaErrors.backendStartFailed(backend.name, msg);
    }
    statusCode = upstreamRes.statusCode;
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      const lk = k.toLowerCase();
      if (DROP_RESP_HEADERS.has(lk)) continue;
      if (v !== undefined) respHeaders[lk] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const respCt = String(respHeaders['content-type'] ?? '');
    isStream = isStream || respCt.includes('text/event-stream');

    reply.raw.writeHead(statusCode, {
      ...respHeaders,
      'x-aya-request-id': requestId,
      ...(isStream ? { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } : {}),
    });

    backendTtfb = Date.now() - tBackend0;

    // 4. 旁路观察：usage / TTFT / 字节计数，不改写字节流
    const sseParser = new SseUsageStreamParser();
    let jsonBuf = '';
    let firstByte = true;
    const isErrResp = statusCode >= 400;
    const observer = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (firstByte) {
          ttftMs = Date.now() - tsStart;
          firstByte = false;
        }
        respBytes += chunk.length;
        if (rawCfg && isErrResp && respHeadSize < rawCfg) {
          respHead.push(chunk);
          respHeadSize += chunk.length;
        }
        if (respCt.includes('text/event-stream')) {
          sseParser.feed(chunk.toString('utf8'));
        } else if (respCt.includes('application/json') && jsonBuf.length < 1_000_000) {
          jsonBuf += chunk.toString('utf8');
        }
        cb(null, chunk);
      },
      flush(cb) {
        sseParser.flush();
        usage = sseParser.usage;
        if (rawCfg && isErrResp && respHeadSize > 0) {
          respRaw = sanitizeRaw(Buffer.concat(respHead).toString('utf8').slice(0, rawCfg));
        }
        if (!usage && jsonBuf) {
          try {
            usage = extractUsage(JSON.parse(jsonBuf));
          } catch {
            /* ignore */
          }
        }
        cb();
      },
    });

    const clientAbort = (): void => abort.abort();
    reply.raw.on('close', clientAbort);
    let clientGone = false;
    try {
      await pipeline(upstreamRes.body as unknown as NodeJS.ReadableStream, observer, reply.raw);
    } catch (e) {
      const msg = (e as Error).message ?? '';
      // 客户端断开：reply 已销毁且未正常写完（含 head -c 提前断开、AbortError、Premature close）
      clientGone = (reply.raw.destroyed && !reply.raw.writableEnded) || (e as Error).name === 'AbortError';
      if (clientGone || msg.includes('abort') || msg.includes('Premature close') || msg.includes('aborted')) {
        errorMsg = 'client_abort';
        statusCode = 499;
      } else if (msg.includes('body timeout') || (e as Error).name === 'BodyTimeoutError') {
        errorMsg = 'upstream_stall';
        statusCode = 502;
      } else {
        errorMsg = msg || (e as Error).name;
        statusCode = 502;
      }
      logger.debug({ err: e, requestId }, 'stream pipeline ended with error');
    } finally {
      reply.raw.off('close', clientAbort);
      backendMs = Date.now() - tBackend0;
      // pipeline 中途出错时 flush 可能未执行：兜底固化已捕获的错误响应头部
      if (rawCfg && isErrResp && !respRaw && respHeadSize > 0) {
        respRaw = sanitizeRaw(Buffer.concat(respHead).toString('utf8').slice(0, rawCfg));
      }
    }

    // 5. 无 usage 时本地估算兜底（chat/completion）
    if (!usage?.total_tokens && (endpoint === 'chat' || endpoint === 'completion') && statusCode === 200) {
      const est = estimateTokens(jsonBuf);
      if (est) {
        usage = est.usage;
        tokensEstimated = true;
      }
    }
    // 上游返回 4xx/5xx：error 列提取上游错误信息（列表页直接可读）
    if (statusCode >= 400 && !errorMsg) {
      errorMsg = upstreamErrorBrief(jsonBuf, statusCode);
    }
    finish(statusCode, errorMsg);
  } catch (err) {
    const e = err instanceof AyaError ? err : new AyaError(500, 'server_error', 'internal', (err as Error).message);
    statusCode = e.status;
    errorMsg = e.code;
    if (!reply.sent && !reply.raw.headersSent) {
      reply.code(e.status).type('application/json').send(e.toJSON());
    }
    finish(statusCode, errorMsg);
  } finally {
    lease?.release();
  }
}

/** 上游 4xx/5xx 响应体 → error 列简报（优先 OpenAI 风格 error.message，否则截断原文） */
function upstreamErrorBrief(body: string, status: number): string {
  if (body) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      const err = j?.error as Record<string, unknown> | undefined;
      const msg = typeof err?.message === 'string' ? err.message : typeof j?.message === 'string' ? j.message : undefined;
      const code = typeof err?.code === 'string' ? err.code : undefined;
      if (msg) return `upstream_error: ${code ? `${code}: ` : ''}${msg.slice(0, 300)}`;
    } catch {
      /* 非 JSON 错误体 */
    }
    return `upstream_error: ${body.slice(0, 300)}`;
  }
  return `upstream_error: http ${status}`;
}

/** base_url 已含 /v1 前缀；originalUrl 去掉 /v1 避免重复 */
export function upstreamUrl(backend: BackendConfig, originalUrl: string): string {
  const base = new URL(backend.base_url!);
  const basePath = base.pathname.replace(/\/+$/, '');
  let path = originalUrl.split('?')[0]!;
  if (path.startsWith('/v1/')) path = path.slice(3);
  const url = new URL(basePath + path, base);
  const q = originalUrl.split('?')[1];
  if (q) url.search = q;
  return url.toString();
}

/** 读取整个流为 Buffer（上限 maxBytes，超限 413） */
async function readAll(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw AyaErrors.payloadTooLarge(maxBytes);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * cli 型后端转发：请求体整体缓冲 → 按端点提取参数 → spawn 一次性命令生成文件 → 读回并回传。
 * - tts：input/voice → 音频文件，Content-Type = output_content_type（默认 audio/wav）。
 * - image：prompt/size/n/seed → OpenAI images JSON（b64_json 数组）。
 */
export async function forwardCli(
  ctx: ForwardContext,
  model: ModelConfig,
  backend: BackendConfig,
  peeked: PeekedRequest,
): Promise<void> {
  const { req, reply, manager, stats } = ctx;
  const requestId = newRequestId();
  const tsStart = Date.now();
  reply.header('X-Aya-Request-Id', requestId);
  const clientAddr =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || '';

  let lease: Lease | undefined;
  let queueMs = 0;
  let statusCode = 500;
  let errorMsg: string | undefined;
  let reqBytes = 0;
  let respBytes = 0;
  let backendMs = 0;
  let reqSummary: Record<string, unknown> = peeked.fields;
  const rawCfg = ctx.proxyCfg.log_raw_on_error ? ctx.proxyCfg.raw_log_max_bytes : 0;
  let reqRaw = rawCfg ? peeked.rawHead : undefined;

  const finish = (code: number, err?: string): void => {
    const tsEnd = Date.now();
    stats.enqueue({
      request_id: requestId,
      ts_start: tsStart,
      ts_end: tsEnd,
      client_addr: clientAddr,
      key_id: ctx.keyId,
      endpoint: ctx.endpoint,
      model: model.name,
      backend: backend.name,
      is_stream: false,
      status_code: code,
      ok: code >= 200 && code < 400,
      error: err,
      latency_ms: tsEnd - tsStart,
      backend_ms: backendMs,
      tokens_estimated: false,
      req_bytes: reqBytes,
      resp_bytes: respBytes,
      req_summary: reqSummary,
      req_raw: err && reqRaw ? reqRaw.slice(0, rawCfg || undefined) : undefined,
      timeline: { queue: queueMs, backend_start: 0, backend_ttfb: backendMs, total: tsEnd - tsStart },
    });
  };

  try {
    // 1. 整体缓冲请求体
    const bodyBuf = await readAll(peeked.body, ctx.proxyCfg.max_upload_bytes);
    reqBytes = bodyBuf.length;

    // 2. 按端点解析参数 → runCli 选项
    let runOpts: CliRunOptions;
    let render: (r: import('../backend/cli-runner.js').CliRunResult) => void;
    if (ctx.endpoint === 'image') {
      const contentType = String(req.headers['content-type'] ?? '');
      let prompt = '';
      let size: unknown;
      let nRaw: unknown;
      let seedRaw: unknown;
      let negative: unknown;
      let refs: { ext: string; data: Buffer }[] = [];
      if (contentType.startsWith('multipart/')) {
        // /v1/images/edits（OpenAI multipart）：prompt 字段 + image/image[] 文件部分
        const mp = await parseMultipartBuffered(bodyBuf, req.headers);
        prompt = mp.fields.prompt ?? '';
        size = mp.fields.size;
        nRaw = mp.fields.n;
        seedRaw = mp.fields.seed;
        negative = mp.fields.negative_prompt;
        refs = mp.refs;
      } else {
        const j = parseJson(bodyBuf);
        prompt = typeof j.prompt === 'string' ? j.prompt : '';
        size = j.size;
        nRaw = j.n;
        seedRaw = j.seed;
        negative = j.negative_prompt;
        // JSON 形态的编辑请求（如 OpenAI SDK images.edit 走 JSON 时）：image 为 base64 字符串或其数组
        refs = decodeRefImages(j.image ?? j.image_b64);
      }
      if (!prompt.trim()) {
        throw AyaErrors.invalidRequest(
          contentType.startsWith('multipart/') ? 'missing "prompt" field for image edit' : 'missing "prompt" for image generation',
          'prompt',
        );
      }
      const { width, height } = parseSize(size);
      const n = Number.isInteger(Number(nRaw)) && Number(nRaw) >= 1 ? Number(nRaw) : 1;
      const seed = seedRaw !== undefined && seedRaw !== null && seedRaw !== '' ? String(seedRaw) : '-1';
      reqSummary = {
        ...reqSummary,
        prompt_chars: prompt.length,
        size: size ?? `${width}x${height}`,
        n,
        ...(refs.length ? { ref_images: refs.length } : {}),
      };
      reqRaw = rawCfg ? reqRaw ?? prompt.slice(0, rawCfg) : reqRaw;
      runOpts = {
        vars: {
          prompt,
          width: String(width),
          height: String(height),
          seed,
          batch_count: String(n),
          negative_prompt: typeof negative === 'string' ? negative : '',
        },
        refImages: refs,
        outputPattern: 'output_%03d.png',
      };
      render = (r) => {
        respBytes = r.outputs.reduce((s, b) => s + b.length, 0);
        statusCode = 200;
        reply.code(200).type('application/json').send({
          created: Math.floor(tsStart / 1000),
          data: r.outputs.map((b) => ({ b64_json: b.toString('base64') })),
        });
      };
    } else {
      // tts
      let inputText: string | undefined;
      let voice: string | undefined;
      const j = tryParseJson(bodyBuf);
      if (j) {
        if (typeof j.input === 'string') inputText = j.input;
        if (typeof j.voice === 'string' && j.voice.trim()) voice = j.voice.trim();
        if (inputText !== undefined) reqSummary.input_chars = inputText.length;
      } else {
        inputText = bodyBuf.toString('utf8'); // 非 JSON：整段作为文本
      }
      if (!inputText?.trim()) throw AyaErrors.invalidRequest('missing "input" text for tts');
      reqRaw = rawCfg ? reqRaw ?? inputText.slice(0, rawCfg) : reqRaw;
      let speakerFile: string | undefined;
      if (voice) {
        const v = ctx.voices?.get(voice) ?? ctx.voices?.findByName(voice);
        if (!v) throw AyaErrors.voiceNotFound(voice);
        speakerFile = v.path;
        reqSummary.voice = v.id;
      }
      runOpts = { inputText, speakerFile };
      render = (r) => {
        respBytes = r.output.length;
        statusCode = 200;
        reply
          .code(200)
          .header('content-type', backend.output_content_type ?? 'audio/wav')
          .header('content-length', respBytes)
          .send(r.output);
      };
    }

    // 3. 租约（并发闸门 + 内存准入）
    const tAcquire0 = Date.now();
    lease = await manager.acquireCli(backend.name);
    queueMs = Date.now() - tAcquire0;

    // 4. 执行一次性命令
    const tBackend0 = Date.now();
    let result;
    try {
      result = await runCli(backend, manager.logDir, runOpts);
      backendMs = Date.now() - tBackend0;
    } catch (e) {
      backendMs = Date.now() - tBackend0;
      throw e;
    }

    // 5. 回传
    render(result);
    finish(200);
  } catch (err) {
    const e = err instanceof AyaError ? err : new AyaError(500, 'server_error', 'internal', (err as Error).message);
    statusCode = e.status;
    errorMsg = e.code === 'internal' ? e.message : e.code;
    if (!reply.sent && !reply.raw.headersSent) {
      reply.code(e.status).type('application/json').send(e.toJSON());
    }
    finish(statusCode, errorMsg);
  } finally {
    lease?.release();
  }
}

function tryParseJson(buf: Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 图片文件魔数 → 扩展名（sd-cli 用 stb_image 按内容解码，扩展名仅示意；未知按 .png） */
function imageExt(data: Buffer, mime?: string, filename?: string): string {
  if (data.subarray(0, 4).toString('hex') === '89504e47') return '.png';
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return '.jpg';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (data.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif';
  if (data.subarray(0, 4).toString('hex') === '49492a00' || data.subarray(0, 4).toString('hex') === '4d4d002a') return '.tif';
  const m = /image\/(png|jpeg|jpg|webp|gif|tiff?)/.exec(mime ?? '');
  if (m) return m[1] === 'jpeg' || m[1] === 'jpg' ? '.jpg' : m[1] === 'tiff' ? '.tif' : `.${m[1]}`;
  const f = /\.(\w{3,4})$/.exec(filename ?? '');
  if (f) return `.${f[1]!.toLowerCase()}`;
  return '.png';
}

/** JSON 请求里的 base64 参考图：字符串或其数组 → 落盘条目 */
function decodeRefImages(v: unknown): { ext: string; data: Buffer }[] {
  const list = Array.isArray(v) ? v : v !== undefined && v !== null ? [v] : [];
  const refs: { ext: string; data: Buffer }[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item) continue;
    const b64 = item.includes(',') && /^data:image\//i.test(item) ? item.slice(item.indexOf(',') + 1) : item;
    const data = Buffer.from(b64, 'base64');
    if (data.length === 0) continue;
    refs.push({ ext: imageExt(data), data });
  }
  return refs;
}

/** 已缓冲的 multipart 请求体解析（image edits）：文本字段 + image/image[] 文件部分（可多个） */
function parseMultipartBuffered(
  bodyBuf: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ fields: Record<string, string>; refs: { ext: string; data: Buffer }[] }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const refs: { ext: string; data: Buffer }[] = [];
    const bb = Busboy({
      headers: headers as Record<string, string>,
      limits: { fileSize: 1024 * 1024 * 1024, files: 16 },
    });
    bb.on('field', (name: string, val: string) => {
      if (fields[name] === undefined) fields[name] = val;
    });
    bb.on('file', (name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const isImage = name === 'image' || name === 'image[]' || name === 'image[0]';
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => {
        if (isImage) chunks.push(c);
      });
      stream.on('end', () => {
        if (isImage && chunks.length) {
          const data = Buffer.concat(chunks);
          refs.push({ ext: imageExt(data, info.mimeType, info.filename), data });
        }
      });
      stream.resume();
    });
    bb.on('close', () => resolve({ fields, refs }));
    bb.on('error', (e: Error) => reject(AyaErrors.invalidRequest(`multipart parse failed: ${e.message}`)));
    Readable.from(bodyBuf).pipe(bb);
  });
}

function parseJson(buf: Buffer): Record<string, unknown> {
  return tryParseJson(buf) ?? {};
}

/** OpenAI size 字段 "WxH"（缺省 1024x1024） */
function parseSize(size: unknown): { width: number; height: number } {
  if (typeof size === 'string') {
    const m = /^(\d+)x(\d+)$/.exec(size.trim());
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  }
  return { width: 1024, height: 1024 };
}
