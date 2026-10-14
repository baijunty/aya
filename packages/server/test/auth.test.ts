import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockBackend, type MockBackend } from './mock-backend.js';
import { createApp, type AyaApp } from '../src/app.js';

let mock: MockBackend;
let aya: AyaApp;
let base: string;

beforeAll(async () => {
  mock = await startMockBackend();
  const tmp = mkdtempSync(path.join(tmpdir(), 'aya-auth-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  writeFileSync(
    cfgPath,
    `
server:
  listen: "127.0.0.1:0"
  api_keys: ["sk-test-111", "sk-test-222"]
  static_ui: false
storage: { path: "${path.join(tmp, 'a.db')}" }
backends:
  - { name: mock, type: remote, base_url: "${mock.url}", health_check: { path: /health } }
models:
  - { name: m1, backend: mock, kind: chat }
`,
  );
  aya = createApp(cfgPath);
  await aya.listen();
  const addr = aya.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 30000);

afterAll(async () => {
  await aya?.shutdown();
  await mock?.close();
});

describe('API Key 鉴权', () => {
  it('无 Key → 401', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.error.code).toBe('invalid_api_key');
  });

  it('错误 Key → 401', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  it('正确 Key → 200', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-test-111' } });
    expect(res.status).toBe(200);
  });

  it('chat 带 Key 成功，key_id 落库（脱敏）', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-222' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    const stats = await (await fetch(`${base}/api/v1/stats/requests`, { headers: { authorization: 'Bearer sk-test-111' } })).json();
    const withKey = stats.items.find((i: { key_id: string }) => i.key_id);
    expect(withKey).toBeTruthy();
    expect(withKey.key_id).toMatch(/^k[0-9a-f]{8}$/); // 短哈希，非明文
  });

  it('管理 API 同样需要鉴权', async () => {
    expect((await fetch(`${base}/api/v1/backends`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/backends`, { headers: { authorization: 'Bearer sk-test-111' } })).status).toBe(200);
  });

  it('/healthz 不鉴权', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
