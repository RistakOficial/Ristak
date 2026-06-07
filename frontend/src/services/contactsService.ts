import type { Contact as ContactType, ContactCustomFieldDefinition } from '@/types'
import { dedupeContacts } from '@/utils/contactDedup'
import { formatName } from '@/utils/format'
import apiClient from './apiClient'

export type Contact = ContactType

export interface ContactStats {
  total: number
  totalPrev: number
  withAppointments: number
  withAppointmentsPrev: number
  customers: number
  customersPrev: number
  ltvTotal: number
  ltvTotalPrev: number
  avgLtv: number
  avgLtvPrev: number
}

export interface JourneyEvent {
  type: 'page_visit' | 'whatsapp_message' | 'meta_message' | 'contact_created' | 'appointment' | 'payment'
  date: string
  data: Record<string, any>
}

interface ContactChartData {
  date: string
  count: number
}

export interface ContactsPagination {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export interface ContactsPageResult {
  contacts: Contact[]
  pagination: ContactsPagination
}

interface ContactsPageParams {
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC'
  signal?: AbortSignal
}

const normalizeContact = <T extends Record<string, any>>(contact: T): T => {
  if (!contact || typeof contact !== 'object') {
    return contact
  }

  const result = { ...contact } as T & Record<string, any>

  if (typeof (result as any).name === 'string') {
    (result as any).name = formatName((result as any).name)
  }

  if (typeof (result as any).full_name === 'string') {
    (result as any).full_name = formatName((result as any).full_name)
  }

  if (typeof (result as any).fullName === 'string') {
    (result as any).fullName = formatName((result as any).fullName)
  }

  if (typeof (result as any).contactName === 'string') {
    (result as any).contactName = formatName((result as any).contactName)
  }

  return result
}

const getAuthHeaders = () => {
  const headers = new Headers()

  try {
    const token = localStorage.getItem('auth_token')
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
  } catch {
    // Local storage can be unavailable during early hydration.
  }

  return headers
}

const requestContactsPage = async ({
  startDate,
  endDate,
  page = 1,
  limit = 100,
  sortBy = 'created_at',
  sortOrder = 'DESC',
  signal
}: ContactsPageParams = {}): Promise<ContactsPageResult> => {
  const params = new URLSearchParams()
  params.append('page', String(page))
  params.append('limit', String(limit))
  params.append('sortBy', sortBy)
  params.append('sortOrder', sortOrder)
  if (startDate) params.append('startDate', startDate)
  if (endDate) params.append('endDate', endDate)

  const url = `${import.meta.env.VITE_API_URL || ''}/api/contacts?${params.toString()}`
  const response = await fetch(url, {
    headers: getAuthHeaders(),
    signal
  })

  if (!response.ok) {
    throw new Error(`No se pudieron cargar los contactos (${response.status})`)
  }

  const json = await response.json()
  const contacts = Array.isArray(json?.data) ? json.data as Contact[] : []
  const pagination = json?.pagination || {}

  return {
    contacts: dedupeContacts<Contact>(contacts).map(normalizeContact),
    pagination: {
      page: Number(pagination.page || page),
      limit: Number(pagination.limit || limit),
      total: Number(pagination.total || contacts.length),
      totalPages: Number(pagination.totalPages || 1),
      hasNext: Boolean(pagination.hasNext),
      hasPrev: Boolean(pagination.hasPrev)
    }
  }
}

export const contactsService = {
  getContactsPage(params: ContactsPageParams = {}): Promise<ContactsPageResult> {
    return requestContactsPage(params)
  },

  async getContacts(startDate?: string, endDate?: string): Promise<Contact[]> {
    try {
      const MAX_PAGES = 100
      let allContacts: Contact[] = []
      let page = 1
      let hasMore = true

      while (hasMore && page <= MAX_PAGES) {
        const result = await requestContactsPage({
          startDate,
          endDate,
          page,
          limit: 250
        })

        allContacts = allContacts.concat(result.contacts)
        hasMore = result.pagination.hasNext && result.contacts.length > 0
        page++
      }

      return dedupeContacts<Contact>(allContacts).map(normalizeContact)
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async searchContacts(searchTerm: string, signal?: AbortSignal): Promise<Contact[]> {
    try {
      const data = await apiClient.get<Contact[]>('/contacts/search', {
        params: { q: searchTerm },
        signal
      })
      const results = Array.isArray(data) ? data : []
      return dedupeContacts<Contact>(results).map(normalizeContact)
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async getStats(startDate?: string, endDate?: string): Promise<ContactStats> {
    try {
      const params: any = {}
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate

      const data = await apiClient.get<ContactStats>('/contacts/stats', { params })
      return data
    } catch (error) {
      // TODO: Implement proper logging service
      return {
        total: 0,
        totalPrev: 0,
        withAppointments: 0,
        withAppointmentsPrev: 0,
        customers: 0,
        customersPrev: 0,
        ltvTotal: 0,
        ltvTotalPrev: 0,
        avgLtv: 0,
        avgLtvPrev: 0
      }
    }
  },

  async createContact(contact: Partial<Omit<Contact, 'id' | 'createdAt' | 'ltv' | 'purchases'>>): Promise<Contact> {
    try {
      // Crear fecha en UTC
      const now = new Date()
      const utcDate = now.toISOString()

      const response = await apiClient.post('/contacts', {
        ...contact,
        status: contact.status || 'lead',
        ltv: 0,
        purchases: 0,
        createdAt: utcDate // Guardar en formato ISO UTC
      })
      return normalizeContact(response as Contact)
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  },

  async updateContact(id: string, contact: Partial<Contact>): Promise<Contact> {
    const data = await apiClient.put<Contact>(`/contacts/${id}`, contact)
    return normalizeContact(data)
  },

  async deleteContact(id: string): Promise<void> {
    await apiClient.delete(`/contacts/${id}`)
  },

  async getContactDetails(id: string): Promise<Contact> {
    const data = await apiClient.get<Contact>(`/contacts/${id}`)
    return normalizeContact(data)
  },

  async getContactJourney(id: string): Promise<JourneyEvent[]> {
    try {
      const data = await apiClient.get<JourneyEvent[]>(`/contacts/${id}/journey`)

      if (!Array.isArray(data)) {
        return []
      }

      return data
        .filter((event): event is JourneyEvent => {
          return Boolean(
            event &&
            typeof event === 'object' &&
            'type' in event &&
            'date' in event
          )
        })
        // Normalizar eventos incompletos para evitar errores en la UI
        .map((event) => ({
          ...event,
          data: event && typeof event.data === 'object' && event.data !== null ? event.data : {}
        }))
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  getCustomFieldDefinitions(params: { includeArchived?: boolean } = {}) {
    return apiClient.get<ContactCustomFieldDefinition[]>('/contacts/custom-fields', {
      params: params.includeArchived ? { includeArchived: 'true' } : undefined
    })
  },

  createCustomFieldDefinition(payload: Partial<ContactCustomFieldDefinition>) {
    return apiClient.post<ContactCustomFieldDefinition>('/contacts/custom-fields', payload)
  },

  updateCustomFieldDefinition(definitionId: string, payload: Partial<ContactCustomFieldDefinition>) {
    return apiClient.put<ContactCustomFieldDefinition>(`/contacts/custom-fields/${definitionId}`, payload)
  },

  async getContactsChart(startDate?: string, endDate?: string): Promise<ContactChartData[]> {
    try {
      const params: any = {}
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate

      const data = await apiClient.get<ContactChartData[]>('/contacts/chart', { params })
      return Array.isArray(data) ? data : []
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  calculateDelta(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0
    return ((current - previous) / previous) * 100
  }
}
