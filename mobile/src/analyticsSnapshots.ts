import { peekCache, preloadCacheKeys, resolveCacheNamespace, writeCache, writeCacheNow } from './cache';
import { hashCacheIdentity } from './sessionAccess';
import type { AnalyticsReportQuery } from './cacheKeys';

type Snapshot<T> = { query: string; access: string; value: T; startDate?: string; endDate?: string };
export type SavedAnalytics<T> = { value: T; previousEndDate?: string };
type AccessState = { token: string; generation: number; ready: Promise<void>; persisted: Promise<void> };

let activeNamespace = '';
let tokenSequence = 0;
const accessByFamily = new Map<string, AccessState>();

// A denied endpoint invalidates every stored range and filter for that endpoint.
// A successful request can then store its own fresh result. If storage evicts
// its access marker, none of the old report files can be restored on their own.
export function analyticsSnapshot(request: string | AnalyticsReportQuery, namespace: string) {
  const query = typeof request === 'string' ? request : request.exactKey;
  const periodKey = typeof request === 'string' ? '' : request.periodKey;
  const startDate = typeof request === 'string' ? '' : request.startDate;
  const endDate = typeof request === 'string' ? '' : request.endDate;
  const lastDataKey = periodKey ? 'analytics:v2:last:' + hashCacheIdentity(periodKey) : '';
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
    async read<T>(): Promise<SavedAnalytics<T> | undefined> {
      const keys = lastDataKey ? [dataKey, lastDataKey] : [dataKey];
      await Promise.all([access.ready, preloadCacheKeys(keys, namespace)]);
      if (!current() || !access.token) return undefined;
      const exact = peekCache<Snapshot<T> | undefined>(dataKey, undefined);
      if (exact?.query === query && exact.access === access.token) return { value: exact.value };
      if (!lastDataKey) return undefined;
      const last = peekCache<Snapshot<T> | undefined>(lastDataKey, undefined);
      // ISO calendar dates sort chronologically. Never substitute a later
      // reporting day after a device clock correction or an account switch.
      if (last?.query !== periodKey || last.access !== access.token || !last.startDate || !last.endDate) return undefined;
      if (last.startDate > last.endDate || last.endDate > endDate) return undefined;
      if (last.endDate === endDate && last.startDate !== startDate) return undefined;
      return { value: last.value, previousEndDate: last.endDate < endDate ? last.endDate : undefined };
    },
    async save<T>(value: T) {
      await access.ready;
      if (!current()) return;
      if (!access.token) issueToken();
      await access.persisted;
      if (!current()) return;
      writeCache<Snapshot<T>>(dataKey, { query, access: access.token, value });
      if (!lastDataKey) return;
      await preloadCacheKeys([lastDataKey], namespace);
      if (!current()) return;
      const previous = peekCache<Snapshot<T> | undefined>(lastDataKey, undefined);
      if (previous?.query === periodKey && previous.access === access.token && previous.endDate && previous.endDate > endDate) return;
      writeCache<Snapshot<T>>(lastDataKey, { query: periodKey, access: access.token, startDate, endDate, value });
    },
    revoke() {
      if (!current()) return;
      access.generation++;
      issueToken();
    },
  };
}
