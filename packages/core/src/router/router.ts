import { AyaErrors } from '../util/errors.js';
import type { AppConfig, BackendConfig, ModelConfig, ModelKind } from '../model/types.js';

/** 端点 → 允许的模型 kind（endpoint_kind_mismatch 校验） */
const ENDPOINT_KINDS: Record<string, ModelKind[]> = {
  chat: ['chat'],
  completion: ['completion', 'chat'],
  embedding: ['embedding'],
  image: ['image'],
  asr: ['asr'],
  tts: ['tts'],
};

export interface ResolvedRoute {
  model: ModelConfig;
  backend: BackendConfig;
}

export class ModelRouter {
  private byName = new Map<string, ModelConfig>();
  private byAlias = new Map<string, string>();
  private backends = new Map<string, BackendConfig>();

  constructor(cfg: AppConfig) {
    for (const b of cfg.backends) this.backends.set(b.name, b);
    for (const m of cfg.models) {
      this.byName.set(m.name, m);
      for (const a of m.aliases ?? []) this.byAlias.set(a, m.name);
    }
  }

  /** 精确名 → 别名；未启用/未配置 → 404 */
  resolveModel(name: string): ModelConfig {
    const direct = this.byName.get(name);
    if (direct) {
      if (!direct.enabled) throw AyaErrors.modelNotFound(name);
      return direct;
    }
    const aliasTarget = this.byAlias.get(name);
    if (aliasTarget) {
      const m = this.byName.get(aliasTarget)!;
      if (!m.enabled) throw AyaErrors.modelNotFound(name);
      return m;
    }
    throw AyaErrors.modelNotFound(name);
  }

  resolveBackend(name: string): BackendConfig {
    const b = this.backends.get(name);
    if (!b) throw AyaErrors.backendNotFound(name);
    return b;
  }

  /** model 名 + 端点类型 → 路由（含 kind 校验） */
  route(modelName: string, endpoint: string): ResolvedRoute {
    const model = this.resolveModel(modelName);
    const allowed = ENDPOINT_KINDS[endpoint];
    if (allowed && !allowed.includes(model.kind)) {
      throw AyaErrors.endpointKindMismatch(endpoint, model.name, model.kind);
    }
    return { model, backend: this.resolveBackend(model.backend) };
  }

  /** /v1/models 列表（规范名，不含别名） */
  listModels(): ModelConfig[] {
    return [...this.byName.values()].filter((m) => m.enabled);
  }

  listBackends(): BackendConfig[] {
    return [...this.backends.values()];
  }

  modelsForBackend(backendName: string): ModelConfig[] {
    return [...this.byName.values()].filter((m) => m.backend === backendName && m.enabled);
  }
}
