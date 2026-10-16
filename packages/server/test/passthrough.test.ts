import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMockBackend, startMockProxy, closedPort, type MockBackend, type MockProxy } from './mock-backend.js';
import { createApp, type AyaApp } from '../src/app.js';

let mock: MockBackend;
let aya: AyaApp;
let base: string;

beforeAll(async () => {
  mock = await startMockBackend();
  const tmp = mkdtempSync(path.join(tmpdir(), 'aya-passthru-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  writeFileSync(
    cfgPath,
    `
server:
  listen: "127.0.0.1:0"
  api_keys: ["sk-gw-own"]
  static_ui: false
storage: { path: "${path.join(tmp, 'p.db')}" }
backends:
  # 纯转发：上游 key 独立配置（与网关自身 api_keys 无关）
  - name: pt-keyed
    type: passthrough
    base_url: "${mock.url}"
    api_key: "sk-upstream-secret"
  # 纯转发：不配上游 key → 透传客户端 Authorization（上游 key 同自身设置）
  - name: pt-passthru
    type: passthrough
    base_url: "${mock.url}"
  # 纯转发：显式 auth 头优先于 api_key
  - name: pt-auth
    type: passthrough
    base_url: "${mock.url}"
    auth: { header: Authorization, value: "Bearer sk-explicit" }
    api_key: "sk-ignored"
models:
  - { name: pt-chat, backend: pt-keyed, kind: chat }
  - { name: pt-open, backend: pt-passthru, kind: chat }
  - { name: pt-authm, backend: pt-auth, kind: chat }
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

async function chat(model: string, auth?: string) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { res, j: await res.json() };
}

describe('passthrough 纯转发后端', () => {
  it('网关鉴权照常生效：无 Key → 401', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
  });

  it('后端状态恒为 ready（不托管进程、不探测健康）', async () => {
    const j = await (await fetch(`${base}/api/v1/backends`, { headers: { authorization: 'Bearer sk-gw-own' } })).json();
    const pt = j.backends.filter((b: { type: string }) => b.type === 'passthrough');
    expect(pt.length).toBe(3);
    for (const b of pt) {
      expect(b.state).toBe('ready');
      expect(b.uptime_ms).toBeNull();
    }
  });

  it('配置 api_key：上游收到注入的 Bearer key，客户端 key 被覆盖', async () => {
    const { res, j } = await chat('pt-chat', 'sk-gw-own');
    expect(res.status).toBe(200);
    expect(j.auth).toBe('Bearer sk-upstream-secret');
  });

  it('客户端 key 与上游 key 相互独立：网关校验自身 api_keys，上游只看到配置的 api_key', async () => {
    // 网关 api_keys 非空 → 客户端必须带合法 key 才能进入路由；
    // 上游收到的是后端配置的 sk-upstream-secret（与客户端 key 无关）
    const { res, j } = await chat('pt-chat', 'sk-gw-own');
    expect(res.status).toBe(200);
    expect(j.auth).toBe('Bearer sk-upstream-secret');
  });

  it('未配 api_key：客户端 Authorization 原样透传（上游 key 同自身设置）', async () => {
    const { res, j } = await chat('pt-open', 'sk-gw-own');
    expect(res.status).toBe(200);
    expect(j.auth).toBe('Bearer sk-gw-own');
  });

  it('显式 auth 头优先于 api_key', async () => {
    const { res, j } = await chat('pt-authm', 'sk-gw-own');
    expect(res.status).toBe(200);
    expect(j.auth).toBe('Bearer sk-explicit');
  });

  it('流式透传正常（SSE + usage 落库）', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-gw-own' },
      body: JSON.stringify({ model: 'pt-chat', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    await new Promise((r) => setTimeout(r, 400));
    const rid = res.headers.get('x-aya-request-id')!;
    const d = await (await fetch(`${base}/api/v1/stats/requests/${rid}`, { headers: { authorization: 'Bearer sk-gw-own' } })).json();
    expect(d.total_tokens).toBe(14);
    expect(d.backend).toBe('pt-keyed');
  });

  it('load/unload 对 passthrough 为 noop', async () => {
    const h = { authorization: 'Bearer sk-gw-own' };
    const l = await fetch(`${base}/api/v1/models/pt-chat/load`, { method: 'POST', headers: h });
    expect(l.status).toBe(200);
    expect((await l.json()).status).toBe('noop');
    const u = await fetch(`${base}/api/v1/models/pt-chat/unload`, { method: 'POST', headers: h });
    expect(u.status).toBe(200);
    expect((await u.json()).status).toBe('noop');
  });
});

describe('passthrough 透传（网关不鉴权 + 客户端不带 key）', () => {
  let aya2: AyaApp;
  let base2: string;

  beforeAll(async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aya-passthru2-'));
    const cfgPath = path.join(tmp, 'config.yaml');
    writeFileSync(
      cfgPath,
      `
server:
  listen: "127.0.0.1:0"
  static_ui: false
storage: { path: "${path.join(tmp, 'p2.db')}" }
backends:
  - name: pt
    type: passthrough
    base_url: "${mock.url}"
models:
  - { name: m, backend: pt, kind: chat }
`,
    );
    aya2 = createApp(cfgPath);
    await aya2.listen();
    const addr = aya2.app.server.address();
    base2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }, 30000);

  afterAll(async () => {
    await aya2?.shutdown();
  });

  it('客户端不带 Authorization：网关放行，上游也不收到 Authorization（原样透传，由上游自行 401）', async () => {
    const res = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.auth).toBeNull();
  });

  it('客户端带任意 key：上游原样收到', async () => {
    const res = await fetch(`${base2}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-client' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.auth).toBe('Bearer sk-client');
  });
});

describe('passthrough 经 HTTP 代理出网（backend.proxy）', () => {
  let proxy: MockProxy;
  let aya3: AyaApp;
  let base3: string;

  beforeAll(async () => {
    proxy = await startMockProxy();
    const dead = await closedPort();
    const tmp = mkdtempSync(path.join(tmpdir(), 'aya-passthru-proxy-'));
    const cfgPath = path.join(tmp, 'config.yaml');
    writeFileSync(
      cfgPath,
      `
server:
  listen: "127.0.0.1:0"
  api_keys: ["sk-gw-own"]
  static_ui: false
storage: { path: "${path.join(tmp, 'p3.db')}" }
backends:
  # 经代理：流量应全部落在 mock 代理上
  - name: pt-via-proxy
    type: passthrough
    base_url: "${mock.url}"
    api_key: "sk-upstream-secret"
    proxy: "${proxy.url}"
  # 代理端口已关闭：直连本可成功，失败即证明真的经了代理而非直连
  - name: pt-dead-proxy
    type: passthrough
    base_url: "${mock.url}"
    proxy: "http://127.0.0.1:${dead}"
models:
  - { name: m-proxy, backend: pt-via-proxy, kind: chat }
  - { name: m-dead, backend: pt-dead-proxy, kind: chat }
`,
    );
    aya3 = createApp(cfgPath);
    await aya3.listen();
    const addr = aya3.app.server.address();
    base3 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }, 30000);

  afterAll(async () => {
    await aya3?.shutdown();
    await proxy?.close();
  });

  async function chat(model: string) {
    const res = await fetch(`${base3}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-gw-own' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { res, j: await res.json() };
  }

  it('请求经代理到达上游：代理命中计数增加，上游收到注入的 Bearer key', async () => {
    const before = proxy.hits();
    const { res, j } = await chat('m-proxy');
    expect(res.status).toBe(200);
    expect(j.auth).toBe('Bearer sk-upstream-secret');
    expect(proxy.hits()).toBeGreaterThan(before);
  });

  it('代理不可达 → 502 upstream_unreachable（证明未回退直连）', async () => {
    const { res, j } = await chat('m-dead');
    expect(res.status).toBe(502);
    expect(j.error.code).toBe('upstream_unreachable');
  });
});
