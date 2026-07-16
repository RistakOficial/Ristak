import { getApiBaseUrl } from './apiBaseUrl'

// IMPORTANTE: VITE_API_URL NO debe terminar con /api
// Este cliente SIEMPRE agrega /api/ a las rutas
// Si no hay VITE_API_URL, usa rutas relativas (producción) o localhost (desarrollo)

interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>
  suppressFeatureNotAvailableToast?: boolean
  showFeatureNotAvailableToast?: boolean
}

export type ApiRequestError = Error & {
  status?: number
  body?: unknown
  retryAfterMs?: number
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, retryAt - now)
}

class ApiClient {
  private baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL
  }

  private getAuthHeaders() {
    try {
      const token = localStorage.getItem('auth_token')
      return token ? { Authorization: `Bearer ${token}` } : {}
    } catch {
      return {}
    }
  }

  private async request<T>(
    endpoint: string,
    options: ApiRequestOptions = {}
  ): Promise<T> {
    const {
      params,
      suppressFeatureNotAvailableToast = false,
      showFeatureNotAvailableToast,
      ...fetchOptions
    } = options
    const method = String(fetchOptions.method || 'GET').toUpperCase()

    // SIEMPRE agregamos /api si no está presente
    const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    let url = `${getApiBaseUrl() || this.baseURL}${apiEndpoint}`

    if (params) {
      const searchParams = new URLSearchParams(params)
      url += `?${searchParams.toString()}`
    }

    const headers = new Headers(fetchOptions.headers)
    const isFormDataBody = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData
    if (!isFormDataBody && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    Object.entries(this.getAuthHeaders()).forEach(([key, value]) => {
      headers.set(key, value)
    })

    const response = await fetch(url, {
      ...fetchOptions,
      headers,
    })

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T
    }

    let rawJson: unknown
    try {
      rawJson = await response.json()
    } catch {
      if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`)
      }
      return {} as T
    }

    const json = rawJson

    if (!response.ok) {
      let message = `API Error: ${response.status} ${response.statusText}`
      if (json && typeof json === 'object') {
        const payload = json as { error?: unknown; message?: unknown }
        if (payload.error) {
          message = String(payload.error)
        } else if (payload.message) {
          message = String(payload.message)
        }
      }
      // (CNT-001) Conservar status y body en el error para que el caller pueda
      // reaccionar a respuestas accionables (p. ej. 409 merge_confirmation_required
      // con el contacto en conflicto) sin perder compatibilidad con error.message.
      const apiError = new Error(message) as ApiRequestError
      apiError.status = response.status
      apiError.body = json
      apiError.retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'))

      // (LIC-005) Cuando el backend bloquea un módulo premium fuera del plan
      // devuelve 403 con code "feature_not_available". Sólo mostramos el toast
      // global en acciones explícitas: las lecturas GET suelen ser cargas de
      // pantalla/status y no deben regañar al usuario por funciones que no tocó.
      // El error igual se lanza para no romper a los callers.
      if (response.status === 403 && json && typeof json === 'object') {
        const code = (json as { code?: unknown }).code
        const shouldShowFeatureToast = showFeatureNotAvailableToast
          ?? (!suppressFeatureNotAvailableToast && method !== 'GET')
        if (code === 'feature_not_available' && shouldShowFeatureToast && typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('ristak:feature-not-available', {
              detail: {
                message,
                feature: (json as { feature?: unknown }).feature,
              },
            })
          )
        }
      }

      throw apiError
    }

    // Si la respuesta tiene la estructura { success: true, data: ... } Y el campo data existe, extraer el campo data
    // IMPORTANTE: Solo extraer data si existe, algunos endpoints devuelven success + otros campos directamente
    if (json && typeof json === 'object' && 'data' in json && 'success' in json && json.data !== undefined) {
      return (json as { data: unknown }).data as T
    }

    return json as T
  }

  async get<T>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'GET',
    })
  }

  async post<T>(endpoint: string, body?: any, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  async postForm<T>(endpoint: string, body: FormData, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body,
    })
  }

  async put<T>(endpoint: string, body?: any, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  async patch<T>(endpoint: string, body?: any, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  }

  async delete<T>(endpoint: string, body?: any, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
    })
  }
}

const apiClient = new ApiClient('')

export default apiClient
