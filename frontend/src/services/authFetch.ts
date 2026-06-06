const API_BASE_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')

const API_AUTH_HEADER = 'Authorization'

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
    })
  }
}
