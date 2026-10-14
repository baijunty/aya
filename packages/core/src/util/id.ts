import { createHash, randomBytes } from 'node:crypto';

let counter = 0;

/** 网关请求 id：req_<base36 时间>_<自增><随机> */
export function newRequestId(): string {
  counter = (counter + 1) % 0xffffff;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(4, '0');
  const r = randomBytes(3).toString('hex');
  return `req_${t}${c}${r}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** API Key 的短哈希标识（不落明文） */
export function shortKeyId(key: string): string {
  return 'k' + createHash('sha256').update(key).digest('hex').slice(0, 8);
}
