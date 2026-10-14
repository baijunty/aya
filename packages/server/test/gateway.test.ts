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

  it('别名路由：gpt-4o-mini → mock-chat', async () => {
    const res = await post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: [] });
    expect(res.status).toBe(200);
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
