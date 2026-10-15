import { z } from 'zod';
import { parseDuration } from '../util/time.js';

/** 时长字段：接受 "5m"/"30s"/数字(ms)，归一化为毫秒 */
const durationMs = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      return parseDuration(v as string | number);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  });

const boolDefault = (d: boolean) => z.boolean().optional().transform((v) => v ?? d);
const numDefault = (d: number) => z.number().int().nonnegative().optional().transform((v) => v ?? d);

export const healthCheckSchema = z
  .object({
    path: z.string().default('/health'),
    interval: durationMs.optional(),
    interval_ms: z.number().int().positive().optional(),
    expect_status: z.number().int().optional(),
    fail_threshold: z.number().int().positive().optional(),
  })
  .transform((h) => ({
    path: h.path,
    interval_ms: h.interval_ms ?? (h.interval ? h.interval : 5000),
    expect_status: h.expect_status,
    fail_threshold: h.fail_threshold ?? 3,
  }));

export const backendSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['process', 'remote', 'cli']),
    base_url: z.string().url().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    cli_timeout: durationMs.optional(),
    cli_timeout_ms: z.number().int().optional(),
    /** 命中即视为后端降级（如 ROCm 初始化失败退回 CPU）的 stdout/stderr 子串，见 cli-runner */
    fail_on_output: z.array(z.string().min(1)).optional(),
    output_content_type: z.string().optional(),
    health_check: healthCheckSchema.optional(),
    start_timeout: durationMs.optional(),
    start_timeout_ms: z.number().int().optional(),
    stop_grace_period: durationMs.optional(),
    stop_grace_period_ms: z.number().int().optional(),
    idle_timeout: durationMs.optional(),
    idle_timeout_ms: z.number().int().optional(),
    auto_start: boolDefault(true),
    max_concurrency: numDefault(8),
    queue_size: numDefault(64),
    queue_timeout: durationMs.optional(),
    queue_timeout_ms: z.number().int().optional(),
    restart: z
      .object({
        max_retries: z.number().int().nonnegative().default(3),
        backoff_base: durationMs.optional(),
        backoff_base_ms: z.number().int().optional(),
      })
      .transform((r) => ({
        max_retries: r.max_retries,
        backoff_base_ms: r.backoff_base_ms ?? (r.backoff_base ?? 2000),
      }))
      .optional(),
    auth: z.object({ header: z.string(), value: z.string() }).optional(),
    required_memory: z.object({ mem_mb: z.number().int().positive() }).optional(),
    priority: z.number().int().optional().transform((v) => v ?? 0),
    evictable: boolDefault(true),
  })
  .passthrough()
  .superRefine((b, ctx) => {
    if ((b.type === 'process' || b.type === 'cli') && !b.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: `${b.type} backend "${b.name}" requires command` });
    }
    if (b.type === 'remote' && !b.base_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['base_url'], message: `remote backend "${b.name}" requires base_url` });
    }
  })
  .transform((b) => ({
    ...b,
    start_timeout_ms: b.start_timeout_ms ?? (b.start_timeout ?? 300_000),
    stop_grace_period_ms: b.stop_grace_period_ms ?? (b.stop_grace_period ?? 60_000),
    idle_timeout_ms: b.idle_timeout_ms ?? (b.idle_timeout ?? 900_000),
    queue_timeout_ms: b.queue_timeout_ms ?? (b.queue_timeout ?? 120_000),
    cli_timeout_ms: b.cli_timeout_ms ?? (b.cli_timeout ?? 300_000),
  }));

export const modelSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  backend: z.string().min(1),
  kind: z.enum(['chat', 'completion', 'embedding', 'image', 'asr', 'tts']),
  context_length: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  enabled: boolDefault(true),
});

export const resourcesSchema = z.object({
  enabled: boolDefault(true),
  probe_interval: durationMs.optional(),
  probe_interval_ms: z.number().int().optional(),
  safety_margin_mb: numDefault(1024),
  evict_wait_timeout: durationMs.optional(),
  evict_wait_timeout_ms: z.number().int().optional(),
  allow_evict_busy: boolDefault(false),
}).transform((r) => ({
  enabled: r.enabled,
  probe_interval_ms: r.probe_interval_ms ?? (r.probe_interval ?? 5000),
  safety_margin_mb: r.safety_margin_mb,
  evict_wait_timeout_ms: r.evict_wait_timeout_ms ?? (r.evict_wait_timeout ?? 600_000),
  allow_evict_busy: r.allow_evict_busy,
}));

export const serverSchema = z.object({
  listen: z.string().default('127.0.0.1:8000'),
  api_keys: z.array(z.string()).default([]),
  static_ui: boolDefault(true),
  // 看板登录（可选）：配置后前端需用户名密码登录（会话 Cookie）；
  // 与 api_keys 并存时，/v1 与 /api/v1 接受「Bearer API Key 或有效登录会话」任一。
  ui_auth: z
    .object({
      username: z.string().min(1),
      password: z.string().min(1),
      session_ttl: durationMs.optional(),
      session_ttl_ms: z.number().int().optional(),
    })
    .optional()
    .transform((u) =>
      u ? { ...u, session_ttl_ms: u.session_ttl_ms ?? (u.session_ttl ?? 7 * 24 * 3600_000) } : undefined,
    ),
});

export const storageSchema = z.object({
  type: z.literal('sqlite').default('sqlite'),
  path: z.string().default('./data/aya.db'),
  retention_days: z.number().int().positive().default(90),
});

export const proxySchema = z.object({
  idle_response_timeout: durationMs.optional(),
  idle_response_timeout_ms: z.number().int().optional(),
  max_upload_bytes: z.number().int().positive().optional(),
  log_raw_on_error: boolDefault(true),
  raw_log_max_bytes: z.number().int().positive().optional(),
}).transform((p) => ({
  idle_response_timeout_ms: p.idle_response_timeout_ms ?? (p.idle_response_timeout ?? 120_000),
  max_upload_bytes: p.max_upload_bytes ?? 104_857_600,
  log_raw_on_error: p.log_raw_on_error,
  raw_log_max_bytes: p.raw_log_max_bytes ?? 8192,
}));

export const appConfigSchema = z
  .object({
    server: serverSchema.default({}),
    storage: storageSchema.default({}),
    resources: resourcesSchema.default({}),
    proxy: proxySchema.default({}),
    backends: z.array(backendSchema).default([]),
    models: z.array(modelSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>();
    for (const b of cfg.backends) {
      if (names.has(b.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate backend name "${b.name}"` });
      }
      names.add(b.name);
    }
    const modelNames = new Set<string>();
    for (const m of cfg.models) {
      if (modelNames.has(m.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate model name "${m.name}"` });
      }
      modelNames.add(m.name);
      if (!names.has(m.backend)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom, path: ['models', m.name, 'backend'],
          message: `model "${m.name}" references unknown backend "${m.backend}"`,
        });
      }
    }
  });

export type ParsedAppConfig = z.infer<typeof appConfigSchema>;
