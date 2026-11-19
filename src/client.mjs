// Client identity for captures. A capture is bound to the client that created it; only that client may read it.
// 2.2.0 has one shared bearer token, so the client is derived from the token. 2.4.0 replaces the body of the
// resolver returned by makeResolveClient with a token -> client table; callers (resolveClient(request)) do not change.
// The raw token is never stored or logged: only an HMAC of it is kept.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const LABEL = 'crawlee-server client-id v1';
export const CLIENT_ID_RE = /^tok_[0-9a-f]{16}$/;

export const clientIdFromToken = token => 'tok_' + createHmac('sha256', LABEL).update(String(token)).digest('hex').slice(0, 16);

const digest = s => createHash('sha256').update(String(s)).digest();

// Bearer token from a request-like object ({ headers }), or null when absent or malformed.
export function bearerToken(request) {
  const h = request?.headers?.authorization;
  const m = typeof h === 'string' ? /^Bearer (\S+)$/.exec(h) : null;
  return m ? m[1] : null;
}

// -> resolveClient(request) -> client_id, or null when the request carries no valid token (fail closed).
export function makeResolveClient(serverToken) {
  const want = digest(serverToken);
  const id = clientIdFromToken(serverToken);
  return request => { const t = bearerToken(request); return t !== null && timingSafeEqual(digest(t), want) ? id : null; };
}

// True only when both ids are well-formed and equal. Constant-time; anything else (empty, wrong type, malformed) is false.
export function ownsCapture(clientId, meta) {
  const owner = meta?.client_id;
  if (typeof clientId !== 'string' || typeof owner !== 'string') return false;
  if (!CLIENT_ID_RE.test(clientId) || !CLIENT_ID_RE.test(owner)) return false;
  return timingSafeEqual(digest(clientId), digest(owner));
}
