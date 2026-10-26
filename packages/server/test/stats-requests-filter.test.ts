import { describe, it, expect } from 'vitest';
import type { RequestLog } from '@aya/core';
import { StatsStore } from '../src/stats/store.js';
import { queryRequests } from '../src/stats/queries.js';

const DAY = 86400_000;

function mkLog(id: string, model: string, ok = true): RequestLog {
  const now = Date.now();
  return {
    request_id: id,
    ts_start: now - 60_000,
    ts_end: now,
    client_addr: '127.0.0.1',
    endpoint: 'chat',
    model,
    backend: 'b',
    is_stream: true,
    status_code: 200,
    ok,
    latency_ms: 100,
    backend_ms: 90,
    tokens_estimated: false,
    req_bytes: 1,
    resp_bytes: 1,
    timeline: { queue: 0, backend_start: 0, backend_ttfb: 10, total: 100, ttft_source: 'token' },
  };
}

describe('queryRequests 模型精确过滤', () => {
  function store(): StatsStore {
    const s = new StatsStore(':memory:');
    s.insertRequestLogs([
      mkLog('r1', 'qwen3.8-flash-next'),
      mkLog('r2', 'QWEN-other'),
      mkLog('r3', 'gemma4-26b'),
      mkLog('r4', 'qwen_x'),
      mkLog('r5', 'qwen-x'),
    ]);
    return s;
  }
  const q = (model: string | undefined, extra: { status?: 'ok' | 'fail'; endpoint?: string } = {}) =>
    queryRequests(store(), { from: Date.now() - DAY, to: Date.now() + DAY, model, page: 1, page_size: 50, ...extra });

  it('只有全名精确匹配才命中（前端是模型下拉，不做子串搜索）', () => {
    expect(q('qwen3.8-flash-next').total).toBe(1);
    expect(q('qwen_x').total).toBe(1);
    expect(q('qwen-x').total).toBe(1);
    // 子串不再放大匹配
    expect(q('qwen').total).toBe(0);
    expect(q('flash').total).toBe(0);
    expect(q('3.8').total).toBe(0);
  });

  it('大小写敏感（TEXT 列默认 BINARY 排序，与趋势页 where() 同口径）', () => {
    expect(q('QWEN-other').total).toBe(1);
    expect(q('qwen-other').total).toBe(0);
  });

  it('LIKE 通配符按字面看待，不会被当成模式', () => {
    expect(q('%').total).toBe(0);
    expect(q('_').total).toBe(0);
    expect(q('qwen%').total).toBe(0);
  });

  it('不传 model 时不过滤，且与其他过滤条件叠加', () => {
    expect(q(undefined).total).toBe(5);
    expect(q('qwen_x', { status: 'ok' }).total).toBe(1);
    expect(q('qwen_x', { status: 'fail' }).total).toBe(0);
    expect(q(undefined, { endpoint: 'chat' }).total).toBe(5);
    expect(q(undefined, { endpoint: 'asr' }).total).toBe(0);
  });

  it('时间窗外不命中', () => {
    const s = store();
    expect(
      queryRequests(s, { from: Date.now() - 2 * DAY, to: Date.now() - DAY - 1, model: 'qwen_x', page: 1, page_size: 50 }).total,
    ).toBe(0);
  });
});
