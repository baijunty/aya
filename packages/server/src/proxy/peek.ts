import { PassThrough, Readable } from 'node:stream';
import Busboy from 'busboy';

export interface PeekedRequest {
  /** 已提取 model 的完整请求流（可直接转发） */
  body: Readable;
  model?: string;
  stream?: boolean;
  /** JSON 请求体摘要字段（不含正文） */
  fields: Record<string, unknown>;
  /** multipart 时的音频文件字节数（观察所得，可能不完整） */
  uploadBytes?: number;
  /** 请求体头部原文（截断，供失败排障；maxRawBytes=0 时不捕获） */
  rawHead?: string;
}

const PEEK_MAX = 256 * 1024;

export interface PeekOptions {
  /** 原始头部捕获上限（字节）；0/缺省 = 不捕获 */
  maxRawBytes?: number;
}

/** 去掉 NUL/控制字符，避免二进制混入文本日志 */
export function sanitizeRaw(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '\uFFFD');
}

export interface ScannedHead {
  model?: string;
  stream?: boolean;
}

/**
 * 从（可能不完整的）JSON 前缀中扫描顶层 "model" / "stream" 字段。
 * 整体 JSON.parse 只对完整文档有效：请求体超过 PEEK_MAX 时前缀永远解析不出来，
 * 而 model 通常在头部——这里用字节级状态机补上这条路。
 * 跟踪字符串/转义/嵌套深度，只认顶层对象的键，消息内容里的 "model" 不会误中；
 * UTF-8 多字节安全（后续字节均 >= 0x80，不会撞上 ASCII 结构字节）。
 * 字符串值返回的是 JSON 原文切片（未做反转义）；模型名不含转义，够用。
 */
export function scanHeadFields(buf: Buffer): ScannedHead {
  const out: ScannedHead = {};
  let depth = 0;
  let inStr = false;
  let esc = false;
  let strStart = 0;
  let lastKey: string | undefined; // 最近解析出的顶层键
  let pendingKey = false; // 当前字符串是顶层键
  let pendingColon = false; // 刚见过顶层 ':' 且值尚未开始
  let captureModel = false; // 当前字符串是 "model" 的值
  let captureStream = false; // 当前字符串是 "stream" 的值
  let litStream = false; // 正在捕获 stream 的裸字面量（true/false）
  let litStart = 0;

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === 0x5c) { esc = true; continue; } // \
      if (c !== 0x22) continue; // " 字符串结束
      inStr = false;
      const s = buf.toString('utf8', strStart, i);
      if (captureModel) {
        out.model = s;
        captureModel = false;
        if (out.stream !== undefined) return out;
      } else if (captureStream) {
        out.stream = s === 'true';
        captureStream = false;
      } else if (pendingKey && depth === 1) {
        lastKey = s;
        pendingKey = false;
      }
      continue;
    }
    if (litStream) {
      // 裸字面量以 , } ] 或空白结束
      if (c === 0x2c || c === 0x7d || c === 0x5d || c <= 0x20) {
        out.stream = buf.toString('utf8', litStart, i) === 'true';
        litStream = false;
        if (out.model !== undefined) return out;
      }
      continue;
    }
    switch (c) {
      case 0x22: // "
        strStart = i + 1;
        inStr = true;
        if (depth === 1) {
          if (pendingColon) {
            if (lastKey === 'model') captureModel = true;
            else if (lastKey === 'stream') captureStream = true;
            pendingColon = false; // 值已开始
          } else {
            pendingKey = true;
          }
        }
        break;
      case 0x7b: // {
      case 0x5b: // [
        depth++;
        pendingColon = false; // 值（对象/数组）已开始
        break;
      case 0x7d: // }
      case 0x5d: // ]
        depth--;
        pendingColon = false;
        break;
      case 0x3a: // :
        if (depth === 1) pendingColon = true;
        break;
      case 0x2c: // ,
        pendingColon = false;
        break;
      default:
        if (c <= 0x20) break; // 空白
        if (depth === 1 && pendingColon && lastKey === 'stream') {
          litStream = true;
          litStart = i;
          pendingColon = false;
        }
    }
  }
  return out;
}

/**
 * 从请求流中「有限窥探」model/stream 字段，同时保持完整流可转发。
 * - JSON：缓冲前缀直到能解析出 model（或流结束/超时）。整体 parse 失败时
 *   退化为前缀扫描（scanHeadFields），保证 >PEEK_MAX 的请求体也能路由。
 * - multipart：busboy 观察 field，文件部分原样 tee 转发。
 */
export function peekRequest(
  raw: NodeJS.ReadableStream,
  contentType: string,
  opts: PeekOptions = {},
): Promise<PeekedRequest> {
  if (contentType.startsWith('multipart/')) {
    return peekMultipart(raw, contentType, opts);
  }
  return peekJson(raw, opts);
}

function peekJson(raw: NodeJS.ReadableStream, opts: PeekOptions): Promise<PeekedRequest> {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const prefix: Buffer[] = [];
    let size = 0;
    let settled = false;
    let parsed: Record<string, unknown> | undefined;
    let scanned: ScannedHead = {};
    const maxRaw = opts.maxRawBytes ?? 0;
    const rawChunks: Buffer[] = [];
    let rawSize = 0;

    const tryParse = (): boolean => {
      try {
        const obj = JSON.parse(Buffer.concat(prefix).toString('utf8'));
        if (obj && typeof obj === 'object') {
          parsed = obj as Record<string, unknown>;
          return true;
        }
      } catch {
        /* 前缀不完整 */
      }
      return false;
    };

    /** 当前已知的 model/stream：优先整体 parse 结果，否则用字节级前缀扫描兜底 */
    const head = (): ScannedHead => {
      if (parsed) {
        return {
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          stream: parsed.stream === true,
        };
      }
      return scanned;
    };

    /** 刷新前缀扫描结果（请求体 > PEEK_MAX 或前缀截断时整体 parse 永远不成功） */
    const refreshScan = (): void => {
      if (!parsed) scanned = scanHeadFields(Buffer.concat(prefix));
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      refreshScan();
      const h = head();
      const fields: Record<string, unknown> = {};
      if (parsed) {
        for (const k of [
          'max_tokens', 'temperature', 'top_p', 'n', 'size', 'response_format',
          'voice', 'speed', 'stream', 'stream_options', 'language', 'encoding_format',
        ]) {
          if (parsed[k] !== undefined) fields[k] = parsed[k];
        }
        if (typeof parsed.input === 'string') fields.input_chars = (parsed.input as string).length;
        if (Array.isArray(parsed.messages)) fields.messages_count = (parsed.messages as unknown[]).length;
        if (Array.isArray(parsed.input)) fields.input_items = (parsed.input as unknown[]).length;
        // /v1/systemone 摘要：题数 + state 长度 + 附图数（state/图片可能很大，不记正文）
        if (parsed.questions && typeof parsed.questions === 'object' && !Array.isArray(parsed.questions)) {
          fields.questions_count = Object.keys(parsed.questions as object).length;
        }
        if (typeof parsed.state === 'string') fields.state_chars = parsed.state.length;
        if (Array.isArray(parsed.images)) fields.images = parsed.images.length;
        else if (Array.isArray(parsed.files)) fields.images = (parsed.files as unknown[]).length;
      }
      resolve({
        body: out,
        model: h.model,
        stream: h.stream,
        fields,
        rawHead: rawSize
          ? sanitizeRaw(Buffer.concat(rawChunks).toString('utf8').slice(0, maxRaw))
          : undefined,
      });
    };

    raw.on('data', (c: Buffer) => {
      out.write(c);
      if (maxRaw && rawSize < maxRaw) {
        rawChunks.push(c);
        rawSize += c.length;
      }
      if (size < PEEK_MAX) {
        prefix.push(c);
        size += c.length;
        tryParse();
        refreshScan();
        // model 已拿到（完整 parse 或前缀扫描）即可放行，剩余字节继续透传
        if (head().model !== undefined) finish();
      }
    });
    raw.on('end', () => {
      tryParse();
      out.end();
      finish();
    });
    raw.on('error', (e) => {
      out.destroy(e);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    // 超时兜底：慢客户端也尽早放行（model 可能未出现 → 路由层报 missing_model）
    setTimeout(() => {
      tryParse();
      finish();
    }, 1000).unref();
  });
}

function peekMultipart(raw: NodeJS.ReadableStream, contentType: string, opts: PeekOptions): Promise<PeekedRequest> {
  return new Promise((resolve) => {
    const out = new PassThrough();
    raw.pipe(out); // 原样转发，busboy 只观察
    let model: string | undefined;
    let uploadBytes = 0;
    let settled = false;
    const maxRaw = opts.maxRawBytes ?? 0;
    const rawChunks: Buffer[] = [];
    let rawSize = 0;
    if (maxRaw) {
      const cap = (c: Buffer): void => {
        if (rawSize < maxRaw) {
          rawChunks.push(c);
          rawSize += c.length;
        }
      };
      raw.on('data', cap);
      raw.on('end', () => raw.off('data', cap));
    }
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({
        body: out,
        model,
        fields: { multipart: true, audio_bytes: uploadBytes },
        uploadBytes,
        rawHead: rawSize
          ? sanitizeRaw(Buffer.concat(rawChunks).toString('utf8').slice(0, maxRaw))
          : undefined,
      });
    };
    try {
      const bb = Busboy({ headers: { 'content-type': contentType } });
      raw.pipe(bb);
      bb.on('field', (name: string, val: string) => {
        if (name === 'model' && model === undefined) {
          model = val;
          finish(); // model 字段已到即可放行
        }
      });
      bb.on('file', (_name: string, file: NodeJS.ReadableStream) => {
        file.on('data', (c: Buffer) => {
          uploadBytes += c.length;
        });
        file.resume();
      });
      bb.on('close', finish);
      bb.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, 3000).unref();
  });
}
