/** 解析时长："1500ms" | "30s" | "5m" | "1h" | 数字(毫秒) → 毫秒数 */
export function parseDuration(v: string | number): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid duration: ${v}`);
    return Math.floor(v);
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(s);
  if (!m) throw new Error(`invalid duration: "${v}" (use e.g. 500ms / 30s / 5m / 1h)`);
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.floor(n * mult);
}

export function nowMs(): number {
  return Date.now();
}
