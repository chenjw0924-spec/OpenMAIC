import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { subscribe } from 'node:diagnostics_channel';

import { createLogger } from '@/lib/logger';

const log = createLogger('LLM Request Diagnostics');

interface RequestTrace {
  id: string;
  startedAt: number;
  lastProgressAt: number;
  phase: string;
  responseBytes: number;
  timer?: ReturnType<typeof setInterval>;
}

const context = new AsyncLocalStorage<RequestTrace>();
// Match events by the actual undici request, including on reused sockets and
// concurrent calls. Connection-level async context can belong to an older call.
const traces = new WeakMap<object, RequestTrace>();

function emit(trace: RequestTrace, event: string, details: Record<string, unknown> = {}) {
  log.info({
    event,
    traceId: trace.id,
    phase: trace.phase,
    elapsedMs: Date.now() - trace.startedAt,
    ...details,
  });
}

function finish(trace: RequestTrace) {
  clearInterval(trace.timer);
  trace.timer = undefined;
}

function errorCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? error.name
    : 'UNKNOWN';
}

interface TransportEvent {
  request?: object;
  response?: { statusCode?: number };
  chunk?: Uint8Array;
  error?: unknown;
}

function observe(name: string, handler: (message: TransportEvent) => void) {
  subscribe(name, (message) => {
    // Diagnostic subscribers must never throw into undici or alter a request.
    try {
      handler(message as TransportEvent);
    } catch {
      // Losing a diagnostic record is preferable to failing generation.
    }
  });
}

observe('undici:request:create', ({ request }) => {
  const trace = context.getStore();
  if (!trace || !request) return;
  traces.set(request, trace);
  trace.phase = 'connect_or_queue';
  emit(trace, 'request_created');
});

observe('undici:client:sendHeaders', ({ request }) => {
  const trace = request && traces.get(request);
  if (!trace) return;
  trace.phase = 'sending_request';
  trace.lastProgressAt = Date.now();
  emit(trace, 'request_sent');
});

observe('undici:request:bodySent', ({ request }) => {
  const trace = request && traces.get(request);
  if (!trace) return;
  trace.phase = 'waiting_headers';
  trace.lastProgressAt = Date.now();
  emit(trace, 'request_body_sent');
});

observe('undici:request:headers', ({ request, response }) => {
  const trace = request && traces.get(request);
  if (!trace) return;
  trace.phase = 'reading_body';
  trace.lastProgressAt = Date.now();
  emit(trace, 'response_headers', { status: response?.statusCode });
});

observe('undici:request:bodyChunkReceived', ({ request, chunk }) => {
  const trace = request && traces.get(request);
  if (!trace || !chunk?.byteLength) return;
  const first = trace.responseBytes === 0;
  trace.responseBytes += chunk.byteLength;
  trace.lastProgressAt = Date.now();
  if (first) emit(trace, 'response_first_byte', { responseBytes: trace.responseBytes });
});

observe('undici:request:trailers', ({ request }) => {
  const trace = request && traces.get(request);
  if (!trace) return;
  trace.phase = 'complete';
  emit(trace, 'response_complete', { responseBytes: trace.responseBytes });
  finish(trace);
  traces.delete(request!);
});

observe('undici:request:error', ({ request, error }) => {
  const trace = request && traces.get(request);
  if (!trace) return;
  emit(trace, 'transport_error', { code: errorCode(error), responseBytes: trace.responseBytes });
  finish(trace);
  traces.delete(request!);
});

function requestSummary(input: RequestInfo | URL, init?: RequestInit) {
  const summary: Record<string, unknown> = {};
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // No credentials, URL queries, arbitrary paths, headers or request content.
    summary.host = url.hostname;
    summary.api = url.pathname.endsWith('/chat/completions')
      ? 'chat-completions'
      : url.pathname.endsWith('/responses')
        ? 'responses'
        : 'other';
  } catch {
    summary.host = 'invalid';
  }
  if (typeof init?.body !== 'string') return summary;
  summary.requestBytes = Buffer.byteLength(init.body);
  try {
    const body = JSON.parse(init.body);
    if (!body || typeof body !== 'object') return summary;
    summary.model =
      typeof body.model === 'string' && /^[\w.\-:/]{1,120}$/.test(body.model)
        ? body.model
        : 'unknown';
    summary.stream = body.stream === true;
    summary.reasoningEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
      body.reasoning_effort,
    )
      ? body.reasoning_effort
      : 'provider-default';
    summary.thinkingMode = ['auto', 'enabled', 'disabled'].includes(body.thinking?.type)
      ? body.thinking.type
      : 'provider-default';
    const maxTokens = body.max_completion_tokens ?? body.max_tokens;
    summary.maxOutputTokens =
      typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? maxTokens : 'provider-default';
  } catch {
    // Non-JSON bodies still get network phase diagnostics.
  }
  return summary;
}

/** Observe the real transport without consuming, buffering or rewriting its response. */
export function withLlmRequestDiagnostics(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  const now = Date.now();
  const trace: RequestTrace = {
    id: randomUUID(),
    startedAt: now,
    lastProgressAt: now,
    phase: 'dispatch',
    responseBytes: 0,
  };
  emit(trace, 'start', requestSummary(input, init));
  trace.timer = setInterval(() => {
    emit(trace, 'waiting', {
      idleMs: Date.now() - trace.lastProgressAt,
      responseBytes: trace.responseBytes,
    });
  }, 60_000);
  trace.timer.unref?.();

  return context.run(trace, async () => {
    try {
      const response = await send();
      const requestId = response.headers.get('x-request-id');
      const contentType = response.headers.get('content-type') ?? '';
      emit(trace, 'fetch_returned', {
        status: response.status,
        contentType: contentType.includes('text/event-stream')
          ? 'event-stream'
          : contentType.includes('application/json')
            ? 'json'
            : 'other',
        ...(requestId && /^[\w-]{1,100}$/.test(requestId) ? { providerRequestId: requestId } : {}),
      });
      // If a substituted/test transport does not publish undici diagnostics,
      // do not retain a timer after fetch returns. Native undici clears it on
      // response completion/error, including failures while reading the body.
      if (trace.phase === 'dispatch') {
        finish(trace);
      }
      return response;
    } catch (error) {
      emit(trace, 'fetch_failed', { code: errorCode(error) });
      finish(trace);
      throw error;
    }
  });
}
