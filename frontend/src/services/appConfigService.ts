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

type AppConfigSnapshot = {
  value: unknown
  fetchedAt: number
}

type PendingAppConfigBatch = {
  keys: Set<string>
  promise: Promise<AppConfigValues>
  resolve: (values: AppConfigValues) => void
  reject: (reason?: unknown) => void
  authRevision: number
  cacheRevision: number
  cancelled: boolean
}

const APP_CONFIG_CACHE_TTL_MS = 60_000
const APP_CONFIG_CACHE_MAX_ENTRIES = 128
const APP_CONFIG_REQUEST_TIMEOUT_MS = 20_000

const appConfigSnapshots = new Map<string, AppConfigSnapshot>()
const appConfigRequestInflight = new Map<string, Promise<AppConfigValues>>()
const appConfigKeyInflight = new Map<string, Promise<AppConfigValues>>()
let pendingAppConfigBatch: PendingAppConfigBatch | null = null
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

function readFreshAppConfigSnapshot(key: string): AppConfigSnapshot | null {
  const cached = appConfigSnapshots.get(key)
  if (!cached) return null

  if (Date.now() - cached.fetchedAt >= APP_CONFIG_CACHE_TTL_MS) {
    appConfigSnapshots.delete(key)
    return null
  }

  appConfigSnapshots.delete(key)
  appConfigSnapshots.set(key, cached)
  return cached
}

function writeAppConfigSnapshot(key: string, value: unknown) {
  appConfigSnapshots.delete(key)
  while (appConfigSnapshots.size >= APP_CONFIG_CACHE_MAX_ENTRIES) {
    const oldestKey = appConfigSnapshots.keys().next().value
    if (!oldestKey) break
    appConfigSnapshots.delete(oldestKey)
  }
  appConfigSnapshots.set(key, { value, fetchedAt: Date.now() })
}

function cleanupPendingBatchKeys(batch: PendingAppConfigBatch) {
  batch.keys.forEach(key => {
    if (appConfigKeyInflight.get(key) === batch.promise) {
      appConfigKeyInflight.delete(key)
    }
  })
}

async function dispatchAppConfigBatch(batch: PendingAppConfigBatch) {
  if (pendingAppConfigBatch === batch) pendingAppConfigBatch = null
  if (batch.cancelled) return

  const normalizedKeys = normalizeConfigKeys([...batch.keys])
  if (normalizedKeys.length === 0) {
    batch.resolve({})
    return
  }

  // La revisión evita que una tanda creada antes de una invalidación suave
  // vuelva a compartirse con lectores nuevos aunque todavía alcance a salir a red.
  const requestKey = `${batch.cacheRevision}:${configRequestKey(normalizedKeys)}`

  try {
    const values = await getOrCreateSharedRequest({
      inflight: appConfigRequestInflight,
      key: requestKey,
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
          if (!response.ok) {
            const error = new Error('Failed to fetch config') as Error & { status?: number }
            error.status = response.status
            throw error
          }

          const data = await response.json()
          return data?.config && typeof data.config === 'object'
            ? data.config as AppConfigValues
            : {}
        }
      })
    })

    const resolvedValues = Object.fromEntries(
      normalizedKeys.map(key => [key, values[key]])
    ) as AppConfigValues

    if (
      batch.authRevision === getAuthScopedCacheRevision()
      && batch.cacheRevision === appConfigCacheRevision
    ) {
      normalizedKeys.forEach(key => writeAppConfigSnapshot(key, resolvedValues[key]))
    }

    batch.resolve(resolvedValues)
  } catch (error) {
    batch.reject(error)
  } finally {
    cleanupPendingBatchKeys(batch)
  }
}

function createPendingAppConfigBatch(): PendingAppConfigBatch {
  let resolve!: (values: AppConfigValues) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<AppConfigValues>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  const batch: PendingAppConfigBatch = {
    keys: new Set(),
    promise,
    resolve,
    reject,
    authRevision: getAuthScopedCacheRevision(),
    cacheRevision: appConfigCacheRevision,
    cancelled: false
  }

  queueMicrotask(() => {
    void dispatchAppConfigBatch(batch)
  })

  return batch
}

function enqueueAppConfigKeys(keys: string[]) {
  const batch = pendingAppConfigBatch || createPendingAppConfigBatch()
  pendingAppConfigBatch = batch

  keys.forEach(key => {
    batch.keys.add(key)
    appConfigKeyInflight.set(key, batch.promise)
  })

  return batch.promise
}

export function clearAppConfigReadCache(
  { abortInflight = true }: Partial<ApiReadCacheInvalidationContext> = {}
) {
  appConfigCacheRevision += 1
  appConfigSnapshots.clear()
  const pendingBatch = pendingAppConfigBatch
  pendingAppConfigBatch = null
  appConfigKeyInflight.clear()

  if (abortInflight) {
    if (pendingBatch) {
      pendingBatch.cancelled = true
      pendingBatch.reject(new DOMException('La configuración cambió antes de leerse', 'AbortError'))
    }
    abortAndClearSharedRequests(
      appConfigRequestInflight,
      new DOMException('La configuración cambió mientras se estaba leyendo', 'AbortError')
    )
    return
  }
  detachSharedRequests(appConfigRequestInflight)
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

  const values: AppConfigValues = {}
  const pendingRequests = new Set<Promise<AppConfigValues>>()
  const keysToEnqueue: string[] = []

  normalizedKeys.forEach(key => {
    const cached = readFreshAppConfigSnapshot(key)
    if (cached) {
      values[key] = cached.value
      return
    }

    const inflight = appConfigKeyInflight.get(key)
    if (inflight) {
      pendingRequests.add(inflight)
      return
    }

    keysToEnqueue.push(key)
  })

  if (keysToEnqueue.length > 0) {
    pendingRequests.add(enqueueAppConfigKeys(keysToEnqueue))
  }

  if (pendingRequests.size === 0) return Promise.resolve(values)

  return Promise.all([...pendingRequests]).then(responses => {
    responses.forEach(responseValues => {
      normalizedKeys.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(responseValues, key)) {
          values[key] = responseValues[key]
        }
      })
    })
    return values
  })
}
