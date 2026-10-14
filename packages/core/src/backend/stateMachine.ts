import type { BackendState } from '../model/types.js';

export type BackendEvent =
  | 'spawn'            // stopped → starting
  | 'health_ok'        // starting → ready
  | 'start_timeout'    // starting → crashed
  | 'spawn_failed'     // starting → crashed
  | 'process_exit'     // starting/ready → crashed（意外）
  | 'health_fail'      // ready → crashed（连续失败达阈值）
  | 'stop'             // ready → draining
  | 'drain_done'       // draining → stopped
  | 'crash_restart'    // crashed → starting
  | 'reset';           // crashed → stopped

/** 表驱动状态机（design.md §4.1）：非法迁移抛错 */
const TRANSITIONS: Record<BackendState, Partial<Record<BackendEvent, BackendState>>> = {
  stopped: { spawn: 'starting' },
  starting: {
    health_ok: 'ready',
    start_timeout: 'crashed',
    spawn_failed: 'crashed',
    process_exit: 'crashed',
    stop: 'draining',
  },
  ready: {
    process_exit: 'crashed',
    health_fail: 'crashed',
    stop: 'draining',
  },
  draining: { drain_done: 'stopped', process_exit: 'stopped', crash_restart: 'starting' },
  crashed: { crash_restart: 'starting', reset: 'stopped', stop: 'draining' },
};

export function transition(state: BackendState, event: BackendEvent): BackendState {
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    throw new Error(`illegal backend state transition: ${state} --${event}-->`);
  }
  return next;
}
