// Offline-first disk cache (WhatsApp-style): keep a local copy of the data the
// user last saw so screens paint instantly on cold start, then revalidate in the
// background. Backed by expo-file-system (documentDirectory) so it can hold large
// payloads — unlike SecureStore, which is for small secrets and caps ~2KB.
//
// Usage:
//   setCacheNamespace(sessionNamespace)  // base URL + token hash, before reads
//   const chats = await readCache<ChatContact[]>('chats', [])
//   writeCache('chats', chats)           // debounced, fire-and-forget
//   clearAllCache()                      // on logout / account switch
import * as FileSystem from 'expo-file-system/legacy';

const CACHE_ROOT = `${FileSystem.documentDirectory ?? ''}ristak-cache-v1/`;

let namespace = 'default';
let dirReady: Promise<void> | null = null;
let cacheEpoch = 0;
const activeWrites = new Set<Promise<void>>();
let cacheClearing: Promise<void> | null = null;

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'default';
}

// Scope every key to the connected account/server so switching apps or logging
// into a different tenant never mixes cached data.
export function setCacheNamespace(rawNamespace: string): void {
  const nextNamespace = sanitize(rawNamespace || 'default');
  if (nextNamespace === namespace) return;
  namespace = nextNamespace;
  cacheEpoch += 1;
}

async function ensureDir(): Promise<void> {
  if (!CACHE_ROOT) return;
  if (!dirReady) {
    dirReady = (async () => {
      try {
        const info = await FileSystem.getInfoAsync(CACHE_ROOT);
        if (!info.exists) {
          await FileSystem.makeDirectoryAsync(CACHE_ROOT, { intermediates: true });
        }
      } catch {
        // Leave dirReady resolved; individual reads/writes will fail-soft.
      }
    })();
  }
  return dirReady;
}

function pathFor(key: string, scopedNamespace = namespace): string {
  return `${CACHE_ROOT}${sanitize(`${scopedNamespace}__${key}`)}.json`;
}

export async function readCache<T>(key: string, fallback: T): Promise<T> {
  if (!CACHE_ROOT || cacheClearing) return fallback;
  const targetPath = pathFor(key);
  const readEpoch = cacheEpoch;
  try {
    await ensureDir();
    if (readEpoch !== cacheEpoch) return fallback;
    const info = await FileSystem.getInfoAsync(targetPath);
    if (!info.exists) return fallback;
    const raw = await FileSystem.readAsStringAsync(targetPath);
    if (readEpoch !== cacheEpoch) return fallback;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { v?: T };
    return parsed && parsed.v !== undefined ? (parsed.v as T) : fallback;
  } catch {
    return fallback;
  }
}

const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();

// Debounced so rapid state updates (e.g. a burst of message merges) collapse into
// a single disk write. Fire-and-forget: callers never await it.
export function writeCache<T>(key: string, value: T, debounceMs = 450): void {
  if (!CACHE_ROOT || cacheClearing) return;
  const scopedKey = `${namespace}__${key}`;
  const targetPath = pathFor(key);
  const writeEpoch = cacheEpoch;
  const existing = pendingWrites.get(scopedKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWrites.delete(scopedKey);
    const writePromise = (async () => {
      try {
        await ensureDir();
        if (writeEpoch !== cacheEpoch) return;
        const payload = JSON.stringify({ v: value });
        await FileSystem.writeAsStringAsync(targetPath, payload);
      } catch {
        // Best-effort: a failed cache write must never break the app.
      }
    })();
    activeWrites.add(writePromise);
    void writePromise.finally(() => activeWrites.delete(writePromise));
  }, Math.max(0, debounceMs));
  pendingWrites.set(scopedKey, timer);
}

// Immediate, awaitable write — for headless contexts (background task) where the
// JS runtime is suspended right after the task resolves, so the debounced
// setTimeout in writeCache would never fire.
export async function writeCacheNow<T>(key: string, value: T, expectedNamespace = ''): Promise<void> {
  if (!CACHE_ROOT || cacheClearing) return;
  const requiredNamespace = expectedNamespace ? sanitize(expectedNamespace) : namespace;
  // A headless fetch can outlive logout/account-switch. Pinning the path to its
  // explicit session namespace means it can never choose whichever operator
  // happens to be active when the response finally arrives. Unlike foreground
  // writes, this does not mutate or depend on the process-global namespace.
  const scopedKey = `${requiredNamespace}__${key}`;
  const targetPath = pathFor(key, requiredNamespace);
  const writeEpoch = cacheEpoch;
  const existing = pendingWrites.get(scopedKey);
  if (existing) {
    clearTimeout(existing);
    pendingWrites.delete(scopedKey);
  }
  const writePromise = (async () => {
    try {
      await ensureDir();
      if (
        writeEpoch !== cacheEpoch
        || cacheClearing
        || (!expectedNamespace && namespace !== requiredNamespace)
      ) return;
      await FileSystem.writeAsStringAsync(targetPath, JSON.stringify({ v: value }));
    } catch {
      // Best-effort.
    }
  })();
  activeWrites.add(writePromise);
  try {
    await writePromise;
  } finally {
    activeWrites.delete(writePromise);
  }
}

export async function removeCache(key: string): Promise<void> {
  if (!CACHE_ROOT) return;
  const scopedKey = `${namespace}__${key}`;
  const targetPath = pathFor(key);
  const pending = pendingWrites.get(scopedKey);
  if (pending) {
    clearTimeout(pending);
    pendingWrites.delete(scopedKey);
  }
  try {
    await FileSystem.deleteAsync(targetPath, { idempotent: true });
  } catch {
    // ignore
  }
}

// Wipe everything (logout / account switch). Also cancels queued writes so a
// late flush can't recreate files after the wipe.
export async function clearAllCache(): Promise<void> {
  if (cacheClearing) return cacheClearing;
  const clearing = (async () => {
    cacheEpoch += 1;
    pendingWrites.forEach((timer) => clearTimeout(timer));
    pendingWrites.clear();
    await Promise.allSettled([...activeWrites]);
    dirReady = null;
    if (!CACHE_ROOT) return;
    try {
      const info = await FileSystem.getInfoAsync(CACHE_ROOT);
      if (info.exists) {
        await FileSystem.deleteAsync(CACHE_ROOT, { idempotent: true });
      }
    } catch {
      // ignore
    }
  })();
  cacheClearing = clearing;
  try {
    await clearing;
  } finally {
    if (cacheClearing === clearing) cacheClearing = null;
  }
}
