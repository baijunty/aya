import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../src/router/router.js';
import { parseConfigText } from '../src/config/loader.js';
import { AyaError } from '../src/util/errors.js';

const yaml = `
server: { listen: "127.0.0.1:8000" }
backends:
  - name: b-chat
    type: remote
    base_url: "http://127.0.0.1:9999/v1"
  - name: b-asr
    type: process
    command: /bin/sleep
models:
  - name: qwen2.5-7b
    aliases: ["gpt-4o-mini"]
    backend: b-chat
    kind: chat
    context_length: 32768
  - name: whisper
    backend: b-asr
    kind: asr
  - name: disabled-model
    backend: b-chat
    kind: chat
    enabled: false
`;

describe('config loader', () => {
  it('解析并填充默认值', () => {
    const cfg = parseConfigText(yaml);
    expect(cfg.backends).toHaveLength(2);
    const b = cfg.backends[0]!;
    expect(b.start_timeout_ms).toBe(300000);
    expect(b.idle_timeout_ms).toBe(900000);
    expect(b.max_concurrency).toBe(8);
    expect(b.evictable).toBe(true);
    expect(cfg.resources.safety_margin_mb).toBe(1024);
    expect(cfg.proxy.max_upload_bytes).toBe(104857600);
  });
  it('时长字符串解析', () => {
    const cfg = parseConfigText(`
backends:
  - { name: b, type: remote, base_url: "http://x/v1", idle_timeout: 5m, start_timeout: 90s }
models: []
`);
    expect(cfg.backends[0]!.idle_timeout_ms).toBe(300000);
    expect(cfg.backends[0]!.start_timeout_ms).toBe(90000);
  });
  it('交叉校验：model 引用不存在的 backend 报错', () => {
    try {
      parseConfigText('backends: []\nmodels:\n  - { name: m, backend: nope, kind: chat }\n');
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('unknown backend');
    }
  });
  it('process 型缺 command 报错', () => {
    expect(() => parseConfigText('backends:\n  - { name: b, type: process }\n')).toThrow(/command/);
  });
});

describe('ModelRouter', () => {
  const cfg = parseConfigText(yaml);
  const router = new ModelRouter(cfg);

  it('精确名匹配', () => {
    const r = router.route('qwen2.5-7b', 'chat');
    expect(r.backend.name).toBe('b-chat');
  });
  it('别名匹配', () => {
    const r = router.route('gpt-4o-mini', 'chat');
    expect(r.model.name).toBe('qwen2.5-7b');
  });
  it('未配置模型 → 404 model_not_found', () => {
    try { router.route('nope', 'chat'); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(AyaError); expect((e as AyaError).status).toBe(404); }
  });
  it('禁用模型 → 404', () => {
    try { router.route('disabled-model', 'chat'); expect.unreachable(); }
    catch (e) { expect((e as AyaError).code).toBe('model_not_found'); }
  });
  it('kind 与端点不符 → 400 endpoint_kind_mismatch', () => {
    try { router.route('whisper', 'chat'); expect.unreachable(); }
    catch (e) { expect((e as AyaError).code).toBe('endpoint_kind_mismatch'); }
  });
  it('listModels 只含启用模型（规范名）', () => {
    const names = router.listModels().map((m) => m.name);
    expect(names).toEqual(['qwen2.5-7b', 'whisper']);
  });
});
