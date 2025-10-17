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
  method: 'card' | 'transfer' | 'cash' | 'paypal' | 'stripe' | 'other' | 'bank_transfer' | 'check'
  status: 'draft' | 'sent' | 'paid' | 'pending' | 'overdue' | 'partial' | 'void' | 'refunded' | 'failed' | 'deleted'
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

export const transactionsService = {
  async getTransactions(startDate?: string, endDate?: string): Promise<Transaction[]> {
    try {
      const params: Record<string, string> = {}
      if (startDate) params.startDate = startDate
      if (endDate) params.endDate = endDate

      const data = await apiClient.get<Transaction[]>('/transactions', {
        params
      })
      return data
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
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

  calculateDelta(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0
    return ((current - previous) / previous) * 100
  }
}