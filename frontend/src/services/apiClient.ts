import { dedupeContactsPayload } from '@/utils/contactDedup'

// IMPORTANTE: VITE_API_URL NO debe terminar con /api
// Este cliente SIEMPRE agrega /api/ a las rutas
// Si no hay VITE_API_URL, usa rutas relativas (producción) o localhost (desarrollo)
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>
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
    const { params, ...fetchOptions } = options

    // SIEMPRE agregamos /api si no está presente
    const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint.startsWith('/') ? '' : '/'}${endpoint}`
    let url = `${this.baseURL}${apiEndpoint}`

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

    const json = dedupeContactsPayload(rawJson)

    if (!response.ok) {
      const message = json && typeof json === 'object' && 'error' in json
        ? String((json as { error?: unknown }).error)
        : `API Error: ${response.status} ${response.statusText}`
      throw new Error(message)
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

const apiClient = new ApiClient(API_BASE_URL)

export default apiClient
