import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AyaApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockScript = path.join(__dirname, 'mock-process-backend.mjs');
const apps: AyaApp[] = [];

afterAll(async () => {
  for (const a of apps) await a.shutdown().catch(() => undefined);
});

async function boot(configYaml: string): Promise<{ aya: AyaApp; base: string; tmp: string }> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'aya-proc-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  writeFileSync(cfgPath, configYaml.replace(/\{tmp\}/g, tmp).replaceAll('{mockScript}', mockScript));
  const aya = createApp(cfgPath);
  await aya.listen();
  apps.push(aya);
  const addr = aya.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { aya, base: `http://127.0.0.1:${port}`, tmp };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function procBackend(port: number, extra = ''): string {
  return `
backends:
  - name: proc
    type: process
    command: node
    args: ["{mockScript}", "--port", "${port}"]
    base_url: "http://127.0.0.1:${port}/v1"
    health_check: { path: /health, interval: 200ms }
    start_timeout: 15s
    stop_grace_period: 3s
    idle_timeout: 2s
    restart: { max_retries: 2, backoff_base: 300ms }
    ${extra}
models:
  - { name: pchat, backend: proc, kind: chat }
`;
}

const head = (listenPort: number) => `
server: { listen: "127.0.0.1:${listenPort}", static_ui: false }
storage: { path: "{tmp}/aya.db" }
resources: { probe_interval: 500ms, safety_margin_mb: 64 }
`;

describe('managed process lifecycle', () => {
  it('冷启动：请求触发 spawn → ready → 应答；闲置 2s 后自动卸载', async () => {
    const { aya, base } = await boot(head(18701) + procBackend(18711));
    // 初始 stopped
    let st = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st.backends[0].state).toBe('stopped');

    // 冷启动请求（auto_start）
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'pchat', messages: [] }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.choices[0].message.content).toBe('from-process');
    expect(Date.now() - t0).toBeLessThan(10000);

    st = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st.backends[0].state).toBe('ready');
    expect(st.backends[0].counters.starts).toBe(1);

    // 闲置 2s 后应自动卸载
    await sleep(3600);
    st = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st.backends[0].state).toBe('stopped');
    expect(st.backends[0].counters.idle_stops).toBe(1);

    // 事件表记录
    const ev = await (await fetch(`${base}/api/v1/events`)).json();
    const kinds = ev.events.map((e: { event: string }) => e.event);
    expect(kinds).toContain('idle_stop');
    expect(kinds).toContain('start');
    await aya.shutdown();
  }, 30000);

  it('崩溃重启：进程意外退出 → crashed → 退避重启', async () => {
    const { aya, base } = await boot(
      head(18702) +
        `
backends:
  - name: crashy
    type: process
    command: node
    args: ["{mockScript}", "--port", "18712", "--crash-after-first"]
    base_url: "http://127.0.0.1:18712/v1"
    health_check: { path: /health, interval: 300ms, fail_threshold: 1 }
    start_timeout: 15s
    stop_grace_period: 3s
    idle_timeout: 0
    restart: { max_retries: 1, backoff_base: 300ms }
models:
  - { name: cchat, backend: crashy, kind: chat }
`,
    );
    // 启动
    await fetch(`${base}/api/v1/models/cchat/load`, { method: 'POST' });
    await sleep(1500); // 等健康检查触发崩溃 + 重启
    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    const b = st.backends[0];
    // 崩溃后应已重启（starts >= 2）或正在重启
    expect(b.counters.crashes).toBeGreaterThanOrEqual(1);
    expect(b.counters.starts).toBeGreaterThanOrEqual(2);
    await aya.shutdown();
  }, 30000);

  it('load/unload API：主动加载与卸载', async () => {
    const { aya, base } = await boot(head(18703) + procBackend(18713));
    const r1 = await fetch(`${base}/api/v1/models/pchat/load`, { method: 'POST' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.status).toBe('ready');

    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st.backends[0].state).toBe('ready');
    expect(st.backends[0].pid).toBeTypeOf('number');

    const r2 = await fetch(`${base}/api/v1/models/pchat/unload`, { method: 'POST' });
    expect(r2.status).toBe(202);
    const j2 = await r2.json();
    expect(j2.affects_models).toEqual(['pchat']);

    await sleep(300);
    const st2 = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st2.backends[0].state).toBe('stopped');
    await aya.shutdown();
  }, 30000);

  it('资源准入：内存不足时 load 返回 503 resource_unavailable', async () => {
    // 声明一个超过物理内存的需求，且无可驱逐候选
    const { aya, base } = await boot(
      head(18704) +
        `
backends:
  - name: huge
    type: process
    command: node
    args: ["{mockScript}", "--port", "18714"]
    base_url: "http://127.0.0.1:18714/v1"
    health_check: { path: /health, interval: 500ms }
    start_timeout: 10s
    idle_timeout: 0
    required_memory: { mem_mb: 999999999 }
models:
  - { name: hchat, backend: huge, kind: chat }
`,
    );
    const res = await fetch(`${base}/api/v1/models/hchat/load?wait=true&timeout_ms=3000`, { method: 'POST' });
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error.code).toBe('resource_unavailable');
    // 进程不应被拉起
    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    expect(st.backends[0].state).toBe('stopped');
    await aya.shutdown();
  }, 30000);

  it('驱逐腾挪：内存不足时等待低优先级后端闲置并卸载后加载', async () => {
    // 两个后端各声明 8GB；先加载 A（ready），再 load B：
    // 可用内存不足以同时容纳两者（总内存 ~124G，但声明值巨大）→ 驱逐 A
    const { aya, base } = await boot(
      head(18705) +
        `
backends:
  - name: va
    type: process
    command: node
    args: ["{mockScript}", "--port", "18715"]
    base_url: "http://127.0.0.1:18715/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 1
    required_memory: { mem_mb: 60000 }
  - name: vb
    type: process
    command: node
    args: ["{mockScript}", "--port", "18716"]
    base_url: "http://127.0.0.1:18716/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 5
    required_memory: { mem_mb: 60000 }
models:
  - { name: achat, backend: va, kind: chat }
  - { name: bchat, backend: vb, kind: chat }
`,
    );
    // 加载 A：free ~89G < 60G+margin? 89G > 60G → fit，A ready
    const rA = await fetch(`${base}/api/v1/models/achat/load`, { method: 'POST' });
    expect(rA.status).toBe(200);

    // 加载 B：free 89G - reserved 60G = 29G < 60G → 需要驱逐 A（priority 1 < 5）
    const rB = await fetch(`${base}/api/v1/models/bchat/load?wait=true&timeout_ms=20000`, { method: 'POST' });
    expect(rB.status).toBe(200);
    const jB = await rB.json();
    expect(jB.status).toBe('ready');

    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    const byName = Object.fromEntries(st.backends.map((b: { name: string }) => [b.name, b]));
    expect(byName.va.state).toBe('stopped'); // 被驱逐
    expect(byName.vb.state).toBe('ready');

    const ev = await (await fetch(`${base}/api/v1/events?backend=va`)).json();
    expect(ev.events.map((e: { event: string }) => e.event)).toContain('evict_stop');
    await aya.shutdown();
  }, 40000);
});
