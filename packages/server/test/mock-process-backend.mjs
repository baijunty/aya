#!/usr/bin/env node
// 进程型 mock 后端：由网关 spawn，参数 --port。行为与 mock-backend.ts 一致（精简版）。
import http from 'node:http';

const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 18500;
const mode = process.argv.includes('--crash-after-first') ? 'crash' : 'normal';
const slowIdx = process.argv.indexOf('--slow-ms');
const slowMs = slowIdx >= 0 ? Number(process.argv[slowIdx + 1]) : 0;
let requests = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    requests++;
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200).end('{"status":"ok"}');
      if (mode === 'crash' && requests >= 2) {
        // 第二次健康检查后自杀，模拟崩溃
        setTimeout(() => process.exit(7), 50);
      }
      return;
    }
    if (url === '/v1/chat/completions') {
      if (slowMs > 0) await sleep(slowMs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-proc', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-process' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
      return;
    }
    res.writeHead(404).end('{}');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`mock-process-backend listening on ${port}`);
});
