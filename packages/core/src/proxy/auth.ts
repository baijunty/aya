import type { BackendConfig } from '../model/types.js';

/**
 * 计算转发上游时的鉴权头覆盖项（纯函数，便于单测）。
 * 返回的键一律小写：转发头里的客户端头已是小写，覆盖同名键即可（避免大小写并存导致
 * 上游收到两个 Authorization）。
 *
 * 优先级：
 * 1. `backend.auth`（显式 header/value）——最高，原样注入；
 * 2. `backend.api_key` —— 注入 `Authorization: Bearer <api_key>`；
 * 3. 两者都未配置 —— 返回空对象，即原样透传客户端自带的 Authorization
 *    （「上游 key 同自身设置」：客户端带什么上游就收到什么，没带就不带，由上游自行 401）。
 */
export function upstreamAuthOverrides(cfg: BackendConfig): Record<string, string> {
  if (cfg.auth?.header) {
    return { [cfg.auth.header.toLowerCase()]: cfg.auth.value };
  }
  if (cfg.api_key) {
    return { authorization: `Bearer ${cfg.api_key}` };
  }
  return {};
}
