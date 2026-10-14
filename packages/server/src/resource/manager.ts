import {
  AyaErrors,
  checkAdmission,
  planEviction,
  requiredMemMb,
  selectEvictCandidates,
  type BackendConfig,
  type BackendRuntime,
  type LoadOp,
  type ResourceSnapshot,
  type StopReason,
} from '@aya/core';
import { ResourceProbe } from './probe.js';
import { logger } from '../log.js';
import { newId, nowMs } from '@aya/core';

/** ResourceManager 对 BackendManager 的反向依赖（避免循环 import） */
export interface EvictionControl {
  getRuntime(name: string): BackendRuntime | undefined;
  getConfig(name: string): BackendConfig | undefined;
  listConfigs(): BackendConfig[];
  stopBackend(name: string, reason: StopReason): Promise<void>;
}

export interface ReservedEntry {
  backend: string;
  mem_mb: number;
  phase: 'reserved' | 'starting' | 'running';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 资源管理器：内存探测 + 加载准入 + 驱逐等待 + 预留记账（design.md §4.7）。
 * 一切进程启动入口统一经 acquireLoadPermit。
 */
export class ResourceManager {
  readonly probe: ResourceProbe;
  /** 预留记账：backend → mem_mb（含安全余量） */
  private reserved = new Map<string, number>();
  private phases = new Map<string, ReservedEntry['phase']>();
  /** 进行中的加载任务（backend → op），并发加载合并 */
  private ops = new Map<string, LoadOp>();
  private opPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly control: EvictionControl,
    private readonly resourcesCfg: {
      enabled: boolean;
      probe_interval_ms: number;
      safety_margin_mb: number;
      evict_wait_timeout_ms: number;
      allow_evict_busy: boolean;
    },
  ) {
    this.probe = new ResourceProbe(resourcesCfg.probe_interval_ms);
  }

  start(): void {
    this.probe.start();
  }
  stop(): void {
    this.probe.stop();
  }

  snapshot(): ResourceSnapshot {
    return this.probe.snapshot();
  }

  reservedEntries(): ReservedEntry[] {
    const out: ReservedEntry[] = [];
    for (const [backend, mem_mb] of this.reserved) {
      out.push({ backend, mem_mb, phase: this.phases.get(backend) ?? 'reserved' });
    }
    return out;
  }

  activeLoadOps(): LoadOp[] {
    return [...this.ops.values()].filter((o) => o.state !== 'done' && o.state !== 'failed');
  }

  getLoadOp(backend: string): LoadOp | undefined {
    return this.ops.get(backend);
  }

  /** 进程 ready 后：预留转为运行占用 */
  markRunning(backend: string): void {
    if (this.reserved.has(backend)) this.phases.set(backend, 'running');
  }
  markStarting(backend: string): void {
    if (this.reserved.has(backend)) this.phases.set(backend, 'starting');
  }

  /** 进程停止/启动失败：释放预留 */
  release(backend: string): void {
    this.reserved.delete(backend);
    this.phases.delete(backend);
    const op = this.ops.get(backend);
    if (op && (op.state === 'starting' || op.state === 'evicting' || op.state === 'admitting')) {
      op.state = 'done';
    }
  }

  /**
   * 加载准入许可。fit → 预留并 resolve；不足 → 驱逐等待循环；超时 → 抛 resource_unavailable。
   * 同一后端并发调用合并到同一 LoadOp（waiters 计数）。
   */
  async acquireLoadPermit(cfg: BackendConfig): Promise<void> {
    if (!this.resourcesCfg.enabled || !cfg.required_memory) {
      return; // 未声明资源需求：不做准入
    }
    const existing = this.opPromises.get(cfg.name);
    if (existing) {
      const op = this.ops.get(cfg.name);
      if (op) op.waiters++;
      return existing;
    }
    const promise = this.doAcquire(cfg).finally(() => {
      this.opPromises.delete(cfg.name);
      const op = this.ops.get(cfg.name);
      if (op && op.state !== 'failed') op.state = 'done';
      setTimeout(() => this.ops.delete(cfg.name), 5000).unref?.();
    });
    this.opPromises.set(cfg.name, promise);
    return promise;
  }

  private async doAcquire(cfg: BackendConfig): Promise<void> {
    const need = requiredMemMb(cfg, this.resourcesCfg.safety_margin_mb);
    const started = nowMs();
    const op: LoadOp = {
      id: newId('load'),
      backend: cfg.name,
      state: 'admitting',
      need: { mem_mb: need },
      victims: [],
      waiters: 1,
      started_at: started,
      deadline: started + this.resourcesCfg.evict_wait_timeout_ms,
    };
    this.ops.set(cfg.name, op);

    for (;;) {
      const snap = this.probe.snapshot();
      const admission = checkAdmission({
        snapshot: snap,
        reserved: this.reserved,
        target: cfg,
        safetyMarginMb: this.resourcesCfg.safety_margin_mb,
      });
      if (admission.fit) {
        this.reserved.set(cfg.name, need);
        this.phases.set(cfg.name, 'reserved');
        return;
      }
      if (nowMs() > op.deadline) {
        const detail = this.blockedDetail(cfg, admission, snap);
        op.state = 'failed';
        op.error = detail;
        throw AyaErrors.resourceUnavailable(detail);
      }
      // 构建驱逐计划
      const candidates = selectEvictCandidates(
        this.control.listConfigs()
          .map((c) => ({ cfg: c, rt: this.control.getRuntime(c.name) }))
          .filter((x): x is { cfg: BackendConfig; rt: BackendRuntime } => x.rt !== undefined),
        cfg.name,
        this.resourcesCfg.allow_evict_busy,
      );
      const plan = planEviction(candidates, admission);
      if (candidates.length === 0) {
        const detail = this.blockedDetail(cfg, admission, snap);
        op.state = 'failed';
        op.error = detail;
        throw AyaErrors.resourceUnavailable(detail);
      }
      op.state = 'evicting';
      op.victims = plan.victims;
      logger.info(
        { backend: cfg.name, need_mb: need, free_mb: admission.free_mb, victims: plan.victims },
        'memory insufficient, waiting for eviction candidates to idle',
      );
      for (const victim of plan.victims) {
        // 等待 victim 自然闲置（默认不打断进行中请求）
        const vrt = this.control.getRuntime(victim);
        if (!vrt || vrt.state !== 'ready') continue;
        while (vrt.inflight > 0 || vrt.queued > 0) {
          if (nowMs() > op.deadline) break;
          await sleep(this.resourcesCfg.probe_interval_ms);
        }
        if (this.control.getRuntime(victim)?.state === 'ready') {
          await this.control.stopBackend(victim, 'evict');
        }
      }
      // 等待 OS 实际回收内存
      await sleep(Math.min(this.resourcesCfg.probe_interval_ms, 1000));
    }
  }

  private blockedDetail(
    cfg: BackendConfig,
    admission: { need_mb: number; free_mb: number },
    snap: ResourceSnapshot,
  ): string {
    const blockers = this.control
      .listConfigs()
      .filter((c) => c.name !== cfg.name && this.reserved.has(c.name))
      .map((c) => {
        const rt = this.control.getRuntime(c.name);
        return `${c.name} (mem ${this.reserved.get(c.name)}MB, state ${rt?.state ?? 'unknown'}, evictable=${c.evictable !== false})`;
      });
    return `need ${admission.need_mb}MB (incl. margin), free ${admission.free_mb}MB of ${snap.mem_total_mb}MB` +
      (blockers.length ? `; blocked by ${blockers.join('; ')}` : '; no evictable candidates');
  }
}
