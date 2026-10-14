import { shortKeyId } from '@aya/core';

/** API Key 鉴权：api_keys 为空则放行；命中返回 key_id（短哈希，不落明文） */
export class AuthManager {
  private keyIds = new Map<string, string>();

  constructor(keys: string[]) {
    this.setKeys(keys);
  }

  setKeys(keys: string[]): void {
    this.keyIds = new Map(keys.map((k) => [k, shortKeyId(k)]));
  }

  get enabled(): boolean {
    return this.keyIds.size > 0;
  }

  /** 校验 Authorization: Bearer；返回 key_id 或 undefined（未启用时） */
  authenticate(header: string | undefined): string | undefined {
    if (this.keyIds.size === 0) return undefined;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) return undefined;
    return this.keyIds.get(token);
  }
}
