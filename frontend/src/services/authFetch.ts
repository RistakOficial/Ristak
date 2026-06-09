const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

const API_AUTH_HEADER = 'Authorization'
const LOCAL_DEV_LOGIN_TIMEOUT_MS = 2500

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

function isRistakApiRequest(url: URL) {
  if (!url.pathname.startsWith('/api/')) return false
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
    const token = getStoredAuthToken()

    if (!requestUrl || !token || !isRistakApiRequest(requestUrl)) {
      return originalFetch(input, init)
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

    return originalFetch(input, {
      ...init,
      headers
    }).then(response => {
      maybeHandleLicenseBlocked(response)
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
    const response = await window.fetch(`${API_BASE_URL}/api/auth/local-dev-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    })

    if (!response.ok) return false

    const data = await response.json()
    if (!data?.success || !data?.token) return false

    window.localStorage.setItem('auth_token', data.token)
    return true
  } catch {
    return false
  } finally {
    window.clearTimeout(timeoutId)
  }
}
