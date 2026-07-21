import type { Contact as ContactType, ContactCustomField, ContactCustomFieldDefinition } from '@/types'
import { parseSortableDateValue } from '@/utils/dateSort'
import { formatName } from '@/utils/format'
import { apiUrl } from './apiBaseUrl'
import apiClient from './apiClient'
import { withRequestTimeout } from './requestTimeout'

const CONTACTS_VIEW_REQUEST_TIMEOUT_MS = 20_000

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
  cursorDate?: string
  cursorKey?: string
  data: Record<string, any>
}

export interface JourneyMessageCursor {
  beforeMessageDate: string
  beforeMessageCursor: string
}

interface ContactJourneyOptions {
  refreshExternalStatuses?: boolean
  throwOnError?: boolean
  chatActivityOnly?: boolean
  limit?: number
  beforeEventDate?: string
  beforeEventCursor?: string
  signal?: AbortSignal
}

interface ContactConversationOptions {
  refreshExternalStatuses?: boolean
  messageLimit?: number
  beforeMessageDate?: string
  beforeMessageCursor?: string
  throwOnError?: boolean
  signal?: AbortSignal
}

interface ContactDetailsOptions {
  signal?: AbortSignal
  includeChildren?: boolean
  // Compatibilidad de firma: los GET son local-only aunque un consumidor viejo
  // todavía mande estas banderas.
  warmProfilePictures?: boolean
  refreshExternalAppointments?: boolean
}

export interface ContactChildPagination {
  mode: 'cursor'
  limit: number
  hasNext: boolean
  nextCursor: string | null
}

export interface ContactPaymentsPage {
  payments: NonNullable<Contact['payments']>
  pagination: ContactChildPagination
}

export interface ContactAppointmentsPage {
  appointments: NonNullable<Contact['appointments']>
  pagination: ContactChildPagination
}

interface ChatReadStateResult {
  contactId?: string
  contactIds?: string[]
  unreadCount?: number
  lastReadAt?: string | null
  updated?: number
}

export interface ContactConversationalChannelPreference {
  contactId: string
  channel: 'whatsapp' | 'sms'
  selectedAt?: string | null
  selectedByUserId?: string | null
  source?: string
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

function getCursorSubMillisecond(value: string) {
  const match = value.match(/\.(\d{1,9})/)
  if (!match) return 0
  return Number(`${match[1]}000000`.slice(3, 6)) || 0
}

export function compareLosslessTimestampCursorTuples(
  leftDate: string,
  leftKey: string,
  rightDate: string,
  rightKey: string
) {
  const timestampDifference = parseSortableDateValue(leftDate) - parseSortableDateValue(rightDate)
  if (timestampDifference !== 0) return timestampDifference

  const subMillisecondDifference = getCursorSubMillisecond(leftDate) - getCursorSubMillisecond(rightDate)
  if (subMillisecondDifference !== 0) return subMillisecondDifference

  if (leftKey === rightKey) return 0
  return leftKey < rightKey ? -1 : 1
}

interface NormalizedNumericCursor {
  sign: -1 | 0 | 1
  integer: string
  fraction: string
}

function normalizeNumericCursor(value: unknown): NormalizedNumericCursor | null {
  const raw = String(value ?? '').trim()
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/)
  if (!match) return null

  const integer = match[2].replace(/^0+(?=\d)/, '')
  const fraction = String(match[3] || '').replace(/0+$/, '')
  const isZero = /^0+$/.test(integer) && fraction.length === 0
  return {
    sign: isZero ? 0 : match[1] === '-' ? -1 : 1,
    integer,
    fraction
  }
}

export function compareLosslessNumericCursorValues(left: unknown, right: unknown): number | null {
  const normalizedLeft = normalizeNumericCursor(left)
  const normalizedRight = normalizeNumericCursor(right)
  if (!normalizedLeft || !normalizedRight) return null
  if (normalizedLeft.sign !== normalizedRight.sign) {
    return normalizedLeft.sign < normalizedRight.sign ? -1 : 1
  }
  if (normalizedLeft.sign === 0) return 0

  let magnitudeDifference = normalizedLeft.integer.length - normalizedRight.integer.length
  if (magnitudeDifference === 0 && normalizedLeft.integer !== normalizedRight.integer) {
    magnitudeDifference = normalizedLeft.integer < normalizedRight.integer ? -1 : 1
  }
  if (magnitudeDifference === 0) {
    const fractionWidth = Math.max(normalizedLeft.fraction.length, normalizedRight.fraction.length)
    const leftFraction = normalizedLeft.fraction.padEnd(fractionWidth, '0')
    const rightFraction = normalizedRight.fraction.padEnd(fractionWidth, '0')
    if (leftFraction !== rightFraction) magnitudeDifference = leftFraction < rightFraction ? -1 : 1
  }

  return normalizedLeft.sign === -1 ? -magnitudeDifference : magnitudeDifference
}

function compareJourneyCursorTuple(
  left: JourneyMessageCursor,
  right: JourneyMessageCursor
) {
  return compareLosslessTimestampCursorTuples(
    left.beforeMessageDate,
    left.beforeMessageCursor,
    right.beforeMessageDate,
    right.beforeMessageCursor
  )
}

export function getOldestJourneyMessageCursor(events: JourneyEvent[]): JourneyMessageCursor | null {
  let oldest: JourneyMessageCursor | null = null

  events.forEach((event) => {
    const beforeMessageDate = String(event.cursorDate || event.date || '').trim()
    const beforeMessageCursor = String(event.cursorKey || '').trim()
    if (!beforeMessageDate || !beforeMessageCursor) return

    const candidate = { beforeMessageDate, beforeMessageCursor }
    if (!oldest || compareJourneyCursorTuple(candidate, oldest) < 0) {
      oldest = candidate
    }
  })

  return oldest
}

interface ContactChartData {
  date: string
  count: number
}

export interface ContactsPagination {
  page: number
  limit: number
  total: number | null
  totalPages: number | null
  hasNext: boolean
  hasPrev: boolean
  nextCursor: string | null
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
  pagination?: 'cursor' | 'offset'
  cursor?: string | null
  signal?: AbortSignal
}

interface ContactStatsParams {
  startDate?: string
  endDate?: string
  search?: string
  filter?: string
  trackingFilters?: Record<string, string[]>
  advancedFilters?: unknown
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
  pagination: paginationMode = 'cursor',
  cursor,
  signal
}: ContactsPageParams = {}): Promise<ContactsPageResult> => {
  const params = new URLSearchParams()
  params.append('page', String(page))
  params.append('limit', String(limit))
  params.append('sortBy', sortBy)
  params.append('sortOrder', sortOrder)
  params.append('pagination', paginationMode)
  if (cursor) params.append('cursor', cursor)
  appendContactsQueryParams(params, { startDate, endDate, search, filter, trackingFilters, advancedFilters })
  if (warmProfilePictures) params.append('warmProfilePictures', 'true')

  const url = apiUrl(`/api/contacts?${params.toString()}`)
  const json = await withRequestTimeout({
    timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'Los contactos tardaron demasiado. Reintenta la carga.',
    signal,
    request: async requestSignal => {
      const response = await fetch(url, {
        headers: getAuthHeaders(),
        signal: requestSignal
      })

      if (!response.ok) {
        throw new Error(`No se pudieron cargar los contactos (${response.status})`)
      }

      return response.json()
    }
  })
  const contacts = Array.isArray(json?.data) ? json.data as Contact[] : []
  const pagination = json?.pagination || {}

  return {
    contacts: contacts.map(normalizeContact),
    pagination: {
      page: Number(pagination.page || page),
      limit: Number(pagination.limit || limit),
      total: pagination.total === null || pagination.total === undefined ? null : Number(pagination.total),
      totalPages: pagination.totalPages === null || pagination.totalPages === undefined ? null : Number(pagination.totalPages),
      hasNext: Boolean(pagination.hasNext),
      hasPrev: Boolean(pagination.hasPrev),
      nextCursor: typeof pagination.nextCursor === 'string' && pagination.nextCursor ? pagination.nextCursor : null
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
      let cursor: string | null = null
      let hasMore = true

      while (hasMore && page <= MAX_PAGES) {
        const result = await requestContactsPage({
          startDate,
          endDate,
          page,
          limit: 250,
          pagination: 'cursor',
          cursor
        })

        allContacts = allContacts.concat(result.contacts)
        hasMore = result.pagination.hasNext && result.contacts.length > 0
        cursor = result.pagination.nextCursor
        if (hasMore && !cursor) break
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

      const data = await apiClient.get<ContactStats>('/contacts/stats', {
        params: Object.fromEntries(params.entries()),
        signal: input.signal
      })
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

  async getConversationalChannelPreference(id: string): Promise<ContactConversationalChannelPreference | null> {
    return apiClient.get<ContactConversationalChannelPreference | null>(
      `/contacts/${encodeURIComponent(id)}/chat-channel-preference`
    )
  },

  async updateConversationalChannelPreference(
    id: string,
    channel: ContactConversationalChannelPreference['channel']
  ): Promise<ContactConversationalChannelPreference> {
    return apiClient.put<ContactConversationalChannelPreference>(
      `/contacts/${encodeURIComponent(id)}/chat-channel-preference`,
      { channel }
    )
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
    if (options.includeChildren) params.includeChildren = 'true'

    const data = await withRequestTimeout({
      timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'El contacto tardó demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<Contact>(`/contacts/${id}`, {
        params: Object.keys(params).length > 0 ? params : undefined,
        signal: requestSignal
      })
    })
    return normalizeContact(data)
  },

  async getContactPaymentsPage(
    id: string,
    options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}
  ): Promise<ContactPaymentsPage> {
    const data = await withRequestTimeout({
      timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'Los pagos del contacto tardaron demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<{ payments?: Contact['payments']; pagination?: Partial<ContactChildPagination> }>(`/contacts/${id}/payments`, {
        params: {
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: String(options.limit) } : {})
        },
        signal: requestSignal
      })
    })
    return {
      payments: Array.isArray(data?.payments) ? data.payments : [],
      pagination: {
        mode: 'cursor',
        limit: Number(data?.pagination?.limit || options.limit || 20),
        hasNext: Boolean(data?.pagination?.hasNext),
        nextCursor: data?.pagination?.nextCursor || null
      }
    }
  },

  async getContactAppointmentsPage(
    id: string,
    options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}
  ): Promise<ContactAppointmentsPage> {
    const data = await withRequestTimeout({
      timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'Las citas del contacto tardaron demasiado. Reintenta la carga.',
      signal: options.signal,
      request: requestSignal => apiClient.get<{ appointments?: Contact['appointments']; pagination?: Partial<ContactChildPagination> }>(`/contacts/${id}/appointments`, {
        params: {
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: String(options.limit) } : {})
        },
        signal: requestSignal
      })
    })
    return {
      appointments: Array.isArray(data?.appointments) ? data.appointments : [],
      pagination: {
        mode: 'cursor',
        limit: Number(data?.pagination?.limit || options.limit || 20),
        hasNext: Boolean(data?.pagination?.hasNext),
        nextCursor: data?.pagination?.nextCursor || null
      }
    }
  },

  refreshContactExternalData(id: string, sections?: Array<'profile' | 'appointments' | 'conversationStatuses'>) {
    return apiClient.post(`/contacts/${id}/refresh`, sections ? { sections } : {})
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
      if (options.chatActivityOnly) params.chatActivityOnly = 'true'
      if (options.limit) params.limit = String(options.limit)
      if (options.beforeEventDate) params.beforeEventDate = options.beforeEventDate
      if (options.beforeEventCursor) params.beforeEventCursor = options.beforeEventCursor

      const data = await withRequestTimeout({
        timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'La actividad del contacto tardó demasiado. Reintenta la carga.',
        signal: options.signal,
        request: requestSignal => apiClient.get<JourneyEvent[]>(`/contacts/${id}/journey`, {
          params: Object.keys(params).length > 0 ? params : undefined,
          signal: requestSignal
        })
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
      if (options.messageLimit && Number.isFinite(options.messageLimit) && options.messageLimit > 0) {
        params.messageLimit = String(Math.round(options.messageLimit))
      }
      if (options.beforeMessageDate) params.beforeMessageDate = options.beforeMessageDate
      if (options.beforeMessageCursor) params.beforeMessageCursor = options.beforeMessageCursor

      const data = await withRequestTimeout({
        timeoutMs: CONTACTS_VIEW_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'La conversación tardó demasiado. Reintenta la carga.',
        signal: options.signal,
        request: requestSignal => apiClient.get<JourneyEvent[]>(`/contacts/${id}/conversation`, {
          params: Object.keys(params).length > 0 ? params : undefined,
          signal: requestSignal
        })
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
