// 核心类型定义（见 design.md §3）

/**
 * process = 常驻 HTTP 服务（网关托管进程）；remote = 已运行的远程服务；
 * cli = 一次性命令行工具（每请求 spawn，产出文件后退出，如 llama-tts 生成 wav）；
 * passthrough = 纯转发上游（远程 OpenAI 兼容 API）：不托管进程、不做健康探测，恒可服务。
 */
export type BackendType = 'process' | 'remote' | 'cli' | 'passthrough';
/**
 * decision = 原生决策模型（llama.cpp `POST /v1/systemone`，TypeSafe System One API）：
 * 对 state 回答带类型的题（choice/score/noul），只出概率化决策，不做文本生成。
 */
export type ModelKind = 'chat' | 'completion' | 'embedding' | 'image' | 'asr' | 'tts' | 'decision';

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
  /** cli 型：单次生成超时（ms），超时杀进程 */
  cli_timeout_ms: number;
  /**
   * cli 型：stdout/stderr 命中这些子串（不区分大小写）即判定后端已降级（如 GPU 不可用退回 CPU），
   * 立即杀掉进程组并以 backend_degraded 快速失败，不陪跑满 cli_timeout。
   */
  fail_on_output?: string[];
  /** cli 型：产出音频的 Content-Type（默认 audio/wav） */
  output_content_type?: string;
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
  /**
   * 上游 API Key：注入 `Authorization: Bearer <api_key>`（backend.auth 显式配置时以 auth 为准）。
   * 缺省则原样透传客户端自带的 Authorization —— 即「上游 key 同自身设置」，
   * 客户端没带就原样不带（由上游自行 401），网关不做拦截。
   */
  api_key?: string;
  /**
   * HTTP 代理（如 http://127.0.0.1:8389）：配置后转发与健康检查均经该代理连接上游
   * （undici ProxyAgent；https 上游走 CONNECT 隧道）。缺省直连。
   */
  proxy?: string;
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
  /** /v1/models architecture.input_modalities 覆盖；缺省按 kind 默认 */
  input_modalities?: string[];
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
  /** 看板登录（可选）：配置后前端需用户名密码登录（会话 Cookie） */
  ui_auth?: { username: string; password: string; session_ttl_ms: number };
}

export interface StorageConfig {
  type: 'sqlite';
  path: string;
  retention_days: number;
}

export interface ProxyConfig {
  idle_response_timeout_ms: number;
  max_upload_bytes: number;
  /** 失败请求记录原始请求/响应头部（排障用），默认开启 */
  log_raw_on_error: boolean;
  /** 原始报文单侧记录上限（字节），超出截断 */
  raw_log_max_bytes: number;
}

/** 后端 stdout/stderr 归档增长策略（<data_dir>/logs/<backend>.log） */
export interface LogsConfig {
  /** run=每次拉起后端清空只留本次运行；day=按天切并保留 keep_days 天（默认）；append=单文件追加 */
  mode: 'run' | 'day' | 'append';
  /** day 模式保留几天的历史文件；0 = 只留当天 */
  keep_days: number;
  /** 单文件上限（字节），超限截断保留最新内容；0 = 不限 */
  max_bytes: number;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  logs: LogsConfig;
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
  /** 最后一次请求「结束」时间（闲置计时起点）；0 = 从未活跃过 */
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
  /** 失败时记录的请求体头部原文（log_raw_on_error 开启时） */
  req_raw?: string;
  /** 失败时记录的上游响应头部原文（log_raw_on_error 开启时） */
  resp_raw?: string;
  /** 时间线（ms）：排队 / 后端启动 / 后端响应头 / 响应首字节 / 总时长 */
  timeline?: {
    queue: number;
    backend_start: number;
    backend_ttfb: number;
    /** 上游响应体首字节（流打开）。SSE 心跳与 role-only 起始帧早于首 token，故不等于 TTFT */
    first_byte?: number;
    /** ttft_ms 的取值来源：token=首个含 token 的帧；first_byte=认不出 token 帧，退回首字节 */
    ttft_source?: 'token' | 'first_byte';
    total: number;
  };
}

export interface BackendEventRow {
  id?: number;
  ts: number;
  backend: string;
  event: 'start' | 'ready' | 'stop' | 'crash' | 'idle_stop' | 'health_fail' | 'restart' | 'evict_stop' | 'restart_deferred_resource';
  reason?: string;
  detail?: string;
}
