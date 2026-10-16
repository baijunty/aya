import {
  AyaErrors,
  nowMs,
  type ModelRouter,
  type BackendConfig,
} from '@aya/core';
import type { BackendManager } from '../backend/manager.js';
import type { ResourceManager } from './manager.js';

export interface LoadResult {
  status: number;
  body: unknown;
}

/**
 * 模型级主动加载 / 卸载（design.md §4.8 / api-design.md B1a）。
 */
export class LoadOps {
  constructor(
    private readonly router: () => ModelRouter,
    private readonly manager: BackendManager,
    private readonly resources: ResourceManager,
  ) {}

  async load(modelName: string, wait: boolean, timeoutMs: number): Promise<LoadResult> {
    const model = this.router().resolveModel(modelName);
    const backend = this.manager.getConfig(model.backend);
    if (!backend) throw AyaErrors.backendNotFound(model.backend);

    if (backend.type === 'remote' || backend.type === 'cli' || backend.type === 'passthrough') {
      return { status: 200, body: { model: model.name, backend: backend.name, status: 'noop' } };
    }

    const state = this.manager.getRuntime(backend.name)?.state;
    if (state === 'ready') {
      return { status: 200, body: { model: model.name, backend: backend.name, status: 'already_loaded' } };
    }

    const op = this.resources.getLoadOp(backend.name);
    const respondPending = (): LoadResult => {
      const snap = this.resources.snapshot();
      const currentOp = this.resources.getLoadOp(backend.name);
      const waitingFor = (currentOp?.victims ?? []).map((v) => {
        const rt = this.manager.getRuntime(v);
        return {
          backend: v,
          reason: (rt?.inflight ?? 0) > 0 ? 'idle_inflight' : 'idle_wait',
          inflight: rt?.inflight ?? 0,
        };
      });
      return {
        status: 202,
        body: {
          model: model.name,
          backend: backend.name,
          status: currentOp?.state === 'evicting' ? 'pending_resources' : 'loading',
          resources: currentOp
            ? { need_mb: currentOp.need.mem_mb, free_mb: snap.mem_free_mb, total_mb: snap.mem_total_mb }
            : undefined,
          waiting_for: waitingFor,
        },
      };
    };

    if (!wait) {
      // 立即返回，后台继续
      void this.manager.startBackend(backend.name).catch(() => undefined);
      return respondPending();
    }

    // wait=true：阻塞至就绪/失败/超时
    const startPromise = this.manager.startBackend(backend.name);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs).unref?.());
    const race = await Promise.race([startPromise.then(() => 'done' as const), timeout]);
    if (race === 'timeout') {
      return respondPending();
    }
    return { status: 200, body: { model: model.name, backend: backend.name, status: 'ready' } };
  }

  async unload(modelName: string, force: boolean): Promise<LoadResult> {
    const model = this.router().resolveModel(modelName);
    const backend = this.manager.getConfig(model.backend);
    if (!backend) throw AyaErrors.backendNotFound(model.backend);

    if (backend.type === 'remote' || backend.type === 'cli' || backend.type === 'passthrough') {
      return { status: 200, body: { model: model.name, backend: backend.name, status: 'noop' } };
    }
    if (this.resources.activeLoadOps().some((o) => o.backend === backend.name)) {
      throw AyaErrors.loadInProgress(backend.name);
    }
    const affects = this.router().modelsForBackend(backend.name).map((m) => m.name);
    await this.manager.stopBackend(backend.name, 'manual_unload', force);
    return {
      status: 202,
      body: { model: model.name, backend: backend.name, status: 'stopping', affects_models: affects },
    };
  }
}

export type { BackendConfig };
