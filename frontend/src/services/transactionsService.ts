import apiClient from './apiClient'

export interface Transaction {
  id: string
  date: string
  contactId?: string
  contactName: string
  email: string
  phone?: string
  amount: number
  currency?: string
  method: 'card' | 'transfer' | 'cash' | 'paypal' | 'other' | 'bank_transfer' | 'check'
  status: 'draft' | 'sent' | 'paid' | 'pending' | 'overdue' | 'partial' | 'void' | 'refunded' | 'failed' | 'deleted'
  paymentMode?: 'live' | 'test'
  reference?: string
  description?: string
  createdAt?: string
  updatedAt?: string
  invoiceId?: string
  invoiceNumber?: string
  dueDate?: string
  sentAt?: string
}

export interface TransactionSummary {
  totalRevenue: number
  totalRevenuePrev: number
  completedPayments: number
  completedPaymentsPrev: number
  averageTicket: number
  averageTicketPrev: number
  refunds: number
  refundsPrev: number
}

export interface PaymentPlan {
  id: string
  name: string
  title?: string
  status: string
  total: number
  currency?: string
  contactId?: string
  contactName?: string
  email?: string
  phone?: string
  description?: string
  startDate?: string
  nextRunAt?: string
  endDate?: string
  recurrenceLabel?: string
  liveMode?: boolean
  itemCount?: number
  createdAt?: string
  updatedAt?: string
  sortDate?: string
  raw?: Record<string, any>
}

export const transactionsService = {
  async getTransactions(startDate?: string, endDate?: string, forceSync?: boolean): Promise<Transaction[]> {
    try {
      const params: Record<string, string> = {}
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate
      // Forzar sincronización cuando se especifica (después de crear invoice)
      if (forceSync) params.sync = 'true'

      const data = await apiClient.get<Transaction[]>('/transactions', {
        params
      })
      return data
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async getTransaction(id: string): Promise<Transaction> {
    return await apiClient.get<Transaction>(`/transactions/${id}`)
  },

  async getSummary(startDate?: string, endDate?: string): Promise<TransactionSummary> {
    try {
      const params: Record<string, string> = {}
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate

      const data = await apiClient.get<TransactionSummary>('/transactions/summary', {
        params
      })

      return data
    } catch (error) {
      return {
        totalRevenue: 0,
        totalRevenuePrev: 0,
        completedPayments: 0,
        completedPaymentsPrev: 0,
        averageTicket: 0,
        averageTicketPrev: 0,
        refunds: 0,
        refundsPrev: 0
      }
    }
  },

  async createTransaction(transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>): Promise<Transaction> {
    const data = await apiClient.post<Transaction>('/transactions', transaction)
    return data
  },

  async updateTransaction(id: string, transaction: Partial<Transaction>): Promise<Transaction> {
    const data = await apiClient.put<Transaction>(`/transactions/${id}`, transaction)
    return data
  },

  async deleteTransaction(id: string): Promise<void> {
    await apiClient.delete(`/transactions/${id}`)
  },

  async voidTransaction(id: string): Promise<void> {
    await apiClient.post(`/transactions/${id}/void`, {})
  },

  async recordPayment(id: string, data: { amount: number; paymentDate: string; paymentMethod: string }): Promise<void> {
    await apiClient.post(`/transactions/${id}/record-payment`, data)
  },

  async sendTransaction(id: string): Promise<void> {
    await apiClient.post(`/transactions/${id}/send`, {})
  },

  async getPaymentLink(id: string): Promise<string> {
    const response = await apiClient.get<{ link: string }>(`/transactions/${id}/payment-link`)
    return response.link
  },

  async getPaymentPlans(): Promise<PaymentPlan[]> {
    const data = await apiClient.get<PaymentPlan[]>('/highlevel/invoices/schedules')
    return data
  },

  async getPaymentPlan(id: string): Promise<PaymentPlan> {
    const data = await apiClient.get<PaymentPlan>(`/highlevel/invoices/schedules/${id}`)
    return data
  },

  async createPaymentPlan(payload: Record<string, any>): Promise<PaymentPlan> {
    const data = await apiClient.post<PaymentPlan>('/highlevel/invoices/schedules', {
      payload,
      scheduleNow: true
    })
    return data
  },

  async updatePaymentPlan(id: string, payload: Record<string, any>): Promise<PaymentPlan> {
    const data = await apiClient.put<PaymentPlan>(`/highlevel/invoices/schedules/${id}`, {
      payload,
      updateAndSchedule: true
    })
    return data
  },

  async actionPaymentPlan(id: string, action: string, payload: Record<string, any> = {}): Promise<PaymentPlan> {
    const data = await apiClient.post<PaymentPlan>(`/highlevel/invoices/schedules/${id}/action`, {
      action,
      payload
    })
    return data
  },

  calculateDelta(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0
    return ((current - previous) / previous) * 100
  }
}
