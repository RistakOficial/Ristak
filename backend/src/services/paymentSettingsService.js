import { getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'
const PAYMENT_MODE_TEST = 'test'
const PAYMENT_MODE_LIVE = 'live'
const PAYMENT_MODES = [PAYMENT_MODE_TEST, PAYMENT_MODE_LIVE]

const DEFAULT_PAYMENT_SETTINGS = {
  paymentMode: PAYMENT_MODE_LIVE,
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
    gigstackApiTokenEncrypted: ''
  }
}

const AUTOMATIC_TAX_RATES_BY_COUNTRY = {
  MX: 16,
  CO: 19,
  CL: 19,
  US: 0
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

export function normalizePaymentSettingsMode(value, fallback = DEFAULT_PAYMENT_SETTINGS.paymentMode) {
  const normalized = cleanString(value, 12).toLowerCase()
  return PAYMENT_MODES.includes(normalized) ? normalized : fallback
}

function cleanNumber(value, fallback, { min = 0, max = 9999, decimals = 0 } = {}) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const bounded = Math.min(Math.max(parsed, min), max)
  const factor = 10 ** decimals
  return Math.round(bounded * factor) / factor
}

function cleanCountry(value) {
  const normalized = cleanString(value, 2).toUpperCase()
  return /^[A-Z]{2}$/.test(normalized) ? normalized : DEFAULT_PAYMENT_SETTINGS.taxes.country
}

function cleanGigstackProductKey(value, fallback = DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultProductKey) {
  const normalized = cleanString(value, 20).replace(/\D/g, '').slice(0, 8)
  return normalized.length === 8 ? normalized : fallback
}

function cleanGigstackUnitKey(value, fallback = DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultUnitKey) {
  const normalized = cleanString(value, 10).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized || fallback
}

function cleanGigstackPaymentMethod(value, fallback = DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultPaymentMethod) {
  const digits = cleanString(value, 2).replace(/\D/g, '')
  return digits ? digits.padStart(2, '0').slice(-2) : fallback
}

function cleanUrl(value, maxLength = 1000) {
  const rawValue = cleanString(value, maxLength)
  if (!rawValue) return ''
  const withProtocol = /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`
  try {
    const url = new URL(withProtocol)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    return url.toString()
  } catch {
    return rawValue
  }
}

function resolveAutomaticTaxRate(country) {
  return AUTOMATIC_TAX_RATES_BY_COUNTRY[country] ?? AUTOMATIC_TAX_RATES_BY_COUNTRY.MX
}

function maskSecret(value = '') {
  const cleanValue = cleanString(value, 500)
  if (!cleanValue) return ''
  if (cleanValue.length <= 8) return '••••'
  return `${cleanValue.slice(0, 4)}••••${cleanValue.slice(-4)}`
}

function isMaskedSecret(value = '') {
  return /[•*]/.test(String(value || ''))
}

function decryptSecret(value = '') {
  const cleanValue = cleanString(value, 3000)
  if (!cleanValue) return ''
  try {
    return decrypt(cleanValue)
  } catch (error) {
    logger.warn(`No se pudo desencriptar el token de Gigstack: ${error.message}`)
    return ''
  }
}

function resolveGigstackTokenStorage(taxes = {}, previousTaxes = {}) {
  if (cleanBoolean(taxes.clearGigstackApiToken, false)) {
    return { encrypted: '', plain: '' }
  }

  const submittedToken = cleanString(taxes.gigstackApiToken || taxes.gigstackToken, 3000)
  if (submittedToken && !isMaskedSecret(submittedToken)) {
    return {
      encrypted: encrypt(submittedToken),
      plain: submittedToken
    }
  }

  const encrypted = cleanString(
    taxes.gigstackApiTokenEncrypted ||
      taxes.gigstackTokenEncrypted ||
      previousTaxes.gigstackApiTokenEncrypted ||
      previousTaxes.gigstackTokenEncrypted,
    3000
  )

  return {
    encrypted,
    plain: decryptSecret(encrypted)
  }
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

export function normalizePaymentSettings(input = {}, options = {}) {
  const checkout = input.checkout || {}
  const receipt = input.receipt || {}
  const automations = input.automations || {}
  const taxes = input.taxes || {}
  const previousTaxes = options.previousTaxes || {}
  const country = cleanCountry(taxes.country || taxes.countryCode || taxes.businessCountry || previousTaxes.country)
  const rateValue = resolveAutomaticTaxRate(country)
  const gigstackToken = resolveGigstackTokenStorage(taxes, previousTaxes)
  const hasGigstackApiToken = Boolean(gigstackToken.plain || gigstackToken.encrypted)

  const normalized = {
    paymentMode: normalizePaymentSettingsMode(input.paymentMode || input.mode, DEFAULT_PAYMENT_SETTINGS.paymentMode),
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
      reminderQrFallbackEnabled: cleanBoolean(automations.reminderQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.reminderQrFallbackEnabled),
      reminderTemplateId: cleanString(automations.reminderTemplateId, 180),
      reminderTemplateName: cleanString(automations.reminderTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.reminderTemplateName,
      reminderTemplateLanguage: cleanString(automations.reminderTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.reminderTemplateLanguage,
      receiptDeliveryEnabled: cleanBoolean(automations.receiptDeliveryEnabled, DEFAULT_PAYMENT_SETTINGS.automations.receiptDeliveryEnabled),
      receiptDeliveryChannel: cleanEnum(automations.receiptDeliveryChannel, ['whatsapp', 'email', 'both'], DEFAULT_PAYMENT_SETTINGS.automations.receiptDeliveryChannel),
      receiptQrFallbackEnabled: cleanBoolean(automations.receiptQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.receiptQrFallbackEnabled),
      receiptTemplateId: cleanString(automations.receiptTemplateId, 180),
      receiptTemplateName: cleanString(automations.receiptTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.receiptTemplateName,
      receiptTemplateLanguage: cleanString(automations.receiptTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.receiptTemplateLanguage,
      afterPaymentAction: cleanEnum(automations.afterPaymentAction, ['none', 'send_receipt', 'start_automation', 'tag_contact'], DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentAction),
      afterPaymentMessage: cleanLongString(automations.afterPaymentMessage, 1000) || DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentMessage,
      failedPaymentEnabled: cleanBoolean(automations.failedPaymentEnabled, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentEnabled),
      failedPaymentChannel: cleanEnum(automations.failedPaymentChannel, ['whatsapp', 'email', 'both'], DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentChannel),
      failedPaymentQrFallbackEnabled: cleanBoolean(automations.failedPaymentQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentQrFallbackEnabled),
      failedPaymentTemplateId: cleanString(automations.failedPaymentTemplateId, 180),
      failedPaymentTemplateName: cleanString(automations.failedPaymentTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentTemplateName,
      failedPaymentTemplateLanguage: cleanString(automations.failedPaymentTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentTemplateLanguage,
      failedPaymentDelayHours: cleanNumber(automations.failedPaymentDelayHours, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentDelayHours, { min: 1, max: 168 })
    },
    taxes: {
      enabled: cleanBoolean(taxes.enabled, DEFAULT_PAYMENT_SETTINGS.taxes.enabled),
      taxName: cleanString(taxes.taxName, 80) || DEFAULT_PAYMENT_SETTINGS.taxes.taxName,
      rateType: 'percentage',
      rateValue,
      rateSource: 'automatic',
      calculationMode: cleanEnum(taxes.calculationMode, ['exclusive', 'inclusive'], DEFAULT_PAYMENT_SETTINGS.taxes.calculationMode),
      country,
      fiscalId: cleanString(taxes.fiscalId, 120),
      fiscalLegalName: cleanString(taxes.fiscalLegalName || taxes.legalName, 180),
      fiscalPostalCode: cleanString(taxes.fiscalPostalCode || taxes.postalCode, 20),
      fiscalRegime: cleanString(taxes.fiscalRegime || taxes.taxRegime, 120),
      provider: 'gigstack',
      gigstackEnabled: cleanBoolean(taxes.gigstackEnabled ?? taxes.jigsawEnabled, DEFAULT_PAYMENT_SETTINGS.taxes.gigstackEnabled),
      gigstackDefaultProductKey: cleanGigstackProductKey(taxes.gigstackDefaultProductKey || taxes.productKey),
      gigstackDefaultUnitKey: cleanGigstackUnitKey(taxes.gigstackDefaultUnitKey || taxes.unitKey),
      gigstackDefaultUnitName: cleanString(taxes.gigstackDefaultUnitName || taxes.unitName, 120) || DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultUnitName,
      gigstackDefaultPaymentMethod: cleanGigstackPaymentMethod(taxes.gigstackDefaultPaymentMethod || taxes.paymentMethod),
      gigstackAutomateInvoiceOnComplete: cleanBoolean(taxes.gigstackAutomateInvoiceOnComplete, DEFAULT_PAYMENT_SETTINGS.taxes.gigstackAutomateInvoiceOnComplete),
      gigstackPortalUrl: cleanUrl(taxes.gigstackPortalUrl || taxes.customerPortalUrl || taxes.portalUrl),
      gigstackApiTokenPreview: maskSecret(gigstackToken.plain),
      hasGigstackApiToken
    }
  }

  if (options.includeSecrets) {
    normalized.taxes.gigstackApiToken = gigstackToken.plain
  }

  if (options.includePrivateStorage) {
    normalized.taxes.gigstackApiTokenEncrypted = gigstackToken.encrypted
  }

  return normalized
}

export function calculatePaymentTax(amount, rawTaxes = {}) {
  const taxes = normalizePaymentSettings({ taxes: rawTaxes }).taxes
  const baseAmount = roundMoney(amount)
  const rateValue = roundMoney(taxes.rateValue)

  if (!taxes.enabled || baseAmount <= 0 || rateValue <= 0) return null

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
    rateSource: taxes.rateSource,
    calculationMode: taxes.calculationMode,
    country: taxes.country,
    fiscalId: taxes.fiscalId,
    fiscalLegalName: taxes.fiscalLegalName,
    fiscalPostalCode: taxes.fiscalPostalCode,
    fiscalRegime: taxes.fiscalRegime,
    provider: taxes.provider,
    subtotalAmount: roundMoney(subtotalAmount),
    taxAmount: roundMoney(taxAmount),
    totalAmount: roundMoney(totalAmount)
  }
}

function settingsForStorage(settings = {}) {
  return {
    ...settings,
    taxes: {
      ...(settings.taxes || {}),
      gigstackApiToken: undefined,
      gigstackApiTokenPreview: undefined,
      hasGigstackApiToken: undefined
    }
  }
}

export async function getPaymentSettings(options = {}) {
  const stored = parseStoredSettings(await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY))
  return normalizePaymentSettings({
    paymentMode: stored.paymentMode || DEFAULT_PAYMENT_SETTINGS.paymentMode,
    checkout: { ...DEFAULT_PAYMENT_SETTINGS.checkout, ...(stored.checkout || {}) },
    receipt: { ...DEFAULT_PAYMENT_SETTINGS.receipt, ...(stored.receipt || {}) },
    automations: { ...DEFAULT_PAYMENT_SETTINGS.automations, ...(stored.automations || {}) },
    taxes: { ...DEFAULT_PAYMENT_SETTINGS.taxes, ...(stored.taxes || {}) }
  }, options)
}

export async function savePaymentSettings(input = {}) {
  const current = await getPaymentSettings({ includeSecrets: true, includePrivateStorage: true })
  const next = normalizePaymentSettings({
    paymentMode: input.paymentMode ?? current.paymentMode,
    checkout: { ...current.checkout, ...(input.checkout || {}) },
    receipt: { ...current.receipt, ...(input.receipt || {}) },
    automations: { ...current.automations, ...(input.automations || {}) },
    taxes: { ...current.taxes, ...(input.taxes || {}) }
  }, {
    previousTaxes: current.taxes,
    includePrivateStorage: true
  })
  await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, settingsForStorage(next))
  return normalizePaymentSettings(next)
}

export async function getPaymentGatewayMode() {
  const settings = await getPaymentSettings()
  return normalizePaymentSettingsMode(settings.paymentMode)
}

export async function getPublicPaymentSettings() {
  const settings = await getPaymentSettings()
  return {
    paymentMode: settings.paymentMode,
    checkout: settings.checkout,
    receipt: settings.receipt,
    taxes: settings.taxes
  }
}
