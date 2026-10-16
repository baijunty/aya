import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { scanHeadFields, peekRequest } from '../src/proxy/peek.js';

const scan = (s: string) => scanHeadFields(Buffer.from(s, 'utf8'));

describe('scanHeadFields（JSON 前缀字节级扫描）', () => {
  it('model 在最前（OpenAI 请求常见形态）', () => {
    expect(scan('{"model":"gpt-4o","messages":[]}')).toEqual({ model: 'gpt-4o' });
  });

  it('model 在 stream 之后也能拿到，stream 一并识别', () => {
    expect(scan('{"stream":true,"model":"m1"}')).toEqual({ model: 'm1', stream: true });
    expect(scan('{"model":"m1","stream":true}')).toEqual({ model: 'm1', stream: true });
    expect(scan('{"stream":false,"model":"m1"}')).toEqual({ model: 'm1', stream: false });
  });

  it('键与冒号/值之间的空白', () => {
    expect(scan('{ "model" : "m1" , "stream" : true }')).toEqual({ model: 'm1', stream: true });
  });

  it('嵌套对象/数组里的 "model" 不误中', () => {
    expect(scan('{"a":{"model":"inner"},"model":"real"}')).toEqual({ model: 'real' });
    expect(scan('{"messages":[{"role":"user","content":"model\":\"evil"}],"model":"real"}')).toEqual({
      model: 'real',
    });
  });

  it('字符串值里的结构字符/转义不破坏状态机', () => {
    expect(scan('{"note":"},{\\"model\\":\\"fake\\"}","model":"real"}')).toEqual({ model: 'real' });
  });

  it('model 为 null / 非字符串 → 不提取', () => {
    expect(scan('{"model":null}')).toEqual({});
    expect(scan('{"model":{"x":1}}')).toEqual({});
  });

  it('截断前缀：model 值已闭合即返回', () => {
    expect(scan('{"model":"m1","messages":[{"content":"abc')).toEqual({ model: 'm1' });
  });

  it('截断在 model 值中间 → 不误报', () => {
    expect(scan('{"model":"m1')).toEqual({});
    expect(scan('{"model":"m')).toEqual({});
  });

  it('UTF-8 多字节内容不干扰', () => {
    expect(scan('{"messages":[{"content":"你好世界，模型名在中文里不会出现"}],"model":"m1"}')).toEqual({
      model: 'm1',
    });
  });

  it('无 model 的前缀返回空', () => {
    expect(scan('{"messages":[{"role":"user"}')).toEqual({});
  });
});

async function collect(r: NodeJS.ReadableStream): Promise<number> {
  let n = 0;
  for await (const c of r) n += (c as Buffer).length;
  return n;
}

describe('peekRequest（JSON）', () => {
  it('请求体 > PEEK_MAX(256KB)：整体 parse 不可能成功，靠前缀扫描拿到 model 且流完整', async () => {
    const big = 'x'.repeat(300 * 1024);
    const body = JSON.stringify({ model: 'big-model', messages: [{ role: 'user', content: big }] });
    const raw = Readable.from(Buffer.from(body, 'utf8'));
    const peeked = await peekRequest(raw, 'application/json');
    expect(peeked.model).toBe('big-model');
    expect(await collect(peeked.body)).toBe(Buffer.byteLength(body));
  });

  it('大请求体分小块喂入（模拟 TCP 分块边界）也能拿到 model', async () => {
    const big = 'x'.repeat(300 * 1024);
    const body = Buffer.from(JSON.stringify({ model: 'big-model', stream: true, messages: [{ role: 'user', content: big }] }), 'utf8');
    // 故意用与 model 字段错位的小块
    const raw = Readable.from((function* () {
      for (let i = 0; i < body.length; i += 4093) yield body.subarray(i, i + 4093);
    })());
    const peeked = await peekRequest(raw, 'application/json');
    expect(peeked.model).toBe('big-model');
    expect(peeked.stream).toBe(true);
    expect(await collect(peeked.body)).toBe(body.length);
  });

  it('小请求体走整体 parse（fields 摘要可用）', async () => {
    const body = JSON.stringify({ model: 'm', messages: [1, 2, 3], max_tokens: 10 });
    const peeked = await peekRequest(Readable.from(Buffer.from(body)), 'application/json');
    expect(peeked.model).toBe('m');
    expect(peeked.fields).toMatchObject({ max_tokens: 10, messages_count: 3 });
  });

  it('缺 model 的小请求体 → model undefined（路由层报 missing_model）', async () => {
    const peeked = await peekRequest(Readable.from(Buffer.from('{"messages":[]}')), 'application/json');
    expect(peeked.model).toBeUndefined();
  });
});
