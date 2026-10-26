// 管理/统计 API 客户端
const BASE = '';

// 会话过期（401）全局广播：App 监听后弹出登录页
export const AUTH_EXPIRED_EVENT = 'aya-auth-expired';
function notifyAuthExpired(status: number): void {
  if (status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) {
    notifyAuthExpired(res.status);
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { method: 'POST' });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 202) {
    notifyAuthExpired(res.status);
    throw new Error(`${res.status} ${text}`);
  }
  return json as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 202) {
    notifyAuthExpired(res.status);
    throw new Error(`${res.status} ${text}`);
  }
  return json as T;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { method: 'DELETE' });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    notifyAuthExpired(res.status);
    throw new Error(`${res.status} ${text}`);
  }
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
  uptime_ms: number | null;
  last_activity_ms: number | null;
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
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  /** prefill 速度 tok/s（流式；(prompt−cached)/(ttft−排队)，与后端 prefill_tps 同口径；TTFT 未量到 token 帧时为空） */
  pp_tokens_s: number | null;
  /** 解码速度 tok/s（流式；completion/(latency−ttft)；TTFT 未量到 token 帧时为空） */
  tg_tokens_s: number | null;
}

export interface HwCpuInfo {
  model: string;
  cores: number;
  usage_pct: number | null;
  load1: number;
  load5: number;
  load15: number;
  temp_c: number | null;
}

export interface HwGpuInfo {
  index: number;
  name: string;
  busy_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  gtt_used_mb: number | null;
  gtt_total_mb: number | null;
  power_w: number | null;
  temp_c: number | null;
  clock_mhz: number | null;
}

export interface HwNpuInfo {
  name: string;
  pci: string;
  fw_version: string | null;
  util_pct: number | null;
  note?: string;
}

export interface HwSnapshot {
  ts: number;
  cpu: HwCpuInfo;
  gpus: HwGpuInfo[];
  npus: HwNpuInfo[];
  swap: { total_mb: number; used_mb: number } | null;
}

export interface ResourceInfo {
  ts: number;
  mem: { total_mb: number; free_mb: number };
  hw?: HwSnapshot;
  reserved: Array<{ backend: string; mem_mb: number; phase: string; live_mb?: number }>;
  loading?: string;
  load_ops: Array<{ backend: string; state: string; victims: string[]; waiters: number }>;
}

export interface Voice {
  id: string;
  object: string;
  created_at: number;
  name: string;
  type: string;
  metadata?: { filename?: string | null; content_type?: string | null; bytes?: number; consent?: string | null };
}

export const api = {
  summary: (from: number, to: number) =>
    get<Summary>(`/api/v1/stats/summary?from=${from}&to=${to}`),
  series: (from: number, to: number, metric: string, granularity?: string, model?: string) =>
    get<{ granularity: string; metric: string; series: SeriesPoint[] }>(
      `/api/v1/stats/series?from=${from}&to=${to}&metric=${metric}${granularity ? `&granularity=${granularity}` : ''}${model ? `&model=${encodeURIComponent(model)}` : ''}`,
    ),
  models: () => get<{ models: Array<{ name: string; kind: string; enabled: boolean }> }>('/api/v1/models'),
  requests: (from: number, to: number, page: number, filters: Record<string, string> = {}) =>
    get<{ total: number; page: number; page_size: number; items: RequestRow[] }>(
      `/api/v1/stats/requests?from=${from}&to=${to}&page=${page}&page_size=50${Object.entries(filters)
        .map(([k, v]) => (v ? `&${k}=${encodeURIComponent(v)}` : ''))
        .join('')}`,
    ),
  requestDetail: (id: string) => get<Record<string, unknown>>(`/api/v1/stats/requests/${id}`),
  purgeRequests: (before: number, dryRun: boolean) =>
    postJson<{
      dry_run: boolean;
      before: number;
      /** dry_run=false 时返回 */
      deleted?: number;
      events_deleted?: number;
      /** dry_run=true 时返回 */
      would_delete?: number;
      events_would_delete?: number;
    }>('/api/v1/stats/requests/purge', { before, dry_run: dryRun }),
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
  voices: () => get<{ object: string; data: Voice[] }>('/v1/audio/voices'),
  uploadVoice: (name: string, file: File, consent?: string) => {
    const fd = new FormData();
    fd.append('name', name);
    if (consent) fd.append('consent', consent);
    fd.append('audio_sample', file, file.name);
    return fetch(BASE + '/v1/audio/voices', { method: 'POST', body: fd }).then(async (res) => {
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        notifyAuthExpired(res.status);
        throw new Error(`${res.status} ${text}`);
      }
      return json as Voice;
    });
  },
  renameVoice: (id: string, name: string) => postJson<Voice>(`/v1/audio/voices/${id}`, { name }),
  deleteVoice: (id: string) => del<{ id: string; deleted: boolean }>(`/v1/audio/voices/${id}`),
  voiceSampleUrl: (id: string) => `${BASE}/v1/audio/voices/${id}?sample=1`,
  authMe: () => get<{ ui_auth: boolean; user: string | null; via: string }>('/api/v1/auth/me'),
  login: (username: string, password: string) =>
    postJson<{ status: string; user: string; expires_at: number }>('/api/v1/auth/login', { username, password }),
  logout: () => post<{ status: string }>('/api/v1/auth/logout'),
};
