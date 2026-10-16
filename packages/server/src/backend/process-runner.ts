import { spawn, type ChildProcess } from 'node:child_process';
import type { BackendConfig } from '@aya/core';
import { logger, backendLogStream } from '../log.js';

export interface RunnerHooks {
  onExit: (code: number | null, signal: string | null) => void;
}

/** 参数插值：{model_path} 等占位符由配置字段填充 */
export function interpolateArgs(cfg: BackendConfig): string[] {
  return (cfg.args ?? []).map((a) =>
    a.replace(/\{(\w+)\}/g, (m, key: string) => {
      const v = (cfg as Record<string, unknown>)[key];
      return typeof v === 'string' ? v : m;
    }),
  );
}

/**
 * 托管进程运行器：detached 进程组启动，SIGTERM→超时 SIGKILL 整组（design.md §4.2/§4.3）。
 */
export class ProcessRunner {
  proc?: ChildProcess;
  pgid?: number;
  private stopping = false;
  private exited = false;

  constructor(
    private readonly cfg: BackendConfig,
    private readonly hooks: RunnerHooks,
    private readonly logDir: string,
  ) {}

  /** 参数插值：{model_path} 等占位符由配置字段填充 */
  interpolateArgs(): string[] {
    return interpolateArgs(this.cfg);
  }

  start(): void {
    if (this.proc) throw new Error(`runner already started: ${this.cfg.name}`);
    const args = this.interpolateArgs();
    const log = backendLogStream(this.logDir, this.cfg.name);
    log.startRun(); // logs.mode=run 时清空，只留本次运行；day 模式顺带跨天切换
    logger.info({ backend: this.cfg.name, command: this.cfg.command, args }, 'spawning backend process');
    this.stopping = false;
    this.exited = false;
    this.proc = spawn(this.cfg.command!, args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      detached: true, // 新进程组组长，pgid = pid
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pgid = this.proc.pid;
    this.proc.stdout!.pipe(log, { end: false });
    this.proc.stderr!.pipe(log, { end: false });
    this.proc.on('error', (e) => {
      logger.error({ backend: this.cfg.name, err: e }, 'spawn error');
      this.finish(null, 'spawn_error');
    });
    this.proc.on('exit', (code, signal) => this.finish(code, signal));
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    const intentional = this.stopping;
    this.proc = undefined;
    this.pgid = undefined;
    this.hooks.onExit(intentional ? 0 : code, intentional ? 'stop' : signal);
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get alive(): boolean {
    return this.proc !== undefined;
  }

  private killGroup(signal: NodeJS.Signals): void {
    if (!this.pgid) return;
    try {
      process.kill(-this.pgid, signal); // 杀整个进程组，回收 worker 内存
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.warn({ backend: this.cfg.name, err: e }, `kill(-${this.pgid}, ${signal}) failed`);
      }
    }
  }

  /** 优雅停止：SIGTERM 整组 → 宽限超时 SIGKILL 整组 */
  async stop(graceMs: number): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
    this.killGroup('SIGTERM');
    const exited = await this.waitExit(graceMs);
    if (!exited) {
      logger.warn({ backend: this.cfg.name }, `grace period expired, SIGKILL process group`);
      this.killGroup('SIGKILL');
      await this.waitExit(5000);
    }
  }

  private waitExit(ms: number): Promise<boolean> {
    if (!this.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this.proc!.once('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }
}
