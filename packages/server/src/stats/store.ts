import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BackendEventRow, RequestLog } from '@aya/core';
import { logger } from '../log.js';

const SCHEMA_VERSION = '2';

const DDL = `
CREATE TABLE IF NOT EXISTS request_logs(
  id INTEGER PRIMARY KEY, request_id TEXT UNIQUE, ts_start INT, ts_end INT,
  client_addr TEXT, key_id TEXT, endpoint TEXT, model TEXT, backend TEXT,
  is_stream INT, status_code INT, ok INT, error TEXT,
  latency_ms INT, backend_ms INT, ttft_ms INT,
  prompt_tokens INT, completion_tokens INT, total_tokens INT, cached_tokens INT,
  tokens_estimated INT, req_bytes INT, resp_bytes INT, req_summary TEXT,
  req_raw TEXT, resp_raw TEXT,
  timeline TEXT
);
CREATE INDEX IF NOT EXISTS idx_rl_ts ON request_logs(ts_start);
CREATE INDEX IF NOT EXISTS idx_rl_model_ts ON request_logs(model, ts_start);
CREATE INDEX IF NOT EXISTS idx_rl_ep_ts ON request_logs(endpoint, ts_start);
CREATE INDEX IF NOT EXISTS idx_rl_ok ON request_logs(ok, ts_start);

CREATE TABLE IF NOT EXISTS backend_events(
  id INTEGER PRIMARY KEY, ts INT, backend TEXT,
  event TEXT, reason TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_be_ts ON backend_events(ts);

CREATE TABLE IF NOT EXISTS log_meta(key TEXT PRIMARY KEY, value TEXT);
`;

export class StatsStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.db.exec(DDL);
    const row = this.db.prepare(`SELECT value FROM log_meta WHERE key='schema_version'`).get() as { value: string } | undefined;
    if (!row) {
      this.db.prepare(`INSERT INTO log_meta(key,value) VALUES('schema_version',?)`).run(SCHEMA_VERSION);
    }
  }

  /** 老库补列：v1 → v2 增加 req_raw / resp_raw（失败请求的原始报文） */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(request_logs)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return; // 新库，DDL 直接建 v2
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has('req_raw')) this.db.exec(`ALTER TABLE request_logs ADD COLUMN req_raw TEXT`);
    if (!has('resp_raw')) this.db.exec(`ALTER TABLE request_logs ADD COLUMN resp_raw TEXT`);
    this.db
      .prepare(`INSERT INTO log_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(SCHEMA_VERSION);
  }

  insertRequestLogs(logs: RequestLog[]): void {
    if (logs.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO request_logs(
        request_id, ts_start, ts_end, client_addr, key_id, endpoint, model, backend,
        is_stream, status_code, ok, error, latency_ms, backend_ms, ttft_ms,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        tokens_estimated, req_bytes, resp_bytes, req_summary, req_raw, resp_raw, timeline
      ) VALUES (
        @request_id, @ts_start, @ts_end, @client_addr, @key_id, @endpoint, @model, @backend,
        @is_stream, @status_code, @ok, @error, @latency_ms, @backend_ms, @ttft_ms,
        @prompt_tokens, @completion_tokens, @total_tokens, @cached_tokens,
        @tokens_estimated, @req_bytes, @resp_bytes, @req_summary, @req_raw, @resp_raw, @timeline
      )`);
    const tx = this.db.transaction((rows: RequestLog[]) => {
      for (const l of rows) {
        stmt.run({
          request_id: l.request_id,
          ts_start: l.ts_start,
          ts_end: l.ts_end,
          client_addr: l.client_addr,
          key_id: l.key_id ?? null,
          endpoint: l.endpoint,
          model: l.model,
          backend: l.backend,
          is_stream: l.is_stream ? 1 : 0,
          status_code: l.status_code,
          ok: l.ok ? 1 : 0,
          error: l.error ?? null,
          latency_ms: l.latency_ms,
          backend_ms: l.backend_ms,
          ttft_ms: l.ttft_ms ?? null,
          prompt_tokens: l.prompt_tokens ?? null,
          completion_tokens: l.completion_tokens ?? null,
          total_tokens: l.total_tokens ?? null,
          cached_tokens: l.cached_tokens ?? null,
          tokens_estimated: l.tokens_estimated ? 1 : 0,
          req_bytes: l.req_bytes,
          resp_bytes: l.resp_bytes,
          req_summary: l.req_summary ? JSON.stringify(l.req_summary) : null,
          req_raw: l.req_raw ?? null,
          resp_raw: l.resp_raw ?? null,
          timeline: l.timeline ? JSON.stringify(l.timeline) : null,
        });
      }
    });
    try {
      tx(logs);
    } catch (e) {
      logger.warn({ err: e, count: logs.length }, 'stats write failed (dropped)');
    }
  }

  insertEvent(ev: BackendEventRow): void {
    try {
      this.db
        .prepare(`INSERT INTO backend_events(ts, backend, event, reason, detail) VALUES(?,?,?,?,?)`)
        .run(ev.ts, ev.backend, ev.event, ev.reason ?? null, ev.detail ?? null);
    } catch (e) {
      logger.warn({ err: e }, 'event write failed');
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
