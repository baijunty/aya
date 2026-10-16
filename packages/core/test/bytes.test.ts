import { describe, it, expect } from 'vitest';
import { parseByteSize } from '../src/index.js';

describe('parseByteSize', () => {
  it('接受带单位的写法', () => {
    expect(parseByteSize('512kb')).toBe(512 * 1024);
    expect(parseByteSize('20MB')).toBe(20 * 1024 * 1024);
    expect(parseByteSize('1.5 gb')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseByteSize('100b')).toBe(100);
    expect(parseByteSize('1tb')).toBe(1024 ** 4);
  });

  it('纯数字按字节，字符串数字同样接受', () => {
    expect(parseByteSize(8192)).toBe(8192);
    expect(parseByteSize('8192')).toBe(8192);
    expect(parseByteSize(0)).toBe(0);
  });

  it('非法写法报错并给出示例', () => {
    for (const bad of ['abc', '20xb', '-5mb', -1, '1.2.3kb', '']) {
      expect(() => parseByteSize(bad as string | number)).toThrow(/invalid byte size/);
    }
  });
});
