import { getAppConfig, setAppConfig } from '../config/database.js'
import {
  getAccountBusinessProfile,
  normalizeAccountBusinessProfile
} from './accountBusinessProfileService.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

const PAYMENT_SETTINGS_CONFIG_KEY = 'payments_settings'
const PAYMENT_MODE_TEST = 'test'
const PAYMENT_MODE_LIVE = 'live'
const PAYMENT_MODES = [PAYMENT_MODE_TEST, PAYMENT_MODE_LIVE]
const PAYMENT_AUTOMATION_CHANNELS = ['whatsapp', 'whatsapp_qr', 'email', 'both']
const PAYMENT_AUTOMATION_CONTENT_MODES = ['template', 'direct']
const GIGSTACK_MODES = [PAYMENT_MODE_TEST, PAYMENT_MODE_LIVE]
const GIGSTACK_AUTOMATION_TYPES = ['pue_invoice', 'none']
const GIGSTACK_CLIENT_MATCH_MODES = ['email', 'client_id_or_email']
const GIGSTACK_FISCAL_SOURCES = ['manual', 'gigstack']
const GIGSTACK_PROTECTED_FISCAL_FIELDS = [
  'enabled',
  'taxName',
  'rateType',
  'rateValue',
  'rateSource',
  'gigstackTaxFactor',
  'calculationMode',
  'country',
  'fiscalId',
  'fiscalLegalName',
  'fiscalPostalCode',
  'fiscalRegime',
  'gigstackFiscalSource',
  'gigstackSatConnected',
  'gigstackTeamId'
]

const DEFAULT_PAYMENT_AUTOMATION_MESSAGES = {
  reminder: 'Hola {{contact.first_name}}, tienes un pago pendiente de {{payment.amount}} por {{payment.product}}. Puedes completarlo aquí: {{payment.url}}',
  receipt: 'Hola {{contact.first_name}}, recibimos tu pago de {{payment.amount}} por {{payment.product}}. Puedes descargar tu comprobante aquí: {{payment.receipt_url}}',
  failed: 'Hola {{contact.first_name}}, no pudimos procesar tu pago de {{payment.amount}} por {{payment.product}}. Puedes intentarlo de nuevo aquí: {{payment.url}}'
}

const DEFAULT_PAYMENT_SETTINGS = {
  paymentMode: PAYMENT_MODE_LIVE,
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
    reminderMessageText: DEFAULT_PAYMENT_AUTOMATION_MESSAGES.reminder,
    reminderTemplateId: '',
    reminderTemplateName: 'recordatorio_pago_pendiente',
    reminderTemplateLanguage: 'es_MX',
    receiptDeliveryEnabled: true,
    receiptDeliveryChannel: 'email',
    receiptQrFallbackEnabled: false,
    receiptContentMode: 'template',
    receiptMessageText: DEFAULT_PAYMENT_AUTOMATION_MESSAGES.receipt,
    receiptTemplateId: '',
    receiptTemplateName: 'comprobante_pago_recibido',
    receiptTemplateLanguage: 'es_MX',
    afterPaymentAction: 'send_receipt',
    afterPaymentMessage: 'Gracias, recibimos tu pago. Te compartimos tu comprobante.',
    failedPaymentEnabled: true,
    failedPaymentChannel: 'whatsapp',
    failedPaymentQrFallbackEnabled: false,
    failedPaymentContentMode: 'template',
    failedPaymentMessageText: DEFAULT_PAYMENT_AUTOMATION_MESSAGES.failed,
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
    gigstackFiscalSource: 'manual',
    gigstackSatConnected: false,
    gigstackTeamId: '',
    gigstackTaxFactor: 'Tasa',
    gigstackDefaultDescription: 'Producto o servicio cobrado',
    gigstackDefaultProductKey: '01010101',
    gigstackDefaultUnitKey: 'E48',
    gigstackDefaultUnitName: 'Unidad de Servicio',
    gigstackDefaultPaymentMethod: '99',
    gigstackAutomateInvoiceOnComplete: true,
    gigstackAutomationType: 'pue_invoice',
    gigstackClientMatchMode: 'email',
    gigstackSendEmail: true,
    gigstackPortalUrl: '',
    gigstackTestApiTokenEncrypted: '',
    gigstackLiveApiTokenEncrypted: ''
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

export function mergeGigstackFiscalProfileTaxes(currentTaxes = {}, profile = {}) {
  return {
    ...currentTaxes,
    enabled: true,
    gigstackEnabled: true,
    gigstackFiscalSource: 'gigstack',
    gigstackSatConnected: profile.satConnected,
    gigstackTeamId: profile.teamId,
    taxName: profile.taxName,
    rateType: 'percentage',
    rateValue: profile.rateValue,
    rateSource: 'gigstack',
    gigstackTaxFactor: profile.taxFactor,
    calculationMode: profile.calculationMode,
    country: profile.country,
    fiscalId: profile.fiscalId,
    fiscalLegalName: profile.fiscalLegalName,
    fiscalPostalCode: profile.fiscalPostalCode,
    fiscalRegime: profile.fiscalRegime
  }
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

export function decodeGigstackTokenMetadata(value = '') {
  const token = cleanString(value, 5000)
  const payloadSegment = token.split('.')[1]
  if (!payloadSegment) return { valid: false, mode: null }

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
    if (typeof payload?.livemode !== 'boolean') return { valid: false, mode: null }
    return {
      valid: true,
      mode: payload.livemode ? PAYMENT_MODE_LIVE : PAYMENT_MODE_TEST,
      livemode: payload.livemode,
      keyId: cleanString(payload.key_id, 180),
      teamId: cleanString(payload.team, 180)
    }
  } catch {
    return { valid: false, mode: null }
  }
}

function gigstackModeTitle(mode) {
  return mode === PAYMENT_MODE_LIVE ? 'Live' : 'Test'
}

function validateSubmittedGigstackToken(token, expectedMode) {
  if (!token || isMaskedSecret(token)) return
  const metadata = decodeGigstackTokenMetadata(token)
  if (!metadata.valid) {
    const error = new Error(`La API key ${gigstackModeTitle(expectedMode)} de Gigstack no tiene un formato válido.`)
    error.status = 400
    throw error
  }
  if (metadata.mode !== expectedMode) {
    const error = new Error(`La API key pegada es ${gigstackModeTitle(metadata.mode)}, pero se intentó guardar en ${gigstackModeTitle(expectedMode)}.`)
    error.status = 400
    throw error
  }
}

function resolveLegacyGigstackTokenStorage(taxes = {}, previousTaxes = {}) {
  if (cleanBoolean(taxes.clearGigstackApiToken, false)) return { encrypted: '', plain: '', mode: null }

  const submittedToken = cleanString(taxes.gigstackApiToken || taxes.gigstackToken, 5000)
  if (submittedToken && !isMaskedSecret(submittedToken)) {
    const metadata = decodeGigstackTokenMetadata(submittedToken)
    return { encrypted: encrypt(submittedToken), plain: submittedToken, mode: metadata.mode }
  }

  const encrypted = cleanString(
    taxes.gigstackApiTokenEncrypted ||
      taxes.gigstackTokenEncrypted ||
      previousTaxes.gigstackApiTokenEncrypted ||
      previousTaxes.gigstackTokenEncrypted,
    5000
  )
  const plain = decryptSecret(encrypted)
  return { encrypted, plain, mode: decodeGigstackTokenMetadata(plain).mode }
}

function resolveGigstackTokenStorage(mode, taxes = {}, previousTaxes = {}, legacyToken = {}) {
  const prefix = mode === PAYMENT_MODE_LIVE ? 'gigstackLive' : 'gigstackTest'
  const clearKey = mode === PAYMENT_MODE_LIVE ? 'clearGigstackLiveApiToken' : 'clearGigstackTestApiToken'

  if (cleanBoolean(taxes[clearKey], false) || cleanBoolean(taxes.clearGigstackApiToken, false)) {
    return { encrypted: '', plain: '' }
  }

  const submittedToken = cleanString(taxes[`${prefix}ApiToken`], 5000)
  if (submittedToken && !isMaskedSecret(submittedToken)) {
    validateSubmittedGigstackToken(submittedToken, mode)
    return {
      encrypted: encrypt(submittedToken),
      plain: submittedToken
    }
  }

  const encrypted = cleanString(
    taxes[`${prefix}ApiTokenEncrypted`] || previousTaxes[`${prefix}ApiTokenEncrypted`],
    5000
  )

  if (!encrypted && legacyToken.mode === mode) {
    return { encrypted: legacyToken.encrypted, plain: legacyToken.plain }
  }

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

function hasOwn(object = {}, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function readBusinessProfileFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return cleanBoolean(value, fallback)
}

function hasCheckoutBusinessOverride(checkout = {}) {
  return Boolean(
    cleanString(checkout.logoUrl, 1000) ||
    cleanString(checkout.supportEmail, 160) ||
    cleanString(checkout.supportPhone, 80)
  )
}

function hasReceiptBusinessOverride(receipt = {}) {
  return Boolean(
    cleanString(receipt.logoUrl, 1000) ||
    cleanString(receipt.businessName, 160) ||
    cleanString(receipt.businessEmail, 160) ||
    cleanString(receipt.businessPhone, 80) ||
    cleanLongString(receipt.businessAddress, 500) ||
    cleanString(receipt.businessWebsite, 250) ||
    cleanLongString(receipt.terms, 12000)
  )
}

function resolveStoredBusinessProfileFlags(stored = {}) {
  const checkout = stored.checkout || {}
  const receipt = stored.receipt || {}
  const checkoutHasFlag = hasOwn(checkout, 'useBusinessProfile') || hasOwn(checkout, 'useAccountBusinessProfile')
  const receiptHasFlag = hasOwn(receipt, 'useBusinessProfile') || hasOwn(receipt, 'useAccountBusinessProfile')

  return {
    checkoutUseBusinessProfile: checkoutHasFlag
      ? readBusinessProfileFlag(checkout.useBusinessProfile ?? checkout.useAccountBusinessProfile, DEFAULT_PAYMENT_SETTINGS.checkout.useBusinessProfile)
      : !hasCheckoutBusinessOverride(checkout),
    receiptUseBusinessProfile: receiptHasFlag
      ? readBusinessProfileFlag(receipt.useBusinessProfile ?? receipt.useAccountBusinessProfile, DEFAULT_PAYMENT_SETTINGS.receipt.useBusinessProfile)
      : !hasReceiptBusinessOverride(receipt)
  }
}

export function resolvePaymentSettingsBusinessProfile(settings = {}, profile = {}) {
  const normalizedProfile = normalizeAccountBusinessProfile(profile)
  const checkout = settings.checkout || {}
  const receipt = settings.receipt || {}
  const checkoutUsesProfile = checkout.useBusinessProfile !== false
  const receiptUsesProfile = receipt.useBusinessProfile !== false

  return {
    ...settings,
    checkout: {
      ...checkout,
      ...(checkoutUsesProfile
        ? {
            logoUrl: normalizedProfile.logoUrl || checkout.logoUrl || '',
            supportEmail: normalizedProfile.email || checkout.supportEmail || '',
            supportPhone: normalizedProfile.phone || checkout.supportPhone || ''
          }
        : {})
    },
    receipt: {
      ...receipt,
      ...(receiptUsesProfile
        ? {
            logoUrl: normalizedProfile.logoUrl || receipt.logoUrl || '',
            businessName: normalizedProfile.name || receipt.businessName || '',
            businessEmail: normalizedProfile.email || receipt.businessEmail || '',
            businessPhone: normalizedProfile.phone || receipt.businessPhone || '',
            businessAddress: normalizedProfile.address || receipt.businessAddress || '',
            businessWebsite: normalizedProfile.website || receipt.businessWebsite || '',
            terms: normalizedProfile.terms || receipt.terms || ''
          }
        : {})
    }
  }
}

export function normalizePaymentSettings(input = {}, options = {}) {
  const checkout = input.checkout || {}
  const receipt = input.receipt || {}
  const automations = input.automations || {}
  const taxes = input.taxes || {}
  const previousTaxes = options.previousTaxes || {}
  const country = cleanCountry(taxes.country || taxes.countryCode || taxes.businessCountry || previousTaxes.country)
  const gigstackEnabled = cleanBoolean(
    taxes.gigstackEnabled ?? taxes.jigsawEnabled,
    DEFAULT_PAYMENT_SETTINGS.taxes.gigstackEnabled
  )
  const automaticRateValue = resolveAutomaticTaxRate(country)
  const rateValue = gigstackEnabled
    ? cleanNumber(taxes.rateValue ?? previousTaxes.rateValue, automaticRateValue, { min: 0, max: 100, decimals: 6 })
    : automaticRateValue
  const legacyGigstackToken = resolveLegacyGigstackTokenStorage(taxes, previousTaxes)
  const gigstackTokens = Object.fromEntries(GIGSTACK_MODES.map((mode) => [
    mode,
    resolveGigstackTokenStorage(mode, taxes, previousTaxes, legacyGigstackToken)
  ]))
  const hasGigstackTestApiToken = Boolean(gigstackTokens.test.plain || gigstackTokens.test.encrypted)
  const hasGigstackLiveApiToken = Boolean(gigstackTokens.live.plain || gigstackTokens.live.encrypted)
  const gigstackAutomateInvoice = cleanBoolean(
    taxes.gigstackAutomateInvoiceOnComplete,
    DEFAULT_PAYMENT_SETTINGS.taxes.gigstackAutomateInvoiceOnComplete
  )
  const requestedGigstackAutomationType = cleanEnum(
    taxes.gigstackAutomationType,
    GIGSTACK_AUTOMATION_TYPES,
    gigstackAutomateInvoice ? 'pue_invoice' : 'none'
  )
  const gigstackAutomationType = gigstackAutomateInvoice && requestedGigstackAutomationType === 'pue_invoice'
    ? 'pue_invoice'
    : 'none'

  const normalized = {
    paymentMode: normalizePaymentSettingsMode(input.paymentMode || input.mode, DEFAULT_PAYMENT_SETTINGS.paymentMode),
    checkout: {
      useBusinessProfile: readBusinessProfileFlag(
        checkout.useBusinessProfile ?? checkout.useAccountBusinessProfile,
        DEFAULT_PAYMENT_SETTINGS.checkout.useBusinessProfile
      ),
      logoUrl: cleanString(checkout.logoUrl, 1000),
      headline: cleanString(checkout.headline, 120) || DEFAULT_PAYMENT_SETTINGS.checkout.headline,
      description: cleanLongString(checkout.description, 420) || DEFAULT_PAYMENT_SETTINGS.checkout.description,
      buttonLabel: cleanString(checkout.buttonLabel, 60) || DEFAULT_PAYMENT_SETTINGS.checkout.buttonLabel,
      supportEmail: cleanString(checkout.supportEmail, 160),
      supportPhone: cleanString(checkout.supportPhone, 80),
      showSecureBadge: cleanBoolean(checkout.showSecureBadge, DEFAULT_PAYMENT_SETTINGS.checkout.showSecureBadge)
    },
    receipt: {
      useBusinessProfile: readBusinessProfileFlag(
        receipt.useBusinessProfile ?? receipt.useAccountBusinessProfile,
        DEFAULT_PAYMENT_SETTINGS.receipt.useBusinessProfile
      ),
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
      reminderChannel: cleanEnum(automations.reminderChannel, PAYMENT_AUTOMATION_CHANNELS, DEFAULT_PAYMENT_SETTINGS.automations.reminderChannel),
      reminderQrFallbackEnabled: cleanBoolean(automations.reminderQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.reminderQrFallbackEnabled),
      reminderContentMode: cleanEnum(automations.reminderContentMode, PAYMENT_AUTOMATION_CONTENT_MODES, DEFAULT_PAYMENT_SETTINGS.automations.reminderContentMode),
      reminderMessageText: cleanLongString(automations.reminderMessageText, 3000) || DEFAULT_PAYMENT_SETTINGS.automations.reminderMessageText,
      reminderTemplateId: cleanString(automations.reminderTemplateId, 180),
      reminderTemplateName: cleanString(automations.reminderTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.reminderTemplateName,
      reminderTemplateLanguage: cleanString(automations.reminderTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.reminderTemplateLanguage,
      receiptDeliveryEnabled: cleanBoolean(automations.receiptDeliveryEnabled, DEFAULT_PAYMENT_SETTINGS.automations.receiptDeliveryEnabled),
      receiptDeliveryChannel: cleanEnum(automations.receiptDeliveryChannel, PAYMENT_AUTOMATION_CHANNELS, DEFAULT_PAYMENT_SETTINGS.automations.receiptDeliveryChannel),
      receiptQrFallbackEnabled: cleanBoolean(automations.receiptQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.receiptQrFallbackEnabled),
      receiptContentMode: cleanEnum(automations.receiptContentMode, PAYMENT_AUTOMATION_CONTENT_MODES, DEFAULT_PAYMENT_SETTINGS.automations.receiptContentMode),
      receiptMessageText: cleanLongString(automations.receiptMessageText, 3000) || DEFAULT_PAYMENT_SETTINGS.automations.receiptMessageText,
      receiptTemplateId: cleanString(automations.receiptTemplateId, 180),
      receiptTemplateName: cleanString(automations.receiptTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.receiptTemplateName,
      receiptTemplateLanguage: cleanString(automations.receiptTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.receiptTemplateLanguage,
      afterPaymentAction: cleanEnum(automations.afterPaymentAction, ['none', 'send_receipt', 'start_automation', 'tag_contact'], DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentAction),
      afterPaymentMessage: cleanLongString(automations.afterPaymentMessage, 1000) || DEFAULT_PAYMENT_SETTINGS.automations.afterPaymentMessage,
      failedPaymentEnabled: cleanBoolean(automations.failedPaymentEnabled, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentEnabled),
      failedPaymentChannel: cleanEnum(automations.failedPaymentChannel, PAYMENT_AUTOMATION_CHANNELS, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentChannel),
      failedPaymentQrFallbackEnabled: cleanBoolean(automations.failedPaymentQrFallbackEnabled, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentQrFallbackEnabled),
      failedPaymentContentMode: cleanEnum(automations.failedPaymentContentMode, PAYMENT_AUTOMATION_CONTENT_MODES, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentContentMode),
      failedPaymentMessageText: cleanLongString(automations.failedPaymentMessageText, 3000) || DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentMessageText,
      failedPaymentTemplateId: cleanString(automations.failedPaymentTemplateId, 180),
      failedPaymentTemplateName: cleanString(automations.failedPaymentTemplateName, 180) || DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentTemplateName,
      failedPaymentTemplateLanguage: cleanString(automations.failedPaymentTemplateLanguage, 20) || DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentTemplateLanguage,
      failedPaymentDelayHours: cleanNumber(automations.failedPaymentDelayHours, DEFAULT_PAYMENT_SETTINGS.automations.failedPaymentDelayHours, { min: 1, max: 168 })
    },
    taxes: {
      enabled: gigstackEnabled ? true : cleanBoolean(taxes.enabled, DEFAULT_PAYMENT_SETTINGS.taxes.enabled),
      taxName: cleanString(taxes.taxName, 80) || DEFAULT_PAYMENT_SETTINGS.taxes.taxName,
      rateType: 'percentage',
      rateValue,
      rateSource: gigstackEnabled ? 'gigstack' : 'automatic',
      gigstackTaxFactor: cleanEnum(taxes.gigstackTaxFactor, ['Tasa', 'Cuota', 'Exento'], 'Tasa'),
      calculationMode: cleanEnum(taxes.calculationMode, ['exclusive', 'inclusive'], DEFAULT_PAYMENT_SETTINGS.taxes.calculationMode),
      country,
      fiscalId: cleanString(taxes.fiscalId, 120),
      fiscalLegalName: cleanString(taxes.fiscalLegalName || taxes.legalName, 180),
      fiscalPostalCode: cleanString(taxes.fiscalPostalCode || taxes.postalCode, 20),
      fiscalRegime: cleanString(taxes.fiscalRegime || taxes.taxRegime, 120),
      provider: 'gigstack',
      gigstackEnabled,
      gigstackFiscalSource: cleanEnum(
        gigstackEnabled ? 'gigstack' : taxes.gigstackFiscalSource,
        GIGSTACK_FISCAL_SOURCES,
        gigstackEnabled ? 'gigstack' : DEFAULT_PAYMENT_SETTINGS.taxes.gigstackFiscalSource
      ),
      gigstackSatConnected: gigstackEnabled && cleanBoolean(
        taxes.gigstackSatConnected,
        DEFAULT_PAYMENT_SETTINGS.taxes.gigstackSatConnected
      ),
      gigstackTeamId: gigstackEnabled ? cleanString(taxes.gigstackTeamId, 180) : '',
      gigstackDefaultDescription: cleanString(taxes.gigstackDefaultDescription || taxes.defaultDescription, 500) || DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultDescription,
      gigstackDefaultProductKey: cleanGigstackProductKey(taxes.gigstackDefaultProductKey || taxes.productKey),
      gigstackDefaultUnitKey: cleanGigstackUnitKey(taxes.gigstackDefaultUnitKey || taxes.unitKey),
      gigstackDefaultUnitName: cleanString(taxes.gigstackDefaultUnitName || taxes.unitName, 120) || DEFAULT_PAYMENT_SETTINGS.taxes.gigstackDefaultUnitName,
      gigstackDefaultPaymentMethod: cleanGigstackPaymentMethod(taxes.gigstackDefaultPaymentMethod || taxes.paymentMethod),
      gigstackAutomateInvoiceOnComplete: gigstackAutomationType === 'pue_invoice',
      gigstackAutomationType,
      gigstackClientMatchMode: cleanEnum(
        taxes.gigstackClientMatchMode,
        GIGSTACK_CLIENT_MATCH_MODES,
        DEFAULT_PAYMENT_SETTINGS.taxes.gigstackClientMatchMode
      ),
      gigstackSendEmail: cleanBoolean(taxes.gigstackSendEmail, DEFAULT_PAYMENT_SETTINGS.taxes.gigstackSendEmail),
      gigstackPortalUrl: cleanUrl(taxes.gigstackPortalUrl || taxes.customerPortalUrl || taxes.portalUrl),
      gigstackTestApiTokenPreview: maskSecret(gigstackTokens.test.plain),
      hasGigstackTestApiToken,
      gigstackLiveApiTokenPreview: maskSecret(gigstackTokens.live.plain),
      hasGigstackLiveApiToken,
      hasGigstackApiToken: hasGigstackTestApiToken || hasGigstackLiveApiToken
    }
  }

  if (options.includeSecrets) {
    normalized.taxes.gigstackTestApiToken = gigstackTokens.test.plain
    normalized.taxes.gigstackLiveApiToken = gigstackTokens.live.plain
  }

  if (options.includePrivateStorage) {
    normalized.taxes.gigstackTestApiTokenEncrypted = gigstackTokens.test.encrypted
    normalized.taxes.gigstackLiveApiTokenEncrypted = gigstackTokens.live.encrypted
  }

  return normalized
}

export function calculatePaymentTax(amount, rawTaxes = {}) {
  const taxes = normalizePaymentSettings({ taxes: rawTaxes }).taxes
  const baseAmount = roundMoney(amount)
  const rateValue = roundMoney(taxes.rateValue)

  if (!taxes.enabled || baseAmount <= 0) return null

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
    gigstackTaxFactor: taxes.gigstackTaxFactor,
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
  const checkout = { ...(settings.checkout || {}) }
  const receipt = { ...(settings.receipt || {}) }

  if (checkout.useBusinessProfile !== false) {
    checkout.logoUrl = ''
    checkout.supportEmail = ''
    checkout.supportPhone = ''
  }

  if (receipt.useBusinessProfile !== false) {
    receipt.logoUrl = ''
    receipt.businessName = ''
    receipt.businessEmail = ''
    receipt.businessPhone = ''
    receipt.businessAddress = ''
    receipt.businessWebsite = ''
    receipt.terms = ''
  }

  return {
    ...settings,
    checkout,
    receipt,
    taxes: {
      ...(settings.taxes || {}),
      gigstackApiToken: undefined,
      gigstackApiTokenPreview: undefined,
      gigstackApiTokenEncrypted: undefined,
      gigstackTokenEncrypted: undefined,
      hasGigstackApiToken: undefined,
      gigstackTestApiToken: undefined,
      gigstackTestApiTokenPreview: undefined,
      hasGigstackTestApiToken: undefined,
      clearGigstackTestApiToken: undefined,
      gigstackLiveApiToken: undefined,
      gigstackLiveApiTokenPreview: undefined,
      hasGigstackLiveApiToken: undefined,
      clearGigstackLiveApiToken: undefined
    }
  }
}

export async function getPaymentSettings(options = {}) {
  const stored = parseStoredSettings(await getAppConfig(PAYMENT_SETTINGS_CONFIG_KEY))
  const businessProfileFlags = resolveStoredBusinessProfileFlags(stored)
  const normalized = normalizePaymentSettings({
    paymentMode: stored.paymentMode || DEFAULT_PAYMENT_SETTINGS.paymentMode,
    checkout: {
      ...DEFAULT_PAYMENT_SETTINGS.checkout,
      ...(stored.checkout || {}),
      useBusinessProfile: businessProfileFlags.checkoutUseBusinessProfile
    },
    receipt: {
      ...DEFAULT_PAYMENT_SETTINGS.receipt,
      ...(stored.receipt || {}),
      useBusinessProfile: businessProfileFlags.receiptUseBusinessProfile
    },
    automations: { ...DEFAULT_PAYMENT_SETTINGS.automations, ...(stored.automations || {}) },
    taxes: { ...DEFAULT_PAYMENT_SETTINGS.taxes, ...(stored.taxes || {}) }
  }, options)

  if (options.resolveBusinessProfile === false) return normalized

  return resolvePaymentSettingsBusinessProfile(normalized, await getAccountBusinessProfile())
}

export async function savePaymentSettings(input = {}, options = {}) {
  const current = await getPaymentSettings({
    includeSecrets: true,
    includePrivateStorage: true,
    resolveBusinessProfile: false
  })
  const requestedTaxes = { ...current.taxes, ...(input.taxes || {}) }
  const requestedGigstackEnabled = cleanBoolean(
    requestedTaxes.gigstackEnabled,
    current.taxes.gigstackEnabled
  )

  if (requestedGigstackEnabled && !current.taxes.gigstackEnabled && !options.allowGigstackFiscalOverride) {
    const error = new Error('Primero conecta Gigstack para importar y validar la configuración fiscal del equipo.')
    error.status = 409
    throw error
  }

  if (requestedGigstackEnabled && current.taxes.gigstackEnabled && !options.allowGigstackFiscalOverride) {
    for (const field of GIGSTACK_PROTECTED_FISCAL_FIELDS) {
      requestedTaxes[field] = current.taxes[field]
    }
  }

  const next = normalizePaymentSettings({
    paymentMode: input.paymentMode ?? current.paymentMode,
    checkout: { ...current.checkout, ...(input.checkout || {}) },
    receipt: { ...current.receipt, ...(input.receipt || {}) },
    automations: { ...current.automations, ...(input.automations || {}) },
    taxes: requestedTaxes
  }, {
    previousTaxes: current.taxes,
    includePrivateStorage: true
  })
  await setAppConfig(PAYMENT_SETTINGS_CONFIG_KEY, settingsForStorage(next))
  return getPaymentSettings()
}

export async function getPaymentGatewayMode() {
  const settings = await getPaymentSettings()
  return normalizePaymentSettingsMode(settings.paymentMode)
}

// PAY2-009: el pago público (/pay/:id) no debe exponer la identidad fiscal del
// merchant (RFC/fiscalId, razón social, CP, régimen) ni la config interna del
// proveedor (Gigstack). Solo se exponen los campos necesarios para mostrar y
// calcular el impuesto en el checkout.
function publicTaxes(taxes = {}) {
  return {
    enabled: taxes.enabled,
    taxName: taxes.taxName,
    rateType: taxes.rateType,
    rateValue: taxes.rateValue,
    rateSource: taxes.rateSource,
    calculationMode: taxes.calculationMode,
    country: taxes.country
  }
}

export async function getPublicPaymentSettings() {
  const settings = await getPaymentSettings()
  return {
    paymentMode: settings.paymentMode,
    checkout: settings.checkout,
    receipt: settings.receipt,
    // PAY2-009: filtrar campos fiscales sensibles antes de exponerlos públicamente
    taxes: publicTaxes(settings.taxes)
  }
}
