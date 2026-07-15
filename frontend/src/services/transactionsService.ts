import apiClient from './apiClient'
import { apiUrl } from './apiBaseUrl'
import { withRequestTimeout } from './requestTimeout'

const TRANSACTIONS_VIEW_REQUEST_TIMEOUT_MS = 20_000

export interface Transaction {
  id: string
  date: string
  contactId?: string
  contactName: string
  email: string
  phone?: string
  amount: number
  currency?: string
  method: 'card' | 'transfer' | 'cash' | 'paypal' | 'other' | 'bank_transfer' | 'check' | 'payment_link' | 'direct_card' | 'saved_card' | 'stripe' | 'stripe_saved_card' | 'stripe_link' | 'stripe_payment_link' | 'conekta' | 'conekta_saved_card' | 'conekta_subscription' | 'mercadopago' | 'mercadopago_checkout' | 'mercadopago_subscription' | 'clip' | 'clip_card' | 'clip_link' | 'clip_payment_link' | 'rebill' | 'rebill_checkout'
  status: 'draft' | 'sent' | 'paid' | 'pending' | 'pending_review' | 'rejected' | 'overdue' | 'partial' | 'void' | 'refunded' | 'failed' | 'deleted'
  paymentMode?: 'live' | 'test'
  paymentProvider?: 'manual' | 'highlevel' | 'stripe' | 'conekta' | 'mercadopago' | 'clip' | 'rebill' | 'gigstack' | string
  paymentMethodCategory?: string
  paymentMethodCategoryId?: string
  paymentType?: string
  paymentChannel?: string
  paymentChannelId?: string
  reference?: string
  title?: string
  description?: string
  createdAt?: string
  updatedAt?: string
  invoiceId?: string
  invoiceNumber?: string
  dueDate?: string
  sentAt?: string
  publicPaymentId?: string
  paymentUrl?: string
  stripePaymentIntentId?: string
  paidAt?: string
  metadata?: Record<string, unknown>
  transferProof?: {
    mediaUrl?: string | null
    receivedAt?: string | null
    bank?: string | null
    reference?: string | null
  } | null
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

export interface TransactionsPagination {
  page: number
  limit: number
  total: number | null
  totalPages: number | null
  hasNext: boolean
  hasPrev: boolean
  nextCursor: string | null
}

export interface CursorPagination {
  page: number
  limit: number
  total: number | null
  totalPages: number | null
  hasNext: boolean
  hasPrev: boolean
  nextCursor: string | null
}

export interface TransactionStatusFacet {
  value: string
  count: number
}

export interface TransactionsPageResult {
  transactions: Transaction[]
  pagination: TransactionsPagination
  facets: {
    statuses: TransactionStatusFacet[]
  }
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
  deleted?: boolean
  itemCount?: number
  completedItemCount?: number
  source?: 'ghl' | 'stripe' | 'rebill' | string
  createdAt?: string
  updatedAt?: string
  sortDate?: string
  raw?: Record<string, any>
}

export interface PaymentPlanSummary {
  total: number
  active: number
  inactive: number
  completed: number
}

export interface PaymentPlansPageResult {
  paymentPlans: PaymentPlan[]
  pagination: CursorPagination
  facets: {
    statuses: TransactionStatusFacet[]
  }
  summary: PaymentPlanSummary
}

interface PaymentPlansPageParams {
  page?: number
  cursor?: string | null
  limit?: number
  search?: string
  statuses?: string[]
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC' | 'asc' | 'desc'
  forceRefresh?: boolean
  signal?: AbortSignal
}

interface TransactionsPageParams {
  startDate?: string
  endDate?: string
  page?: number
  limit?: number
  cursor?: string | null
  search?: string
  statuses?: string[]
  sortBy?: string
  sortOrder?: 'ASC' | 'DESC' | 'asc' | 'desc'
  signal?: AbortSignal
}

interface TransactionSummaryParams {
  startDate?: string
  endDate?: string
  search?: string
  statuses?: string[]
  signal?: AbortSignal
}

interface CreateTransactionOptions {
  idempotencyKey?: string
}

const EMPTY_TRANSACTION_SUMMARY: TransactionSummary = {
  totalRevenue: 0,
  totalRevenuePrev: 0,
  completedPayments: 0,
  completedPaymentsPrev: 0,
  averageTicket: 0,
  averageTicketPrev: 0,
  refunds: 0,
  refundsPrev: 0
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

const appendTransactionQueryParams = (
  params: URLSearchParams,
  {
    startDate,
    endDate,
    search,
    statuses
  }: Pick<TransactionsPageParams, 'startDate' | 'endDate' | 'search' | 'statuses'>
) => {
  if (startDate) params.append('startDate', startDate)
  if (endDate) params.append('endDate', endDate)
  if (search?.trim()) params.append('q', search.trim())
  if (statuses?.length) params.append('status', statuses.join(','))
}

const requestTransactionsPage = async ({
  startDate,
  endDate,
  page = 1,
  limit = 50,
  cursor,
  search,
  statuses,
  sortBy = 'date',
  sortOrder = 'DESC',
  signal
}: TransactionsPageParams = {}): Promise<TransactionsPageResult> => {
  const params = new URLSearchParams()
  params.append('page', String(page))
  params.append('limit', String(limit))
  params.append('sortBy', sortBy)
  params.append('sortOrder', String(sortOrder).toUpperCase())
  params.append('pagination', 'cursor')
  if (cursor) params.append('cursor', cursor)
  appendTransactionQueryParams(params, { startDate, endDate, search, statuses })

  const json = await withRequestTimeout({
    timeoutMs: TRANSACTIONS_VIEW_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'Los pagos tardaron demasiado. Reintenta la carga.',
    signal,
    request: async requestSignal => {
      const response = await fetch(apiUrl(`/api/transactions?${params.toString()}`), {
        headers: getAuthHeaders(),
        signal: requestSignal
      })

      if (!response.ok) {
        throw new Error(`No se pudieron cargar los pagos (${response.status})`)
      }

      return response.json()
    }
  })
  const transactions = Array.isArray(json?.data) ? json.data as Transaction[] : []
  const pagination = json?.pagination || {}
  const facets = json?.facets || {}

  return {
    transactions,
    pagination: {
      page: Number(pagination.page || page),
      limit: Number(pagination.limit || limit),
      total: pagination.total === null || pagination.total === undefined ? null : Number(pagination.total),
      totalPages: pagination.totalPages === null || pagination.totalPages === undefined ? null : Number(pagination.totalPages),
      hasNext: Boolean(pagination.hasNext),
      hasPrev: Boolean(pagination.hasPrev),
      nextCursor: typeof pagination.nextCursor === 'string' && pagination.nextCursor ? pagination.nextCursor : null
    },
    facets: {
      statuses: Array.isArray(facets.statuses)
        ? facets.statuses.map((status: any) => ({
          value: String(status.value || '').trim().toLowerCase(),
          count: Number(status.count || 0)
        })).filter((status: TransactionStatusFacet) => status.value)
        : []
    }
  }
}

const requestPaymentPlansPage = async ({
  page = 1,
  cursor,
  limit = 20,
  search,
  statuses,
  sortBy = 'startDate',
  sortOrder = 'DESC',
  forceRefresh = false,
  signal
}: PaymentPlansPageParams = {}): Promise<PaymentPlansPageResult> => {
  const params = new URLSearchParams()
  params.append('page', String(page))
  if (cursor) params.append('cursor', cursor)
  params.append('limit', String(limit))
  params.append('sortBy', sortBy)
  params.append('sortOrder', String(sortOrder).toUpperCase())
  const cleanSearch = search?.trim() || ''
  if (cleanSearch.length >= 2) params.append('q', cleanSearch)
  if (statuses?.length) params.append('status', statuses.join(','))

  const json = await withRequestTimeout({
    timeoutMs: TRANSACTIONS_VIEW_REQUEST_TIMEOUT_MS,
    timeoutMessage: 'Los planes de pago tardaron demasiado. Reintenta la carga.',
    signal,
    request: async requestSignal => {
      const response = await fetch(apiUrl(`/api/transactions/payment-plans?${params.toString()}`), {
        headers: getAuthHeaders(),
        signal: requestSignal,
        ...(forceRefresh ? { cache: 'reload' as RequestCache } : {})
      })

      if (!response.ok) {
        throw new Error(`No se pudieron cargar los planes de pago (${response.status})`)
      }

      return response.json()
    }
  })
  const paymentPlans = Array.isArray(json?.data) ? json.data as PaymentPlan[] : []
  const pagination = json?.pagination || {}
  const facets = json?.facets || {}
  const summary = json?.summary || {}

  return {
    paymentPlans,
    pagination: {
      page: Number(pagination.page || page),
      limit: Number(pagination.limit || limit),
      total: pagination.total === null || pagination.total === undefined ? null : Number(pagination.total),
      totalPages: pagination.totalPages === null || pagination.totalPages === undefined ? null : Number(pagination.totalPages),
      hasNext: Boolean(pagination.hasNext),
      hasPrev: Boolean(pagination.hasPrev),
      nextCursor: typeof pagination.nextCursor === 'string' && pagination.nextCursor ? pagination.nextCursor : null
    },
    facets: {
      statuses: Array.isArray(facets.statuses)
        ? facets.statuses.map((status: any) => ({
          value: String(status.value || '').trim().toLowerCase(),
          count: Number(status.count || 0)
        })).filter((status: TransactionStatusFacet) => status.value)
        : []
    },
    summary: {
      total: Number(summary.total || 0),
      active: Number(summary.active || 0),
      inactive: Number(summary.inactive || 0),
      completed: Number(summary.completed || 0)
    }
  }
}

export const transactionsService = {
  getTransactionsPage(params: TransactionsPageParams = {}): Promise<TransactionsPageResult> {
    return requestTransactionsPage(params)
  },

  async getTransactions(
    startDate?: string,
    endDate?: string,
    forceSync?: boolean,
    searchTerm?: string
  ): Promise<Transaction[]> {
    try {
      if (forceSync) await apiClient.post('/transactions/sync', {})
      const result = await requestTransactionsPage({
        startDate,
        endDate,
        search: searchTerm,
        limit: 250
      })
      return result.transactions
    } catch (error) {
      // TODO: Implement proper logging service
      return []
    }
  },

  async getTransaction(id: string): Promise<Transaction> {
    return await apiClient.get<Transaction>(`/transactions/${id}`)
  },

  async getSummary(startOrParams?: string | TransactionSummaryParams, endDate?: string): Promise<TransactionSummary> {
    const input = typeof startOrParams === 'object'
      ? startOrParams
      : { startDate: startOrParams, endDate }
    try {
      const params: Record<string, string> = {}
      if (input.startDate) params.startDate = input.startDate
      if (input.endDate) params.endDate = input.endDate
      if (input.search?.trim()) params.q = input.search.trim()
      if (input.statuses?.length) params.status = input.statuses.join(',')

      const data = await apiClient.get<TransactionSummary>('/transactions/summary', {
        params,
        signal: input.signal
      })

      return data
    } catch (error) {
      if (input.signal?.aborted) throw error
      return EMPTY_TRANSACTION_SUMMARY
    }
  },

  async getFacets(paramsInput: Omit<TransactionSummaryParams, 'statuses'> = {}): Promise<{ statuses: TransactionStatusFacet[] }> {
    const params: Record<string, string> = {}
    if (paramsInput.startDate) params.startDate = paramsInput.startDate
    if (paramsInput.endDate) params.endDate = paramsInput.endDate
    if (paramsInput.search?.trim()) params.q = paramsInput.search.trim()
    const data = await apiClient.get<{ statuses?: TransactionStatusFacet[] }>('/transactions/facets', {
      params,
      signal: paramsInput.signal
    })
    return {
      statuses: Array.isArray(data?.statuses)
        ? data.statuses.map(status => ({
          value: String(status.value || '').trim().toLowerCase(),
          count: Number(status.count || 0)
        })).filter(status => status.value)
        : []
    }
  },

  async syncTransactions(): Promise<Record<string, unknown>> {
    return await apiClient.post<Record<string, unknown>>('/transactions/sync', {})
  },

  async createTransaction(
    transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>,
    options: CreateTransactionOptions = {}
  ): Promise<Transaction> {
    const cleanIdempotencyKey = String(options.idempotencyKey || '').trim()
    const data = await apiClient.post<Transaction>('/transactions', transaction, cleanIdempotencyKey
      ? { headers: { 'Idempotency-Key': cleanIdempotencyKey } }
      : undefined)
    return data
  },

  async updateTransaction(id: string, transaction: Partial<Transaction>): Promise<Transaction> {
    const data = await apiClient.put<Transaction>(`/transactions/${id}`, transaction)
    return data
  },

  async deleteTransaction(id: string): Promise<void> {
    await apiClient.delete(`/transactions/${id}`)
  },

  async refundTransaction(id: string): Promise<void> {
    await apiClient.post(`/transactions/${id}/refund`, {})
  },

  async voidTransaction(id: string): Promise<void> {
    await apiClient.post(`/transactions/${id}/void`, {})
  },

  async recordPayment(id: string, data: { amount: number; paymentDate: string; paymentMethod: string }): Promise<void> {
    await apiClient.post(`/transactions/${id}/record-payment`, data)
  },

  async approveTransferProof(id: string, reference?: string): Promise<Transaction> {
    return await apiClient.post<Transaction>(`/transactions/${id}/approve-transfer-proof`, {
      ...(reference?.trim() ? { reference: reference.trim() } : {})
    })
  },

  async rejectTransferProof(id: string, reason: string): Promise<Transaction> {
    return await apiClient.post<Transaction>(`/transactions/${id}/reject-transfer-proof`, {
      reason: reason.trim()
    })
  },

  async sendTransaction(id: string): Promise<void> {
    await apiClient.post(`/transactions/${id}/send`, {})
  },

  async getPaymentLink(id: string): Promise<string> {
    const response = await apiClient.get<{ link: string }>(`/transactions/${id}/payment-link`)
    return response.link
  },

  getPaymentPlansPage(params: PaymentPlansPageParams = {}): Promise<PaymentPlansPageResult> {
    return requestPaymentPlansPage(params)
  },

  async getPaymentPlans(): Promise<PaymentPlan[]> {
    const result = await requestPaymentPlansPage({ limit: 100 })
    return result.paymentPlans
  },

  async getPaymentPlan(id: string): Promise<PaymentPlan> {
    const data = await apiClient.get<PaymentPlan>(`/transactions/payment-plans/${id}`)
    return data
  },

  async createPaymentPlan(payload: Record<string, any>): Promise<PaymentPlan> {
    const data = await apiClient.post<PaymentPlan>('/transactions/payment-plans', {
      payload,
      scheduleNow: true
    })
    return data
  },

  async updatePaymentPlan(id: string, payload: Record<string, any>): Promise<PaymentPlan> {
    const data = await apiClient.put<PaymentPlan>(`/transactions/payment-plans/${id}`, {
      payload,
      updateAndSchedule: true
    })
    return data
  },

  async actionPaymentPlan(id: string, action: string, payload: Record<string, any> = {}): Promise<PaymentPlan> {
    const data = await apiClient.post<PaymentPlan>(`/transactions/payment-plans/${id}/action`, {
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
