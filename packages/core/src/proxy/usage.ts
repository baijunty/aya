/** usage / token 提取（design.md §5.3）——纯函数，可单测 */

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

export function extractUsage(obj: unknown): Usage | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const u = (obj as Record<string, unknown>).usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const out: Usage = {};
  const p = num(u.prompt_tokens);
  const c = num(u.completion_tokens);
  const t = num(u.total_tokens);
  const cached = num(details?.cached_tokens);
  if (p !== undefined) out.prompt_tokens = p;
  if (c !== undefined) out.completion_tokens = c;
  if (t !== undefined) out.total_tokens = t;
  if (cached !== undefined) out.cached_tokens = cached;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 该 SSE 帧是否携带「真正生成出来的 token」——用来把「流打开」与「首 token」分开。
 * 以下帧都不是 token，必须跳过：
 * - SSE 注释（`: ping` 心跳，压根不是 data: 帧，解析阶段就被丢掉）；
 * - 起始 role 帧 `delta:{role:"assistant"}`（content 为空）；
 * - progress 帧（delta 为空对象，gufo 在 prefill 期间持续发）。
 * 否则 TTFT 会落在响应头/role 帧上（约 30ms），prefill 全被算成 0，pp 虚高 1~2 个数量级。
 */
export function frameHasToken(obj: unknown): boolean {
  const choices = (obj as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return false;
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    // /v1/completions 方言：choices[].text
    if (typeof o.text === 'string' && o.text.length > 0) return true;
    const delta = o.delta;
    if (!delta || typeof delta !== 'object') continue;
    const d = delta as Record<string, unknown>;
    for (const k of ['content', 'reasoning_content', 'reasoning', 'thinking']) {
      if (typeof d[k] === 'string' && (d[k] as string).length > 0) return true;
    }
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return true;
  }
  return false;
}

/**
 * 一个 SSE 帧里「生成出来的文本」——用于上游不带 usage 时本地估算 completion tokens。
 * 与 frameHasToken 同一套认法：chat 走 delta.content / reasoning_*，
 * /v1/completions 方言走 choices[].text；role-only 与 progress 帧自然贡献 0。
 */
export function frameText(obj: unknown): string {
  const choices = (obj as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return '';
  let out = '';
  for (const c of choices) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    // /v1/completions 方言：choices[].text
    if (typeof o.text === 'string') out += o.text;
    const delta = o.delta;
    if (!delta || typeof delta !== 'object') continue;
    const d = delta as Record<string, unknown>;
    for (const k of ['content', 'reasoning_content', 'reasoning', 'thinking']) {
      if (typeof d[k] === 'string') out += d[k] as string;
    }
  }
  return out;
}

/** 合并 usage：后到的非空字段覆盖（流式末尾 usage chunk 语义） */
export function mergeUsage(base: Usage | undefined, extra: Usage | undefined): Usage | undefined {
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };
}

/**
 * SSE 行解析器：喂入 SSE 文本行，捕获 `data:` 帧中的 usage。
 * 只观察不改写；供转发旁路 Transform 使用。
 */
export class SseUsageCollector {
  private usage: Usage | undefined;

  /** onFrame：每个成功解析的 JSON data 帧都会回调一次（先于 usage 合并），供 TTFT 首 token 判定用 */
  constructor(private readonly onFrame?: (obj: unknown) => void) {}

  feedLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
      this.onFrame?.(obj);
      const u = extractUsage(obj);
      if (u) this.usage = mergeUsage(this.usage, u);
    } catch {
      /* 非 JSON 帧忽略 */
    }
  }

  get usage_(): Usage | undefined {
    return this.usage;
  }
}

/** 按 chunk 边界喂入（处理跨 chunk 的行切分） */
export class SseUsageStreamParser {
  private buf = '';
  private collector: SseUsageCollector;

  constructor(onFrame?: (obj: unknown) => void) {
    this.collector = new SseUsageCollector(onFrame);
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.collector.feedLine(line);
    }
  }

  flush(): void {
    if (this.buf) {
      this.collector.feedLine(this.buf);
      this.buf = '';
    }
  }

  get usage(): Usage | undefined {
    return this.collector.usage_;
  }
}
