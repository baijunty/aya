// 管理/统计 API 客户端
const BASE = '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { method: 'POST' });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 202) throw new Error(`${res.status} ${text}`);
  return json as T;
}

export interface Summary {
  range: { from: number; to: number };
  requests: { total: number; ok: number; fail: number; success_rate: number };
  tokens: { prompt: number; completion: number; total: number; cached: number };
  cache_hit_rate: number;
  latency_ms: { avg: number | null; p50: number | null; p95: number | null; p99: number | null };
  ttft_ms: { avg: number | null; p95: number | null };
  by_model: Array<{ model: string; requests: number; tokens: number }>;
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

export interface BackendStatus {
  name: string;
  type: string;
  state: string;
  inflight: number;
  queued: number;
  uptime_ms: number;
  last_activity_ms: number;
  idle_remaining_ms: number | null;
  idle_timeout_ms: number;
  counters: { starts: number; stops: number; crashes: number; idle_stops: number };
  pid?: number;
}

export interface RequestRow {
  request_id: string;
  ts_start: number;
  ts_end: number;
  model: string;
  endpoint: string;
  backend: string;
  is_stream: boolean;
  status_code: number;
  ok: boolean;
  error: string | null;
  latency_ms: number;
  ttft_ms: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
}

export interface ResourceInfo {
  ts: number;
  mem: { total_mb: number; free_mb: number };
  reserved: Array<{ backend: string; mem_mb: number; phase: string }>;
  load_ops: Array<{ backend: string; state: string; victims: string[]; waiters: number }>;
}

export const api = {
  summary: (from: number, to: number) =>
    get<Summary>(`/api/v1/stats/summary?from=${from}&to=${to}`),
  series: (from: number, to: number, metric: string, granularity?: string) =>
    get<{ granularity: string; metric: string; series: SeriesPoint[] }>(
      `/api/v1/stats/series?from=${from}&to=${to}&metric=${metric}${granularity ? `&granularity=${granularity}` : ''}`,
    ),
  requests: (from: number, to: number, page: number, filters: Record<string, string> = {}) =>
    get<{ total: number; page: number; page_size: number; items: RequestRow[] }>(
      `/api/v1/stats/requests?from=${from}&to=${to}&page=${page}&page_size=50${Object.entries(filters)
        .map(([k, v]) => (v ? `&${k}=${encodeURIComponent(v)}` : ''))
        .join('')}`,
    ),
  requestDetail: (id: string) => get<Record<string, unknown>>(`/api/v1/stats/requests/${id}`),
  backends: () => get<{ backends: BackendStatus[] }>('/api/v1/backends'),
  backendStats: (from: number, to: number) =>
    get<{ backends: Array<Record<string, unknown>> }>(`/api/v1/stats/backends?from=${from}&to=${to}`),
  resources: () => get<ResourceInfo>('/api/v1/resources'),
  events: (backend?: string) =>
    get<{ events: Array<Record<string, unknown>> }>(`/api/v1/events${backend ? `?backend=${backend}` : ''}`),
  loadModel: (name: string) => post<Record<string, unknown>>(`/api/v1/models/${name}/load`),
  unloadModel: (name: string) => post<Record<string, unknown>>(`/api/v1/models/${name}/unload`),
  startBackend: (name: string) => post<Record<string, unknown>>(`/api/v1/backends/${name}/start`),
  stopBackend: (name: string) => post<Record<string, unknown>>(`/api/v1/backends/${name}/stop`),
  restartBackend: (name: string) => post<Record<string, unknown>>(`/api/v1/backends/${name}/restart`),
};
