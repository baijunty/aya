import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile } from '../src/config/loader.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aya-loader-'));
const origCwd = process.cwd();
afterAll(() => process.chdir(origCwd));

describe('loadConfigFile storage.path 解析', () => {
  it('相对路径按配置文件所在目录解析，与进程 cwd 无关', () => {
    const cfgDir = path.join(tmp, 'cfgdir');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'config.yaml');
    writeFileSync(cfgPath, 'storage:\n  path: ./data/aya.db\n');

    // 从完全无关的 cwd（系统临时目录根）加载，结果仍锚定配置文件目录
    process.chdir(os.tmpdir());
    expect(loadConfigFile(cfgPath).storage.path).toBe(path.join(cfgDir, 'data', 'aya.db'));

    // 相对 configPath 按 cwd 定位文件本身，数据目录仍跟文件走
    process.chdir(cfgDir);
    expect(loadConfigFile('config.yaml').storage.path).toBe(path.join(cfgDir, 'data', 'aya.db'));
  });

  it('绝对路径原样保留', () => {
    const cfgPath = path.join(tmp, 'abs.yaml');
    const dbPath = path.join(os.tmpdir(), 'somewhere', 'aya.db');
    writeFileSync(cfgPath, `storage:\n  path: ${dbPath}\n`);
    expect(loadConfigFile(cfgPath).storage.path).toBe(dbPath);
  });

  it('缺省 storage.path 也解析为配置文件旁的 data/aya.db', () => {
    const cfgPath = path.join(tmp, 'default.yaml');
    writeFileSync(cfgPath, 'server:\n  listen: "127.0.0.1:0"\n');
    expect(loadConfigFile(cfgPath).storage.path).toBe(path.join(tmp, 'data', 'aya.db'));
  });
});

describe('loadConfigFile logs 归档策略', () => {
  it('缺省为按天切、保留 3 天、单文件 20MB', () => {
    const cfgPath = path.join(tmp, 'logs-default.yaml');
    writeFileSync(cfgPath, 'server:\n  listen: "127.0.0.1:0"\n');
    expect(loadConfigFile(cfgPath).logs).toEqual({ mode: 'day', keep_days: 3, max_bytes: 20 * 1024 * 1024 });
  });

  it('mode / keep_days / max_bytes 可配，max_bytes 支持 5mb 写法', () => {
    const cfgPath = path.join(tmp, 'logs-custom.yaml');
    writeFileSync(cfgPath, 'logs:\n  mode: run\n  keep_days: 0\n  max_bytes: 5mb\n');
    expect(loadConfigFile(cfgPath).logs).toEqual({ mode: 'run', keep_days: 0, max_bytes: 5 * 1024 * 1024 });
  });

  it('非法 mode 与 max_bytes 报错', () => {
    const bad = path.join(tmp, 'logs-bad.yaml');
    writeFileSync(bad, 'logs:\n  mode: weekly\n');
    expect(() => loadConfigFile(bad)).toThrow(/mode/);
    writeFileSync(bad, 'logs:\n  max_bytes: 5mbb\n');
    expect(() => loadConfigFile(bad)).toThrow(/invalid byte size/);
  });
});

describe('loadConfigFile passthrough 后端', () => {
  it('passthrough 型接受 api_key；缺 base_url 报错', () => {
    const ok = path.join(tmp, 'pt-ok.yaml');
    writeFileSync(ok, [
      'backends:',
      '  - { name: pt, type: passthrough, base_url: "http://127.0.0.1:8731/v1", api_key: "sk-up" }',
      'models:',
      '  - { name: m, backend: pt, kind: chat }',
      '',
    ].join('\n'));
    expect(loadConfigFile(ok).backends[0].api_key).toBe('sk-up');

    const bad = path.join(tmp, 'pt-bad.yaml');
    writeFileSync(bad, 'backends:\n  - { name: pt, type: passthrough }\n');
    expect(() => loadConfigFile(bad)).toThrow(/requires base_url/);
  });

  it('cli 型配 api_key 报错（无 HTTP 上游）', () => {
    const bad = path.join(tmp, 'cli-key.yaml');
    writeFileSync(bad, 'backends:\n  - { name: c, type: cli, command: x, api_key: "sk-x" }\n');
    expect(() => loadConfigFile(bad)).toThrow(/api_key is meaningless/);
  });
});
