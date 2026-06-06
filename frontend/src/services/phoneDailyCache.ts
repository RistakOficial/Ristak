const CACHE_PREFIX = 'ristak_phone_daily_data_cache_v1:'
const MAX_TOTAL_CACHE_CHARS = 1_200_000
const DEFAULT_MAX_ENTRY_CHARS = 420_000

interface CachedRecord<T> {
  dayKey: string
  savedAt: number
  data: T
}

export interface PhoneDailyCacheEntry<T> {
  data: T
  savedAt: number
  ageMs: number
}

interface WriteOptions {
  maxEntryChars?: number
}

function getStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getTodayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getStorageKey(key: string) {
  return `${CACHE_PREFIX}${key}`
}

function getCacheEntries(storage: Storage) {
  const entries: Array<{ key: string; value: string; savedAt: number; dayKey: string }> = []

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(CACHE_PREFIX)) continue

    const value = storage.getItem(key)
    if (!value) continue

    try {
      const parsed = JSON.parse(value) as Partial<CachedRecord<unknown>>
      if (!parsed || typeof parsed !== 'object') {
        entries.push({ key, value, savedAt: 0, dayKey: '' })
        continue
      }
      entries.push({
        key,
        value,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : ''
      })
    } catch {
      entries.push({ key, value, savedAt: 0, dayKey: '' })
    }
  }

  return entries
}

export function prunePhoneDailyCache() {
  const storage = getStorage()
  if (!storage) return

  const todayKey = getTodayKey()
  const currentEntries = getCacheEntries(storage)
  currentEntries.forEach((entry) => {
    if (entry.dayKey !== todayKey) {
      storage.removeItem(entry.key)
    }
  })

  const freshEntries = getCacheEntries(storage)
    .filter((entry) => entry.dayKey === todayKey)
    .sort((left, right) => right.savedAt - left.savedAt)

  let totalChars = freshEntries.reduce((total, entry) => total + entry.value.length, 0)
  for (const entry of [...freshEntries].reverse()) {
    if (totalChars <= MAX_TOTAL_CACHE_CHARS) break
    storage.removeItem(entry.key)
    totalChars -= entry.value.length
  }
}

export function getPhoneDailyCacheKey(...parts: Array<string | number | boolean | null | undefined>) {
  return parts
    .map((part) => encodeURIComponent(String(part ?? 'none')))
    .join(':')
}

export function readPhoneDailyCache<T>(key: string): PhoneDailyCacheEntry<T> | null {
  const storage = getStorage()
  if (!storage) return null

  const storageKey = getStorageKey(key)
  const raw = storage.getItem(storageKey)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<CachedRecord<T>>
    if (!parsed || typeof parsed !== 'object') {
      storage.removeItem(storageKey)
      return null
    }
    if (parsed.dayKey !== getTodayKey() || typeof parsed.savedAt !== 'number' || !('data' in parsed)) {
      storage.removeItem(storageKey)
      return null
    }

    return {
      data: parsed.data as T,
      savedAt: parsed.savedAt,
      ageMs: Date.now() - parsed.savedAt
    }
  } catch {
    storage.removeItem(storageKey)
    return null
  }
}

export function writePhoneDailyCache<T>(key: string, data: T, options: WriteOptions = {}) {
  const storage = getStorage()
  if (!storage) return false

  const record: CachedRecord<T> = {
    dayKey: getTodayKey(),
    savedAt: Date.now(),
    data
  }
  const value = JSON.stringify(record)
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS
  const storageKey = getStorageKey(key)

  if (value.length > maxEntryChars) {
    storage.removeItem(storageKey)
    prunePhoneDailyCache()
    return false
  }

  try {
    storage.setItem(storageKey, value)
    prunePhoneDailyCache()
    return true
  } catch {
    prunePhoneDailyCache()
    try {
      storage.setItem(storageKey, value)
      prunePhoneDailyCache()
      return true
    } catch {
      storage.removeItem(storageKey)
      return false
    }
  }
}

export function removePhoneDailyCache(key: string) {
  const storage = getStorage()
  if (!storage) return
  storage.removeItem(getStorageKey(key))
}
