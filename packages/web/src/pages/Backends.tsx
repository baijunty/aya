import { useState } from 'react';
import { api, type BackendStatus, type HwSnapshot } from '../api';
import { useRange } from '../App';
import { useNow, usePoll, useRefresh } from '../refresh';
import { RefreshHint } from '../components/RefreshControl';
import { fmtClock, fmtCount, fmtDuration, fmtInt, fmtMb, fmtNum, fmtPct, fmtPower, fmtTemp } from '../format';

/** 启停动作：点击到服务端落地之间用于展示「启动中/停止中/重启中」 */
type PendingAction = 'start' | 'stop' | 'restart';
const PENDING_LABEL: Record<PendingAction, string> = {
  start: '启动中',
  stop: '停止中',
  restart: '重启中',
};

export function Backends() {
  const { from, to } = useRange();
  const { refreshNow } = useRefresh();
  const { data: stats } = usePoll(() => api.backendStats(from, to), [from, to]);
  const [busy, setBusy] = useState<string>();
  // 点击瞬间就落地的「意图」：启停请求要等服务端真正 ready 才返回（模型加载可达几十秒），
  // 只靠 busy 禁用按钮，卡片上看着像没点上——所以先把动作显示出来，别等服务端回话
  const [pending, setPending] = useState<{ name: string; action: PendingAction; at: number; from?: string }>();
  // 有动作在途时把进程/资源两张表提到 2s 一拉，启停进展（starting、⏳ 准入）马上可见
  const hot = pending ? 2_000 : undefined;
  const { data, error, refreshing, updatedAt } = usePoll(() => api.backends(), [], hot);
  const { data: res } = usePoll(() => api.resources(), [], hot);
  // 轮询 10s 一次，倒计时按秒本地插值，否则数字会僵住 10s 再跳一格
  const now = useNow(1000);
  const drift = updatedAt ? Math.max(0, now - updatedAt) : 0;

  const stateOf = (name: string) => data?.backends.find((b) => b.name === name)?.state;

  const act = async (name: string, action: PendingAction, fn: () => Promise<unknown>) => {
    setBusy(name);
    setPending({ name, action, at: Date.now(), from: stateOf(name) });
    // 点击即刷新：状态、加载中（⏳ 准入/驱逐）立刻跟上，而不是等这一个请求返回
    refreshNow();
    try {
      await fn();
    } catch (e) {
      alert(String((e as Error).message));
    }
    // 启停是异步落地的：结束时再拉一次，别等下一个节拍
    refreshNow();
    setBusy(undefined);
    setPending((p) => (p?.name === name ? undefined : p));
  };

  const statOf = (name: string) => stats?.backends.find((b) => b.backend === name);

  return (
    <div>
      {res && (
        <div className="panel">
          <div className="panel-head">
            <h3>设备内存（统一内存，MemAvailable 口径）</h3>
          </div>
          <div className="bar-row">
            <span className="muted" style={{ width: 120 }} title={`占总内存 ${fmtPct((res.mem.free_mb / (res.mem.total_mb || 1)) * 100)}`}>
              可用 {fmtMb(res.mem.free_mb)} / {fmtMb(res.mem.total_mb)}
            </span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(res.mem.free_mb / res.mem.total_mb) * 100}%`, background: 'var(--green)' }} />
            </div>
          </div>
          {res.reserved.map((r) => {
            const shown = r.live_mb ?? r.mem_mb;
            return (
              <div key={r.backend} className="bar-row">
                <span className="muted" style={{ width: 120 }}>{r.backend}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(shown / res.mem.total_mb) * 100}%` }} />
                </div>
                <span className="muted" title={`占总内存 ${fmtPct((shown / (res.mem.total_mb || 1)) * 100)}`}>
                  {fmtMb(shown)}（{r.phase}）
                </span>
              </div>
            );
          })}
          {res.load_ops.map((op) => (
            <div key={op.backend} className="muted" style={{ marginTop: 6 }}>
              ⏳ {op.backend} 加载中（{op.state}）
              {op.victims.length > 0 && <>，正在等待闲置卸载：<b>{op.victims.join(', ')}</b></>}
            </div>
          ))}
        </div>
      )}

      {res?.hw && <HwPanel hw={res.hw} />}

      {error && <div className="err">加载失败：{error}</div>}
      <div className="panel">
        <div className="panel-head">
          <h3>后端进程</h3>
          <RefreshHint refreshing={refreshing} updatedAt={updatedAt} />
        </div>
        <div className="be-grid">
          {(data?.backends ?? []).map((b: BackendStatus) => {
            const st = statOf(b.name);
            const remaining = b.idle_remaining_ms != null ? Math.max(0, b.idle_remaining_ms - drift) : null;
            // 运行时长：服务端已按“进程实际运行中”给出（cli 空闲/process 非 ready 为 null），
            // 仅对非空值做本地秒级插值，避免 cli 型把轮询间隔 drift 误当运行时长一直跳
            const uptime = b.uptime_ms != null ? b.uptime_ms + drift : null;
            const idleFor = b.last_activity_ms ? now - b.last_activity_ms : null;
            const stopped = b.state === 'stopped' || b.state === 'crashed';
            // 本地已点下但服务端状态还没变（在排队等加载锁/驱逐）：卡片亮起 + 秒级计时，
            // 明确「点上了，正在处理」；服务端一变色就自动收起，不与实际状态打架
            const pend = pending?.name === b.name && b.state === pending.from ? pending : undefined;
            const pendLabel = pend ? PENDING_LABEL[pend.action] : undefined;
            const pendSec = pend ? Math.floor((now - pend.at) / 1000) : 0;
            return (
              <div key={b.name} className={`be-card ${b.state}${pend ? ' pending' : ''}`}>
                <div className="be-head">
                  <span className="be-name" title={b.name}>{b.name}</span>
                  <span className="be-tags">
                    {pend && (
                      <span className="tag pending" title={`${pendLabel}：服务端确认后自动更新`}>
                        {pendLabel} {pendSec}s
                      </span>
                    )}
                    <span className={`tag ${b.state}`}>{b.state}</span>
                  </span>
                </div>
                <div className="be-sub muted">
                  {b.type}
                  {st ? <span> · 请求 {fmtCount(st.requests as number)}</span> : null}
                </div>
                <div className="be-metrics">
                  <span><span className="k">进行中</span>{fmtInt(b.inflight)}</span>
                  <span><span className="k">排队</span>{fmtInt(b.queued)}</span>
                  <span><span className="k">运行时长</span>{fmtDuration(uptime)}</span>
                  <span className="muted"><span className="k">最近活跃</span>{idleFor != null ? `${fmtDuration(idleFor)}前` : '—'}</span>
                  <span className={remaining != null && remaining < 30_000 ? 'warn' : ''}>
                    <span className="k">闲置倒计时</span>{fmtDuration(remaining)}
                  </span>
                  <span className="muted" title="启动/停止/崩溃/闲置停">
                    <span className="k">启/停/崩/闲停</span>
                    {fmtInt(b.counters.starts)}/{fmtInt(b.counters.stops)}/{fmtInt(b.counters.crashes)}/{fmtInt(b.counters.idle_stops)}
                  </span>
                </div>
                <div className="be-foot">
                  {b.type === 'process' && (
                    stopped ? (
                      <button className="btn" disabled={busy === b.name} onClick={() => act(b.name, 'start', () => api.startBackend(b.name))}>
                        {pend?.action === 'start' ? '启动中…' : '启动'}
                      </button>
                    ) : (
                      <>
                        <button className="btn danger" disabled={busy === b.name} onClick={() => act(b.name, 'stop', () => api.stopBackend(b.name))}>
                          {pend?.action === 'stop' ? '停止中…' : '停止'}
                        </button>
                        <button className="btn" disabled={busy === b.name} onClick={() => act(b.name, 'restart', () => api.restartBackend(b.name))}>
                          {pend?.action === 'restart' ? '重启中…' : '重启'}
                        </button>
                      </>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 占用条颜色：绿 <60% ≤ 黄 <85% ≤ 红 */
function usageColor(pct: number | null): string {
  if (pct == null) return 'var(--accent)';
  if (pct >= 85) return 'var(--red)';
  if (pct >= 60) return 'var(--yellow)';
  return 'var(--green)';
}

function HwPanel({ hw }: { hw: HwSnapshot }) {
  const { cpu, gpus, npus, swap } = hw;
  const swapPct = swap && swap.total_mb > 0 ? (swap.used_mb / swap.total_mb) * 100 : null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>硬件状态</h3>
      </div>
      <div className="bar-row">
        <span className="muted" style={{ width: 120 }} title={cpu.model}>CPU</span>
        <div className="bar-track">
          <div className="bar-fill" style={{ width: `${Math.min(100, cpu.usage_pct ?? 0)}%`, background: usageColor(cpu.usage_pct) }} />
        </div>
        <span className="muted">
          {fmtPct(cpu.usage_pct)} · 负载 {fmtNum(cpu.load1)} / {fmtNum(cpu.load5)} / {fmtNum(cpu.load15)} · {fmtInt(cpu.cores)} 核
          {cpu.temp_c != null ? ` · ${fmtTemp(cpu.temp_c)}` : ''}
        </span>
      </div>
      {gpus.map((g) => (
        <div key={g.index}>
          <div className="bar-row">
            <span className="muted" style={{ width: 120 }} title={g.name}>GPU {g.index}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.min(100, g.busy_pct ?? 0)}%`, background: usageColor(g.busy_pct) }} />
            </div>
            <span className="muted">
              {fmtPct(g.busy_pct)}
              {g.power_w != null ? ` · ${fmtPower(g.power_w)}` : ''}
              {g.temp_c != null ? ` · ${fmtTemp(g.temp_c)}` : ''}
              {g.clock_mhz != null ? ` · ${fmtClock(g.clock_mhz)}` : ''}
            </span>
          </div>
          {g.vram_total_mb != null && g.vram_total_mb > 0 && (
            <div className="bar-row">
              <span className="muted" style={{ width: 120 }}>　显存</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.min(100, ((g.vram_used_mb ?? 0) / g.vram_total_mb) * 100)}%` }} />
              </div>
              <span className="muted">{fmtMb(g.vram_used_mb ?? 0)} / {fmtMb(g.vram_total_mb)}</span>
            </div>
          )}
          {g.gtt_total_mb != null && g.gtt_total_mb > 0 && (
            <div className="bar-row">
              <span className="muted" style={{ width: 120 }} title="统一内存主机上 GPU 实际显存占用（GTT，从系统内存划分）">　GTT 共享</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.min(100, ((g.gtt_used_mb ?? 0) / g.gtt_total_mb) * 100)}%` }} />
              </div>
              <span className="muted">{fmtMb(g.gtt_used_mb ?? 0)} / {fmtMb(g.gtt_total_mb)}</span>
            </div>
          )}
        </div>
      ))}
      {npus.map((n) => (
        <div key={n.pci} className="bar-row">
          <span className="muted" style={{ width: 120 }} title={n.pci}>NPU</span>
          {n.util_pct != null ? (
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.min(100, n.util_pct)}%`, background: usageColor(n.util_pct) }} />
            </div>
          ) : (
            <div className="bar-track" style={{ opacity: 0.35 }} />
          )}
          <span className="muted">
            {fmtPct(n.util_pct)} · {n.name}
            {n.fw_version ? ` · FW ${n.fw_version}` : ''}
            {n.util_pct == null && n.note ? ` · ${n.note}` : ''}
          </span>
        </div>
      ))}
      {swap && swap.total_mb > 0 && (
        <div className="bar-row">
          <span className="muted" style={{ width: 120 }}>Swap</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.min(100, swapPct ?? 0)}%`, background: usageColor(swapPct) }} />
          </div>
          <span className="muted">{fmtMb(swap.used_mb)} / {fmtMb(swap.total_mb)}</span>
        </div>
      )}
    </div>
  );
}
