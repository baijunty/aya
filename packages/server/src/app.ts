import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { watch } from 'chokidar';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfigFile,
  ModelRouter,
  type AppConfig,
} from '@aya/core';
import { logger } from './log.js';
import { BackendManager } from './backend/manager.js';
import { ResourceManager } from './resource/manager.js';
import { LoadOps } from './resource/load-ops.js';
import { StatsStore } from './stats/store.js';
import { StatsWriter } from './stats/writer.js';
import { purgeRetention } from './stats/queries.js';
import { VoiceStore } from './voices/store.js';
import { AuthManager } from './http/auth.js';
import { SessionStore } from './http/sessions.js';
import { registerRoutes, type AppDeps } from './http/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AyaApp {
  app: Fastify.FastifyInstance;
  config: () => AppConfig;
  configPath: string;
  shutdown: () => Promise<void>;
  listen: () => Promise<string>;
}

export function createApp(configPath: string): AyaApp {
  let cfg = loadConfigFile(configPath);
  let router = new ModelRouter(cfg);
  const auth = new AuthManager(cfg.server.api_keys);
  const sessions = new SessionStore(cfg.server.ui_auth);

  const store = new StatsStore(cfg.storage.path);
  const stats = new StatsWriter(store);
  stats.start();
  const voices = new VoiceStore(store.db, path.join(path.dirname(cfg.storage.path), 'voices'));

  const logDir = path.join(path.dirname(cfg.storage.path), 'logs');
  let managerRef!: BackendManager;
  const resources: ResourceManager = new ResourceManager(
    {
      getRuntime: (n) => managerRef.getRuntime(n),
      getConfig: (n) => managerRef.getConfig(n),
      listConfigs: () => managerRef.listConfigs(),
      stopBackend: (n, r) => managerRef.stopBackend(n, r),
    },
    cfg.resources,
  );
  const manager = new BackendManager({
    configs: cfg.backends,
    resources,
    logDir,
    emitEvent: (ev) => stats.event(ev),
  });
  managerRef = manager;
  const loadOps = new LoadOps(() => router, manager, resources);

  const app = Fastify({
    disableRequestLogging: true,
    bodyLimit: cfg.proxy.max_upload_bytes,
    // 透传场景：不解析 JSON body（由 forwarder 以流处理）
  });
  // 移除内置 JSON/text 解析器：透传场景下 body 必须以原始流形式交给 forwarder
  app.removeContentTypeParser(['application/json', 'text/plain']);
  app.addContentTypeParser('*', (req, payload, done) => {
    // 透传场景：POST/PUT 保留原始流交给 forwarder 消费；无 body 的方法直接放行
    const method = (req as { method?: string }).method ?? '';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      done(null, undefined);
      return;
    }
    done(null, payload);
  });

  const deps: AppDeps = {
    config: () => cfg,
    router: () => router,
    manager,
    resources,
    stats,
    store,
    voices,
    auth,
    sessions,
    loadModel: (n, w, t) => loadOps.load(n, w, t),
    unloadModel: (n, f) => loadOps.unload(n, f),
    reloadConfig: async () => {
      try {
        const next = loadConfigFile(configPath);
        applyConfig(next);
        return { status: 200, body: { status: 'reloaded', backends: next.backends.length, models: next.models.length } };
      } catch (e) {
        return { status: 400, body: { status: 'error', message: (e as Error).message } };
      }
    },
  };
  registerRoutes(app, deps);

  // 静态前端（web 构建产物）
  if (cfg.server.static_ui) {
    const webDist = path.resolve(__dirname, '../../web/dist');
    if (existsSync(webDist)) {
      void app.register(fastifyStatic, { root: webDist, prefix: '/' });
      logger.info({ webDist }, 'serving static UI');
    }
  }

  function applyConfig(next: AppConfig): void {
    const prevNames = new Set(cfg.backends.map((b) => b.name));
    const nextNames = new Set(next.backends.map((b) => b.name));
    cfg = next;
    router = new ModelRouter(next);
    auth.setKeys(next.server.api_keys);
    sessions.setCreds(next.server.ui_auth);
    for (const b of next.backends) manager.updateConfig(b);
    for (const name of prevNames) {
      if (!nextNames.has(name)) void manager.removeBackend(name);
    }
    logger.info({ backends: next.backends.length, models: next.models.length }, 'config reloaded');
  }

  // 配置热加载监听
  let watcher: ReturnType<typeof watch> | undefined;
  function startWatcher(): void {
    watcher = watch(configPath, { ignoreInitial: true });
    watcher.on('change', () => {
      logger.info('config file changed, reloading');
      try {
        applyConfig(loadConfigFile(configPath));
      } catch (e) {
        logger.error({ err: e }, 'config reload failed, keeping previous config');
      }
    });
  }

  // 保留清理（每日）
  let retentionTimer: NodeJS.Timeout | undefined;

  async function listen(): Promise<string> {
    resources.start();
    manager.startIdleReaper();
    startWatcher();
    retentionTimer = setInterval(() => {
      const n = purgeRetention(store, cfg.storage.retention_days);
      if (n > 0) logger.info({ purged: n }, 'retention cleanup');
    }, 86400_000);
    retentionTimer.unref();
    // 首次清理
    purgeRetention(store, cfg.storage.retention_days);

    const [host, portStr] = cfg.server.listen.split(':');
    const port = Number(portStr ?? 8000);
    await app.listen({ host: host ?? '127.0.0.1', port });
    return `http://${host}:${port}`;
  }

  async function shutdown(): Promise<void> {
    logger.info('shutting down');
    await watcher?.close();
    if (retentionTimer) clearInterval(retentionTimer);
    await app.close();
    await manager.shutdown();
    resources.stop();
    stats.close();
    store.close();
  }

  return { app, config: () => cfg, configPath, shutdown, listen };
}
