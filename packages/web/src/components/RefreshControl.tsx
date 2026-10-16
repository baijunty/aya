import { REFRESH_OPTIONS, isPageVisible, useNow, useRefresh } from '../refresh';

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

/** 面板右上角的拉取状态提示：在途 / 上次成功时刻，让「有没有在刷新」一眼可见 */
export function RefreshHint({ refreshing, updatedAt }: { refreshing: boolean; updatedAt?: number }) {
  return (
    <span className="muted refresh-hint">
      <span className={`dot${refreshing ? ' busy' : ''}`} />
      {refreshing ? '刷新中…' : updatedAt ? `更新于 ${fmtClock(updatedAt)}` : '加载中…'}
    </span>
  );
}

/**
 * 顶栏自动刷新控件：档位（含「关」）、立即刷新、上次刷新时刻与下次倒计时。
 * 全局生效——所有未指定自身周期的 usePoll（总览/趋势/请求明细/后端状态）都跟着它走。
 */
export function RefreshControl() {
  const { intervalMs, setIntervalMs, lastTickAt, refreshNow } = useRefresh();
  const now = useNow(1000);
  const hidden = !isPageVisible();
  const nextIn = intervalMs ? Math.max(0, Math.ceil((lastTickAt + intervalMs - now) / 1000)) : 0;

  return (
    <span className="refresh-ctl">
      <span className="muted">自动刷新</span>
      {REFRESH_OPTIONS.map((o) => (
        <button
          key={o.ms}
          className={`btn ${intervalMs === o.ms ? 'active' : ''}`}
          title={o.title}
          onClick={() => setIntervalMs(o.ms)}
        >
          {o.label}
        </button>
      ))}
      <button className="btn" title="立即刷新" onClick={refreshNow}>
        ↻
      </button>
      <span className="refresh-meta" title={`上次刷新发起于 ${fmtClock(lastTickAt)}`}>
        {hidden ? '后台已暂停' : intervalMs ? `${nextIn}s 后` : '已暂停'} · 更新于 {fmtClock(lastTickAt)}
      </span>
    </span>
  );
}
