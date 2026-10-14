import os from 'node:os';
import { readFileSync } from 'node:fs';
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
