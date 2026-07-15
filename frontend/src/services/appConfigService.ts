import { apiUrl } from './apiBaseUrl'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import {
  registerRistakApiReadCacheInvalidator,
  type ApiReadCacheInvalidationContext
} from './authFetch'
import {
  abortAndClearSharedRequests,
  detachSharedRequests,
  getOrCreateSharedRequest
} from './sharedRequest'
import { withRequestTimeout } from './requestTimeout'

type AppConfigValues = Record<string, unknown>

const APP_CONFIG_CACHE_TTL_MS = 60_000
const APP_CONFIG_CACHE_MAX_ENTRIES = 128
const APP_CONFIG_REQUEST_TIMEOUT_MS = 20_000

const appConfigSnapshots = new Map<string, { values: AppConfigValues; fetchedAt: number }>()
const appConfigInflight = new Map<string, Promise<AppConfigValues>>()
let appConfigCacheRevision = 0

function normalizeConfigKeys(keys: string[]) {
  return [...new Set(keys
    .map(key => String(key || '').trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
}

function configRequestKey(keys: string[]) {
  return keys.join(',')
}

function getConfigHeaders() {
  let token: string | null = null

  try {
    token = localStorage.getItem('auth_token')
  } catch {
    token = null
  }

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

function readFreshAppConfigSnapshot(key: string) {
  const cached = appConfigSnapshots.get(key)
  if (!cached) return null

  if (Date.now() - cached.fetchedAt >= APP_CONFIG_CACHE_TTL_MS) {
    appConfigSnapshots.delete(key)
    return null
  }

  appConfigSnapshots.delete(key)
  appConfigSnapshots.set(key, cached)
  return cached.values
}

function writeAppConfigSnapshot(key: string, values: AppConfigValues) {
  appConfigSnapshots.delete(key)
  while (appConfigSnapshots.size >= APP_CONFIG_CACHE_MAX_ENTRIES) {
    const oldestKey = appConfigSnapshots.keys().next().value
    if (!oldestKey) break
    appConfigSnapshots.delete(oldestKey)
  }
  appConfigSnapshots.set(key, { values, fetchedAt: Date.now() })
}

export function clearAppConfigReadCache(
  { abortInflight = true }: Partial<ApiReadCacheInvalidationContext> = {}
) {
  appConfigCacheRevision += 1
  appConfigSnapshots.clear()
  if (abortInflight) {
    abortAndClearSharedRequests(
      appConfigInflight,
      new DOMException('La configuración cambió mientras se estaba leyendo', 'AbortError')
    )
    return
  }
  detachSharedRequests(appConfigInflight)
}

registerAuthScopedCacheInvalidator(clearAppConfigReadCache)
registerRistakApiReadCacheInvalidator(clearAppConfigReadCache, {
  pathPrefixes: ['/api/config']
})

/**
 * Lee configuración global como JSON ya consumido. Sólo esta familia pequeña
 * comparte requests y snapshots; nunca cachea Response ni cuerpos arbitrarios.
 */
export function getAppConfigValues(keys: string[]): Promise<AppConfigValues> {
  syncAuthScopedCachePrincipal()
  const normalizedKeys = normalizeConfigKeys(keys)
  if (normalizedKeys.length === 0) return Promise.resolve({})

  const key = configRequestKey(normalizedKeys)
  const cached = readFreshAppConfigSnapshot(key)
  if (cached) return Promise.resolve(cached)

  const requestAuthRevision = getAuthScopedCacheRevision()
  const requestCacheRevision = appConfigCacheRevision

  return getOrCreateSharedRequest({
    inflight: appConfigInflight,
    key,
    abortWhenUnused: true,
    createRequest: sharedSignal => withRequestTimeout({
      timeoutMs: APP_CONFIG_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'La configuración tardó demasiado. Reintenta la carga.',
      signal: sharedSignal,
      request: async signal => {
        const params = new URLSearchParams({ keys: normalizedKeys.join(',') })
        const response = await fetch(apiUrl(`/api/config?${params.toString()}`), {
          headers: getConfigHeaders(),
          signal
        })
        if (!response.ok) throw new Error('Failed to fetch config')

        const data = await response.json()
        const values = data?.config && typeof data.config === 'object'
          ? data.config as AppConfigValues
          : {}

        if (
          requestAuthRevision === getAuthScopedCacheRevision()
          && requestCacheRevision === appConfigCacheRevision
        ) {
          writeAppConfigSnapshot(key, values)
        }
        return values
      }
    })
  })
}
