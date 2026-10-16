import pino from 'pino';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export const logger = pino({
  level: process.env.AYA_LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type BackendLogMode = 'run' | 'day' | 'append';

export interface BackendLogConfig {
  /** run=每次拉起后端清空只留本次运行；day=按天切并保留 keep_days 天；append=单文件追加 */
  mode: BackendLogMode;
  /** day 模式保留几天的历史文件；0 = 只留当天 */
  keepDays: number;
  /** 单文件上限（字节），超限截断保留最新内容；0 = 不限 */
  maxBytes: number;
}

const DEFAULT_CFG: BackendLogConfig = { mode: 'day', keepDays: 3, maxBytes: 20 * 1024 * 1024 };

let cfg: BackendLogConfig = { ...DEFAULT_CFG };
let clock: () => Date = () => new Date();

/** 历史日志文件名：<backend>-YYYY-MM-DD.log（<backend> 本身可含 '-'） */
const DAY_FILE = /^(.+)-(\d{4}-\d{2}-\d{2})\.log$/;

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该日期距今几天（按本地日界，不做时钟漂移特判） */
function ageInDays(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d).getTime();
  const now = clock();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.floor((today - then) / 86400_000);
}

/**
 * 后端 stdout/stderr 的归档目标。对 runner 始终是同一个对象（pipe 的引用不变），
 * 内部按「新运行 / 跨天 / 超上限」切换底层文件流。
 */
class BackendLogSink extends Writable {
  private stream: WriteStream | undefined;
  private file: string;
  private day = '';
  private size = 0;
  private warned = false;

  constructor(
    private readonly logDir: string,
    private readonly backend: string,
  ) {
    super();
    this.file = join(logDir, `${backend}.log`);
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as unknown as string);
    // 归档失败只影响日志，不能顺着 pipe 把网关带崩：告警一次后继续吞掉写入
    try {
      this.ensureOpen(len);
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        logger.warn({ backend: this.backend }, `backend log unavailable: ${(e as Error).message}`);
      }
      cb(null);
      return;
    }
    this.stream!.write(chunk, (err) => {
      if (!err) this.size += len;
      if (err && !this.warned) {
        this.warned = true;
        logger.warn({ backend: this.backend }, `backend log write error: ${err.message}`);
      }
      cb(null);
    });
  }

  /** 每次 spawn 前调用：run 模式清空重来，day 模式顺带检查跨天 */
  startRun(): void {
    try {
      this.ensureOpen(0);
      if (cfg.mode === 'run') this.reopen('w');
      else if (cfg.mode === 'day' && dayKey(clock()) !== this.day) this.rollDay();
      this.mark(`run started ${clock().toISOString()}`);
    } catch (e) {
      logger.warn({ backend: this.backend }, `backend log start-run failed: ${(e as Error).message}`);
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }

  /** 打开（或按需切换）底层文件；len 为即将写入的字节数，用于上限判断 */
  private ensureOpen(len: number): void {
    if (!this.stream) {
      mkdirSync(this.logDir, { recursive: true });
      this.reopen(cfg.mode === 'run' ? 'w' : 'a');
      return;
    }
    if (cfg.mode === 'day' && dayKey(clock()) !== this.day) {
      this.rollDay();
      return;
    }
    if (cfg.maxBytes > 0 && this.size + len > cfg.maxBytes) {
      this.reopen('w');
      this.mark(`log truncated ${clock().toISOString()}（超过 max_bytes=${cfg.maxBytes}，旧内容丢弃）`);
    }
  }

  private reopen(flags: 'a' | 'w'): void {
    this.stream?.end();
    mkdirSync(this.logDir, { recursive: true });
    const s = createWriteStream(this.file, { flags });
    s.on('error', (e) => logger.warn({ backend: this.backend }, `backend log write error: ${e.message}`));
    this.stream = s;
    this.day = dayKey(clock());
    if (flags === 'a') {
      try {
        this.size = statSync(this.file).size;
      } catch {
        this.size = 0;
      }
    } else {
      this.size = 0;
    }
  }

  /** 跨天：当前文件按日期另存，新起当天文件 */
  private rollDay(): void {
    const dated = join(this.logDir, `${this.backend}-${this.day}.log`);
    this.stream?.end();
    this.stream = undefined;
    try {
      if (existsSync(dated)) {
        // 同名日期文件已存在（时钟回拨 / 手工拷贝）：并进去，既不覆盖也不丢
        appendFileSync(dated, `\n==== merged ${clock().toISOString()} ====\n`, 'utf8');
        appendFileSync(dated, readFileSync(this.file));
        writeFileSync(this.file, '');
      } else {
        renameSync(this.file, dated);
      }
    } catch (e) {
      logger.warn({ backend: this.backend }, `backend log rotate failed: ${(e as Error).message}`);
    }
    this.reopen('w');
    pruneBackendLogs(this.logDir);
  }

  private mark(text: string): void {
    const line = `==== ${text} ====\n`;
    this.stream?.write(line);
    this.size += Buffer.byteLength(line);
  }
}

const streams = new Map<string, BackendLogSink>();

/** 后端 stdout/stderr 归档到 <data_dir>/logs/<backend>.log，按 logs 配置控制增长 */
export function backendLogStream(logDir: string, backend: string): BackendLogSink {
  const key = `${logDir}\u0000${backend}`;
  let s = streams.get(key);
  if (!s) {
    s = new BackendLogSink(logDir, backend);
    streams.set(key, s);
  }
  return s;
}

/** 下发归档策略（启动与配置热加载）；给了 logDir 就顺带清理超期历史文件 */
export function configureBackendLogs(next: BackendLogConfig, logDir?: string): void {
  cfg = { ...next };
  if (logDir) pruneBackendLogs(logDir);
}

/** 删除超出 keep_days 的 <backend>-YYYY-MM-DD.log；keep_days=0 即只留当天 */
export function pruneBackendLogs(logDir: string): void {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return; // 目录还没建，没有可清理的
  }
  let removed = 0;
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    if (!m) continue;
    if (cfg.keepDays > 0 && ageInDays(m[2]!) < cfg.keepDays) continue;
    try {
      unlinkSync(join(logDir, name));
      removed++;
    } catch (e) {
      logger.warn({ file: name }, `backend log prune failed: ${(e as Error).message}`);
    }
  }
  if (removed > 0) logger.info({ logDir, removed, keep_days: cfg.keepDays }, 'backend log cleanup');
}

/** 测试注入时钟，用于验证跨天切换与保留期 */
export function setBackendLogClock(fn?: () => Date): void {
  clock = fn ?? (() => new Date());
}

export function closeBackendLogs(): void {
  for (const s of streams.values()) s.close();
  streams.clear();
}
