import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AyaApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockScript = path.join(__dirname, 'mock-process-backend.mjs');
const apps: AyaApp[] = [];

afterAll(async () => {
  for (const a of apps) await a.shutdown().catch(() => undefined);
}, 30000);

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

/** 读取当前 MemAvailable（MB），测试按机器实际余量缩放，避免依赖机器空闲状态 */
function memAvailableMb(): number {
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  return m ? Math.floor(parseInt(m[1]!, 10) / 1024) : 0;
}

/** 等待后端实测驻留稳定到目标值（分配完成），返回实测 live_mb；超时返回最后值 */
async function waitResident(base: string, backend: string, targetMb: number, timeoutMs = 30000): Promise<number> {
  const t0 = Date.now();
  let live = 0;
  for (;;) {
    const res = await (await fetch(`${base}/api/v1/resources`)).json();
    live = res.reserved.find((r: { backend: string }) => r.backend === backend)?.live_mb ?? 0;
    if (live >= targetMb * 0.9 || Date.now() - t0 > timeoutMs) return live;
    await sleep(500);
  }
}

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

  it('驱逐腾挪：实测驻留不足时卸载闲置后端并加载', async () => {
    // 按机器当前余量缩放：va 真实驻留匿名页（≤12G），声明值只略高于驻留；
    // vb 声明值落在「va 驻留后剩余」与「va 卸载后恢复」之间 → 必须驱逐 va 才能容纳。
    const avail = memAvailableMb();
    const vaAlloc = Math.min(Math.max(Math.floor(avail * 0.4), 2048), 8192);
    const vaNeed = vaAlloc + 256;
    const vbNeed = avail - Math.floor(vaAlloc / 2);
    const { aya, base } = await boot(
      head(18705) +
        `
backends:
  - name: va
    type: process
    command: node
    args: ["{mockScript}", "--port", "18715", "--alloc-mb", "${vaAlloc}"]
    base_url: "http://127.0.0.1:18715/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 30s
    idle_timeout: 0
    priority: 1
    required_memory: { mem_mb: ${vaNeed} }
  - name: vb
    type: process
    command: node
    args: ["{mockScript}", "--port", "18716"]
    base_url: "http://127.0.0.1:18716/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 5
    required_memory: { mem_mb: ${vbNeed} }
models:
  - { name: achat, backend: va, kind: chat }
  - { name: bchat, backend: vb, kind: chat }
`,
    );
    // 加载 A：匿名页驻留 vaAlloc，MemAvailable 随之降到 ≈ avail − vaAlloc
    const rA = await fetch(`${base}/api/v1/models/achat/load`, { method: 'POST' });
    expect(rA.status).toBe(200);
    // 等驻留稳定（分配完成），避免把「还在填充」误判成余量充足
    expect(await waitResident(base, 'va', vaAlloc)).toBeGreaterThanOrEqual(vaAlloc * 0.9);

    // 加载 B：available ≈ (avail − vaAlloc) − A 的文件页驻留(≈0) < vbNeed → 驱逐 A（priority 1 < 5）；
    // A 停止后匿名页归还 MemAvailable → B fit ready
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
  }, 60000);

  it('准入按实测驻留：running 声明巨大但驻留小 → 新后端直接共存不驱逐', async () => {
    // 回归 flash-next(声明90G) vs tts(3G) 误驱逐：va 声明 0.9×余量但几乎不占内存。
    // 旧口径：B 检查时 available = free − 声明0.9A < need → 误驱逐 A。
    // 新口径：A running 只扣实测文件页驻留(≈0) → B 直接 fit，A 保持 ready。
    const avail = memAvailableMb();
    const { aya, base } = await boot(
      head(18709) +
        `
backends:
  - name: va
    type: process
    command: node
    args: ["{mockScript}", "--port", "18721"]
    base_url: "http://127.0.0.1:18721/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 1
    required_memory: { mem_mb: ${Math.floor(avail * 0.9)} }
  - name: vb
    type: process
    command: node
    args: ["{mockScript}", "--port", "18722"]
    base_url: "http://127.0.0.1:18722/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 5
    required_memory: { mem_mb: ${Math.floor(avail * 0.2)} }
models:
  - { name: achat, backend: va, kind: chat }
  - { name: bchat, backend: vb, kind: chat }
`,
    );
    expect((await fetch(`${base}/api/v1/models/achat/load`, { method: 'POST' })).status).toBe(200);
    const rB = await fetch(`${base}/api/v1/models/bchat/load?wait=true&timeout_ms=10000`, { method: 'POST' });
    expect(rB.status).toBe(200);

    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    const byName = Object.fromEntries(st.backends.map((b: { name: string }) => [b.name, b]));
    expect(byName.va.state).toBe('ready'); // 未被误驱逐
    expect(byName.vb.state).toBe('ready'); // 直接共存

    // 资源面板：running 条目带实测驻留 live_mb（远小于声明值）
    const res = await (await fetch(`${base}/api/v1/resources`)).json();
    const vaEntry = res.reserved.find((r: { backend: string }) => r.backend === 'va');
    expect(vaEntry?.phase).toBe('running');
    expect(vaEntry?.live_mb).toBeTypeOf('number');
    expect(vaEntry.live_mb).toBeLessThan(vaEntry.mem_mb);
    await aya.shutdown();
  }, 40000);

  it('实测驻留含子进程：启动脚本自身很小，内存大头在子进程', async () => {
    // 回归「面板只显示脚本自身的 29M」：旧口径只读主进程 smaps_rollup，
    // 子进程（真正的引擎进程）驻留被完全漏计，准入/驱逐估算也随之严重低估。
    const avail = memAvailableMb();
    const childAlloc = Math.min(Math.max(Math.floor(avail * 0.15), 1024), 4096);
    const { aya, base } = await boot(
      head(18708) +
        `
backends:
  - name: vc
    type: process
    command: node
    args: ["{mockScript}", "--port", "18720", "--child-alloc-mb", "${childAlloc}"]
    base_url: "http://127.0.0.1:18720/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    required_memory: { mem_mb: ${childAlloc + 512} }
models:
  - { name: cchat, backend: vc, kind: chat }
`,
    );
    expect((await fetch(`${base}/api/v1/models/cchat/load`, { method: 'POST' })).status).toBe(200);
    // live_mb 必须覆盖子进程驻留（旧口径只有脚本自身的几十 MB，远达不到 childAlloc）
    const live = await waitResident(base, 'vc', childAlloc);
    expect(live).toBeGreaterThanOrEqual(childAlloc * 0.9);
    await aya.shutdown();
  }, 60000);

  it('串行加载：并发 load 时后一个必须等前一个加载完毕后才 spawn', async () => {
    // va 用 --alloc-mb 拉长加载窗口；va/vb 声明值都远小于余量（本可同时过检），
    // 但加载必须串行——并行加载瞬时峰值合计可能 OOM。vb 的 start 必须晚于 va 的 ready。
    const { aya, base } = await boot(
      head(18710) +
        `
backends:
  - name: va
    type: process
    command: node
    args: ["{mockScript}", "--port", "18723", "--alloc-mb", "4096"]
    base_url: "http://127.0.0.1:18723/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 30s
    idle_timeout: 0
    priority: 1
    required_memory: { mem_mb: 4608 }
  - name: vb
    type: process
    command: node
    args: ["{mockScript}", "--port", "18724"]
    base_url: "http://127.0.0.1:18724/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 5
    required_memory: { mem_mb: 1024 }
models:
  - { name: achat, backend: va, kind: chat }
  - { name: bchat, backend: vb, kind: chat }
`,
    );
    const pA = fetch(`${base}/api/v1/models/achat/load?wait=true&timeout_ms=30000`, { method: 'POST' });
    await sleep(150); // 确保 achat 先取得加载锁（va 此时仍在分配内存/未 ready）
    const pB = fetch(`${base}/api/v1/models/bchat/load?wait=true&timeout_ms=30000`, { method: 'POST' });
    const [rA, rB] = await Promise.all([pA, pB]);
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200); // vb 排队后重新估算仍 fit，最终 ready

    const evA = await (await fetch(`${base}/api/v1/events?backend=va`)).json();
    const evB = await (await fetch(`${base}/api/v1/events?backend=vb`)).json();
    const readyA = evA.events.find((e: { event: string }) => e.event === 'ready')?.ts;
    const startB = evB.events.find((e: { event: string }) => e.event === 'start')?.ts;
    expect(readyA).toBeTypeOf('number');
    expect(startB).toBeTypeOf('number');
    expect(startB).toBeGreaterThanOrEqual(readyA - 50); // vb 未与 va 并行加载
    await aya.shutdown();
  }, 60000);

  it('驱逐腾挪（victim 正忙）：等待其闲置后卸载，不立刻 503', async () => {
    // va 上有一个进行中的慢请求（inflight>0）。此时 load vb：
    // 旧行为：busy 后端不算候选 → 立刻 503 resource_unavailable
    // 新行为：静默等待 va 当前请求结束 → 驱逐 → vb ready
    const avail = memAvailableMb();
    const vaAlloc = Math.min(Math.max(Math.floor(avail * 0.4), 2048), 8192);
    const { aya, base } = await boot(
      head(18706) +
        `
backends:
  - name: va
    type: process
    command: node
    args: ["{mockScript}", "--port", "18717", "--slow-ms", "2500", "--alloc-mb", "${vaAlloc}"]
    base_url: "http://127.0.0.1:18717/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 30s
    idle_timeout: 0
    priority: 1
    required_memory: { mem_mb: ${vaAlloc + 256} }
  - name: vb
    type: process
    command: node
    args: ["{mockScript}", "--port", "18718"]
    base_url: "http://127.0.0.1:18718/v1"
    health_check: { path: /health, interval: 300ms }
    start_timeout: 15s
    idle_timeout: 0
    priority: 5
    required_memory: { mem_mb: ${avail - Math.floor(vaAlloc / 2)} }
models:
  - { name: achat, backend: va, kind: chat }
  - { name: bchat, backend: vb, kind: chat }
`,
    );
    // 先让 va ready 且驻留稳定，再打一个 2.5s 的慢请求使其 busy
    expect((await fetch(`${base}/api/v1/models/achat/load`, { method: 'POST' })).status).toBe(200);
    expect(await waitResident(base, 'va', vaAlloc)).toBeGreaterThanOrEqual(vaAlloc * 0.9);
    const slowReq = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'achat', messages: [] }),
    }).then((r) => r.status);

    await sleep(300); // 慢请求已进入 va（inflight=1）
    const t0 = Date.now();
    const rB = await fetch(`${base}/api/v1/models/bchat/load?wait=true&timeout_ms=25000`, { method: 'POST' });
    const waited = Date.now() - t0;
    expect(rB.status).toBe(200); // 不是 503
    const jB = await rB.json();
    expect(jB.status).toBe('ready');
    expect(waited).toBeGreaterThanOrEqual(1000); // 确实等待了 victim 闲置，而非瞬间返回
    expect(await slowReq).toBe(200); // 慢请求未被中断

    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    const byName = Object.fromEntries(st.backends.map((b: { name: string }) => [b.name, b]));
    expect(byName.va.state).toBe('stopped'); // 闲置后被驱逐
    expect(byName.vb.state).toBe('ready');
    await aya.shutdown();
  }, 60000);

  it('被拦截的请求（路由失败/缺 model）也写入统计', async () => {
    const { aya, base } = await boot(head(18707) + procBackend(18719));

    // 未知模型 → 404 model_not_found（未进入 forward）
    const r1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model', messages: [] }),
    });
    expect(r1.status).toBe(404);

    // 缺 model → 400 missing_model
    const r2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(r2.status).toBe(400);

    await sleep(400); // StatsWriter 批量落库间隔 200ms
    const list = await (await fetch(`${base}/api/v1/stats/requests?status=fail&page_size=10`)).json();
    const errs = list.items.map((i: { error: string }) => i.error);
    expect(errs).toContain('model_not_found');
    expect(errs).toContain('missing_model');
    const notFound = list.items.find((i: { error: string }) => i.error === 'model_not_found');
    expect(notFound.model).toBe('no-such-model');
    expect(notFound.status_code).toBe(404);
    await aya.shutdown();
  }, 20000);
});
