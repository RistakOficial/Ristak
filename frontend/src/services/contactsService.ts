import type { Contact as ContactType, ContactCustomField, ContactCustomFieldDefinition } from '@/types'
import { dedupeContacts } from '@/utils/contactDedup'
import { formatName } from '@/utils/format'
import { apiUrl } from './apiBaseUrl'
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
  type: 'page_visit' | 'video_playback' | 'whatsapp_message' | 'meta_message' | 'email_message' | 'contact_created' | 'appointment' | 'appointment_confirmation' | 'payment'
  date: string
  data: Record<string, any>
}

interface ContactJourneyOptions {
  includeBusinessMessages?: boolean
  refreshExternalStatuses?: boolean
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

export type PaymentLinkDeliveryChannelKey = 'whatsapp' | 'messenger' | 'email'

export interface PaymentLinkDeliveryChannel {
  key: PaymentLinkDeliveryChannelKey
  label: string
  available: boolean
  connected: boolean
  value: string
  reason?: string
}

export interface PaymentLinkDeliveryOptions {
  contact: {
    id: string
    name: string
    email: string
    phone: string
  }
  channels: Record<PaymentLinkDeliveryChannelKey, PaymentLinkDeliveryChannel>
}

interface ContactsPageParams {
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
  search?: string
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC'
  signal?: AbortSignal
}

const normalizeContact = <T extends Record<string, any>>(contact: T): T => {
  if (!contact || typeof contact !== 'object') {
    return contact
  }

  const result = { ...contact } as T & Record<string, any>

  const hasName = typeof (result as any).name === 'string'
  const hasFullName = typeof (result as any).full_name === 'string'

  if (hasName) {
    (result as any).name = formatName((result as any).name)
  }

  if (hasFullName) {
    (result as any).full_name = formatName((result as any).full_name)
  }

  if (!hasName && hasFullName) {
    (result as any).name = (result as any).full_name
  }

  if (typeof (result as any).fullName === 'string') {
    (result as any).fullName = formatName((result as any).fullName)
  }

  if (typeof (result as any).contactName === 'string') {
    (result as any).contactName = formatName((result as any).contactName)
  }

  const rawPhones = Array.isArray((result as any).phones)
    ? (result as any).phones
    : Array.isArray((result as any).phoneNumbers)
      ? (result as any).phoneNumbers
      : []
  const phonesByValue = new Map<string, Record<string, any>>()
  const addPhone = (entry: Record<string, any>) => {
    const phone = String(entry?.phone || '').trim()
    if (!phone || phonesByValue.has(phone)) return
    const isPrimary = Boolean(entry?.isPrimary || entry?.is_primary || phone === String((result as any).phone || '').trim())
    const label = isPrimary
      ? 'Principal'
      : entry?.label && entry.label !== 'Principal'
        ? entry.label
        : 'Adicional'
    phonesByValue.set(phone, {
      ...entry,
      id: entry?.id || phone,
      phone,
      label,
      isPrimary,
      is_primary: isPrimary
    })
  }

  if (typeof (result as any).phone === 'string' && (result as any).phone.trim()) {
    addPhone({
      id: `${(result as any).id || 'contact'}-primary-phone`,
      phone: (result as any).phone,
      label: 'Principal',
      isPrimary: true
    })
  }
  rawPhones.forEach(addPhone)

  const phones = Array.from(phonesByValue.values()).sort((left, right) => {
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1
    return String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
  })
  ;(result as any).phones = phones
  ;(result as any).phoneNumbers = phones

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
  search,
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
  if (search) params.append('search', search)

  const url = apiUrl(`/api/contacts?${params.toString()}`)
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
    const payload: Record<string, unknown> = { ...contact }
    if (Object.prototype.hasOwnProperty.call(payload, 'name') && !Object.prototype.hasOwnProperty.call(payload, 'full_name')) {
      payload.full_name = payload.name
    }

    const data = await apiClient.put<Contact>(`/contacts/${id}`, payload)
    return normalizeContact(data)
  },

  async deleteContact(id: string): Promise<void> {
    await apiClient.delete(`/contacts/${id}`)
  },

  async getContactDetails(id: string): Promise<Contact> {
    const data = await apiClient.get<Contact>(`/contacts/${id}`)
    return normalizeContact(data)
  },

  getPaymentLinkDeliveryOptions(contactId: string): Promise<PaymentLinkDeliveryOptions> {
    return apiClient.get<PaymentLinkDeliveryOptions>(`/contacts/${encodeURIComponent(contactId)}/payment-link-delivery-options`)
  },

  async getContactJourney(id: string, options: ContactJourneyOptions = {}): Promise<JourneyEvent[]> {
    try {
      const params: Record<string, string> = {}
      if (options.includeBusinessMessages) params.includeBusinessMessages = 'true'
      if (options.refreshExternalStatuses === false) params.refreshExternalStatuses = 'false'

      const data = await apiClient.get<JourneyEvent[]>(`/contacts/${id}/journey`, {
        params: Object.keys(params).length > 0 ? params : undefined
      })

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

  bulkUpdateCustomFields(contactIds: string[], customFields: ContactCustomField[]) {
    return apiClient.post<{ updated: number; total: number; customFields: ContactCustomField[] }>('/contacts/bulk/custom-fields', {
      contactIds,
      customFields
    })
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
