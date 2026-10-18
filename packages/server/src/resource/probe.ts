import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import type { ResourceSnapshot } from '@aya/core';
import { logger } from '../log.js';

/** 读取 MemAvailable（KB→MB）；不可得时退化到 os.freemem() */
function memAvailableMb(): number {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
    if (m) return Math.floor(parseInt(m[1]!, 10) / 1024);
  } catch {
    /* fall through */
  }
  return Math.floor(os.freemem() / 1048576);
}

export interface ProcResident {
  /** 进程实测驻留总量（Pss，回退 VmRSS） */
  total_mb: number;
  /** 其中文件页 + shmem（mmap 权重等）：MemAvailable 把它们计为「可回收」，
   *  准入时必须从 MemAvailable 里扣掉，否则同一块物理页会被重复许诺 */
  file_mb: number;
}

/** 进程表快照条目：pid → 父 pid / 进程组 id */
export interface ProcInfo {
  ppid: number;
  pgid: number;
}

/** pid → ProcInfo 的进程表快照 */
export type ProcTable = Map<number, ProcInfo>;

/**
 * 扫描一次 /proc 得到进程表（pid → ppid/pgid）。
 * /proc/<pid>/stat 中 comm 可含空格与括号，须从最后一个 ')' 之后开始解析字段。
 */
export function scanProcTable(): ProcTable {
  const out: ProcTable = new Map();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      // ')' 之后依次为: state ppid pgrp session ...
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const ppid = parseInt(fields[1]!, 10);
      const pgid = parseInt(fields[2]!, 10);
      if (Number.isFinite(ppid)) out.set(pid, { ppid, pgid: Number.isFinite(pgid) ? pgid : pid });
    } catch {
      /* readdir 与读取之间进程已退出，或无权限 */
    }
  }
  return out;
}

/**
 * 以 rootPid 为根的进程树成员：PPID 子树 ∪ 同进程组。
 * 托管进程以 detached 启动（pgid=pid），很多后端是「启动脚本 + 引擎子进程」结构，
 * 内存大头在子进程；进程组兜底可捕获 setsid 脱离 PPID 链的子孙（与停止时 killGroup 口径一致）。
 * table 可复用一轮采样内的扫描结果，避免重复扫 /proc。
 */
export function procTreePids(rootPid: number, table?: ProcTable): number[] {
  const t = table ?? scanProcTable();
  const members = new Set<number>([rootPid]);
  const childrenOf = new Map<number, number[]>();
  for (const [pid, info] of t) {
    if (info.ppid === pid) continue;
    const arr = childrenOf.get(info.ppid);
    if (arr) arr.push(pid);
    else childrenOf.set(info.ppid, [pid]);
  }
  const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
  }
  for (const [pid, info] of t) if (info.pgid === rootPid) members.add(pid);
  return [...members];
}

/** 读取单个进程实时驻留（/proc/<pid>/smaps_rollup）；不可得时退化到 VmRSS（按全量保守计） */
function procResidentSingle(pid: number): ProcResident | null {
  try {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (re: RegExp) => {
      const m = re.exec(text);
      return m ? parseInt(m[1]!, 10) : 0;
    };
    // 优先 Pss_*（共享页按份额分摊），老内核缺 Pss 细分时退化到 Rss_*
    let pss = kb(/^Pss:\s+(\d+)\s+kB$/m);
    let file = kb(/^Pss_File:\s+(\d+)\s+kB$/m);
    let shmem = kb(/^Pss_Shmem:\s+(\d+)\s+kB$/m);
    if (!pss) {
      pss = kb(/^Rss:\s+(\d+)\s+kB$/m);
      file = kb(/^RssFile:\s+(\d+)\s+kB$/m);
      shmem = kb(/^RssShmem:\s+(\d+)\s+kB$/m);
    }
    if (pss) {
      return {
        total_mb: Math.floor(pss / 1024),
        file_mb: Math.floor((file + shmem) / 1024),
      };
    }
  } catch {
    /* fall through */
  }
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    if (m) {
      const mb = Math.floor(parseInt(m[1]!, 10) / 1024);
      return { total_mb: mb, file_mb: mb };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * 以 pid 为根的进程树实测驻留（含全部子进程）。
 * Pss 已把共享页按份额分摊，跨进程求和不会重复计数；
 * 只算启动脚本自身会严重低估（脚本几十 MB，模型驻留全在子进程里）。
 */
export function procResidentMb(pid: number, table?: ProcTable): ProcResident | null {
  if (!pid) return null;
  let total = 0;
  let file = 0;
  let seen = false;
  for (const p of procTreePids(pid, table)) {
    const r = procResidentSingle(p);
    if (r) {
      seen = true;
      total += r.total_mb;
      file += r.file_mb;
    }
  }
  return seen ? { total_mb: total, file_mb: file } : null;
}

export function probeSnapshot(): ResourceSnapshot {
  return {
    ts: Date.now(),
    mem_total_mb: Math.floor(os.totalmem() / 1048576),
    mem_free_mb: memAvailableMb(),
  };
}

/** 周期采集系统内存快照（统一内存主机，只看系统内存） */
export class ResourceProbe {
  private current: ResourceSnapshot = probeSnapshot();
  private timer?: NodeJS.Timeout;

  constructor(private readonly intervalMs: number) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.current = probeSnapshot();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): ResourceSnapshot {
    // 快照过旧时即时刷新，保证准入判定新鲜
    if (Date.now() - this.current.ts > this.intervalMs * 2) {
      this.current = probeSnapshot();
      logger.debug(this.current, 'resource snapshot refreshed on demand');
    }
    return this.current;
  }
}
