import type { GithubOAuthConfig } from './config';

/**
 * GitHub OAuth (web application flow), plain fetch, no SDK.
 *
 * - authorizeUrl sends the browser to GitHub with our client id, the
 *   callback and a CSRF state (kept in a short-lived cookie by the route).
 * - exchangeCode trades the callback's code for an access token.
 * - fetchGithubProfile reads the user; `read:user user:email` scope covers
 *   the profile plus the verified-email endpoint.
 */

export function githubAuthorizeUrl(
  config: GithubOAuthConfig,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'read:user user:email',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export class GithubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GithubOAuthError';
  }
}

async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenMAIC',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new GithubOAuthError(`GitHub answered ${response.status} for ${url}`);
  }
  return response;
}

export async function exchangeGithubCode(
  config: GithubOAuthConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new GithubOAuthError(`token exchange answered ${response.status}`);
  }
  const body: unknown = await response.json();
  const token =
    body && typeof body === 'object'
      ? (body as { access_token?: unknown }).access_token
      : undefined;
  if (typeof token !== 'string' || !token) {
    const description =
      body && typeof body === 'object'
        ? (body as { error_description?: unknown }).error_description
        : undefined;
    throw new GithubOAuthError(
      typeof description === 'string' ? description : 'token exchange returned no access token',
    );
  }
  return token;
}

export interface GithubProfile {
  /** The numeric GitHub user id, as a string: the stable external account key. */
  readonly githubId: string;
  /** Primary verified email, or null when the account has none. */
  readonly email: string | null;
  readonly name: string | null;
  readonly image: string | null;
}

export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const userResponse = await githubFetch('https://api.github.com/user', { headers: auth });
  const user: unknown = await userResponse.json();
  if (!user || typeof user !== 'object') throw new GithubOAuthError('malformed /user payload');
  const { id, login, name, avatar_url: avatarUrl, email } = user as Record<string, unknown>;
  if (typeof id !== 'number') throw new GithubOAuthError('/user payload has no numeric id');

  // The profile email is only present when the user made it public, so fall
  // back to the emails endpoint and take the primary verified one.
  let verifiedEmail = typeof email === 'string' && email ? email : null;
  if (!verifiedEmail) {
    const emailsResponse = await githubFetch('https://api.github.com/user/emails', {
      headers: auth,
    });
    const emails: unknown = await emailsResponse.json();
    if (Array.isArray(emails)) {
      const primary = emails.find(
        (entry): entry is { email: string; primary: boolean; verified: boolean } =>
          !!entry &&
          typeof entry === 'object' &&
          (entry as { primary?: unknown }).primary === true &&
          (entry as { verified?: unknown }).verified === true &&
          typeof (entry as { email?: unknown }).email === 'string',
      );
      verifiedEmail = primary?.email ?? null;
    }
  }

  return {
    githubId: String(id),
    email: verifiedEmail,
    name: typeof name === 'string' && name ? name : typeof login === 'string' ? login : null,
    image: typeof avatarUrl === 'string' ? avatarUrl : null,
  };
}