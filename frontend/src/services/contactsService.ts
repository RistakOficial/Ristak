import type { Contact as ContactType } from '@/types'
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

export const contactsService = {
  async getContacts(startDate?: string, endDate?: string): Promise<Contact[]> {
    try {
      // SIEMPRE paginar para traer TODOS los resultados (con o sin filtro)
      const MAX_PAGES = 100
      let allContacts: Contact[] = []
      let page = 1
      let hasMore = true

      while (hasMore && page <= MAX_PAGES) {
        // Construir URL con parámetros
        const params = new URLSearchParams()
        params.append('page', page.toString())
        params.append('limit', '100')
        if (startDate) params.append('startDate', startDate)
        if (endDate) params.append('endDate', endDate)

        const url = `${import.meta.env.VITE_API_URL || ''}/api/contacts?${params.toString()}`
        const response = await fetch(url)
        const json = await response.json()

        // El backend devuelve { success: true, data: [...], pagination: {...} }
        const contacts = (json.data || []) as Contact[]
        allContacts = allContacts.concat(contacts)

        // Verificar si hay más páginas
        const nextPageAvailable = Boolean(json.pagination?.hasNext)
        hasMore = nextPageAvailable && contacts.length > 0
        page++

        if (contacts.length === 0 && !nextPageAvailable) {
          break
        }
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
