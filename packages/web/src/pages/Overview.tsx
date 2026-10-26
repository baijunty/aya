import { api } from '../api';
import { useRange } from '../App';
import { usePoll } from '../refresh';
import { Chart, baseGrid, axisStyle } from '../components/Chart';
import { axisFmt, fmtBucket, fmtCount, fmtDuration, fmtInt, fmtRatio, tooltipFmt } from '../format';

export function Overview() {
  const { from, to } = useRange();
  const { data: s, error } = usePoll(() => api.summary(from, to), [from, to]);
  const { data: reqSeries } = usePoll(() => api.series(from, to, 'requests'), [from, to]);
  const { data: tokSeries } = usePoll(() => api.series(from, to, 'tokens'), [from, to]);

  if (error) return <div className="err">加载失败：{error}</div>;
  if (!s) return <div className="muted">加载中…</div>;

  return (
    <div>
      <div className="cards">
        <div className="card" title={`${fmtInt(s.requests.total)} 次（成功 ${fmtInt(s.requests.ok)} / 失败 ${fmtInt(s.requests.fail)}）`}>
          <div className="label">请求总数</div>
          <div className="value">{fmtCount(s.requests.total)}</div>
        </div>
        <div className="card" title={`prompt ${fmtInt(s.tokens.prompt)} / completion ${fmtInt(s.tokens.completion)} / 命中缓存 ${fmtInt(s.tokens.cached)}`}>
          <div className="label">Token 总量</div>
          <div className="value">{fmtCount(s.tokens.total)}</div>
        </div>
        <div className="card" title={`p50 ${fmtDuration(s.latency_ms.p50)} · p95 ${fmtDuration(s.latency_ms.p95)} · p99 ${fmtDuration(s.latency_ms.p99)}`}>
          <div className="label">平均延迟</div>
          <div className="value">{fmtDuration(s.latency_ms.avg)}</div>
        </div>
        <div className="card" title={`平均 TTFT ${fmtDuration(s.ttft_ms.avg)}`}>
          <div className="label">P95 TTFT</div>
          <div className="value">{fmtDuration(s.ttft_ms.p95)}</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: s.requests.success_rate < 0.95 ? 'var(--red)' : 'var(--green)' }}>
            {fmtRatio(1 - s.requests.success_rate)}
          </div>
        </div>
        <div className="card">
          <div className="label">缓存命中率</div>
          <div className="value">{fmtRatio(s.cache_hit_rate)}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>请求量趋势</h3>
          <Chart
            option={{
              grid: baseGrid,
              tooltip: { trigger: 'axis', formatter: tooltipFmt((v) => `${fmtCount(v)} 次`) },
              xAxis: { type: 'category', data: (reqSeries?.series ?? []).map((p) => fmtBucket(p.bucket)), ...axisStyle },
              yAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: axisFmt(fmtCount) } },
              series: [{ type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: (reqSeries?.series ?? []).map((p) => p.value ?? 0), itemStyle: { color: '#4c9aff' } }],
            }}
          />
        </div>
        <div className="panel">
          <h3>Token 用量（prompt vs completion）</h3>
          <Chart
            option={{
              grid: baseGrid,
              tooltip: { trigger: 'axis', formatter: tooltipFmt(fmtCount) },
              legend: { textStyle: { color: '#8494a3' } },
              xAxis: { type: 'category', data: (tokSeries?.series ?? []).map((p) => fmtBucket(p.bucket)), ...axisStyle },
              yAxis: { type: 'value', ...axisStyle, axisLabel: { ...axisStyle.axisLabel, formatter: axisFmt(fmtCount) } },
              series: [
                { name: 'prompt', type: 'bar', stack: 't', data: (tokSeries?.series ?? []).map((p) => p.prompt ?? 0), itemStyle: { color: '#4c9aff' } },
                { name: 'completion', type: 'bar', stack: 't', data: (tokSeries?.series ?? []).map((p) => p.completion ?? 0), itemStyle: { color: '#3fb950' } },
              ],
            }}
          />
        </div>
      </div>

      <div className="panel">
        <h3>按模型请求占比</h3>
        {s.by_model.length === 0 ? (
          <div className="muted">暂无数据</div>
        ) : (
          <Chart
            height={240}
            option={{
              tooltip: { trigger: 'item', formatter: tooltipFmt((v) => `${fmtCount(v)} 次`) },
              legend: { orient: 'vertical', left: 10, textStyle: { color: '#8494a3' } },
              series: [
                {
                  type: 'pie',
                  radius: ['40%', '68%'],
                  center: ['60%', '50%'],
                  data: s.by_model.map((m) => ({ name: m.model, value: m.requests })),
                  label: { color: '#d7dee6', formatter: '{b}: {d}%' },
                },
              ],
            }}
          />
        )}
      </div>
    </div>
  );
}
