import { describe, it, expect } from 'vitest';
import { upstreamAuthOverrides } from '../src/proxy/auth.js';
import type { BackendConfig } from '../src/model/types.js';

const base = {
  name: 'b',
  type: 'passthrough',
  base_url: 'http://x/v1',
  cli_timeout_ms: 1,
  start_timeout_ms: 1,
  stop_grace_period_ms: 1,
  idle_timeout_ms: 1,
  auto_start: true,
  max_concurrency: 1,
  queue_size: 1,
  queue_timeout_ms: 1,
  priority: 0,
  evictable: true,
} as BackendConfig;

describe('upstreamAuthOverrides', () => {
  it('api_key → Bearer 注入', () => {
    expect(upstreamAuthOverrides({ ...base, api_key: 'sk-up' })).toEqual({
      authorization: 'Bearer sk-up',
    });
  });

  it('auth 显式头优先于 api_key（键小写化避免与透传头并存）', () => {
    expect(
      upstreamAuthOverrides({ ...base, api_key: 'sk-up', auth: { header: 'Authorization', value: 'Bearer sk-x' } }),
    ).toEqual({ authorization: 'Bearer sk-x' });
  });

  it('自定义 auth 头名保留原样（小写化）', () => {
    expect(upstreamAuthOverrides({ ...base, auth: { header: 'X-Api-Key', value: 'k' } })).toEqual({
      'x-api-key': 'k',
    });
  });

  it('两者都未配置 → 空对象（原样透传客户端 Authorization）', () => {
    expect(upstreamAuthOverrides(base)).toEqual({});
  });
});
