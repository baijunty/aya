/** 解析字节数："512kb" | "20mb" | "1gb" | 数字(字节) → 字节数 */
export function parseByteSize(v: string | number): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid byte size: ${v}`);
    return Math.floor(v);
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(s);
  if (!m) throw new Error(`invalid byte size: "${v}" (use e.g. 512kb / 20mb / 1gb)`);
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.floor(parseFloat(m[1]!) * mult[m[2]!.toLowerCase()]!);
}
