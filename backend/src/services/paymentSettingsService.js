import { getAppConfig, setAppConfig } from '../config/database.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'

const DEFAULT_PAYMENT_SETTINGS = {
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
    receiptDeliveryEnabled: true,
    afterPaymentAction: 'send_receipt',
    afterPaymentMessage: 'Gracias, recibimos tu pago. Te compartimos tu comprobante.',
    failedPaymentEnabled: true,
    failedPaymentDelayHours: 2
  },
  taxes: {
    enabled: false,
    taxName: 'IVA',
    rateType: 'percentage',
    rateValue: 16,
    calculationMode: 'exclusive',
    fiscalId: '',
    provider: 'jigsaw',
    jigsawEnabled: false,
    applyToStripe: true,
    applyToHighLevel: true
  }
}

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanHexColor(value, fallback) {
  const normalized = String(value || '').trim()
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : fallback
}

function cleanLongString(value, maxLength = 3000) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanBoolean(value, fallback = false) {
  if (value === true || value === false) return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function cleanNumber(value, fallback, { min = 0, max = 9999, decimals = 0 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const bounded = Math.min(Math.max(parsed, min), max)
  const factor = 10 ** decimals
  return Math.round(bounded * factor) / factor
}

function cleanEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function roundMoney(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

function parseStoredSettings(rawValue) {
  if (!rawValue) return {}
  try {
    const parsed = JSON.parse(rawValue)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function normalizePaymentSettings(input = {}) {
  const checkout = input.checkout || {}
  const receipt = input.receipt || {}
  const automations = input.automations || {}
  const taxes = input.taxes || {}

  return {
    checkout: {
      logoUrl: cleanString(checkout.logoUrl, 1000),
      headline: cleanString(checkout.headline, 120) || DEFAULT_PAYMENT_SETTINGS.checkout.headline,
      description: cleanLongString(checkout.description, 420) || DEFAULT_PAYMENT_SETTINGS.checkout.description,
      buttonLabel: cleanString(checkout.buttonLabel, 60) || DEFAULT_PAYMENT_SETTINGS.checkout.buttonLabel,
      supportEmail: cleanString(checkout.supportEmail, 160),
      supportPhone: cleanString(checkout.supportPhone, 80),
      showSecureBadge: cleanBoolean(checkout.showSecureBadge, DEFAULT_PAYMENT_SETTINGS.checkout.showSecureBadge)
    },
    receipt: {
      logoUrl: cleanString(receipt.logoUrl, 1000),
      invoiceTemplate: cleanEnum(receipt.invoiceTemplate, ['classic', 'executive', 'accent', 'ledger'], DEFAULT_PAYMENT_SETTINGS.receipt.invoiceTemplate),
      invoicePalette: cleanEnum(receipt.invoicePalette, ['graphite', 'sage', 'indigo', 'terracotta', 'champagne', 'custom'], DEFAULT_PAYMENT_SETTINGS.receipt.invoicePalette),
      invoiceAccentColor: cleanHexColor(receipt.invoiceAccentColor, DEFAULT_PAYMENT_SETTINGS.receipt.invoiceAccentColor),
      invoicePaperColor: cleanHexColor(receipt.invoicePaperColor, DEFAULT_PAYMENT_SETTINGS.receipt.invoicePaperColor),
      invoiceTextColor: cleanHexColor(receipt.invoiceTextColor, DEFAULT_PAYMENT_SETTINGS.receipt.invoiceTextColor),
      title: cleanString(receipt.title, 120) || DEFAULT_PAYMENT_SETTINGS.receipt.title,
      intro: cleanLongString(receipt.intro, 420) || DEFAULT_PAYMENT_SETTINGS.receipt.intro,
      footer: cleanLongString(receipt.footer, 420),
      businessName: cleanString(receipt.businessName, 160),
      businessEmail: cleanString(receipt.businessEmail, 160),
      businessPhone: cleanString(receipt.businessPhone, 80),
      businessAddress: cleanLongString(receipt.businessAddress, 500),
      businessWebsite: cleanString(receipt.businessWebsite, 250),
      terms: cleanLongString(receipt.terms, 12000),
      showBusinessInfo: cleanBoolean(receipt.showBusinessInfo, DEFAULT_PAYMENT_SETTINGS.receipt.showBusinessInfo),
      showCustomerInfo: cleanBoolean(receipt.showCustomerInfo, DEFAULT_PAYMENT_SETTINGS.receipt.showCustomerInfo),
      showTerms: cleanBoolean(receipt.showTerms, DEFAULT_PAYMENT_SETTINGS.receipt.showTerms)
    },
    automations: {
      remindersEnabled: cleanBoolean(automations.remindersEnabled, DEFAULT_PAYMENT_SETTINGS.automations.remindersEnabled),
      reminderDaysBefore: cleanNumber(automations.reminderDaysBefore, DEFAULT_PAYMENT_SETTINGS.automations.reminderDaysBefore, { min: 1, max: 60 }),
      reminderChannel: cleanEnum(automations.reminderChannel, ['whatsapp', 'email', 'both'], DEFAULT_PAYMENT_SETTINGS.automations.reminderChannel),
      receiptDeliveryEnabled: cleanBoolean(automations.receiptDeliveryEnabled, DEFAULT_PAYMENT_SETTINGS.automations.receiptDeliveryEnabled),
      afterPaymentAction: cleanEnum(automations.afterPaymentAction, ['none', 'send_receipt', 'start_automation', 'tag_contact'], DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentAction),
      afterPaymentMessage: cleanLongString(automations.afterPaymentMessage, 1000) || DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentMessage,
      failedPaymentEnabled: cleanBoolean(automations.failedPaymentEnabled, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentEnabled),
      failedPaymentDelayHours: cleanNumber(automations.failedPaymentDelayHours, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentDelayHours, { min: 1, max: 168 })
    },
    taxes: {
      enabled: cleanBoolean(taxes.enabled, DEFAULT_PAYMENT_SETTINGS.taxes.enabled),
      taxName: cleanString(taxes.taxName, 80) || DEFAULT_PAYMENT_SETTINGS.taxes.taxName,
      rateType: cleanEnum(taxes.rateType, ['percentage', 'fixed'], DEFAULT_PAYMENT_SETTINGS.taxes.rateType),
      rateValue: cleanNumber(taxes.rateValue, DEFAULT_PAYMENT_SETTINGS.taxes.rateValue, { min: 0, max: 1000000, decimals: 2 }),
      calculationMode: cleanEnum(taxes.calculationMode, ['exclusive', 'inclusive'], DEFAULT_PAYMENT_SETTINGS.taxes.calculationMode),
      fiscalId: cleanString(taxes.fiscalId, 120),
      provider: 'jigsaw',
      jigsawEnabled: cleanBoolean(taxes.jigsawEnabled, DEFAULT_PAYMENT_SETTINGS.taxes.jigsawEnabled),
      applyToStripe: cleanBoolean(taxes.applyToStripe, DEFAULT_PAYMENT_SETTINGS.taxes.applyToStripe),
      applyToHighLevel: cleanBoolean(taxes.applyToHighLevel, DEFAULT_PAYMENT_SETTINGS.taxes.applyToHighLevel)
    }
  }
}

export function calculatePaymentTax(amount, rawTaxes = {}, { provider = 'stripe' } = {}) {
  const taxes = normalizePaymentSettings({ taxes: rawTaxes }).taxes
  const baseAmount = roundMoney(amount)
  const rateValue = roundMoney(taxes.rateValue)

  if (!taxes.enabled || baseAmount <= 0 || rateValue <= 0) return null
  if (provider === 'stripe' && !taxes.applyToStripe) return null
  if (provider === 'highlevel' && !taxes.applyToHighLevel) return null

  const isPercentage = taxes.rateType === 'percentage'
  const inclusive = taxes.calculationMode === 'inclusive'
  let subtotalAmount = baseAmount
  let taxAmount = 0
  let totalAmount = baseAmount

  if (inclusive) {
    taxAmount = isPercentage
      ? baseAmount - (baseAmount / (1 + (rateValue / 100)))
      : Math.min(rateValue, baseAmount)
    subtotalAmount = baseAmount - taxAmount
  } else {
    taxAmount = isPercentage
      ? baseAmount * (rateValue / 100)
      : rateValue
    totalAmount = baseAmount + taxAmount
  }

  return {
    enabled: true,
    taxName: taxes.taxName,
    rateType: taxes.rateType,
    rateValue,
    calculationMode: taxes.calculationMode,
    fiscalId: taxes.fiscalId,
    provider: taxes.provider,
    subtotalAmount: roundMoney(subtotalAmount),
    taxAmount: roundMoney(taxAmount),
    totalAmount: roundMoney(totalAmount)
  }
}

export async function getPaymentSettings() {
  const stored = parseStoredSettings(await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY))
  return normalizePaymentSettings({
    checkout: { ...DEFAULT_PAYMENT_SETTINGS.checkout, ...(stored.checkout || {}) },
    receipt: { ...DEFAULT_PAYMENT_SETTINGS.receipt, ...(stored.receipt || {}) },
    automations: { ...DEFAULT_PAYMENT_SETTINGS.automations, ...(stored.automations || {}) },
    taxes: { ...DEFAULT_PAYMENT_SETTINGS.taxes, ...(stored.taxes || {}) }
  })
}

export async function savePaymentSettings(input = {}) {
  const current = await getPaymentSettings()
  const next = normalizePaymentSettings({
    checkout: { ...current.checkout, ...(input.checkout || {}) },
    receipt: { ...current.receipt, ...(input.receipt || {}) },
    automations: { ...current.automations, ...(input.automations || {}) },
    taxes: { ...current.taxes, ...(input.taxes || {}) }
  })
  await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, next)
  return next
}

export async function getPublicPaymentSettings() {
  const settings = await getPaymentSettings()
  return {
    checkout: settings.checkout,
    receipt: settings.receipt,
    taxes: settings.taxes
  }
}
