import {
  AyaErrors,
  idleRemainingMs,
  nowMs,
  shouldUnload,
  transition,
  type BackendConfig,
  type BackendEventRow,
  type BackendRuntime,
  type BackendState,
  type StopReason,
} from '@aya/core';
import { ProcessRunner } from './process-runner.js';
import { checkHealth } from './health.js';
import { ResourceManager } from '../resource/manager.js';
import { logger } from '../log.js';

export interface Lease {
  release(): void;
}

interface BackendEntry {
  cfg: BackendConfig;
  rt: BackendRuntime;
  runner?: ProcessRunner;
  healthTimer?: NodeJS.Timeout;
  /** 等待就绪的排队者 */
  readyWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  /** 等待并发槽位的排队者 */
  slotWaiters: Array<() => void>;
  /** 等待 in-flight 归零的观察者（drain 用） */
  drainWaiters: Array<() => void>;
  /** cli 型：进行中的一次性运行数（内存准入引用计数） */
  cliActive: number;
  /** cli 型：当前批次一次性运行的起始时间；空闲（无运行）时为 undefined */
  cliStartedAt?: number;
  startTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  intentionalStop: boolean;
}

export interface BackendManagerDeps {
  configs: BackendConfig[];
  resources: ResourceManager;
  logDir: string;
  emitEvent: (ev: BackendEventRow) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 后端生命周期管理器：状态机、进程拉起/停止、健康检查、闲置卸载、并发闸门与排队。
 * 状态迁移全部经 transition() 表驱动（design.md §4）。
 */
export class BackendManager {
  private entries = new Map<string, BackendEntry>();
  private reaper?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: BackendManagerDeps) {
    for (const cfg of deps.configs) this.addBackend(cfg);
  }

  // ——— 配置装载（热加载复用）———
  addBackend(cfg: BackendConfig): void {
    if (this.entries.has(cfg.name)) return;
    this.entries.set(cfg.name, {
      cfg,
      rt: {
        name: cfg.name,
        state: 'stopped',
        inflight: 0,
        queued: 0,
        // 0 = 从未活跃：闲置判定/驱逐排序只作用于 ready 态（届时必已被 markReady 刷新），
        // 看板对 0 显示“—”，避免未用过后端被误报为“服务启动时刻活跃过”
        lastActivityAt: 0,
        consecutiveHealthFails: 0,
        restartAttempts: 0,
        counters: { starts: 0, stops: 0, crashes: 0, idle_stops: 0 },
      },
      readyWaiters: [],
      slotWaiters: [],
      drainWaiters: [],
      cliActive: 0,
      intentionalStop: false,
    });
  }

  updateConfig(cfg: BackendConfig): void {
    const e = this.entries.get(cfg.name);
    if (e) e.cfg = cfg;
    else this.addBackend(cfg);
  }

  removeBackend(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return Promise.resolve();
    return this.stopBackend(name, 'config_removed').finally(() => this.entries.delete(name));
  }

  getConfig(name: string): BackendConfig | undefined {
    return this.entries.get(name)?.cfg;
  }
  get logDir(): string {
    return this.deps.logDir;
  }
  getRuntime(name: string): BackendRuntime | undefined {
    return this.entries.get(name)?.rt;
  }
  listConfigs(): BackendConfig[] {
    return [...this.entries.values()].map((e) => e.cfg);
  }
  listRuntimes(): BackendRuntime[] {
    return [...this.entries.values()].map((e) => e.rt);
  }

  // ——— 状态迁移 ———
  private setState(e: BackendEntry, event: Parameters<typeof transition>[1]): void {
    const next = transition(e.rt.state, event);
    const prev = e.rt.state;
    e.rt.state = next;
    logger.info({ backend: e.cfg.name, from: prev, to: next, via: event }, 'backend state');
  }

  // ——— 并发闸门与排队（design.md §4.6）———
  /**
   * 获取一个请求租约。stopped 时按 auto_start 拉起（经资源准入），请求在租约处等待就绪。
   */
  async acquire(name: string): Promise<Lease> {
    const e = this.entries.get(name);
    if (!e) throw AyaErrors.backendNotFound(name);
    const cfg = e.cfg;

    for (;;) {
      // cli 型：一次性进程，无常驻状态机，直接就绪（并发闸门在下方统一生效）
      // passthrough 型：纯转发远程 API，不托管进程、不探测健康，同样直接就绪
      if (cfg.type === 'cli' || cfg.type === 'passthrough') break;
      const st = e.rt.state;
      if (st === 'draining') throw AyaErrors.backendDraining(name);
      if (st === 'crashed') throw AyaErrors.backendCrashed(name);
      if (st === 'ready') break;
      if (st === 'stopped') {
        if (!cfg.auto_start) throw AyaErrors.backendStopped(name);
        await this.startBackend(name).catch((err) => {
          // 启动失败：等待者收到错误
          throw err;
        });
        continue;
      }
      // starting：等待就绪
      await this.waitReady(e, cfg.queue_timeout_ms);
    }

    // 并发闸门
    await this.acquireSlot(e, cfg);
    e.rt.inflight++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        e.rt.inflight--;
        e.rt.lastActivityAt = nowMs(); // 计时起点=请求结束
        this.wakeDrain(e);
        this.wakeSlot(e);
      },
    };
  }

  /**
   * cli 型运行租约：并发闸门（max_concurrency 个一次性进程）+ 内存准入引用计数
   * （首个运行 acquireLoadPermit，最后一个 release；驱逐候选判定按 busy 处理）。
   */
  async acquireCli(name: string): Promise<Lease> {
    const e = this.entries.get(name);
    if (!e) throw AyaErrors.backendNotFound(name);
    const cfg = e.cfg;
    await this.acquireSlot(e, cfg);
    const first = e.cliActive++ === 0;
    let admitted = false;
    if (first) {
      try {
        await this.deps.resources.acquireLoadPermit(cfg);
        admitted = true;
      } catch (err) {
        e.cliActive--;
        this.wakeSlot(e);
        throw err;
      }
    }
    e.rt.inflight++;
    if (first) e.cliStartedAt = nowMs(); // 运行时长只在一次性进程运行期间计时
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        e.rt.inflight--;
        e.rt.lastActivityAt = nowMs();
        if (--e.cliActive === 0) {
          e.cliStartedAt = undefined;
          if (admitted) this.deps.resources.release(cfg.name);
        }
        this.wakeDrain(e);
        this.wakeSlot(e);
      },
    };
  }

  /** 并发闸门：满则排队（queue_size 上限 / queue_timeout 超时） */
  private async acquireSlot(e: BackendEntry, cfg: BackendConfig): Promise<void> {
    if (e.rt.inflight >= cfg.max_concurrency) {
      if (e.rt.queued >= cfg.queue_size) throw AyaErrors.queueFull(cfg.name);
      e.rt.queued++;
      try {
        await this.waitForSlot(e, cfg.queue_timeout_ms);
      } finally {
        e.rt.queued--;
      }
    }
  }

  private waitReady(e: BackendEntry, timeoutMs: number): Promise<void> {
    if (e.rt.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = e.readyWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (i >= 0) e.readyWaiters.splice(i, 1);
        reject(AyaErrors.queueTimeout(e.cfg.name, 'waiting for backend to become ready'));
      }, timeoutMs);
      const wrappedResolve = () => {
        clearTimeout(t);
        resolve();
      };
      e.readyWaiters.push({ resolve: wrappedResolve, reject: (err) => { clearTimeout(t); reject(err); } });
    });
  }

  private waitForSlot(e: BackendEntry, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = e.slotWaiters.findIndex((w) => w === wrapped);
        if (i >= 0) e.slotWaiters.splice(i, 1);
        reject(AyaErrors.queueTimeout(e.cfg.name));
      }, timeoutMs);
      const wrapped = () => {
        if (e.rt.inflight < e.cfg.max_concurrency) {
          clearTimeout(t);
          const i = e.slotWaiters.indexOf(wrapped);
          if (i >= 0) e.slotWaiters.splice(i, 1);
          resolve();
        }
      };
      e.slotWaiters.push(wrapped);
    });
  }

  private wakeSlot(e: BackendEntry): void {
    if (e.rt.inflight < e.cfg.max_concurrency && e.slotWaiters.length) {
      const w = e.slotWaiters.shift()!;
      w();
    }
  }

  private wakeDrain(e: BackendEntry): void {
    if (e.rt.inflight === 0) {
      for (const w of e.drainWaiters.splice(0)) w();
    }
  }

  // ——— 启动 ———
  /** 主动启动（经资源准入）。并发调用合并。cli / passthrough 型无常驻进程，直接返回。 */
  async startBackend(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw AyaErrors.backendNotFound(name);
    if (e.cfg.type === 'cli' || e.cfg.type === 'passthrough') return;
    if (e.rt.state === 'ready') return;
    if (e.rt.state === 'starting') {
      return this.waitReady(e, e.cfg.start_timeout_ms);
    }
    if (e.rt.state === 'draining') {
      await this.finishStop(e, 'manual');
    }
    if (e.rt.state === 'crashed') this.setState(e, 'reset');

    // 资源准入（一切进程启动入口统一经此）
    try {
      await this.deps.resources.acquireLoadPermit(e.cfg);
    } catch (err) {
      if (e.rt.state === 'stopped') throw err;
      throw err;
    }
    this.deps.resources.markStarting(e.cfg.name);
    this.setState(e, 'spawn');
    e.rt.startedAt = nowMs();
    e.rt.counters.starts++;
    this.emit(e, 'start');

    if (e.cfg.type === 'remote') {
      // remote 型：仅健康探测
      const ok = await checkHealth(e.cfg);
      if (ok) this.markReady(e);
      else {
        this.setState(e, 'start_timeout');
        this.emit(e, 'crash', 'remote health check failed');
        this.deps.resources.release(e.cfg.name);
        this.setState(e, 'reset');
        throw AyaErrors.backendStartFailed(name, 'remote health check failed');
      }
      this.startHealthLoop(e);
      return;
    }

    // process 型
    const runner = new ProcessRunner(
      e.cfg,
      {
        onExit: (code, signal) => this.onProcessExit(e, code, signal),
      },
      this.deps.logDir,
    );
    e.runner = runner;
    try {
      runner.start();
      e.rt.pid = runner.pid;
      e.rt.pgid = runner.pgid;
    } catch (err) {
      this.setState(e, 'spawn_failed');
      this.deps.resources.release(e.cfg.name);
      this.setState(e, 'reset');
      throw AyaErrors.backendStartFailed(name, (err as Error).message);
    }

    // 启动超时看门狗
    e.startTimer = setTimeout(() => {
      if (e.rt.state === 'starting') {
        logger.error({ backend: name }, 'start timeout exceeded');
        this.emit(e, 'crash', 'start_timeout');
        void this.handleCrash(e, 'start_timeout');
      }
    }, e.cfg.start_timeout_ms);
    e.startTimer.unref();

    // 轮询健康
    void this.pollUntilReady(e);
    return this.waitReady(e, e.cfg.start_timeout_ms).catch((err) => {
      if (e.rt.state === 'crashed') throw AyaErrors.backendStartFailed(name, 'health check failed');
      throw err;
    });
  }

  private async pollUntilReady(e: BackendEntry): Promise<void> {
    const interval = e.cfg.health_check?.interval_ms ?? 1000;
    while (e.rt.state === 'starting' && !this.closed) {
      const ok = await checkHealth(e.cfg);
      if (e.rt.state !== 'starting') return;
      if (ok) {
        if (e.startTimer) clearTimeout(e.startTimer);
        this.markReady(e);
        return;
      }
      await sleep(Math.min(interval, 1000));
    }
  }

  private markReady(e: BackendEntry): void {
    if (e.rt.state !== 'starting') return;
    this.setState(e, 'health_ok');
    e.rt.readyAt = nowMs();
    e.rt.lastActivityAt = nowMs();
    e.rt.consecutiveHealthFails = 0;
    e.rt.restartAttempts = 0;
    this.deps.resources.markRunning(e.cfg.name);
    this.emit(e, 'ready');
    for (const w of e.readyWaiters.splice(0)) w.resolve();
    this.startHealthLoop(e);
  }

  // ——— 健康检查循环 ———
  private startHealthLoop(e: BackendEntry): void {
    if (e.healthTimer) clearInterval(e.healthTimer);
    const interval = e.cfg.health_check?.interval_ms ?? 5000;
    e.healthTimer = setInterval(async () => {
      if (e.rt.state !== 'ready') return;
      const ok = await checkHealth(e.cfg);
      if (e.rt.state !== 'ready') return;
      if (!ok) {
        e.rt.consecutiveHealthFails++;
        const threshold = e.cfg.health_check?.fail_threshold ?? 3;
        if (e.rt.consecutiveHealthFails >= threshold) {
          this.emit(e, 'health_fail', `consecutive fails ${e.rt.consecutiveHealthFails}`);
          if (e.rt.state === 'ready') this.setState(e, 'health_fail'); // ready → crashed
          void this.handleCrash(e, 'health_fail');
        }
      } else {
        e.rt.consecutiveHealthFails = 0;
      }
    }, interval);
    e.healthTimer.unref();
  }

  // ——— 进程退出 / 崩溃 ———
  private onProcessExit(e: BackendEntry, code: number | null, signal: string | null): void {
    if (e.startTimer) clearTimeout(e.startTimer);
    if (e.healthTimer) clearInterval(e.healthTimer);
    e.rt.pid = undefined;
    e.rt.pgid = undefined;
    e.runner = undefined;
    this.deps.resources.release(e.cfg.name);

    if (e.intentionalStop) {
      if (e.rt.state === 'draining') {
        this.setState(e, 'drain_done');
      } else if (e.rt.state === 'starting') {
        this.setState(e, 'process_exit');
        this.setState(e, 'reset');
      }
      for (const w of e.readyWaiters.splice(0)) w.reject(AyaErrors.backendStartFailed(e.cfg.name, 'process exited during startup'));
      return;
    }

    logger.warn({ backend: e.cfg.name, code, signal }, 'backend process exited unexpectedly');
    e.rt.counters.crashes++;
    if (e.rt.state === 'ready' || e.rt.state === 'starting') {
      this.setState(e, 'process_exit');
    } else if (e.rt.state === 'draining') {
      this.setState(e, 'process_exit');
      return;
    }
    this.emit(e, 'crash', `exit code=${code} signal=${signal}`);
    for (const w of e.readyWaiters.splice(0)) w.reject(AyaErrors.backendStartFailed(e.cfg.name, 'process exited'));
    void this.handleCrash(e, 'process_exit');
  }

  /** 崩溃处理：有 restart 预算则退避重启（重启同样过准入），否则回到 stopped */
  private async handleCrash(e: BackendEntry, reason: string): Promise<void> {
    const restart = e.cfg.restart;
    if (!restart || e.rt.restartAttempts >= restart.max_retries) {
      if (e.rt.state === 'crashed') this.setState(e, 'reset');
      return;
    }
    e.rt.restartAttempts++;
    const backoff = restart.backoff_base_ms * 2 ** (e.rt.restartAttempts - 1);
    logger.info({ backend: e.cfg.name, attempt: e.rt.restartAttempts, backoff }, 'scheduling crash restart');
    await sleep(backoff);
    if (this.closed || e.rt.state !== 'crashed') return;
    // 崩溃重启同样过准入；拿不到 permit 则保持 stopped 并记事件
    try {
      await this.startBackend(e.cfg.name); // startBackend 内部处理 crashed → reset → starting
      this.emit(e, 'restart', reason);
    } catch {
      this.emit(e, 'restart_deferred_resource', reason);
      if (e.rt.state === 'crashed') this.setState(e, 'reset');
    }
  }

  // ——— 停止 ———
  /** 优雅停止：draining → 等 in-flight 归零 → SIGTERM 整组 → 超时 SIGKILL。force=true 跳过 drain 等待 */
  async stopBackend(name: string, reason: StopReason, force = false): Promise<void> {
    const e = this.entries.get(name);
    if (!e) return;
    if (e.cfg.type === 'cli' || e.cfg.type === 'passthrough') return; // 无常驻进程可停
    if (e.rt.state === 'stopped') return;
    if (e.rt.state === 'ready' || e.rt.state === 'crashed' || e.rt.state === 'starting') {
      this.setState(e, 'stop');
    }
    if (e.rt.state !== 'draining') return;
    await this.finishStop(e, reason, force);
  }

  private async finishStop(e: BackendEntry, reason: StopReason, force = false): Promise<void> {
    e.intentionalStop = true;
    // 等待 in-flight 归零（上限 stop_grace_period）
    if (e.rt.inflight > 0 && !force) {
      await Promise.race([
        new Promise<void>((resolve) => e.drainWaiters.push(() => e.rt.inflight === 0 && resolve())),
        sleep(e.cfg.stop_grace_period_ms),
      ]);
    }
    if (e.healthTimer) clearInterval(e.healthTimer);
    if (e.startTimer) clearTimeout(e.startTimer);
    if (e.runner) {
      await e.runner.stop(e.cfg.stop_grace_period_ms);
    }
    if (e.rt.state === 'draining') this.setState(e, 'drain_done');
    e.rt.counters.stops++;
    if (reason === 'idle') e.rt.counters.idle_stops++;
    this.deps.resources.release(e.cfg.name);
    this.emit(e, reason === 'idle' ? 'idle_stop' : reason === 'evict' ? 'evict_stop' : 'stop', reason);
    e.intentionalStop = false;
  }

  async restartBackend(name: string): Promise<void> {
    await this.stopBackend(name, 'manual');
    await this.startBackend(name);
  }

  // ——— 闲置卸载 ———
  startIdleReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = nowMs();
      for (const e of this.entries.values()) {
        if (shouldUnload(e.rt, e.cfg, now)) {
          logger.info({ backend: e.cfg.name, idle_ms: now - e.rt.lastActivityAt }, 'idle timeout reached, unloading');
          void this.stopBackend(e.cfg.name, 'idle');
        }
      }
    }, 1000);
    this.reaper.unref();
  }

  // ——— 状态快照 ———
  status(name: string): Record<string, unknown> | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    return this.statusOf(e);
  }

  allStatus(): Array<Record<string, unknown>> {
    return [...this.entries.values()].map((e) => this.statusOf(e));
  }

  private statusOf(e: BackendEntry): Record<string, unknown> {
    const now = nowMs();
    const isCli = e.cfg.type === 'cli';
    const isPassthrough = e.cfg.type === 'passthrough';
    return {
      name: e.cfg.name,
      type: e.cfg.type,
      // cli 型无常驻进程：按需 spawn，始终可服务；passthrough 型纯转发远程 API，恒可服务
      state: isCli || isPassthrough ? 'ready' : e.rt.state,
      inflight: e.rt.inflight,
      queued: e.rt.queued,
      // 运行时长=进程实际运行时间：process 从 readyAt 起算；cli 仅在一次性进程运行期间，空闲为 null；
      // passthrough 无进程，恒为 null
      uptime_ms: isCli
        ? e.cliStartedAt != null
          ? now - e.cliStartedAt
          : null
        : isPassthrough
          ? null
          : e.rt.state === 'ready' && e.rt.readyAt
            ? now - e.rt.readyAt
            : null,
      /** null = 从未活跃过（未跑过任何请求） */
      last_activity_ms: e.rt.lastActivityAt || null,
      idle_remaining_ms: idleRemainingMs(e.rt, e.cfg, now),
      idle_timeout_ms: e.cfg.idle_timeout_ms,
      counters: e.rt.counters,
      pid: e.rt.pid,
    };
  }

  private emit(e: BackendEntry, event: BackendEventRow['event'], reason?: string, detail?: string): void {
    this.deps.emitEvent({ ts: nowMs(), backend: e.cfg.name, event, reason, detail });
  }

  /** 网关退出：优雅关闭所有托管进程 */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    for (const e of this.entries.values()) {
      if (e.healthTimer) clearInterval(e.healthTimer);
      if (e.rt.state !== 'stopped') {
        await this.stopBackend(e.cfg.name, 'shutdown').catch(() => undefined);
      }
    }
  }
}
