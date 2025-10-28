import apiClient from './apiClient'

export type MatchType = 'contains' | 'exact'

export interface HiddenFilter {
  id: string
  filterText: string
  matchType: MatchType
  createdAt: string
}

export const hiddenContactsService = {
  async getFilters(): Promise<HiddenFilter[]> {
    try {
      const data = await apiClient.get<HiddenFilter[]>('/hidden-contacts')
      return data
    } catch {
      return []
    }
  },

  async addFilter(filterText: string, matchType: MatchType = 'contains'): Promise<HiddenFilter> {
    const data = await apiClient.post<HiddenFilter>('/hidden-contacts', { filterText, matchType })
    return data
  },

  async deleteFilter(id: string): Promise<void> {
    await apiClient.delete(`/hidden-contacts/${id}`)
  }
}
