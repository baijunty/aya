import { request } from 'undici';
import type { BackendConfig } from '@aya/core';
import { proxyDispatcher } from '../proxy/forwarder.js';

/** 单次健康检查：GET base_url 根域 + health_check.path */
export async function checkHealth(cfg: BackendConfig): Promise<boolean> {
  if (!cfg.base_url) return false;
  const hc = cfg.health_check;
  const url = new URL(cfg.base_url);
  const path = hc?.path ?? '/health';
  const target = `${url.protocol}//${url.host}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await request(target, {
      method: 'GET',
      headersTimeout: 3000,
      bodyTimeout: 3000,
      dispatcher: proxyDispatcher(cfg.proxy),
    });
    await res.body.dump();
    const expect = hc?.expect_status ?? 200;
    return res.statusCode === expect;
  } catch {
    return false;
  }
}
