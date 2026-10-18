#!/usr/bin/env node
// 进程型 mock 后端：由网关 spawn，参数 --port。行为与 mock-backend.ts 一致（精简版）。
import http from 'node:http';
import { spawn } from 'node:child_process';

const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 18500;
const mode = process.argv.includes('--crash-after-first') ? 'crash' : 'normal';
const slowIdx = process.argv.indexOf('--slow-ms');
const slowMs = slowIdx >= 0 ? Number(process.argv[slowIdx + 1]) : 0;
const allocIdx = process.argv.indexOf('--alloc-mb');
const allocMb = allocIdx >= 0 ? Number(process.argv[allocIdx + 1]) : 0;
const childAllocIdx = process.argv.indexOf('--child-alloc-mb');
const childAllocMb = childAllocIdx >= 0 ? Number(process.argv[childAllocIdx + 1]) : 0;
let requests = 0;

// 真实驻留内存（匿名页，触页后才算占用）：供资源准入的实测口径测试。
// 分块分配避开单 Buffer 的 MAX_LENGTH 上限；held 引用防止被 GC。
const held = [];
if (allocMb > 0) {
  const CHUNK = 1024; // MB
  for (let left = allocMb; left > 0; left -= CHUNK) {
    const buf = Buffer.allocUnsafe(Math.min(left, CHUNK) * 1048576);
    buf.fill(1);
    held.push(buf);
  }
  // 持续触页保持工作集热度（模拟推理引擎反复访问权重），
  // 防止在重回收压力的主机上冷页被内核换出/回收导致驻留不稳定
  setInterval(() => {
    for (const b of held) for (let i = 0; i < b.length; i += 4096) b[i] = 1;
  }, 500).unref();
}

// 「启动脚本 + 引擎子进程」结构：内存大头放在子进程里，父进程自身保持很小。
// 子进程继承本进程的进程组（网关 detached 启动 → pgid=父 pid），停止时随整组回收。
if (childAllocMb > 0) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const held=[];const CHUNK=1024;
for(let left=${childAllocMb};left>0;left-=CHUNK){const b=Buffer.allocUnsafe(Math.min(left,CHUNK)*1048576);b.fill(1);held.push(b);}
setInterval(()=>{for(const b of held)for(let i=0;i<b.length;i+=4096)b[i]=1;},500);`,
    ],
    { stdio: 'ignore' },
  );
  // 子进程异常退出时父进程跟随退出，避免网关误判 ready
  child.on('exit', () => process.exit(0));
}

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
