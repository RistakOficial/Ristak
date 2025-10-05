import { dedupeContactsPayload } from '@/utils/contactDedup'

// IMPORTANTE: VITE_API_URL NO debe terminar con /api
// Este cliente SIEMPRE agrega /api/ a las rutas
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>
}

class ApiClient {
  private baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL
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

    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`)
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T
    }

    const rawJson = await response.json()
    const json = dedupeContactsPayload(rawJson)

    // Si la respuesta tiene la estructura { success: true, data: ... }, extraer el campo data
    if (json && typeof json === 'object' && 'data' in json && 'success' in json) {
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

  async put<T>(endpoint: string, body?: any, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  async delete<T>(endpoint: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'DELETE',
    })
  }
}

const apiClient = new ApiClient(API_BASE_URL)

export default apiClient
