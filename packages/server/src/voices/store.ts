import path from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { newId } from '@aya/core';

/** 自定义音色（OpenAI custom voices 风格）：上传音频样本作为音色，speech 请求按 id 引用 */
export interface VoiceRow {
  id: string;
  name: string;
  created_at: number; // Unix 秒
  type: string; // 'audio_sample'
  filename: string | null;
  content_type: string | null;
  bytes: number;
  consent: string | null;
  path: string; // 样本文件绝对路径（cli 后端 --tts-speaker-file 用）
}

const DDL = `
CREATE TABLE IF NOT EXISTS voices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INT NOT NULL,
  type TEXT NOT NULL DEFAULT 'audio_sample',
  filename TEXT, content_type TEXT, bytes INT NOT NULL DEFAULT 0,
  consent TEXT, path TEXT NOT NULL
);
`;

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.webm']);

/** 是否已是 PCM WAV（llama-tts 可直接解码） */
function isPcmWav(buf: Buffer): boolean {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

/** ffmpeg 转 24kHz 单声道 pcm_s16le wav；失败返回 undefined */
function transcodeToWav(buf: Buffer): Buffer | undefined {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], {
    input: buf,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status === 0 && r.stdout && isPcmWav(r.stdout)) return r.stdout;
  return undefined;
}

export class VoiceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly dir: string,
  ) {
    this.dir = path.resolve(dir);
    mkdirSync(this.dir, { recursive: true });
    db.exec(DDL);
    this.normalizeStoredPaths();
  }

  /**
   * 历史遗留：旧版本 cwd 不同导致 path 列存了相对路径（甚至指向别处的 data）。
   * 启动时归一化：相对路径一律按「样本就在本 voices 目录」重解析为绝对路径，
   * 文件存在才回写，不存在则保持原样（宁可查不到也不指错文件）。
   */
  private normalizeStoredPaths(): void {
    const rows = this.db.prepare(`SELECT id, path FROM voices`).all() as { id: string; path: string }[];
    for (const r of rows) {
      if (path.isAbsolute(r.path)) continue;
      const candidate = path.join(this.dir, path.basename(r.path));
      if (existsSync(candidate)) {
        this.db.prepare(`UPDATE voices SET path=? WHERE id=?`).run(candidate, r.id);
      }
    }
  }

  /** OpenAI voice 对象（不含内部字段） */
  static toObject(v: VoiceRow): Record<string, unknown> {
    return {
      id: v.id,
      object: 'audio.voice',
      created_at: v.created_at,
      name: v.name,
      type: v.type,
      metadata: { filename: v.filename, content_type: v.content_type, bytes: v.bytes, consent: v.consent },
    };
  }

  create(
    name: string,
    buf: Buffer,
    opts: { filename?: string; contentType?: string; consent?: string } = {},
  ): VoiceRow {
    const id = newId('voice');
    const ext = opts.filename ? path.extname(opts.filename).toLowerCase() : '';
    // llama-tts 的 speaker file 对 wav(PCM) 解码最稳（ogg/mp3 等依赖 ffprobe 管道，易失败）：
    // 非 wav 一律用 ffmpeg 转成 24kHz 单声道 pcm_s16le；ffmpeg 不可用时回退存原始文件。
    let data: Buffer = buf;
    let storedExt = AUDIO_EXTS.has(ext) ? ext : '.bin';
    if (!isPcmWav(buf) && storedExt !== '.bin') {
      const wav = transcodeToWav(buf);
      if (wav) {
        data = wav;
        storedExt = '.wav';
      }
    }
    const file = path.resolve(this.dir, id + storedExt); // 绝对路径：--tts-speaker-file 与 cwd 解耦
    writeFileSync(file, data);
    const row: VoiceRow = {
      id,
      name,
      created_at: Math.floor(Date.now() / 1000),
      type: 'audio_sample',
      filename: opts.filename ?? null,
      content_type: storedExt === '.wav' ? 'audio/wav' : (opts.contentType ?? null),
      bytes: data.length,
      consent: opts.consent ?? null,
      path: file,
    };
    this.db
      .prepare(
        `INSERT INTO voices(id,name,created_at,type,filename,content_type,bytes,consent,path)
         VALUES(@id,@name,@created_at,@type,@filename,@content_type,@bytes,@consent,@path)`,
      )
      .run(row);
    return row;
  }

  get(id: string): VoiceRow | undefined {
    return this.db.prepare(`SELECT * FROM voices WHERE id=?`).get(id) as VoiceRow | undefined;
  }

  findByName(name: string): VoiceRow | undefined {
    return this.db
      .prepare(`SELECT * FROM voices WHERE name = ? COLLATE NOCASE`)
      .get(name) as VoiceRow | undefined;
  }

  list(): VoiceRow[] {
    return this.db.prepare(`SELECT * FROM voices ORDER BY created_at DESC, id`).all() as VoiceRow[];
  }

  rename(id: string, name: string): boolean {
    return this.db.prepare(`UPDATE voices SET name=? WHERE id=?`).run(name, id).changes > 0;
  }

  remove(id: string): boolean {
    const v = this.get(id);
    if (!v) return false;
    this.db.prepare(`DELETE FROM voices WHERE id=?`).run(id);
    rmSync(v.path, { force: true });
    return true;
  }
}
