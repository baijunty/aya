import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RequestLog } from '@aya/core';
import { createApp, type AyaApp } from '../src/app.js';
import { StatsStore } from '../src/stats/store.js';
import { purgeBefore } from '../src/stats/queries.js';

const DAY = 86400_000;

function mkLog(id: string, ts: number): RequestLog {
  return {
    request_id: id,
    ts_start: ts,
    ts_end: ts + 10,
    client_addr: '127.0.0.1',
    endpoint: 'chat',
    model: 'm',
    backend: 'b',
    is_stream: false,
    status_code: 200,
    ok: true,
    latency_ms: 10,
    backend_ms: 5,
    tokens_estimated: false,
    req_bytes: 1,
    resp_bytes: 1,
  };
}

describe('purgeBefore（按时间点清理）', () => {
  it('dry_run 只计数不删除；真删只清 cutoff 之前的行（含 backend_events）', () => {
    const store = new StatsStore(':memory:');
    const now = Date.now();
    store.insertRequestLogs([mkLog('old1', now - 10 * DAY), mkLog('old2', now - 8 * DAY), mkLog('new', now - DAY)]);
    store.insertEvent({ ts: now - 9 * DAY, backend: 'b', event: 'start' });

    const preview = purgeBefore(store, now - 7 * DAY, true);
    expect(preview).toEqual({ requests: 2, events: 1 });
    // dry_run 后数据仍在
    expect(purgeBefore(store, now - 7 * DAY, true).requests).toBe(2);

    const done = purgeBefore(store, now - 7 * DAY);
    expect(done).toEqual({ requests: 2, events: 1 });
    const left = store.db.prepare(`SELECT request_id FROM request_logs`).all() as Array<{ request_id: string }>;
    expect(left.map((r) => r.request_id)).toEqual(['new']);
    expect((store.db.prepare(`SELECT COUNT(*) c FROM backend_events`).get() as { c: number }).c).toBe(0);
    store.close();
  });
});

describe('POST /api/v1/stats/requests/purge', () => {
  let aya: AyaApp;
  let base: string;
  let dbPath: string;

  beforeAll(async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aya-purge-'));
    dbPath = path.join(tmp, 'aya.db');
    const cfgPath = path.join(tmp, 'config.yaml');
    writeFileSync(
      cfgPath,
      `
server:
  listen: "127.0.0.1:0"
  static_ui: false
storage:
  type: sqlite
  path: ${dbPath}
`,
    );
    aya = createApp(cfgPath);
    await aya.listen();
    const addr = aya.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await aya?.shutdown();
  });

  async function purge(body: unknown) {
    const res = await fetch(`${base}/api/v1/stats/requests/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  it('参数校验：缺 before / 未来时间 → 400', async () => {
    expect((await purge({})).status).toBe(400);
    expect((await purge({ before: 'abc' })).status).toBe(400);
    expect((await purge({ before: Date.now() + DAY })).status).toBe(400);
  });

  it('dry_run 展示条数，真删后列表不再包含过期行', async () => {
    const now = Date.now();
    // 通过第二个连接写入历史数据（WAL 支持多连接）；注意保留清理默认 90 天，
    // 历史行取 10 天前，不会被启动时的 retention 误删。
    const store = new StatsStore(dbPath);
    store.insertRequestLogs([mkLog('old-a', now - 10 * DAY), mkLog('keep-b', now - DAY)]);
    store.close();

    const preview = await purge({ before: now - 7 * DAY, dry_run: true });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ dry_run: true, would_delete: 1 });

    const done = await purge({ before: now - 7 * DAY });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ dry_run: false, deleted: 1 });

    const list = await (await fetch(`${base}/api/v1/stats/requests`)).json();
    const ids = (list.items as Array<{ request_id: string }>).map((r) => r.request_id);
    expect(ids).toContain('keep-b');
    expect(ids).not.toContain('old-a');
  });
});
