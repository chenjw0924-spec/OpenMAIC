import type { OwnerAuthRequest, OwnerPrincipal } from '@/lib/server/identity/types';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export function withClassroomJobOwner(
  req: OwnerAuthRequest,
  handler: (principal: OwnerPrincipal) => Promise<Response>,
): Promise<Response> {
  return withRequestOwner(req, async (principal, responseHeaders) => {
    const response = await handler(principal);
    for (const [name, value] of responseHeaders) response.headers.append(name, value);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  });
}
