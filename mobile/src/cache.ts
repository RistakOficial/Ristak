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
import { shouldDeletePreloadCandidate } from './cachePreloadPolicy';

const CACHE_ROOT = `${FileSystem.documentDirectory ?? ''}ristak-cache-v1/`;

let namespace = 'default';
let dirReady: Promise<void> | null = null;
let cacheEpoch = 0;
const activeWrites = new Set<Promise<void>>();
const activeWritePathCounts = new Map<string, number>();
let cacheClearing: Promise<void> | null = null;
const memory = new Map<string, unknown>();

// The Android app has several independent screens. Reading one file each time a
// tab mounts was still fast, but it was visible as a short empty state on a cold
// launch. Keep the same bounded, account-scoped preload model as the iOS app:
// load recent snapshots once during bootstrap and make every later read a RAM
// lookup while the network revalidates in the background.
const MAX_PRELOADED_ENTRIES = 180;
const MAX_PRELOADED_BYTES = 32 * 1024 * 1024;
const MAX_BOOTSTRAP_PRELOADED_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const CACHE_PRELOAD_BATCH_SIZE = 4;

function yieldCachePreload(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  memory.clear();
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

function memoryKeyFor(key: string, scopedNamespace = namespace): string {
  return pathFor(key, scopedNamespace);
}

type CacheFileInfo = {
  exists: boolean;
  size?: number;
  modificationTime?: number;
};

type CachePreloadEntry = {
  path: string;
  size: number;
  modifiedAt: number;
};

function normalizeCacheFileSnapshot(info: CacheFileInfo): { size: number; modifiedAt: number } {
  return {
    size: Math.max(0, Number(info.size) || 0),
    modifiedAt: Math.max(0, Number(info.modificationTime) || 0) * 1000,
  };
}

function beginCachePathWrite(path: string): void {
  activeWritePathCounts.set(path, (activeWritePathCounts.get(path) || 0) + 1);
}

function finishCachePathWrite(path: string): void {
  const remaining = (activeWritePathCounts.get(path) || 0) - 1;
  if (remaining > 0) activeWritePathCounts.set(path, remaining);
  else activeWritePathCounts.delete(path);
}

function cachePathHasActiveOwner(path: string): boolean {
  return memory.has(path) || (activeWritePathCounts.get(path) || 0) > 0;
}

async function deletePreloadCandidateIfUnchanged(entry: CachePreloadEntry): Promise<void> {
  // Foreground reads/debounced writes populate RAM synchronously; immediate
  // writes are covered by the active-path counter. Either one owns this path,
  // even if the preload stat ran before its network response arrived.
  if (cachePathHasActiveOwner(entry.path)) return;

  try {
    const currentInfo = await FileSystem.getInfoAsync(entry.path) as CacheFileInfo;
    const currentSnapshot = currentInfo.exists ? normalizeCacheFileSnapshot(currentInfo) : null;
    if (!shouldDeletePreloadCandidate(entry, currentSnapshot, cachePathHasActiveOwner(entry.path))) return;
    // No await occurs between this final ownership check and scheduling delete,
    // so a foreground write cannot slip through the JS side of the guard.
    if (cachePathHasActiveOwner(entry.path)) return;
    await FileSystem.deleteAsync(entry.path, { idempotent: true });
  } catch {
    // Cache cleanup is best-effort and must never affect the live screen.
  }
}

function readEnvelope(raw: string): unknown {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as { v?: unknown };
  return parsed && Object.prototype.hasOwnProperty.call(parsed, 'v') ? parsed.v : undefined;
}

/**
 * Synchronous read from the already-preloaded cache. Use it in a component's
 * initial state so the first paint never waits for an effect or a disk read.
 */
export function peekCache<T>(key: string, fallback: T): T {
  const memoryKey = memoryKeyFor(key);
  return memory.has(memoryKey) ? memory.get(memoryKey) as T : fallback;
}

/** Whether the active namespace has an authoritative value, including `[]`. */
export function hasCachedValue(key: string): boolean {
  return memory.has(memoryKeyFor(key));
}

/**
 * Loads only the small set of snapshots needed for the first useful paint.
 * Unlike the general preload, this never enumerates the cache directory and
 * never parses more than a strict bootstrap budget before the shell opens.
 */
export async function preloadCacheKeys(keys: readonly string[], expectedNamespace = ''): Promise<void> {
  if (!CACHE_ROOT || cacheClearing || !keys.length) return;
  const requiredNamespace = expectedNamespace ? sanitize(expectedNamespace) : namespace;
  if (requiredNamespace !== namespace) return;
  const preloadEpoch = cacheEpoch;

  try {
    await ensureDir();
    if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
    const now = Date.now();
    const candidates = await Promise.all([...new Set(keys)].map(async (key) => {
      const path = pathFor(key, requiredNamespace);
      const info = await FileSystem.getInfoAsync(path) as CacheFileInfo;
      if (!info.exists) return null;
      const snapshot = normalizeCacheFileSnapshot(info);
      return {
        path,
        ...snapshot,
      };
    }));

    let selectedBytes = 0;
    const selected = candidates.filter((entry): entry is { path: string; size: number; modifiedAt: number } => {
      if (!entry) return false;
      const expired = entry.modifiedAt > 0 && now - entry.modifiedAt > MAX_CACHE_AGE_MS;
      if (expired) {
        void deletePreloadCandidateIfUnchanged(entry);
        return false;
      }
      if (selectedBytes + entry.size > MAX_BOOTSTRAP_PRELOADED_BYTES) return false;
      selectedBytes += entry.size;
      return true;
    });

    await Promise.all(selected.map(async (entry) => {
      try {
        const value = readEnvelope(await FileSystem.readAsStringAsync(entry.path));
        if (value === undefined) return;
        if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
        if (!memory.has(entry.path)) memory.set(entry.path, value);
      } catch {
        void deletePreloadCandidateIfUnchanged(entry);
      }
    }));
  } catch {
    // A missing/corrupt bootstrap snapshot falls back to the normal screen load.
  }
}

/**
 * Preloads a bounded set of the active account's newest snapshots into RAM.
 * It runs after the shell's initial interactions; bounded batches yield back to
 * the UI and stale or invalid files stay fail-soft.
 */
export async function preloadCache(expectedNamespace = ''): Promise<void> {
  if (!CACHE_ROOT || cacheClearing) return;
  const requiredNamespace = expectedNamespace ? sanitize(expectedNamespace) : namespace;
  if (requiredNamespace !== namespace) return;
  const preloadEpoch = cacheEpoch;

  try {
    await ensureDir();
    if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
    const files = await FileSystem.readDirectoryAsync(CACHE_ROOT);
    const prefix = `${sanitize(requiredNamespace)}__`;
    const now = Date.now();
    const cacheFiles = files.filter((filename) => filename.startsWith(prefix) && filename.endsWith('.json'));
    const entries: CachePreloadEntry[] = [];
    for (let batchStart = 0; batchStart < cacheFiles.length; batchStart += CACHE_PRELOAD_BATCH_SIZE) {
      if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
      const metadataBatch = await Promise.all(cacheFiles
        .slice(batchStart, batchStart + CACHE_PRELOAD_BATCH_SIZE)
        .map(async (filename) => {
          try {
            const path = `${CACHE_ROOT}${filename}`;
            const info = await FileSystem.getInfoAsync(path) as CacheFileInfo;
            if (!info.exists) return null;
            const snapshot = normalizeCacheFileSnapshot(info);
            return {
              path,
              ...snapshot,
            };
          } catch {
            // One file may disappear between directory enumeration and stat.
            return null;
          }
        }));
      entries.push(...metadataBatch.filter((entry): entry is { path: string; size: number; modifiedAt: number } => Boolean(entry)));
      if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
      await yieldCachePreload();
    }

    entries.sort((left, right) => right.modifiedAt - left.modifiedAt);
    let loadedBytes = 0;
    for (let batchStart = 0; batchStart < entries.length; batchStart += CACHE_PRELOAD_BATCH_SIZE) {
      if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
      const batch = entries.slice(batchStart, batchStart + CACHE_PRELOAD_BATCH_SIZE);
      const operations = batch.map(async (entry, batchOffset) => {
        const index = batchStart + batchOffset;
        const expired = entry.modifiedAt > 0 && now - entry.modifiedAt > MAX_CACHE_AGE_MS;
        const overBudget = index >= MAX_PRELOADED_ENTRIES || loadedBytes + entry.size > MAX_PRELOADED_BYTES;
        if (expired || overBudget) {
          await deletePreloadCandidateIfUnchanged(entry);
          return;
        }

        // Reserve the bounded budget before parallel reads in this small batch;
        // a corrupt file may make the accounting conservative, never unbounded.
        loadedBytes += entry.size;
        try {
          const value = readEnvelope(await FileSystem.readAsStringAsync(entry.path));
          if (value === undefined) return;
          if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
          // A foreground write can win while preload is reading. Never replace
          // that fresher in-memory value with an older disk snapshot.
          if (!memory.has(entry.path)) memory.set(entry.path, value);
        } catch {
          // A corrupt snapshot is disposable; fresh network data will replace it.
          await deletePreloadCandidateIfUnchanged(entry);
        }
      });
      await Promise.allSettled(operations);
      if (preloadEpoch !== cacheEpoch || requiredNamespace !== namespace || cacheClearing) return;
      // Yield after every batch, including batches that only expired or exceeded
      // the budget, so cleanup cannot flood the bridge while the shell is live.
      await yieldCachePreload();
    }
  } catch {
    // Offline-first is an enhancement, never a reason to block the shell.
  }
}

export async function readCache<T>(key: string, fallback: T): Promise<T> {
  if (!CACHE_ROOT || cacheClearing) return fallback;
  const targetPath = pathFor(key);
  if (memory.has(targetPath)) return memory.get(targetPath) as T;
  const readEpoch = cacheEpoch;
  try {
    await ensureDir();
    if (readEpoch !== cacheEpoch) return fallback;
    const info = await FileSystem.getInfoAsync(targetPath);
    if (!info.exists) return fallback;
    const raw = await FileSystem.readAsStringAsync(targetPath);
    if (readEpoch !== cacheEpoch) return fallback;
    if (!raw) return fallback;
    const value = readEnvelope(raw);
    if (value === undefined) return fallback;
    memory.set(targetPath, value);
    return value as T;
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
  memory.set(targetPath, value);
  const existing = pendingWrites.get(scopedKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingWrites.delete(scopedKey);
    const writePromise = (async () => {
      beginCachePathWrite(targetPath);
      try {
        await ensureDir();
        if (writeEpoch !== cacheEpoch) return;
        const payload = JSON.stringify({ v: value });
        await FileSystem.writeAsStringAsync(targetPath, payload);
      } catch {
        // Best-effort: a failed cache write must never break the app.
      } finally {
        finishCachePathWrite(targetPath);
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
    beginCachePathWrite(targetPath);
    try {
      await ensureDir();
      if (
        writeEpoch !== cacheEpoch
        || cacheClearing
        || (!expectedNamespace && namespace !== requiredNamespace)
      ) return;
      await FileSystem.writeAsStringAsync(targetPath, JSON.stringify({ v: value }));
      if (namespace === requiredNamespace && writeEpoch === cacheEpoch) {
        memory.set(targetPath, value);
      }
    } catch {
      // Best-effort.
    } finally {
      finishCachePathWrite(targetPath);
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
  memory.delete(targetPath);
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
    memory.clear();
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
