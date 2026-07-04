import { apiUrl } from './apiBaseUrl'
import type { PublicMetaPurchaseEvent } from './mercadoPagoPaymentsService'
import type { PublicPaymentSettings } from './paymentSettingsService'

export interface RebillWebhookEndpoint {
  source: 'render' | 'configured' | 'app_domain' | 'current_request' | string
  label: string
  description: string
  url: string
}

export interface RebillModeConnectionStatus {
  mode: 'test' | 'live'
  connected: boolean
  configured?: boolean
  accountLabel?: string
  publicKey?: string
  hasPublicKey?: boolean
  hasSecretKey?: boolean
  secretKeyPreview?: string
  webhookId?: string | null
  webhookUrl?: string | null
  webhookConfigured?: boolean
  webhookStatus?: string | null
  webhookLastError?: string | null
  webhookSyncedAt?: string | null
  connectedAt?: string | null
  updatedAt?: string | null
}

export interface RebillPaymentConfig {
  enabled: boolean
  configured: boolean
  mode: 'test' | 'live'
  defaultCurrency: string
  accountLabel?: string
  publicKey?: string
  hasPublicKey?: boolean
  hasSecretKey?: boolean
  secretKeyPreview?: string
  connectedAt?: string | null
  disconnectedAt?: string | null
  webhookId?: string | null
  webhookUrl?: string | null
  webhookConfigured?: boolean
  webhookStatus?: string | null
  webhookLastError?: string | null
  webhookSyncedAt?: string | null
  modeConnections?: Record<'test' | 'live', RebillModeConnectionStatus>
  webhookEndpointPath?: string
  webhookEndpoints?: RebillWebhookEndpoint[]
}

export interface SaveRebillPaymentConfigPayload {
  enabled?: boolean
  mode: 'test' | 'live'
  defaultCurrency?: string
  publicKey?: string
  secretKey?: string
  disconnectMode?: boolean
}

export interface RebillPaymentConfigTestResult {
  ok: boolean
  mode: 'test' | 'live'
  accountLabel?: string
  publicKeyPreview?: string
  secretKeyPreview?: string
  organization?: {
    id?: string
    name?: string
    alias?: string
    status?: string
    environment?: string
  }
  message?: string
}

export interface RebillInstantProduct {
  name: Array<{ language: 'en' | 'es' | 'pt'; text: string }>
  description?: Array<{ language: 'en' | 'es' | 'pt'; text: string }>
  amount: number
  currency: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface RebillCustomerInformation {
  email?: string
  fullName?: string
  phoneNumber?: {
    number?: string
    countryCode?: string
  }
  [key: string]: unknown
}

export interface RebillPaymentLinkPayload {
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

export interface RebillPaymentPlanPayload {
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
    frequency?: string
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
    paymentMethod?: string
  }>
  paymentMethodId?: string
  cardSetupAmount?: number
  source?: string
}

export interface RebillSavedPaymentSource {
  id: string
  contactId: string
  rebillCustomerId: string
  rebillCardId: string
  brand: string
  last4: string
  name?: string
  mode: 'test' | 'live'
  isDefault: boolean
  label: string
  expiresLabel: string
}

export interface RebillPaymentPlanResponse {
  flowId: string
  currentState: string
  paymentMode: 'test' | 'live'
  firstPaymentLink?: string | null
  firstPaymentPaymentId?: string | null
  cardSetupLink?: string | null
  cardSetupPaymentId?: string | null
  cardSetupAmount?: number
  savedPaymentSource?: RebillSavedPaymentSource | null
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

export interface PublicRebillPayment {
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
  provider: 'rebill'
  contact: {
    id?: string
    name?: string
    email?: string
    phone?: string
  }
  publicKey?: string
  rebillPaymentId?: string | null
  rebillSubscriptionId?: string | null
  instantProduct?: RebillInstantProduct | null
  customerInformation?: RebillCustomerInformation | null
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

export interface RebillConfirmPaymentPayload {
  rebillPaymentId?: string
  paymentId?: string
}

export interface RebillSavedCardPaymentPayload {
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
}

export interface RebillConfirmPaymentResponse {
  payment: PublicRebillPayment
  rebillPaymentId?: string
  status?: string
  statusDetail?: unknown
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || 'No se pudo completar la operación')
  }
  return data.data as T
}

export const rebillPaymentsService = {
  async getConfig(): Promise<RebillPaymentConfig> {
    const response = await fetch(apiUrl('/api/rebill/config'), {
      credentials: 'include'
    })
    return parseResponse<RebillPaymentConfig>(response)
  },

  async saveConfig(payload: SaveRebillPaymentConfigPayload): Promise<RebillPaymentConfig> {
    const response = await fetch(apiUrl('/api/rebill/config'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<RebillPaymentConfig>(response)
  },

  async deleteConfig(): Promise<RebillPaymentConfig> {
    const response = await fetch(apiUrl('/api/rebill/config'), {
      method: 'DELETE',
      credentials: 'include'
    })
    return parseResponse<RebillPaymentConfig>(response)
  },

  async testConfig(payload: Partial<SaveRebillPaymentConfigPayload> = {}): Promise<RebillPaymentConfigTestResult> {
    const response = await fetch(apiUrl('/api/rebill/config/test'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse(response)
  },

  async createPaymentLink(payload: RebillPaymentLinkPayload): Promise<{ payment: PublicRebillPayment; paymentUrl: string; publicPaymentId: string }> {
    const response = await fetch(apiUrl('/api/rebill/payment-links'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse(response)
  },

  async createPaymentPlan(payload: RebillPaymentPlanPayload): Promise<RebillPaymentPlanResponse> {
    const response = await fetch(apiUrl('/api/rebill/payment-plans'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<RebillPaymentPlanResponse>(response)
  },

  async getSavedPaymentSources(contactId: string): Promise<RebillSavedPaymentSource[]> {
    const response = await fetch(apiUrl(`/api/rebill/contacts/${encodeURIComponent(contactId)}/payment-sources`), {
      credentials: 'include'
    })
    return parseResponse<RebillSavedPaymentSource[]>(response)
  },

  async createSavedCardPayment(payload: RebillSavedCardPaymentPayload): Promise<{ payment: PublicRebillPayment }> {
    const response = await fetch(apiUrl('/api/rebill/saved-card-payments'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<{ payment: PublicRebillPayment }>(response)
  },

  async getPublicPayment(publicPaymentId: string): Promise<PublicRebillPayment> {
    const response = await fetch(apiUrl(`/api/rebill/public/payments/${encodeURIComponent(publicPaymentId)}`))
    return parseResponse<PublicRebillPayment>(response)
  },

  async confirmPublicPayment(publicPaymentId: string, payload: RebillConfirmPaymentPayload): Promise<RebillConfirmPaymentResponse> {
    const response = await fetch(apiUrl(`/api/rebill/public/payments/${encodeURIComponent(publicPaymentId)}/confirm`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return parseResponse<RebillConfirmPaymentResponse>(response)
  }
}
