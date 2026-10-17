import http from 'node:http';
import net from 'node:net';
import { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';

/**
 * 可编程 mock OpenAI 后端（design.md §11）：
 * - /v1/chat/completions 非流式/流式（含 usage + cached_tokens）
 * - /v1/embeddings
 * - /v1/audio/transcriptions（multipart）
 * - /v1/audio/speech（二进制流）
 * - model=mock-enc-{gzip,br,zstd}：压缩响应（远端 API 按 accept-encoding 回包的形态）；
 *   mock-encfail-gzip：压缩的 429 错误体；mock-nousage：流式末尾不带 usage
 * - /health
 * - /slow?ms= 慢响应；/fail 返回 500；/stall 卡死
 */
export interface MockBackend {
  url: string;
  port: number;
  close(): Promise<void>;
  requestCount(): number;
}

export async function startMockBackend(): Promise<MockBackend> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (() => {
        try {
          return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();

      if (url.pathname === '/health') {
        res.writeHead(200).end('{"status":"ok"}');
        return;
      }
      if (url.pathname === '/fail') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"boom","type":"server_error"}}');
        return;
      }
      if (url.pathname === '/stall') {
        // 只回头，不发包（触发 bodyTimeout）
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return;
      }
      if (url.pathname === '/slow') {
        const ms = Number(url.searchParams.get('ms') ?? 100);
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'cmpl-slow', object: 'chat.completion', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
        }, ms);
        return;
      }
      if (url.pathname === '/v1/chat/completions') {
        if (json.model === 'mock-auth') {
          // 回显上游收到的 Authorization 头：断言网关的 api_key 注入 / 客户端 Authorization 透传
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: 'cmpl-auth', object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              auth: req.headers['authorization'] ?? null,
            }),
          );
          return;
        }
        if (json.model === 'mock-framing') {
          // 回显上游收到的请求体定界方式：用于断言网关没有把请求退化成 chunked
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: 'cmpl-framing', object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              framing: {
                contentLength: req.headers['content-length'] ?? null,
                transferEncoding: req.headers['transfer-encoding'] ?? null,
                bytes: body.length,
              },
            }),
          );
          return;
        }
        if (json.model === 'mock-fail') {
          res.writeHead(500, { 'content-type': 'application/json' }).end(
            JSON.stringify({ error: { message: 'CUDA out of memory', type: 'server_error', code: 'oom' } }),
          );
          return;
        }
        // 压缩响应：远端 API（DeepSeek/Venice 等）按客户端 accept-encoding 回 gzip/br/zstd。
        // 旁路观察必须先解出明文，否则 usage / TTFT / 错误响应头部集体落空
        // （回归：远程转发后端的请求明细里 tokens 全空、pp/tg 无数）。
        const enc = /^(?:mock-enc|mock-encfail)-(gzip|br|zstd)$/.exec(String(json.model ?? ''))?.[1] as
          | 'gzip'
          | 'br'
          | 'zstd'
          | undefined;
        if (enc) {
          const compress = enc === 'gzip' ? gzipSync : enc === 'br' ? brotliCompressSync : zstdCompressSync;
          const failing = json.model === 'mock-encfail-gzip';
          if (json.stream === true && !failing) {
            const frames = [
              { id: 'ce1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
              { id: 'ce1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '你好' } }] },
              { id: 'ce1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '世界' } }] },
              {
                id: 'ce1', object: 'chat.completion.chunk', choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 } },
              },
            ];
            const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
            const packed = compress(Buffer.from(sse, 'utf8'));
            res.writeHead(200, {
              'content-type': 'text/event-stream', 'content-encoding': enc, 'cache-control': 'no-cache',
            });
            // 分两块下发：解码必须是增量的，不能等整包收齐
            const half = Math.floor(packed.length / 2);
            res.write(packed.subarray(0, half));
            setTimeout(() => res.end(packed.subarray(half)), 20);
            return;
          }
          const payload = failing
            ? { error: { message: 'rate limit exceeded', type: 'rate_limit_error', code: 'overloaded' } }
            : {
                id: 'cmpl-enc', object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: '你好世界' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 } },
              };
          const packed = compress(Buffer.from(JSON.stringify(payload), 'utf8'));
          res.writeHead(failing ? 429 : 200, { 'content-type': 'application/json', 'content-encoding': enc });
          res.end(packed);
          return;
        }
        // 流式末尾不带 usage（客户端没声明 stream_options.include_usage 的常见形态）：
        // 走本地估算兜底，并打 tokens_estimated 标记
        if (json.model === 'mock-nousage' && json.stream === true) {
          const frames = [
            { id: 'nu1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
            { id: 'nu1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '你好' } }] },
            { id: 'nu1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '世界' } }] },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n');
          return;
        }
        if (json.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chunksOut = [
            { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
            { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '你好' } }] },
            { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '世界' } }] },
            {
              id: 'c1', object: 'chat.completion.chunk', choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 } },
            },
          ];
          let i = 0;
          const t = setInterval(() => {
            if (i < chunksOut.length) {
              res.write(`data: ${JSON.stringify(chunksOut[i])}\n\n`);
              i++;
            } else {
              res.write('data: [DONE]\n\n');
              clearInterval(t);
              res.end();
            }
          }, 20);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-1', object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '你好世界' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 } },
            // 回显上游收到的 Authorization（passthrough 鉴权断言用；其余测试忽略该字段）
            auth: req.headers['authorization'] ?? null,
          }),
        );
        return;
      }
      if (url.pathname === '/v1/embeddings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
        );
        return;
      }
      if (url.pathname === '/v1/audio/transcriptions') {
        const ct = String(req.headers['content-type'] ?? '');
        const isMultipart = ct.startsWith('multipart/');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: `transcribed ${isMultipart ? body.length : 0} bytes` }));
        return;
      }
      if (url.pathname === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        // 分块二进制
        const audio = Buffer.from('FAKEAUDIO'.repeat(100));
        let off = 0;
        const t = setInterval(() => {
          if (off < audio.length) {
            res.write(audio.subarray(off, off + 100));
            off += 100;
          } else {
            clearInterval(t);
            res.end();
          }
        }, 5);
        return;
      }
      if (url.pathname === '/v1/images/generations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'aGVsbG8=' }] }));
        return;
      }
      res.writeHead(404).end('{"error":"not found"}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requestCount: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface MockProxy {
  url: string;
  hits(): number;
  close(): Promise<void>;
}

/**
 * 极简 HTTP 代理（backend.proxy 断言用）：undici ProxyAgent 对一切上游都发 CONNECT 建隧道
 * （https 亦然），故这里实现 CONNECT 隧道转发，hits() 计隧道数——>0 即证明流量真的走了代理。
 */
export async function startMockProxy(): Promise<MockProxy> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    // 非 CONNECT 的 absolute-form 请求（curl 等客户端会这样发）：本测试用不到，明确拒绝
    req.resume();
    req.on('end', () => res.writeHead(502, { 'content-type': 'text/plain' }).end('mock proxy: CONNECT only'));
  });
  server.on('connect', (req, socket, head) => {
    hits++;
    const [host, port] = String(req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host ?? '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 取一个「刚关闭」的端口：连它必然 ECONNREFUSED（死代理断言用） */
export async function closedPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}
