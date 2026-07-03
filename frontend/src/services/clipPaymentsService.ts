import { apiUrl } from './apiBaseUrl'
import type { PublicMetaPurchaseEvent } from './mercadoPagoPaymentsService'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface ClipWebhookEndpoint {
  source: 'render' | 'configured' | 'app_domain' | 'current_request' | string
  label: string
  description: string
  url: string
}

export interface ClipModeConnectionStatus {
  mode: 'test' | 'live'
  connected: boolean
  configured?: boolean
  accountLabel?: string
  hasApiKey?: boolean
  apiKeyPreview?: string
  connectedAt?: string | null
  updatedAt?: string | null
}

export interface ClipPaymentConfig {
  enabled: boolean
  configured: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  hasApiKey?: boolean
  apiKeyPreview?: string
  connectedAt?: string | null
  disconnectedAt?: string | null
  modeConnections?: Record<'test' | 'live', ClipModeConnectionStatus>
  webhookEndpointPath?: string
  webhookEndpoints?: ClipWebhookEndpoint[]
}

export interface SaveClipPaymentConfigPayload {
  enabled?: boolean
  mode: 'test' | 'live'
  accountLabel?: string
  apiKey?: string
  disconnectMode?: boolean
}

export interface ClipPaymentLinkPayload {
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
  metadata?: Record<string, unknown>
}

export interface PublicClipSubscriptionStart {
  subscriptionId: string
  paymentProvider?: string
  paymentMethod?: string
  intervalType?: string
  intervalCount?: number
  startDate?: string | null
  nextRunAt?: string | null
  cancelAt?: string | null
}

export interface PublicClipPayment {
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
  provider: 'clip'
  contact: {
    id?: string
    name?: string
    email?: string
    phone?: string
  }
  clipPaymentId?: string | null
  clipReceiptNo?: string | null
  pendingAction?: {
    type?: string
    url?: string
  } | null
  apiKey?: string
  subscriptionStart?: PublicClipSubscriptionStart | null
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

export interface ClipPublicCardPaymentPayload {
  token?: string
  tokenId?: string
  cardTokenId?: string
  installments?: number
  email?: string
  phone?: string
}

export interface ClipCardPaymentResponse {
  payment: PublicClipPayment
  clipPaymentId?: string
  clipReceiptNo?: string
  status?: string
  statusDetail?: Record<string, unknown> | null
  pendingAction?: {
    type?: string
    url?: string
  } | null
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || 'No se pudo completar la operación')
  }
  return data.data as T
}

export const clipPaymentsService = {
  async getConfig(): Promise<ClipPaymentConfig> {
    const response = await fetch(apiUrl('/api/clip/config'), {
      credentials: 'include'
    })
    return parseResponse<ClipPaymentConfig>(response)
  },

  async saveConfig(payload: SaveClipPaymentConfigPayload): Promise<ClipPaymentConfig> {
    const response = await fetch(apiUrl('/api/clip/config'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<ClipPaymentConfig>(response)
  },

  async deleteConfig(): Promise<ClipPaymentConfig> {
    const response = await fetch(apiUrl('/api/clip/config'), {
      method: 'DELETE',
      credentials: 'include'
    })
    return parseResponse<ClipPaymentConfig>(response)
  },

  async testConfig(payload: Partial<SaveClipPaymentConfigPayload> = {}): Promise<{ ok: boolean; mode: 'test' | 'live'; accountLabel?: string; apiKeyPreview?: string }> {
    const response = await fetch(apiUrl('/api/clip/config/test'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse(response)
  },

  async createPaymentLink(payload: ClipPaymentLinkPayload): Promise<{ payment: PublicClipPayment; paymentUrl: string; publicPaymentId: string }> {
    const response = await fetch(apiUrl('/api/clip/payment-links'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse(response)
  },

  async getPublicPayment(publicPaymentId: string): Promise<PublicClipPayment> {
    const response = await fetch(apiUrl(`/api/clip/public/payments/${encodeURIComponent(publicPaymentId)}`))
    return parseResponse<PublicClipPayment>(response)
  },

  async createPublicCardPayment(publicPaymentId: string, payload: ClipPublicCardPaymentPayload): Promise<ClipCardPaymentResponse> {
    const response = await fetch(apiUrl(`/api/clip/public/payments/${encodeURIComponent(publicPaymentId)}/card`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<ClipCardPaymentResponse>(response)
  },

  async refreshPublicPayment(publicPaymentId: string, clipPaymentId?: string): Promise<ClipCardPaymentResponse> {
    const response = await fetch(apiUrl(`/api/clip/public/payments/${encodeURIComponent(publicPaymentId)}/refresh`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipPaymentId })
    })
    return parseResponse<ClipCardPaymentResponse>(response)
  }
}
