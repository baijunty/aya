import { api } from '../api';
import { useRange } from '../App';
import { usePoll } from '../refresh';
import { Chart, baseGrid, axisStyle } from '../components/Chart';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n * 100) / 100);
}

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
        <div className="card">
          <div className="label">请求总数</div>
          <div className="value">{fmt(s.requests.total)}</div>
        </div>
        <div className="card">
          <div className="label">Token 总量</div>
          <div className="value">{fmt(s.tokens.total)}</div>
        </div>
        <div className="card">
          <div className="label">平均延迟</div>
          <div className="value">
            {fmt(s.latency_ms.avg)} <small>ms</small>
          </div>
        </div>
        <div className="card">
          <div className="label">P95 TTFT</div>
          <div className="value">
            {fmt(s.ttft_ms.p95)} <small>ms</small>
          </div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: s.requests.success_rate < 0.95 ? 'var(--red)' : 'var(--green)' }}>
            {((1 - s.requests.success_rate) * 100).toFixed(1)}%
          </div>
        </div>
        <div className="card">
          <div className="label">缓存命中率</div>
          <div className="value">{(s.cache_hit_rate * 100).toFixed(1)}%</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>请求量趋势</h3>
          <Chart
            option={{
              grid: baseGrid,
              tooltip: { trigger: 'axis' },
              xAxis: { type: 'category', data: (reqSeries?.series ?? []).map((p) => new Date(p.bucket).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit' })), ...axisStyle },
              yAxis: { type: 'value', ...axisStyle },
              series: [{ type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: (reqSeries?.series ?? []).map((p) => p.value ?? 0), itemStyle: { color: '#4c9aff' } }],
            }}
          />
        </div>
        <div className="panel">
          <h3>Token 用量（prompt vs completion）</h3>
          <Chart
            option={{
              grid: baseGrid,
              tooltip: { trigger: 'axis' },
              legend: { textStyle: { color: '#8494a3' } },
              xAxis: { type: 'category', data: (tokSeries?.series ?? []).map((p) => new Date(p.bucket).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit' })), ...axisStyle },
              yAxis: { type: 'value', ...axisStyle },
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
              tooltip: { trigger: 'item' },
              legend: { orient: 'vertical', left: 10, textStyle: { color: '#8494a3' } },
              series: [
                {
                  type: 'pie',
                  radius: ['40%', '68%'],
                  center: ['60%', '50%'],
                  data: s.by_model.map((m) => ({ name: m.model, value: m.requests })),
                  label: { color: '#d7dee6' },
                },
              ],
            }}
          />
        )}
      </div>
    </div>
  );
}
