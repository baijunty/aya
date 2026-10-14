import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export function Chart({ option, height = 260 }: { option: echarts.EChartsOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts>();

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ height, width: '100%' }} />;
}

export const baseGrid = { left: 48, right: 20, top: 30, bottom: 28 };
export const axisStyle = {
  axisLine: { lineStyle: { color: '#2d3944' } },
  axisLabel: { color: '#8494a3' },
  splitLine: { lineStyle: { color: '#212b36' } },
};
