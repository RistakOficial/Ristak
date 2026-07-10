import { apiUrl } from './apiBaseUrl'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface ConektaModeCredentials {
  publicKey: string
  privateKey: string
}

export interface ConektaModeStatus {
  mode: 'test' | 'live'
  configured: boolean
  publicKey: string
  hasPrivateKey: boolean
  privateKeyPreview?: string
  webhookId?: string
  webhookUrl?: string
  webhookStatus?: string
  webhookSyncedAt?: string
  webhookLastError?: string
  webhookKeyConfigured?: boolean
  webhookConfigured?: boolean
  updatedAt?: string
}

export interface ConektaWebhookEndpoint {
  source: 'render' | 'configured' | 'app_domain' | 'current_request' | string
  label: string
  description: string
  url: string
}

export interface ConektaPaymentConfig {
  enabled: boolean
  configured: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publicKey: string
  hasPrivateKey: boolean
  privateKeyPreview?: string
  webhookId?: string
  webhookUrl?: string
  webhookStatus?: string
  webhookSyncedAt?: string
  webhookLastError?: string
  webhookKeyConfigured?: boolean
  webhookConfigured?: boolean
  manualModes?: Record<'test' | 'live', ConektaModeStatus>
  webhookEndpointPath?: string
  webhookEndpoints?: ConektaWebhookEndpoint[]
}

export interface SaveConektaPaymentConfigPayload {
  enabled?: boolean
  mode?: 'test' | 'live'
  defaultCurrency?: string
  accountLabel?: string
  publicKey?: string
  privateKey?: string
  manualModes?: Partial<Record<'test' | 'live', Partial<ConektaModeCredentials>>>
}

export interface ConektaInstallmentsConfig {
  enabled: boolean
  maxInstallments: number
  minAmount?: number
  label?: string
  options?: Array<{
    months: number
    minAmount: number
  }>
}

export interface ConektaPaymentLinkPayload {
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

export interface PublicConektaSubscriptionStart {
  subscriptionId: string
  paymentProvider?: string
  paymentMethod?: string
  intervalType?: string
  intervalCount?: number
  startDate?: string | null
  nextRunAt?: string | null
  cancelAt?: string | null
}

export interface PublicConektaPayment {
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
  provider: 'conekta'
  contact: {
    id?: string
    name?: string
    email?: string
    phone?: string
  }
  conektaOrderId?: string | null
  conektaChargeId?: string | null
  publicKey: string
  subscriptionStart?: PublicConektaSubscriptionStart | null
  conektaInstallments?: ConektaInstallmentsConfig | null
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

export interface ConektaPublicCardPaymentPayload {
  tokenId: string
  savePaymentSource?: boolean
  installments?: number
}

export interface ConektaPublicSubscriptionPayload {
  tokenId: string
}

export interface ConektaSavedPaymentSource {
  id: string
  contactId: string
  conektaCustomerId: string
  conektaPaymentSourceId: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
  name?: string
  mode: 'test' | 'live'
  isDefault: boolean
  label: string
  expiresLabel: string
}

export interface ConektaSavedCardPaymentPayload {
  contactId: string
  paymentSourceId: string
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

export interface ConektaPaymentPlanPayload {
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

export interface ConektaPaymentPlanResponse {
  flowId: string
  currentState: string
  paymentMode: 'test' | 'live'
  firstPaymentLink?: string | null
  firstPaymentPaymentId?: string | null
  cardSetupLink?: string | null
  cardSetupPaymentId?: string | null
  cardSetupAmount?: number
  savedPaymentSource?: ConektaSavedPaymentSource | null
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

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || 'No se pudo completar la operación')
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

export const conektaPaymentsService = {
  async getConfig(): Promise<ConektaPaymentConfig> {
    const response = await fetch(apiUrl('/api/conekta/config'), {
      headers: getAuthHeaders()
    })
    return parseApiResponse<ConektaPaymentConfig>(response)
  },

  async saveConfig(payload: SaveConektaPaymentConfigPayload): Promise<ConektaPaymentConfig> {
    const response = await fetch(apiUrl('/api/conekta/config'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<ConektaPaymentConfig>(response)
  },

  async testConfig(payload?: Partial<SaveConektaPaymentConfigPayload>): Promise<{ ok: boolean; mode: 'test' | 'live'; publicKey: string; accountLabel: string; customersAvailable: number }> {
    const response = await fetch(apiUrl('/api/conekta/config/test'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload || {})
    })
    return parseApiResponse(response)
  },

  async deleteConfig(): Promise<ConektaPaymentConfig> {
    const response = await fetch(apiUrl('/api/conekta/config'), {
      method: 'DELETE',
      headers: getAuthHeaders()
    })
    return parseApiResponse<ConektaPaymentConfig>(response)
  },

  async createPaymentLink(payload: ConektaPaymentLinkPayload): Promise<{ payment: PublicConektaPayment; paymentUrl: string; publicPaymentId: string }> {
    const response = await fetch(apiUrl('/api/conekta/payment-links'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse(response)
  },

  async createPaymentPlan(payload: ConektaPaymentPlanPayload): Promise<ConektaPaymentPlanResponse> {
    const response = await fetch(apiUrl('/api/conekta/payment-plans'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : {}),
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<ConektaPaymentPlanResponse>(response)
  },

  async getPublicPayment(publicPaymentId: string): Promise<PublicConektaPayment> {
    const response = await fetch(apiUrl(`/api/conekta/public/payments/${encodeURIComponent(publicPaymentId)}`))
    return parseApiResponse<PublicConektaPayment>(response)
  },

  async createPublicCardPayment(publicPaymentId: string, payload: ConektaPublicCardPaymentPayload): Promise<{ payment: PublicConektaPayment; conektaOrderId?: string; conektaChargeId?: string; status?: string }> {
    const response = await fetch(apiUrl(`/api/conekta/public/payments/${encodeURIComponent(publicPaymentId)}/card`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseApiResponse(response)
  },

  async createPublicSubscription(publicPaymentId: string, payload: ConektaPublicSubscriptionPayload): Promise<{ payment: PublicConektaPayment; conektaSubscriptionId?: string; conektaPaymentSourceId?: string; status?: string }> {
    const response = await fetch(apiUrl(`/api/conekta/public/payments/${encodeURIComponent(publicPaymentId)}/subscription`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseApiResponse(response)
  },

  async getSavedPaymentSources(contactId: string): Promise<ConektaSavedPaymentSource[]> {
    const response = await fetch(apiUrl(`/api/conekta/contacts/${encodeURIComponent(contactId)}/payment-sources`), {
      headers: getAuthHeaders()
    })
    return parseApiResponse<ConektaSavedPaymentSource[]>(response)
  },

  async createSavedCardPayment(payload: ConektaSavedCardPaymentPayload): Promise<{ payment: any }> {
    const response = await fetch(apiUrl('/api/conekta/saved-card-payments'), {
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
