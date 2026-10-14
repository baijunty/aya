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

  feedLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const obj = JSON.parse(payload);
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
  private collector = new SseUsageCollector();

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
