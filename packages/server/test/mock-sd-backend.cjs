#!/usr/bin/env node
// 模拟 sd-cli 绘图后端：读取 -p/-W/-H/-b/-s/-r(可重复)/--sigmas/--cfg-scale/-o(含 %03d)，
// 按 batch 数量写出伪 PNG 文件；参考图内容回显进产物供测试断言。
const fs = require('node:fs');
const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const getAll = (flag) => {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag) out.push(argv[i + 1]);
  }
  return out;
};
const prompt = get('-p') ?? '';
const width = Number(get('-W') ?? 0);
const height = Number(get('-H') ?? 0);
const batch = Number(get('-b') ?? 1);
const seed = get('-s');
const sigmas = get('--sigmas');
const cfg = get('--cfg-scale');
const refs = getAll('-r');
const outPattern = get('-o') ?? 'output_%03d.png';

console.log(`[mock-sd] prompt="${prompt}" ${width}x${height} batch=${batch} seed=${seed} refs=${refs.length} sigmas=${sigmas} cfg=${cfg}`);
if (!prompt.trim()) {
  console.error('[mock-sd] empty prompt');
  process.exit(2);
}
// 参考图内容回显（编辑链路断言：文件已落盘、顺序正确、可读）
const refEcho = refs
  .map((r) => {
    try {
      return fs.readFileSync(r).toString('utf8').slice(0, 32);
    } catch {
      return 'MISSING';
    }
  })
  .join(',');
for (let i = 0; i < batch; i++) {
  const file = outPattern.replace('%03d', String(i).padStart(3, '0'));
  // 伪 PNG：魔数 + 参数回显（测试断言用）
  const body = Buffer.from(
    `PNGFAKE:${prompt}:${width}x${height}:seed=${seed}:idx=${i}` +
      (refs.length ? `:refs=${refs.length}[${refEcho}]` : '') +
      (sigmas ? `:sigmas=${sigmas}` : '') +
      (cfg ? `:cfg=${cfg}` : ''),
  );
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), body]));
  console.log(`[mock-sd] wrote ${file}`);
}
