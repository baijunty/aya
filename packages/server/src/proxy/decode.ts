import * as zlib from 'node:zlib';
import type { Transform as StreamTransform } from 'node:stream';

/**
 * 观察侧解码器：把压缩的上游响应体还原成明文，只喂给旁路解析（SSE usage / TTFT /
 * JSON usage / 错误响应头部）。转发给客户端的字节流始终原封不动。
 *
 * 为什么必须有：undici.request 不解压（只有 fetch 会），而远端 API（DeepSeek、Venice、
 * 各家 OpenAI 兼容网关）几乎必然按客户端的 accept-encoding 回 gzip/br/zstd。把压缩字节
 * 直接喂给 SSE/JSON 解析器，一帧都解不出来 —— usage、TTFT、上游错误信息全部落空，
 * 明细里 tokens 为空、pp/tg 无数、错误响应头部是乱码，都是这一个原因（本机 llama-server
 * 不压缩，所以只有远程转发后端缺这些）。
 */
export interface PlainFeeder {
  /** 喂入线上字节（压缩或明文），解出的明文回调给 onText */
  write(chunk: Buffer): void;
  /** 结束输入并等明文吐尽；幂等，且永不 reject（解码失败按已解出的部分收尾） */
  finish(): Promise<void>;
}

/** content-encoding 名 → zlib 解码流；未知/不支持返回 undefined（放弃解码，按明文喂） */
function createDecoder(name: string): StreamTransform | undefined {
  switch (name) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    case 'zstd': {
      // zstd 要 Node ≥ 24（Docker 镜像是 22）：缺了别硬调，退化成「不认识该编码」
      const make = (zlib as unknown as { createZstdDecompress?: () => StreamTransform }).createZstdDecompress;
      return typeof make === 'function' ? make() : undefined;
    }
    default:
      return undefined;
  }
}

/** finish 的兜底时限：zlib 输入为空/异常时可能不再发 'end'，不能让转发收尾挂住 */
const FINISH_FALLBACK_MS = 500;

/**
 * content-encoding → 明文喂入器。
 * - 无编码（identity）或编码不认识：按明文直喂（解不出 usage 也不影响转发本身）。
 * - 链式编码（如 "br, gzip"）：线上按声明顺序叠加，解码顺序相反。
 * - 解码中途出错（截断的压缩流、客户端提前断开）：丢掉剩余输入，保留已解出的明文。
 */
export function createPlainFeeder(
  contentEncoding: string | undefined,
  onText: (text: string) => void,
): PlainFeeder {
  const names = (contentEncoding ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();

  const chain: StreamTransform[] = [];
  for (const n of names) {
    const d = createDecoder(n);
    if (!d) {
      chain.length = 0; // 任一环节解不了就整体按明文喂，别把明文也丢了
      break;
    }
    chain.push(d);
  }
  if (chain.length === 0) {
    return { write: (c) => onText(c.toString('utf8')), finish: async () => {} };
  }

  let dead = false;
  let settle: (() => void) | undefined;
  const finishOnce = (): void => {
    const f = settle;
    settle = undefined;
    f?.();
  };

  for (let i = 0; i < chain.length - 1; i++) chain[i]!.pipe(chain[i + 1]!);
  const tail = chain[chain.length - 1]!;
  // setEncoding 自带 StringDecoder：UTF-8 多字节被 zlib 输出切开时不会出乱码
  tail.setEncoding('utf8');
  tail.on('data', (s: string) => {
    if (!dead && s) onText(s);
  });
  tail.on('end', finishOnce);
  tail.on('close', finishOnce);
  for (const d of chain) {
    // 压缩流截断/非法：已解出的明文照常可用，剩下的丢掉
    d.on('error', () => {
      dead = true;
      finishOnce();
    });
  }

  let finishing: Promise<void> | undefined;
  return {
    write(chunk: Buffer): void {
      if (dead) return;
      try {
        chain[0]!.write(chunk);
      } catch {
        dead = true;
        finishOnce();
      }
    },
    finish(): Promise<void> {
      if (finishing) return finishing;
      finishing = new Promise<void>((resolve) => {
        if (dead) return resolve();
        settle = resolve;
        try {
          chain[0]!.end();
        } catch {
          resolve();
        }
        setTimeout(() => {
          settle = undefined;
          resolve();
        }, FINISH_FALLBACK_MS).unref();
      });
      return finishing;
    },
  };
}
