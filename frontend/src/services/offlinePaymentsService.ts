import { apiUrl } from './apiBaseUrl'
import type {
  PublicStripePayment,
  PublicStripePaymentPlan,
  PublicStripePaymentPlanInstallment
} from './stripePaymentsService'

export interface OfflinePaymentPlanInstallment extends PublicStripePaymentPlanInstallment {
  paymentMethod?: 'offline' | string | null
}

export interface PublicOfflinePaymentPlan extends Omit<PublicStripePaymentPlan, 'provider' | 'installments'> {
  provider: 'offline'
  reminderChannel?: string
  reminderChannelLabel?: string
  reminderDaysBefore?: number
  reminderTime?: string
  installments: OfflinePaymentPlanInstallment[]
}

export interface PublicOfflinePayment extends Omit<PublicStripePayment, 'provider' | 'publishableKey' | 'paymentPlan'> {
  provider: 'offline'
  paymentPlan?: PublicOfflinePaymentPlan | null
}

export interface OfflinePaymentPlanPayload {
  contact: {
    id: string
    name?: string
    email?: string
    phone?: string
  }
  totalAmount: number
  currency: string
  applyTax?: boolean
  taxCalculationMode?: 'exclusive' | 'inclusive'
  title: string
  description?: string
  firstPayment: {
    enabled: boolean
    amount: number
    date?: string
    method?: string
  }
  remainingFrequency: string
  reminderDaysBefore: number
  reminderTime: string
  remainingPayments: Array<{
    sequence: number
    amount: number
    percentage?: number | null
    dueDate: string
    frequency?: string
  }>
  lineItems?: Array<Record<string, unknown>>
  invoicePayload?: Record<string, unknown>
  source?: string
  idempotencyKey: string
}

export interface OfflinePaymentPlanResult {
  flowId: string
  currentState: string
  paymentMode: 'test' | 'live'
  reminderChannel: string
  reminderChannelLabel: string
  reminderDaysBefore: number
  reminderTime: string
  firstPaymentPaymentId?: string | null
  scheduledPayments: Array<{
    installmentId: string
    paymentId: string
    publicPaymentId: string
    paymentUrl: string
    sequence: number
    amount: number
    currency: string
    dueDate: string
    status: string
  }>
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error || 'No se pudo completar la operación offline.')
  return (data?.data ?? data) as T
}

export const offlinePaymentsService = {
  async createPaymentPlan(payload: OfflinePaymentPlanPayload): Promise<OfflinePaymentPlanResult> {
    const response = await fetch(apiUrl('/api/offline/payment-plans'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.idempotencyKey
      },
      body: JSON.stringify(payload)
    })
    return parseResponse<OfflinePaymentPlanResult>(response)
  },

  async getPublicPayment(publicPaymentId: string): Promise<PublicOfflinePayment> {
    const response = await fetch(apiUrl(`/api/offline/public/payments/${encodeURIComponent(publicPaymentId)}`))
    return parseResponse<PublicOfflinePayment>(response)
  }
}
