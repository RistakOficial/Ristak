import { getApiBaseUrl } from './apiBaseUrl'
import {
  finishRistakApiRequest,
  startRistakApiRequest
} from './requestActivity'
import { syncAuthScopedCachePrincipal } from './authPrincipalCache'

const API_AUTH_HEADER = 'Authorization'
const LOCAL_DEV_LOGIN_TIMEOUT_MS = 2500

type ApiReadCacheInvalidation = {
  pathPrefixes?: string[]
  abortInflight?: boolean
}

export type ApiReadCacheInvalidationContext = {
  abortInflight: boolean
}

type ApiReadCacheInvalidatorRegistration = {
  invalidator: (context: ApiReadCacheInvalidationContext) => void
  pathPrefixes: string[]
}

const apiReadInvalidationListeners = new Set<ApiReadCacheInvalidatorRegistration>()
// Evita que el primer GET de una sesión ya restaurada invalide los snapshots que
// la propia ruta acaba de preparar. Los cambios reales de login/cuenta sí pasan
// por syncAuthPrincipal y limpian todo el estado anterior.
let currentAuthPrincipal = getStoredAuthToken() || ''

// Algunos POST son lecturas y no deben invalidar snapshots especializados.
const API_READ_ONLY_POST_PATHS = new Set([
  '/api/chat-events/viewing',
  '/api/sites/analytics/summary',
  '/api/tracking/analytics/facets',
  '/api/tracking/analytics/summary',
  '/api/tracking/sessions/search',
  '/api/settings/message-templates/preview',
  '/api/whatsapp-api/phone-numbers/preview',
  '/api/email/detect'
])

// Estas mutaciones cambian métricas derivadas que también leen Dashboard y
// Analíticas. La invalidación se limita a sus consumidores reales; nunca vuelve
// a enfriar Sites, Configuración, Chats u otro módulo ajeno.
const ANALYTICS_MUTATION_MODULES = new Set([
  'appointments',
  'calendar',
  'calendars',
  'campaigns',
  'contacts',
  'meta',
  'payments',
  'tracking',
  'transactions'
])

function isAnalyticsNeutralMutation(pathname: string) {
  return pathname === '/api/contacts/chats/read'
    || /^\/api\/contacts\/chats\/[^/]+\/read$/.test(pathname)
}

function normalizeApiReadInvalidationPrefixes(values: string[] = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(value => value.startsWith('/api/')))]
}

function pathPrefixesOverlap(leftPrefixes: string[], rightPrefixes: string[]) {
  return leftPrefixes.some(left => rightPrefixes.some(right => (
    left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`)
  )))
}

/**
 * Notifica únicamente a los snapshots especializados afectados. La capa global
 * de Response.clone/cache/dedupe fue retirada porque dejaba ramas de body sin
 * consumir y convertía mutaciones locales en recargas de toda la aplicación.
 */
export function invalidateRistakApiReadCache(options: ApiReadCacheInvalidation = {}) {
  const prefixes = normalizeApiReadInvalidationPrefixes(options.pathPrefixes)
  const context = { abortInflight: options.abortInflight !== false }

  apiReadInvalidationListeners.forEach(({ invalidator, pathPrefixes }) => {
    if (prefixes.length === 0 || pathPrefixesOverlap(prefixes, pathPrefixes)) {
      invalidator(context)
    }
  })
}

/** Registra un snapshot de servicio y las rutas de API de las que depende. */
export function registerRistakApiReadCacheInvalidator(
  invalidator: (context: ApiReadCacheInvalidationContext) => void,
  options: ApiReadCacheInvalidation = {}
) {
  const registration = {
    invalidator,
    pathPrefixes: normalizeApiReadInvalidationPrefixes(options.pathPrefixes)
  }
  apiReadInvalidationListeners.add(registration)
  return () => apiReadInvalidationListeners.delete(registration)
}

function syncAuthPrincipal(token: string | null) {
  syncAuthScopedCachePrincipal(token)
  const nextPrincipal = token || ''
  if (nextPrincipal === currentAuthPrincipal) return
  currentAuthPrincipal = nextPrincipal
  invalidateRistakApiReadCache()
}

function getMutationInvalidationPrefixes(pathname: string) {
  const moduleName = pathname.split('/').filter(Boolean)[1] || ''
  const prefixes = moduleName ? [`/api/${moduleName}`] : []
  if (ANALYTICS_MUTATION_MODULES.has(moduleName) && !isAnalyticsNeutralMutation(pathname)) {
    prefixes.push('/api/dashboard', '/api/tracking')
  }
  return normalizeApiReadInvalidationPrefixes(prefixes)
}

function shouldNotifyMutation(method: string, pathname: string) {
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
    syncAuthPrincipal(token)

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

    return runFetch({
      ...init,
      headers
    }, response => {
      maybeHandleLicenseBlocked(response)
      if (response.ok && shouldNotifyMutation(method, requestUrl.pathname)) {
        invalidateRistakApiReadCache({
          pathPrefixes: getMutationInvalidationPrefixes(requestUrl.pathname)
        })
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
        syncAuthPrincipal(null)
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
    syncAuthPrincipal(data.token)
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timeoutId)
  }
}
