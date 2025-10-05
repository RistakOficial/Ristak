import type { Contact as ContactType } from '@/types'
import { dedupeContacts } from '@/utils/contactDedup'
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

        const url = `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/api/contacts?${params.toString()}`
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

      if (page > MAX_PAGES) {
        console.warn('getContacts reached pagination safeguard limit. Verify backend pagination response.')
      }

      return dedupeContacts<Contact>(allContacts)
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async searchContacts(searchTerm: string): Promise<Contact[]> {
    try {
      const data = await apiClient.get<Contact[]>('/contacts/search', {
        params: { q: searchTerm }
      })
      const results = Array.isArray(data) ? data : []
      return dedupeContacts<Contact>(results)
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
      return response as Contact
    } catch (error) {
      // TODO: Implement proper logging service
      throw error
    }
  },

  async updateContact(id: string, contact: Partial<Contact>): Promise<Contact> {
    const data = await apiClient.put<Contact>(`/contacts/${id}`, contact)
    return data
  },

  async deleteContact(id: string): Promise<void> {
    await apiClient.delete(`/contacts/${id}`)
  },

  async getContactDetails(id: string): Promise<Contact> {
    const data = await apiClient.get<Contact>(`/contacts/${id}`)
    return data
  },

  calculateDelta(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0
    return ((current - previous) / previous) * 100
  }
}
