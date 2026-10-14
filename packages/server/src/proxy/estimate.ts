import { encode } from 'gpt-tokenizer';
import type { Usage } from '@aya/core';

/**
 * 本地估算兜底（design.md §5.3）：上游无 usage 时对非流式 chat 响应估算 completion tokens。
 * 估算值打 estimated 标记；prompt 侧无法从响应还原，记 0。
 */
export function estimateTokens(responseJson: string): { usage: Usage } | undefined {
  try {
    const parsed = JSON.parse(responseJson) as Record<string, unknown>;
    let completion = 0;
    const choices = parsed.choices as Array<{ message?: { content?: string } }> | undefined;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        if (typeof c?.message?.content === 'string') completion += encode(c.message.content).length;
      }
    }
    if (completion === 0) return undefined;
    return {
      usage: {
        completion_tokens: completion,
        total_tokens: completion,
      },
    };
  } catch {
    return undefined;
  }
}
