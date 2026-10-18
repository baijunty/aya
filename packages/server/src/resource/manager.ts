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
import { ResourceProbe, procResidentMb, scanProcTable, type ProcResident } from './probe.js';
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
  /** 记账值：加载窗口内为声明值（含安全余量） */
  mem_mb: number;
  phase: 'reserved' | 'starting' | 'running';
  /** running 后端进程树（含子进程）的实测驻留总量（MB），供资源面板展示 */
  live_mb?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 资源管理器：内存探测 + 加载准入 + 驱逐等待 + 预留记账（design.md §4.7）。
 * 一切进程启动入口统一经 acquireLoadPermit。
 * 准入按「及时内存」判定：running 后端扣实测驻留（文件页+shmem），
 * 仅 reserved/starting 窗口扣声明值——模型加载完毕后不再按声明值重复扣减。
 */
export class ResourceManager {
  readonly probe: ResourceProbe;
  /** 预留记账：backend → mem_mb（含安全余量） */
  private reserved = new Map<string, number>();
  private phases = new Map<string, ReservedEntry['phase']>();
  /** 进行中的加载任务（backend → op），并发加载合并 */
  private ops = new Map<string, LoadOp>();
  private opPromises = new Map<string, Promise<void>>();
  /**
   * 全局加载锁：串行化「permit → ready/失败」加载窗口。
   * 两个引擎并行加载时各自的瞬时峰值（权重暂存、pack 转换等）不在声明值内，
   * 各自过检合计仍可能 OOM——必须一次只加载一个，下一个等前序加载完毕重新估算内存。
   * cli 型（一次性命令）不持锁：其 permit 覆盖整个运行期，持锁会把请求流量串行化，
   * 其并发防超卖由预留记账保证。
   */
  private loadLockHolder?: string;
  private loadLockQueue: Array<{ backend: string; grant: () => void }> = [];

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
    const resident = this.sampleResidents();
    const out: ReservedEntry[] = [];
    for (const [backend, mem_mb] of this.reserved) {
      const phase = this.phases.get(backend) ?? 'reserved';
      out.push({
        backend,
        mem_mb,
        phase,
        live_mb: phase === 'running' ? resident.get(backend)?.total_mb : undefined,
      });
    }
    return out;
  }

  /** 采样各 ready 后端的实时驻留（准入/驱逐/面板共用一轮采样；进程表只扫一次 /proc） */
  private sampleResidents(): Map<string, ProcResident | null> {
    const out = new Map<string, ProcResident | null>();
    const table = scanProcTable();
    for (const c of this.control.listConfigs()) {
      const rt = this.control.getRuntime(c.name);
      if (rt?.state === 'ready' && rt.pid) out.set(c.name, procResidentMb(rt.pid, table));
    }
    return out;
  }

  /**
   * 有效占用视图：running 扣实测文件页驻留（MemAvailable 已排除其匿名页，
   * 但把 mmap 权重页计为可回收，须显式扣回，防同一物理页被重复许诺）；
   * reserved/starting 尚未变成真实占用，扣声明值挡住并发超卖。
   */
  private effectiveReserved(resident: Map<string, ProcResident | null>): Map<string, number> {
    const out = new Map<string, number>();
    for (const [backend, declared] of this.reserved) {
      const live = this.phases.get(backend) === 'running' ? resident.get(backend) : undefined;
      out.set(backend, live ? live.file_mb : declared);
    }
    return out;
  }

  /** 获取全局加载锁（FIFO 排队，deadline 超时返回 false；同后端重入直接放行） */
  private acquireLoadLock(backend: string, deadline: number): Promise<boolean> {
    if (!this.loadLockHolder || this.loadLockHolder === backend) {
      this.loadLockHolder = backend;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        backend,
        grant: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const i = this.loadLockQueue.indexOf(entry);
        if (i >= 0) this.loadLockQueue.splice(i, 1);
        resolve(false);
      }, Math.max(deadline - nowMs(), 0));
      timer.unref?.();
      this.loadLockQueue.push(entry);
    });
  }

  /** 释放加载锁并移交下一个排队者（仅持有者可释放） */
  private releaseLoadLock(backend: string): void {
    if (this.loadLockHolder !== backend) return;
    const next = this.loadLockQueue.shift();
    if (next) {
      this.loadLockHolder = next.backend;
      next.grant();
    } else {
      this.loadLockHolder = undefined;
    }
  }

  /** 当前持有加载锁（加载中）的后端，供状态查询 */
  loadingBackend(): string | undefined {
    return this.loadLockHolder;
  }

  activeLoadOps(): LoadOp[] {
    return [...this.ops.values()].filter((o) => o.state !== 'done' && o.state !== 'failed');
  }

  getLoadOp(backend: string): LoadOp | undefined {
    return this.ops.get(backend);
  }

  /** 进程 ready 后：预留转为运行占用，加载窗口结束 → 释放加载锁 */
  markRunning(backend: string): void {
    if (this.reserved.has(backend)) this.phases.set(backend, 'running');
    this.releaseLoadLock(backend);
  }
  markStarting(backend: string): void {
    if (this.reserved.has(backend)) this.phases.set(backend, 'starting');
  }

  /** 进程停止/启动失败：释放预留与加载锁 */
  release(backend: string): void {
    this.reserved.delete(backend);
    this.phases.delete(backend);
    this.releaseLoadLock(backend);
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
    let loggedPlan: string | undefined;

    // 串行加载：先排队拿全局加载锁，前序加载完毕（ready/失败）后才开始准入估算；
    // 拿到锁后每轮都用最新快照 + 实测驻留重新判定，绝不按到达时的旧余量放行
    if (cfg.type !== 'cli') {
      const locked = await this.acquireLoadLock(cfg.name, op.deadline);
      if (!locked) {
        const detail = `等待前序加载超时（当前加载中：${this.loadLockHolder ?? '未知'}）；加载必须串行以防并行加载瞬时峰值 OOM`;
        op.state = 'failed';
        op.error = detail;
        throw AyaErrors.resourceUnavailable(detail);
      }
    }

    for (;;) {
      const snap = this.probe.snapshot();
      const resident = this.sampleResidents();
      const reservedView = this.effectiveReserved(resident);
      const admission = checkAdmission({
        snapshot: snap,
        reserved: reservedView,
        target: cfg,
        safetyMarginMb: this.resourcesCfg.safety_margin_mb,
      });
      if (admission.fit) {
        this.reserved.set(cfg.name, need);
        this.phases.set(cfg.name, 'reserved');
        return;
      }
      if (nowMs() > op.deadline) {
        const detail = this.blockedDetail(cfg, admission, snap, reservedView);
        op.state = 'failed';
        op.error = detail;
        this.releaseLoadLock(cfg.name);
        throw AyaErrors.resourceUnavailable(detail);
      }
      // 构建驱逐计划。busy 后端同样是候选（allow_evict_busy=false 只是不打断，
      // 等其当前请求跑完闲置后再驱逐）——否则 agent 持续占用内存时，新请求会被立刻 503
      const candidates = selectEvictCandidates(
        this.control.listConfigs()
          .map((c) => ({
            cfg: c,
            rt: this.control.getRuntime(c.name),
            // 卸载一个 victim 的净腾挪 = 匿名页（MemAvailable 回升）+ 文件页（扣减解除）= 驻留总量
            resident_mb: resident.get(c.name)?.total_mb,
          }))
          .filter((x): x is { cfg: BackendConfig; rt: BackendRuntime; resident_mb: number | undefined } => x.rt !== undefined),
        cfg.name,
        true,
      );
      const plan = planEviction(candidates, admission);
      if (candidates.length === 0) {
        const detail = this.blockedDetail(cfg, admission, snap, reservedView);
        op.state = 'failed';
        op.error = detail;
        this.releaseLoadLock(cfg.name);
        throw AyaErrors.resourceUnavailable(detail);
      }
      op.state = 'evicting';
      op.victims = plan.victims;
      if (loggedPlan !== plan.victims.join(',')) {
        loggedPlan = plan.victims.join(',');
        logger.info(
          { backend: cfg.name, need_mb: need, free_mb: admission.free_mb, victims: plan.victims },
          'memory insufficient, waiting for eviction candidates to idle',
        );
      }
      // 先卸载已闲置的 victim；仍有进行中请求的 victim 等其自然闲置后再卸载
      // （allow_evict_busy=true 时直接打断）。每轮结束后回到循环顶部重新评估准入，
      // 在 evict_wait_timeout 内静默等待腾挪，而不是立刻 503。
      let stopped = 0;
      let firstBusy: string | undefined;
      for (const victim of plan.victims) {
        const vrt = this.control.getRuntime(victim);
        if (!vrt || vrt.state !== 'ready') continue;
        if ((vrt.inflight > 0 || vrt.queued > 0) && !this.resourcesCfg.allow_evict_busy) {
          firstBusy ??= victim;
          continue;
        }
        await this.control.stopBackend(victim, 'evict');
        stopped++;
      }
      if (!stopped && firstBusy) {
        const vrt = this.control.getRuntime(firstBusy);
        if (vrt) {
          while ((vrt.inflight > 0 || vrt.queued > 0) && nowMs() <= op.deadline) {
            await sleep(this.resourcesCfg.probe_interval_ms);
          }
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
    reservedView: Map<string, number>,
  ): string {
    const blockers = this.control
      .listConfigs()
      .filter((c) => c.name !== cfg.name && this.reserved.has(c.name))
      .map((c) => {
        const rt = this.control.getRuntime(c.name);
        return `${c.name} (mem ${reservedView.get(c.name)}MB, state ${rt?.state ?? 'unknown'}, evictable=${c.evictable !== false})`;
      });
    return `need ${admission.need_mb}MB (incl. margin), free ${admission.free_mb}MB of ${snap.mem_total_mb}MB` +
      (blockers.length ? `; blocked by ${blockers.join('; ')}` : '; no evictable candidates');
  }
}
