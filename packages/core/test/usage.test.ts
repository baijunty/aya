import { describe, it, expect } from 'vitest';
import { extractUsage, SseUsageStreamParser, mergeUsage } from '../src/proxy/usage.js';

describe('extractUsage', () => {
  it('非流式 usage + cached_tokens', () => {
    const u = extractUsage({
      usage: { prompt_tokens: 400, completion_tokens: 112, total_tokens: 512, prompt_tokens_details: { cached_tokens: 128 } },
    });
    expect(u).toEqual({ prompt_tokens: 400, completion_tokens: 112, total_tokens: 512, cached_tokens: 128 });
  });
  it('无 usage → undefined', () => {
    expect(extractUsage({ id: 'x' })).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
  });
  it('mergeUsage 后到覆盖', () => {
    expect(mergeUsage({ prompt_tokens: 1 }, { completion_tokens: 2 })).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
    expect(mergeUsage({ prompt_tokens: 1 }, { prompt_tokens: 5 })).toEqual({ prompt_tokens: 5 });
  });
});

describe('SSE usage 旁路解析', () => {
  it('捕获末尾 usage chunk（含跨 chunk 切分）', () => {
    const p = new SseUsageStreamParser();
    p.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    p.feed('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":4}}}\n\n');
    p.feed('data: [DONE]\n\n');
    expect(p.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 4 });
  });
  it('行被 chunk 切断也能解析', () => {
    const p = new SseUsageStreamParser();
    p.feed('data: {"usage":{"prompt_to');
    p.feed('kens":7}}\n');
    p.flush();
    expect(p.usage?.prompt_tokens).toBe(7);
  });
});
