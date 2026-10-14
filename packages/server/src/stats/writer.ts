import type { BackendEventRow, RequestLog } from '@aya/core';
import type { StatsStore } from './store.js';
import { logger } from '../log.js';

/**
 * 异步批量写入（design.md §6.1）：有界队列，满则丢最旧；批量 100 条 / 200ms 提交。
 * 统计写入失败绝不影响转发主链路。
 */
export class StatsWriter {
  private queue: RequestLog[] = [];
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private closed = false;

  constructor(
    private readonly store: StatsStore,
    private readonly maxQueue = 10000,
    private readonly batchSize = 100,
    private readonly flushIntervalMs = 200,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref();
  }

  enqueue(log: RequestLog): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped++;
      if (this.dropped % 100 === 1) {
        logger.warn({ dropped: this.dropped }, 'stats queue full, dropping oldest logs');
      }
      return;
    }
    this.queue.push(log);
    if (this.queue.length >= this.batchSize) this.flush();
  }

  event(ev: BackendEventRow): void {
    // 事件低频，直接写（失败仅告警）
    this.store.insertEvent(ev);
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize * 10);
    this.store.insertRequestLogs(batch);
  }

  /** 进程退出：限时 flush */
  close(timeoutMs = 2000): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      this.flush();
    }
  }

  get droppedCount(): number {
    return this.dropped;
  }
}
