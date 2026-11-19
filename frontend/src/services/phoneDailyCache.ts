import { createAuthScopedLocalStorageNamespace } from './authScopedLocalStorage'

const CACHE_STORAGE_PREFIX = 'ristak_phone_daily_data_cache_v1'
const phoneDailyStorage = createAuthScopedLocalStorageNamespace([CACHE_STORAGE_PREFIX])
const MAX_TOTAL_CACHE_CHARS = 1_200_000
const DEFAULT_MAX_ENTRY_CHARS = 420_000

interface CachedRecord<T> {
  dayKey: string
  savedAt: number
  retainAcrossDays?: boolean
  data: T
}

export interface PhoneDailyCacheEntry<T> {
  data: T
  savedAt: number
  ageMs: number
}

interface WriteOptions {
  retainAcrossDays?: boolean
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

// (MOB-007) Formatters cacheados por zona de negocio para derivar el dayKey 'YYYY-MM-DD'
// en la zona del NEGOCIO (no la del dispositivo). Mismo enfoque que getContactInfoJourneyDayKey.
const businessDayFormatters = new Map<string, Intl.DateTimeFormat>()

// (MOB-007) `timezone` opcional: si se pasa, el dayKey sigue el día del NEGOCIO; si no, se
// mantiene el comportamiento actual (zona del dispositivo) para no romper llamadas sin tz.
function getTodayKey(date = new Date(), timezone?: string) {
  // (MOB-007) Con timezone de negocio: 'en-CA' + 2-digit produce 'YYYY-MM-DD' en esa zona.
  if (timezone) {
    try {
      let formatter = businessDayFormatters.get(timezone)
      if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        })
        businessDayFormatters.set(timezone, formatter)
      }
      return formatter.format(date)
    } catch {
      // (MOB-007) Zona inválida → cae al comportamiento del dispositivo.
    }
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getStorageKey(key: string) {
  return `${phoneDailyStorage.getKey(CACHE_STORAGE_PREFIX)}:${key}`
}

function getCacheEntries(storage: Storage) {
  const entries: Array<{ key: string; value: string; savedAt: number; dayKey: string; retainAcrossDays?: boolean }> = []
  const cachePrefix = `${phoneDailyStorage.getKey(CACHE_STORAGE_PREFIX)}:`

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key?.startsWith(cachePrefix)) continue

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
        retainAcrossDays: parsed.retainAcrossDays === true,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : ''
      })
    } catch {
      entries.push({ key, value, savedAt: 0, dayKey: '' })
    }
  }

  return entries
}

// (MOB-007) timezone opcional: el bucket de "hoy" sigue el día del negocio cuando se pasa.
export function prunePhoneDailyCache(timezone?: string) {
  const storage = getStorage()
  if (!storage) return

  const todayKey = getTodayKey(new Date(), timezone) // (MOB-007) día del negocio si hay tz
  try {
    const retained = getCacheEntries(storage).filter((entry) => {
      if (entry.retainAcrossDays || entry.dayKey === todayKey) return true
      storage.removeItem(entry.key)
      return false
    }).sort((left, right) => left.savedAt - right.savedAt)

    let totalChars = retained.reduce((total, entry) => total + entry.value.length, 0)
    for (const entry of retained) {
      if (totalChars <= MAX_TOTAL_CACHE_CHARS) break
      storage.removeItem(entry.key)
      totalChars -= entry.value.length
    }
  } catch {
    // Un navegador con storage bloqueado sigue pudiendo mostrar la lectura de red.
  }
}

export function getPhoneDailyCacheKey(...parts: Array<string | number | boolean | null | undefined>) {
  return parts
    .map((part) => encodeURIComponent(String(part ?? 'none')))
    .join(':')
}

// (MOB-007) timezone opcional: valida que la entrada sea "de hoy" según el día del negocio.
export function readPhoneDailyCache<T>(key: string, timezone?: string): PhoneDailyCacheEntry<T> | null {
  const storage = getStorage()
  if (!storage) return null

  const storageKey = getStorageKey(key)
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedRecord<T>>
    if (!parsed || typeof parsed !== 'object') {
      storage.removeItem(storageKey)
      return null
    }
    const expired = !parsed.retainAcrossDays && parsed.dayKey !== getTodayKey(new Date(), timezone)
    if (expired || typeof parsed.savedAt !== 'number' || !('data' in parsed)) {
      storage.removeItem(storageKey)
      return null
    }

    return {
      data: parsed.data as T,
      savedAt: parsed.savedAt,
      ageMs: Date.now() - parsed.savedAt
    }
  } catch {
    removePhoneDailyCache(key)
    return null
  }
}

// (MOB-007) timezone opcional: el dayKey almacenado sigue el día del negocio cuando se pasa.
export function writePhoneDailyCache<T>(key: string, data: T, options: WriteOptions = {}, timezone?: string) {
  const storage = getStorage()
  if (!storage) return false

  const record: CachedRecord<T> = {
    dayKey: getTodayKey(new Date(), timezone), // (MOB-007) día del negocio si hay tz
    savedAt: Date.now(),
    retainAcrossDays: options.retainAcrossDays || undefined,
    data
  }
  const value = JSON.stringify(record)
  const maxEntryChars = options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS
  const storageKey = getStorageKey(key)

  if (value.length > maxEntryChars) {
    removePhoneDailyCache(key)
    prunePhoneDailyCache(timezone) // (MOB-007) propaga tz para no purgar el bucket del negocio
    return false
  }

  try {
    storage.setItem(storageKey, value)
    prunePhoneDailyCache(timezone) // (MOB-007)
    return true
  } catch {
    prunePhoneDailyCache(timezone) // (MOB-007)
    try {
      storage.setItem(storageKey, value)
      prunePhoneDailyCache(timezone) // (MOB-007)
      return true
    } catch {
      removePhoneDailyCache(key)
      return false
    }
  }
}

export function removePhoneDailyCache(key: string) {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.removeItem(getStorageKey(key))
  } catch {
    // Storage no disponible.
  }
}

export function removePhoneDailyCacheGroup(group: string) {
  const storage = getStorage()
  if (!storage) return
  const prefix = getStorageKey(group) + ':'
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) storage.removeItem(key)
    }
  } catch {
    // Storage no disponible.
  }
}
