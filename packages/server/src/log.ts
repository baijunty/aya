import pino from 'pino';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export const logger = pino({
  level: process.env.AYA_LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** 托管进程 stdout/stderr 按后端归档（data/logs/<backend>.log），追加写 */
const streams = new Map<string, Writable>();
const rotatedSizes = new Map<string, number>();
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50MB 轮转

export function backendLogStream(logDir: string, backend: string): Writable {
  let s = streams.get(backend);
  if (s) return s;
  mkdirSync(logDir, { recursive: true });
  const path = join(logDir, `${backend}.log`);
  try {
    const st = statSync(path);
    rotatedSizes.set(backend, st.size);
  } catch {
    rotatedSizes.set(backend, 0);
  }
  s = createWriteStream(path, { flags: 'a' });
  s.on('error', (e) => logger.warn({ backend }, `backend log write error: ${e.message}`));
  const origWrite = s.write.bind(s);
  s.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const size = rotatedSizes.get(backend) ?? 0;
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer)?.length ?? 0;
    if (size + len > MAX_LOG_BYTES) {
      rotatedSizes.set(backend, 0);
      return origWrite(`\n==== log rotated ${new Date().toISOString()} ====\n`, ...(rest as []));
    }
    rotatedSizes.set(backend, size + len);
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof s.write;
  streams.set(backend, s);
  return s;
}

export function closeBackendLogs(): void {
  for (const s of streams.values()) s.end();
  streams.clear();
}
