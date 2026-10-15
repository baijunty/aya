import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ServerConfig } from '@aya/core';

export const SESSION_COOKIE = 'aya_session';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * 看板登录会话（内存态，重启失效）：用户名密码来自 server.ui_auth 配置。
 * 密码只存 SHA-256 摘要，比较用 timingSafeEqual；会话 token 为 32 字节随机数。
 */
export class SessionStore {
  private sessions = new Map<string, { user: string; expiresAt: number }>();
  private creds?: { username: string; passHash: Buffer; ttlMs: number };

  constructor(cfg?: ServerConfig['ui_auth']) {
    this.setCreds(cfg);
  }

  setCreds(cfg?: ServerConfig['ui_auth']): void {
    this.creds = cfg
      ? { username: cfg.username, passHash: sha256(cfg.password), ttlMs: cfg.session_ttl_ms }
      : undefined;
    this.sessions.clear();
  }

  get enabled(): boolean {
    return this.creds !== undefined;
  }

  get ttlMs(): number {
    return this.creds?.ttlMs ?? 0;
  }

  /** 校验凭据；成功返回会话 token，失败返回 undefined */
  login(username: string, password: string): { token: string; user: string; expiresAt: number } | undefined {
    if (!this.creds) return undefined;
    const userOk = username === this.creds.username;
    const passOk = timingSafeEqual(this.creds.passHash, sha256(password));
    if (!userOk || !passOk) return undefined;
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.creds.ttlMs;
    this.sessions.set(token, { user: username, expiresAt });
    this.sweep();
    return { token, user: username, expiresAt };
  }

  /** 校验会话 token；过期即删。返回用户名或 undefined */
  verify(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return s.user;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
  }
}

/** 从请求 Cookie 头提取 aya_session 值 */
export function sessionCookie(req: FastifyRequest): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}

/** 会话 Cookie 的 Set-Cookie 值；pass='' 且 clear=true 用于登出清除 */
export function sessionCookieHeader(token: string, maxAgeSec: number, clear = false): string {
  const attrs = [
    `${SESSION_COOKIE}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  return attrs.join('; ');
}
