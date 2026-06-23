import { apiUrl } from './apiBaseUrl'

export interface PaymentCheckoutSettings {
  logoUrl: string
  headline: string
  description: string
  buttonLabel: string
  supportEmail: string
  supportPhone: string
  showSecureBadge: boolean
}

export interface PaymentReceiptSettings {
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

export interface PaymentAutomationSettings {
  remindersEnabled: boolean
  reminderDaysBefore: number
  reminderChannel: 'whatsapp' | 'email' | 'both'
  reminderQrFallbackEnabled: boolean
  reminderTemplateId: string
  reminderTemplateName: string
  reminderTemplateLanguage: string
  receiptDeliveryEnabled: boolean
  receiptDeliveryChannel: 'whatsapp' | 'email' | 'both'
  receiptQrFallbackEnabled: boolean
  receiptTemplateId: string
  receiptTemplateName: string
  receiptTemplateLanguage: string
  afterPaymentAction: 'none' | 'send_receipt' | 'start_automation' | 'tag_contact'
  afterPaymentMessage: string
  failedPaymentEnabled: boolean
  failedPaymentChannel: 'whatsapp' | 'email' | 'both'
  failedPaymentQrFallbackEnabled: boolean
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
    logoUrl: '',
    headline: 'Pago seguro',
    description: 'Revisa el resumen y completa tu pago con tarjeta.',
    buttonLabel: 'Pagar ahora',
    supportEmail: '',
    supportPhone: '',
    showSecureBadge: true
  },
  receipt: {
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
    reminderTemplateId: '',
    reminderTemplateName: 'recordatorio_pago_pendiente',
    reminderTemplateLanguage: 'es_MX',
    receiptDeliveryEnabled: true,
    receiptDeliveryChannel: 'email',
    receiptQrFallbackEnabled: false,
    receiptTemplateId: '',
    receiptTemplateName: 'comprobante_pago_recibido',
    receiptTemplateLanguage: 'es_MX',
    afterPaymentAction: 'send_receipt',
    afterPaymentMessage: 'Gracias, recibimos tu pago. Te compartimos tu comprobante.',
    failedPaymentEnabled: true,
    failedPaymentChannel: 'whatsapp',
    failedPaymentQrFallbackEnabled: false,
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
  async getSettings(): Promise<PaymentSettings> {
    const response = await fetch(apiUrl('/api/settings/payments'), {
      headers: getAuthHeaders()
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
