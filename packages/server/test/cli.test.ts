import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AyaApp } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockScript = path.join(__dirname, 'mock-cli-backend.cjs');
const mockSdScript = path.join(__dirname, 'mock-sd-backend.cjs');
const apps: AyaApp[] = [];

afterAll(async () => {
  for (const a of apps) await a.shutdown().catch(() => undefined);
});

async function boot(configYaml: string): Promise<{ aya: AyaApp; base: string; tmp: string }> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'aya-cli-'));
  const cfgPath = path.join(tmp, 'config.yaml');
  writeFileSync(cfgPath, configYaml.replace(/\{tmp\}/g, tmp).replaceAll('{mockScript}', mockScript).replaceAll('{mockSdScript}', mockSdScript));
  const aya = createApp(cfgPath);
  await aya.listen();
  apps.push(aya);
  const addr = aya.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { aya, base: `http://127.0.0.1:${port}`, tmp };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const head = (listenPort: number) => `
server: { listen: "127.0.0.1:${listenPort}", static_ui: false }
storage: { path: "{tmp}/aya.db" }
resources: { probe_interval: 500ms, safety_margin_mb: 64 }
`;

const cliBackend = (extra = '') => `
backends:
  - name: clitts
    type: cli
    command: node
    args: ["{mockScript}", "-f", "{input_file}", "-o", "{output_file}"${extra}]
    output_content_type: audio/wav
    cli_timeout: 10s
    max_concurrency: 2
    queue_timeout: 15s
models:
  - { name: ctts, backend: clitts, kind: tts }
`;

async function speech(base: string, body: unknown) {
  return fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('cli backend (one-shot command per request)', () => {
  it('TTS 请求 → spawn 命令 → 产出文件回传 audio/wav', async () => {
    const { aya, base } = await boot(head(18801) + cliBackend());
    const res = await speech(base, { model: 'ctts', input: '你好世界' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe('RIFF-mock-audio:你好世界');

    // 统计落库
    await sleep(400);
    const list = await (await fetch(`${base}/api/v1/stats/requests?model=ctts`)).json();
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items[0].ok).toBe(true);
    expect(list.items[0].endpoint).toBe('tts');
    await aya.shutdown();
  }, 30000);

  it('命令非零退出 → 502 cli_failed', async () => {
    const { aya, base } = await boot(head(18802) + cliBackend(', "--fail"'));
    const res = await speech(base, { model: 'ctts', input: 'boom' });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.code).toBe('cli_failed');
    await aya.shutdown();
  }, 30000);

  it('产出空文件 → 502 cli_failed', async () => {
    const { aya, base } = await boot(head(18803) + cliBackend(', "--empty"'));
    const res = await speech(base, { model: 'ctts', input: 'x' });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.code).toBe('cli_failed');
    await aya.shutdown();
  }, 30000);

  it('缺 input → 400 invalid_request，不 spawn', async () => {
    const { aya, base } = await boot(head(18804) + cliBackend());
    const res = await speech(base, { model: 'ctts' });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe('invalid_request');
    await aya.shutdown();
  }, 30000);

  it('并发闸门：max_concurrency=2，第 3 个请求排队后仍成功', async () => {
    const { aya, base } = await boot(head(18805) + cliBackend(', "--sleep-ms", "1200"'));
    const t0 = Date.now();
    const results = await Promise.all([
      speech(base, { model: 'ctts', input: 'a' }),
      speech(base, { model: 'ctts', input: 'b' }),
      speech(base, { model: 'ctts', input: 'c' }),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    // 第 3 个请求必须等前两个之一完成（>1.2s 串行段）
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1100);
    await aya.shutdown();
  }, 30000);

  it('cli_timeout：超时杀进程 → 502 cli_failed', async () => {
    const { aya, base } = await boot(
      head(18806) +
        `
backends:
  - name: slowcli
    type: cli
    command: node
    args: ["{mockScript}", "-f", "{input_file}", "-o", "{output_file}", "--sleep-ms", "60000"]
    cli_timeout: 1s
    max_concurrency: 1
models:
  - { name: stts, backend: slowcli, kind: tts }
`,
    );
    const res = await speech(base, { model: 'stts', input: 'slow' });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.code).toBe('cli_failed');
    await aya.shutdown();
  }, 30000);

  it('fail_on_output：命中致命输出 → 立即杀进程组，返回 502 backend_degraded（不等 cli_timeout）', async () => {
    const { aya, base } = await boot(
      head(18817) +
        `
backends:
  - name: degradedcli
    type: cli
    command: node
    args: ["{mockScript}", "-f", "{input_file}", "-o", "{output_file}", "--fatal", "no ROCm-capable device is detected"]
    cli_timeout: 10s
    fail_on_output: ["no ROCm-capable device is detected"]
    max_concurrency: 1
models:
  - { name: dtts, backend: degradedcli, kind: tts }
`,
    );
    const t0 = Date.now();
    const res = await speech(base, { model: 'dtts', input: 'gpu down' });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.code).toBe('backend_degraded');
    expect(j.error.message).toContain('no ROCm-capable device is detected');
    // 熔断：远早于 cli_timeout(10s) 返回
    expect(elapsed).toBeLessThan(5000);

    // 未配置 fail_on_output 时同样输出不熔断（对照：走完 cli_timeout → cli_failed）
    const plain = await boot(
      head(18818) +
        `
backends:
  - name: plaincli
    type: cli
    command: node
    args: ["{mockScript}", "-f", "{input_file}", "-o", "{output_file}", "--fatal", "no ROCm-capable device is detected"]
    cli_timeout: 1s
    max_concurrency: 1
models:
  - { name: ptts, backend: plaincli, kind: tts }
`,
    );
    const res2 = await speech(plain.base, { model: 'ptts', input: 'gpu down' });
    expect(res2.status).toBe(502);
    expect((await res2.json()).error.code).toBe('cli_failed');
    await plain.aya.shutdown();
    await aya.shutdown();
  }, 30000);

  it('backends 状态：cli 型显示 ready，load/unload 为 noop', async () => {
    const { aya, base } = await boot(head(18807) + cliBackend());
    const st = await (await fetch(`${base}/api/v1/backends`)).json();
    const b = st.backends.find((x: { name: string }) => x.name === 'clitts');
    expect(b.type).toBe('cli');
    expect(b.state).toBe('ready');

    const r1 = await fetch(`${base}/api/v1/models/ctts/load`, { method: 'POST' });
    expect(r1.status).toBe(200);
    expect((await r1.json()).status).toBe('noop');
    const r2 = await fetch(`${base}/api/v1/models/ctts/unload`, { method: 'POST' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).status).toBe('noop');
    await aya.shutdown();
  }, 30000);
});

describe('custom voices (upload sample → speech by voice id)', () => {
  const speakerBackend = `
backends:
  - name: clitts
    type: cli
    command: node
    args: ["{mockScript}", "-f", "{input_file}", "-o", "{output_file}", "--tts-speaker-file", "{speaker_file}"]
    output_content_type: audio/wav
    max_concurrency: 2
models:
  - { name: ctts, backend: clitts, kind: tts }
`;

  async function uploadVoice(base: string, name: string, sample: string, consent = 'cons_1') {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('consent', consent);
    fd.append('audio_sample', new Blob([sample], { type: 'audio/wav' }), 'sample.wav');
    return fetch(`${base}/v1/audio/voices`, { method: 'POST', body: fd });
  }

  it('上传音色 → 列表 → speech 按 id 克隆 → 改名 → 删除', async () => {
    const { aya, base } = await boot(head(18808) + speakerBackend);

    // 上传
    const up = await uploadVoice(base, 'myvoice', 'spk-A');
    expect(up.status).toBe(201);
    const v = await up.json();
    expect(v.object).toBe('audio.voice');
    expect(v.name).toBe('myvoice');
    expect(v.type).toBe('audio_sample');
    expect(v.id).toMatch(/^voice_/);

    // 列表
    const list = await (await fetch(`${base}/v1/audio/voices`)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(v.id);

    // speech 按 id：mock 后端把 speaker 文件内容拼进输出
    const res = await speech(base, { model: 'ctts', input: 'hello', voice: v.id });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('RIFF-mock-audio:hello|spk:spk-A');

    // speech 按 name（大小写不敏感）
    const res2 = await speech(base, { model: 'ctts', input: 'hi', voice: 'MyVoice' });
    expect(res2.status).toBe(200);
    expect(Buffer.from(await res2.arrayBuffer()).toString()).toBe('RIFF-mock-audio:hi|spk:spk-A');

    // 不存在的 voice → 404 voice_not_found
    const bad = await speech(base, { model: 'ctts', input: 'x', voice: 'nope' });
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.code).toBe('voice_not_found');

    // 不传 voice → 无 speaker 参数（flag 一并剔除）
    const plain = await speech(base, { model: 'ctts', input: 'plain' });
    expect(plain.status).toBe(200);
    expect(Buffer.from(await plain.arrayBuffer()).toString()).toBe('RIFF-mock-audio:plain');

    // 改名
    const ren = await fetch(`${base}/v1/audio/voices/${v.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(ren.status).toBe(200);
    expect((await ren.json()).name).toBe('renamed');

    // 删除 → 再 speech 404
    const del = await fetch(`${base}/v1/audio/voices/${v.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);
    const gone = await speech(base, { model: 'ctts', input: 'x', voice: v.id });
    expect(gone.status).toBe(404);
    await aya.shutdown();
  }, 30000);

  it('上传校验：缺 name / 缺文件 → 400', async () => {
    const { aya, base } = await boot(head(18809) + speakerBackend);
    const fd1 = new FormData();
    fd1.append('audio_sample', new Blob(['x'], { type: 'audio/wav' }), 'a.wav');
    const r1 = await fetch(`${base}/v1/audio/voices`, { method: 'POST', body: fd1 });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error.code).toBe('invalid_request');

    const fd2 = new FormData();
    fd2.append('name', 'nofile');
    const r2 = await fetch(`${base}/v1/audio/voices`, { method: 'POST', body: fd2 });
    expect(r2.status).toBe(400);
    await aya.shutdown();
  }, 30000);
});

describe('image generation via cli backend (mock sd-cli)', () => {
  const imageBackend = `
backends:
  - name: sdcli
    type: cli
    command: node
    args: ["{mockSdScript}", "-p", "{prompt}", "-W", "{width}", "-H", "{height}", "-s", "{seed}", "-b", "{batch_count}", "-o", "{output_pattern}"]
    cli_timeout: 30s
    max_concurrency: 1
models:
  - { name: sdimg, backend: sdcli, kind: image }
`;

  async function gen(base: string, body: unknown) {
    return fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('prompt → 生成 1 张图，OpenAI images JSON（b64_json）', async () => {
    const { aya, base } = await boot(head(18810) + imageBackend);
    const res = await gen(base, { model: 'sdimg', prompt: '一只可爱的猫', size: '1024x768', seed: 42 });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.created).toBe('number');
    expect(j.data).toHaveLength(1);
    const img = Buffer.from(j.data[0].b64_json, 'base64');
    expect(img.subarray(0, 4).toString('hex')).toBe('89504e47'); // PNG 魔数
    expect(img.toString()).toContain('一只可爱的猫');
    expect(img.toString()).toContain('1024x768');
    expect(img.toString()).toContain('seed=42');

    await sleep(400);
    const list = await (await fetch(`${base}/api/v1/stats/requests?model=sdimg`)).json();
    expect(list.items[0].endpoint).toBe('image');
    expect(list.items[0].ok).toBe(true);
    await aya.shutdown();
  }, 30000);

  it('n=2 → 两张图；缺 prompt → 400', async () => {
    const { aya, base } = await boot(head(18811) + imageBackend);
    const res = await gen(base, { model: 'sdimg', prompt: 'x', n: 2 });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data).toHaveLength(2);
    const img0 = Buffer.from(j.data[0].b64_json, 'base64').toString();
    const img1 = Buffer.from(j.data[1].b64_json, 'base64').toString();
    expect(img0).toContain('idx=0');
    expect(img1).toContain('idx=1');
    expect(img0).toContain('seed=-1'); // 未传 seed → 随机哨兵

    const bad = await gen(base, { model: 'sdimg' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_request');
    await aya.shutdown();
  }, 30000);
});

describe('image editing via cli backend (/v1/images/edits, mock sd-cli -r)', () => {
  // sdedit：带 {ref_image} 占位的后端，edits 注入 -r，generations 无参考图时 flag 自动剔除
  // sdturbo：模拟 turbo 后端（--sigmas 预设 + cfg 1.0），验证参数透传
  const editBackends = `
backends:
  - name: sdedit
    type: cli
    command: node
    args: ["{mockSdScript}", "-r", "{ref_image}", "-p", "{prompt}", "-W", "{width}", "-H", "{height}", "-s", "{seed}", "-b", "{batch_count}", "-o", "{output_pattern}"]
    cli_timeout: 30s
    max_concurrency: 1
  - name: sdturbo
    type: cli
    command: node
    args: ["{mockSdScript}", "--sigmas", "qwen-image-2.1-turbo", "--steps", "8", "--cfg-scale", "1.0", "-r", "{ref_image}", "-p", "{prompt}", "-o", "{output_pattern}"]
    cli_timeout: 30s
    max_concurrency: 1
models:
  - { name: sdedit, backend: sdedit, kind: image }
  - { name: sdturbo, backend: sdturbo, kind: image }
`;

  async function editMultipart(base: string, form: FormData) {
    return fetch(`${base}/v1/images/edits`, { method: 'POST', body: form });
  }

  it('multipart edits：prompt + image 文件 → -r 注入参考图', async () => {
    const { aya, base } = await boot(head(18812) + editBackends);
    const fd = new FormData();
    fd.append('model', 'sdedit');
    fd.append('prompt', "把文字改成 'sd.cpp'");
    fd.append('image', new Blob(['REFDATA-A'], { type: 'image/png' }), 'in.png');
    const res = await editMultipart(base, fd);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data).toHaveLength(1);
    const img = Buffer.from(j.data[0].b64_json, 'base64').toString();
    expect(img).toContain("把文字改成 'sd.cpp'");
    expect(img).toContain('refs=1[REFDATA-A]');

    await sleep(400);
    const list = await (await fetch(`${base}/api/v1/stats/requests?model=sdedit`)).json();
    expect(list.items[0].endpoint).toBe('image');
    expect(list.items[0].ok).toBe(true);
    await aya.shutdown();
  }, 30000);

  it('多张参考图 image[] → -r 重复展开且顺序保持', async () => {
    const { aya, base } = await boot(head(18813) + editBackends);
    const fd = new FormData();
    fd.append('model', 'sdedit');
    fd.append('prompt', 'merge');
    fd.append('image[]', new Blob(['REF-1'], { type: 'image/png' }), 'a.png');
    fd.append('image[]', new Blob(['REF-2'], { type: 'image/jpeg' }), 'b.jpg');
    const res = await editMultipart(base, fd);
    expect(res.status).toBe(200);
    const img = Buffer.from((await res.json()).data[0].b64_json, 'base64').toString();
    expect(img).toContain('refs=2[REF-1,REF-2]');
    await aya.shutdown();
  }, 30000);

  it('JSON 形态：image=base64 → 同样注入 -r；generations 无参考图不受影响', async () => {
    const { aya, base } = await boot(head(18814) + editBackends);
    const b64 = Buffer.from('REFDATA-B64').toString('base64');
    const res = await fetch(`${base}/v1/images/edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sdedit', prompt: 'edit me', image: b64 }),
    });
    expect(res.status).toBe(200);
    const img = Buffer.from((await res.json()).data[0].b64_json, 'base64').toString();
    expect(img).toContain('refs=1[REFDATA-B64]');

    // 同一后端走 generations（无参考图）：-r flag 应被剔除，产物无 refs 段
    const gen = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sdedit', prompt: 'plain gen' }),
    });
    expect(gen.status).toBe(200);
    const img2 = Buffer.from((await gen.json()).data[0].b64_json, 'base64').toString();
    expect(img2).not.toContain('refs=');
    await aya.shutdown();
  }, 30000);

  it('turbo 后端：--sigmas/--cfg-scale 透传（generations 与 edits 通用）', async () => {
    const { aya, base } = await boot(head(18815) + editBackends);
    const res = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sdturbo', prompt: 'turbo cat' }),
    });
    expect(res.status).toBe(200);
    const img = Buffer.from((await res.json()).data[0].b64_json, 'base64').toString();
    expect(img).toContain('sigmas=qwen-image-2.1-turbo');
    expect(img).toContain('cfg=1.0');
    await aya.shutdown();
  }, 30000);

  it('edits 缺 prompt → 400；缺 model → 400', async () => {
    const { aya, base } = await boot(head(18816) + editBackends);
    const fd1 = new FormData();
    fd1.append('model', 'sdedit');
    fd1.append('image', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const r1 = await editMultipart(base, fd1);
    expect(r1.status).toBe(400);
    expect((await r1.json()).error.code).toBe('invalid_request');

    const fd2 = new FormData();
    fd2.append('prompt', 'x');
    const r2 = await editMultipart(base, fd2);
    expect(r2.status).toBe(400);
    await aya.shutdown();
  }, 30000);
});
