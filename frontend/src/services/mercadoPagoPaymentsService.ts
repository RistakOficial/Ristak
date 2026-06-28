import { apiUrl } from './apiBaseUrl'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface MercadoPagoWebhookEndpoint {
  source: 'render' | 'configured' | 'app_domain' | 'current_request' | string
  label: string
  description: string
  url: string
}

export interface MercadoPagoModeConnectionStatus {
  mode: 'test' | 'live'
  connected: boolean
  accountLabel?: string
  userId?: string
  publicKey?: string
  livemode?: boolean
  hasAccessToken?: boolean
  hasRefreshToken?: boolean
  hasWebhookSecret?: boolean
  webhookUrl?: string
  connectedAt?: string | null
  managedByPortal?: boolean
}

export interface MercadoPagoPaymentConfig {
  enabled: boolean
  configured: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  userId?: string
  publicKey?: string
  scope?: string
  tokenType?: string
  livemode?: boolean
  webhookUrl?: string
  hasWebhookSecret?: boolean
  tokenExpiresAt?: string | null
  connectedAt?: string | null
  managedByPortal?: boolean
  hasAccessToken?: boolean
  hasRefreshToken?: boolean
  modeConnections?: Record<'test' | 'live', MercadoPagoModeConnectionStatus>
  subscriptionTestCredentials?: {
    configured: boolean
    publicKey?: string
    hasAccessToken?: boolean
    accessTokenPreview?: string
    userId?: string
    accountLabel?: string
  }
  webhookEndpointPath?: string
  webhookEndpoints?: MercadoPagoWebhookEndpoint[]
}

export interface MercadoPagoConnectUrlResponse {
  url: string
  mode: 'test' | 'live'
  redirectUri: string
  webhookUrl?: string
}

export interface MercadoPagoPaymentLinkPayload {
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

export interface PublicMercadoPagoPayment {
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
  provider: 'mercadopago'
  contact: {
    id?: string
    name?: string
    email?: string
    phone?: string
  }
  mercadoPagoPaymentId?: string | null
  mercadoPagoPreferenceId?: string | null
  publicKey?: string
  mercadoPagoInstallments?: {
    enabled: boolean
    maxInstallments: number
    label: string
  } | null
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

export interface MercadoPagoCardPaymentPayload {
  token: string
  paymentMethodId?: string
  payment_method_id?: string
  issuerId?: string
  issuer_id?: string
  installments?: number
  idempotencyKey?: string
  idempotency_key?: string
  payer: {
    email: string
    firstName?: string
    first_name?: string
    lastName?: string
    last_name?: string
    identification?: {
      type?: string
      number?: string
    }
  }
}

export interface MercadoPagoCardPaymentResponse {
  payment: PublicMercadoPagoPayment
  mercadoPagoPaymentId?: string
  status?: string
  statusDetail?: string
  paymentMethodId?: string
  paymentTypeId?: string
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || 'No se pudo completar la operación')
  }
  return data.data as T
}

export const mercadoPagoPaymentsService = {
  async getConfig(): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/config'), {
      credentials: 'include'
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async createConnectUrl(payload: { mode: 'test' | 'live'; returnPath?: string; appUrl?: string }): Promise<MercadoPagoConnectUrlResponse> {
    const response = await fetch(apiUrl('/api/mercadopago/connect/url'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<MercadoPagoConnectUrlResponse>(response)
  },

  async syncConnect(payload: { handoffToken?: string } = {}): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/connect/sync'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(payload.handoffToken ? { handoffToken: payload.handoffToken } : {})
      })
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async setConnectMode(mode: 'test' | 'live'): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/connect/mode'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async testConfig(): Promise<{ ok: boolean; userId: string; accountLabel: string; email: string }> {
    const response = await fetch(apiUrl('/api/mercadopago/config/test'), {
      method: 'POST',
      credentials: 'include'
    })
    return parseResponse(response)
  },

  async deleteConfig(): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/config'), {
      method: 'DELETE',
      credentials: 'include'
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async saveSubscriptionTestCredentials(payload: { publicKey: string; accessToken: string }): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/config/subscription-test-credentials'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async deleteSubscriptionTestCredentials(): Promise<MercadoPagoPaymentConfig> {
    const response = await fetch(apiUrl('/api/mercadopago/config/subscription-test-credentials'), {
      method: 'DELETE',
      credentials: 'include'
    })
    return parseResponse<MercadoPagoPaymentConfig>(response)
  },

  async createPaymentLink(payload: MercadoPagoPaymentLinkPayload): Promise<{ payment: PublicMercadoPagoPayment; paymentUrl: string; publicPaymentId: string; preferenceId: string }> {
    const response = await fetch(apiUrl('/api/mercadopago/payment-links'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse(response)
  },

  async getPublicPayment(publicPaymentId: string): Promise<PublicMercadoPagoPayment> {
    const response = await fetch(apiUrl(`/api/mercadopago/public/payments/${encodeURIComponent(publicPaymentId)}`))
    return parseResponse<PublicMercadoPagoPayment>(response)
  },

  async ensurePublicPreference(publicPaymentId: string): Promise<{ paymentUrl: string; checkoutUrl?: string; preferenceId: string }> {
    const response = await fetch(apiUrl(`/api/mercadopago/public/payments/${encodeURIComponent(publicPaymentId)}/preference`), {
      method: 'POST'
    })
    return parseResponse(response)
  },

  async createPublicCardPayment(publicPaymentId: string, payload: MercadoPagoCardPaymentPayload): Promise<MercadoPagoCardPaymentResponse> {
    const response = await fetch(apiUrl(`/api/mercadopago/public/payments/${encodeURIComponent(publicPaymentId)}/card`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<MercadoPagoCardPaymentResponse>(response)
  }
}
