import { useState } from 'react';
import type { EChartsOption } from 'echarts';
import { api } from '../api';
import { useRange } from '../App';
import { usePoll } from '../refresh';
import { Chart, baseGrid, axisStyle } from '../components/Chart';

const METRICS: Array<[string, string]> = [
  ['requests', '请求量'],
  ['latency', '延迟'],
  ['ttft', 'TTFT'],
  ['pp', 'Prefill 速度'],
  ['tg', 'Decode 速度'],
  ['tokens', 'Token'],
  ['cache', '缓存'],
];

export function Trends() {
  const { from, to } = useRange();
  const [metric, setMetric] = useState('requests');
  const [model, setModel] = useState('');
  // 模型下拉：配置里的模型基本不变，60s 拉一次即可
  const { data: modelsData } = usePoll(() => api.models(), [], 60000);
  const { data } = usePoll(() => api.series(from, to, metric, undefined, model), [from, to, metric, model]);

  const pts = data?.series ?? [];
  const labels = pts.map((p) => new Date(p.bucket).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit' }));

  let option: EChartsOption;
  if (metric === 'latency' || metric === 'ttft' || metric === 'pp' || metric === 'tg') {
    const unit = metric === 'pp' || metric === 'tg' ? 'tok/s' : 'ms';
    option = {
      grid: baseGrid,
      tooltip: { trigger: 'axis' },
      legend: { textStyle: { color: '#8494a3' } },
      xAxis: { type: 'category', data: labels, ...axisStyle },
      yAxis: { type: 'value', name: unit, ...axisStyle },
      series: [
        { name: 'avg', type: 'line', smooth: true, data: pts.map((p) => p.avg), itemStyle: { color: '#4c9aff' } },
        { name: 'p95', type: 'line', smooth: true, data: pts.map((p) => p.p95), itemStyle: { color: '#d29922' } },
      ],
    };
  } else if (metric === 'tokens') {
    option = {
      grid: baseGrid,
      tooltip: { trigger: 'axis' },
      legend: { textStyle: { color: '#8494a3' } },
      xAxis: { type: 'category', data: labels, ...axisStyle },
      yAxis: { type: 'value', ...axisStyle },
      series: [
        { name: 'prompt', type: 'bar', stack: 't', data: pts.map((p) => p.prompt ?? 0), itemStyle: { color: '#4c9aff' } },
        { name: 'completion', type: 'bar', stack: 't', data: pts.map((p) => p.completion ?? 0), itemStyle: { color: '#3fb950' } },
      ],
    };
  } else if (metric === 'cache') {
    option = {
      grid: baseGrid,
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, ...axisStyle },
      yAxis: { type: 'value', name: '命中率', ...axisStyle },
      series: [{ name: '命中率', type: 'line', areaStyle: { opacity: 0.15 }, data: pts.map((p) => p.value ?? 0), itemStyle: { color: '#3fb950' } }],
    };
  } else {
    option = {
      grid: baseGrid,
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels, ...axisStyle },
      yAxis: { type: 'value', ...axisStyle },
      series: [{ name: '请求数', type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: pts.map((p) => p.value ?? 0), itemStyle: { color: '#4c9aff' } }],
    };
  }

  return (
    <div className="panel">
      <h3>
        趋势图表{' '}
        <span style={{ fontWeight: 400 }}>
          {METRICS.map(([m, label]) => (
            <button key={m} className={`btn ${metric === m ? '' : 'muted'}`} style={{ marginRight: 6, ...(metric === m ? { borderColor: 'var(--accent)' } : {}) }} onClick={() => setMetric(m)}>
              {label}
            </button>
          ))}
        </span>
      </h3>
      <div style={{ marginBottom: 8 }}>
        <select value={model} onChange={(e) => setModel(e.target.value)} title="按模型过滤（pp/tg 仅流式 chat 请求有数据）">
          <option value="">全部模型</option>
          {(modelsData?.models ?? [])
            .filter((m) => m.enabled)
            .map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
        </select>
      </div>
      <Chart option={option} height={380} />
    </div>
  );
}
