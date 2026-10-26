import { describe, expect, it } from 'vitest';
import {
  axisFmt,
  fmtBytes,
  fmtClock,
  fmtCount,
  fmtDateTime,
  fmtDuration,
  fmtInt,
  fmtMb,
  fmtNum,
  fmtPct,
  fmtPower,
  fmtRate,
  fmtRatio,
  fmtTemp,
  tooltipFmt,
} from '../src/format';

describe('fmtDuration', () => {
  it('亚秒用 ms，秒级保留小数，往上 m/h/d 进位', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(850)).toBe('850ms');
    expect(fmtDuration(999)).toBe('999ms');
    expect(fmtDuration(1000)).toBe('1s');
    expect(fmtDuration(1234)).toBe('1.23s');
    expect(fmtDuration(9_640)).toBe('9.64s');
    expect(fmtDuration(12_345)).toBe('12.3s');
    expect(fmtDuration(59_000)).toBe('59s');
    expect(fmtDuration(95_000)).toBe('1m35s');
    expect(fmtDuration(600_000)).toBe('10m00s');
    expect(fmtDuration(7_260_000)).toBe('2h01m');
    expect(fmtDuration(90_000_000)).toBe('1d01h');
  });
  it('空值渲染成占位符，负值带符号', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtDuration(-1500)).toBe('-1.5s');
  });
});

describe('fmtCount', () => {
  it('万以下保留精确值，往上 k/M/B', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(1234)).toBe('1,234');
    expect(fmtCount(9_999)).toBe('9,999');
    expect(fmtCount(12_345)).toBe('12.3k');
    expect(fmtCount(1_000_000)).toBe('1M');
    expect(fmtCount(3_456_789)).toBe('3.46M');
    expect(fmtCount(2_500_000_000)).toBe('2.5B');
    expect(fmtCount(null)).toBe('—');
  });
  it('小数按量级给有效位数', () => {
    expect(fmtCount(1.234)).toBe('1.2');
    expect(fmtCount(12.5)).toBe('12.5');
    expect(fmtCount(1234.5)).toBe('1,234.5');
  });
});

describe('单位类格式化', () => {
  it('速率带单位', () => {
    expect(fmtRate(123.4)).toBe('123.4 t/s');
    expect(fmtRate(23456)).toBe('23.5k t/s');
    expect(fmtRate(null)).toBe('—');
  });
  it('比率与百分数', () => {
    expect(fmtRatio(0.9846)).toBe('98.5%');
    expect(fmtRatio(0)).toBe('0%');
    expect(fmtRatio(null)).toBe('—');
    expect(fmtPct(42.53)).toBe('42.5%');
  });
  it('字节与内存按 1024 进位', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(fmtMb(512)).toBe('512 MB');
    expect(fmtMb(2048)).toBe('2 GB');
    expect(fmtMb(1536)).toBe('1.5 GB');
  });
  it('频率、温度、功耗', () => {
    expect(fmtClock(800)).toBe('800 MHz');
    expect(fmtClock(2400)).toBe('2.4 GHz');
    expect(fmtTemp(56.78)).toBe('56.8°C');
    expect(fmtPower(123.44)).toBe('123.4 W');
  });
  it('通用数值与整数', () => {
    expect(fmtInt(12345)).toBe('12,345');
    expect(fmtNum(1.234567)).toBe('1.23');
    expect(fmtNum(1234.56)).toBe('1,234.6');
  });
  it('时间戳可读化', () => {
    expect(fmtDateTime(new Date(2026, 9, 25, 10, 7, 36).getTime())).toContain('2026/10/25');
  });
});

describe('ECharts 格式化器', () => {
  it('坐标轴标签带单位', () => {
    expect(axisFmt(fmtDuration)(1234)).toBe('1.23s');
    expect(axisFmt(fmtCount)('12345')).toBe('12.3k');
  });
  it('axis tooltip 逐行列出各系列', () => {
    const out = tooltipFmt(fmtDuration)([
      { axisValueLabel: '10/25 14:00', seriesName: 'avg', value: 1234, marker: '●' },
      { axisValueLabel: '10/25 14:00', seriesName: 'p95', value: 5000, marker: '○' },
    ]);
    expect(out).toBe('10/25 14:00<br/>● avg: 1.23s<br/>○ p95: 5s');
  });
  it('item tooltip 用名称并保留占比', () => {
    const out = tooltipFmt(fmtCount)({ name: 'qwen', value: 12345, percent: 63.24, marker: '●' });
    expect(out).toBe('● qwen: 12.3k (63.2%)');
  });
});
