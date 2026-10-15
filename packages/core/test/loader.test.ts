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
