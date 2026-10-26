// 全站统一的「人类可读」格式化。
// 口径约定（页面只负责选口径，不再各写一份 fmt）：
//  - 时长：<1s 用 ms，<100s 用 s（1~2 位小数），再往上 m/s → h/m → d/h；
//  - 计数 / Token：≥1 万用 k，≥100 万用 M，≥10 亿用 B，以下保留千分位精确值；
//  - 字节 / 内存：B → KB → MB → GB → TB（1024 进制，与内存容量口径一致）；
//  - 比率：0~1 的小数统一转百分比。
// 空值一律渲染成 '—'，调用方不必再写 ?? '—'。

export const DASH = '—';

/** 千分位 + 最多 maxDigits 位小数（去掉尾随 0）：1234.5 → '1,234.5' */
function plain(n: number, maxDigits: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: maxDigits });
}

/** 四舍五入到 digits 位并去掉尾随 0：1.50 → '1.5'，2.00 → '2' */
function trim(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)));
}

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** 精确整数 + 千分位：12345 → '12,345'。条数、页数这类要「数得清」的用 */
export function fmtInt(n: number | null | undefined): string {
  return isNum(n) ? Math.round(n).toLocaleString('en-US') : DASH;
}

/** 通用数值：按量级给有效位数，不做单位换算。负载、温度、核数这类用 */
export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (!isNum(n)) return DASH;
  const abs = Math.abs(n);
  return plain(n, abs >= 100 ? Math.min(digits, 1) : digits);
}

/** 计数 / Token 总量：1234 → '1,234'，12345 → '12.3k'，3.4e6 → '3.4M' */
export function fmtCount(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6, 2)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3, 1)}k`;
  return plain(n, Number.isInteger(n) ? 0 : 1);
}

/** 时长：850 → '850ms'，1234 → '1.23s'，95_000 → '1m35s'，7_200_000 → '2h00m' */
export function fmtDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 999.5) return `${sign}${Math.round(abs)}ms`;
  if (abs < 10_000) return `${sign}${trim(abs / 1000, 2)}s`;
  if (abs < 60_000) return `${sign}${trim(abs / 1000, 1)}s`;
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.round((abs - m * 60_000) / 1000);
    return `${sign}${m}m${String(s).padStart(2, '0')}s`;
  }
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs - h * 3_600_000) / 60_000);
    return `${sign}${h}h${String(m).padStart(2, '0')}m`;
  }
  const d = Math.floor(abs / 86_400_000);
  const h = Math.round((abs - d * 86_400_000) / 3_600_000);
  return `${sign}${d}d${String(h).padStart(2, '0')}h`;
}

/** 速率（tok/s）：1234.5 → '1,234.5 t/s'，23456 → '23.5k t/s' */
export function fmtRate(n: number | null | undefined, unit = 't/s'): string {
  return isNum(n) ? `${fmtCount(n)} ${unit}` : DASH;
}

/** 0~1 比率 → 百分比：0.9846 → '98.5%' */
export function fmtRatio(ratio: number | null | undefined, digits = 1): string {
  return isNum(ratio) ? `${trim(ratio * 100, digits)}%` : DASH;
}

/** 已经是百分数的数值 → '42.5%'（硬件占用、命中率这类服务端已换算好的） */
export function fmtPct(pct: number | null | undefined, digits = 1): string {
  return isNum(pct) ? `${trim(pct, digits)}%` : DASH;
}

/** 字节：1536 → '1.5 KB' */
export function fmtBytes(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${trim(v, i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 内存：服务端按 MB 给出，≥1024MB 进位成 GB */
export function fmtMb(mb: number | null | undefined): string {
  if (!isNum(mb)) return DASH;
  if (Math.abs(mb) >= 1024) return `${trim(mb / 1024, 1)} GB`;
  return `${trim(mb, 0)} MB`;
}

/** 显存/内存占用「已用 / 总量」，总量同时作为 title 提示百分比 */
export function fmtMbPair(usedMb: number | null | undefined, totalMb: number | null | undefined): string {
  if (!isNum(totalMb) || totalMb <= 0) return fmtMb(usedMb);
  return `${fmtMb(usedMb)} / ${fmtMb(totalMb)}`;
}

/** 频率：2400MHz → '2.4 GHz'，800MHz → '800 MHz' */
export function fmtClock(mhz: number | null | undefined): string {
  if (!isNum(mhz)) return DASH;
  return mhz >= 1000 ? `${trim(mhz / 1000, 2)} GHz` : `${trim(mhz, 0)} MHz`;
}

/** 温度：56.78 → '56.8°C' */
export function fmtTemp(c: number | null | undefined): string {
  return isNum(c) ? `${trim(c, 1)}°C` : DASH;
}
/** 功耗：123.45 → '123.5 W' */
export function fmtPower(w: number | null | undefined): string {
  return isNum(w) ? `${trim(w, 1)} W` : DASH;
}

// ---------- 时间戳 ----------

/** 完整时刻：'2026/10/25 10:07:36' */
export function fmtDateTime(ms: number | null | undefined): string {
  if (!isNum(ms)) return DASH;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 图表 x 轴时间刻度：'10/25 14:00' */
export function fmtBucket(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
  });
}

// ---------- ECharts 适配 ----------
// 图表里数值是裸的 number，靠 axisLabel / tooltip 的 formatter 套上单位才「人类可读」；
// 坐标轴 name 因此不再写单位（formatter 自带），避免 800ms 与 name:'ms' 打架。

/** 坐标轴标签格式化器 */
export function axisFmt(fn: (v: number) => string): (value: number | string) => string {
  return (value: number | string) => (isNum(Number(value)) ? fn(Number(value)) : String(value));
}

interface SeriesParam {
  axisValueLabel?: string;
  name?: string;
  seriesName?: string;
  value?: unknown;
  marker?: string;
  percent?: number;
}

/**
 * tooltip 格式化器。trigger:'axis' 收到的是数组，'item'（饼图）是单个对象，
 * 两种都吃：数组逐行列出，饼图单行「名称: 值 (占比)」。
 */
export function tooltipFmt(fn: (v: number) => string): (params: unknown) => string {
  return (params: unknown) => {
    const list = (Array.isArray(params) ? params : [params]) as SeriesParam[];
    if (!list.length) return '';
    const line = (p: SeriesParam, useName = false): string => {
      const raw = p.value;
      const val = typeof raw === 'number' ? fn(raw) : String(raw ?? DASH);
      const pct = p.percent != null ? ` (${trim(p.percent, 1)}%)` : '';
      const label = p.seriesName ?? (useName ? p.name : undefined);
      const marker = p.marker ? `${p.marker} ` : '';
      return `${marker}${label ? `${label}: ` : ''}${val}${pct}`;
    };
    // 饼图这类单条 params：名称就在 params 上，直接并到一行，别再来一个同名标题
    if (!Array.isArray(params)) return line(list[0], true);
    const head = list[0].axisValueLabel ?? list[0].name ?? '';
    const lines = list.map((p) => line(p));
    return head ? [head, ...lines].join('<br/>') : lines.join('<br/>');
  };
}
