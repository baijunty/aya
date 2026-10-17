import { describe, it, expect } from 'vitest';
import { extractUsage, frameHasToken, frameText, SseUsageStreamParser, mergeUsage } from '../src/proxy/usage.js';

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

describe('frameHasToken（TTFT 首 token 判定）', () => {
  it('role-only 起始帧与 progress 帧不算 token', () => {
    expect(frameHasToken({ choices: [{ index: 0, delta: { role: 'assistant' } }] })).toBe(false);
    expect(frameHasToken({ choices: [{ index: 0, delta: {} }], progress: { phase: 'prefill' } })).toBe(false);
    expect(frameHasToken({ choices: [], usage: { total_tokens: 3 } })).toBe(false);
    expect(frameHasToken({ choices: null })).toBe(false);
  });
  it('content / reasoning / tool_calls / completions.text 算 token', () => {
    expect(frameHasToken({ choices: [{ delta: { content: '你' } }] })).toBe(true);
    expect(frameHasToken({ choices: [{ delta: { content: '' } }] })).toBe(false); // 空串不是 token
    expect(frameHasToken({ choices: [{ delta: { reasoning_content: 'thinking' } }] })).toBe(true);
    expect(frameHasToken({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })).toBe(true);
    expect(frameHasToken({ choices: [{ text: 'hi' }] })).toBe(true);
  });
  it('gufo 流：跳过响应头后的 role 帧与 : ping 注释，落在首个 content 帧', () => {
    const seen: number[] = [];
    let idx = 0;
    const p = new SseUsageStreamParser((frame) => {
      if (frameHasToken(frame)) seen.push(idx);
      idx++;
    });
    p.feed(': ping\n\n'); // SSE 注释：不进 onFrame
    p.feed('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'); // 1 帧，非 token
    p.feed('data: {"choices":[{"delta":{}}],"progress":{"phase":"prefill","tokens":4096}}\n\n');
    p.feed('data: {"choices":[{"delta":{"content":"哈"}}]}\n\n'); // 应命中
    p.feed('data: {"choices":[{"delta":{"content":"喽"}}]}\n\n');
    p.flush();
    expect(seen).toEqual([2, 3]); // 第 3、4 帧（role 帧与 progress 帧被跳过）
    expect(idx).toBe(4);
  });
});

describe('frameText（上游不带 usage 时的估算素材）', () => {
  it('累计 content / reasoning / completions 方言的 text，role 帧与 usage 帧贡献 0', () => {
    let text = '';
    const p = new SseUsageStreamParser((frame) => {
      text += frameText(frame);
    });
    p.feed('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    p.feed('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    p.feed('data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n');
    p.feed('data: {"choices":[{"text":" 以及 completions 方言"}]}\n\n');
    p.feed('data: {"choices":[],"usage":{"total_tokens":9}}\n\n');
    p.feed('data: [DONE]\n\n');
    expect(text).toBe('你好想一想 以及 completions 方言');
  });
  it('非对象帧 / 缺 choices / 数组里混 null 都不炸', () => {
    expect(frameText(null)).toBe('');
    expect(frameText({})).toBe('');
    expect(frameText({ choices: [null, { delta: { content: 'x' } }] })).toBe('x');
  });
});
