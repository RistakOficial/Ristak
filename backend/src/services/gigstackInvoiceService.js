import crypto from 'crypto'
import JSZip from 'jszip'

import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  calculatePaymentTax,
  decodeGigstackTokenMetadata,
  getPaymentSettings
} from './paymentSettingsService.js'
import { sendEmailToContact } from './emailService.js'
import {
  paymentWhatsAppRouteArgs,
  resolvePaymentWhatsAppRoute
} from './paymentAutomationsService.js'
import {
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiTextMessage
} from './whatsappApiService.js'
import {
  signPublicContextClaims,
  verifyPublicContextToken
} from './publicContextTokenService.js'

const GIGSTACK_API_BASE_URL = (process.env.GIGSTACK_API_BASE_URL || 'https://api.gigstack.io/v2').replace(/\/+$/, '')
const GIGSTACK_REQUEST_TIMEOUT_MS = 15_000
const GIGSTACK_FILE_MAX_BYTES = 25 * 1024 * 1024
const GIGSTACK_UNIT_NAMES = {
  E48: 'Unidad de servicio',
  H87: 'Pieza',
  EA: 'Elemento',
  ACT: 'Actividad',
  MON: 'Mes',
  ANN: 'Año',
  HUR: 'Hora',
  DAY: 'Día',
  KGM: 'Kilogramo',
  MTR: 'Metro'
}
const GIGSTACK_JOB_LEASE_MS = 2 * 60 * 1000
const GIGSTACK_JOB_BATCH_SIZE = 10
const GIGSTACK_MAX_ATTEMPTS = 12
const GIGSTACK_DELIVERY_JOB_BATCH_SIZE = 20
const GIGSTACK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000
]
const PAID_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
const REGISTERED_GIGSTACK_STATUSES = new Set(['registered', 'stamped', 'succeeded'])
const GIGSTACK_DELIVERY_FORMATS = new Set(['pdf', 'xml', 'bundle'])
const GIGSTACK_DELIVERY_CHANNELS = new Set(['whatsapp', 'email'])

const defaultGigstackDeliveryDependencies = Object.freeze({
  sendEmailToContact,
  resolvePaymentWhatsAppRoute,
  paymentWhatsAppRouteArgs,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiTextMessage,
  signPublicContextClaims
})
let gigstackDeliveryDependencies = { ...defaultGigstackDeliveryDependencies }

export function setGigstackInvoiceDeliveryDependenciesForTest(overrides = null) {
  gigstackDeliveryDependencies = overrides && typeof overrides === 'object'
    ? { ...defaultGigstackDeliveryDependencies, ...overrides }
    : { ...defaultGigstackDeliveryDependencies }
}

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function escapeHtml(value) {
  return cleanString(value, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function roundMoney(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 100) / 100
}

function positiveQuantity(value) {
  const quantity = Number(value)
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1
}

function createGigstackError(message, { status = 0, code = 'gigstack_error', retryable = false } = {}) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.retryable = retryable
  return error
}

export function normalizeGigstackPaymentMode(value) {
  const normalized = cleanString(value, 24).toLowerCase()
  if (['test', 'sandbox'].includes(normalized)) return 'test'
  if (['live', 'production'].includes(normalized)) return 'live'
  return null
}

function gigstackModeTitle(mode) {
  return mode === 'live' ? 'Live' : 'Test'
}

function getGigstackTokenForMode(taxes = {}, mode) {
  return mode === 'live'
    ? cleanString(taxes.gigstackLiveApiToken, 5000)
    : cleanString(taxes.gigstackTestApiToken, 5000)
}

function assertGigstackTokenMode(token, mode) {
  if (!token) {
    throw createGigstackError(`Falta la API key ${gigstackModeTitle(mode)} de Gigstack.`, {
      code: `missing_${mode}_token`
    })
  }

  const metadata = decodeGigstackTokenMetadata(token)
  if (!metadata.valid) {
    throw createGigstackError(`La API key ${gigstackModeTitle(mode)} de Gigstack no tiene un formato verificable.`, {
      code: `invalid_${mode}_token`
    })
  }
  if (metadata.mode !== mode) {
    throw createGigstackError(
      `La API key configurada para ${gigstackModeTitle(mode)} pertenece al ambiente ${gigstackModeTitle(metadata.mode)}.`,
      { code: 'gigstack_token_mode_mismatch' }
    )
  }
  return metadata
}

function normalizeGigstackTaxRate(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  const percentage = parsed > 0 && parsed <= 1 ? parsed * 100 : parsed
  return Math.round(percentage * 1_000_000) / 1_000_000
}

function normalizeGigstackTeamProfile(response, tokenMetadata) {
  const team = response?.data && typeof response.data === 'object' ? response.data : response
  const settings = team?.settings && typeof team.settings === 'object' ? team.settings : {}
  const taxes = Array.isArray(settings.taxes) ? settings.taxes : []
  const tax = taxes.find((item) => item && typeof item === 'object' && item.withholding !== true) || null
  const rateValue = normalizeGigstackTaxRate(tax?.rate ?? tax?.percentage ?? tax?.value)
  const satConnected = team?.sat?.completed === true

  if (!satConnected) {
    throw createGigstackError('El equipo de Gigstack todavía no tiene completa la conexión con el SAT.', {
      status: 409,
      code: 'gigstack_sat_not_connected'
    })
  }
  if (!tax || rateValue === null) {
    throw createGigstackError('Gigstack no tiene una tasa de impuesto válida configurada para este equipo.', {
      status: 409,
      code: 'gigstack_tax_not_configured'
    })
  }

  const fiscalProfile = {
    fiscalId: cleanString(team?.tax_id, 120),
    fiscalLegalName: cleanString(team?.legal_name, 180),
    fiscalPostalCode: cleanString(team?.address?.zip, 20),
    fiscalRegime: cleanString(team?.tax_system, 120)
  }
  const missingFiscalFields = Object.entries(fiscalProfile)
    .filter(([, value]) => !value)
    .map(([field]) => field)
  if (missingFiscalFields.length) {
    throw createGigstackError('El perfil fiscal de Gigstack está incompleto. Revisa RFC, razón social, régimen y código postal antes de activarlo.', {
      status: 409,
      code: 'gigstack_fiscal_profile_incomplete'
    })
  }

  const unitKey = normalizeGigstackUnitKey(settings.unit_key, '')

  return {
    teamId: cleanString(team?.id || tokenMetadata.teamId, 180),
    satConnected,
    ...fiscalProfile,
    taxName: cleanString(tax?.type || tax?.name || 'IVA', 80) || 'IVA',
    rateValue,
    taxFactor: ['Tasa', 'Cuota', 'Exento'].includes(tax?.factor) ? tax.factor : 'Tasa',
    calculationMode: tax?.inclusive === true ? 'inclusive' : 'exclusive',
    country: 'MX',
    defaultDescription: cleanString(settings.default_description, 500),
    productKey: normalizeGigstackProductKey(settings.product_key, ''),
    unitKey,
    unitName: GIGSTACK_UNIT_NAMES[unitKey] || unitKey
  }
}

function normalizeGigstackProductKey(value, fallback = '01010101') {
  const normalized = cleanString(value, 20).replace(/\D/g, '').slice(0, 8)
  return normalized.length === 8 ? normalized : fallback
}

function normalizeGigstackUnitKey(value, fallback = 'E48') {
  const normalized = cleanString(value, 10).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized || fallback
}

function resolvePaymentForm(method = '', fallback = '99', metadata = {}) {
  const stripeFunding = cleanString(metadata?.stripe?.cardFunding, 40).toLowerCase()
  const candidates = [
    method,
    metadata?.mercadoPago?.paymentTypeId,
    metadata?.mercadoPago?.paymentMethodId,
    stripeFunding === 'credit' ? 'credit_card' : '',
    stripeFunding === 'debit' ? 'debit_card' : ''
  ].map((value) => cleanString(value, 80).toLowerCase()).filter(Boolean)

  for (const normalized of candidates) {
    if (['credit', 'credit_card', 'tarjeta_credito'].includes(normalized)) return '04'
    if (['debit', 'debit_card', 'tarjeta_debito'].includes(normalized)) return '28'
    if (['bank_transfer', 'transfer', 'spei'].includes(normalized)) return '03'
    if (['cash', 'deposit', 'oxxo', 'ticket'].includes(normalized)) return '01'
    if (['check', 'cheque'].includes(normalized)) return '02'
  }

  const fallbackDigits = cleanString(fallback, 2).replace(/\D/g, '')
  return fallbackDigits ? fallbackDigits.padStart(2, '0').slice(-2) : '99'
}

function getStoredLineItems(row) {
  const metadata = parseJson(row.metadata_json)
  return Array.isArray(metadata.lineItems)
    ? metadata.lineItems.filter((item) => item && typeof item === 'object')
    : []
}

function getItemLineAmount(item) {
  const quantity = positiveQuantity(item.quantity ?? item.qty)
  if (item.amount !== undefined && item.amount !== null) return roundMoney(item.amount)
  const unitPrice = item.unit_price ?? item.unitPrice ?? item.price ?? 0
  return roundMoney(Number(unitPrice) * quantity)
}

async function getProductFiscalConfig(item = {}) {
  const candidates = [
    item.localProductId,
    item.productId,
    item.product_id,
    item.ghlProductId,
    item.ghl_product_id
  ].map((value) => cleanString(value, 180)).filter(Boolean)

  for (const productId of candidates) {
    const row = await db.get(
      `SELECT gigstack_product_key, gigstack_unit_key, gigstack_unit_name
       FROM products
       WHERE id = ? OR ghl_product_id = ?
       LIMIT 1`,
      [productId, productId]
    )
    if (row) return row
  }
  return null
}

function buildGigstackTaxLine(tax) {
  return {
    factor: ['Tasa', 'Cuota', 'Exento'].includes(tax.gigstackTaxFactor) ? tax.gigstackTaxFactor : 'Tasa',
    inclusive: tax.calculationMode === 'inclusive',
    rate: roundMoney(tax.rateValue / 100),
    type: cleanString(tax.taxName || tax.name || 'IVA', 20) || 'IVA',
    withholding: false
  }
}

async function buildGigstackItems(row, settings, tax) {
  const taxes = settings.taxes || {}
  const storedItems = getStoredLineItems(row)
  const sourceItems = storedItems.length > 0
    ? storedItems
    : [{
        description: row.description || row.title || taxes.gigstackDefaultDescription || 'Pago',
        amount: tax.calculationMode === 'inclusive' ? tax.totalAmount : tax.subtotalAmount,
        quantity: 1
      }]
  const sourceTotal = sourceItems.reduce((total, item) => total + getItemLineAmount(item), 0)
  const ratioBase = sourceTotal > 0
    ? sourceTotal
    : tax.calculationMode === 'inclusive' ? tax.totalAmount : tax.subtotalAmount
  const taxLine = buildGigstackTaxLine(tax)

  const items = []
  for (const item of sourceItems) {
    const productConfig = await getProductFiscalConfig(item)
    const rawLineAmount = getItemLineAmount(item)
    const ratio = ratioBase > 0 && rawLineAmount > 0 ? rawLineAmount / ratioBase : 1 / sourceItems.length
    const lineAmount = tax.calculationMode === 'inclusive'
      ? roundMoney(tax.totalAmount * ratio)
      : roundMoney(rawLineAmount || tax.subtotalAmount * ratio)
    const quantity = positiveQuantity(item.quantity ?? item.qty)
    const productKey = normalizeGigstackProductKey(
      item.gigstackProductKey || item.product_key || productConfig?.gigstack_product_key,
      normalizeGigstackProductKey(taxes.gigstackDefaultProductKey)
    )
    const unitKey = normalizeGigstackUnitKey(
      item.gigstackUnitKey || item.unit_key || productConfig?.gigstack_unit_key,
      normalizeGigstackUnitKey(taxes.gigstackDefaultUnitKey)
    )
    const unitName = cleanString(
      item.gigstackUnitName || item.unit_name || productConfig?.gigstack_unit_name ||
        taxes.gigstackDefaultUnitName || 'Unidad de Servicio',
      120
    )

    items.push({
      description: cleanString(
        item.description || item.name || row.description || row.title ||
          taxes.gigstackDefaultDescription || 'Pago',
        500
      ),
      discount: roundMoney(item.discount || 0),
      product_key: productKey,
      unit_key: unitKey,
      unit_name: unitName,
      taxes: [taxLine],
      quantity,
      unit_price: roundMoney(lineAmount / quantity)
    })
  }
  return items
}

function getPaymentTax(row, settings) {
  const metadata = parseJson(row.metadata_json)
  const storedTax = metadata.tax && typeof metadata.tax === 'object' ? metadata.tax : null

  if (storedTax?.enabled && Number(storedTax.taxAmount) > 0) {
    return {
      enabled: true,
      taxName: cleanString(storedTax.taxName || storedTax.name) || settings.taxes.taxName,
      rateType: 'percentage',
      rateValue: roundMoney(storedTax.rateValue || storedTax.rate || settings.taxes.rateValue),
      rateSource: storedTax.rateSource || settings.taxes.rateSource,
      gigstackTaxFactor: storedTax.gigstackTaxFactor || settings.taxes.gigstackTaxFactor,
      calculationMode: storedTax.calculationMode || settings.taxes.calculationMode,
      country: storedTax.country || settings.taxes.country,
      fiscalId: storedTax.fiscalId || settings.taxes.fiscalId,
      fiscalLegalName: storedTax.fiscalLegalName || settings.taxes.fiscalLegalName,
      fiscalPostalCode: storedTax.fiscalPostalCode || settings.taxes.fiscalPostalCode,
      fiscalRegime: storedTax.fiscalRegime || settings.taxes.fiscalRegime,
      provider: 'gigstack',
      subtotalAmount: roundMoney(storedTax.subtotalAmount),
      taxAmount: roundMoney(storedTax.taxAmount),
      totalAmount: roundMoney(storedTax.totalAmount || row.amount)
    }
  }
  return calculatePaymentTax(row.amount, settings.taxes)
}

async function buildGigstackPayload(row, settings, tax, mode) {
  const taxes = settings.taxes || {}
  const metadata = parseJson(row.metadata_json)
  const clientId = taxes.gigstackClientMatchMode === 'client_id_or_email'
    ? cleanString(metadata.gigstackClientId || metadata.clientId || '', 180)
    : ''
  const email = cleanString(row.contact_email, 180).toLowerCase()

  if (!clientId && !email) {
    throw createGigstackError('El pago no tiene correo del cliente ni client ID de Gigstack; no se enviará al SAT.', {
      code: 'missing_gigstack_client'
    })
  }

  const client = clientId
    ? { id: clientId }
    : {
        search: { on_key: 'email', on_value: email, auto_create: true },
        name: cleanString(row.contact_name || email, 180),
        email,
        phone: cleanString(row.contact_phone, 80)
      }

  return {
    client,
    automation_type: taxes.gigstackAutomationType === 'none' || taxes.gigstackAutomateInvoiceOnComplete === false
      ? 'none'
      : 'pue_invoice',
    currency: cleanString(row.currency, 3).toUpperCase(),
    items: await buildGigstackItems(row, settings, tax),
    payment_form: resolvePaymentForm(
      row.payment_method,
      taxes.gigstackDefaultPaymentMethod,
      metadata
    ),
    metadata: {
      ristak_payment_id: cleanString(row.id, 160),
      ristak_payment_mode: mode
    },
    idempotency_key: `ristak-payment-${cleanString(row.id, 160)}`,
    // Ristak entrega y audita PDF + XML por sus propios canales. Dejar este
    // flag activo haría que Gigstack mandara un segundo correo sin trazabilidad.
    send_email: false
  }
}

async function gigstackRequest(path, { token, method = 'GET', body } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GIGSTACK_REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetch(`${GIGSTACK_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = cleanString(data?.message || data?.error, 1000) || `Gigstack respondió ${response.status}`
      throw createGigstackError(message, {
        status: response.status,
        code: `gigstack_http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      })
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createGigstackError('Gigstack tardó demasiado en responder.', {
        code: 'gigstack_timeout',
        retryable: true
      })
    }
    if (error?.code) throw error
    throw createGigstackError(cleanString(error?.message, 1000) || 'No se pudo conectar con Gigstack.', {
      code: 'gigstack_network_error',
      retryable: true
    })
  } finally {
    clearTimeout(timeout)
  }
}

export async function getGigstackFiscalProfile({ mode, token } = {}) {
  const normalizedMode = normalizeGigstackPaymentMode(mode)
  if (!normalizedMode) {
    throw createGigstackError('Elige si quieres sincronizar Gigstack Test o Live.', {
      status: 400,
      code: 'invalid_gigstack_mode'
    })
  }

  let selectedToken = cleanString(token, 5000)
  if (!selectedToken) {
    const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
    selectedToken = getGigstackTokenForMode(settings.taxes, normalizedMode)
  }
  const tokenMetadata = assertGigstackTokenMode(selectedToken, normalizedMode)
  if (!tokenMetadata.teamId) {
    throw createGigstackError('La API key de Gigstack no identifica el equipo fiscal.', {
      status: 400,
      code: 'gigstack_missing_team'
    })
  }

  const response = await gigstackRequest(`/teams/${encodeURIComponent(tokenMetadata.teamId)}`, {
    token: selectedToken
  })
  return normalizeGigstackTeamProfile(response, tokenMetadata)
}

function findInvoiceFileReference(payload, format) {
  if (!payload) return null
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const candidates = [
    root?.[format],
    root?.[`${format}_url`],
    root?.[`${format}Url`],
    root?.[`${format}_file`],
    root?.[`${format}File`],
    root?.files?.[format]
  ]
  const files = Array.isArray(root?.files) ? root.files : []
  const listedFile = files.find((file) => {
    const type = cleanString(file?.type || file?.format || file?.extension || file?.name, 120).toLowerCase()
    return type === format || type.endsWith(`.${format}`) || type.includes(format)
  })
  if (listedFile) candidates.push(listedFile)
  return candidates.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '') || null
}

function decodeInlineInvoiceFile(reference, format) {
  if (Buffer.isBuffer(reference)) return reference
  if (reference && typeof reference === 'object') {
    const nested = reference.url || reference.download_url || reference.downloadUrl ||
      reference.file_url || reference.fileUrl || reference.href || reference.base64 ||
      reference.content || reference.data
    return decodeInlineInvoiceFile(nested, format)
  }
  const value = String(reference || '').trim()
  if (!value || /^https?:\/\//i.test(value)) return null
  if (value.startsWith('data:')) {
    const separator = value.indexOf(',')
    if (separator < 0) return null
    const metadata = value.slice(0, separator)
    const content = value.slice(separator + 1)
    return Buffer.from(content, metadata.includes(';base64') ? 'base64' : 'utf8')
  }
  if (format === 'xml' && value.startsWith('<')) return Buffer.from(value, 'utf8')
  if (format === 'pdf' && value.startsWith('%PDF')) return Buffer.from(value, 'binary')
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length >= 32) {
    return Buffer.from(value.replace(/\s/g, ''), 'base64')
  }
  return null
}

function getInvoiceFileUrl(reference) {
  if (typeof reference === 'string' && /^https?:\/\//i.test(reference.trim())) return reference.trim()
  if (!reference || typeof reference !== 'object') return ''
  return cleanString(
    reference.url || reference.download_url || reference.downloadUrl ||
      reference.file_url || reference.fileUrl || reference.href,
    4000
  )
}

function isAllowedGigstackFileHost(hostname) {
  const host = cleanString(hostname, 255).toLowerCase()
  return host === 'api.gigstack.io' || host.endsWith('.gigstack.io') || host.endsWith('.gigstack.pro') ||
    host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com') ||
    host.endsWith('.googleapis.com') || host.endsWith('.googleusercontent.com')
}

async function fetchInvoiceFileUrl(rawUrl, token) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw createGigstackError('Gigstack devolvió una dirección inválida para la factura.', {
      code: 'gigstack_invalid_file_url'
    })
  }
  if (url.protocol !== 'https:' || !isAllowedGigstackFileHost(url.hostname)) {
    throw createGigstackError('Gigstack devolvió una dirección de descarga no permitida.', {
      code: 'gigstack_untrusted_file_url'
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GIGSTACK_REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetch(url, {
      headers: url.hostname === 'api.gigstack.io' || url.hostname.endsWith('.gigstack.io')
        ? { Authorization: `Bearer ${token}` }
        : {},
      signal: controller.signal
    })
    if (!response.ok) {
      throw createGigstackError(`No se pudo descargar el archivo fiscal (${response.status}).`, {
        status: response.status,
        code: `gigstack_file_http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      })
    }
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > GIGSTACK_FILE_MAX_BYTES) {
      throw createGigstackError('El archivo fiscal excede el tamaño permitido.', {
        status: 413,
        code: 'gigstack_file_too_large'
      })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > GIGSTACK_FILE_MAX_BYTES) {
      throw createGigstackError('El archivo fiscal excede el tamaño permitido.', {
        status: 413,
        code: 'gigstack_file_too_large'
      })
    }
    return buffer
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createGigstackError('La descarga fiscal tardó demasiado.', {
        code: 'gigstack_file_timeout',
        retryable: true
      })
    }
    if (error?.code) throw error
    throw createGigstackError('No se pudo descargar el archivo fiscal.', {
      code: 'gigstack_file_download_error',
      retryable: true
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function loadGigstackInvoiceFile(invoiceId, format, token) {
  let response = await gigstackRequest(`/invoices/${encodeURIComponent(invoiceId)}/files`, { token })
  let reference = findInvoiceFileReference(response, format)
  if (!reference) {
    response = await gigstackRequest(
      `/invoices/${encodeURIComponent(invoiceId)}/files?file_type=${encodeURIComponent(format)}`,
      { token }
    )
    reference = findInvoiceFileReference(response, format)
  }
  if (!reference) {
    throw createGigstackError(`Gigstack no devolvió el archivo ${format.toUpperCase()} de esta factura.`, {
      status: 404,
      code: `gigstack_${format}_not_available`
    })
  }

  const inline = decodeInlineInvoiceFile(reference, format)
  const buffer = inline || await fetchInvoiceFileUrl(getInvoiceFileUrl(reference), token)
  if (!buffer?.length || buffer.length > GIGSTACK_FILE_MAX_BYTES) {
    throw createGigstackError(`El archivo ${format.toUpperCase()} de Gigstack no es válido.`, {
      status: 422,
      code: `gigstack_invalid_${format}`
    })
  }
  return buffer
}

function safeInvoiceFileBase(value) {
  const normalized = cleanString(value, 180).replace(/[^a-zA-Z0-9_-]/g, '-')
  return normalized || 'factura'
}

export async function getGigstackInvoiceFileDownload(paymentId, format = 'zip') {
  const normalizedFormat = cleanString(format, 12).toLowerCase()
  if (!['zip', 'pdf', 'xml'].includes(normalizedFormat)) {
    throw createGigstackError('El formato de factura debe ser ZIP, PDF o XML.', {
      status: 400,
      code: 'invalid_gigstack_file_format'
    })
  }
  const row = await db.get('SELECT id, payment_mode, metadata_json FROM payments WHERE id = ?', [cleanString(paymentId, 160)])
  if (!row) {
    throw createGigstackError('No encontramos esta transacción.', { status: 404, code: 'payment_not_found' })
  }
  const mode = normalizeGigstackPaymentMode(row.payment_mode)
  if (!mode) {
    throw createGigstackError('La transacción no tiene un ambiente fiscal válido.', {
      status: 409,
      code: 'unknown_payment_mode'
    })
  }
  const metadata = parseJson(row.metadata_json)
  const fiscal = metadata.gigstack && typeof metadata.gigstack === 'object' ? metadata.gigstack : {}
  const metadataMode = normalizeGigstackPaymentMode(fiscal.mode)
  if (metadataMode && metadataMode !== mode) {
    throw createGigstackError('La factura y la transacción pertenecen a ambientes distintos.', {
      status: 409,
      code: 'gigstack_invoice_mode_mismatch'
    })
  }
  const storedInvoices = Array.isArray(fiscal.invoices) ? fiscal.invoices : []
  const fallbackIds = Array.isArray(fiscal.invoiceIds) ? fiscal.invoiceIds : []
  const invoices = (storedInvoices.length ? storedInvoices : fallbackIds.map((id) => ({ id })))
    .map((invoice) => ({
      id: cleanString(typeof invoice === 'object' ? invoice.id || invoice.uuid : invoice, 180),
      uuid: cleanString(typeof invoice === 'object' ? invoice.uuid || invoice.id : invoice, 180)
    }))
    .filter((invoice) => invoice.id)
  if (!invoices.length || !['stamped', 'valid'].includes(cleanString(fiscal.status, 80).toLowerCase())) {
    throw createGigstackError('Esta transacción todavía no tiene una factura timbrada disponible.', {
      status: 404,
      code: 'gigstack_invoice_not_available'
    })
  }

  const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
  const token = getGigstackTokenForMode(settings.taxes, mode)
  assertGigstackTokenMode(token, mode)
  const first = invoices[0]
  const fileBase = `factura-${safeInvoiceFileBase(first.uuid || first.id)}`

  if (normalizedFormat === 'pdf' || normalizedFormat === 'xml') {
    const buffer = await loadGigstackInvoiceFile(first.id, normalizedFormat, token)
    return {
      buffer,
      contentType: normalizedFormat === 'pdf' ? 'application/pdf' : 'application/xml; charset=utf-8',
      fileName: `${fileBase}.${normalizedFormat}`
    }
  }

  const zip = new JSZip()
  for (const [index, invoice] of invoices.entries()) {
    const invoiceBase = invoices.length === 1
      ? fileBase
      : `factura-${safeInvoiceFileBase(invoice.uuid || invoice.id)}-${index + 1}`
    const [pdf, xml] = await Promise.all([
      loadGigstackInvoiceFile(invoice.id, 'pdf', token),
      loadGigstackInvoiceFile(invoice.id, 'xml', token)
    ])
    zip.file(`${invoiceBase}.pdf`, pdf)
    zip.file(`${invoiceBase}.xml`, xml)
  }
  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    contentType: 'application/zip',
    fileName: `${fileBase}.zip`
  }
}

async function verifyGigstackInvoices(invoiceIds, token, mode) {
  if (!invoiceIds.length) {
    throw createGigstackError('Gigstack registró el pago, pero todavía no devolvió la factura PUE.', {
      code: 'gigstack_invoice_pending',
      retryable: true
    })
  }

  const invoices = []
  for (const invoiceId of invoiceIds) {
    let response
    try {
      response = await gigstackRequest(`/invoices/income/${encodeURIComponent(invoiceId)}`, { token })
    } catch (error) {
      if (Number(error?.status) === 404) {
        throw createGigstackError('La factura todavía no está disponible para confirmar el timbrado.', {
          code: 'gigstack_invoice_pending',
          retryable: true
        })
      }
      throw error
    }
    const invoice = response?.data && typeof response.data === 'object' ? response.data : response
    if (typeof invoice?.livemode === 'boolean' && invoice.livemode !== (mode === 'live')) {
      throw createGigstackError('La factura de Gigstack pertenece a un ambiente distinto al pago.', {
        code: 'gigstack_invoice_mode_mismatch'
      })
    }
    const status = cleanString(invoice?.status, 80).toLowerCase()
    if (!['stamped', 'valid'].includes(status)) {
      const pending = ['pending', 'processing', 'created', 'draft'].includes(status)
      throw createGigstackError(`La factura de Gigstack todavía no está timbrada (${status || 'sin estado'}).`, {
        code: pending ? 'gigstack_invoice_pending' : 'gigstack_invoice_not_stamped',
        retryable: pending
      })
    }
    invoices.push({
      id: invoiceId,
      uuid: cleanString(invoice?.uuid || invoiceId, 180),
      status,
      verificationUrl: cleanString(invoice?.verification_url, 1000)
    })
  }
  return invoices
}

async function updateGigstackMetadata(paymentId, patch) {
  const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
  if (!row) return
  const metadata = parseJson(row.metadata_json)
  metadata.gigstack = {
    ...(metadata.gigstack || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  }
  await db.run(
    'UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(metadata), paymentId]
  )
}

async function getPaymentRow(paymentId) {
  return db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.first_name AS contact_first_name,
      c.last_name AS contact_last_name,
      c.email AS contact_email,
      c.phone AS contact_phone,
      c.preferred_whatsapp_phone_number_id AS contact_preferred_whatsapp_phone_number_id
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.id = ?`,
    [paymentId]
  )
}

function gigstackDeliveryJobId({ paymentId, invoiceId, channel, documentFormat }) {
  const digest = crypto.createHash('sha256')
    .update([paymentId, invoiceId, channel, documentFormat].join('|'))
    .digest('hex')
    .slice(0, 32)
  return `gigstack_delivery_${digest}`
}

function normalizeGigstackDeliveryInvoices(invoices = []) {
  return (Array.isArray(invoices) ? invoices : [])
    .map((invoice) => ({
      id: cleanString(typeof invoice === 'object' ? invoice?.id || invoice?.uuid : invoice, 180),
      uuid: cleanString(typeof invoice === 'object' ? invoice?.uuid || invoice?.id : invoice, 180),
      status: cleanString(typeof invoice === 'object' ? invoice?.status : 'stamped', 80).toLowerCase()
    }))
    .filter((invoice) => invoice.id && ['stamped', 'valid'].includes(invoice.status || 'stamped'))
}

export async function enqueueGigstackInvoiceDeliveryJobs(paymentId, {
  mode,
  invoices = [],
  taxes = {}
} = {}) {
  const cleanPaymentId = cleanString(paymentId, 160)
  const paymentMode = normalizeGigstackPaymentMode(mode)
  const stampedInvoices = normalizeGigstackDeliveryInvoices(invoices)
  if (!cleanPaymentId || !paymentMode || !stampedInvoices.length) {
    return { queued: 0, reason: 'missing_stamped_invoice' }
  }

  const specs = []
  if (taxes.gigstackSendWhatsapp !== false) {
    specs.push(
      { channel: 'whatsapp', documentFormat: 'pdf' },
      { channel: 'whatsapp', documentFormat: 'xml' }
    )
  }
  if (taxes.gigstackSendEmail !== false) {
    specs.push({ channel: 'email', documentFormat: 'bundle' })
  }
  if (!specs.length) return { queued: 0, reason: 'delivery_disabled' }

  let queued = 0
  for (const invoice of stampedInvoices) {
    for (const spec of specs) {
      const id = gigstackDeliveryJobId({
        paymentId: cleanPaymentId,
        invoiceId: invoice.id,
        channel: spec.channel,
        documentFormat: spec.documentFormat
      })
      const result = await db.run(
        `INSERT INTO gigstack_invoice_delivery_jobs (
           id, payment_id, payment_mode, invoice_id, invoice_uuid, channel,
           document_format, status, attempt_count, next_attempt_at_ms,
           claim_token, lease_until_at_ms, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(payment_id, invoice_id, channel, document_format) DO NOTHING`,
        [
          id,
          cleanPaymentId,
          paymentMode,
          invoice.id,
          invoice.uuid || invoice.id,
          spec.channel,
          spec.documentFormat
        ]
      )
      if (Number(result?.changes) > 0 || Number(result?.rowCount) > 0) queued += 1
    }
  }

  return { queued, paymentId: cleanPaymentId, invoices: stampedInvoices.length }
}

function deliveryContactFromPayment(payment = {}) {
  const fullName = cleanString(payment.contact_name, 180)
  return {
    id: cleanString(payment.contact_id, 180),
    firstName: cleanString(payment.contact_first_name, 120) || fullName.split(/\s+/).filter(Boolean)[0] || '',
    lastName: cleanString(payment.contact_last_name, 120),
    fullName,
    email: cleanString(payment.contact_email, 180).toLowerCase(),
    phone: cleanString(payment.contact_phone, 80),
    preferredWhatsAppPhoneNumberId: cleanString(payment.contact_preferred_whatsapp_phone_number_id, 200)
  }
}

function deliveryFileDescriptor(job, format) {
  const safeBase = safeInvoiceFileBase(job.invoice_uuid || job.invoice_id)
  return {
    filename: `factura-${safeBase}.${format}`,
    mimeType: format === 'pdf' ? 'application/pdf' : 'application/xml'
  }
}

function safeDeliveryResult(result = {}) {
  return {
    id: cleanString(result?.id || result?.messageId || result?.smtpMessageId, 240),
    localMessageId: cleanString(result?.localMessageId, 240),
    status: cleanString(result?.status, 80),
    transport: cleanString(result?.transport, 40),
    to: cleanString(result?.to, 180)
  }
}

function deliveryProviderMessageId(result = {}) {
  return cleanString(
    result?.id || result?.messageId || result?.smtpMessageId || result?.localMessageId,
    240
  )
}

async function updateGigstackDeliveryMetadata(paymentId, job, patch = {}) {
  const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
  if (!row) return
  const metadata = parseJson(row.metadata_json)
  const gigstack = metadata.gigstack && typeof metadata.gigstack === 'object'
    ? metadata.gigstack
    : {}
  const delivery = gigstack.delivery && typeof gigstack.delivery === 'object'
    ? gigstack.delivery
    : {}
  const jobs = delivery.jobs && typeof delivery.jobs === 'object' ? delivery.jobs : {}
  const now = new Date().toISOString()
  jobs[job.id] = {
    ...(jobs[job.id] || {}),
    channel: job.channel,
    documentFormat: job.document_format,
    invoiceId: job.invoice_id,
    invoiceUuid: job.invoice_uuid || '',
    ...patch,
    updatedAt: now
  }
  metadata.gigstack = {
    ...gigstack,
    delivery: { ...delivery, jobs, updatedAt: now },
    updatedAt: now
  }
  await db.run(
    'UPDATE payments SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [JSON.stringify(metadata), paymentId]
  )
}

async function claimGigstackInvoiceDeliveryJob(jobId) {
  const now = Date.now()
  const claimToken = crypto.randomUUID()
  await db.run(
    `UPDATE gigstack_invoice_delivery_jobs
     SET status = 'processing', claim_token = ?, lease_until_at_ms = ?,
         attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND next_attempt_at_ms <= ?
       AND (
         status IN ('pending', 'retry')
         OR (status = 'processing' AND COALESCE(lease_until_at_ms, 0) <= ?)
       )`,
    [claimToken, now + GIGSTACK_JOB_LEASE_MS, jobId, now, now]
  )
  const row = await db.get('SELECT * FROM gigstack_invoice_delivery_jobs WHERE id = ?', [jobId])
  return row?.claim_token === claimToken ? { row, claimToken } : null
}

async function finishGigstackInvoiceDeliveryJob(jobId, claimToken, patch = {}) {
  await db.run(
    `UPDATE gigstack_invoice_delivery_jobs
     SET status = ?, next_attempt_at_ms = ?, claim_token = NULL,
         lease_until_at_ms = NULL, last_error = ?, provider_message_id = ?,
         result_json = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND claim_token = ?`,
    [
      patch.status,
      Number(patch.nextAttemptAtMs) || 0,
      cleanString(patch.lastError, 1000) || null,
      cleanString(patch.providerMessageId, 240) || null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.status,
      jobId,
      claimToken
    ]
  )
}

function shouldRetryGigstackDelivery(error, attemptCount) {
  if (Number(attemptCount) >= GIGSTACK_MAX_ATTEMPTS) return false
  if (error?.retryable === true) return true
  const status = Number(error?.status || error?.statusCode || 0)
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true
  const message = cleanString(error?.message || error, 1200).toLowerCase()
  return [
    'timeout',
    'tiempo',
    'network',
    'conexión',
    'conexion',
    'no está conectado',
    'no esta conectado',
    'ventana de 24',
    'temporal'
  ].some((fragment) => message.includes(fragment))
}

async function deliverGigstackInvoiceEmail(job, payment, token) {
  const contact = deliveryContactFromPayment(payment)
  if (!contact.id || !contact.email) {
    throw createGigstackError('El contacto no tiene un correo válido para recibir la factura.', {
      status: 400,
      code: 'missing_invoice_delivery_email'
    })
  }
  const [pdf, xml] = await Promise.all([
    loadGigstackInvoiceFile(job.invoice_id, 'pdf', token),
    loadGigstackInvoiceFile(job.invoice_id, 'xml', token)
  ])
  const pdfFile = deliveryFileDescriptor(job, 'pdf')
  const xmlFile = deliveryFileDescriptor(job, 'xml')
  const invoiceReference = safeInvoiceFileBase(job.invoice_uuid || job.invoice_id)
  const greeting = contact.firstName ? `Hola ${contact.firstName},` : 'Hola,'
  const greetingHtml = escapeHtml(greeting)

  return gigstackDeliveryDependencies.sendEmailToContact({
    contactId: contact.id,
    to: contact.email,
    subject: `Factura ${invoiceReference} · PDF y XML`,
    text: `${greeting}\n\nTe compartimos los archivos fiscales de tu factura ${invoiceReference}. Encontrarás adjuntos el PDF y el XML.\n\nEste correo fue enviado automáticamente por Ristak.`,
    html: `<p>${greetingHtml}</p><p>Te compartimos los archivos fiscales de tu factura <strong>${invoiceReference}</strong>. Encontrarás adjuntos el PDF y el XML.</p><p>Este correo fue enviado automáticamente por Ristak.</p>`,
    attachments: [
      { filename: pdfFile.filename, content: pdf, contentType: pdfFile.mimeType },
      { filename: xmlFile.filename, content: xml, contentType: xmlFile.mimeType }
    ],
    externalId: `gigstack-invoice:${job.payment_id}:${job.invoice_id}:email`,
    variablesResolved: true
  })
}

function gigstackDeliveryPublicBaseUrl(payment = {}) {
  const configuredCandidates = [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_PUBLIC_URL,
    process.env.APP_URL,
    process.env.FRONTEND_URL
  ]
  for (const candidate of configuredCandidates) {
    try {
      const url = new URL(cleanString(candidate, 2000))
      if (url.protocol === 'https:') return url.origin
    } catch {
      // Se intenta la siguiente fuente configurada.
    }
  }

  // payment_url sólo es una fuente segura cuando apunta al checkout público de
  // Ristak. Un link legacy del proveedor (Stripe, Mercado Pago, etc.) no debe
  // convertirse accidentalmente en el host de nuestra ruta fiscal.
  try {
    const paymentUrl = new URL(cleanString(payment.payment_url, 2000))
    if (paymentUrl.protocol === 'https:' && paymentUrl.pathname.startsWith('/pay/')) {
      return paymentUrl.origin
    }
  } catch {
    // Sin URL pública verificable, la entrega queda reintentable y auditable.
  }
  return ''
}

async function createGigstackXmlDeliveryUrl(job, payment) {
  const baseUrl = gigstackDeliveryPublicBaseUrl(payment)
  if (!baseUrl) {
    throw createGigstackError('Ristak no tiene una URL pública HTTPS para compartir el XML de forma temporal.', {
      code: 'invoice_delivery_public_base_url_missing',
      retryable: true
    })
  }
  const token = await gigstackDeliveryDependencies.signPublicContextClaims({
    purpose: 'gigstack.invoice.delivery',
    claims: {
      jobId: job.id,
      paymentId: job.payment_id,
      invoiceId: job.invoice_id,
      format: 'xml'
    },
    ttlSeconds: 24 * 60 * 60
  })
  return `${baseUrl}/api/settings/payments/gigstack-invoice-file/${encodeURIComponent(token)}`
}

async function deliverGigstackInvoiceWhatsapp(job, payment, token) {
  const contact = deliveryContactFromPayment(payment)
  if (!contact.id || !contact.phone) {
    throw createGigstackError('El contacto no tiene un número válido para recibir la factura.', {
      status: 400,
      code: 'missing_invoice_delivery_phone'
    })
  }
  const route = await gigstackDeliveryDependencies.resolvePaymentWhatsAppRoute(contact)
  if (!route?.available) {
    throw createGigstackError('La conversación del contacto no tiene un canal de WhatsApp disponible.', {
      status: 409,
      code: 'invoice_delivery_whatsapp_unavailable',
      retryable: true
    })
  }
  const format = cleanString(job.document_format, 12).toLowerCase()
  const routeArgs = gigstackDeliveryDependencies.paymentWhatsAppRouteArgs(route, true)
  const invoiceReference = safeInvoiceFileBase(job.invoice_uuid || job.invoice_id)

  // Meta y YCloud no aceptan XML como documento. En ese caso compartimos una
  // capacidad firmada que expira en 24 h y descarga el XML directamente desde
  // Gigstack; el archivo fiscal nunca queda alojado en una URL pública fija.
  if (format === 'xml' && route.transport !== 'qr') {
    const downloadUrl = await createGigstackXmlDeliveryUrl(job, payment)
    return gigstackDeliveryDependencies.sendWhatsAppApiTextMessage({
      to: contact.phone,
      ...routeArgs,
      text: `Te compartimos el XML fiscal de tu factura ${invoiceReference}. El enlace privado vence en 24 horas: ${downloadUrl}`,
      contactId: contact.id,
      externalId: `gigstack-invoice:${job.payment_id}:${job.invoice_id}:xml`,
      variablesResolved: true
    })
  }

  const buffer = await loadGigstackInvoiceFile(job.invoice_id, format, token)
  const file = deliveryFileDescriptor(job, format)
  return gigstackDeliveryDependencies.sendWhatsAppApiDocumentMessage({
    to: contact.phone,
    ...routeArgs,
    documentDataUrl: `data:${file.mimeType.split(';')[0]};base64,${buffer.toString('base64')}`,
    filename: file.filename,
    mimeType: file.mimeType,
    caption: `Factura ${invoiceReference} · ${format.toUpperCase()}`,
    contactId: contact.id,
    externalId: `gigstack-invoice:${job.payment_id}:${job.invoice_id}:${format}`,
    sensitive: true,
    variablesResolved: true
  })
}

export async function processGigstackInvoiceDeliveryJob(jobId) {
  const claim = await claimGigstackInvoiceDeliveryJob(cleanString(jobId, 180))
  if (!claim) return { skipped: true, reason: 'not_claimed' }

  const { row: job, claimToken } = claim
  try {
    const validDeliveryCombination =
      (job.channel === 'email' && job.document_format === 'bundle') ||
      (job.channel === 'whatsapp' && ['pdf', 'xml'].includes(job.document_format))
    if (
      !GIGSTACK_DELIVERY_CHANNELS.has(job.channel) ||
      !GIGSTACK_DELIVERY_FORMATS.has(job.document_format) ||
      !validDeliveryCombination
    ) {
      throw createGigstackError('El trabajo de entrega fiscal no tiene un canal o formato válido.', {
        status: 400,
        code: 'invalid_invoice_delivery_job'
      })
    }
    const payment = await getPaymentRow(job.payment_id)
    if (!payment) {
      throw createGigstackError('No encontramos el pago relacionado con esta factura.', {
        status: 404,
        code: 'invoice_delivery_payment_not_found'
      })
    }
    const currentMode = normalizeGigstackPaymentMode(payment.payment_mode)
    if (!currentMode || currentMode !== normalizeGigstackPaymentMode(job.payment_mode)) {
      throw createGigstackError('El ambiente del pago cambió después del timbrado; se bloqueó la entrega.', {
        status: 400,
        code: 'invoice_delivery_payment_mode_changed'
      })
    }

    const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
    const taxes = settings.taxes || {}
    const channelEnabled = job.channel === 'whatsapp'
      ? taxes.gigstackSendWhatsapp !== false
      : taxes.gigstackSendEmail !== false
    if (!channelEnabled) {
      await finishGigstackInvoiceDeliveryJob(job.id, claimToken, {
        status: 'skipped',
        lastError: 'delivery_disabled'
      })
      await updateGigstackDeliveryMetadata(job.payment_id, job, {
        status: 'skipped',
        reason: 'delivery_disabled'
      })
      return { skipped: true, reason: 'delivery_disabled', jobId: job.id }
    }

    const token = getGigstackTokenForMode(taxes, currentMode)
    assertGigstackTokenMode(token, currentMode)
    const response = job.channel === 'email'
      ? await deliverGigstackInvoiceEmail(job, payment, token)
      : await deliverGigstackInvoiceWhatsapp(job, payment, token)
    const result = safeDeliveryResult(response)
    const providerMessageId = deliveryProviderMessageId(response)
    await finishGigstackInvoiceDeliveryJob(job.id, claimToken, {
      status: 'sent',
      providerMessageId,
      result
    })
    await updateGigstackDeliveryMetadata(job.payment_id, job, {
      status: 'sent',
      providerMessageId,
      sentAt: new Date().toISOString(),
      result
    })
    return {
      sent: true,
      jobId: job.id,
      paymentId: job.payment_id,
      channel: job.channel,
      documentFormat: job.document_format
    }
  } catch (error) {
    const retryable = shouldRetryGigstackDelivery(error, Number(job.attempt_count))
    const status = retryable ? 'retry' : 'blocked'
    const lastError = `${error?.code || 'invoice_delivery_error'}: ${cleanString(error?.message, 900)}`
    await finishGigstackInvoiceDeliveryJob(job.id, claimToken, {
      status,
      nextAttemptAtMs: retryable ? nextRetryAtMs(Number(job.attempt_count)) : 0,
      lastError
    })
    await updateGigstackDeliveryMetadata(job.payment_id, job, {
      status,
      retryable,
      errorCode: error?.code || 'invoice_delivery_error',
      error: cleanString(error?.message, 900)
    })
    return {
      error: true,
      retryable,
      jobId: job.id,
      paymentId: job.payment_id,
      code: error?.code || 'invoice_delivery_error'
    }
  }
}

export async function processDueGigstackInvoiceDeliveryJobs({
  limit = GIGSTACK_DELIVERY_JOB_BATCH_SIZE
} = {}) {
  const now = Date.now()
  const rows = await db.all(
    `SELECT id
     FROM gigstack_invoice_delivery_jobs
     WHERE next_attempt_at_ms <= ?
       AND (
         status IN ('pending', 'retry')
         OR (status = 'processing' AND COALESCE(lease_until_at_ms, 0) <= ?)
       )
     ORDER BY next_attempt_at_ms ASC, created_at ASC
     LIMIT ?`,
    [now, now, Math.max(1, Math.min(Number(limit) || GIGSTACK_DELIVERY_JOB_BATCH_SIZE, 100))]
  )
  const results = []
  for (const row of rows || []) {
    results.push(await processGigstackInvoiceDeliveryJob(row.id))
  }
  return results
}

export async function getGigstackInvoiceDeliveryPublicFile(token) {
  const verified = await verifyPublicContextToken(token, {
    purpose: 'gigstack.invoice.delivery'
  })
  const claims = verified.claims || {}
  const job = await db.get(
    `SELECT * FROM gigstack_invoice_delivery_jobs
     WHERE id = ? AND payment_id = ? AND invoice_id = ?
       AND channel = 'whatsapp' AND document_format = 'xml'
     LIMIT 1`,
    [
      cleanString(claims.jobId, 180),
      cleanString(claims.paymentId, 160),
      cleanString(claims.invoiceId, 180)
    ]
  )
  if (!job || cleanString(claims.format, 12).toLowerCase() !== 'xml') {
    throw createGigstackError('El enlace del XML no corresponde a una factura disponible.', {
      status: 404,
      code: 'invoice_delivery_link_not_found'
    })
  }
  if (['blocked', 'skipped'].includes(cleanString(job.status, 40).toLowerCase())) {
    throw createGigstackError('El enlace del XML ya no está disponible.', {
      status: 410,
      code: 'invoice_delivery_link_inactive'
    })
  }

  const payment = await db.get(
    'SELECT payment_mode FROM payments WHERE id = ? LIMIT 1',
    [job.payment_id]
  )
  const mode = normalizeGigstackPaymentMode(payment?.payment_mode)
  if (!mode || mode !== normalizeGigstackPaymentMode(job.payment_mode)) {
    throw createGigstackError('El ambiente fiscal del enlace no es válido.', {
      status: 409,
      code: 'invoice_delivery_payment_mode_changed'
    })
  }
  const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
  const gigstackToken = getGigstackTokenForMode(settings.taxes, mode)
  assertGigstackTokenMode(gigstackToken, mode)
  const file = deliveryFileDescriptor(job, 'xml')
  return {
    buffer: await loadGigstackInvoiceFile(job.invoice_id, 'xml', gigstackToken),
    contentType: file.mimeType,
    fileName: file.filename,
    expiresAt: verified.expiresAt
  }
}

export async function testGigstackConnection({ mode, token } = {}) {
  const normalizedMode = normalizeGigstackPaymentMode(mode)
  if (!normalizedMode) {
    throw createGigstackError('Elige si quieres probar la conexión Test o Live.', {
      status: 400,
      code: 'invalid_gigstack_mode'
    })
  }

  let selectedToken = cleanString(token, 5000)
  if (!selectedToken) {
    const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
    selectedToken = getGigstackTokenForMode(settings.taxes, normalizedMode)
  }
  const tokenMetadata = assertGigstackTokenMode(selectedToken, normalizedMode)
  const response = await gigstackRequest('/payments?limit=1', { token: selectedToken })
  const sample = Array.isArray(response?.data) ? response.data[0] : null
  if (sample && typeof sample.livemode === 'boolean' && sample.livemode !== (normalizedMode === 'live')) {
    throw createGigstackError('Gigstack respondió desde un ambiente distinto al de la API key.', {
      code: 'gigstack_response_mode_mismatch'
    })
  }

  return {
    connected: true,
    mode: normalizedMode,
    teamId: tokenMetadata.teamId,
    keyIdSuffix: tokenMetadata.keyId ? tokenMetadata.keyId.slice(-6) : '',
    checkedAt: new Date().toISOString()
  }
}

export async function registerGigstackPaymentForTransaction(paymentId, { expectedMode } = {}) {
  const cleanPaymentId = cleanString(paymentId, 160)
  if (!cleanPaymentId) return { skipped: true, reason: 'missing_payment_id' }

  const row = await getPaymentRow(cleanPaymentId)
  if (!row) return { skipped: true, reason: 'payment_not_found' }
  if (!PAID_STATUSES.has(cleanString(row.status).toLowerCase())) {
    return { skipped: true, reason: 'payment_not_paid' }
  }

  const mode = normalizeGigstackPaymentMode(row.payment_mode)
  if (!mode) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'blocked',
      errorCode: 'unknown_payment_mode',
      error: 'El pago no tiene un ambiente fiscal reconocible.'
    })
    throw createGigstackError('El pago no tiene payment_mode Test o Live; se bloqueó para proteger el SAT.', {
      code: 'unknown_payment_mode'
    })
  }

  const pinnedMode = expectedMode === undefined ? null : normalizeGigstackPaymentMode(expectedMode)
  if (expectedMode !== undefined && (!pinnedMode || pinnedMode !== mode)) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'blocked',
      mode,
      expectedMode: pinnedMode || cleanString(expectedMode, 24),
      errorCode: 'gigstack_payment_mode_changed',
      error: 'El ambiente del pago cambió después de entrar a la cola fiscal.'
    })
    throw createGigstackError(
      'El ambiente del pago cambió después de entrar a la cola fiscal; se bloqueó antes de llamar a Gigstack.',
      { code: 'gigstack_payment_mode_changed' }
    )
  }

  const existingMetadata = parseJson(row.metadata_json)
  if (
    REGISTERED_GIGSTACK_STATUSES.has(cleanString(existingMetadata.gigstack?.status).toLowerCase()) ||
    cleanString(existingMetadata.gigstack?.id)
  ) {
    const existingSettings = await getPaymentSettings({ resolveBusinessProfile: false })
    const delivery = await enqueueGigstackInvoiceDeliveryJobs(cleanPaymentId, {
      mode,
      invoices: existingMetadata.gigstack?.invoices || [],
      taxes: existingSettings.taxes || {}
    })
    return { skipped: true, reason: 'already_registered', delivery }
  }

  const settings = await getPaymentSettings({ includeSecrets: true, resolveBusinessProfile: false })
  const taxes = settings.taxes || {}
  if (!taxes.enabled || !taxes.gigstackEnabled) return { skipped: true, reason: 'gigstack_disabled' }
  const token = getGigstackTokenForMode(taxes, mode)
  try {
    assertGigstackTokenMode(token, mode)
  } catch (error) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'blocked',
      mode,
      errorCode: error.code || 'gigstack_token_error',
      error: cleanString(error.message, 1000)
    })
    throw error
  }

  const tax = getPaymentTax(row, settings)
  if (!tax?.enabled) return { skipped: true, reason: 'missing_tax' }
  if (!/^[A-Z]{3}$/.test(cleanString(row.currency, 3).toUpperCase())) {
    throw createGigstackError('El pago no tiene una moneda ISO válida; no se enviará a Gigstack.', { code: 'missing_payment_currency' })
  }

  const payload = await buildGigstackPayload(row, settings, tax, mode)
  await updateGigstackMetadata(cleanPaymentId, {
    status: 'processing',
    mode,
    idempotencyKey: payload.idempotency_key,
    error: '',
    errorCode: ''
  })

  let data
  try {
    data = await gigstackRequest('/payments/register', { token, method: 'POST', body: payload })
  } catch (error) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      mode,
      errorCode: error.code || 'gigstack_error',
      error: cleanString(error.message, 1000)
    })
    throw error
  }

  const result = data?.data && typeof data.data === 'object' ? data.data : data
  if (typeof result?.livemode === 'boolean' && result.livemode !== (mode === 'live')) {
    const error = createGigstackError('Gigstack registró el pago en un ambiente distinto al esperado.', {
      code: 'gigstack_response_mode_mismatch'
    })
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      mode,
      errorCode: error.code,
      error: error.message
    })
    throw error
  }

  const remoteStatus = cleanString(result?.status, 80).toLowerCase()
  if (remoteStatus && !REGISTERED_GIGSTACK_STATUSES.has(remoteStatus)) {
    const error = createGigstackError(`Gigstack devolvió un estado inesperado: ${remoteStatus}.`, {
      code: 'gigstack_unexpected_status',
      retryable: true
    })
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      mode,
      errorCode: error.code,
      error: error.message
    })
    throw error
  }

  const remotePaymentId = cleanString(result?.id || result?.payment?.id || '', 180)
  const invoiceIds = Array.isArray(result?.invoices)
    ? result.invoices.map((invoice) => cleanString(
        typeof invoice === 'object' ? invoice?.id || invoice?.uuid : invoice,
        180
      )).filter(Boolean)
    : []
  const automationType = payload.automation_type
  let verifiedInvoices = []
  try {
    verifiedInvoices = automationType === 'pue_invoice'
      ? await verifyGigstackInvoices(invoiceIds, token, mode)
      : []
  } catch (error) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      mode,
      pendingRemotePaymentId: remotePaymentId,
      pendingInvoiceIds: invoiceIds,
      errorCode: error.code || 'gigstack_invoice_verification_error',
      error: cleanString(error.message, 1000)
    })
    throw error
  }
  await updateGigstackMetadata(cleanPaymentId, {
    status: automationType === 'pue_invoice' ? 'stamped' : 'registered',
    remoteStatus: remoteStatus || 'succeeded',
    mode,
    livemode: mode === 'live',
    id: remotePaymentId,
    invoiceIds,
    invoices: verifiedInvoices,
    registeredAt: new Date().toISOString(),
    error: '',
    errorCode: ''
  })

  let delivery
  try {
    delivery = await enqueueGigstackInvoiceDeliveryJobs(cleanPaymentId, {
      mode,
      invoices: verifiedInvoices,
      taxes
    })
  } catch (error) {
    await updateGigstackMetadata(cleanPaymentId, {
      deliveryEnqueueStatus: 'error',
      deliveryEnqueueError: cleanString(error?.message, 900)
    })
    throw createGigstackError('La factura quedó timbrada, pero no se pudo preparar la entrega de PDF y XML.', {
      code: 'gigstack_delivery_enqueue_error',
      retryable: true
    })
  }

  logger.info(`[Gigstack] Pago ${cleanPaymentId} registrado en ${gigstackModeTitle(mode)}.`)
  return { registered: true, mode, remotePaymentId, data, delivery }
}

function nextRetryAtMs(attemptCount) {
  const index = Math.min(Math.max(0, attemptCount - 1), GIGSTACK_RETRY_DELAYS_MS.length - 1)
  return Date.now() + GIGSTACK_RETRY_DELAYS_MS[index]
}

async function enqueueGigstackInvoiceJob(paymentId) {
  const cleanPaymentId = cleanString(paymentId, 160)
  if (!cleanPaymentId) return { skipped: true, reason: 'missing_payment_id' }

  const [settings, payment] = await Promise.all([
    getPaymentSettings({ resolveBusinessProfile: false }),
    db.get('SELECT payment_mode FROM payments WHERE id = ?', [cleanPaymentId])
  ])
  if (!payment) return { skipped: true, reason: 'payment_not_found' }
  if (!settings.taxes?.enabled || !settings.taxes?.gigstackEnabled) {
    return { skipped: true, reason: 'gigstack_disabled' }
  }

  const mode = normalizeGigstackPaymentMode(payment.payment_mode)
  if (!mode) {
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'blocked',
      errorCode: 'unknown_payment_mode',
      error: 'El pago no tiene un ambiente fiscal reconocible.'
    })
    return { skipped: true, reason: 'unknown_payment_mode' }
  }

  await db.run(
    `INSERT INTO gigstack_invoice_jobs (
       payment_id, payment_mode, status, attempt_count, next_attempt_at_ms,
       claim_token, lease_until_at_ms, last_error, created_at, updated_at
     ) VALUES (?, ?, 'pending', 0, 0, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(payment_id) DO NOTHING`,
    [cleanPaymentId, mode]
  )
  return { queued: true, paymentId: cleanPaymentId, mode }
}

async function claimGigstackInvoiceJob(paymentId) {
  const now = Date.now()
  const claimToken = crypto.randomUUID()
  await db.run(
    `UPDATE gigstack_invoice_jobs
     SET status = 'processing', claim_token = ?, lease_until_at_ms = ?,
         attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ?
       AND next_attempt_at_ms <= ?
       AND (
         status IN ('pending', 'retry')
         OR (status = 'processing' AND COALESCE(lease_until_at_ms, 0) <= ?)
       )`,
    [claimToken, now + GIGSTACK_JOB_LEASE_MS, paymentId, now, now]
  )
  const row = await db.get('SELECT * FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
  return row?.claim_token === claimToken ? { row, claimToken } : null
}

async function finishGigstackInvoiceJob(paymentId, claimToken, patch = {}) {
  await db.run(
    `UPDATE gigstack_invoice_jobs
     SET status = ?, next_attempt_at_ms = ?, claim_token = NULL, lease_until_at_ms = NULL,
         last_error = ?, remote_payment_id = COALESCE(?, remote_payment_id), updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ? AND claim_token = ?`,
    [
      patch.status,
      Number(patch.nextAttemptAtMs) || 0,
      cleanString(patch.lastError, 1000) || null,
      cleanString(patch.remotePaymentId, 180) || null,
      paymentId,
      claimToken
    ]
  )
}

export async function processGigstackInvoiceJob(paymentId) {
  const claim = await claimGigstackInvoiceJob(cleanString(paymentId, 160))
  if (!claim) return { skipped: true, reason: 'not_claimed' }

  const { row, claimToken } = claim
  try {
    const result = await registerGigstackPaymentForTransaction(row.payment_id, {
      expectedMode: row.payment_mode
    })
    if (result.registered || result.reason === 'already_registered') {
      await finishGigstackInvoiceJob(row.payment_id, claimToken, {
        status: 'registered',
        remotePaymentId: result.remotePaymentId
      })
      return { registered: true, paymentId: row.payment_id }
    }

    const terminalStatus = ['payment_not_found', 'payment_not_paid', 'missing_tax', 'gigstack_disabled'].includes(result.reason)
      ? 'skipped'
      : 'blocked'
    await finishGigstackInvoiceJob(row.payment_id, claimToken, {
      status: terminalStatus,
      lastError: result.reason
    })
    return { skipped: true, reason: result.reason, paymentId: row.payment_id }
  } catch (error) {
    const retryable = error?.retryable === true && Number(row.attempt_count) < GIGSTACK_MAX_ATTEMPTS
    const status = retryable ? 'retry' : 'blocked'
    await finishGigstackInvoiceJob(row.payment_id, claimToken, {
      status,
      nextAttemptAtMs: retryable ? nextRetryAtMs(Number(row.attempt_count)) : 0,
      lastError: `${error?.code || 'gigstack_error'}: ${cleanString(error?.message, 900)}`
    })
    return { error: true, retryable, paymentId: row.payment_id, code: error?.code || 'gigstack_error' }
  }
}

export async function processDueGigstackInvoiceJobs({ limit = GIGSTACK_JOB_BATCH_SIZE } = {}) {
  const now = Date.now()
  const rows = await db.all(
    `SELECT payment_id
     FROM gigstack_invoice_jobs
     WHERE next_attempt_at_ms <= ?
       AND (
         status IN ('pending', 'retry')
         OR (status = 'processing' AND COALESCE(lease_until_at_ms, 0) <= ?)
       )
     ORDER BY next_attempt_at_ms ASC, created_at ASC
     LIMIT ?`,
    [now, now, Math.max(1, Math.min(Number(limit) || GIGSTACK_JOB_BATCH_SIZE, 50))]
  )
  const results = []
  for (const row of rows || []) {
    results.push(await processGigstackInvoiceJob(row.payment_id))
  }
  return results
}

export async function requeueBlockedGigstackInvoiceJobs({ errorCodes = [] } = {}) {
  const codes = [...new Set((Array.isArray(errorCodes) ? errorCodes : [])
    .map((code) => cleanString(code, 120).replace(/[^a-z0-9_]/gi, ''))
    .filter(Boolean))]
  if (!codes.length) return { invoiceJobs: 0, deliveryJobs: 0 }

  const whereErrors = codes.map(() => 'last_error LIKE ?').join(' OR ')
  const patterns = codes.map((code) => `${code}:%`)
  const invoiceResult = await db.run(
    `UPDATE gigstack_invoice_jobs
     SET status = 'pending', next_attempt_at_ms = 0, claim_token = NULL,
         lease_until_at_ms = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'blocked' AND (${whereErrors})`,
    patterns
  )
  const deliveryResult = await db.run(
    `UPDATE gigstack_invoice_delivery_jobs
     SET status = 'pending', next_attempt_at_ms = 0, claim_token = NULL,
         lease_until_at_ms = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'blocked' AND (${whereErrors})`,
    patterns
  )
  return {
    invoiceJobs: Number(invoiceResult?.changes || invoiceResult?.rowCount || 0),
    deliveryJobs: Number(deliveryResult?.changes || deliveryResult?.rowCount || 0)
  }
}

export function registerGigstackPaymentForTransactionInBackground(paymentId) {
  const task = enqueueGigstackInvoiceJob(paymentId)
    .then((queued) => queued.queued ? processGigstackInvoiceJob(queued.paymentId) : queued)
    .catch((error) => {
      logger.warn(`[Gigstack] No se pudo encolar el pago ${cleanString(paymentId, 160)}: ${error.message}`)
      return { error: true, retryable: false, code: error.code || 'gigstack_queue_error' }
    })
  return task
}
