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

/**
 * 从请求流中「有限窥探」model/stream 字段，同时保持完整流可转发。
 * - JSON：缓冲前缀直到能解析出 model（或流结束/超时）。
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

    const finish = (): void => {
      if (settled) return;
      settled = true;
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
      }
      resolve({
        body: out,
        model: typeof parsed?.model === 'string' ? (parsed.model as string) : undefined,
        stream: parsed?.stream === true,
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
        if (tryParse() && parsed?.model !== undefined) {
          // model 已拿到；继续透传剩余字节，但先 resolve
          finish();
        }
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
