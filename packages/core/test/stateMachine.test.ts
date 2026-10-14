import { describe, it, expect } from 'vitest';
import { transition } from '../src/backend/stateMachine.js';

describe('backend state machine', () => {
  it('正常生命周期 stopped→starting→ready→draining→stopped', () => {
    let s = transition('stopped', 'spawn');
    expect(s).toBe('starting');
    s = transition(s, 'health_ok');
    expect(s).toBe('ready');
    s = transition(s, 'stop');
    expect(s).toBe('draining');
    s = transition(s, 'drain_done');
    expect(s).toBe('stopped');
  });
  it('启动超时 → crashed → 退避重启', () => {
    expect(transition('starting', 'start_timeout')).toBe('crashed');
    expect(transition('crashed', 'crash_restart')).toBe('starting');
  });
  it('ready 进程意外退出 → crashed', () => {
    expect(transition('ready', 'process_exit')).toBe('crashed');
  });
  it('非法迁移抛错', () => {
    expect(() => transition('stopped', 'health_ok')).toThrow(/illegal/);
    expect(() => transition('ready', 'spawn')).toThrow(/illegal/);
    expect(() => transition('stopped', 'drain_done')).toThrow(/illegal/);
  });
});
