import { describe, expect, it } from 'vitest';
import { generationHttpErrorMessage } from '@/lib/utils/generation-http-error';

const messages = { failed: 'Generation failed', timeout: 'Generation timed out' };

describe('generation HTTP errors', () => {
  it('handles the plain-text Vercel timeout without a JSON parse failure', () => {
    expect(
      generationHttpErrorMessage(504, 'An error occurred with your deployment', messages),
    ).toBe(messages.timeout);
    expect(generationHttpErrorMessage(500, 'FUNCTION_INVOCATION_TIMEOUT', messages)).toBe(
      messages.timeout,
    );
  });
  it('preserves API JSON errors', () => {
    expect(generationHttpErrorMessage(401, '{"error":"Unauthorized"}', messages)).toBe(
      'Unauthorized',
    );
  });
  it.each(['An error occurred', '<html>Error</html>', 'null', '[]', '{"error":123}'])(
    'handles unexpected error bodies: %s',
    (raw) => {
      expect(generationHttpErrorMessage(500, raw, messages)).toBe(messages.failed);
    },
  );
});
