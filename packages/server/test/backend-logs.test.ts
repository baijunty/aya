import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import {
  backendLogStream,
  closeBackendLogs,
  configureBackendLogs,
  setBackendLogClock,
  type BackendLogConfig,
} from '../src/log.js';

let now = new Date('2026-10-15T10:00:00');
setBackendLogClock(() => now);

function tmpDir(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `aya-log-${name}-`));
}

function write(sink: Writable, s: string): Promise<void> {
  return new Promise((resolve, reject) => sink.write(s, (e) => (e ? reject(e) : resolve())));
}

function read(dir: string, name: string): string {
  return readFileSync(path.join(dir, name), 'utf8');
}

const NO_LIMIT: BackendLogConfig = { mode: 'day', keepDays: 3, maxBytes: 0 };

afterEach(() => {
  closeBackendLogs();
  now = new Date('2026-10-15T10:00:00');
});

describe('后端日志归档', () => {
  it('day：跨天把旧文件按日期另存，当天另起新文件', async () => {
    const dir = tmpDir('day');
    configureBackendLogs(NO_LIMIT, dir);
    const sink = backendLogStream(dir, 'qwen');
    await write(sink, '第一天的输出\n');
    now = new Date('2026-10-16T09:00:00');
    await write(sink, '第二天的输出\n');

    expect(read(dir, 'qwen.log')).toBe('第二天的输出\n');
    expect(read(dir, 'qwen-2026-10-15.log')).toBe('第一天的输出\n');
  });

  it('run：每次拉起后端清空，只留本次运行', async () => {
    const dir = tmpDir('run');
    configureBackendLogs({ mode: 'run', keepDays: 0, maxBytes: 0 }, dir);
    const sink = backendLogStream(dir, 'qwen');
    sink.startRun();
    await write(sink, '第一次运行的输出\n');
    sink.startRun();
    await write(sink, '第二次运行的输出\n');

    const txt = read(dir, 'qwen.log');
    expect(txt).toContain('第二次运行的输出');
    expect(txt).not.toContain('第一次运行的输出');
    expect(txt).toContain('run started'); // 每次运行留一行标记，便于对齐重启点
  });

  it('max_bytes：超过上限即截断，保留最新内容', async () => {
    const dir = tmpDir('cap');
    configureBackendLogs({ mode: 'append', keepDays: 0, maxBytes: 300 }, dir);
    const sink = backendLogStream(dir, 'qwen');
    await write(sink, `${'A'.repeat(250)}\n`);
    await write(sink, `${'B'.repeat(200)}\n`);

    const txt = read(dir, 'qwen.log');
    expect(txt).toContain('B'.repeat(200));
    expect(txt).not.toContain('A'.repeat(250));
    expect(txt).toContain('log truncated');
    expect(Buffer.byteLength(txt)).toBeLessThan(400);
  });

  it('keep_days：清理超期的日期文件，当天文件不动', () => {
    const dir = tmpDir('keep');
    writeFileSync(path.join(dir, 'qwen-2026-10-14.log'), 'x'); // 1 天前
    writeFileSync(path.join(dir, 'qwen-2026-10-01.log'), 'x'); // 14 天前
    writeFileSync(path.join(dir, 'qwen.log'), 'active');

    configureBackendLogs({ mode: 'day', keepDays: 3, maxBytes: 0 }, dir);
    expect(existsSync(path.join(dir, 'qwen-2026-10-14.log'))).toBe(true);
    expect(existsSync(path.join(dir, 'qwen-2026-10-01.log'))).toBe(false);
    expect(read(dir, 'qwen.log')).toBe('active');

    // keep_days=0 → 只留当天
    configureBackendLogs({ mode: 'day', keepDays: 0, maxBytes: 0 }, dir);
    expect(existsSync(path.join(dir, 'qwen-2026-10-14.log'))).toBe(false);
    expect(existsSync(path.join(dir, 'qwen.log'))).toBe(true);
  });
});
