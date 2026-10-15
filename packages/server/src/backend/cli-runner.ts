import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AyaErrors, type BackendConfig } from '@aya/core';
import { interpolateArgs } from './process-runner.js';
import { backendLogStream, logger } from '../log.js';

export interface CliRunResult {
  /** 首个产出文件内容（单产出场景，如 tts 的 wav） */
  output: Buffer;
  /** 全部产出文件（按文件名排序；多产出场景，如 sd-cli 批量出图） */
  outputs: Buffer[];
  exitCode: number | null;
  durationMs: number;
}

export interface CliRunOptions {
  /** tts：请求文本，落盘为 {input_file} */
  inputText?: string;
  /** tts：音色样本路径，注入 {speaker_file}（未提供时连同其前面的 flag 一并剔除） */
  speakerFile?: string;
  /** image 编辑：参考图字节（runCli 落盘到临时目录 ref_NNN.<ext>；{ref_image} 展开为每个一张，含其前面的 flag） */
  refImages?: { ext: string; data: Buffer }[];
  /** 通用变量占位符：{prompt} {width} {height} {seed} {batch_count} 等 */
  vars?: Record<string, string>;
  /** 多产出模式：临时目录内的输出文件名模板（含 %d），如 output_%03d.png */
  outputPattern?: string;
}

/**
 * 一次性 CLI 执行（cli 型后端）：临时目录内落输入 → spawn 命令生成输出文件 → 读回并清理。
 * args 占位符：
 *   {input_file}     请求文本落盘路径（tts）
 *   {output_file}    单产出路径（命令只生成一个文件）
 *   {output_pattern} 多产出模板（命令按 %d 序号生成多个文件，如 sd-cli -o）
 *   {speaker_file}   音色样本（未提供 voice 时连同前面的 flag 参数一并剔除）
 *   {ref_image}      图片编辑参考图（可多张：为每张复制其前面的 flag，如 -r a.png -r b.png；无参考图时连同 flag 剔除）
 *   {prompt}/{width}/{height}/{seed}/{batch_count}/...  由 opts.vars 注入
 *   其余 {xxx}       走 BackendConfig 字段插值（同 process 型）
 * stdout/stderr 归档到 data/logs/<backend>.log；超时 SIGTERM→5s 后 SIGKILL 整组。
 * stdout/stderr 命中 cfg.fail_on_output 任一子串 ⇒ 判定后端降级，立即整组杀掉并返回 502 backend_degraded。
 */
export async function runCli(
  cfg: BackendConfig,
  logDir: string,
  opts: CliRunOptions = {},
): Promise<CliRunResult> {
  const dir = mkdtempSync(path.join(tmpdir(), `aya-cli-${cfg.name}-`));
  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.bin');
  const started = Date.now();
  try {
    if (opts.inputText !== undefined) writeFileSync(inputPath, opts.inputText, 'utf8');
    // 参考图落盘（图片编辑）：ref_001.<ext> 起，按请求顺序
    const refFiles: string[] = [];
    (opts.refImages ?? []).forEach((r, i) => {
      const name = `ref_${String(i + 1).padStart(3, '0')}${r.ext}`;
      writeFileSync(path.join(dir, name), r.data);
      refFiles.push(name);
    });
    const patternPath = opts.outputPattern ? path.join(dir, opts.outputPattern) : undefined;
    let raw = interpolateArgs(cfg).map((a) =>
      a
        .replace('{input_file}', inputPath)
        .replace('{output_file}', outputPath)
        .replace('{output_pattern}', patternPath ?? ''),
    );
    if (opts.vars) {
      for (const [k, v] of Object.entries(opts.vars)) {
        raw = raw.map((a) => a.replaceAll(`{${k}}`, v));
      }
    }
    const args: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '{speaker_file}') {
        if (opts.speakerFile) {
          args.push(opts.speakerFile);
        } else {
          args.pop(); // 剔除前面的 flag（如 --tts-speaker-file）
        }
        continue;
      }
      if (raw[i] === '{ref_image}') {
        const refs = refFiles;
        if (refs.length === 0) {
          args.pop(); // 无参考图：剔除前面的 flag（如 -r）
          continue;
        }
        // 多张参考图：把前面的 flag 复制给每一张（-r a.png -r b.png ...）
        const flag = args.pop();
        for (const r of refs) {
          if (flag !== undefined) args.push(flag);
          args.push(path.join(dir, r));
        }
        continue;
      }
      args.push(raw[i]!);
    }
    const log = backendLogStream(logDir, cfg.name);
    logger.info({ backend: cfg.name, command: cfg.command, args }, 'spawning cli backend');
    const proc = spawn(cfg.command!, args, {
      cwd: cfg.cwd,
      env: { ...process.env, ...(cfg.env ?? {}) },
      detached: true, // 新进程组，超时整组回收
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pgid = proc.pid;

    /** 整组回收：SIGTERM → 5s 后 SIGKILL */
    const killGroup = (): void => {
      try {
        process.kill(-pgid!, 'SIGTERM');
      } catch {
        /* 已退出 */
      }
      setTimeout(() => {
        try {
          process.kill(-pgid!, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 5000).unref();
    };

    // 致命输出熔断：命中 fail_on_output 说明后端降级运行（典型：GPU 初始化失败静默退回 CPU，
    // 单步耗时从秒级涨到分钟级）。此时立刻整组杀掉并带回原因，而不是陪跑满 cli_timeout 再报超时。
    const failPatterns = (cfg.fail_on_output ?? [])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => p.toLowerCase());
    let fatal: { pattern: string; line: string } | undefined;
    let carry = '';
    const scan = (chunk: Buffer): void => {
      if (!failPatterns.length || fatal) return;
      const text = carry + chunk.toString('utf8');
      carry = text.slice(-256); // 保留尾部，避免模式被 chunk 边界切断
      const lower = text.toLowerCase();
      for (const p of failPatterns) {
        const idx = lower.indexOf(p);
        if (idx < 0) continue;
        const line = text.split(/\r?\n/).find((l) => l.toLowerCase().includes(p)) ?? text.slice(idx, idx + 200);
        fatal = { pattern: p, line: line.trim().slice(0, 200) };
        logger.warn(
          { backend: cfg.name, pattern: p, line: fatal.line },
          'cli backend output matched fail_on_output; killing process group',
        );
        killGroup();
        return;
      }
    };
    proc.stdout!.on('data', scan);
    proc.stderr!.on('data', scan);
    proc.stdout!.pipe(log, { end: false });
    proc.stderr!.pipe(log, { end: false });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, cfg.cli_timeout_ms);
    timer.unref();

    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(AyaErrors.cliFailed(cfg.name, `spawn failed: ${e.message}`));
      });
      proc.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });

    if (fatal) {
      throw AyaErrors.backendDegraded(cfg.name, `matched "${fatal.line}" (fail_on_output: "${fatal.pattern}")`);
    }
    if (timedOut) {
      throw AyaErrors.cliFailed(cfg.name, `timeout after ${cfg.cli_timeout_ms}ms, process killed`);
    }
    if (code !== 0) {
      throw AyaErrors.cliFailed(cfg.name, `exit code ${code}（详见 data/logs/${cfg.name}.log）`);
    }

    let outputs: Buffer[];
    if (patternPath) {
      // 多产出：临时目录内除 input.txt 与参考图外全部按文件名排序读回
      const skip = new Set(['input.txt', ...refFiles]);
      const files = readdirSync(dir)
        .filter((f) => !skip.has(f))
        .sort();
      if (files.length === 0) {
        throw AyaErrors.cliFailed(cfg.name, '命令正常退出但未产出任何文件');
      }
      outputs = files.map((f) => readFileSync(path.join(dir, f)));
    } else {
      if (!existsSync(outputPath)) {
        throw AyaErrors.cliFailed(cfg.name, '命令正常退出但未产出输出文件');
      }
      outputs = [readFileSync(outputPath)];
    }
    if (outputs.some((b) => b.length === 0)) {
      throw AyaErrors.cliFailed(cfg.name, '产出文件为空');
    }
    return { output: outputs[0]!, outputs, exitCode: code, durationMs: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
