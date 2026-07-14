import { getApiBaseUrl } from './apiBaseUrl'
import {
  finishRistakApiRequest,
  startRistakApiRequest
} from './requestActivity'
import { syncAuthScopedCachePrincipal } from './authPrincipalCache'

const API_AUTH_HEADER = 'Authorization'
const LOCAL_DEV_LOGIN_TIMEOUT_MS = 2500
const API_READ_CACHE_DEFAULT_TTL_MS = 15_000
const API_READ_CACHE_CONFIG_TTL_MS = 60_000
const API_READ_CACHE_MAX_ENTRIES = 120
const API_READ_CACHE_MAX_RESPONSE_BYTES = 1_000_000
const API_READ_CACHE_MAX_TOTAL_BYTES = 12_000_000

type ApiReadCacheEntry = {
  response: Response
  expiresAt: number
  sizeBytes: number
}

type ApiReadRequestPolicy = {
  key: string
  ttlMs: number
  cacheResponse: boolean
}

const apiReadResponseCache = new Map<string, ApiReadCacheEntry>()
const apiReadInFlight = new Map<string, Promise<Response>>()
const apiReadInvalidationListeners = new Set<() => void>()
let apiReadCacheToken = ''
let apiReadCacheVersion = 0
let apiReadCacheTotalBytes = 0

const API_READ_CACHE_BYPASS_PREFIXES = [
  '/api/auth/',
  '/api/automations/assets',
  '/api/chat-events',
  '/api/payment-events',
  '/api/highlevel/conversations',
  '/api/highlevel/sync/progress',
  '/api/whatsapp-api',
  '/api/email/',
  '/api/search',
  '/api/health'
]

const API_READ_RESPONSE_CACHE_BYPASS_PREFIXES = [
  '/api/media',
  '/api/internal',
  '/api/tracking/sessions',
  '/api/tracking/visitors',
  '/api/reports/contacts-list'
]

// Algunos endpoints POST son consultas porque su filtro no cabe de forma segura
// en una URL. No deben vaciar snapshots de toda la aplicación como si hubieran
// modificado datos.
const API_READ_ONLY_POST_PATHS = new Set([
  '/api/chat-events/viewing',
  '/api/sites/analytics/summary',
  '/api/tracking/analytics/summary',
  '/api/tracking/sessions/search',
  '/api/settings/message-templates/preview',
  '/api/whatsapp-api/phone-numbers/preview',
  '/api/email/detect'
])

function clearApiReadCache() {
  apiReadResponseCache.clear()
  apiReadInFlight.clear()
  apiReadCacheTotalBytes = 0
  apiReadCacheVersion += 1
}

function deleteCachedApiResponse(key: string) {
  const cached = apiReadResponseCache.get(key)
  if (!cached) return false
  apiReadResponseCache.delete(key)
  apiReadCacheTotalBytes = Math.max(0, apiReadCacheTotalBytes - cached.sizeBytes)
  return true
}

/**
 * Invalida snapshots GET después de una mutación local o de un evento vivo.
 * Las mutaciones que atraviesan installAuthFetch ya lo hacen automáticamente;
 * este helper cubre servicios que reciben actualizaciones por SSE/websocket.
 */
export function invalidateRistakApiReadCache() {
  clearApiReadCache()
  apiReadInvalidationListeners.forEach((invalidate) => invalidate())
}

/** Permite que snapshots especializados sigan la misma coherencia que GET. */
export function registerRistakApiReadCacheInvalidator(invalidator: () => void) {
  apiReadInvalidationListeners.add(invalidator)
  return () => apiReadInvalidationListeners.delete(invalidator)
}

function syncApiReadCacheToken(token: string | null) {
  syncAuthScopedCachePrincipal(token)
  const nextToken = token || ''
  if (nextToken === apiReadCacheToken) return
  apiReadCacheToken = nextToken
  clearApiReadCache()
}

function requestAcceptHeader(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }
  return headers.get('Accept') || ''
}

function requestHeadersFingerprint(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  const serialized = Array.from(headers.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join('\n')

  // FNV-1a de 64 bits: diferencia headers que cambian el alcance de la
  // respuesta (por ejemplo X-Meta-Access-Token) sin conservar secrets crudos
  // dentro de las llaves del Map.
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `${serialized.length}:${hash.toString(16)}`
}

function hasBypassPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

function requestsStreamingResponse(url: URL) {
  if (['download', 'export', 'stream'].some((key) => url.searchParams.has(key))) return true

  // Una respuesta binaria grande no puede compartir el camino de snapshots:
  // response.clone() crea un tee cuyo segundo brazo puede retener el archivo
  // completo en memoria mientras el consumidor lee el primero.
  return /\/(?:download|export)$/.test(url.pathname)
    || /\/(?:file|thumbnail|voice\.ogg)$/.test(url.pathname)
    || /\/stream$/.test(url.pathname)
}

function getApiReadRequestPolicy(
  url: URL,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string,
  token: string | null
): ApiReadRequestPolicy | null {
  if (method !== 'GET' || !token) return null
  if (init?.signal || init?.cache === 'no-store' || init?.cache === 'reload') return null
  if (hasBypassPrefix(url.pathname, API_READ_CACHE_BYPASS_PREFIXES)) return null

  const accept = requestAcceptHeader(input, init).toLowerCase()
  if (accept.includes('text/event-stream')) return null

  const limit = Number(url.searchParams.get('limit') || 0)
  const requestsOversizedPage = Number.isFinite(limit) && limit > 200
  if (requestsOversizedPage) return null
  if (requestsStreamingResponse(url)) return null

  const cacheResponse = !hasBypassPrefix(url.pathname, API_READ_RESPONSE_CACHE_BYPASS_PREFIXES)
    && !url.pathname.includes('/preview')

  const ttlMs = (
    url.pathname.startsWith('/api/config')
    || url.pathname.startsWith('/api/user-config')
    || url.pathname.startsWith('/api/settings')
    || url.pathname.startsWith('/api/integrations')
  )
    ? API_READ_CACHE_CONFIG_TTL_MS
    : API_READ_CACHE_DEFAULT_TTL_MS

  return {
    key: `${url.href}\nheaders:${requestHeadersFingerprint(input, init)}`,
    ttlMs,
    cacheResponse
  }
}

function readCachedApiResponse(key: string) {
  const cached = apiReadResponseCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    deleteCachedApiResponse(key)
    return null
  }

  // Map conserva orden de inserción: reinsertar vuelve este snapshot el más
  // reciente y permite podar como LRU sin otra estructura paralela.
  apiReadResponseCache.delete(key)
  apiReadResponseCache.set(key, cached)
  return cached.response.clone()
}

async function cacheApiResponse(
  key: string,
  response: Response,
  ttlMs: number,
  expectedCacheVersion: number
) {
  if (!response.ok) return
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) return
  if (response.headers.has('content-disposition')) return

  // El cache en memoria no debe saltarse una prohibicion explicita del
  // backend. `no-cache` tambien queda fuera porque este cliente no implementa
  // revalidacion condicional (ETag/Last-Modified) para respuestas de API.
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() || ''
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/.test(cacheControl)) return
  if ((response.headers.get('vary') || '').trim() === '*') return

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > API_READ_CACHE_MAX_RESPONSE_BYTES) return

  const payload = await response.clone().arrayBuffer()
  if (payload.byteLength > API_READ_CACHE_MAX_RESPONSE_BYTES) return
  if (expectedCacheVersion !== apiReadCacheVersion) return

  deleteCachedApiResponse(key)
  while (
    apiReadResponseCache.size >= API_READ_CACHE_MAX_ENTRIES
    || apiReadCacheTotalBytes + payload.byteLength > API_READ_CACHE_MAX_TOTAL_BYTES
  ) {
    const oldestKey = apiReadResponseCache.keys().next().value
    if (!oldestKey) break
    deleteCachedApiResponse(oldestKey)
  }

  apiReadResponseCache.set(key, {
    response: new Response(payload, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }),
    expiresAt: Date.now() + ttlMs,
    sizeBytes: payload.byteLength
  })
  apiReadCacheTotalBytes += payload.byteLength
}

function shouldInvalidateApiReadCache(method: string, pathname: string) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  if (method === 'POST' && API_READ_ONLY_POST_PATHS.has(pathname)) return false
  return true
}

function getStoredAuthToken() {
  try {
    return localStorage.getItem('auth_token')
  } catch {
    return null
  }
}

function resolveRequestUrl(input: RequestInfo | URL) {
  const rawUrl = input instanceof Request ? input.url : String(input)

  try {
    return new URL(rawUrl, window.location.origin)
  } catch {
    return null
  }
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase()
  if (input instanceof Request && input.method) return input.method.toUpperCase()
  return 'GET'
}

function isRistakApiRequest(url: URL) {
  if (!url.pathname.startsWith('/api/')) return false
  const API_BASE_URL = getApiBaseUrl()
  if (!API_BASE_URL) return url.origin === window.location.origin

  try {
    return url.origin === new URL(API_BASE_URL, window.location.origin).origin
  } catch {
    return url.origin === window.location.origin
  }
}

function isLocalDevHost() {
  if (typeof window === 'undefined') return false

  const hostname = window.location.hostname
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function shouldUseLocalDevLogin() {
  return import.meta.env.DEV
    && import.meta.env.VITE_DISABLE_LOCAL_DEV_LOGIN !== 'true'
    && isLocalDevHost()
}

export function installAuthFetch() {
  if (typeof window === 'undefined') return
  if ((window as typeof window & { __ristakAuthFetchInstalled?: boolean }).__ristakAuthFetchInstalled) return

  const originalFetch = window.fetch.bind(window)
  ;(window as typeof window & { __ristakAuthFetchInstalled?: boolean }).__ristakAuthFetchInstalled = true

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = resolveRequestUrl(input)
    const method = resolveRequestMethod(input, init)
    const activityId = requestUrl && isRistakApiRequest(requestUrl)
      ? startRistakApiRequest(requestUrl, input, init)
      : null
    const token = getStoredAuthToken()
    syncApiReadCacheToken(token)

    const runFetch = (nextInit?: RequestInit, onResponse?: (response: Response) => Response) => {
      try {
        return originalFetch(input, nextInit).then((response) => (
          onResponse ? onResponse(response) : response
        )).finally(() => {
          finishRistakApiRequest(activityId)
        })
      } catch (error) {
        finishRistakApiRequest(activityId)
        throw error
      }
    }

    if (!requestUrl || !token || !isRistakApiRequest(requestUrl)) {
      return runFetch(init)
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined)

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value)
      })
    }

    if (!headers.has(API_AUTH_HEADER)) {
      headers.set(API_AUTH_HEADER, `Bearer ${token}`)
    }

    const nextInit = {
      ...init,
      headers
    }
    const readPolicy = getApiReadRequestPolicy(requestUrl, input, nextInit, method, token)

    if (readPolicy) {
      const cachedResponse = readCachedApiResponse(readPolicy.key)
      if (cachedResponse) {
        finishRistakApiRequest(activityId)
        return Promise.resolve(cachedResponse)
      }

      const requestCacheVersion = apiReadCacheVersion
      let sharedRequest = apiReadInFlight.get(readPolicy.key)

      if (!sharedRequest) {
        sharedRequest = originalFetch(input, nextInit)
          .then(response => {
            maybeHandleLicenseBlocked(response)
            if (readPolicy.cacheResponse && requestCacheVersion === apiReadCacheVersion) {
              void cacheApiResponse(
                readPolicy.key,
                response,
                readPolicy.ttlMs,
                requestCacheVersion
              )
            }
            return response
          })
          .finally(() => {
            if (apiReadInFlight.get(readPolicy.key) === sharedRequest) {
              apiReadInFlight.delete(readPolicy.key)
            }
          })
        apiReadInFlight.set(readPolicy.key, sharedRequest)
      }

      return sharedRequest
        .then(response => response.clone())
        .finally(() => finishRistakApiRequest(activityId))
    }

    return runFetch(nextInit, response => {
      maybeHandleLicenseBlocked(response)
      if (response.ok && shouldInvalidateApiReadCache(method, requestUrl.pathname)) {
        invalidateRistakApiReadCache()
      }
      return response
    })
  }
}

// Si la licencia central se suspende a media sesión, cualquier request privado
// responde 403 con code license_blocked: se manda al usuario a la pantalla de bloqueo.
function maybeHandleLicenseBlocked(response: Response) {
  if (response.status !== 403) return
  if (window.location.pathname === '/license-blocked') return

  response.clone().json().then(data => {
    if (data?.code === 'license_blocked') {
      try {
        localStorage.removeItem('auth_token')
        syncAuthScopedCachePrincipal(null)
      } catch {
        // sin acceso a storage, continuar igual
      }
      window.location.href = '/license-blocked'
    }
  }).catch(() => {
    // respuesta sin JSON: no es un bloqueo de licencia
  })
}

export async function ensureLocalDevAuth() {
  if (typeof window === 'undefined') return false
  if (!shouldUseLocalDevLogin()) return false
  if (getStoredAuthToken()) return false

  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), LOCAL_DEV_LOGIN_TIMEOUT_MS)

  try {
    const response = await window.fetch(`${getApiBaseUrl()}/api/auth/local-dev-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    })

    if (!response.ok) return false

    const data = await response.json()
    if (!data?.success || !data?.token) return false

    window.localStorage.setItem('auth_token', data.token)
    syncAuthScopedCachePrincipal(data.token)
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timeoutId)
  }
}
