import { describe, expect, it, vi } from 'vitest';
import { createSseParser, runSse } from './sse';

describe('createSseParser', () => {
  it('parses events split across chunks and skips comments', () => {
    const parse = createSseParser();
    expect(parse('retry: 3000\n\nevent: status\nda')).toEqual([]);
    expect(parse('ta: {"a":1}\n\n: ping\n\nevent: done\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'status', data: '{"a":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('joins multi-line data and defaults the event name', () => {
    expect(createSseParser()('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

describe('runSse', () => {
  const stream = (text: string) =>
    new Response(new Blob([text]).stream(), { headers: { 'content-type': 'text/event-stream' } });

  function setup(responses: (Response | Error)[]) {
    const fetch = vi.fn(async () => {
      const next = responses.shift() ?? new Response(null, { status: 418 });
      if (next instanceof Error) throw next;
      return next;
    });
    const messages: string[] = [];
    const stops: number[] = [];
    const refreshSession = vi.fn(async () => undefined);
    const opts = {
      url: '/s',
      headers: async () => ({ authorization: 'Bearer t' }),
      onMessage: (m: { event: string }) => messages.push(m.event),
      shouldReconnect: () => true,
      refreshSession,
      onStop: (s: number) => stops.push(s),
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async () => undefined,
    };
    return { opts, fetch, messages, stops, refreshSession };
  }

  it('reconnects after the stream ends or the network fails', async () => {
    const t = setup([
      stream('event: status\ndata: 1\n\n'),
      new Error('offline'),
      stream('event: done\ndata: {}\n\n'),
    ]);
    await runSse(t.opts, new AbortController().signal);
    expect(t.messages).toEqual(['status', 'done']);
    expect(t.fetch).toHaveBeenCalledTimes(4); // the 4th gets the 418 below and stops
    expect(t.stops).toEqual([418]);
  });

  it('stops on 404 without reconnecting', async () => {
    const t = setup([new Response(null, { status: 404 })]);
    await runSse(t.opts, new AbortController().signal);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.stops).toEqual([404]);
  });

  it('refreshes the session once on 401, then gives up', async () => {
    const t = setup([new Response(null, { status: 401 }), new Response(null, { status: 401 })]);
    await runSse(t.opts, new AbortController().signal);
    expect(t.refreshSession).toHaveBeenCalledTimes(1);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.stops).toEqual([401]);
  });

  it('keeps retrying 5xx', async () => {
    const t = setup([new Response(null, { status: 503 }), new Response(null, { status: 404 })]);
    await runSse(t.opts, new AbortController().signal);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.stops).toEqual([404]);
  });
});
