import { fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withLlmRequestDiagnostics } from '@/lib/server/llm-request-diagnostics';
import { closeLoopbackServers, startLoopback } from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: mocks.info }),
}));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function records() {
  return mocks.info.mock.calls.map(([record]) => record as Record<string, unknown>);
}

function send(url: string, model: string, signal?: AbortSignal) {
  const init: RequestInit = {
    method: 'POST',
    headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'private-course-material' }],
      reasoning_effort: 'medium',
      max_tokens: 4000,
    }),
    signal,
  };
  return withLlmRequestDiagnostics(
    url,
    init,
    async () =>
      (await undiciFetch(url, init as Parameters<typeof undiciFetch>[1])) as unknown as Response,
  );
}

afterEach(async () => {
  vi.useRealTimers();
  await closeLoopbackServers();
  mocks.info.mockClear();
});

describe('LLM transport phase diagnostics', () => {
  it('distinguishes a sent request waiting for headers, while redacting secrets and content', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const received = gate();
    const release = gate();
    const server = await startLoopback((_req, res) => {
      received.resolve();
      void release.promise.then(() => res.end('private-model-output'));
    });
    const pending = send(`${server.origin}/secret-path/chat/completions?key=secret-query`, 'pro');
    await received.promise;
    expect(records().some((r) => r.event === 'request_body_sent')).toBe(true);
    expect(records().some((r) => r.event === 'response_headers')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records()).toContainEqual(
      expect.objectContaining({ event: 'waiting', phase: 'waiting_headers', responseBytes: 0 }),
    );
    release.resolve();
    expect(await (await pending).text()).toBe('private-model-output');
    const start = records().find((r) => r.event === 'start');
    expect(start).toMatchObject({
      model: 'pro',
      api: 'chat-completions',
      stream: false,
      reasoningEffort: 'medium',
      maxOutputTokens: 4000,
    });
    const serialized = JSON.stringify(records());
    for (const secret of [
      'secret-key',
      'secret-query',
      'secret-path',
      'private-course-material',
      'private-model-output',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes a body stall after headers and the first response byte without buffering', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const release = gate();
    const server = await startLoopback((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-request-id': 'ark-request-123',
      });
      res.write('first');
      void release.promise.then(() => res.end('last'));
    });
    const response = await send(`${server.origin}/chat/completions`, 'pro');
    expect(records()).toContainEqual(
      expect.objectContaining({
        event: 'fetch_returned',
        contentType: 'event-stream',
        providerRequestId: 'ark-request-123',
      }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    expect(records()).toContainEqual(
      expect.objectContaining({ event: 'response_first_byte', responseBytes: 5 }),
    );
    expect(records().some((r) => r.event === 'response_complete')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records()).toContainEqual(
      expect.objectContaining({ event: 'waiting', phase: 'reading_body', responseBytes: 5 }),
    );
    release.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
    expect((await reader.read()).done).toBe(true);
    expect(records()).toContainEqual(
      expect.objectContaining({ event: 'response_complete', responseBytes: 9 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps concurrent calls in distinct traces even when they finish out of order', async () => {
    const slowReceived = gate();
    const releaseSlow = gate();
    const server = await startLoopback((_req, res, body) => {
      if (JSON.parse(body.toString()).model === 'slow') {
        slowReceived.resolve();
        void releaseSlow.promise.then(() => res.end('slow'));
      } else {
        res.end('fast');
      }
    });
    const url = `${server.origin}/chat/completions`;
    const slow = send(url, 'slow');
    await slowReceived.promise;
    expect(await (await send(url, 'fast')).text()).toBe('fast');
    const starts = records().filter((r) => r.event === 'start');
    expect(starts).toHaveLength(2);
    const slowId = starts.find((r) => r.model === 'slow')!.traceId;
    const fastId = starts.find((r) => r.model === 'fast')!.traceId;
    expect(slowId).not.toBe(fastId);
    expect(
      records()
        .filter((r) => r.event === 'response_complete')
        .map((r) => r.traceId),
    ).toEqual([fastId]);
    releaseSlow.resolve();
    expect(await (await slow).text()).toBe('slow');
    expect(
      records()
        .filter((r) => r.event === 'response_complete')
        .map((r) => r.traceId),
    ).toEqual([fastId, slowId]);
  });

  it('records the failed phase and clears progress timers when a waiting request is aborted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const received = gate();
    const server = await startLoopback(() => received.resolve());
    const controller = new AbortController();
    const pending = send(`${server.origin}/chat/completions`, 'pro', controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await received.promise;
    controller.abort();
    await rejected;
    expect(records()).toContainEqual(
      expect.objectContaining({ event: 'transport_error', phase: 'waiting_headers' }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns an unchanged response and clears timers when a replacement fetch has no transport events', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const response = new Response('unchanged');
    expect(
      await withLlmRequestDiagnostics(
        'https://user:password@example.com/private?key=secret',
        undefined,
        async () => response,
      ),
    ).toBe(response);
    expect(JSON.stringify(records())).not.toMatch(/password|private|secret/);
    expect(vi.getTimerCount()).toBe(0);
  });
});
