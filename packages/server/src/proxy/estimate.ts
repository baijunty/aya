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

/**
 * 流式响应的估算兜底：上游没在最后一个 chunk 带 usage（OpenAI 语义要求客户端声明
 * stream_options.include_usage，很多客户端不带）时，对累计下来的增量文本整段编码一次。
 * 整段而非逐帧编码：逐帧会把跨帧的 subword 各算一遍，长回答能虚高十几个百分点。
 */
export function estimateStreamTokens(streamText: string): { usage: Usage } | undefined {
  if (!streamText.trim()) return undefined;
  const completion = encode(streamText).length;
  if (completion === 0) return undefined;
  return {
    usage: {
      completion_tokens: completion,
      total_tokens: completion,
    },
  };
}
