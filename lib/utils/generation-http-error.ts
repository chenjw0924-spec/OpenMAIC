export function generationHttpErrorMessage(
  status: number,
  raw: string,
  messages: { failed: string; timeout: string },
): string {
  if (status === 504 || /timeout|timed out|function_invocation_timeout|300 seconds/i.test(raw)) {
    return messages.timeout;
  }
  try {
    const data: unknown = JSON.parse(raw);
    if (
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string' &&
      data.error.trim()
    ) {
      return data.error;
    }
  } catch {
    // Platform failures may be plain text or HTML, not an API JSON response.
  }
  return messages.failed;
}
