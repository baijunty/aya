import { useState } from 'react';
import { api, type BackendStatus } from '../api';
import { usePoll, useRange } from '../App';

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function Backends() {
  const { from, to } = useRange();
  const { data, error, reload } = usePoll(() => api.backends(), []);
  const { data: res } = usePoll(() => api.resources(), []);
  const { data: stats } = usePoll(() => api.backendStats(from, to), [from, to]);
  const [busy, setBusy] = useState<string>();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy('x');
    try {
      await fn();
    } catch (e) {
      alert(String((e as Error).message));
    }
    reload();
    setBusy(undefined);
  };

  const statOf = (name: string) => stats?.backends.find((b) => b.backend === name);

  return (
    <div>
      {res && (
        <div className="panel">
          <h3>设备内存（统一内存，MemAvailable 口径）</h3>
          <div className="bar-row">
            <span className="muted" style={{ width: 120 }}>
              可用 {fmtMb(res.mem.free_mb)} / {fmtMb(res.mem.total_mb)}
            </span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(res.mem.free_mb / res.mem.total_mb) * 100}%`, background: 'var(--green)' }} />
            </div>
          </div>
          {res.reserved.map((r) => (
            <div key={r.backend} className="bar-row">
              <span className="muted" style={{ width: 120 }}>{r.backend}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${(r.mem_mb / res.mem.total_mb) * 100}%` }} />
              </div>
              <span className="muted">{fmtMb(r.mem_mb)} ({r.phase})</span>
            </div>
          ))}
          {res.load_ops.map((op) => (
            <div key={op.backend} className="muted" style={{ marginTop: 6 }}>
              ⏳ {op.backend} 加载中（{op.state}）
              {op.victims.length > 0 && <>，正在等待闲置卸载：<b>{op.victims.join(', ')}</b></>}
            </div>
          ))}
        </div>
      )}

      {error && <div className="err">加载失败：{error}</div>}
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>后端</th><th>类型</th><th>状态</th><th>进行中</th><th>排队</th>
              <th>运行时长</th><th>闲置倒计时</th><th>启动/停止/崩溃/闲置停</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(data?.backends ?? []).map((b: BackendStatus) => {
              const st = statOf(b.name);
              return (
                <tr key={b.name}>
                  <td><b>{b.name}</b></td>
                  <td className="muted">{b.type}</td>
                  <td><span className={`tag ${b.state}`}>{b.state}</span></td>
                  <td>{b.inflight}</td>
                  <td>{b.queued}</td>
                  <td>{b.state === 'ready' ? fmtMs(b.uptime_ms) : '—'}</td>
                  <td>{b.idle_remaining_ms != null ? fmtMs(b.idle_remaining_ms) : '—'}</td>
                  <td className="muted">
                    {b.counters.starts}/{b.counters.stops}/{b.counters.crashes}/{b.counters.idle_stops}
                    {st ? <span> · 请求 {String(st.requests)}</span> : null}
                  </td>
                  <td>
                    {b.type === 'process' && (
                      b.state === 'stopped' || b.state === 'crashed' ? (
                        <button className="btn" disabled={busy === b.name} onClick={() => act(() => api.startBackend(b.name))}>启动</button>
                      ) : (
                        <button className="btn danger" disabled={busy === b.name} onClick={() => act(() => api.stopBackend(b.name))}>停止</button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + 'G';
  return mb + 'M';
}
