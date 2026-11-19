import { peekCache, preloadCacheKeys, resolveCacheNamespace, writeCache, writeCacheNow } from './cache';
import { hashCacheIdentity } from './sessionAccess';

type Snapshot<T> = { query: string; access: string; value: T };
type AccessState = { token: string; generation: number; ready: Promise<void>; persisted: Promise<void> };

let activeNamespace = '';
let tokenSequence = 0;
const accessByFamily = new Map<string, AccessState>();

// A denied endpoint invalidates every stored range and filter for that endpoint.
// A successful request can then store its own fresh result. If storage evicts
// its access marker, none of the old report files can be restored on their own.
export function analyticsSnapshot(query: string, namespace: string) {
  if (activeNamespace !== namespace) {
    accessByFamily.clear();
    activeNamespace = namespace;
  }
  const family = query.split(':')[1];
  const accessKey = 'analytics:v2:access:' + family;
  // Disk names are capped at 120 characters including the session namespace.
  // Verify the original full query inside the file as well.
  const dataKey = 'analytics:v2:data:' + hashCacheIdentity(query);
  let state = accessByFamily.get(family);
  if (!state) {
    const initial: AccessState = { token: '', generation: 0, ready: Promise.resolve(), persisted: Promise.resolve() };
    initial.ready = preloadCacheKeys([accessKey], namespace).then(() => {
      if (!initial.generation && namespace === resolveCacheNamespace()) initial.token = peekCache(accessKey, '');
    });
    accessByFamily.set(family, initial);
    state = initial;
  }
  const access = state;
  const generationAtStart = access.generation;
  const current = () => namespace === resolveCacheNamespace() && access.generation === generationAtStart;
  const issueToken = () => {
    const next = Date.now().toString(36) + '-' + (++tokenSequence).toString(36);
    access.token = next;
    // Serialize changes to the same marker; a slower write from before a
    // rejection must never restore its old token after the rejection.
    access.persisted = access.persisted.then(() => writeCacheNow(accessKey, next, namespace));
  };
  return {
    current,
    async read<T>() {
      await Promise.all([access.ready, preloadCacheKeys([dataKey], namespace)]);
      if (!current() || !access.token) return undefined;
      const saved = peekCache<Snapshot<T> | undefined>(dataKey, undefined);
      return saved?.query === query && saved.access === access.token ? saved.value : undefined;
    },
    async save<T>(value: T) {
      await access.ready;
      if (!current()) return;
      if (!access.token) issueToken();
      await access.persisted;
      if (current()) writeCache<Snapshot<T>>(dataKey, { query, access: access.token, value });
    },
    revoke() {
      if (!current()) return;
      access.generation++;
      issueToken();
    },
  };
}
