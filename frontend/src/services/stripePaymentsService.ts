import { apiUrl } from './apiBaseUrl'

export interface StripePaymentConfig {
  enabled: boolean
  configured: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publishableKey: string
  hasSecretKey: boolean
  secretKeyPreview?: string
  hasWebhookSecret: boolean
  webhookSecretPreview?: string
}

export interface SaveStripePaymentConfigPayload {
  enabled?: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publishableKey: string
  secretKey?: string
  webhookSecret?: string
}

export interface StripePaymentLinkPayload {
  contactId?: string
  contactName?: string
  email?: string
  phone?: string
  amount: number
  currency: string
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
}

export interface StripePaymentIntentResponse {
  clientSecret: string
  publishableKey: string
  status: string
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

  async testConfig(payload: SaveStripePaymentConfigPayload): Promise<{ ok: boolean; livemode: boolean; available: number }> {
    const response = await fetch(apiUrl('/api/stripe/config/test'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
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

  async getPublicPayment(publicPaymentId: string, sync = false): Promise<PublicStripePayment> {
    const query = sync ? '?sync=true' : ''
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}${query}`))
    return parseApiResponse<PublicStripePayment>(response)
  },

  async createPublicPaymentIntent(publicPaymentId: string): Promise<StripePaymentIntentResponse> {
    const response = await fetch(apiUrl(`/api/stripe/public/payments/${encodeURIComponent(publicPaymentId)}/intent`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return parseApiResponse<StripePaymentIntentResponse>(response)
  }
}
