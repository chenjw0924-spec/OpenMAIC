import { describe, expect, it } from 'vitest';

describe('llmApiError', () => {
  it('returns a retryable 504 with a clear message for upstream timeouts', async () => {
    const { llmApiError } = await import('@/lib/server/llm-error-response');
    const response = llmApiError(new DOMException('request deadline exceeded', 'TimeoutError'));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'GENERATION_TIMEOUT',
      error: expect.stringContaining('生成超时'),
    });
  });

  it('preserves upstream status handling for non-timeout errors', async () => {
    const { llmApiError } = await import('@/lib/server/llm-error-response');
    const response = llmApiError({ statusCode: 429 });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'RATE_LIMITED',
    });
  });
});
