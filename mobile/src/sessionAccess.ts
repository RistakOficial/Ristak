import type { RistakUser } from './types';

export type VerifiedUserCacheRecord = {
  namespace: string;
  verifiedAt: number;
  user: RistakUser;
};

function normalizeBaseUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

// SecureStore keys/values must never expose the bearer token. Two independent
// 32-bit hashes keep this namespace compact and make an accidental collision
// between operators on the same installation extremely unlikely.
function hashNamespacePart(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function getSessionCacheNamespace(baseUrl: string, token: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedToken = String(token || '').trim();
  if (!normalizedBaseUrl || !normalizedToken) return '';
  return `session-${hashNamespacePart(normalizedBaseUrl)}-${hashNamespacePart(normalizedToken)}`;
}

// Kept as the public ACL-cache name for backwards compatibility. Both the
// verified user and the offline data cache must use the exact same session
// boundary so two operators on one Ristak server can never share local data.
export function getVerifiedUserCacheNamespace(baseUrl: string, token: string) {
  return getSessionCacheNamespace(baseUrl, token);
}

export function isCurrentSessionCacheNamespace(
  expectedNamespace: string,
  baseUrl: string,
  token: string,
) {
  const expected = String(expectedNamespace || '').trim();
  return Boolean(expected) && getSessionCacheNamespace(baseUrl, token) === expected;
}

export function createVerifiedUserCacheRecord(
  baseUrl: string,
  token: string,
  user: RistakUser,
  verifiedAt = Date.now(),
): VerifiedUserCacheRecord | null {
  const namespace = getSessionCacheNamespace(baseUrl, token);
  if (!namespace || !String(user?.id || '').trim()) return null;
  return { namespace, verifiedAt, user };
}

export function getCachedVerifiedUser(
  record: VerifiedUserCacheRecord | null | undefined,
  baseUrl: string,
  token: string,
) {
  const expectedNamespace = getSessionCacheNamespace(baseUrl, token);
  if (
    !record
    || !expectedNamespace
    || record.namespace !== expectedNamespace
    || !String(record.user?.id || '').trim()
  ) {
    return null;
  }
  return record.user;
}

export function getSessionVerifyRejection(error: unknown): 'unauthorized' | 'license_blocked' | null {
  const candidate = error && typeof error === 'object'
    ? error as { status?: unknown; code?: unknown }
    : {};
  const status = Number(candidate.status || 0);
  if (status === 401) return 'unauthorized';
  if (status === 403 && String(candidate.code || '') === 'license_blocked') return 'license_blocked';
  return null;
}
