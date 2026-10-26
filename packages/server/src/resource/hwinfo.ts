/**
 * 硬件状态探测：CPU / GPU / NPU / Swap，供看板「硬件状态」面板展示。
 * 全部走 procfs/sysfs 纯文件读取（无子进程、无外部命令依赖）：
 *   - CPU：/proc/stat 两次采样差值算总占用，os.loadavg()，k10temp hwmon 温度
 *   - GPU：/sys/class/drm/cardN/device（amdgpu 系）busy/VRAM/GTT/power/temp/clock
 *   - NPU：/sys/bus/pci/drivers/amdxdna 绑定设备（AMD XDNA）；利用率仅 debugfs
 *     暴露（root），普通进程读不到 → util_pct 为 null，前端如实显示「未暴露」
 * 任何一项读不到都降级为 null，绝不让 /api/v1/resources 因探测失败而报错。
 */
import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';

export interface HwCpuInfo {
  model: string;
  cores: number;
  /** 总占用 %（两次 /proc/stat 采样差值；首次调用按开机以来均值） */
  usage_pct: number | null;
  load1: number;
  load5: number;
  load15: number;
  temp_c: number | null;
}

export interface HwGpuInfo {
  index: number;
  name: string;
  busy_pct: number | null;
  /** 显存（APU 上为 stolen 可见显存，通常很小，大头在 GTT） */
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  /** GTT：从系统内存划给 GPU 的部分（统一内存主机 GPU 实际显存占用） */
  gtt_used_mb: number | null;
  gtt_total_mb: number | null;
  power_w: number | null;
  temp_c: number | null;
  clock_mhz: number | null;
}

export interface HwNpuInfo {
  name: string;
  pci: string;
  fw_version: string | null;
  /** XDNA 利用率仅 debugfs（root）暴露，常规环境为 null */
  util_pct: number | null;
  note?: string;
}

export interface HwSwapInfo {
  total_mb: number;
  used_mb: number;
}

export interface HwSnapshot {
  ts: number;
  cpu: HwCpuInfo;
  gpus: HwGpuInfo[];
  npus: HwNpuInfo[];
  swap: HwSwapInfo | null;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 读数值文件并按除数换算；不可得或非数值返回 null */
function readNumber(path: string, divisor = 1): number | null {
  const t = readOrNull(path);
  if (t == null) return null;
  const n = Number(t.trim());
  return Number.isFinite(n) ? n / divisor : null;
}

/** 读字节数值文件换算 MB（向下取整）；不可得返回 null */
function readMb(path: string): number | null {
  const mb = readNumber(path, 1048576);
  return mb == null ? null : Math.floor(mb);
}

/** 按 hwmon name（如 k10temp / amdgpu）找 hwmon 目录 */
function findHwmon(label: string): string | null {
  let names: string[];
  try {
    names = readdirSync('/sys/class/hwmon');
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    const dir = `/sys/class/hwmon/${name}`;
    if (readOrNull(`${dir}/name`)?.trim() === label) return dir;
  }
  return null;
}

// —— CPU ——

/** 上一次 /proc/stat 采样（模块级：CPU 占用 = 相邻两次调用差值） */
let lastCpuSample: { idle: number; total: number } | null = null;

function cpuSample(): { idle: number; total: number } | null {
  const text = readOrNull('/proc/stat');
  const m = text && /^cpu\s+(.+)$/m.exec(text);
  if (!m) return null;
  const fields = m[1]!.trim().split(/\s+/).map(Number);
  if (fields.some((n) => !Number.isFinite(n))) return null;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
  const total = fields.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuUsagePct(): number | null {
  const cur = cpuSample();
  if (!cur) return null;
  const prev = lastCpuSample;
  lastCpuSample = cur;
  // 首次调用没有前值：用开机以来均值兜底（total 即自开机累计，语义仍成立）
  const base = prev ?? { idle: 0, total: 0 };
  const dTotal = cur.total - base.total;
  if (dTotal <= 0) return null;
  const dIdle = cur.idle - base.idle;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10));
}

function probeCpu(): HwCpuInfo {
  const cpuinfo = readOrNull('/proc/cpuinfo') ?? '';
  const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? 'CPU';
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  const hwmon = findHwmon('k10temp') ?? findHwmon('zenpower');
  return {
    model,
    cores: os.cpus().length,
    usage_pct: cpuUsagePct(),
    load1: Math.round(load1 * 100) / 100,
    load5: Math.round(load5 * 100) / 100,
    load15: Math.round(load15 * 100) / 100,
    temp_c: hwmon ? round1(readNumber(`${hwmon}/temp1_input`, 1000)) : null,
  };
}

// —— GPU ——

/** 常见 PCI 设备 ID 的友好名（读不到就退回 driver + PCI ID） */
const GPU_FRIENDLY: Record<string, string> = {
  '1002:1586': 'AMD Radeon 8060S (gfx1151)',
};

function gpuName(deviceDir: string): string {
  const uevent = readOrNull(`${deviceDir}/uevent`) ?? '';
  const pciId = /^PCI_ID=(.+)$/m.exec(uevent)?.[1]?.trim();
  const driver = /^DRIVER=(.+)$/m.exec(uevent)?.[1]?.trim() ?? 'gpu';
  if (pciId && GPU_FRIENDLY[pciId]) return GPU_FRIENDLY[pciId]!;
  return pciId ? `${driver} ${pciId}` : driver;
}

function probeGpus(): HwGpuInfo[] {
  const out: HwGpuInfo[] = [];
  let cards: string[];
  try {
    cards = readdirSync('/sys/class/drm');
  } catch {
    return out;
  }
  const devs = cards
    .filter((c) => /^card\d+$/.test(c))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  for (const card of devs) {
    const dev = `/sys/class/drm/${card}/device`;
    const busy = readNumber(`${dev}/gpu_busy_percent`);
    const vramTotal = readMb(`${dev}/mem_info_vram_total`);
    const gttTotal = readMb(`${dev}/mem_info_gtt_total`);
    // 非 GPU 卡（虚拟/无 amdgpu 接口）跳过
    if (busy == null && vramTotal == null && gttTotal == null) continue;
    // 卡自带 hwmon（amdgpu）：温度/功耗/频率
    let hwmon: string | null = null;
    try {
      const subs = readdirSync(`${dev}/hwmon`).sort();
      if (subs[0]) hwmon = `${dev}/hwmon/${subs[0]}`;
    } catch {
      /* 无 hwmon */
    }
    const powerW = hwmon
      ? readNumber(`${hwmon}/power1_average`, 1e6) ?? readNumber(`${hwmon}/power1_input`, 1e6)
      : null;
    const clock = hwmon ? readNumber(`${hwmon}/freq1_input`, 1e6) : null;
    out.push({
      index: Number(card.slice(4)),
      name: gpuName(dev),
      busy_pct: busy,
      vram_used_mb: readMb(`${dev}/mem_info_vram_used`),
      vram_total_mb: vramTotal,
      gtt_used_mb: readMb(`${dev}/mem_info_gtt_used`),
      gtt_total_mb: gttTotal,
      power_w: round1(powerW),
      temp_c: hwmon ? round1(readNumber(`${hwmon}/temp1_input`, 1000)) : null,
      clock_mhz: clock != null && Number.isFinite(clock) ? Math.round(clock) : null,
    });
  }
  return out;
}

// —— NPU（AMD XDNA，amdxdna 驱动）——

function probeNpus(): HwNpuInfo[] {
  const out: HwNpuInfo[] = [];
  let bound: string[];
  try {
    bound = readdirSync('/sys/bus/pci/drivers/amdxdna');
  } catch {
    return out; // 无驱动/无设备
  }
  for (const pci of bound.sort()) {
    if (!/^[\da-f]+:[\da-f]+:[\da-f]+\.[\da-f]+$/i.test(pci)) continue;
    const dir = `/sys/bus/pci/drivers/amdxdna/${pci}`;
    let accel = '';
    try {
      accel = readdirSync(`${dir}/accel`)[0] ?? '';
    } catch {
      /* accel 节点缺失 */
    }
    out.push({
      name: accel ? `AMD XDNA NPU (${accel})` : 'AMD XDNA NPU',
      pci,
      fw_version: readOrNull(`${dir}/fw_version`)?.trim() ?? null,
      util_pct: null,
      note: '利用率需 root 读 debugfs，当前未暴露',
    });
  }
  return out;
}

// —— Swap ——

function probeSwap(): HwSwapInfo | null {
  const text = readOrNull('/proc/meminfo');
  if (!text) return null;
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Math.floor(parseInt(m[1]!, 10) / 1024) : null;
  };
  const total = num(/^SwapTotal:\s+(\d+)\s+kB$/m);
  const free = num(/^SwapFree:\s+(\d+)\s+kB$/m);
  if (!total) return null;
  return { total_mb: total, used_mb: Math.max(0, total - (free ?? total)) };
}

function round1(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

/** 采集一次硬件快照（CPU 占用为相邻两次调用的差值，随请求周期刷新） */
export function probeHardware(): HwSnapshot {
  return {
    ts: Date.now(),
    cpu: probeCpu(),
    gpus: probeGpus(),
    npus: probeNpus(),
    swap: probeSwap(),
  };
}
