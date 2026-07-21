import crypto from 'crypto'

import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  calculatePaymentTax,
  decodeGigstackTokenMetadata,
  getPaymentSettings
} from './paymentSettingsService.js'

const GIGSTACK_API_BASE_URL = (process.env.GIGSTACK_API_BASE_URL || 'https://api.gigstack.io/v2').replace(/\/+$/, '')
const GIGSTACK_REQUEST_TIMEOUT_MS = 15_000
const GIGSTACK_JOB_LEASE_MS = 2 * 60 * 1000
const GIGSTACK_JOB_BATCH_SIZE = 10
const GIGSTACK_MAX_ATTEMPTS = 12
const GIGSTACK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000
]
const PAID_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'])
const REGISTERED_GIGSTACK_STATUSES = new Set(['registered', 'stamped', 'succeeded'])

function cleanString(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
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

function normalizeGigstackProductKey(value, fallback = '82101800') {
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
    send_email: taxes.gigstackSendEmail !== false
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
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id
    WHERE p.id = ?`,
    [paymentId]
  )
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
    return { skipped: true, reason: 'already_registered' }
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
  if (!tax?.enabled || tax.taxAmount <= 0) return { skipped: true, reason: 'missing_tax' }
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

  logger.info(`[Gigstack] Pago ${cleanPaymentId} registrado en ${gigstackModeTitle(mode)}.`)
  return { registered: true, mode, remotePaymentId, data }
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

export async function requeueBlockedGigstackInvoiceJobs() {
  await db.run(
    `UPDATE gigstack_invoice_jobs
     SET status = 'pending', next_attempt_at_ms = 0, claim_token = NULL,
         lease_until_at_ms = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'blocked'`
  )
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
