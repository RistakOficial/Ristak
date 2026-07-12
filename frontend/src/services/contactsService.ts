import type { Contact as ContactType, ContactCustomField, ContactCustomFieldDefinition } from '@/types'
import { parseSortableDateValue } from '@/utils/dateSort'
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
  refreshExternalStatuses?: boolean
  throwOnError?: boolean
  chatActivityOnly?: boolean
}

interface ContactConversationOptions {
  refreshExternalStatuses?: boolean
  messageLimit?: number
  beforeMessageDate?: string
  throwOnError?: boolean
}

interface ContactDetailsOptions {
  warmProfilePictures?: boolean
  refreshExternalAppointments?: boolean
}

interface ChatReadStateResult {
  contactId?: string
  contactIds?: string[]
  unreadCount?: number
  lastReadAt?: string | null
  updated?: number
}

function normalizeJourneyEvents(data: unknown): JourneyEvent[] {
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

export type PaymentLinkDeliveryChannelKey = 'whatsapp' | 'messenger' | 'instagram' | 'email'

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
  filter?: string
  trackingFilters?: Record<string, string[]>
  advancedFilters?: unknown
  warmProfilePictures?: boolean
  signal?: AbortSignal
}

interface ContactStatsParams {
  startDate?: string
  endDate?: string
  search?: string
  filter?: string
  trackingFilters?: Record<string, string[]>
  advancedFilters?: unknown
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
    return parseSortableDateValue(left.createdAt) - parseSortableDateValue(right.createdAt)
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

const appendContactsQueryParams = (
  params: URLSearchParams,
  {
    startDate,
    endDate,
    search,
    filter,
    trackingFilters,
    advancedFilters
  }: Pick<ContactsPageParams, 'startDate' | 'endDate' | 'search' | 'filter' | 'trackingFilters' | 'advancedFilters'>
) => {
  if (startDate) params.append('startDate', startDate)
  if (endDate) params.append('endDate', endDate)
  if (search) params.append('search', search)
  if (filter && filter !== 'all') params.append('filter', filter)
  if (trackingFilters && Object.values(trackingFilters).some(values => values.length > 0)) {
    params.append('trackingFilters', JSON.stringify(trackingFilters))
  }
  if (advancedFilters) {
    params.append('advancedFilters', JSON.stringify(advancedFilters))
  }
}

const requestContactsPage = async ({
  startDate,
  endDate,
  page = 1,
  limit = 100,
  search,
  sortBy = 'created_at',
  sortOrder = 'DESC',
  filter,
  trackingFilters,
  advancedFilters,
  warmProfilePictures,
  signal
}: ContactsPageParams = {}): Promise<ContactsPageResult> => {
  const params = new URLSearchParams()
  params.append('page', String(page))
  params.append('limit', String(limit))
  params.append('sortBy', sortBy)
  params.append('sortOrder', sortOrder)
  appendContactsQueryParams(params, { startDate, endDate, search, filter, trackingFilters, advancedFilters })
  if (warmProfilePictures) params.append('warmProfilePictures', 'true')

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
    contacts: contacts.map(normalizeContact),
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

      return allContacts.map(normalizeContact)
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
      return results.map(normalizeContact)
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async getStats(startOrParams?: string | ContactStatsParams, endDate?: string): Promise<ContactStats> {
    try {
      const input = typeof startOrParams === 'object'
        ? startOrParams
        : { startDate: startOrParams, endDate }
      const params = new URLSearchParams()
      appendContactsQueryParams(params, input)

      const data = await apiClient.get<ContactStats>('/contacts/stats', { params: Object.fromEntries(params.entries()) })
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

  async updateContact(id: string, contact: Partial<Contact>, options?: { confirmMerge?: boolean }): Promise<Contact> {
    const payload: Record<string, unknown> = { ...contact }
    if (Object.prototype.hasOwnProperty.call(payload, 'name') && !Object.prototype.hasOwnProperty.call(payload, 'full_name')) {
      payload.full_name = payload.name
    }
    // (CNT-001) confirmMerge=true autoriza la fusión cuando el teléfono/email ya
    // pertenece a otro contacto (el backend devuelve 409 sin esta bandera).
    if (options?.confirmMerge) payload.confirmMerge = true

    const data = await apiClient.put<Contact>(`/contacts/${id}`, payload)
    return normalizeContact(data)
  },

  async deleteContact(id: string): Promise<void> {
    await apiClient.delete(`/contacts/${id}`)
  },

  // (CNT-007) Papelera de contactos: listar, restaurar y borrar permanentemente.
  async getTrashedContacts(): Promise<Array<{ id: string; full_name?: string | null; email?: string | null; phone?: string | null; deleted_at?: string | null; total_paid?: number; purchases_count?: number }>> {
    const data = await apiClient.get<{ contacts?: any[] }>('/contacts/trash')
    return (data?.contacts ?? []) as any
  },

  async restoreContact(id: string): Promise<void> {
    await apiClient.post(`/contacts/${id}/restore`)
  },

  async permanentlyDeleteContact(id: string): Promise<void> {
    await apiClient.delete(`/contacts/${id}/permanent`)
  },

  async getContactDetails(id: string, options: ContactDetailsOptions = {}): Promise<Contact> {
    const params: Record<string, string> = {}
    if (options.warmProfilePictures === false) params.warmProfilePictures = 'false'
    if (options.refreshExternalAppointments === false) params.refreshExternalAppointments = 'false'

    const data = await apiClient.get<Contact>(`/contacts/${id}`, {
      params: Object.keys(params).length > 0 ? params : undefined
    })
    return normalizeContact(data)
  },

  getPaymentLinkDeliveryOptions(contactId: string): Promise<PaymentLinkDeliveryOptions> {
    return apiClient.get<PaymentLinkDeliveryOptions>(`/contacts/${encodeURIComponent(contactId)}/payment-link-delivery-options`)
  },

  markChatRead(contactId: string): Promise<ChatReadStateResult> {
    return apiClient.post<ChatReadStateResult>(`/contacts/chats/${encodeURIComponent(contactId)}/read`, {})
  },

  markChatsRead(contactIds: string[]): Promise<ChatReadStateResult> {
    return apiClient.post<ChatReadStateResult>('/contacts/chats/read', { contactIds })
  },

  async getContactJourney(id: string, options: ContactJourneyOptions = {}): Promise<JourneyEvent[]> {
    try {
      const params: Record<string, string> = {}
      if (options.refreshExternalStatuses === false) params.refreshExternalStatuses = 'false'
      if (options.chatActivityOnly) params.chatActivityOnly = 'true'

      const data = await apiClient.get<JourneyEvent[]>(`/contacts/${id}/journey`, {
        params: Object.keys(params).length > 0 ? params : undefined
      })

      return normalizeJourneyEvents(data)
    } catch (error) {
      // TODO: Implement proper logging service
      if (options.throwOnError) throw error
      return []
    }
  },

  async getContactConversation(id: string, options: ContactConversationOptions = {}): Promise<JourneyEvent[]> {
    try {
      const params: Record<string, string> = {}
      if (options.refreshExternalStatuses === false) params.refreshExternalStatuses = 'false'
      if (options.messageLimit && Number.isFinite(options.messageLimit) && options.messageLimit > 0) {
        params.messageLimit = String(Math.round(options.messageLimit))
      }
      if (options.beforeMessageDate) params.beforeMessageDate = options.beforeMessageDate

      const data = await apiClient.get<JourneyEvent[]>(`/contacts/${id}/conversation`, {
        params: Object.keys(params).length > 0 ? params : undefined
      })

      return normalizeJourneyEvents(data)
    } catch (error) {
      // TODO: Implement proper logging service
      if (options.throwOnError) throw error
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
