// 核心类型定义（见 design.md §3）

export type BackendType = 'process' | 'remote';
export type ModelKind = 'chat' | 'completion' | 'embedding' | 'image' | 'asr' | 'tts';

export interface HealthCheckConfig {
  path: string;
  interval_ms: number;
  expect_status?: number;
  /** 连续失败多少次判定 crashed */
  fail_threshold: number;
}

export interface BackendConfig {
  name: string;
  type: BackendType;
  /** 转发目标根，如 http://127.0.0.1:8100/v1 */
  base_url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 供命令行模板插值使用的自定义参数（{model_path} 等） */
  [extra: string]: unknown;
  health_check?: HealthCheckConfig;
  start_timeout_ms: number;
  stop_grace_period_ms: number;
  /** 0 = 不自动停止 */
  idle_timeout_ms: number;
  auto_start: boolean;
  max_concurrency: number;
  queue_size: number;
  queue_timeout_ms: number;
  restart?: { max_retries: number; backoff_base_ms: number };
  auth?: { header: string; value: string };
  required_memory?: { mem_mb: number };
  /** 驱逐优先级，越大越不易被驱逐（默认 0） */
  priority: number;
  /** 是否可作为腾挪牺牲者（默认 true，false=常驻） */
  evictable: boolean;
}

export interface ModelConfig {
  name: string;
  aliases?: string[];
  backend: string;
  kind: ModelKind;
  context_length?: number;
  max_tokens?: number;
  enabled: boolean;
}

export interface ResourcesConfig {
  enabled: boolean;
  probe_interval_ms: number;
  safety_margin_mb: number;
  evict_wait_timeout_ms: number;
  /** 默认 false：不打断使用中的后端 */
  allow_evict_busy: boolean;
}

export interface ServerConfig {
  listen: string;
  api_keys: string[];
  static_ui: boolean;
}

export interface StorageConfig {
  type: 'sqlite';
  path: string;
  retention_days: number;
}

export interface ProxyConfig {
  idle_response_timeout_ms: number;
  max_upload_bytes: number;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  resources: ResourcesConfig;
  proxy: ProxyConfig;
  backends: BackendConfig[];
  models: ModelConfig[];
}

// —— 运行时后端状态 ——
export type BackendState = 'stopped' | 'starting' | 'ready' | 'draining' | 'crashed';

export interface BackendCounters {
  starts: number;
  stops: number;
  crashes: number;
  idle_stops: number;
}

export interface BackendRuntime {
  name: string;
  state: BackendState;
  pid?: number;
  pgid?: number;
  inflight: number;
  queued: number;
  /** 最后一次请求「结束」时间（闲置计时起点） */
  lastActivityAt: number;
  startedAt?: number;
  readyAt?: number;
  consecutiveHealthFails: number;
  restartAttempts: number;
  counters: BackendCounters;
}

// —— 资源与加载任务 ——
export interface ResourceSnapshot {
  ts: number;
  mem_total_mb: number;
  /** free = MemAvailable 语义（统一内存，不单独探测显存） */
  mem_free_mb: number;
}

export type LoadOpState = 'admitting' | 'evicting' | 'starting' | 'done' | 'failed';

export interface LoadOp {
  id: string;
  backend: string;
  state: LoadOpState;
  need: { mem_mb: number };
  /** 已选中等待其闲置后卸载的后端 */
  victims: string[];
  /** 附加到本任务的等待者数 */
  waiters: number;
  started_at: number;
  deadline: number;
  error?: string;
}

export type StopReason = 'idle' | 'manual' | 'manual_unload' | 'evict' | 'config_removed' | 'shutdown';

// —— 请求日志 ——
export interface RequestLog {
  request_id: string;
  ts_start: number;
  ts_end: number;
  client_addr: string;
  key_id?: string;
  endpoint: string;
  model: string;
  backend: string;
  is_stream: boolean;
  status_code: number;
  ok: boolean;
  error?: string;
  latency_ms: number;
  backend_ms: number;
  ttft_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  tokens_estimated: boolean;
  req_bytes: number;
  resp_bytes: number;
  /** 参数摘要，不含正文 */
  req_summary?: Record<string, unknown>;
  /** 时间线（ms）：排队 / 后端启动 / 后端首包 / 总时长 */
  timeline?: { queue: number; backend_start: number; backend_ttfb: number; total: number };
}

export interface BackendEventRow {
  id?: number;
  ts: number;
  backend: string;
  event: 'start' | 'ready' | 'stop' | 'crash' | 'idle_stop' | 'health_fail' | 'restart' | 'evict_stop' | 'restart_deferred_resource';
  reason?: string;
  detail?: string;
}
