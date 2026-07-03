import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { calculatePaymentTax, getPaymentSettings } from './paymentSettingsService.js'

const GIGSTACK_API_BASE_URL = (process.env.GIGSTACK_API_BASE_URL || 'https://api.gigstack.io/v2').replace(/\/+$/, '')

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
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

function normalizeGigstackProductKey(value, fallback = '82101800') {
  const normalized = cleanString(value, 20).replace(/\D/g, '').slice(0, 8)
  return normalized.length === 8 ? normalized : fallback
}

function normalizeGigstackUnitKey(value, fallback = 'E48') {
  const normalized = cleanString(value, 10).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return normalized || fallback
}

function resolvePaymentMethod(method = '', fallback = '99') {
  const normalized = cleanString(method).toLowerCase()
  if (['card', 'credit_card', 'stripe', 'stripe_saved_card', 'conekta', 'conekta_saved_card', 'mercadopago', 'mercadopago_checkout', 'clip', 'clip_card', 'rebill', 'rebill_checkout'].includes(normalized)) return '04'
  if (['debit_card'].includes(normalized)) return '28'
  if (['bank_transfer', 'transfer', 'spei'].includes(normalized)) return '03'
  if (['cash', 'deposit'].includes(normalized)) return '01'
  if (normalized === 'check') return '02'
  const fallbackDigits = cleanString(fallback, 2).replace(/\D/g, '')
  return fallbackDigits ? fallbackDigits.padStart(2, '0').slice(-2) : '99'
}

function getStoredLineItems(row) {
  const metadata = parseJson(row.metadata_json)
  return Array.isArray(metadata.lineItems)
    ? metadata.lineItems.filter((item) => item && typeof item === 'object')
    : []
}

function getItemAmount(item) {
  return roundMoney(item.amount ?? item.unit_price ?? item.unitPrice ?? item.price ?? 0)
}

async function getProductFiscalConfig(item = {}) {
  const candidates = [
    item.localProductId,
    item.productId,
    item.product_id,
    item.ghlProductId,
    item.ghl_product_id
  ]
    .map((value) => cleanString(value, 180))
    .filter(Boolean)

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
    factor: 'Tasa',
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
        description: row.description || row.title || 'Pago',
        amount: tax.calculationMode === 'inclusive' ? tax.totalAmount : tax.subtotalAmount,
        quantity: 1
      }]
  const sourceTotal = sourceItems.reduce((total, item) => total + getItemAmount(item), 0)
  const ratioBase = sourceTotal > 0
    ? sourceTotal
    : tax.calculationMode === 'inclusive'
      ? tax.totalAmount
      : tax.subtotalAmount
  const taxLine = buildGigstackTaxLine(tax)

  const items = []
  for (const item of sourceItems) {
    const productConfig = await getProductFiscalConfig(item)
    const rawAmount = getItemAmount(item)
    const ratio = ratioBase > 0 && rawAmount > 0 ? rawAmount / ratioBase : 1 / sourceItems.length
    const amount = tax.calculationMode === 'inclusive'
      ? roundMoney(tax.totalAmount * ratio)
      : roundMoney((rawAmount || tax.subtotalAmount * ratio))
    const productKey = normalizeGigstackProductKey(
      item.gigstackProductKey || item.product_key || productConfig?.gigstack_product_key,
      normalizeGigstackProductKey(taxes.gigstackDefaultProductKey)
    )
    const unitKey = normalizeGigstackUnitKey(
      item.gigstackUnitKey || item.unit_key || productConfig?.gigstack_unit_key,
      normalizeGigstackUnitKey(taxes.gigstackDefaultUnitKey)
    )
    const unitName = cleanString(
      item.gigstackUnitName ||
        item.unit_name ||
        productConfig?.gigstack_unit_name ||
        taxes.gigstackDefaultUnitName ||
        'Unidad de Servicio',
      120
    )

    items.push({
      description: cleanString(item.description || item.name || row.description || row.title || 'Pago'),
      discount: roundMoney(item.discount || 0),
      product_key: productKey,
      unit_key: unitKey,
      unit_name: unitName,
      taxes: [taxLine],
      quantity: Number(item.quantity || item.qty || 1) || 1,
      amount
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

async function buildGigstackPayload(row, settings, tax) {
  const taxes = settings.taxes
  const metadata = parseJson(row.metadata_json)

  return {
    paid: true,
    items: await buildGigstackItems(row, settings, tax),
    currency: cleanString(row.currency || 'MXN').toUpperCase(),
    paymentMethod: resolvePaymentMethod(
      row.payment_method || row.payment_provider,
      taxes.gigstackDefaultPaymentMethod
    ),
    automateInvoiceOnComplete: taxes.gigstackAutomateInvoiceOnComplete !== false,
    clientId: cleanString(metadata.gigstackClientId || metadata.clientId || ''),
    email: cleanString(row.contact_email)
  }
}

async function updateGigstackMetadata(paymentId, patch) {
  const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
  const metadata = parseJson(row?.metadata_json)
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

export async function registerGigstackPaymentForTransaction(paymentId) {
  const cleanPaymentId = cleanString(paymentId, 160)
  if (!cleanPaymentId) return { skipped: true, reason: 'missing_payment_id' }

  const settings = await getPaymentSettings({ includeSecrets: true })
  const taxes = settings.taxes || {}
  if (!taxes.enabled || !taxes.gigstackEnabled) return { skipped: true, reason: 'gigstack_disabled' }
  if (!taxes.gigstackApiToken) return { skipped: true, reason: 'missing_gigstack_token' }

  const row = await db.get(
    `SELECT
      p.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.id = ?`,
    [cleanPaymentId]
  )

  if (!row) return { skipped: true, reason: 'payment_not_found' }
  if (!['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'].includes(cleanString(row.status).toLowerCase())) {
    return { skipped: true, reason: 'payment_not_paid' }
  }

  const existingMetadata = parseJson(row.metadata_json)
  if (existingMetadata.gigstack?.status === 'registered' || existingMetadata.gigstack?.status === 'stamped') {
    return { skipped: true, reason: 'already_registered' }
  }

  const tax = getPaymentTax(row, settings)
  if (!tax?.enabled || tax.taxAmount <= 0) return { skipped: true, reason: 'missing_tax' }

  const payload = await buildGigstackPayload(row, settings, tax)
  const response = await fetch(`${GIGSTACK_API_BASE_URL}/payments/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${taxes.gigstackApiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = data?.message || data?.error || `Gigstack respondió ${response.status}`
    await updateGigstackMetadata(cleanPaymentId, {
      status: 'error',
      error: message
    })
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  const result = data?.data && typeof data.data === 'object' ? data.data : data
  await updateGigstackMetadata(cleanPaymentId, {
    status: result?.status || result?.invoice?.status || 'registered',
    id: result?.id || result?.payment?.id || result?.invoice?.id || '',
    uuid: result?.uuid || result?.invoice?.uuid || '',
    pdfUrl: result?.pdf_url || result?.invoice?.pdf_url || '',
    registeredAt: new Date().toISOString()
  })

  logger.info(`Pago ${cleanPaymentId} registrado en Gigstack para timbrado automático.`)
  return { registered: true, data }
}

// (PAY2-006) Reintentos con backoff: si el 1er intento de registrar la factura
// en Gigstack falla, la factura se perdía. Ahora reintentamos con espera
// exponencial. Es seguro porque registerGigstackPaymentForTransaction es
// idempotente (salta si ya está 'registered'/'stamped').
const GIGSTACK_MAX_ATTEMPTS = Math.max(1, Number(process.env.GIGSTACK_MAX_ATTEMPTS) || 4)
const GIGSTACK_RETRY_BASE_MS = Math.max(1000, Number(process.env.GIGSTACK_RETRY_BASE_MS) || 5000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// (PAY2-006) No reintentar errores que nunca se van a resolver solos
// (config faltante, pago inexistente, etc.); solo reintentar fallas
// transitorias (red, timeouts, 5xx, 429).
function isRetryableGigstackError(error) {
  const status = Number(error?.status)
  if (Number.isFinite(status) && status > 0) {
    return status === 429 || status >= 500
  }
  // Sin status HTTP suele ser error de red/timeout: reintentar.
  return true
}

export function registerGigstackPaymentForTransactionInBackground(paymentId) {
  ;(async () => {
    let lastError = null
    for (let attempt = 1; attempt <= GIGSTACK_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await registerGigstackPaymentForTransaction(paymentId)
        // (PAY2-006) Si se saltó por config/estado, no tiene sentido reintentar.
        return result
      } catch (error) {
        lastError = error
        if (attempt >= GIGSTACK_MAX_ATTEMPTS || !isRetryableGigstackError(error)) {
          break
        }
        const delayMs = GIGSTACK_RETRY_BASE_MS * Math.pow(2, attempt - 1)
        logger.warn(`Registro de pago ${paymentId} en Gigstack falló (intento ${attempt}/${GIGSTACK_MAX_ATTEMPTS}): ${error.message}. Reintentando en ${delayMs}ms.`)
        await sleep(delayMs)
      }
    }
    logger.warn(`No se pudo registrar pago ${paymentId} en Gigstack tras ${GIGSTACK_MAX_ATTEMPTS} intento(s): ${lastError?.message}`)
  })()
}
