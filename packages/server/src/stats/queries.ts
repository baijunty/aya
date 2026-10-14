import type { StatsStore } from './store.js';
import type { BackendEventRow } from '@aya/core';

export interface RangeFilter {
  from: number;
  to: number;
  model?: string;
  endpoint?: string;
}

function where(f: RangeFilter): { sql: string; params: unknown[] } {
  const conds = ['ts_start >= ?', 'ts_start <= ?'];
  const params: unknown[] = [f.from, f.to];
  if (f.model) {
    conds.push('model = ?');
    params.push(f.model);
  }
  if (f.endpoint) {
    conds.push('endpoint = ?');
    params.push(f.endpoint);
  }
  return { sql: conds.join(' AND '), params };
}

/** 应用层分位数（design.md §6.3：SQLite 无原生 percentile） */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export interface SummaryResult {
  range: { from: number; to: number };
  requests: { total: number; ok: number; fail: number; success_rate: number };
  tokens: { prompt: number; completion: number; total: number; cached: number };
  cache_hit_rate: number;
  latency_ms: { avg: number | null; p50: number | null; p95: number | null; p99: number | null };
  ttft_ms: { avg: number | null; p95: number | null };
  by_model: Array<{ model: string; requests: number; tokens: number }>;
}

export function querySummary(store: StatsStore, f: RangeFilter): SummaryResult {
  const { sql, params } = where(f);
  const db = store.db;
  const agg = db
    .prepare(
      `SELECT COUNT(*) total, SUM(ok) ok,
        COALESCE(SUM(prompt_tokens),0) pt, COALESCE(SUM(completion_tokens),0) ct,
        COALESCE(SUM(total_tokens),0) tt, COALESCE(SUM(cached_tokens),0) cached,
        AVG(latency_ms) lat_avg, AVG(ttft_ms) ttft_avg
       FROM request_logs WHERE ${sql}`,
    )
    .get(...params) as Record<string, number | null>;
  const latencies = (
    db.prepare(`SELECT latency_ms FROM request_logs WHERE ${sql} AND latency_ms IS NOT NULL ORDER BY latency_ms`)
      .all(...params) as Array<{ latency_ms: number }>
  ).map((r) => r.latency_ms);
  const ttfts = (
    db.prepare(`SELECT ttft_ms FROM request_logs WHERE ${sql} AND ttft_ms IS NOT NULL ORDER BY ttft_ms`)
      .all(...params) as Array<{ ttft_ms: number }>
  ).map((r) => r.ttft_ms);
  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens
       FROM request_logs WHERE ${sql} GROUP BY model ORDER BY requests DESC LIMIT 20`,
    )
    .all(...params) as Array<{ model: string; requests: number; tokens: number }>;

  const total = agg.total ?? 0;
  const ok = agg.ok ?? 0;
  return {
    range: { from: f.from, to: f.to },
    requests: { total, ok, fail: total - ok, success_rate: total ? Number((ok / total).toFixed(4)) : 0 },
    tokens: { prompt: agg.pt ?? 0, completion: agg.ct ?? 0, total: agg.tt ?? 0, cached: agg.cached ?? 0 },
    cache_hit_rate: agg.pt ? Number(((agg.cached ?? 0) / agg.pt).toFixed(4)) : 0,
    latency_ms: {
      avg: agg.lat_avg != null ? Math.round(agg.lat_avg) : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    ttft_ms: {
      avg: agg.ttft_avg != null ? Math.round(agg.ttft_avg) : null,
      p95: percentile(ttfts, 95),
    },
    by_model: byModel,
  };
}

export type Granularity = 'minute' | 'hour' | 'day';
export type Metric = 'requests' | 'latency' | 'ttft' | 'tokens' | 'cache';

const BUCKET_FMT: Record<Granularity, string> = {
  minute: '%Y-%m-%dT%H:%M:00',
  hour: '%Y-%m-%dT%H:00:00',
  day: '%Y-%m-%d 00:00:00',
};

export function autoGranularity(from: number, to: number): Granularity {
  const span = to - from;
  if (span <= 2 * 86400_000) return 'hour';
  if (span <= 31 * 86400_000) return 'day';
  return 'hour';
}

export interface SeriesPoint {
  bucket: number;
  value?: number;
  avg?: number | null;
  p95?: number | null;
  prompt?: number;
  completion?: number;
  cached?: number;
}

export function querySeries(
  store: StatsStore,
  f: RangeFilter,
  granularity: Granularity,
  metric: Metric,
): SeriesPoint[] {
  const { sql, params } = where(f);
  const fmt = BUCKET_FMT[granularity];
  const db = store.db;
  let rows: Array<Record<string, unknown>>;
  switch (metric) {
    case 'requests':
      rows = db
        .prepare(
          `SELECT strftime('${fmt}', ts_start/1000,'unixepoch') b, COUNT(*) v
           FROM request_logs WHERE ${sql} GROUP BY b ORDER BY b`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ bucket: Date.parse(String(r.b)), value: Number(r.v) }));
    case 'tokens':
      rows = db
        .prepare(
          `SELECT strftime('${fmt}', ts_start/1000,'unixepoch') b,
            COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c
           FROM request_logs WHERE ${sql} GROUP BY b ORDER BY b`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ bucket: Date.parse(String(r.b)), prompt: Number(r.p), completion: Number(r.c) }));
    case 'cache':
      rows = db
        .prepare(
          `SELECT strftime('${fmt}', ts_start/1000,'unixepoch') b,
            COALESCE(SUM(cached_tokens),0) c, COALESCE(SUM(prompt_tokens),0) p
           FROM request_logs WHERE ${sql} GROUP BY b ORDER BY b`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        bucket: Date.parse(String(r.b)),
        cached: Number(r.c),
        value: Number(r.p) ? Number((Number(r.c) / Number(r.p)).toFixed(4)) : 0,
      }));
    case 'latency':
    case 'ttft': {
      const col = metric === 'latency' ? 'latency_ms' : 'ttft_ms';
      const lrows = db
        .prepare(
          `SELECT strftime('${fmt}', ts_start/1000,'unixepoch') b, ${col} v
           FROM request_logs WHERE ${sql} AND ${col} IS NOT NULL ORDER BY b, v`,
        )
        .all(...params) as Array<{ b: string; v: number }>;
      const groups = new Map<string, number[]>();
      for (const r of lrows) {
        let arr = groups.get(r.b);
        if (!arr) groups.set(r.b, (arr = []));
        arr.push(r.v);
      }
      return [...groups.entries()].map(([b, vals]) => ({
        bucket: Date.parse(b),
        avg: Math.round(vals.reduce((a, x) => a + x, 0) / vals.length),
        p95: percentile(vals, 95),
      }));
    }
  }
}

export interface RequestListFilter extends RangeFilter {
  status?: 'ok' | 'fail';
  stream?: boolean;
  page: number;
  page_size: number;
}

export function queryRequests(store: StatsStore, f: RequestListFilter): { total: number; items: unknown[] } {
  const conds = ['ts_start >= ?', 'ts_start <= ?'];
  const params: unknown[] = [f.from, f.to];
  if (f.model) { conds.push('model = ?'); params.push(f.model); }
  if (f.endpoint) { conds.push('endpoint = ?'); params.push(f.endpoint); }
  if (f.status === 'ok') conds.push('ok = 1');
  if (f.status === 'fail') conds.push('ok = 0');
  if (f.stream !== undefined) { conds.push('is_stream = ?'); params.push(f.stream ? 1 : 0); }
  const whereSql = conds.join(' AND ');
  const db = store.db;
  const total = (db.prepare(`SELECT COUNT(*) c FROM request_logs WHERE ${whereSql}`).get(...params) as { c: number }).c;
  const offset = (f.page - 1) * f.page_size;
  const items = db
    .prepare(
      `SELECT request_id, ts_start, ts_end, model, endpoint, backend, key_id, is_stream,
        status_code, ok, error, latency_ms, ttft_ms, total_tokens, cached_tokens
       FROM request_logs WHERE ${whereSql} ORDER BY ts_start DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, f.page_size, offset)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, is_stream: !!row.is_stream, ok: !!row.ok };
    });
  return { total, items };
}

export function queryRequestDetail(store: StatsStore, requestId: string): Record<string, unknown> | undefined {
  const row = store.db.prepare(`SELECT * FROM request_logs WHERE request_id = ?`).get(requestId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const parse = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
  return {
    ...row,
    is_stream: !!row.is_stream,
    ok: !!row.ok,
    tokens_estimated: !!row.tokens_estimated,
    req_summary: parse(row.req_summary),
    timeline_ms: parse(row.timeline),
  };
}

export function queryBackendStats(
  store: StatsStore,
  f: { from: number; to: number },
): Array<Record<string, unknown>> {
  const db = store.db;
  const reqs = db
    .prepare(
      `SELECT backend, COUNT(*) requests FROM request_logs
       WHERE ts_start >= ? AND ts_start <= ? GROUP BY backend`,
    )
    .all(f.from, f.to) as Array<{ backend: string; requests: number }>;
  const events = db
    .prepare(
      `SELECT backend, event, COUNT(*) c FROM backend_events
       WHERE ts >= ? AND ts <= ? GROUP BY backend, event`,
    )
    .all(f.from, f.to) as Array<{ backend: string; event: string; c: number }>;
  const byBackend = new Map<string, Record<string, unknown>>();
  const ensure = (name: string) => {
    let o = byBackend.get(name);
    if (!o) {
      o = { backend: name, starts: 0, stops: 0, crashes: 0, idle_stops: 0, requests: 0 };
      byBackend.set(name, o);
    }
    return o;
  };
  for (const r of reqs) ensure(r.backend).requests = r.requests;
  for (const e of events) {
    const o = ensure(e.backend);
    if (e.event === 'start') o.starts = e.c;
    else if (e.event === 'stop' || e.event === 'evict_stop') o.stops = (o.stops as number) + e.c;
    else if (e.event === 'crash') o.crashes = e.c;
    else if (e.event === 'idle_stop') o.idle_stops = e.c;
  }
  return [...byBackend.values()];
}

export function queryEvents(
  store: StatsStore,
  opts: { backend?: string; limit: number },
): BackendEventRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.backend) { conds.push('backend = ?'); params.push(opts.backend); }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(opts.limit);
  return store.db
    .prepare(`SELECT * FROM backend_events ${whereSql} ORDER BY ts DESC LIMIT ?`)
    .all(...params) as BackendEventRow[];
}

/** 保留清理：删除过期 request_logs */
export function purgeRetention(store: StatsStore, retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * 86400_000;
  const r = store.db.prepare(`DELETE FROM request_logs WHERE ts_start < ?`).run(cutoff);
  store.db.prepare(`DELETE FROM backend_events WHERE ts < ?`).run(cutoff);
  return r.changes;
}
