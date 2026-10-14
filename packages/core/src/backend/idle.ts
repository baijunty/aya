import type { BackendConfig, BackendRuntime } from '../model/types.js';

/**
 * 闲置判定纯函数（design.md §4.5）。
 * 计时起点 = 最后一次请求「结束」时间（lastActivityAt）。
 */
export function shouldUnload(rt: BackendRuntime, cfg: BackendConfig, now: number): boolean {
  if (cfg.type !== 'process') return false;
  if (cfg.idle_timeout_ms <= 0) return false;
  if (rt.state !== 'ready') return false;
  if (rt.inflight > 0 || rt.queued > 0) return false;
  return now - rt.lastActivityAt >= cfg.idle_timeout_ms;
}

/** 闲置倒计时（ms）；不适用时返回 null */
export function idleRemainingMs(rt: BackendRuntime, cfg: BackendConfig, now: number): number | null {
  if (cfg.type !== 'process' || cfg.idle_timeout_ms <= 0) return null;
  if (rt.state !== 'ready') return null;
  return Math.max(0, cfg.idle_timeout_ms - (now - rt.lastActivityAt));
}
