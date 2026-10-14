import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as undiciRequest } from 'undici';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AyaError,
  AyaErrors,
  SseUsageStreamParser,
  extractUsage,
  newRequestId,
  type BackendConfig,
  type ModelConfig,
  type RequestLog,
  type Usage,
} from '@aya/core';
import type { BackendManager, Lease } from '../backend/manager.js';
import type { StatsWriter } from '../stats/writer.js';
import { logger } from '../log.js';
import type { PeekedRequest } from './peek.js';
import { estimateTokens } from './estimate.js';

export interface ForwardContext {
  endpoint: string; // chat | completion | embedding | image | asr | tts
  req: FastifyRequest;
  reply: FastifyReply;
  manager: BackendManager;
  stats: StatsWriter;
  proxyCfg: { idle_response_timeout_ms: number; max_upload_bytes: number };
  keyId?: string;
}

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

  const finish = (code: number, err?: string): void => {
    const tsEnd = Date.now();
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
    if (backend.auth) headers[backend.auth.header] = backend.auth.value;

    const abort = new AbortController();
    const reqCounter = new Transform({
      transform(c: Buffer, _e, cb) {
        reqBytes += c.length;
        cb(null, c);
      },
    });
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
    const observer = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (firstByte) {
          ttftMs = Date.now() - tsStart;
          firstByte = false;
        }
        respBytes += chunk.length;
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
    }

    // 5. 无 usage 时本地估算兜底（chat/completion）
    if (!usage?.total_tokens && (endpoint === 'chat' || endpoint === 'completion') && statusCode === 200) {
      const est = estimateTokens(jsonBuf);
      if (est) {
        usage = est.usage;
        tokensEstimated = true;
      }
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
