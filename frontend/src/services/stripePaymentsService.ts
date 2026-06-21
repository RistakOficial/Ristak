import { apiUrl } from './apiBaseUrl'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface StripePaymentConfig {
  enabled: boolean
  configured: boolean
  connectionType?: 'manual' | 'connect'
  configurationStatus?: 'not_configured' | 'configured_manually' | 'connection_failed' | 'disconnected'
  stripeConnectOAuthEnabled?: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publishableKey: string
  hasSecretKey: boolean
  secretKeyPreview?: string
  hasWebhookSecret: boolean
  webhookSecretPreview?: string
  manualModes?: Record<'test' | 'live', StripeManualModeStatus>
  webhookEndpointPath?: string
  webhookEndpoints?: StripeWebhookEndpoint[]
  connectedAccountId?: string
  connectedAccountPreview?: string
  connectScope?: string
  connectLivemode?: boolean
  connectReady?: boolean
  connectModes?: Record<'test' | 'live', StripeConnectModeStatus>
  connectOauthReady?: boolean
  connectOauthReadyByMode?: Record<'test' | 'live', boolean>
  connectMissingEnv?: string[]
  connectAccountEmail?: string
  connectManagedByPortal?: boolean
  connectUsesAccessToken?: boolean
  connectUsesPlatformAccountHeader?: boolean
  connectChargesEnabled?: boolean
  connectPayoutsEnabled?: boolean
  connectDetailsSubmitted?: boolean
  connectWebhookEndpointId?: string
  connectWebhookUrl?: string
  connectWebhookStatus?: string
  connectWebhookLastError?: string
  connectConnectedAt?: string
  hasConnectAccessToken?: boolean
  hasConnectRefreshToken?: boolean
}

export interface StripeManualModeStatus {
  mode: 'test' | 'live'
  configured: boolean
  publishableKey: string
  hasSecretKey: boolean
  secretKeyPreview?: string
  hasWebhookSecret: boolean
  webhookSecretPreview?: string
  updatedAt?: string
}

export interface StripeConnectModeStatus {
  connected: boolean
  mode: 'test' | 'live'
  accountId?: string
  accountPreview?: string
  accountEmail?: string
  accountLabel?: string
  webhookStatus?: string
  webhookUrl?: string
  connectedAt?: string
  livemode?: boolean
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
}

export interface StripePaymentIntentResponse {
  clientSecret: string
  publishableKey: string
  stripeAccountId?: string
  status: string
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

  async testConfig(payload?: Partial<SaveStripePaymentConfigPayload>): Promise<{ ok: boolean; livemode: boolean; available: number; connectionType?: string; connectedAccountId?: string }> {
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
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<StripePaymentPlanResponse>(response)
  },

  async getPublicPayment(publicPaymentId: string, sync = false): Promise<PublicStripePayment> {
    const query = sync ? '?sync=true' : ''
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
