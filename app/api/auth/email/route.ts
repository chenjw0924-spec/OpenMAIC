import { createLogger } from '@/lib/logger';
import { emailAuthEnabled } from '@/lib/server/auth/config';
import { issueEmailToken } from '@/lib/server/auth/db';
import { sendMagicLinkEmail } from '@/lib/server/auth/email';

export const runtime = 'nodejs';

const log = createLogger('Auth');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * `POST /api/auth/email` — send a magic-link sign-in email.
 *
 * Always answers `{ ok: true }` for a well-formed address, whether or not a
 * mail actually went out (resend cooldown): the answer must not reveal which
 * addresses are registered or throttled. A genuine send failure answers 502
 * so the login page can tell the user to retry — that leaks nothing about
 * the address, only about our own mailer.
 */
export async function POST(request: Request): Promise<Response> {
  if (!emailAuthEnabled()) {
    return json(503, { error: { code: 'EMAIL_AUTH_NOT_CONFIGURED' } });
  }
  let email: string;
  try {
    const body: unknown = await request.json();
    email =
      body && typeof body === 'object' && typeof (body as { email?: unknown }).email === 'string'
        ? (body as { email: string }).email.trim().toLowerCase()
        : '';
  } catch {
    return json(400, { error: { code: 'INVALID_REQUEST' } });
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return json(400, { error: { code: 'INVALID_EMAIL' } });
  }

  const issue = await issueEmailToken(email);
  if (issue.status === 'sent') {
    const url = new URL(request.url);
    const link = `${url.origin}/api/auth/verify?token=${encodeURIComponent(issue.token)}`;
    try {
      await sendMagicLinkEmail(email, link);
    } catch (error) {
      log.error(`magic link send to ${email} failed`, error);
      return json(502, { error: { code: 'EMAIL_SEND_FAILED' } });
    }
  }
  return json(200, { ok: true });
}