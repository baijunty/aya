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

describe('看板登录（ui_auth）', () => {
  let aya2: AyaApp;
  let base2: string;
  let mock2: MockBackend;

  beforeAll(async () => {
    mock2 = await startMockBackend();
    const tmp = mkdtempSync(path.join(tmpdir(), 'aya-uiauth-'));
    const cfgPath = path.join(tmp, 'config.yaml');
    writeFileSync(
      cfgPath,
      `
server:
  listen: "127.0.0.1:0"
  api_keys: ["sk-test-111"]
  static_ui: false
  ui_auth: { username: admin, password: "change-me", session_ttl: 1h }
storage: { path: "${path.join(tmp, 'a.db')}" }
backends:
  - { name: mock, type: remote, base_url: "${mock2.url}", health_check: { path: /health } }
models:
  - { name: m1, backend: mock, kind: chat }
`,
    );
    aya2 = createApp(cfgPath);
    await aya2.listen();
    const addr = aya2.app.server.address();
    base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }, 30000);

  afterAll(async () => {
    await aya2?.shutdown();
    await mock2?.close();
  });

  const cookieOf = (res: Response): string => {
    const sc = res.headers.get('set-cookie') ?? '';
    return sc.split(';')[0] ?? '';
  };

  it('未登录 → /api/v1 401 session_expired；/auth/me 报 ui_auth', async () => {
    const r = await fetch(`${base2}/api/v1/backends`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('session_expired');

    const me = await fetch(`${base2}/api/v1/auth/me`);
    expect(me.status).toBe(401);
  });

  it('错误密码 → 401 invalid_credentials；正确 → Cookie 放行', async () => {
    const bad = await fetch(`${base2}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe('invalid_credentials');

    const ok = await fetch(`${base2}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'change-me' }),
    });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.user).toBe('admin');
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^aya_session=[0-9a-f]{64}$/);

    // Cookie 放行管理 API 与 /v1
    const me = await fetch(`${base2}/api/v1/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const meJ = await me.json();
    expect(meJ.user).toBe('admin');
    expect(meJ.via).toBe('session');
    expect((await fetch(`${base2}/api/v1/backends`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base2}/v1/models`, { headers: { cookie } })).status).toBe(200);

    // 登出 → Cookie 失效
    const out = await fetch(`${base2}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    expect((await fetch(`${base2}/api/v1/backends`, { headers: { cookie } })).status).toBe(401);
  });

  it('Bearer API Key 与登录会话并存：Key 无需 Cookie 即放行', async () => {
    const r = await fetch(`${base2}/api/v1/backends`, { headers: { authorization: 'Bearer sk-test-111' } });
    expect(r.status).toBe(200);
    const me = await fetch(`${base2}/api/v1/auth/me`, { headers: { authorization: 'Bearer sk-test-111' } });
    expect((await me.json()).via).toBe('api_key');
  });
});
