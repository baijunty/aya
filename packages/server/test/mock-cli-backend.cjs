#!/usr/bin/env node
// 模拟一次性 CLI 后端：读取 -f 输入文件文本，向 -o 输出文件写入伪音频。
// 支持 --fail（非零退出）、--empty（产出空文件）、--sleep-ms（模拟耗时）、
// --fatal <text>（先打印降级原因再长睡，用于验证 fail_on_output 熔断）。
const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = get('-f');
const output = get('-o');
const speaker = get('--tts-speaker-file');
const fail = argv.includes('--fail');
const empty = argv.includes('--empty');
const sleepMs = Number(get('--sleep-ms') ?? 0);
const fatal = get('--fatal');

console.log(`[mock-cli] input=${input} output=${output} speaker=${speaker ?? '-'}`);
const text = input ? require('node:fs').readFileSync(input, 'utf8') : '';
const speakerTag = speaker ? `|spk:${require('node:fs').readFileSync(speaker, 'utf8')}` : '';
console.log(`[mock-cli] read ${text.length} chars from input`);

(async () => {
  if (fatal) {
    // 模拟后端降级：打印成因后继续慢慢算（不产出、不退出），等网关熔断
    console.error(`[mock-cli] ${fatal}`);
    await sleep(600000);
    return;
  }
  if (sleepMs) await sleep(sleepMs);
  if (fail) {
    console.error('[mock-cli] simulated failure');
    process.exit(3);
  }
  const payload = empty ? Buffer.alloc(0) : Buffer.from(`RIFF-mock-audio:${text}${speakerTag}`);
  require('node:fs').writeFileSync(output, payload);
  console.log(`[mock-cli] wrote ${payload.length} bytes`);
})();
