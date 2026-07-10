import { apiUrl } from './apiBaseUrl'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface StripePaymentConfig {
  enabled: boolean
  configured: boolean
  connectionType?: 'manual'
  configurationStatus?: 'not_configured' | 'configured_manually' | 'connection_failed' | 'disconnected'
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publishableKey: string
  hasSecretKey: boolean
  secretKeyPreview?: string
  hasWebhookSecret: boolean
  webhookSecretPreview?: string
  webhookEndpointId?: string
  webhookUrl?: string
  webhookStatus?: string
  webhookSyncedAt?: string
  webhookLastError?: string
  webhookConfigured?: boolean
  manualModes?: Record<'test' | 'live', StripeManualModeStatus>
  webhookEndpointPath?: string
  webhookEndpoints?: StripeWebhookEndpoint[]
}

export interface StripeManualModeStatus {
  mode: 'test' | 'live'
  configured: boolean
  publishableKey: string
  hasSecretKey: boolean
  secretKeyPreview?: string
  hasWebhookSecret: boolean
  webhookSecretPreview?: string
  webhookEndpointId?: string
  webhookUrl?: string
  webhookStatus?: string
  webhookSyncedAt?: string
  webhookLastError?: string
  webhookConfigured?: boolean
  updatedAt?: string
}

export interface StripeWebhookEndpoint {
  source: 'render' | 'configured' | 'app_domain' | 'current_request' | string
  label: string
  description: string
  url: string
}

export interface SaveStripePaymentConfigPayload {
  enabled?: boolean
  mode?: 'test' | 'live'
  defaultCurrency?: string
  accountLabel?: string
  publishableKey?: string
  secretKey?: string
  webhookSecret?: string
  manualModes?: Partial<Record<'test' | 'live', {
    publishableKey?: string
    secretKey?: string
    webhookSecret?: string
  }>>
}

export interface StripePaymentLinkPayload {
  contactId?: string
  contactName?: string
  email?: string
  phone?: string
  amount: number
  currency: string
  applyTax?: boolean
  taxCalculationMode?: 'exclusive' | 'inclusive'
  title?: string
  description?: string
  dueDate?: string
  source?: string
  lineItems?: Array<Record<string, unknown>>
  installments?: {
    enabled?: boolean
    maxInstallments?: number
  }
}

export interface PublicMetaPurchaseEvent {
  pixelId: string
  eventName: string
  eventId: string
  customData?: Record<string, unknown>
}

export interface PublicStripePaymentPlanInstallment {
  id: string
  sequence: number
  amount: number
  percentage?: number | null
  dueDate?: string | null
  status?: string | null
  paymentId?: string | null
  paymentMethod?: string | null
  changeType?: 'added' | null
}

export interface PublicStripePaymentPlan {
  provider: 'stripe'
  flowId: string
  trigger?: string | null
  title: string
  description?: string
  status?: string | null
  total: number
  currency: string
  remainingFrequency?: string | null
  recurrenceLabel?: string | null
  cardSetupRequired?: boolean
  cardSetupStatus?: string | null
  cardSetupAmount?: number
  stripePaymentMethodLabel?: string | null
  firstPayment?: {
    amount: number
    date?: string | null
    method?: string | null
    status?: string | null
    paymentId?: string | null
  } | null
  installments: PublicStripePaymentPlanInstallment[]
  changeSummary?: {
    type: 'added_installments'
    label: string
    addedInstallmentCount: number
  } | null
}

export interface PublicStripeSubscriptionStart {
  subscriptionId: string
  paymentProvider?: string
  paymentMethod?: string
  intervalType?: string
  intervalCount?: number
  startDate?: string | null
  nextRunAt?: string | null
  cancelAt?: string | null
}

export interface PublicStripePayment {
  id: string
  publicPaymentId: string
  paymentUrl: string
  status: string
  amount: number
  currency: string
  title: string
  description: string
  dueDate?: string | null
  sentAt?: string | null
  paidAt?: string | null
  timezone?: string
  timeZone?: string
  paymentMode: 'test' | 'live'
  provider: 'stripe'
  contact: {
    id?: string
    name?: string
    email?: string
    phone?: string
  }
  stripePaymentIntentId?: string | null
  publishableKey: string
  stripeAccountId?: string
  stripeInstallments?: {
    enabled: boolean
    minAmount?: number
    maxInstallments?: number
    allowedCounts?: number[]
    label?: string
    provider?: 'stripe'
    selectionMode?: string
  } | null
  subscriptionStart?: PublicStripeSubscriptionStart | null
  paymentPlan?: PublicStripePaymentPlan | null
  tax?: {
    enabled: boolean
    taxName: string
    rateType: 'percentage' | 'fixed'
    rateValue: number
    rateSource?: 'automatic'
    calculationMode: 'exclusive' | 'inclusive'
    country?: string
    fiscalId?: string
    fiscalLegalName?: string
    fiscalPostalCode?: string
    fiscalRegime?: string
    provider?: 'gigstack'
    subtotalAmount: number
    taxAmount: number
    totalAmount: number
  } | null
  settings?: PublicPaymentSettings | null
  metaPurchaseEvent?: PublicMetaPurchaseEvent | null
}

export interface StripePaymentIntentResponse {
  clientSecret: string
  publishableKey: string
  stripeAccountId?: string
  status: string
}

export interface StripeInstallmentPlan {
  type: 'fixed_count'
  interval: 'month'
  count: number
}

export interface StripeInstallmentPlansResponse {
  paymentIntentId: string
  clientSecret: string
  publishableKey: string
  stripeAccountId?: string
  status: string
  maxInstallments: number
  availablePlans: StripeInstallmentPlan[]
}

export interface StripeInstallmentConfirmResponse {
  paymentIntentId: string
  clientSecret: string
  publishableKey: string
  stripeAccountId?: string
  status: string
  selectedPlan?: StripeInstallmentPlan | null
  availablePlans?: StripeInstallmentPlan[]
}

export interface StripeSubscriptionCheckoutResponse {
  checkoutUrl: string
  stripeCheckoutSessionId?: string
  status: string
  subscriptionId: string
  alreadyActive?: boolean
}

export interface StripeSavedPaymentMethod {
  id: string
  contactId: string
  stripeCustomerId: string
  stripePaymentMethodId: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
  funding?: string
  country?: string
  mode: 'test' | 'live'
  isDefault: boolean
  label: string
  expiresLabel: string
}

export interface StripeSavedCardPaymentPayload {
  contactId: string
  paymentMethodId: string
  contactName?: string
  email?: string
  phone?: string
  amount: number
  currency: string
  applyTax?: boolean
  taxCalculationMode?: 'exclusive' | 'inclusive'
  title?: string
  description?: string
  dueDate?: string
  source?: string
  lineItems?: Array<Record<string, unknown>>
}

export interface StripePaymentPlanPayload {
  idempotencyKey?: string
  contact: {
    id: string
    name?: string
    email?: string
    phone?: string
  }
  totalAmount: number
  currency: string
  description?: string
  title?: string
  invoicePayload?: Record<string, unknown>
  firstPayment: {
    enabled: boolean
    amount: number
    date?: string
    method?: string
  }
  remainingFrequency?: string
  remainingPayments: Array<{
    sequence: number
    type?: string
    value?: number
    amount: number
    percentage?: number | null
    dueDate: string
    frequency?: string
  }>
  paymentMethodId?: string
  cardSetupAmount?: number
  source?: string
}

export interface StripePaymentPlanResponse {
  flowId: string
  currentState: string
  paymentMode: 'test' | 'live'
  firstPaymentLink?: string | null
  firstPaymentPaymentId?: string | null
  cardSetupLink?: string | null
  cardSetupPaymentId?: string | null
  cardSetupAmount?: number
  savedPaymentMethod?: StripeSavedPaymentMethod | null
  scheduledPayments: Array<{
    installmentId: string
    paymentId: string
    sequence: number
    amount: number
    currency: string
    dueDate: string
    status: string
  }>
}

export interface CreatePublicPaymentIntentPayload {
  savePaymentMethod?: boolean
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || 'No se pudo completar la operación')
  }
  return (data?.data ?? data) as T
}

function getAuthHeaders(): Record<string, string> {
  try {
    const token = window.localStorage.getItem('auth_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

export const stripePaymentsService = {
  async getConfig(): Promise<StripePaymentConfig> {
    const response = await fetch(apiUrl('/api/stripe/config'), {
      headers: getAuthHeaders()
    })
    return parseApiResponse<StripePaymentConfig>(response)
  },

  async saveConfig(payload: SaveStripePaymentConfigPayload): Promise<StripePaymentConfig> {
    const response = await fetch(apiUrl('/api/stripe/config'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripePaymentConfig>(response)
  },

  async testConfig(payload?: Partial<SaveStripePaymentConfigPayload>): Promise<{ ok: boolean; livemode: boolean; available: number; connectionType?: 'manual' | string }> {
    const response = await fetch(apiUrl('/api/stripe/config/test'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload || {})
    })
    return parseApiResponse(response)
  },

  async deleteConfig(): Promise<StripePaymentConfig> {
    const response = await fetch(apiUrl('/api/stripe/config'), {
      method: 'DELETE',
      headers: getAuthHeaders()
    })
    return parseApiResponse<StripePaymentConfig>(response)
  },

  async createPaymentLink(payload: StripePaymentLinkPayload): Promise<{ payment: PublicStripePayment; paymentUrl: string; publicPaymentId: string }> {
    const response = await fetch(apiUrl('/api/stripe/payment-links'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse(response)
  },

  async createPaymentPlan(payload: StripePaymentPlanPayload): Promise<StripePaymentPlanResponse> {
    const response = await fetch(apiUrl('/api/stripe/payment-plans'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : {}),
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripePaymentPlanResponse>(response)
  },

  async getPublicPayment(publicPaymentId: string, sync = false, checkoutSessionId = ''): Promise<PublicStripePayment> {
    const params = new URLSearchParams()
    if (sync) params.set('sync', 'true')
    if (checkoutSessionId) params.set('session_id', checkoutSessionId)
    const query = params.toString() ? `?${params.toString()}` : ''
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}${query}`))
    return parseApiResponse<PublicStripePayment>(response)
  },

  async createPublicPaymentIntent(publicPaymentId: string, payload: CreatePublicPaymentIntentPayload = {}): Promise<StripePaymentIntentResponse> {
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}/intent`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripePaymentIntentResponse>(response)
  },

  async preparePublicInstallmentPlans(publicPaymentId: string, payload: {
    paymentMethodId: string
    savePaymentMethod?: boolean
  }): Promise<StripeInstallmentPlansResponse> {
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}/installment-plans`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripeInstallmentPlansResponse>(response)
  },

  async confirmPublicInstallmentPayment(publicPaymentId: string, payload: {
    paymentIntentId: string
    selectedInstallments?: number | null
    returnUrl?: string
  }): Promise<StripeInstallmentConfirmResponse> {
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}/installment-confirm`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripeInstallmentConfirmResponse>(response)
  },

  async createPublicSubscriptionCheckout(publicPaymentId: string): Promise<StripeSubscriptionCheckoutResponse> {
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}/subscription-checkout`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return parseApiResponse<StripeSubscriptionCheckoutResponse>(response)
  },

  async getSavedPaymentMethods(contactId: string): Promise<StripeSavedPaymentMethod[]> {
    const response = await fetch(apiUrl(`/api/stripe/contacts/${encodeURIComponent(contactId)}/payment-methods`), {
      headers: getAuthHeaders()
    })
    return parseApiResponse<StripeSavedPaymentMethod[]>(response)
  },

  async createSavedCardPayment(payload: StripeSavedCardPaymentPayload): Promise<{ payment: any }> {
    const response = await fetch(apiUrl('/api/stripe/saved-card-payments'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse(response)
  }
}
