import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AyaError,
  AyaErrors,
  nowMs,
  type AppConfig,
  type ModelConfig,
} from '@aya/core';
import type { BackendManager } from '../backend/manager.js';
import type { ResourceManager } from '../resource/manager.js';
import type { StatsWriter } from '../stats/writer.js';
import type { StatsStore } from '../stats/store.js';
import type { AuthManager } from './auth.js';
import { forward } from '../proxy/forwarder.js';
import { peekRequest } from '../proxy/peek.js';
import {
  querySummary,
  querySeries,
  queryRequests,
  queryRequestDetail,
  queryBackendStats,
  queryEvents,
  autoGranularity,
  type Granularity,
  type Metric,
} from '../stats/queries.js';

export interface AppDeps {
  config: () => AppConfig;
  router: () => import('@aya/core').ModelRouter;
  manager: BackendManager;
  resources: ResourceManager;
  stats: StatsWriter;
  store: StatsStore;
  auth: AuthManager;
  loadModel: (name: string, wait: boolean, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
  unloadModel: (name: string, force: boolean) => Promise<{ status: number; body: unknown }>;
  reloadConfig: () => Promise<{ status: number; body: unknown }>;
}

const ENDPOINT_BY_PATH: Record<string, string> = {
  '/v1/chat/completions': 'chat',
  '/v1/completions': 'completion',
  '/v1/embeddings': 'embedding',
  '/v1/images/generations': 'image',
  '/v1/audio/transcriptions': 'asr',
  '/v1/audio/translations': 'asr',
  '/v1/audio/speech': 'tts',
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
  const guard = async (req: FastifyRequest): Promise<void> => {
    if (!deps.auth.enabled) return;
    const keyId = deps.auth.authenticate(req.headers.authorization);
    if (!keyId) throw AyaErrors.invalidApiKey();
    (req as FastifyRequest & { keyId?: string }).keyId = keyId;
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
        ...(m.context_length ? { context_length: m.context_length } : {}),
      })),
    };
  });

  // —— /v1/* 转发路由 ——
  for (const [path, endpoint] of Object.entries(ENDPOINT_BY_PATH)) {
    app.post(path, { preHandler: guard }, async (req, reply) => {
      const keyId = (req as FastifyRequest & { keyId?: string }).keyId;
      try {
        const contentType = String(req.headers['content-type'] ?? '');
        const peeked = await peekRequest(req.raw, contentType);
        if (!peeked.model) throw AyaErrors.missingModel();
        const { model, backend } = deps.router().route(peeked.model, endpoint);
        await forward(
          { req, reply, endpoint, manager: deps.manager, stats: deps.stats, proxyCfg: deps.config().proxy, keyId },
          model,
          backend,
          peeked,
        );
      } catch (err) {
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

  // —— 后端维度统计 ——
  app.get<{ Querystring: Record<string, string> }>('/api/v1/stats/backends', { preHandler: guard }, async (req) => ({
    backends: queryBackendStats(deps.store, parseRange(req.query)),
  }));
}
