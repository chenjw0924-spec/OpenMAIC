/**
 * Account configuration from the environment.
 *
 * The whole account feature is opt-in: without AUTH_SECRET no auth method is
 * registered (instrumentation.ts) and the deployment keeps the identity its
 * environment selects. The email and GitHub sign-in providers each need their
 * own settings on top; /api/auth/session reports which are live so the login
 * page can hide the rest.
 */

export const SESSION_COOKIE = 'openmaic_session';
/** 30 days, renewed on use once half of it has passed (lib/server/identity/host/session.ts). */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const OAUTH_STATE_COOKIE = 'openmaic_oauth_state';
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Magic links stay valid for 15 minutes and are single-use. */
export const EMAIL_TOKEN_TTL_MS = 15 * 60 * 1000;
/** One magic link per email per minute; repeat requests inside the window are silently dropped. */
export const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;

/** The HMAC key for session cookies and OAuth state. Auth is off without it. */
export function authSecret(): string | undefined {
  const value = process.env.AUTH_SECRET?.trim();
  return value || undefined;
}

/** Same convention as the anonymous owner cookie: Secure in production, COOKIE_SECURE=0 opts out. */
export function authCookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  /** Display name on the From header. */
  readonly fromName: string;
}

/**
 * SMTP settings for magic-link email, or undefined when not configured.
 * Port 465 means implicit TLS; any other port (usually 587) starts plain and
 * upgrades with STARTTLS.
 */
export function smtpConfig(): SmtpConfig | undefined {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return undefined;
  const portRaw = process.env.SMTP_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 465;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return {
    host,
    port,
    user,
    pass,
    from: process.env.SMTP_FROM?.trim() || user,
    fromName: process.env.SMTP_FROM_NAME?.trim() || 'OpenMAIC',
  };
}

export interface GithubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function githubOAuthConfig(): GithubOAuthConfig | undefined {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/** Whether the email sign-in provider can actually send mail. */
export function emailAuthEnabled(): boolean {
  return authSecret() !== undefined && smtpConfig() !== undefined;
}

export function githubAuthEnabled(): boolean {
  return authSecret() !== undefined && githubOAuthConfig() !== undefined;
}
