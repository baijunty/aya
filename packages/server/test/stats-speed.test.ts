import { describe, it, expect } from 'vitest';
import type { RequestLog } from '@aya/core';
import { StatsStore } from '../src/stats/store.js';
import { querySeries } from '../src/stats/queries.js';

const DAY = 86400_000;

function mkLog(id: string, over: Partial<RequestLog> = {}): RequestLog {
  const now = Date.now();
  return {
    request_id: id,
    ts_start: now - 3600_000, // 同一小时桶
    ts_end: now,
    client_addr: '127.0.0.1',
    endpoint: 'chat',
    model: 'm',
    backend: 'b',
    is_stream: true,
    status_code: 200,
    ok: true,
    latency_ms: 1000,
    backend_ms: 900,
    tokens_estimated: false,
    req_bytes: 1,
    resp_bytes: 1,
    timeline: { queue: 0, backend_start: 0, backend_ttfb: 100, total: 1000, ttft_source: 'token' },
    ...over,
  };
}

describe('querySeries pp/tg（速度趋势）', () => {
  function store(): StatsStore {
    const s = new StatsStore(':memory:');
    s.insertRequestLogs([
      // 计入：pp=(1000-0)/(500-0)s=2000；tg=100/(1500-500)s=100
      mkLog('r1', { prompt_tokens: 1000, cached_tokens: 0, ttft_ms: 500, latency_ms: 1500, completion_tokens: 100 }),
      // 计入：pp=(500-100)/(300-100)s=2000；tg=200/(1300-300)s=200
      mkLog('r2', {
        prompt_tokens: 500, cached_tokens: 100, ttft_ms: 300, latency_ms: 1300, completion_tokens: 200,
        timeline: { queue: 100, backend_start: 0, backend_ttfb: 100, total: 1300, ttft_source: 'token' },
      }),
      // 排除：非流式
      mkLog('r3', { is_stream: false, prompt_tokens: 1000, ttft_ms: 500, completion_tokens: 100 }),
      // 排除：TTFT 未量到 token 帧（与明细页同口径，不给假速度）
      mkLog('r4', {
        prompt_tokens: 1000, ttft_ms: 500, latency_ms: 1500, completion_tokens: 100,
        timeline: { queue: 0, backend_start: 0, backend_ttfb: 100, total: 1500, ttft_source: 'first_byte' },
      }),
      // 排除：ttft−排队 ≤ 0（pp 无意义）；completion 缺失（tg 无意义）
      mkLog('r5', {
        prompt_tokens: 1000, ttft_ms: 50, completion_tokens: undefined,
        timeline: { queue: 100, backend_start: 0, backend_ttfb: 10, total: 1000, ttft_source: 'token' },
      }),
      // 排除：其它模型（model 过滤）
      mkLog('r6', { model: 'other', prompt_tokens: 1000, cached_tokens: 0, ttft_ms: 500, latency_ms: 1500, completion_tokens: 100 }),
    ]);
    return s;
  }

  const range = { from: Date.now() - DAY, to: Date.now() + DAY };
  const rangeM = { ...range, model: 'm' }; // 聚合断言只看模型 m（r6 属其它模型，见过滤用例）

  it('pp：按 (prompt−cached)/(ttft−排队) 聚合 avg/p95，排除不可信行', () => {
    const series = querySeries(store(), rangeM, 'hour', 'pp');
    expect(series).toHaveLength(1);
    expect(series[0]!.avg).toBe(2000);
    expect(series[0]!.p95).toBe(2000);
  });

  it('tg：按 completion/(latency−ttft) 聚合 avg/p95', () => {
    const series = querySeries(store(), rangeM, 'hour', 'tg');
    expect(series).toHaveLength(1);
    expect(series[0]!.avg).toBe(150);
    expect(series[0]!.p95).toBe(200);
  });

  it('model 过滤生效', () => {
    expect(querySeries(store(), { ...range, model: 'other' }, 'hour', 'pp')).toHaveLength(1);
    // 不存在的模型 → 空序列
    expect(querySeries(store(), { ...range, model: 'nope' }, 'hour', 'pp')).toHaveLength(0);
  });
});
