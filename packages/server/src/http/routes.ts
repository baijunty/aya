import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Busboy from 'busboy';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  AyaError,
  AyaErrors,
  newRequestId,
  nowMs,
  type AppConfig,
  type ModelConfig,
  type ModelKind,
} from '@aya/core';
import type { BackendManager } from '../backend/manager.js';
import type { ResourceManager } from '../resource/manager.js';
import type { StatsWriter } from '../stats/writer.js';
import type { StatsStore } from '../stats/store.js';
import { VoiceStore } from '../voices/store.js';
import type { AuthManager } from './auth.js';
import { SessionStore, sessionCookie, sessionCookieHeader } from './sessions.js';
import { forward, forwardCli } from '../proxy/forwarder.js';
import { peekRequest } from '../proxy/peek.js';
import {
  querySummary,
  querySeries,
  queryRequests,
  queryRequestDetail,
  queryBackendStats,
  queryEvents,
  purgeBefore,
  autoGranularity,
  type Granularity,
  type Metric,
} from '../stats/queries.js';
import { logger } from '../log.js';

export interface AppDeps {
  config: () => AppConfig;
  router: () => import('@aya/core').ModelRouter;
  manager: BackendManager;
  resources: ResourceManager;
  stats: StatsWriter;
  store: StatsStore;
  voices: VoiceStore;
  auth: AuthManager;
  sessions: SessionStore;
  loadModel: (name: string, wait: boolean, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
  unloadModel: (name: string, force: boolean) => Promise<{ status: number; body: unknown }>;
  reloadConfig: () => Promise<{ status: number; body: unknown }>;
}

const ENDPOINT_BY_PATH: Record<string, string> = {
  '/v1/chat/completions': 'chat',
  '/v1/completions': 'completion',
  '/v1/embeddings': 'embedding',
  '/v1/images/generations': 'image',
  '/v1/images/edits': 'image',
  '/v1/audio/transcriptions': 'asr',
  '/v1/audio/translations': 'asr',
  '/v1/audio/speech': 'tts',
  // llama.cpp TypeSafe-compatible System One API（决策模型，非流式）
  '/v1/systemone': 'systemone',
};

/**
 * /v1/models 的 architecture（llama.cpp 语义）：客户端用
 * `architecture?.output_modalities?.includes("decisions")` 识别原生决策模型，
 * 其余值仅为信息性默认（模型可用 input_modalities 配置覆盖，如多模态决策模型）。
 */
const ARCH_BY_KIND: Record<ModelKind, { input: string[]; output: string[] }> = {
  chat: { input: ['text'], output: ['text'] },
  completion: { input: ['text'], output: ['text'] },
  embedding: { input: ['text'], output: ['text'] },
  image: { input: ['text'], output: ['image'] },
  asr: { input: ['audio'], output: ['text'] },
  tts: { input: ['text'], output: ['audio'] },
  decision: { input: ['text'], output: ['decisions'] },
};

function parseRange(q: Record<string, string | undefined>): { from: number; to: number } {
  const to = q.to ? Number(q.to) : nowMs();
  const from = q.from ? Number(q.from) : to - 7 * 86400_000;
  return { from, to };
}

function sendError(reply: FastifyReply, err: unknown): void {
  const e = err instanceof AyaError
    ? err
    : new AyaError(500, 'server_error', 'internal', (err as Error).message ?? 'internal error');
  if (!reply.sent) reply.code(e.status).type('application/json').send(e.toJSON());
}

/** multipart 请求体解析（busboy）：字段 + 单个文件部分，整体受 maxBytes 限制 */
function parseMultipart(
  req: FastifyRequest,
  maxBytes: number,
): Promise<{ fields: Record<string, string>; file?: { buf: Buffer; filename: string; mimeType: string } }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let file: { buf: Buffer; filename: string; mimeType: string } | undefined;
    let total = 0;
    let overflow = false;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1 } });
    const bump = (n: number) => {
      total += n;
      if (total > maxBytes) {
        overflow = true;
        bb.destroy();
      }
    };
    bb.on('field', (name: string, val: string) => {
      fields[name] = val;
      bump(Buffer.byteLength(val));
    });
    bb.on('file', (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => {
        chunks.push(c);
        bump(c.length);
      });
      stream.on('end', () => {
        if (!file) {
          file = { buf: Buffer.concat(chunks), filename: info.filename, mimeType: info.mimeType };
        }
      });
    });
    bb.on('close', () => (overflow ? reject(AyaErrors.payloadTooLarge(maxBytes)) : resolve({ fields, file })));
    bb.on('error', (e: Error) =>
      reject(overflow ? AyaErrors.payloadTooLarge(maxBytes) : AyaErrors.invalidRequest(`multipart parse failed: ${e.message}`)),
    );
    req.raw.pipe(bb);
  });
}

/** 未进入转发的拦截请求（鉴权失败 / 缺 model / 路由失败 / peek 失败）也写入统计，看板可查 */
function recordRejected(o: {
  deps: AppDeps;
  req: FastifyRequest;
  endpoint: string;
  keyId?: string;
  model?: string;
  backend?: string;
  err: unknown;
  tsStart: number;
  reqRaw?: string;
}): void {
  const { deps } = o;
  try {
    const e = o.err instanceof AyaError
      ? o.err
      : new AyaError(500, 'server_error', 'internal', (o.err as Error)?.message ?? 'internal error');
    const tsEnd = nowMs();
    deps.stats.enqueue({
      request_id: newRequestId(),
      ts_start: o.tsStart,
      ts_end: tsEnd,
      client_addr:
        (o.req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || o.req.ip || '',
      key_id: o.keyId,
      endpoint: o.endpoint,
      model: o.model ?? '',
      backend: o.backend ?? '',
      is_stream: false,
      status_code: e.status,
      ok: false,
      error: e.code,
      latency_ms: tsEnd - o.tsStart,
      backend_ms: 0,
      tokens_estimated: false,
      req_bytes: 0,
      resp_bytes: 0,
      req_summary: { intercepted: true },
      req_raw: o.reqRaw,
      timeline: { queue: 0, backend_start: 0, backend_ttfb: 0, total: tsEnd - o.tsStart },
    });
  } catch {
    /* 统计写入失败不影响错误应答 */
  }
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  // —— 全局错误处理：AyaError → OpenAI 风格错误体 ——
  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    // 透传场景 body 是原始流：错误时确保消费，避免连接悬挂
    const raw = req.raw;
    if (raw.readable) raw.resume();
    const e = err instanceof AyaError ? err : new AyaError(500, 'server_error', 'internal', err.message);
    if (!reply.sent) reply.code(e.status).type('application/json').send(e.toJSON());
  });

  // —— 鉴权 preHandler（失败抛错，由全局 error handler 序列化）——
  // 注意：本 Fastify 版本下同步 preHandler 会挂起，必须 async
  // 放行条件（任一）：Bearer API Key 命中（api_keys 非空时）；有效登录会话（ui_auth 配置时）；
  // 两者都未配置 → 全放行（本地默认）。
  const guard = async (req: FastifyRequest): Promise<void> => {
    const keyId = deps.auth.enabled ? deps.auth.authenticate(req.headers.authorization) : undefined;
    if (keyId) {
      (req as FastifyRequest & { keyId?: string }).keyId = keyId;
      return;
    }
    if (deps.sessions.enabled) {
      const user = deps.sessions.verify(sessionCookie(req));
      if (user) {
        (req as FastifyRequest & { keyId?: string }).keyId = `ui:${user}`;
        return;
      }
    }
    if (!deps.auth.enabled && !deps.sessions.enabled) return;
    const err = deps.sessions.enabled ? AyaErrors.sessionExpired() : AyaErrors.invalidApiKey();
    recordRejected({
      deps, req, endpoint: ENDPOINT_BY_PATH[req.url.split('?')[0]!] ?? req.url,
      err, tsStart: nowMs(),
    });
    throw err;
  };

  // —— 健康检查（不鉴权）——
  app.get('/healthz', async () => {
    const backends = deps.manager.allStatus() as Array<Record<string, unknown>>;
    const degraded = backends.some((b) => b.state === 'crashed');
    return {
      status: degraded ? 'degraded' : 'ok',
      uptime_s: Math.floor(process.uptime()),
      backends: backends.map((b) => ({
        name: b.name,
        state: b.state,
        inflight: b.inflight,
        idle_remaining_ms: b.idle_remaining_ms,
      })),
    };
  });

  // —— 看板登录（ui_auth 配置后启用；不鉴权，供前端换取会话 Cookie）——
  app.post('/api/v1/auth/login', async (req, reply) => {
    try {
      if (!deps.sessions.enabled) {
        throw AyaErrors.invalidRequest('ui_auth is not configured on this server');
      }
      // 全局透传解析器把 body 留成原始流，这里自行缓冲 JSON
      const chunks: Buffer[] = [];
      for await (const c of req.raw) chunks.push(c as Buffer);
      let body: { username?: unknown; password?: unknown } = {};
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw AyaErrors.invalidRequest('request body must be JSON');
        }
      }
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const sess = deps.sessions.login(username, password);
      if (!sess) {
        recordRejected({ deps, req, endpoint: 'auth_login', err: AyaErrors.invalidCredentials(), tsStart: nowMs() });
        throw AyaErrors.invalidCredentials();
      }
      reply.header('set-cookie', sessionCookieHeader(sess.token, deps.sessions.ttlMs / 1000));
      return { status: 'ok', user: sess.user, expires_at: sess.expiresAt };
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    deps.sessions.logout(sessionCookie(req));
    reply.header('set-cookie', sessionCookieHeader('', 0, true));
    return { status: 'ok' };
  });

  // 当前身份：guard 鉴权；返回是否启用登录与用户名（前端启动时探测）
  app.get('/api/v1/auth/me', { preHandler: guard }, async (req) => {
    const keyId = (req as FastifyRequest & { keyId?: string }).keyId;
    return {
      ui_auth: deps.sessions.enabled,
      user: keyId?.startsWith('ui:') ? keyId.slice(3) : null,
      via: keyId?.startsWith('ui:') ? 'session' : keyId ? 'api_key' : 'anonymous',
    };
  });

  // —— /v1/models ——
  app.get('/v1/models', { preHandler: guard }, async () => {
    const router = deps.router();
    return {
      object: 'list',
      data: router.listModels().map((m: ModelConfig) => ({
        id: m.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'aya',
        architecture: {
          input_modalities: m.input_modalities ?? ARCH_BY_KIND[m.kind].input,
          output_modalities: ARCH_BY_KIND[m.kind].output,
        },
        ...(m.context_length ? { context_length: m.context_length } : {}),
      })),
    };
  });

  // —— /v1/audio/voices —— 自定义音色（OpenAI custom voices 风格）
  // 上传音频样本作为音色；/v1/audio/speech 的 voice 参数传音色 id（或 name）即克隆该音色。
  app.post('/v1/audio/voices', { preHandler: guard }, async (req, reply) => {
    try {
      const parsed = await parseMultipart(req, deps.config().proxy.max_upload_bytes);
      const name = parsed.fields.name?.trim();
      if (!name) throw AyaErrors.invalidRequest('missing "name" field', 'name');
      if (!parsed.file || parsed.file.buf.length === 0) {
        throw AyaErrors.invalidRequest('missing "audio_sample" file part', 'audio_sample');
      }
      const v = deps.voices.create(name, parsed.file.buf, {
        filename: parsed.file.filename,
        contentType: parsed.file.mimeType,
        consent: parsed.fields.consent,
      });
      reply.code(201);
      return VoiceStore.toObject(v);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get('/v1/audio/voices', { preHandler: guard }, async () => ({
    object: 'list',
    data: deps.voices.list().map(VoiceStore.toObject),
  }));

  // 样本文件下载（前端试听用）：?sample=1 返回音频本体
  app.get<{ Params: { id: string }; Querystring: { sample?: string } }>(
    '/v1/audio/voices/:id',
    { preHandler: guard },
    async (req, reply) => {
      const v = deps.voices.get(req.params.id);
      if (!v) throw AyaErrors.voiceNotFound(req.params.id);
      if (req.query.sample === '1') {
        const buf = readFileSync(v.path);
        const extType: Record<string, string> = {
          '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
          '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
          '.aac': 'audio/aac', '.webm': 'audio/webm',
        };
        const ctype =
          v.content_type && v.content_type !== 'application/octet-stream'
            ? v.content_type
            : extType[path.extname(v.path).toLowerCase()] ?? 'application/octet-stream';
        reply
          .code(200)
          .header('content-type', ctype)
          .header('content-length', buf.length)
          .send(buf);
        return;
      }
      return VoiceStore.toObject(v);
    },
  );

  app.post<{ Params: { id: string } }>('/v1/audio/voices/:id', { preHandler: guard }, async (req) => {
    // 全局透传解析器把 body 留成原始流，这里自行缓冲 JSON
    const chunks: Buffer[] = [];
    for await (const c of req.raw) chunks.push(c as Buffer);
    let body: { name?: string } = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw AyaErrors.invalidRequest('request body must be JSON');
      }
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw AyaErrors.invalidRequest('missing "name" in body', 'name');
    if (!deps.voices.rename(req.params.id, name)) throw AyaErrors.voiceNotFound(req.params.id);
    return VoiceStore.toObject(deps.voices.get(req.params.id)!);
  });

  app.delete<{ Params: { id: string } }>('/v1/audio/voices/:id', { preHandler: guard }, async (req) => {
    if (req.raw.readable) req.raw.resume(); // 透传解析器留下的原始流
    if (!deps.voices.remove(req.params.id)) throw AyaErrors.voiceNotFound(req.params.id);
    return { id: req.params.id, object: 'audio.voice', deleted: true };
  });

  // —— /v1/* 转发路由 ——
  for (const [path, endpoint] of Object.entries(ENDPOINT_BY_PATH)) {
    app.post(path, { preHandler: guard }, async (req, reply) => {
      const keyId = (req as FastifyRequest & { keyId?: string }).keyId;
      const tsStart = nowMs();
      let peekedModel: string | undefined;
      let peekedRaw: string | undefined;
      let routedBackend: string | undefined;
      let enteredForward = false;
      try {
        const contentType = String(req.headers['content-type'] ?? '');
        const pcfg = deps.config().proxy;
        const peeked = await peekRequest(req.raw, contentType, {
          maxRawBytes: pcfg.log_raw_on_error ? pcfg.raw_log_max_bytes : 0,
        });
        peekedModel = peeked.model;
        peekedRaw = peeked.rawHead;
        if (!peeked.model) throw AyaErrors.missingModel();
        const { model, backend } = deps.router().route(peeked.model, endpoint);
        routedBackend = backend.name;
        enteredForward = true;
        if (backend.type === 'cli') {
          await forwardCli(
            { req, reply, endpoint, manager: deps.manager, stats: deps.stats, proxyCfg: pcfg, keyId, voices: deps.voices },
            model,
            backend,
            peeked,
          );
        } else {
          await forward(
            { req, reply, endpoint, manager: deps.manager, stats: deps.stats, proxyCfg: pcfg, keyId },
            model,
            backend,
            peeked,
          );
        }
      } catch (err) {
        // forward 内部错误已由其 finish() 落库；此处只记进入 forward 之前被拦截的
        if (!enteredForward) {
          recordRejected({
            deps, req, endpoint, keyId,
            model: peekedModel, backend: routedBackend, err, tsStart,
            reqRaw: peekedRaw,
          });
        }
        sendError(reply, err);
      }
    });
  }

  // ============ 管理 / 统计 API（/api/v1/*，鉴权同 /v1）============

  app.get('/api/v1/backends', { preHandler: guard }, async () => ({
    backends: deps.manager.allStatus(),
  }));

  app.post<{ Params: { name: string } }>('/api/v1/backends/:name/start', { preHandler: guard }, async (req, reply) => {
    try {
      await deps.manager.startBackend(req.params.name);
      return { backend: req.params.name, status: deps.manager.getRuntime(req.params.name)?.state };
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { name: string } }>('/api/v1/backends/:name/stop', { preHandler: guard }, async (req, reply) => {
    try {
      await deps.manager.stopBackend(req.params.name, 'manual');
      return { backend: req.params.name, status: deps.manager.getRuntime(req.params.name)?.state };
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { name: string } }>('/api/v1/backends/:name/restart', { preHandler: guard }, async (req, reply) => {
    try {
      await deps.manager.restartBackend(req.params.name);
      return { backend: req.params.name, status: deps.manager.getRuntime(req.params.name)?.state };
    } catch (err) {
      sendError(reply, err);
    }
  });

  // —— 模型主动加载 / 卸载 ——
  app.post<{ Params: { name: string }; Querystring: { wait?: string; timeout_ms?: string } }>(
    '/api/v1/models/:name/load',
    { preHandler: guard },
    async (req, reply) => {
      try {
        const wait = req.query.wait !== 'false';
        const timeoutMs = req.query.timeout_ms ? Number(req.query.timeout_ms) : 600_000;
        const r = await deps.loadModel(req.params.name, wait, timeoutMs);
        reply.code(r.status);
        return r.body;
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { name: string }; Querystring: { force?: string } }>(
    '/api/v1/models/:name/unload',
    { preHandler: guard },
    async (req, reply) => {
      try {
        const r = await deps.unloadModel(req.params.name, req.query.force === 'true');
        reply.code(r.status);
        return r.body;
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // —— 资源快照 ——
  app.get('/api/v1/resources', { preHandler: guard }, async () => {
    const snap = deps.resources.snapshot();
    return {
      ts: snap.ts,
      mem: { total_mb: snap.mem_total_mb, free_mb: snap.mem_free_mb },
      reserved: deps.resources.reservedEntries(),
      loading: deps.resources.loadingBackend(),
      load_ops: deps.resources.activeLoadOps(),
    };
  });

  // —— 配置视角模型列表 ——
  app.get('/api/v1/models', { preHandler: guard }, async () => ({
    models: deps.router().listModels(),
  }));

  // —— 配置热加载 ——
  app.post('/api/v1/config/reload', { preHandler: guard }, async (req, reply) => {
    try {
      const r = await deps.reloadConfig();
      reply.code(r.status);
      return r.body;
    } catch (err) {
      sendError(reply, err);
    }
  });

  // —— 事件 ——
  app.get<{ Querystring: { backend?: string; limit?: string } }>(
    '/api/v1/events',
    { preHandler: guard },
    async (req) => ({
      events: queryEvents(deps.store, { backend: req.query.backend, limit: Math.min(Number(req.query.limit ?? 100), 1000) }),
    }),
  );

  // —— 统计概览 ——
  app.get<{ Querystring: Record<string, string> }>('/api/v1/stats/summary', { preHandler: guard }, async (req) => {
    const q = req.query;
    return querySummary(deps.store, {
      ...parseRange(q),
      model: q.model,
      endpoint: q.endpoint,
    });
  });

  // —— 趋势序列 ——
  app.get<{ Querystring: Record<string, string> }>('/api/v1/stats/series', { preHandler: guard }, async (req) => {
    const q = req.query;
    const range = parseRange(q);
    const granularity = (q.granularity as Granularity) || autoGranularity(range.from, range.to);
    const metric = (q.metric as Metric) || 'requests';
    return {
      granularity,
      metric,
      series: querySeries(deps.store, { ...range, model: q.model, endpoint: q.endpoint }, granularity, metric),
    };
  });

  // —— 请求明细 ——
  app.get<{ Querystring: Record<string, string> }>('/api/v1/stats/requests', { preHandler: guard }, async (req) => {
    const q = req.query;
    return queryRequests(deps.store, {
      ...parseRange(q),
      model: q.model,
      endpoint: q.endpoint,
      status: q.status as 'ok' | 'fail' | undefined,
      stream: q.stream === '1' ? true : q.stream === '0' ? false : undefined,
      page: Math.max(1, Number(q.page ?? 1)),
      page_size: Math.min(200, Math.max(1, Number(q.page_size ?? 50))),
    });
  });

  // —— 单请求详情 ——
  app.get<{ Params: { id: string } }>('/api/v1/stats/requests/:id', { preHandler: guard }, async (req, reply) => {
    const detail = queryRequestDetail(deps.store, req.params.id);
    if (!detail) {
      reply.code(404).send(AyaErrors.modelNotFound(req.params.id).toJSON());
      return;
    }
    return detail;
  });

  // —— 清理过期请求明细 ——
  // body: { before: <epoch ms>, dry_run?: boolean }。dry_run 只返回将删条数（前端确认框用），
  // 实际删除同时按同一时间点清理 backend_events，与每日 retention 行为一致。
  app.post('/api/v1/stats/requests/purge', { preHandler: guard }, async (req) => {
    // 全局透传解析器把 body 留成原始流，这里自行缓冲 JSON
    const chunks: Buffer[] = [];
    for await (const c of req.raw) chunks.push(c as Buffer);
    let body: { before?: unknown; dry_run?: unknown } = {};
    if (chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw AyaErrors.invalidRequest('request body must be JSON');
      }
    }
    const before = Number(body.before);
    if (!Number.isFinite(before) || before <= 0) {
      throw AyaErrors.invalidRequest('"before" must be an epoch-ms timestamp', 'before');
    }
    if (before > nowMs()) {
      throw AyaErrors.invalidRequest('"before" must not be in the future', 'before');
    }
    const dryRun = body.dry_run === true;
    const counts = purgeBefore(deps.store, before, dryRun);
    if (dryRun) {
      return { dry_run: true, before, would_delete: counts.requests, events_would_delete: counts.events };
    }
    logger.info({ before, deleted: counts.requests, events_deleted: counts.events }, 'manual stats purge');
    return { dry_run: false, before, deleted: counts.requests, events_deleted: counts.events };
  });

  // —— 后端维度统计 ——
  app.get<{ Querystring: Record<string, string> }>('/api/v1/stats/backends', { preHandler: guard }, async (req) => ({
    backends: queryBackendStats(deps.store, parseRange(req.query)),
  }));
}
