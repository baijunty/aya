import { describe, it, expect } from 'vitest';
import { checkAdmission, selectEvictCandidates, planEviction, requiredMemMb } from '../src/resource/admission.js';
import type { BackendConfig, BackendRuntime, ResourceSnapshot } from '../src/model/types.js';

function b(over: Partial<BackendConfig>): BackendConfig {
  return {
    name: 'x', type: 'process', command: 'x',
    start_timeout_ms: 1, stop_grace_period_ms: 1, idle_timeout_ms: 0,
    auto_start: true, max_concurrency: 1, queue_size: 1, queue_timeout_ms: 1,
    priority: 0, evictable: true, ...over,
  } as BackendConfig;
}
function rt(over: Partial<BackendRuntime> = {}): BackendRuntime {
  return {
    name: 'x', state: 'ready', inflight: 0, queued: 0, lastActivityAt: 0,
    consecutiveHealthFails: 0, restartAttempts: 0,
    counters: { starts: 0, stops: 0, crashes: 0, idle_stops: 0 }, ...over,
  } as BackendRuntime;
}

describe('admission', () => {
  it('required = mem_mb + margin', () => {
    expect(requiredMemMb(b({ required_memory: { mem_mb: 16384 } }), 1024)).toBe(17408);
    expect(requiredMemMb(b({}), 1024)).toBe(0);
  });
  it('fit 判定', () => {
    const snap: ResourceSnapshot = { ts: 0, mem_total_mb: 65536, mem_free_mb: 6000 };
    const r = checkAdmission({
      snapshot: snap, reserved: new Map(), target: b({ name: 't', required_memory: { mem_mb: 16384 } }), safetyMarginMb: 1024,
    });
    expect(r.fit).toBe(false);
    expect(r.need_mb).toBe(17408);
  });
  it('预留记账：并发 load 不超卖', () => {
    const snap: ResourceSnapshot = { ts: 0, mem_total_mb: 65536, mem_free_mb: 20000 };
    const target = b({ name: 't', required_memory: { mem_mb: 16384 } });
    const r1 = checkAdmission({ snapshot: snap, reserved: new Map(), target, safetyMarginMb: 1024 });
    expect(r1.fit).toBe(true);
    // 第一个预留后，第二个同样大小的请求应不 fit
    const reserved = new Map([['t', 17408]]);
    const r2 = checkAdmission({ snapshot: snap, reserved, target: b({ name: 't2', required_memory: { mem_mb: 16384 } }), safetyMarginMb: 1024 });
    expect(r2.fit).toBe(false);
  });
  it('未声明 required_memory 永远 fit', () => {
    const snap: ResourceSnapshot = { ts: 0, mem_total_mb: 100, mem_free_mb: 1 };
    const r = checkAdmission({ snapshot: snap, reserved: new Map(), target: b({ name: 't' }), safetyMarginMb: 1024 });
    expect(r.fit).toBe(true);
  });
});

describe('eviction', () => {
  const big = b({ name: 'big', required_memory: { mem_mb: 40000 }, evictable: false });
  const low = b({ name: 'low', required_memory: { mem_mb: 8000 }, priority: 1 });
  const mid = b({ name: 'mid', required_memory: { mem_mb: 8000 }, priority: 5 });
  const snap: ResourceSnapshot = { ts: 0, mem_total_mb: 65536, mem_free_mb: 6000 };

  it('候选排序：priority 升序 → 闲置最久优先', () => {
    const cands = selectEvictCandidates(
      [
        { cfg: mid, rt: rt({ name: 'mid', lastActivityAt: 100 }) },
        { cfg: low, rt: rt({ name: 'low', lastActivityAt: 200 }) },
        { cfg: big, rt: rt({ name: 'big' }) },
      ],
      'target', false,
    );
    expect(cands.map((c) => c.name)).toEqual(['low', 'mid']);
  });
  it('busy 后端默认不可驱逐；allow_evict_busy 后可驱逐', () => {
    const backends = [{ cfg: low, rt: rt({ name: 'low', inflight: 1 }) }];
    expect(selectEvictCandidates(backends, 'target', false)).toHaveLength(0);
    expect(selectEvictCandidates(backends, 'target', true)).toHaveLength(1);
  });
  it('planEviction 依序累加至 fit', () => {
    const admission = checkAdmission({
      snapshot: snap, reserved: new Map(), target: b({ name: 'target', required_memory: { mem_mb: 16384 } }), safetyMarginMb: 1024,
    });
    const cands = [
      { name: 'low', release_mb: 8000, busy: false, priority: 1, lastActivityAt: 0 },
      { name: 'mid', release_mb: 8000, busy: false, priority: 5, lastActivityAt: 0 },
    ];
    const plan = planEviction(cands, admission);
    expect(plan.sufficient).toBe(true);
    expect(plan.victims).toEqual(['low', 'mid']);
  });
  it('候选不足 → insufficient', () => {
    const admission = checkAdmission({
      snapshot: snap, reserved: new Map(), target: b({ name: 'target', required_memory: { mem_mb: 100000 } }), safetyMarginMb: 1024,
    });
    const plan = planEviction([{ name: 'low', release_mb: 8000, busy: false, priority: 1, lastActivityAt: 0 }], admission);
    expect(plan.sufficient).toBe(false);
  });
});
