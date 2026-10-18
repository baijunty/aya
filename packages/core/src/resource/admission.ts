import type { BackendConfig, BackendRuntime, ResourceSnapshot } from '../model/types.js';

/** 后端加载所需内存（含安全余量）；未声明 required_memory 时为 0（不做准入） */
export function requiredMemMb(cfg: BackendConfig, safetyMarginMb: number): number {
  if (!cfg.required_memory) return 0;
  return cfg.required_memory.mem_mb + safetyMarginMb;
}

export interface AdmissionInput {
  snapshot: ResourceSnapshot;
  /**
   * 有效占用记账（backend → mem_mb）：
   * running 后端为实测驻留（文件页+shmem，由调用方采样），reserved/starting 为声明值。
   * MemAvailable 已排除匿名占用，但把 mmap 权重页计为「可回收」，故只需扣文件页部分。
   */
  reserved: Map<string, number>;
  target: BackendConfig;
  safetyMarginMb: number;
}

export interface AdmissionResult {
  fit: boolean;
  need_mb: number;
  free_mb: number;
  available_mb: number;
}

/** 准入检查（design.md §4.7.2）：available = free − reserved ≥ required */
export function checkAdmission(input: AdmissionInput): AdmissionResult {
  const need = requiredMemMb(input.target, input.safetyMarginMb);
  let reservedTotal = 0;
  for (const [b, mb] of input.reserved) {
    if (b !== input.target.name) reservedTotal += mb;
  }
  const available = input.snapshot.mem_free_mb - reservedTotal;
  return {
    fit: need === 0 || available >= need,
    need_mb: need,
    free_mb: input.snapshot.mem_free_mb,
    available_mb: available,
  };
}

export interface EvictCandidate {
  name: string;
  /** 卸载后可释放的内存（实测驻留总量，缺省按声明值；仅作为腾挪顺序参考） */
  release_mb: number;
  busy: boolean;
  priority: number;
  lastActivityAt: number;
}

/**
 * 驱逐候选排序（design.md §4.7.3）：
 * 仅 ready && evictable && 非目标；allow_evict_busy=false 时再要求非忙。
 * 排序：priority 升序 → lastActivityAt 升序（低优先级、闲置最久者先牺牲）。
 * 卸载可释放量优先用调用方传入的实测驻留 resident_mb，缺省回退声明值。
 */
export function selectEvictCandidates(
  backends: Array<{ cfg: BackendConfig; rt: BackendRuntime; resident_mb?: number }>,
  targetName: string,
  allowEvictBusy: boolean,
): EvictCandidate[] {
  const out: EvictCandidate[] = [];
  for (const { cfg, rt, resident_mb } of backends) {
    if (cfg.name === targetName) continue;
    if (cfg.type !== 'process') continue;
    if (rt.state !== 'ready') continue;
    if (cfg.evictable === false) continue;
    const busy = rt.inflight > 0 || rt.queued > 0;
    if (busy && !allowEvictBusy) continue;
    out.push({
      name: cfg.name,
      release_mb: resident_mb ?? cfg.required_memory?.mem_mb ?? 0,
      busy,
      priority: cfg.priority ?? 0,
      lastActivityAt: rt.lastActivityAt,
    });
  }
  out.sort((a, b) => a.priority - b.priority || a.lastActivityAt - b.lastActivityAt);
  return out;
}

/**
 * 依序累加候选为 victims，模拟释放后重算 fit（design.md §4.7.3）。
 * 返回选中的 victims 列表；无法凑够时返回全部候选（继续等待其闲置）。
 */
export function planEviction(
  candidates: EvictCandidate[],
  admission: AdmissionResult,
): { victims: string[]; sufficient: boolean } {
  const victims: string[] = [];
  let avail = admission.available_mb;
  for (const c of candidates) {
    if (avail >= admission.need_mb) return { victims, sufficient: true };
    victims.push(c.name);
    avail += c.release_mb;
  }
  return { victims, sufficient: avail >= admission.need_mb };
}
