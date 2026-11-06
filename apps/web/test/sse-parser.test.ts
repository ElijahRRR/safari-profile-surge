import { describe, expect, it } from 'vitest';
import { SseParser, type SseMessage } from '../src/api/sse';

function collect() {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = new SseParser({ onMessage: (m) => messages.push(m), onComment: (c) => comments.push(c), onRetry: (r) => retries.push(r) });
  return { parser, messages, comments, retries };
}

const enc = new TextEncoder();

describe('SseParser', () => {
  it('parses id, event and data fields', () => {
    const { parser, messages } = collect();
    parser.pushText('id: 7\nevent: route.updated\ndata: {"a":1}\n\n');
    expect(messages).toEqual([{ event: 'route.updated', data: '{"a":1}', id: '7' }]);
  });

  it('defaults the event name to message and joins multiple data lines', () => {
    const { parser, messages } = collect();
    parser.pushText('data: one\ndata: two\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'one\ntwo', id: '' }]);
  });

  it('handles any chunk boundary, including inside field names', () => {
    const text = 'id: 12\nevent: x\ndata: {"sequence":12}\n\nid: 13\ndata: {"sequence":13}\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      const { parser, messages } = collect();
      parser.pushText(text.slice(0, cut));
      parser.pushText(text.slice(cut));
      expect(messages.map((m) => m.id)).toEqual(['12', '13']);
      expect(messages[1]?.data).toBe('{"sequence":13}');
    }
  });

  it('handles CRLF split across chunks without producing an extra blank line', () => {
    const { parser, messages } = collect();
    parser.pushText('data: a\r');
    parser.pushText('\ndata: b\r\n\r');
    parser.pushText('\n');
    expect(messages).toEqual([{ event: 'message', data: 'a\nb', id: '' }]);
  });

  it('accepts bare CR line endings', () => {
    const { parser, messages } = collect();
    parser.pushText('data: x\r\rdata: y\r\r');
    expect(messages.map((m) => m.data)).toEqual(['x', 'y']);
  });

  it('decodes multi-byte UTF-8 split between chunks', () => {
    const { parser, messages } = collect();
    const bytes = enc.encode('data: {"m":"环境已切换"}\n\n');
    for (let i = 0; i < bytes.length; i++) parser.pushBytes(bytes.subarray(i, i + 1));
    expect(messages[0]?.data).toBe('{"m":"环境已切换"}');
  });

  it('ignores comments (heartbeats) and reports them separately', () => {
    const { parser, messages, comments } = collect();
    parser.pushText(': heartbeat\n\n:\ndata: z\n\n');
    expect(comments).toEqual(['heartbeat', '']);
    expect(messages).toHaveLength(1);
  });

  it('keeps the last event id across events and ignores ids with NUL', () => {
    const { parser, messages } = collect();
    parser.pushText('id: 5\ndata: a\n\ndata: b\n\nid: 6\u0000\ndata: c\n\n');
    expect(messages.map((m) => m.id)).toEqual(['5', '5', '5']);
    expect(parser.lastEventId).toBe('5');
  });

  it('does not dispatch events without data but still records the id', () => {
    const { parser, messages } = collect();
    parser.pushText('id: 9\nevent: ping\n\n');
    expect(messages).toHaveLength(0);
    expect(parser.lastEventId).toBe('9');
  });

  it('parses retry and ignores invalid retry values', () => {
    const { parser, retries } = collect();
    parser.pushText('retry: 3000\nretry: 3s\n\n');
    expect(retries).toEqual([3000]);
  });

  it('strips one leading space only and supports fields without a colon', () => {
    const { parser, messages } = collect();
    parser.pushText('data:  two spaces\ndata\n\n');
    expect(messages[0]?.data).toBe(' two spaces\n');
  });

  it('strips a UTF-8 BOM at the start of the stream', () => {
    const { parser, messages } = collect();
    parser.pushText('\ufeffdata: x\n\n');
    expect(messages[0]?.data).toBe('x');
  });

  it('discards an unterminated event at end of stream', () => {
    const { parser, messages } = collect();
    parser.pushText('data: partial');
    parser.end();
    expect(messages).toHaveLength(0);
  });
});
