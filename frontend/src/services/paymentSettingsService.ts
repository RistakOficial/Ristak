import { apiUrl } from './apiBaseUrl'

export interface PaymentCheckoutSettings {
  useBusinessProfile: boolean
  logoUrl: string
  headline: string
  description: string
  buttonLabel: string
  supportEmail: string
  supportPhone: string
  showSecureBadge: boolean
}

export interface PaymentReceiptSettings {
  useBusinessProfile: boolean
  logoUrl: string
  invoiceTemplate: 'classic' | 'executive' | 'accent' | 'ledger'
  invoicePalette: 'graphite' | 'sage' | 'indigo' | 'terracotta' | 'champagne' | 'custom'
  invoiceAccentColor: string
  invoicePaperColor: string
  invoiceTextColor: string
  title: string
  intro: string
  footer: string
  businessName: string
  businessEmail: string
  businessPhone: string
  businessAddress: string
  businessWebsite: string
  terms: string
  showBusinessInfo: boolean
  showCustomerInfo: boolean
  showTerms: boolean
}

export type PaymentAutomationChannel = 'whatsapp' | 'whatsapp_qr' | 'email' | 'both'

export interface PaymentAutomationSettings {
  remindersEnabled: boolean
  reminderDaysBefore: number
  reminderChannel: PaymentAutomationChannel
  reminderQrFallbackEnabled: boolean
  reminderContentMode: 'template' | 'direct'
  reminderMessageText: string
  reminderTemplateId: string
  reminderTemplateName: string
  reminderTemplateLanguage: string
  receiptDeliveryEnabled: boolean
  receiptDeliveryChannel: PaymentAutomationChannel
  receiptQrFallbackEnabled: boolean
  receiptContentMode: 'template' | 'direct'
  receiptMessageText: string
  receiptTemplateId: string
  receiptTemplateName: string
  receiptTemplateLanguage: string
  afterPaymentAction: 'none' | 'send_receipt' | 'start_automation' | 'tag_contact'
  afterPaymentMessage: string
  failedPaymentEnabled: boolean
  failedPaymentChannel: PaymentAutomationChannel
  failedPaymentQrFallbackEnabled: boolean
  failedPaymentContentMode: 'template' | 'direct'
  failedPaymentMessageText: string
  failedPaymentTemplateId: string
  failedPaymentTemplateName: string
  failedPaymentTemplateLanguage: string
  failedPaymentDelayHours: number
}

export interface PaymentTaxSettings {
  enabled: boolean
  taxName: string
  rateType: 'percentage' | 'fixed'
  rateValue: number
  rateSource: 'automatic'
  calculationMode: 'exclusive' | 'inclusive'
  country: string
  fiscalId: string
  fiscalLegalName: string
  fiscalPostalCode: string
  fiscalRegime: string
  provider: 'gigstack'
  gigstackEnabled: boolean
  gigstackDefaultProductKey: string
  gigstackDefaultUnitKey: string
  gigstackDefaultUnitName: string
  gigstackDefaultPaymentMethod: string
  gigstackAutomateInvoiceOnComplete: boolean
  gigstackPortalUrl?: string
  gigstackApiToken?: string
  gigstackApiTokenPreview?: string
  hasGigstackApiToken?: boolean
  clearGigstackApiToken?: boolean
}

export interface PaymentSettings {
  paymentMode: 'test' | 'live'
  checkout: PaymentCheckoutSettings
  receipt: PaymentReceiptSettings
  automations: PaymentAutomationSettings
  taxes: PaymentTaxSettings
}

export type PublicPaymentSettings = Pick<PaymentSettings, 'paymentMode' | 'checkout' | 'receipt' | 'taxes'>

export interface PaymentReceiptPreviewSession {
  url: string
  expiresAt: string
}

export const defaultPaymentSettings: PaymentSettings = {
  paymentMode: 'live',
  checkout: {
    useBusinessProfile: true,
    logoUrl: '',
    headline: 'Pago seguro',
    description: 'Revisa el resumen y completa tu pago con tarjeta.',
    buttonLabel: 'Pagar ahora',
    supportEmail: '',
    supportPhone: '',
    showSecureBadge: true
  },
  receipt: {
    useBusinessProfile: true,
    logoUrl: '',
    invoiceTemplate: 'classic',
    invoicePalette: 'graphite',
    invoiceAccentColor: '#111827',
    invoicePaperColor: '#ffffff',
    invoiceTextColor: '#111827',
    title: 'Comprobante de pago',
    intro: 'Tu pago fue recibido correctamente.',
    footer: 'Gracias por tu pago.',
    businessName: '',
    businessEmail: '',
    businessPhone: '',
    businessAddress: '',
    businessWebsite: '',
    terms: '',
    showBusinessInfo: true,
    showCustomerInfo: true,
    showTerms: true
  },
  automations: {
    remindersEnabled: true,
    reminderDaysBefore: 3,
    reminderChannel: 'whatsapp',
    reminderQrFallbackEnabled: false,
    reminderContentMode: 'template',
    reminderMessageText: 'Hola {{contact.first_name}}, tienes un pago pendiente de {{payment.amount}} por {{payment.product}}. Puedes completarlo aquí: {{payment.url}}',
    reminderTemplateId: '',
    reminderTemplateName: 'recordatorio_pago_pendiente',
    reminderTemplateLanguage: 'es_MX',
    receiptDeliveryEnabled: true,
    receiptDeliveryChannel: 'email',
    receiptQrFallbackEnabled: false,
    receiptContentMode: 'template',
    receiptMessageText: 'Hola {{contact.first_name}}, recibimos tu pago de {{payment.amount}} por {{payment.product}}. Puedes descargar tu comprobante aquí: {{payment.receipt_url}}',
    receiptTemplateId: '',
    receiptTemplateName: 'comprobante_pago_recibido',
    receiptTemplateLanguage: 'es_MX',
    afterPaymentAction: 'send_receipt',
    afterPaymentMessage: 'Gracias, recibimos tu pago. Te compartimos tu comprobante.',
    failedPaymentEnabled: true,
    failedPaymentChannel: 'whatsapp',
    failedPaymentQrFallbackEnabled: false,
    failedPaymentContentMode: 'template',
    failedPaymentMessageText: 'Hola {{contact.first_name}}, no pudimos procesar tu pago de {{payment.amount}} por {{payment.product}}. Puedes intentarlo de nuevo aquí: {{payment.url}}',
    failedPaymentTemplateId: '',
    failedPaymentTemplateName: 'pago_fallido_reintento',
    failedPaymentTemplateLanguage: 'es_MX',
    failedPaymentDelayHours: 2
  },
  taxes: {
    enabled: false,
    taxName: 'IVA',
    rateType: 'percentage',
    rateValue: 16,
    rateSource: 'automatic',
    calculationMode: 'exclusive',
    country: 'MX',
    fiscalId: '',
    fiscalLegalName: '',
    fiscalPostalCode: '',
    fiscalRegime: '',
    provider: 'gigstack',
    gigstackEnabled: false,
    gigstackDefaultProductKey: '82101800',
    gigstackDefaultUnitKey: 'E48',
    gigstackDefaultUnitName: 'Unidad de Servicio',
    gigstackDefaultPaymentMethod: '99',
    gigstackAutomateInvoiceOnComplete: true,
    gigstackPortalUrl: '',
    gigstackApiToken: '',
    gigstackApiTokenPreview: '',
    hasGigstackApiToken: false,
    clearGigstackApiToken: false
  }
}

function getAuthHeaders(): Record<string, string> {
  try {
    const token = window.localStorage.getItem('auth_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.error || 'No se pudo completar la operación')
  }
  return (data?.data ?? data) as T
}

export const paymentSettingsService = {
  async getSettings(signal?: AbortSignal): Promise<PaymentSettings> {
    const response = await fetch(apiUrl('/api/settings/payments'), {
      headers: getAuthHeaders(),
      signal
    })
    return parseApiResponse<PaymentSettings>(response)
  },

  async saveSettings(payload: PaymentSettings): Promise<PaymentSettings> {
    const response = await fetch(apiUrl('/api/settings/payments'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify(payload)
    })
    return parseApiResponse<PaymentSettings>(response)
  },

  async createReceiptPreviewSession(payload: PaymentSettings, currency = 'MXN'): Promise<PaymentReceiptPreviewSession> {
    const response = await fetch(apiUrl('/api/settings/payments/receipt-preview-session'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ settings: payload, currency })
    })
    return parseApiResponse<PaymentReceiptPreviewSession>(response)
  }
}
