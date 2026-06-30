import apiClient from './apiClient'

export type GlobalSearchItemType = 'contact' | 'appointment' | 'payment' | 'payment_plan' | 'campaign' | 'adset' | 'ad'

export interface GlobalSearchItem {
  type: GlobalSearchItemType
  id: string
  title: string
  subtitle?: string
  meta?: string
  metadata?: Record<string, string | number | null | undefined>
}

export interface GlobalSearchCategory {
  id: string
  label: string
  items: GlobalSearchItem[]
}

interface GlobalSearchResponse {
  categories: GlobalSearchCategory[]
  total: number
}

export const globalSearchService = {
  async search(query: string, signal?: AbortSignal): Promise<GlobalSearchResponse> {
    const data = await apiClient.get<GlobalSearchResponse>('/search/global', {
      params: { q: query },
      signal
    })

    return {
      categories: Array.isArray(data?.categories) ? data.categories : [],
      total: Number(data?.total || 0)
    }
  }
}
