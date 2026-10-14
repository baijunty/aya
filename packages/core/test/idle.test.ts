import { describe, it, expect } from 'vitest';
import { shouldUnload, idleRemainingMs } from '../src/backend/idle.js';
import type { BackendConfig, BackendRuntime } from '../src/model/types.js';

function rt(over: Partial<BackendRuntime> = {}): BackendRuntime {
  return {
    name: 'b1', state: 'ready', inflight: 0, queued: 0,
    lastActivityAt: 1000, consecutiveHealthFails: 0, restartAttempts: 0,
    counters: { starts: 0, stops: 0, crashes: 0, idle_stops: 0 },
    ...over,
  };
}
function cfg(over: Partial<BackendConfig> = {}): BackendConfig {
  return {
    name: 'b1', type: 'process', base_url: 'http://x/v1', command: 'x',
    start_timeout_ms: 1, stop_grace_period_ms: 1, idle_timeout_ms: 1000,
    auto_start: true, max_concurrency: 1, queue_size: 1, queue_timeout_ms: 1,
    priority: 0, evictable: true, ...over,
  };
}

describe('shouldUnload', () => {
  it('闲置达到阈值 → true', () => {
    expect(shouldUnload(rt(), cfg(), 2000)).toBe(true);
    expect(shouldUnload(rt(), cfg(), 1999)).toBe(false);
  });
  it('remote 型永不卸载', () => {
    expect(shouldUnload(rt(), cfg({ type: 'remote', idle_timeout_ms: 1 }), 99999)).toBe(false);
  });
  it('idle_timeout=0 关闭', () => {
    expect(shouldUnload(rt(), cfg({ idle_timeout_ms: 0 }), 99999)).toBe(false);
  });
  it('非 ready 不卸载（starting 天然保护）', () => {
    expect(shouldUnload(rt({ state: 'starting' }), cfg(), 99999)).toBe(false);
  });
  it('有进行中/排队请求不卸载', () => {
    expect(shouldUnload(rt({ inflight: 1 }), cfg(), 99999)).toBe(false);
    expect(shouldUnload(rt({ queued: 2 }), cfg(), 99999)).toBe(false);
  });
  it('计时起点为最后请求结束时间', () => {
    const r = rt({ lastActivityAt: 5000 });
    expect(shouldUnload(r, cfg({ idle_timeout_ms: 1000 }), 5999)).toBe(false);
    expect(shouldUnload(r, cfg({ idle_timeout_ms: 1000 }), 6000)).toBe(true);
  });
  it('idleRemainingMs 倒计时', () => {
    expect(idleRemainingMs(rt(), cfg(), 1500)).toBe(500);
    expect(idleRemainingMs(rt(), cfg(), 5000)).toBe(0);
    expect(idleRemainingMs(rt({ state: 'stopped' }), cfg(), 0)).toBeNull();
  });
});
