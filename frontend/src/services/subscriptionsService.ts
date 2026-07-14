import apiClient from './apiClient'

export type SubscriptionStatus = 'draft' | 'active' | 'trialing' | 'past_due' | 'paused' | 'cancelled' | 'incomplete'
export type SubscriptionInterval = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface PaymentSubscription {
  id: string
  contactId?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  name: string
  description?: string | null
  status: SubscriptionStatus | string
  amount: number
  currency: string
  intervalType: SubscriptionInterval | string
  intervalCount: number
  startDate?: string | null
  nextRunAt?: string | null
  currentPeriodStart?: string | null
  currentPeriodEnd?: string | null
  cancelAt?: string | null
  cancelledAt?: string | null
  paymentMethod?: string | null
  paymentProvider?: string | null
  paymentMode?: 'test' | 'live' | string | null
  source?: string | null
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  stripeProductId?: string | null
  stripePriceId?: string | null
  stripePaymentMethodId?: string | null
  stripeCheckoutSessionId?: string | null
  stripeCheckoutUrl?: string | null
  mercadoPagoPreapprovalId?: string | null
  mercadoPagoPreapprovalPlanId?: string | null
  mercadoPagoInitPoint?: string | null
  mercadoPagoSandboxInitPoint?: string | null
  mercadoPagoPayerId?: string | null
  mercadoPagoCardId?: string | null
  mercadoPagoPaymentMethodId?: string | null
  mercadoPagoNextPaymentDate?: string | null
  conektaCustomerId?: string | null
  conektaPlanId?: string | null
  conektaSubscriptionId?: string | null
  conektaPaymentSourceId?: string | null
  conektaNextBillingAt?: string | null
  conektaCheckoutId?: string | null
  conektaCheckoutUrl?: string | null
  rebillSubscriptionId?: string | null
  rebillPlanId?: string | null
  rebillPaymentLinkId?: string | null
  rebillPaymentLinkUrl?: string | null
  rebillCustomerId?: string | null
  rebillCardId?: string | null
  rebillNextChargeAt?: string | null
  rebillLastChargeAt?: string | null
  rebillCheckoutUrl?: string | null
  subscriptionStartPaymentId?: string | null
  subscriptionStartPublicPaymentId?: string | null
  subscriptionStartPaymentProvider?: string | null
  subscriptionStartPaymentStatus?: string | null
  subscriptionStartUrl?: string | null
  metadata?: Record<string, unknown> | null
  raw?: Record<string, unknown> | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface SubscriptionSummary {
  total: number
  active: number
  paused: number
  pastDue: number
  monthlyRevenue: number
  nextRunAt?: string | null
}

export interface SubscriptionListResponse {
  subscriptions: PaymentSubscription[]
  summary: SubscriptionSummary
  pagination: {
    page: number
    limit: number
    total: number | null
    totalPages: number | null
    hasNext: boolean
    hasPrev: boolean
    nextCursor: string | null
  }
}

export interface SubscriptionPayload {
  contactId?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  name: string
  description?: string
  status?: SubscriptionStatus | string
  amount: number
  currency: string
  intervalType: SubscriptionInterval | string
  intervalCount: number
  startDate?: string | null
  nextRunAt?: string | null
  cancelAt?: string | null
  paymentMethod?: string
  paymentProvider?: string
  paymentMode?: 'test' | 'live' | string
  source?: string
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  stripeProductId?: string | null
  stripePriceId?: string | null
  stripePaymentMethodId?: string | null
  mercadoPagoPreapprovalId?: string | null
  mercadoPagoPreapprovalPlanId?: string | null
  mercadoPagoInitPoint?: string | null
  mercadoPagoSandboxInitPoint?: string | null
  mercadoPagoPayerId?: string | null
  mercadoPagoCardId?: string | null
  mercadoPagoPaymentMethodId?: string | null
  mercadoPagoNextPaymentDate?: string | null
  conektaCustomerId?: string | null
  conektaPlanId?: string | null
  conektaSubscriptionId?: string | null
  conektaPaymentSourceId?: string | null
  conektaNextBillingAt?: string | null
  rebillSubscriptionId?: string | null
  rebillPlanId?: string | null
  rebillPaymentLinkId?: string | null
  rebillPaymentLinkUrl?: string | null
  rebillCustomerId?: string | null
  rebillCardId?: string | null
  rebillNextChargeAt?: string | null
  rebillLastChargeAt?: string | null
  metadata?: Record<string, unknown> | null
}

const EMPTY_SUMMARY: SubscriptionSummary = {
  total: 0,
  active: 0,
  paused: 0,
  pastDue: 0,
  monthlyRevenue: 0,
  nextRunAt: null
}

const EMPTY_PAGINATION: SubscriptionListResponse['pagination'] = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
  nextCursor: null
}

export const subscriptionsService = {
  async listSubscriptions(params: {
    status?: string
    search?: string
    page?: number
    cursor?: string | null
    limit?: number
    sortBy?: string
    sortOrder?: 'asc' | 'desc'
    refresh?: boolean
  } = {}): Promise<SubscriptionListResponse> {
    const queryParams: Record<string, string> = {}
    if (params.status && params.status !== 'all') queryParams.status = params.status
    if (params.search?.trim()) queryParams.search = params.search.trim()
    if (params.page) queryParams.page = String(params.page)
    if (params.cursor) queryParams.cursor = params.cursor
    if (params.limit) queryParams.limit = String(params.limit)
    if (params.sortBy) queryParams.sortBy = params.sortBy
    if (params.sortOrder) queryParams.sortOrder = params.sortOrder
    if (params.refresh) queryParams.refresh = 'true'

    const data = await apiClient.get<SubscriptionListResponse>('/subscriptions', {
      params: Object.keys(queryParams).length ? queryParams : undefined
    })

    return {
      subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
      summary: data.summary || EMPTY_SUMMARY,
      pagination: {
        ...EMPTY_PAGINATION,
        ...(data.pagination || {}),
        nextCursor: typeof data.pagination?.nextCursor === 'string' && data.pagination.nextCursor
          ? data.pagination.nextCursor
          : null
      }
    }
  },

  async getSubscription(id: string): Promise<PaymentSubscription> {
    return apiClient.get<PaymentSubscription>(`/subscriptions/${encodeURIComponent(id)}`)
  },

  async createSubscription(payload: SubscriptionPayload): Promise<PaymentSubscription> {
    return apiClient.post<PaymentSubscription>('/subscriptions', payload)
  },

  async updateSubscription(id: string, payload: SubscriptionPayload): Promise<PaymentSubscription> {
    return apiClient.put<PaymentSubscription>(`/subscriptions/${encodeURIComponent(id)}`, payload)
  },

  async actionSubscription(id: string, action: string, payload: Record<string, unknown> = {}): Promise<PaymentSubscription> {
    return apiClient.post<PaymentSubscription>(`/subscriptions/${encodeURIComponent(id)}/action`, {
      action,
      payload
    })
  },

  async deleteSubscription(id: string): Promise<void> {
    await apiClient.delete(`/subscriptions/${encodeURIComponent(id)}`)
  }
}
