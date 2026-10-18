import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockBackend, type MockBackend } from './mock-backend.js';
import { createApp, type AyaApp } from '../src/app.js';

let mock: MockBackend;
let aya: AyaApp;
let base: string;
let tmp: string;

beforeAll(async () => {
  mock = await startMockBackend();
  tmp = mkdtempSync(path.join(tmpdir(), 'aya-test-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  writeFileSync(
    cfgPath,
    `
server:
  listen: "127.0.0.1:0"
  static_ui: false
storage:
  type: sqlite
  path: ${path.join(tmp, 'aya.db')}
backends:
  - name: mock
    type: remote
    base_url: "${mock.url}"
    health_check: { path: /health }
models:
  - name: mock-chat
    aliases: ["gpt-4o-mini"]
    backend: mock
    kind: chat
    context_length: 4096
  - name: mock-fail
    backend: mock
    kind: chat
  - name: mock-framing
    backend: mock
    kind: chat
  - name: mock-embed
    backend: mock
    kind: embedding
  - name: mock-asr
    backend: mock
    kind: asr
  - name: mock-tts
    backend: mock
    kind: tts
  - name: mock-image
    backend: mock
    kind: image
  - name: mock-decision
    aliases: ["d1"]
    backend: mock
    kind: decision
    input_modalities: ["text", "image"]
`,
  );
  aya = createApp(cfgPath);
  await aya.listen();
  const addr = aya.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
}, 30000);

afterAll(async () => {
  await aya?.shutdown();
  await mock?.close();
});

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

describe('Aya gateway (remote mock backend)', () => {
  it('GET /healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.status).toBe('ok');
    expect(j.backends[0].name).toBe('mock');
  });

  it('GET /v1/models 返回启用模型', async () => {
    const res = await fetch(`${base}/v1/models`);
    const j = await res.json();
    expect(j.object).toBe('list');
    const ids = j.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('mock-chat');
    expect(ids).not.toContain('gpt-4o-mini'); // 别名不单独列出
  });

  it('chat 非流式：透传 + usage 落库', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-aya-request-id')).toBeTruthy();
    const j = await res.json();
    expect(j.choices[0].message.content).toBe('你好世界');
    expect(j.usage.total_tokens).toBe(14);
  });

  it('chat 流式：SSE 逐块透传 + 末尾 usage', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-chat',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('你好');
    expect(text).toContain('"cached_tokens":6');
  });

  it('chat 流式：TTFT 落在首个带 token 的帧，不是响应头/role 帧', async () => {
    // mock 后端每 20ms 一帧：第 1 帧只有 role。按首字节计时会让 TTFT≈首包，
    // 于是 pp（prefill 速度）虚高一个数量级——这里锁死测量点。
    const res = await post('/v1/chat/completions', {
      model: 'mock-chat',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const id = res.headers.get('x-aya-request-id')!;
    await res.text();
    await new Promise((r) => setTimeout(r, 600));
    const d = await (await fetch(`${base}/api/v1/stats/requests/${id}`)).json();
    expect(d.is_stream).toBe(true);
    expect(d.timeline_ms.ttft_source).toBe('token');
    expect(d.timeline_ms.first_byte).toBeTypeOf('number');
    expect(d.ttft_ms - d.timeline_ms.first_byte).toBeGreaterThanOrEqual(10);
  });

  it('别名路由：gpt-4o-mini → mock-chat', async () => {
    const res = await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: [] });
    expect(res.status).toBe(200);
  });

  it('GET /v1/models architecture：decision 模型 output_modalities 含 decisions', async () => {
    const res = await fetch(`${base}/v1/models`);
    const j = await res.json();
    const d = j.data.find((m: { id: string }) => m.id === 'mock-decision');
    expect(d.architecture.output_modalities).toEqual(['decisions']);
    expect(d.architecture.input_modalities).toEqual(['text', 'image']); // 配置覆盖生效
    const c = j.data.find((m: { id: string }) => m.id === 'mock-chat');
    expect(c.architecture.output_modalities).toEqual(['text']);
    expect(c.architecture.input_modalities).toEqual(['text']);
  });

  it('systemone：决策模型路由 + answers 透传 + input_tokens 落库', async () => {
    const state = 'Customer message: I was charged twice for my order last week.';
    const res = await post('/v1/systemone', {
      model: 'mock-decision',
      state,
      questions: {
        route: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: null, shipping: null } },
        angry: { type: 'noul', instructions: 'Is the customer angry?' },
        urgency: { type: 'score', instructions: 'How urgent is this?', criteria: ['can wait', 'today', 'right now'] },
      },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.answers.route.choice).toBe('billing');
    expect(j.answers.route.probabilities.billing).toBe(0.5);
    expect(j.answers.angry.noul).toBeTypeOf('number');
    expect(j.answers.urgency.legend['2']).toBe('right now');
    expect(j.usage).toEqual({ input_tokens: 152, output_tokens: 0 });
    // 落库：systemone 的 input_tokens/output_tokens 方言记入 prompt/completion tokens
    const id = res.headers.get('x-aya-request-id')!;
    await new Promise((r) => setTimeout(r, 600));
    const d = await (await fetch(`${base}/api/v1/stats/requests/${id}`)).json();
    expect(d.endpoint).toBe('systemone');
    expect(d.model).toBe('mock-decision');
    expect(d.is_stream).toBe(false);
    expect(d.prompt_tokens).toBe(152);
    expect(d.completion_tokens).toBe(0);
    expect(d.total_tokens).toBe(152);
    expect(d.tokens_estimated).toBe(false);
    expect(d.req_summary.questions_count).toBe(3);
    expect(d.req_summary.state_chars).toBe(state.length);
  });

  it('systemone：kind 不符 / 缺 model → 400', async () => {
    const res = await post('/v1/systemone', {
      model: 'mock-chat', state: 'x', questions: { a: { type: 'noul', instructions: 'q' } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('endpoint_kind_mismatch');
    const res2 = await post('/v1/systemone', { state: 'x', questions: { a: { type: 'noul', instructions: 'q' } } });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error.code).toBe('missing_model');
  });

  it('systemone：上游 400（questions 缺失）原样透传', async () => {
    const res = await post('/v1/systemone', { model: 'mock-decision', state: 'x' });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.message).toContain('questions');
  });

  it('大请求体也必须带 content-length（不得退化为 chunked，gufo 会 400 malformed request）', async () => {
    // 超过单个 socket 读/PassThrough 缓冲（约 64KB）时，undici 无法自行推出 body 长度，
    // 若不显式透传客户端的 Content-Length 就会发 Transfer-Encoding: chunked。
    const res = await post('/v1/chat/completions', {
      model: 'mock-framing',
      messages: [{ role: 'user', content: 'x'.repeat(80 * 1024) }],
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.framing.bytes).toBeGreaterThan(64 * 1024);
    expect(j.framing.transferEncoding).toBeNull();
    expect(Number(j.framing.contentLength)).toBe(j.framing.bytes);
  });

  it('embeddings 透传', async () => {
    const res = await post('/v1/embeddings', { model: 'mock-embed', input: 'hello' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('TTS 二进制流透传', async () => {
    const res = await post('/v1/audio/speech', { model: 'mock-tts', input: '你好', voice: 'alloy' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(900);
  });

  it('ASR multipart 透传', async () => {
    const fd = new FormData();
    fd.append('model', 'mock-asr');
    fd.append('file', new Blob([Buffer.from('fake-audio-bytes')], { type: 'audio/wav' }), 'a.wav');
    const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.text).toContain('transcribed');
  });

  it('images 透传', async () => {
    const res = await post('/v1/images/generations', { model: 'mock-image', prompt: 'cat' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data[0].b64_json).toBe('aGVsbG8=');
  });

  it('缺 model → 400 missing_model', async () => {
    const res = await post('/v1/chat/completions', { messages: [] });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe('missing_model');
  });

  it('请求体 > PEEK_MAX(256KB)：model 在头部也必须路由成功（回归：前缀截断曾致 400 missing_model）', async () => {
    // 300KB 请求体：peek 前缀（256KB）装不下整个 JSON，整体 parse 必失败；
    // 旧实现依赖整体 parse，成败取决于 TCP 分块边界。修复后由前缀扫描兜底。
    const res = await post('/v1/chat/completions', {
      model: 'mock-chat',
      messages: [{ role: 'user', content: 'x'.repeat(300 * 1024) }],
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.choices[0].message.content).toBe('你好世界');
  });

  it('未知模型 → 404 model_not_found', async () => {
    const res = await post('/v1/chat/completions', { model: 'nope', messages: [] });
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.error.code).toBe('model_not_found');
  });

  it('kind 不符 → 400 endpoint_kind_mismatch', async () => {
    const res = await post('/v1/chat/completions', { model: 'mock-asr', messages: [] });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe('endpoint_kind_mismatch');
  });

  it('失败请求记录原始请求/响应（req_raw / resp_raw / error 提取上游信息）', async () => {
    const res = await post('/v1/chat/completions', {
      model: 'mock-fail',
      messages: [{ role: 'user', content: 'boom-raw-content' }],
    });
    expect(res.status).toBe(500);
    const rid = res.headers.get('x-aya-request-id')!;
    await new Promise((r) => setTimeout(r, 400));
    const detail = await (await fetch(`${base}/api/v1/stats/requests/${rid}`)).json();
    expect(detail.ok).toBe(false);
    // error 列提取上游 OpenAI 风格错误信息
    expect(detail.error).toContain('CUDA out of memory');
    // 原始请求体头部（截断原文）
    expect(detail.req_raw).toContain('mock-fail');
    expect(detail.req_raw).toContain('boom-raw-content');
    // 上游错误响应头部
    expect(detail.resp_raw).toContain('CUDA out of memory');
  });

  it('拦截请求（缺 model）也记录 req_raw', async () => {
    const res = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'no-model-here' }] });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 400));
    const list = await (await fetch(`${base}/api/v1/stats/requests?status=fail&model=`)).json();
    const row = list.items.find((i: { error: string }) => i.error === 'missing_model');
    expect(row).toBeTruthy();
    const detail = await (await fetch(`${base}/api/v1/stats/requests/${row.request_id}`)).json();
    expect(detail.req_raw).toContain('no-model-here');
  });

  it('统计 API：summary 有数据（含 cached_tokens）', async () => {
    // 等待异步落库
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${base}/api/v1/stats/summary`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.requests.total).toBeGreaterThanOrEqual(6);
    expect(j.tokens.cached).toBeGreaterThanOrEqual(6);
    expect(j.cache_hit_rate).toBeGreaterThan(0);
    expect(j.latency_ms.p95).toBeTypeOf('number');
  });

  it('统计 API：requests 明细 + 详情下钻', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${base}/api/v1/stats/requests?model=mock-chat`);
    const j = await res.json();
    expect(j.total).toBeGreaterThanOrEqual(3);
    const first = j.items[0];
    const detail = await fetch(`${base}/api/v1/stats/requests/${first.request_id}`);
    const d = await detail.json();
    expect(d.request_id).toBe(first.request_id);
    expect(d.timeline_ms).toBeTruthy();
  });

  it('统计 API：series 聚合', async () => {
    const res = await fetch(`${base}/api/v1/stats/series?granularity=minute&metric=requests`);
    const j = await res.json();
    expect(j.series.length).toBeGreaterThan(0);
    expect(j.series[0].value).toBeGreaterThan(0);
  });

  it('管理 API：backends 状态', async () => {
    const res = await fetch(`${base}/api/v1/backends`);
    const j = await res.json();
    expect(j.backends[0].state).toBe('ready');
  });
});
