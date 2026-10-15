import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * 可编程 mock OpenAI 后端（design.md §11）：
 * - /v1/chat/completions 非流式/流式（含 usage + cached_tokens）
 * - /v1/embeddings
 * - /v1/audio/transcriptions（multipart）
 * - /v1/audio/speech（二进制流）
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
