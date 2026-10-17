import { useEffect, useRef, useState } from 'react';
import { api, type RequestRow } from '../api';
import { useRange } from '../App';
import { usePoll } from '../refresh';
import { RefreshHint } from '../components/RefreshControl';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function RawBlock({ title, text }: { title: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <b>{title}</b>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
          }}
        >
          复制
        </button>
      </div>
      <pre className="raw">{text}</pre>
    </div>
  );
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = usePoll(() => api.requestDetail(id), [id], 60000);
  if (!data) return null;
  const tl = data.timeline_ms as Record<string, number> | undefined;
  const total = tl?.total ?? 1;
  const queue = tl?.queue ?? 0;
  const ttfb = tl?.backend_ttfb ?? 0;
  const stream = Math.max(0, total - queue - ttfb);
  const reqRaw = typeof data.req_raw === 'string' ? (data.req_raw as string) : '';
  const respRaw = typeof data.resp_raw === 'string' ? (data.resp_raw as string) : '';
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>请求详情 {id}</h3>
        {tl && (
          <div
            className="timeline"
            title={`排队 ${queue}ms / 响应头 ${ttfb}ms / 首字节 ${tl.first_byte ?? 0}ms / 传输 ${stream}ms（TTFT 来源：${tl.ttft_source ?? '未知'}）`}
          >
            <div className="tl-queue" style={{ width: `${(queue / total) * 100}%` }} />
            <div className="tl-ttfb" style={{ width: `${(ttfb / total) * 100}%` }} />
            <div className="tl-stream" style={{ width: `${(stream / total) * 100}%` }} />
          </div>
        )}
        <table>
          <tbody>
            {Object.entries(data)
              .filter(([k]) => k !== 'timeline_ms' && k !== 'req_raw' && k !== 'resp_raw')
              .map(([k, v]) => (
                <tr key={k}>
                  <td className="muted" style={{ width: 180 }}>{k}</td>
                  <td style={{ whiteSpace: 'pre-wrap' }}>{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <RawBlock title="原始请求（请求体头部）" text={reqRaw} />
        <RawBlock title="上游错误响应（响应体头部）" text={respRaw} />
        {!reqRaw && !respRaw && (
          <p className="muted" style={{ marginTop: 12 }}>
            未记录原始报文：仅失败请求记录请求体/上游错误响应头部（proxy.log_raw_on_error 可关闭，raw_log_max_bytes 控制长度）。
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

const PURGE_PRESETS = [
  { days: 1, label: '1 天前' },
  { days: 3, label: '3 天前' },
  { days: 7, label: '一周前' },
  { days: 14, label: '两周前' },
  { days: 30, label: '一个月前' },
  { days: 90, label: '三个月前' },
];

export function Requests() {
  const { from, to } = useRange();
  const [page, setPage] = useState(1);
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<string>();
  const { data, refreshing, updatedAt, reload } = usePoll(
    () => api.requests(from, to, page, { model, endpoint, status }),
    [from, to, page, model, endpoint, status],
  );

  // 过期数据清理：先 dry_run 数条数，确认框展示后再真删
  const [purgeDays, setPurgeDays] = useState(7);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string>();

  async function onPurge() {
    if (purging) return;
    setPurging(true);
    setPurgeMsg(undefined);
    try {
      const before = Date.now() - purgeDays * 86400_000;
      const preview = await api.purgeRequests(before, true);
      const n = preview.would_delete ?? 0;
      if (n === 0) {
        setPurgeMsg(`${fmtTime(before)} 之前已无数据`);
        return;
      }
      const ok = window.confirm(
        `将删除 ${fmtTime(before)} 之前的 ${n} 条请求记录（含后端事件 ${preview.events_would_delete ?? 0} 条），删除后不可恢复。确认清理？`,
      );
      if (!ok) return;
      const r = await api.purgeRequests(before, false);
      setPurgeMsg(`已清理 ${r.deleted ?? 0} 条请求记录`);
      setPage(1);
      reload();
    } catch (e) {
      setPurgeMsg(`清理失败：${(e as Error).message}`);
    } finally {
      setPurging(false);
    }
  }

  // 定时刷新带进来的新增条数：只在第一页提示，翻页时不去打扰正在看历史的用户
  const prevTotal = useRef<number | undefined>(undefined);
  const newCount = data && prevTotal.current != null && page === 1 ? Math.max(0, data.total - prevTotal.current) : 0;
  useEffect(() => {
    prevTotal.current = data?.total;
  }, [data?.total]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          请求明细{' '}
          {newCount > 0 && (
            <span className="tag ok" title="本次定时刷新新增">
              +{newCount} 条新请求
            </span>
          )}
        </h3>
        <RefreshHint refreshing={refreshing} updatedAt={updatedAt} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input type="text" placeholder="模型过滤" value={model} onChange={(e) => { setModel(e.target.value); setPage(1); }} />
        <select value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setPage(1); }}>
          <option value="">全部端点</option>
          {['chat', 'completion', 'embedding', 'image', 'asr', 'tts'].map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">全部状态</option>
          <option value="ok">成功</option>
          <option value="fail">失败</option>
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {purgeMsg && <span className="muted">{purgeMsg}</span>}
          <select
            value={purgeDays}
            title="清理早于该时间点的请求明细"
            onChange={(e) => { setPurgeDays(Number(e.target.value)); setPurgeMsg(undefined); }}
          >
            {PURGE_PRESETS.map((p) => (
              <option key={p.days} value={p.days}>{p.label}</option>
            ))}
          </select>
          <button className="btn" disabled={purging} onClick={() => void onPurge()}>
            {purging ? '清理中…' : '清理过期数据'}
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>时间</th><th>模型</th><th>端点</th><th>后端</th><th>流式</th>
            <th>状态</th><th>延迟</th><th>TTFT</th><th>pp</th><th>tg</th>
            <th>tokens</th><th>cached</th>
          </tr>
        </thead>
        <tbody>
          {(data?.items ?? []).map((r: RequestRow) => (
            <tr key={r.request_id} className="clickable" onClick={() => setDetail(r.request_id)}>
              <td>{fmtTime(r.ts_start)}</td>
              <td>{r.model}</td>
              <td>{r.endpoint}</td>
              <td className="muted">{r.backend}</td>
              <td>{r.is_stream ? '是' : '否'}</td>
              <td>
                <span className={`tag ${r.ok ? 'ok' : 'fail'}`} title={r.error ?? undefined}>
                  {r.status_code}{r.error ? ` ${r.error.length > 60 ? r.error.slice(0, 60) + '…' : r.error}` : ''}
                </span>
              </td>
              <td>{r.latency_ms}ms</td>
              <td>{r.ttft_ms ?? '—'}{r.ttft_ms != null ? 'ms' : ''}</td>
              <td>{r.pp_tokens_s != null ? `${r.pp_tokens_s} t/s` : '—'}</td>
              <td>{r.tg_tokens_s != null ? `${r.tg_tokens_s} t/s` : '—'}</td>
              <td>{r.total_tokens ?? '—'}</td>
              <td>{r.cached_tokens ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
        <span>第 {page} 页 / 共 {Math.max(1, Math.ceil((data?.total ?? 0) / 50))} 页（{data?.total ?? 0} 条）</span>
        <button className="btn" disabled={page * 50 >= (data?.total ?? 0)} onClick={() => setPage((p) => p + 1)}>下一页</button>
      </div>
      {detail && <DetailModal id={detail} onClose={() => setDetail(undefined)} />}
    </div>
  );
}
