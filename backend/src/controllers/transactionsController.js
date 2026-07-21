import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  DEFAULT_TIMEZONE,
  businessTodayDateOnly,
  getAccountTimezone,
  normalizeToUtcIso,
  resolveDateRange,
  resolveDateRangeWithGHLTimezone
} from '../utils/dateUtils.js'
import { buildTransactionStats, buildTransactionSummary } from '../services/analyticsService.js'
import {
  buildTransactionListWhere,
  buildTransactionStatusGroupExpression,
  normalizeTransactionPagination,
  normalizeTransactionStatusFilters
} from '../services/transactionQueryService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { getHighLevelConfig } from '../config/database.js'
import { syncAllInvoices, syncLocalPaymentsToHighLevel } from '../services/invoicesSyncService.js'
import { syncStripePaymentPlanFromLocalPayment } from '../services/stripePaymentService.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { triggerMetaPaymentPurchaseEvent } from '../services/metaConversionEventsService.js'
import { sendPaymentNotification } from '../services/pushNotificationsService.js'
import { queuePaymentAutomationMessage } from '../services/paymentAutomationsService.js'
import {
  getGigstackInvoiceFileDownload,
  registerGigstackPaymentForTransactionInBackground
} from '../services/gigstackInvoiceService.js'
import { dispatchProductPostWebhooksForPaymentInBackground } from '../services/productPostWebhookService.js'
import {
  getPaymentDeletionGuard,
  hardDeleteTestPaymentRecord,
  isSuccessfulPaymentStatus
} from '../services/paymentRecordSafetyService.js'
import { formatInvoiceMultilineText, formatInvoiceSingleLineText } from '../utils/invoiceTextFormatter.js'
import { findContactByPhoneCandidates, generateContactId } from '../services/contactIdentityService.js'
import { getAccountCurrency, normalizePhoneForAccount } from '../utils/accountLocale.js'
import { createRistakPaymentEntityId } from '../utils/idGenerator.js'
import { timestampSortExpression } from '../utils/sqlTimestampSort.js'
import {
  hashPaginationCursorScope,
  paginationCursorHiddenFiltersScope,
  paginationCursorListScope,
  paginationCursorRangeScope
} from '../utils/paginationCursorScope.js'
import { isPaymentListProjectionReady } from '../services/crmListProjectionService.js'
import { getCachedTransactionQuery } from '../services/paymentListSummaryCacheService.js'
import { buildPaymentDisplay } from '../utils/paymentDisplay.js'
import { serializePaymentAmount } from '../utils/paymentAmountSerialization.js'
import { formatContactName, splitContactName } from '../utils/contactNameFormatter.js'
import { completeConversationalAgentSalePaymentFromInvoice } from '../services/conversationalAgentService.js'

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const STRIPE_PLAN_AUTHORIZATION_TRIGGERS = new Set(['card_setup', 'card_setup_authorization', 'first_payment', 'first_payment_saved_card'])
const VALID_TRANSACTION_STATUSES = new Set([
  'draft',
  'sent',
  'scheduled',
  'paid',
  'pending',
  'overdue',
  'partial',
  'void',
  'refunded',
  'failed',
  'deleted'
])

function createTransactionsRequestAbortScope(req, res, timeoutMs = 18_000) {
  const controller = new AbortController()
  let disconnected = Boolean(req.aborted || res.destroyed)
  let timedOut = false
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const abortIfDisconnected = () => {
    disconnected = true
    abort()
  }

  req.once?.('aborted', abortIfDisconnected)
  res.once?.('close', abortIfDisconnected)
  if (req.aborted) abortIfDisconnected()

  const timer = setTimeout(() => {
    timedOut = true
    abort(Object.assign(new Error('La consulta de pagos agotó su tiempo.'), {
      status: 504,
      code: 'payment_request_deadline',
      retryable: true,
      retryAfter: 1
    }))
  }, timeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    abort,
    get disconnected() {
      return disconnected || Boolean(req.aborted) || Boolean(res.destroyed)
    },
    get timedOut() {
      return timedOut
    },
    cleanup() {
      clearTimeout(timer)
      req.off?.('aborted', abortIfDisconnected)
      res.off?.('close', abortIfDisconnected)
      req.removeListener?.('aborted', abortIfDisconnected)
      res.removeListener?.('close', abortIfDisconnected)
    }
  }
}

function isTransactionsRequestAbort(error, scope) {
  const abortError = error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
  return Boolean(
    scope?.disconnected ||
    (!scope?.timedOut && scope?.signal?.aborted && abortError)
  )
}

const PAYMENT_METHOD_TO_GHL_MODE = {
  card: 'card',
  transfer: 'bank_transfer',
  bank_transfer: 'bank_transfer',
  cash: 'cash',
  check: 'check',
  paypal: 'other',
  other: 'other'
}

const normalizeGhlInvoiceMode = mode => mode === 'test' ? 'test' : 'live'

async function getGhlInvoiceLiveMode() {
  try {
    const config = await db.get('SELECT ghl_invoice_mode FROM highlevel_config LIMIT 1')
    return normalizeGhlInvoiceMode(config?.ghl_invoice_mode) === 'live'
  } catch {
    return true
  }
}

const normalizeStatus = (status) => {
  if (!status) return status
  const normalized = String(status).toLowerCase()
  return normalized === 'succeeded' ? 'paid' : normalized
}

const normalizeAmount = (amount) => {
  if (amount === undefined || amount === null || amount === '') return undefined
  const parsed = Number(amount)
  if (!Number.isFinite(parsed)) {
    throw new Error('Monto inválido')
  }
  return Math.round(parsed * 100) / 100
}

const cleanString = (value) => String(value || '').trim()

const TRANSFER_PROOF_PENDING_SOURCE = 'conversational_agent_transfer_proof_pending_review'

const createLocalId = (prefix) => createRistakPaymentEntityId(prefix)

export const __transactionsControllerTestHooks = {
  paymentTimestampSortExpression: timestampSortExpression,
  paymentAmountForResponse: serializePaymentAmount
}

// (PAY-007) Idempotencia del registro manual de pago: un reintento de red NO debe
// crear un pago duplicado. Si el cliente manda Idempotency-Key (o un id estable en el
// body), derivamos un id de pago determinista para que el segundo intento reproduzca
// el primero (mismo PK) en vez de insertar otra fila.
const sanitizeIdempotencyToken = (value) => cleanString(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)

const resolveManualPaymentId = (req, bodyId) => {
  const explicitId = cleanString(bodyId)
  if (explicitId) return explicitId
  const headerKey = sanitizeIdempotencyToken(
    req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key']
  )
  if (headerKey) return `manual_payment_idemp_${headerKey}`
  return createLocalId('manual_payment')
}

const parseJson = (value, fallback = {}) => {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const getRequestBaseUrl = (req) => {
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || process.env.RENDER_EXTERNAL_URL
  if (configured) return String(configured).replace(/\/+$/, '')

  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
  const host = forwardedHost || req.headers?.host || req.get?.('host')
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'https'
  return host ? `${protocol}://${host}`.replace(/\/+$/, '') : ''
}

const buildPaymentUrlFromBase = (baseUrl, publicPaymentId) => {
  const cleanPublicId = cleanString(publicPaymentId)
  const cleanBase = cleanString(baseUrl).replace(/\/+$/, '')
  return cleanPublicId && cleanBase ? `${cleanBase}/pay/${encodeURIComponent(cleanPublicId)}` : ''
}

const appendReceiptQuery = (url = '') => {
  const cleanUrl = cleanString(url)
  if (!cleanUrl) return ''
  return cleanUrl.includes('?') ? `${cleanUrl}&receipt=1` : `${cleanUrl}?receipt=1`
}

const resolveTransactionPaymentUrl = (transaction = {}, baseUrl = '') => {
  const localUrl = buildPaymentUrlFromBase(baseUrl, transaction.public_payment_id)
  const provider = cleanString(transaction.payment_provider).toLowerCase()
  if (provider === 'mercadopago' && localUrl) return localUrl
  return cleanString(transaction.payment_url) || localUrl
}

const buildTransactionAutomationPayload = (transaction = {}, req, overrides = {}) => {
  const metadata = parseJson(transaction.metadata_json, {})
  const paymentUrl = resolveTransactionPaymentUrl(transaction, getRequestBaseUrl(req))
  const provider = transaction.payment_provider || (transaction.ghl_invoice_id ? 'highlevel' : 'manual')
  return {
    contactId: transaction.contact_id,
    paymentId: transaction.id || '',
    amount: transaction.amount,
    currency: transaction.currency,
    status: transaction.status || '',
    paymentStatus: transaction.status || '',
    product: transaction.description || transaction.title || '',
    provider,
    paymentProvider: provider,
    paymentMethod: transaction.payment_method || '',
    paymentMode: transaction.payment_mode || '',
    reference: transaction.reference || '',
    title: transaction.title || '',
    description: transaction.description || '',
    invoiceId: transaction.ghl_invoice_id || '',
    invoiceNumber: transaction.invoice_number || '',
    publicPaymentId: transaction.public_payment_id || '',
    paymentUrl,
    receiptUrl: appendReceiptQuery(paymentUrl),
    stripePaymentIntentId: transaction.stripe_payment_intent_id || '',
    stripeChargeId: transaction.stripe_charge_id || '',
    mercadoPagoPaymentId: transaction.mercadopago_payment_id || '',
    mercadoPagoPreferenceId: transaction.mercadopago_preference_id || '',
    conektaOrderId: transaction.conekta_order_id || '',
    conektaChargeId: transaction.conekta_charge_id || '',
    conektaPaymentSourceId: transaction.conekta_payment_source_id || '',
    clipPaymentId: transaction.clip_payment_id || '',
    clipReceiptNo: transaction.clip_receipt_no || '',
    rebillPaymentId: transaction.rebill_payment_id || '',
    rebillSubscriptionId: transaction.rebill_subscription_id || '',
    rebillCustomerId: transaction.rebill_customer_id || '',
    rebillCardId: transaction.rebill_card_id || '',
    paidAt: transaction.paid_at || '',
    dueDate: transaction.due_date || '',
    sentAt: transaction.sent_at || '',
    createdAt: transaction.created_at || '',
    updatedAt: transaction.updated_at || '',
    receipt: transaction.reference || transaction.invoice_number || transaction.ghl_invoice_id || '',
    paymentDate: transaction.date || transaction.created_at || '',
    metadata,
    metadataJson: transaction.metadata_json || '',
    lineItems: Array.isArray(metadata.lineItems) ? metadata.lineItems : [],
    ...overrides
  }
}

const isStripeBackedTransaction = (transaction = {}) => {
  if (cleanString(transaction.payment_provider).toLowerCase() === 'stripe') return true
  if (cleanString(transaction.payment_method).toLowerCase().startsWith('stripe')) return true
  if (cleanString(transaction.public_payment_id) || cleanString(transaction.payment_url) || cleanString(transaction.stripe_payment_intent_id)) return true
  const metadata = parseJson(transaction.metadata_json, {})
  return Boolean(metadata?.paymentPlan?.flowId)
}

const isStripePlanAuthorizationTransaction = (transaction = {}) => {
  const metadata = parseJson(transaction.metadata_json, {})
  const plan = metadata?.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : {}
  const trigger = cleanString(plan.trigger).toLowerCase()
  const source = cleanString(metadata.source).toLowerCase()

  return Boolean(plan.flowId && (
    STRIPE_PLAN_AUTHORIZATION_TRIGGERS.has(trigger) ||
    source === 'stripe_payment_plan_card_setup' ||
    source === 'stripe_payment_plan_first_link'
  ))
}

const sendStripePlanAuthorizationManualPaymentError = (res) => res.status(422).json({
  success: false,
  error: 'Este pago activa la domiciliación del plan y solo Stripe puede marcarlo como pagado cuando el cliente complete el enlace. No se puede registrar como pago offline.'
})

const sendPaymentDeletionGuardError = (res, guard) => {
  if (guard.canHardDelete) return null

  if (guard.hasPlanLink) {
    return res.status(422).json({
      success: false,
      error: 'Esta transacción pertenece a un plan de pagos. No se puede borrar desde transacciones; edita, cancela o elimina el plan completo para conservar el historial.'
    })
  }

  if (guard.hasSubscriptionLink) {
    return res.status(422).json({
      success: false,
      error: 'Esta transacción pertenece a una suscripción. No se puede borrar desde transacciones; cancela o pausa la suscripción para conservar el historial.'
    })
  }

  if (guard.hasLedgerActivity) {
    return res.status(422).json({
      success: false,
      error: 'Esta transacción ya tiene actividad de pago registrada. No se puede borrar; usa reembolso o anulación según corresponda para mantener el historial.'
    })
  }

  return null
}

const splitName = (name = '') => {
  return splitContactName(name)
}

const normalizePaymentMode = (mode) => mode === 'test' ? 'test' : 'live'

async function findExistingContactForPayment({ contactId, email, phone }) {
  if (contactId) {
    const byId = await db.get('SELECT id FROM contacts WHERE id = ?', [contactId])
    if (byId) return byId.id
  }

  const normalizedEmail = cleanString(email).toLowerCase()
  if (normalizedEmail) {
    const byEmail = await db.get('SELECT id FROM contacts WHERE LOWER(email) = ? LIMIT 1', [normalizedEmail])
    if (byEmail) return byEmail.id
  }

  if (phone) {
    const byPhone = await findContactByPhoneCandidates(phone)
    if (byPhone) return byPhone.id
  }

  return null
}

async function ensureLocalContactForPayment({ contactId, contactName, email, phone }) {
  const fullName = formatContactName(cleanString(contactName))
  const normalizedPhone = await normalizePhoneForAccount(phone) || cleanString(phone) || null
  const normalizedEmail = cleanString(email) || null
  const existingContactId = await findExistingContactForPayment({
    contactId: cleanString(contactId),
    email: normalizedEmail,
    phone: normalizedPhone
  })

  if (existingContactId) {
    const nameParts = splitName(fullName)
    try {
      await db.run(
        `UPDATE contacts
         SET phone = COALESCE(NULLIF(phone, ''), ?),
             email = COALESCE(NULLIF(email, ''), ?),
             full_name = COALESCE(NULLIF(full_name, ''), ?),
             first_name = COALESCE(NULLIF(first_name, ''), ?),
             last_name = COALESCE(NULLIF(last_name, ''), ?),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          normalizedPhone,
          normalizedEmail,
          fullName || null,
          nameParts.firstName || null,
          nameParts.lastName || null,
          existingContactId
        ]
      )
    } catch (error) {
      logger.warn(`No se pudo completar datos del contacto ${existingContactId}: ${error.message}`)
    }

    return existingContactId
  }

  if (!normalizedEmail && !normalizedPhone && !fullName) {
    return null
  }

  const id = cleanString(contactId) || generateContactId()
  const nameParts = splitName(fullName)

  await db.run(
    `INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      email = COALESCE(NULLIF(contacts.email, ''), excluded.email),
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      normalizedPhone,
      normalizedEmail,
      fullName || normalizedEmail || normalizedPhone || 'Contacto manual',
      nameParts.firstName || null,
      nameParts.lastName || null,
      'ristak_manual'
    ]
  )

  return id
}

const toDateOnly = (dateValue) => {
  if (!dateValue) return undefined
  return String(dateValue).split('T')[0]
}

/**
 * Normaliza la fecha de un pago a un timestamp ISO COMPLETO, para poder ordenar las
 * transacciones por el momento EXACTO en que se hizo/registró el pago.
 *
 * - Sin valor             -> ahora mismo (timestamp completo con hora).
 * - Ya trae hora (ISO/T)  -> se respeta tal cual.
 * - Solo fecha YYYY-MM-DD:
 *     · si es HOY         -> ahora mismo (captura la hora real del registro).
 *     · si es otra fecha  -> esa fecha a mediodía UTC. Mediodía evita que la zona
 *                            horaria mueva el pago al día anterior/siguiente; el
 *                            desempate por created_at conserva el orden de registro.
 */
const resolvePaymentTimestamp = (rawDate, timezone = DEFAULT_TIMEZONE) => {
  const now = new Date()
  const value = cleanString(rawDate)
  if (!value) return now.toISOString()

  // Ya viene con hora (timestamp ISO o "YYYY-MM-DD HH:mm:ss") -> respetar.
  if (value.includes('T') || value.includes(' ')) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString()
  }

  // Solo fecha (YYYY-MM-DD).
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const today = businessTodayDateOnly(timezone, now)
    if (value === today) return now.toISOString()
    return normalizeToUtcIso(`${value}T12:00:00`, timezone)
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString()
}

/**
 * Para edición: si el usuario deja la MISMA fecha (día) ya guardada, conservamos el
 * timestamp original para no perder la hora exacta del registro. Si cambia el día,
 * se recalcula como pago fechado en ese nuevo día.
 */
const resolvePaymentUpdateDate = (rawDate, currentDate, timezone = DEFAULT_TIMEZONE) => {
  const value = cleanString(rawDate)
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && currentDate) {
    if (value === String(currentDate).slice(0, 10)) return currentDate
  }
  return resolvePaymentTimestamp(value, timezone)
}

const mapSafeTransferProof = (transaction = {}) => {
  const metadata = parseJson(transaction.metadata_json, {})
  if (cleanString(metadata.source) !== TRANSFER_PROOF_PENDING_SOURCE) return null
  const extracted = metadata.extracted && typeof metadata.extracted === 'object' && !Array.isArray(metadata.extracted)
    ? metadata.extracted
    : {}
  const rawMediaUrl = cleanString(metadata.mediaUrl)
  const mediaUrl = /^https?:\/\//i.test(rawMediaUrl) || /^\/(?!\/)/.test(rawMediaUrl) ? rawMediaUrl : ''
  return {
    mediaUrl: mediaUrl || null,
    receivedAt: cleanString(metadata.receivedAt || transaction.created_at || transaction.date) || null,
    bank: cleanString(extracted.bank) || null,
    reference: cleanString(transaction.reference || extracted.reference) || null,
    reviewDecision: ['approved', 'rejected'].includes(cleanString(metadata.reviewDecision))
      ? cleanString(metadata.reviewDecision)
      : 'pending',
    reviewReason: cleanString(metadata.reviewReason) || null,
    reviewedAt: cleanString(metadata.reviewedAt) || null
  }
}

const mapSafeFiscalInvoice = (transaction = {}) => {
  const metadata = parseJson(transaction.metadata_json, {})
  const gigstack = metadata.gigstack && typeof metadata.gigstack === 'object' ? metadata.gigstack : null
  if (!gigstack) return null
  const invoices = Array.isArray(gigstack.invoices) ? gigstack.invoices : []
  const invoiceIds = Array.isArray(gigstack.invoiceIds) ? gigstack.invoiceIds : []
  const status = cleanString(gigstack.status, 80).toLowerCase()
  const firstInvoice = invoices[0] && typeof invoices[0] === 'object' ? invoices[0] : null
  const invoiceCount = invoices.length || invoiceIds.length
  return {
    provider: 'gigstack',
    status: status || 'pending',
    available: ['stamped', 'valid'].includes(status) && invoiceCount > 0,
    invoiceCount,
    uuid: cleanString(firstInvoice?.uuid || firstInvoice?.id || invoiceIds[0], 180),
    mode: gigstack.mode === 'test' ? 'test' : gigstack.mode === 'live' ? 'live' : null
  }
}

const mapTransactionRow = (t, baseUrl = '') => ({
  id: t.id,
  date: t.date,
  contactId: t.contact_id,
  contactName: t.contact_name || '',
  email: t.contact_email || '',
  phone: t.contact_phone || '',
  amount: serializePaymentAmount(t.amount),
  currency: t.currency,
  method: t.payment_method || 'other',
  status: normalizeStatus(t.status),
  paymentMode: t.payment_mode || 'live',
  paymentProvider: t.payment_provider || (t.ghl_invoice_id ? 'highlevel' : 'manual'),
  ...buildPaymentDisplay(t),
  reference: t.reference,
  title: t.title || t.description || 'Pago',
  description: t.description,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  invoiceId: t.ghl_invoice_id,
  invoiceNumber: t.invoice_number,
  dueDate: t.due_date,
  sentAt: t.sent_at,
  publicPaymentId: t.public_payment_id,
  paymentUrl: resolveTransactionPaymentUrl(t, baseUrl),
  stripePaymentIntentId: t.stripe_payment_intent_id,
  stripeChargeId: t.stripe_charge_id,
  mercadoPagoPaymentId: t.mercadopago_payment_id,
  mercadoPagoPreferenceId: t.mercadopago_preference_id,
  conektaOrderId: t.conekta_order_id,
  conektaChargeId: t.conekta_charge_id,
  conektaPaymentSourceId: t.conekta_payment_source_id,
  clipPaymentId: t.clip_payment_id,
  clipReceiptNo: t.clip_receipt_no,
  rebillPaymentId: t.rebill_payment_id,
  rebillSubscriptionId: t.rebill_subscription_id,
  rebillCustomerId: t.rebill_customer_id,
  rebillCardId: t.rebill_card_id,
  paidAt: t.paid_at,
  ...(mapSafeFiscalInvoice(t) ? { fiscalInvoice: mapSafeFiscalInvoice(t) } : {}),
  ...(mapSafeTransferProof(t) ? { transferProof: mapSafeTransferProof(t) } : {})
})

const getInvoiceFromResponse = (response) => response?.invoice || response?.data || response || {}

const getInvoiceItems = (invoice) => {
  if (Array.isArray(invoice.items)) return invoice.items
  if (Array.isArray(invoice.invoiceItems)) return invoice.invoiceItems
  return []
}

const buildInvoiceItemsForAmount = ({ invoice, amount, currency, title, description }) => {
  const items = getInvoiceItems(invoice)
  const firstItem = items[0] || {}
  const itemName = formatInvoiceSingleLineText(title || firstItem.name || invoice.name || invoice.title || 'Pago') || 'Pago'
  const itemDescription = formatInvoiceMultilineText(description || firstItem.description || firstItem.name || itemName) || itemName
  const rawTaxRate = Number(invoice.tax?.rate || 0)
  const taxRate = Number.isFinite(rawTaxRate) && rawTaxRate > 0 ? rawTaxRate : 0
  const subtotal = taxRate > 0
    ? Math.round((amount / (1 + taxRate / 100)) * 100) / 100
    : amount
  const taxAmount = taxRate > 0 ? Math.round((amount - subtotal) * 100) / 100 : 0

  const nextItem = {
    ...firstItem,
    name: itemName,
    description: itemDescription,
    amount: subtotal,
    qty: firstItem.qty || 1,
    currency
  }

  return {
    items: [nextItem],
    tax: taxRate > 0
      ? {
          ...invoice.tax,
          amount: taxAmount,
          rate: taxRate
        }
      : undefined
  }
}

const buildInvoiceUpdatePayload = ({ invoice, transaction, updates }) => {
  const amount = updates.amount ?? Number(transaction.amount || invoice.total || invoice.amount || 0)
  const currency = updates.currency || transaction.currency || invoice.currency || 'MXN'
  const firstItem = getInvoiceItems(invoice)[0] || {}
  const rawTitle = updates.title ?? transaction.title ?? invoice.title ?? invoice.name ?? firstItem.name ?? 'Pago'
  const rawDescription = updates.description ?? transaction.description ?? firstItem.description ?? firstItem.name ?? rawTitle
  const title = formatInvoiceSingleLineText(rawTitle) || 'Pago'
  const description = formatInvoiceMultilineText(rawDescription) || 'Pago'
  const issueDate = toDateOnly(updates.date || transaction.date || invoice.issueDate || invoice.createdAt)
  const dueDate = toDateOnly(updates.dueDate || transaction.due_date || invoice.dueDate)
  const currentItems = getInvoiceItems(invoice)
  const invoiceItemData = buildInvoiceItemsForAmount({ invoice, amount, currency, title, description })

  const payload = {
    name: title,
    title,
    currency,
    contactDetails: {
      ...(invoice.contactDetails || {}),
      id: updates.contactId || invoice.contactDetails?.id || transaction.contact_id || invoice.contactId,
      name: updates.contactName || invoice.contactDetails?.name || invoice.contactName || '',
      email: updates.email || invoice.contactDetails?.email || '',
      phoneNo: updates.phone || invoice.contactDetails?.phoneNo || invoice.contactDetails?.phone || ''
    },
    businessDetails: invoice.businessDetails,
    liveMode: invoice.liveMode !== undefined ? invoice.liveMode : true,
    items: invoiceItemData.items,
  }

  if (issueDate) payload.issueDate = issueDate
  if (dueDate) payload.dueDate = dueDate
  if (invoiceItemData.tax) payload.tax = invoiceItemData.tax
  if (invoice.termsNotes) payload.termsNotes = formatInvoiceMultilineText(invoice.termsNotes)

  if (!updates.amount && currentItems.length > 0) {
    payload.items = currentItems.map((item, index) => index === 0
      ? {
          ...item,
          name: formatInvoiceSingleLineText(item.name || title) || title,
          description: description || formatInvoiceMultilineText(item.description || item.name),
          currency: item.currency || currency
        }
      : item
    )
  }

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null) {
      delete payload[key]
    }
  })

  return payload
}

const getTransactionByIdForResponse = async (id, baseUrl = '') => {
  const row = await db.get(
    `SELECT
      p.id,
      p.contact_id,
      p.amount,
      p.currency,
      p.status,
      p.payment_mode,
      p.payment_provider,
      p.payment_method,
      p.reference,
      p.title,
      p.description,
      p.date,
      p.created_at,
      p.updated_at,
      p.ghl_invoice_id,
      p.invoice_number,
      p.due_date,
      p.sent_at,
      p.public_payment_id,
      p.payment_url,
      p.stripe_payment_intent_id,
      p.stripe_charge_id,
      p.mercadopago_payment_id,
      p.mercadopago_preference_id,
      p.conekta_order_id,
      p.conekta_charge_id,
      p.conekta_payment_source_id,
      p.clip_payment_id,
      p.clip_receipt_no,
      p.rebill_payment_id,
      p.rebill_subscription_id,
      p.rebill_customer_id,
      p.rebill_card_id,
      p.paid_at,
      p.metadata_json,
      c.full_name as contact_name,
      c.email as contact_email,
      c.phone as contact_phone
    FROM payments p
    LEFT JOIN contacts c ON p.contact_id = c.id
    WHERE p.id = ?`,
    [id]
  )

  return row ? mapTransactionRow(row, baseUrl) : null
}

/**
 * Crea una transacción/pago local. HighLevel es opcional: si está configurado,
 * el pago se exporta como invoice y se enlaza por ghl_invoice_id.
 */
export const createTransaction = async (req, res) => {
  try {
    const {
      id,
      amount,
      currency,
      method,
      paymentMethod,
      status,
      reference,
      title,
      description,
      date,
      dueDate,
      contactId,
      contactName,
      email,
      phone,
      paymentMode,
      metadata
    } = req.body

    const finalAmount = normalizeAmount(amount)
    if (finalAmount === undefined || finalAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      })
    }

    const finalStatus = normalizeStatus(status) || 'paid'
    if (!VALID_TRANSACTION_STATUSES.has(finalStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Estado de pago inválido'
      })
    }

    const finalContactId = await ensureLocalContactForPayment({
      contactId,
      contactName,
      email,
      phone
    })

    if (!finalContactId) {
      return res.status(400).json({
        success: false,
        error: 'Necesitas asociar el pago a un contacto con nombre, email o teléfono'
      })
    }

    // (PAY-007) Id idempotente: con Idempotency-Key (o id estable) un reintento
    // reusa el mismo PK en vez de duplicar el pago.
    const transactionId = resolveManualPaymentId(req, id)

    // (PAY-007) Replay idempotente: si ya existe un pago con este id (reintento de
    // red), devolvemos el existente sin volver a insertar ni re-disparar efectos.
    const existingTransaction = await getTransactionByIdForResponse(transactionId, getRequestBaseUrl(req))
    if (existingTransaction) {
      logger.info(`Transacción ${transactionId} ya existía (reintento idempotente); se devuelve sin duplicar`)
      return res.status(200).json({
        success: true,
        data: existingTransaction
      })
    }

    const finalCurrency = cleanString(await getAccountCurrency()).toUpperCase() || 'MXN'
    const finalMethod = cleanString(paymentMethod || method || 'cash') || 'cash'
    const finalTitle = cleanString(title || description || 'Pago')
    const finalDescription = cleanString(description || title || 'Pago')
    const accountTimezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
    const finalDate = resolvePaymentTimestamp(date, accountTimezone)
    const finalPaymentMode = normalizePaymentMode(paymentMode)
    const metadataJson = metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : null

    // (PAY-007) INSERT idempotente: ON CONFLICT DO NOTHING cierra la ventana de
    // carrera entre el chequeo previo y el insert. Si no se insertó (changes==0),
    // otro reintento ya creó el pago: devolvemos el existente sin re-disparar efectos.
    const insertResult = await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, reference, title, description, date, due_date, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING`,
      [
        transactionId,
        finalContactId,
        finalAmount,
        finalCurrency,
        finalStatus,
        finalMethod,
        finalPaymentMode,
        'manual',
        reference || null,
        finalTitle,
        finalDescription,
        finalDate,
        dueDate || null,
        metadataJson
      ]
    )

    if (Number(insertResult?.changes || 0) <= 0) {
      const replayTransaction = await getTransactionByIdForResponse(transactionId, getRequestBaseUrl(req))
      if (replayTransaction) {
        logger.info(`Transacción ${transactionId} ya existía (carrera de reintento); se devuelve sin duplicar`)
        return res.status(200).json({
          success: true,
          data: replayTransaction
        })
      }
    }

    await updateSingleContactStats(finalContactId)

    if (SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      await triggerMetaPaymentPurchaseEvent(finalContactId, {
        id: transactionId,
        amount: finalAmount,
        currency: finalCurrency,
        paymentMode: finalPaymentMode
      })
    }

    try {
      const localExport = await syncLocalPaymentsToHighLevel({ paymentId: transactionId, limit: 1 })
      if (localExport.exported > 0) {
        logger.success(`Pago local exportado a HighLevel: ${transactionId}`)
      }
    } catch (syncError) {
      logger.warn(`Pago ${transactionId} guardado localmente; no se pudo exportar a HighLevel: ${syncError.message}`)
    }

    const createdTransaction = await getTransactionByIdForResponse(transactionId, getRequestBaseUrl(req))

    if (createdTransaction) {
      dispatchProductPostWebhooksForPaymentInBackground(transactionId, { status: finalStatus })
    }

    if (createdTransaction && SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      registerGigstackPaymentForTransactionInBackground(transactionId)
      queuePaymentAutomationMessage('receipt', transactionId)
      sendPaymentNotification(createdTransaction).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${transactionId}: ${pushError.message}`)
      })
    }

    logger.success(`Transacción creada: ${transactionId}`)

    res.status(201).json({
      success: true,
      data: createdTransaction
    })
  } catch (error) {
    logger.error(`Error creando transacción: ${error.message}`)
    const statusCode = error.message === 'Monto inválido' ? 400 : 500
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Error creando transacción'
    })
  }
}

/**
 * Obtiene todas las transacciones/pagos con paginación y filtros
 */
const TRANSACTION_LIST_CURSOR_KIND = 'transactions-list'

function transactionListCursorError(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function encodeTransactionListCursor(row, scope) {
  if (!row?.id || row.cursor_sort_value === undefined || row.cursor_sort_value === null) return null
  return Buffer.from(JSON.stringify({
    v: 2,
    kind: TRANSACTION_LIST_CURSOR_KIND,
    scope,
    sort: String(row.cursor_sort_value),
    created: String(row.cursor_created_value ?? 0),
    id: String(row.id)
  }), 'utf8').toString('base64url')
}

function decodeTransactionListCursor(value, expectedScope) {
  const clean = cleanString(value)
  if (!clean) return null
  if (clean.length > 4096) throw transactionListCursorError('Cursor inválido')
  try {
    const decoded = JSON.parse(Buffer.from(clean, 'base64url').toString('utf8'))
    if (decoded?.v !== 2 || decoded?.kind !== TRANSACTION_LIST_CURSOR_KIND || decoded?.scope !== expectedScope) {
      if (decoded?.scope && decoded.scope !== expectedScope) {
        throw transactionListCursorError('El cursor ya no corresponde a estos filtros; vuelve a la primera página')
      }
      throw new Error('invalid cursor payload')
    }
    // Un valor de orden vacío es legítimo (por ejemplo, un pago huérfano
    // ordenado por nombre/email). No lo confundimos con un cursor ausente y
    // conservamos espacios exactamente como quedaron almacenados.
    const sort = typeof decoded.sort === 'string' ? decoded.sort : null
    const created = typeof decoded.created === 'string' ? decoded.created : null
    const id = cleanString(decoded.id)
    if (sort === null || !created || !id || sort.length > 500 || created.length > 500 || id.length > 500) {
      throw new Error('invalid cursor values')
    }
    return { sort, created, id }
  } catch (error) {
    if (error?.status === 400) throw error
    throw transactionListCursorError('Cursor inválido')
  }
}

function getTransactionListSortDescriptor(sortBy, useProjection) {
  const normalized = String(sortBy || 'date')
  const key = normalized === 'createdAt'
    ? 'created_at'
    : normalized === 'paymentType'
      ? 'method'
      : normalized === 'paymentChannel'
        ? 'provider'
        : normalized
  const statusGroupExpression = buildTransactionStatusGroupExpression('p')
  const directMap = {
    date: timestampSortExpression('p.date'),
    created_at: timestampSortExpression('p.created_at'),
    amount: 'COALESCE(p.amount, 0)',
    status: statusGroupExpression,
    contactName: "LOWER(COALESCE(c.full_name, ''))",
    email: "LOWER(COALESCE(c.email, ''))",
    method: "LOWER(COALESCE(p.payment_method, ''))",
    provider: "LOWER(COALESCE(p.payment_provider, ''))",
    title: "LOWER(COALESCE(p.title, p.description, ''))"
  }
  const projectedMap = {
    date: 'pla.date_sort',
    created_at: 'pla.created_sort',
    amount: 'pla.amount_sort',
    status: 'pla.status_sort',
    contactName: 'pla.contact_name_sort',
    email: 'pla.contact_email_sort',
    method: 'pla.method_sort',
    provider: 'pla.provider_sort',
    title: 'pla.title_sort'
  }
  const safeKey = Object.prototype.hasOwnProperty.call(directMap, key) ? key : 'date'
  return {
    key: safeKey,
    primary: useProjection ? projectedMap[safeKey] : directMap[safeKey],
    created: useProjection ? 'pla.created_sort' : timestampSortExpression('p.created_at'),
    type: ['status', 'contactName', 'email', 'method', 'provider', 'title'].includes(safeKey) ? 'text' : 'numeric'
  }
}

export const getTransactions = async (req, res) => {
  try {
    const {
      page = 1,
      limit,
      status = '',
      statuses = '',
      q = '',
      search = '',
      startDate,
      endDate,
      sortBy = 'date',
      sortOrder = 'DESC'
    } = req.query

    const searchTerm = cleanString(q || search)
    const selectedStatuses = normalizeTransactionStatusFilters([
      ...(Array.isArray(status) ? status : [status]),
      ...(Array.isArray(statuses) ? statuses : [statuses])
    ])
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'
    const { pageNumber, limitNumber, offset } = normalizeTransactionPagination({ page, limit })
    const cursorMode = String(req.query.pagination || '').toLowerCase() === 'cursor' || Boolean(req.query.cursor)

    logger.info(`Obteniendo transacciones - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    const listWhere = buildTransactionListWhere({
      range,
      statuses: selectedStatuses,
      search: searchTerm,
      hiddenCondition,
      paymentAlias: 'p',
      contactAlias: 'c'
    })
    const projectionReady = await isPaymentListProjectionReady()
    const sortDescriptor = getTransactionListSortDescriptor(sortBy, projectionReady)
    const legacySortDescriptor = getTransactionListSortDescriptor(sortBy, false)
    const orderDirection = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    const cursorScope = hashPaginationCursorScope(TRANSACTION_LIST_CURSOR_KIND, {
      range: paginationCursorRangeScope(range),
      statuses: paginationCursorListScope(selectedStatuses),
      search: searchTerm.toLowerCase(),
      hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters),
      sortBy: sortDescriptor.key,
      sortOrder: orderDirection
    })
    const decodedCursor = cursorMode ? decodeTransactionListCursor(req.query.cursor, cursorScope) : null
    const comparator = orderDirection === 'ASC' ? '>' : '<'
    const valueCast = sortDescriptor.type === 'text' ? 'CAST(? AS TEXT)' : 'CAST(? AS NUMERIC)'
    const cursorConditions = []
    const cursorParams = []
    if (decodedCursor) {
      if (sortDescriptor.key === 'created_at') {
        cursorConditions.push(`(
          ${sortDescriptor.created} ${comparator} CAST(? AS NUMERIC)
          OR (${sortDescriptor.created} = CAST(? AS NUMERIC) AND p.id ${comparator} ?)
        )`)
        cursorParams.push(decodedCursor.sort, decodedCursor.sort, decodedCursor.id)
      } else {
        cursorConditions.push(`(
          ${sortDescriptor.primary} ${comparator} ${valueCast}
          OR (${sortDescriptor.primary} = ${valueCast} AND (
            ${sortDescriptor.created} ${comparator} CAST(? AS NUMERIC)
            OR (${sortDescriptor.created} = CAST(? AS NUMERIC) AND p.id ${comparator} ?)
          ))
        )`)
        cursorParams.push(
          decodedCursor.sort,
          decodedCursor.sort,
          decodedCursor.created,
          decodedCursor.created,
          decodedCursor.id
        )
      }
    }
    const pageConditions = [...listWhere.filters, ...cursorConditions]
    const projectionJoin = projectionReady
      ? 'JOIN payment_list_activity pla ON pla.payment_id = p.id'
      : ''
    const primaryOrder = `cursor_sort_value ${orderDirection}`
    const tieOrder = sortDescriptor.key === 'created_at'
      ? `payment_id ${orderDirection}`
      : `cursor_created_value ${orderDirection}, payment_id ${orderDirection}`

    let transactions
    let totalTransactions = null
    let totalPages = null
    let hasNext
    let statusFacetRows = []

    if (cursorMode) {
      const transactionsQuery = `
        WITH page_payments AS (
          SELECT
            p.id AS payment_id,
            ${sortDescriptor.primary} AS cursor_sort_value,
            ${sortDescriptor.created} AS cursor_created_value
          FROM payments p
          LEFT JOIN contacts c ON p.contact_id = c.id
          ${projectionJoin}
          ${pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : ''}
          ORDER BY ${sortDescriptor.primary} ${orderDirection},
            ${sortDescriptor.key === 'created_at' ? `p.id ${orderDirection}` : `${sortDescriptor.created} ${orderDirection}, p.id ${orderDirection}`}
          LIMIT ?
        )
        SELECT
          page_payments.cursor_sort_value,
          page_payments.cursor_created_value,
        p.id,
        p.contact_id,
        p.amount,
        p.currency,
        p.status,
        p.payment_mode,
        p.payment_provider,
        p.payment_method,
        p.reference,
        p.title,
        p.description,
        p.date,
        p.created_at,
        p.updated_at,
        p.ghl_invoice_id,
        p.invoice_number,
        p.due_date,
        p.sent_at,
        p.public_payment_id,
        p.payment_url,
        p.stripe_payment_intent_id,
        p.stripe_charge_id,
        p.mercadopago_payment_id,
        p.mercadopago_preference_id,
        p.conekta_order_id,
        p.conekta_charge_id,
        p.conekta_payment_source_id,
        p.clip_payment_id,
        p.clip_receipt_no,
        p.rebill_payment_id,
        p.rebill_subscription_id,
        p.rebill_customer_id,
        p.rebill_card_id,
        p.paid_at,
        p.metadata_json,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone
        FROM page_payments
        JOIN payments p ON p.id = page_payments.payment_id
        LEFT JOIN contacts c ON p.contact_id = c.id
        ORDER BY ${primaryOrder}, ${tieOrder}
      `
      const queried = await db.all(transactionsQuery, [
        ...listWhere.params,
        ...cursorParams,
        limitNumber + 1
      ])
      hasNext = queried.length > limitNumber
      transactions = hasNext ? queried.slice(0, limitNumber) : queried
    } else {
      const facetsWhere = buildTransactionListWhere({
        range,
        statuses: [],
        search: searchTerm,
        hiddenCondition,
        paymentAlias: 'p',
        contactAlias: 'c'
      })
      const statusGroupExpression = buildTransactionStatusGroupExpression('p')
      const [countResult, facetRows, rows] = await Promise.all([
        db.get(
          `SELECT COUNT(*) as total FROM payments p LEFT JOIN contacts c ON p.contact_id = c.id ${listWhere.whereClause}`,
          listWhere.params
        ),
        db.all(
          `SELECT ${statusGroupExpression} as status, COUNT(*) as count
           FROM payments p LEFT JOIN contacts c ON p.contact_id = c.id
           ${facetsWhere.whereClause}
           GROUP BY ${statusGroupExpression}`,
          facetsWhere.params
        ),
        db.all(`
          SELECT p.*, c.full_name as contact_name, c.email as contact_email, c.phone as contact_phone
          FROM payments p
          LEFT JOIN contacts c ON p.contact_id = c.id
          ${listWhere.whereClause}
          ORDER BY ${legacySortDescriptor.primary} ${orderDirection},
            ${legacySortDescriptor.key === 'created_at' ? `p.id ${orderDirection}` : `${legacySortDescriptor.created} ${orderDirection}, p.id ${orderDirection}`}
          LIMIT ? OFFSET ?
        `, [...listWhere.params, limitNumber, offset])
      ])
      totalTransactions = Number(countResult?.total || 0)
      totalPages = Math.max(Math.ceil(totalTransactions / limitNumber), 1)
      hasNext = pageNumber < totalPages
      statusFacetRows = facetRows
      transactions = rows
    }

    // Mapear campos de base de datos a nombres esperados por frontend
    const responseBaseUrl = getRequestBaseUrl(req)
    const mappedTransactions = transactions.map(transaction => mapTransactionRow(transaction, responseBaseUrl))

    const nextCursor = cursorMode && hasNext && transactions.length
      ? encodeTransactionListCursor(transactions[transactions.length - 1], cursorScope)
      : null

    logger.debug(
      `Transacciones obtenidas (${rangeLabel}) -> ${transactions.length} registros, modo ${cursorMode ? 'cursor' : 'legacy'}`
    )

    res.json({
      success: true,
      data: mappedTransactions,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total: totalTransactions,
        totalPages,
        hasNext,
        hasPrev: pageNumber > 1,
        nextCursor
      },
      facets: {
        statuses: statusFacetRows
          .map(row => ({
            value: String(row.status || '').trim(),
            count: Number(row.count || 0)
          }))
          .filter(row => row.value)
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo transacciones: ${error.message}`)
    const status = error?.status === 400 ? 400 : 500
    res.status(status).json({
      success: false,
      error: status === 400 ? error.message : 'Error obteniendo transacciones'
    })
  }
}

/** Facetas versionadas; nunca forman parte del camino crítico de la tabla. */
export const getTransactionFacets = async (req, res) => {
  const requestScope = createTransactionsRequestAbortScope(req, res)
  try {
    const { q = '', search = '', startDate, endDate } = req.query
    const searchTerm = cleanString(q || search)
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal })
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal })
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    const facetsWhere = buildTransactionListWhere({
      range,
      statuses: [],
      search: searchTerm,
      hiddenCondition,
      paymentAlias: 'p',
      contactAlias: 'c'
    })
    const cacheKey = `facets:${hashPaginationCursorScope('transactions-facets-v1', {
      range: paginationCursorRangeScope(range),
      search: searchTerm.toLowerCase(),
      hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters)
    })}`
    const facets = await getCachedTransactionQuery(cacheKey, async (buildSignal) => {
      const statusGroupExpression = buildTransactionStatusGroupExpression('p')
      const rows = await db.all(
        `SELECT ${statusGroupExpression} AS status, COUNT(*) AS count
         FROM payments p
         LEFT JOIN contacts c ON p.contact_id = c.id
         ${facetsWhere.whereClause}
         GROUP BY ${statusGroupExpression}`,
        facetsWhere.params,
        { signal: buildSignal }
      )
      return {
        statuses: rows
          .map(row => ({ value: cleanString(row.status), count: Number(row.count || 0) }))
          .filter(row => row.value)
      }
    }, { signal: requestScope.signal })

    if (!requestScope.disconnected) res.json({ success: true, data: facets })
  } catch (error) {
    if (isTransactionsRequestAbort(error, requestScope)) return
    requestScope.abort(error)
    logger.error(`Error obteniendo facetas de transacciones: ${error.message}`)
    const requestedStatus = Number(error?.status || error?.statusCode || 500)
    const status = requestScope.timedOut
      ? 504
      : Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
        ? requestedStatus
        : 500
    const retryable = status >= 503 || Boolean(error?.retryable || error?.retriable)
    if (retryable) res.set?.('Retry-After', String(error?.retryAfter || 1))
    res.status(status).json({
      success: false,
      error: status >= 503 ? (error?.message || 'La consulta tardó demasiado') : 'Error obteniendo filtros de transacciones',
      code: requestScope.timedOut ? 'payment_request_deadline' : (error?.code || null),
      retryable
    })
  } finally {
    requestScope.cleanup()
  }
}

/** Sincronización explícita: las lecturas GET permanecen 100% locales. */
export const syncTransactions = async (_req, res) => {
  try {
    const stats = await syncAllInvoices()
    res.json({ success: true, data: stats })
  } catch (error) {
    logger.error(`Error sincronizando transacciones: ${error.message}`)
    res.status(502).json({ success: false, error: 'No se pudieron sincronizar los pagos' })
  }
}

/**
 * Obtiene una transacción por ID
 */
export const getTransactionById = async (req, res) => {
  try {
    const { id } = req.params

    // Obtener filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)

    const conditions = ['p.id = ?']
    // Filtrar contactos ocultos (permitir pagos sin contacto)
    if (hiddenCondition) {
      conditions.push(`(p.contact_id IS NULL OR ${hiddenCondition})`)
    }

    const transaction = await db.get(
      `SELECT
        p.*,
        c.full_name as contact_name,
        c.email as contact_email,
        c.phone as contact_phone,
        c.source as contact_source,
        c.attribution_ad_name,
        c.attribution_ad_id
      FROM payments p
      LEFT JOIN contacts c ON p.contact_id = c.id
      WHERE ${conditions.join(' AND ')}`,
      [id]
    )

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedTransaction = {
      id: transaction.id,
      date: transaction.date,
      contactId: transaction.contact_id,
      contactName: transaction.contact_name || '',
      email: transaction.contact_email || '',
      phone: transaction.contact_phone || '',
      amount: serializePaymentAmount(transaction.amount),
      currency: transaction.currency,
      method: transaction.payment_method || 'other',
      status: normalizeStatus(transaction.status),
      paymentMode: transaction.payment_mode || 'live',
      paymentProvider: transaction.payment_provider || (transaction.ghl_invoice_id ? 'highlevel' : 'manual'),
      reference: transaction.reference,
      title: transaction.title || transaction.description || 'Pago',
      description: transaction.description,
      createdAt: transaction.created_at,
      updatedAt: transaction.updated_at,
      invoiceId: transaction.ghl_invoice_id,
      invoiceNumber: transaction.invoice_number,
      dueDate: transaction.due_date,
      sentAt: transaction.sent_at,
      publicPaymentId: transaction.public_payment_id,
      paymentUrl: resolveTransactionPaymentUrl(transaction, getRequestBaseUrl(req)),
      stripePaymentIntentId: transaction.stripe_payment_intent_id,
      stripeChargeId: transaction.stripe_charge_id,
      mercadoPagoPaymentId: transaction.mercadopago_payment_id,
      mercadoPagoPreferenceId: transaction.mercadopago_preference_id,
      conektaOrderId: transaction.conekta_order_id,
      conektaChargeId: transaction.conekta_charge_id,
      conektaPaymentSourceId: transaction.conekta_payment_source_id,
      clipPaymentId: transaction.clip_payment_id,
      clipReceiptNo: transaction.clip_receipt_no,
      rebillPaymentId: transaction.rebill_payment_id,
      rebillSubscriptionId: transaction.rebill_subscription_id,
      rebillCustomerId: transaction.rebill_customer_id,
      rebillCardId: transaction.rebill_card_id,
      paidAt: transaction.paid_at,
      ...(mapSafeFiscalInvoice(transaction) ? { fiscalInvoice: mapSafeFiscalInvoice(transaction) } : {}),
      ...(mapSafeTransferProof(transaction) ? { transferProof: mapSafeTransferProof(transaction) } : {}),
      contactSource: transaction.contact_source,
      attributionAdName: transaction.attribution_ad_name,
      attributionAdId: transaction.attribution_ad_id
    }

    res.json({
      success: true,
      data: mappedTransaction
    })

  } catch (error) {
    logger.error(`Error obteniendo transacción ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo transacción'
    })
  }
}

export const downloadTransactionFiscalInvoice = async (req, res) => {
  try {
    const result = await getGigstackInvoiceFileDownload(req.params.id, req.query.format || 'zip')
    res.set('Cache-Control', 'private, no-store')
    res.set('Content-Type', result.contentType)
    res.attachment(result.fileName)
    res.send(result.buffer)
  } catch (error) {
    logger.warn(`No se pudo descargar la factura fiscal de ${req.params.id}: ${error.message}`)
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'No se pudo descargar la factura fiscal'
    })
  }
}

/**
 * Obtiene estadísticas de transacciones
 */
export const getTransactionStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const { range, stats } = await buildTransactionStats({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    res.json({
      success: true,
      data: stats
    })

    logger.debug(
      `Stats transacciones (${rangeLabel}) -> pagos: ${stats.total.count}`
    )

  } catch (error) {
    logger.error(`Error obteniendo estadísticas de transacciones: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    })
  }
}

/**
 * Obtiene el resumen de transacciones para el dashboard
 */
export const getTransactionSummary = async (req, res) => {
  const requestScope = createTransactionsRequestAbortScope(req, res)
  try {
    const { startDate, endDate, status = '', statuses = '', q = '', search = '' } = req.query
    const selectedStatuses = normalizeTransactionStatusFilters([
      ...(Array.isArray(status) ? status : [status]),
      ...(Array.isArray(statuses) ? statuses : [statuses])
    ])
    const searchTerm = cleanString(q || search)
    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate, signal: requestScope.signal })
    const hiddenFilters = await getHiddenContactFilters({ signal: requestScope.signal })
    const cacheKey = `summary:${hashPaginationCursorScope('transactions-summary-v1', {
      range: paginationCursorRangeScope(range),
      statuses: paginationCursorListScope(selectedStatuses),
      search: searchTerm.toLowerCase(),
      hiddenFilters: paginationCursorHiddenFiltersScope(hiddenFilters)
    })}`
    const summary = await getCachedTransactionQuery(cacheKey, async (buildSignal) => {
      const built = await buildTransactionSummary({
        startDate,
        endDate,
        search: searchTerm,
        statuses: selectedStatuses,
        signal: buildSignal
      })
      return built.summary
    }, { signal: requestScope.signal })

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'todos'

    logger.info(`Obteniendo resumen de transacciones - rango: ${rangeLabel}`)

    if (!requestScope.disconnected) {
      res.json({
        success: true,
        data: summary
      })
    }

    logger.debug(
      `Resumen transacciones (${rangeLabel}) -> total: ${summary.totalRevenue}, reembolsos: ${summary.refunds}`
    )

  } catch (error) {
    if (isTransactionsRequestAbort(error, requestScope)) return
    requestScope.abort(error)
    logger.error(`Error obteniendo resumen de transacciones: ${error.message}`)
    const requestedStatus = Number(error?.status || error?.statusCode || 500)
    const status = requestScope.timedOut
      ? 504
      : Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
        ? requestedStatus
        : 500
    const retryable = status >= 503 || Boolean(error?.retryable || error?.retriable)
    if (retryable) res.set?.('Retry-After', String(error?.retryAfter || 1))
    res.status(status).json({
      success: false,
      error: status >= 503 ? (error?.message || 'La consulta tardó demasiado') : 'Error obteniendo resumen',
      code: requestScope.timedOut ? 'payment_request_deadline' : (error?.code || null),
      retryable
    })
  } finally {
    requestScope.cleanup()
  }
}

/**
 * Actualiza una transacción/pago y sincroniza los cambios posibles con HighLevel
 */
export const updateTransaction = async (req, res) => {
  try {
    const { id } = req.params
    const {
      amount,
      currency,
      method,
      paymentMethod,
      status,
      reference,
      title,
      description,
      date,
      dueDate,
      contactId,
      contactName,
      email,
      phone
    } = req.body

    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    if (getTransferProofReviewState(transaction).valid) {
      return res.status(409).json({
        success: false,
        error: 'Este comprobante usa un flujo de revisión protegido. Usa Aprobar o Rechazar; no se puede editar como un pago normal.'
      })
    }

    const accountCurrency = cleanString(await getAccountCurrency()).toUpperCase() || 'MXN'
    const accountTimezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
    const shouldNormalizeCurrency = currency !== undefined || cleanString(transaction.currency).toUpperCase() !== accountCurrency
    const updates = {
      amount: normalizeAmount(amount),
      currency: shouldNormalizeCurrency ? accountCurrency : undefined,
      method: paymentMethod || method,
      status: status ? normalizeStatus(status) : undefined,
      reference: reference !== undefined ? String(reference || '') : undefined,
      title: title !== undefined ? String(title || '') : undefined,
      description: description !== undefined ? String(description || '') : undefined,
      date: resolvePaymentUpdateDate(date, transaction.date, accountTimezone),
      dueDate: dueDate || undefined,
      contactId: contactId || undefined,
      contactName: contactName || undefined,
      email: email || undefined,
      phone: phone || undefined
    }

    if (updates.amount !== undefined && updates.amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'El monto debe ser mayor a 0'
      })
    }

    if (updates.status && !VALID_TRANSACTION_STATUSES.has(updates.status)) {
      return res.status(400).json({
        success: false,
        error: 'Estado de pago inválido'
      })
    }

    const currentStatus = normalizeStatus(transaction.status)
    const nextStatus = updates.status || currentStatus
    const statusChanged = nextStatus !== currentStatus
    const invoiceId = transaction.ghl_invoice_id

    if (statusChanged && nextStatus === 'paid' && isStripePlanAuthorizationTransaction(transaction)) {
      return sendStripePlanAuthorizationManualPaymentError(res)
    }

    if (statusChanged && nextStatus === 'deleted') {
      const deletionGuard = await getPaymentDeletionGuard(transaction)
      const guardResponse = sendPaymentDeletionGuardError(res, deletionGuard)
      if (guardResponse) return guardResponse
    }

    if (invoiceId && statusChanged && nextStatus === 'refunded') {
      return res.status(422).json({
        success: false,
        error: 'HighLevel no expone un endpoint público para emitir reembolsos desde esta integración. Haz el refund en HighLevel; Ristak lo actualizará por webhook o sincronización.'
      })
    }

    if (invoiceId && statusChanged && nextStatus === 'void' && SUCCESS_PAYMENT_STATUSES.has(currentStatus)) {
      return res.status(422).json({
        success: false,
        error: 'HighLevel no permite anular un invoice pagado sin reembolsarlo primero. Procesa el refund en HighLevel y después sincroniza.'
      })
    }

    if (invoiceId && statusChanged && !['paid', 'void'].includes(nextStatus)) {
      return res.status(422).json({
        success: false,
        error: `HighLevel no permite cambiar manualmente el estado del invoice a "${nextStatus}" por API. Sí se puede editar monto, fecha, descripción, registrar pago o anular.`
      })
    }

    const hasInvoiceFieldUpdates = [
      updates.amount,
      updates.currency,
      updates.title,
      updates.description,
      updates.date,
      updates.dueDate,
      updates.contactId
    ].some(value => value !== undefined)

    if (invoiceId && hasInvoiceFieldUpdates && nextStatus !== 'void') {
      const ghlClient = await getGHLClient()
      const invoiceResponse = await ghlClient.getInvoice(invoiceId)
      const invoice = getInvoiceFromResponse(invoiceResponse)
      const payload = buildInvoiceUpdatePayload({ invoice, transaction, updates })
      await ghlClient.updateInvoice(invoiceId, payload)
    }

    let recordedPaymentMode = transaction.payment_mode || 'live'

    if (invoiceId && statusChanged && nextStatus === 'paid') {
      const ghlClient = await getGHLClient()
      const liveMode = await getGhlInvoiceLiveMode()
      recordedPaymentMode = liveMode ? 'live' : 'test'
      await ghlClient.recordPayment(invoiceId, {
        amount: updates.amount ?? transaction.amount,
        currency: accountCurrency,
        fulfilledAt: updates.date || transaction.date || new Date().toISOString(),
        mode: PAYMENT_METHOD_TO_GHL_MODE[updates.method || transaction.payment_method] || 'cash',
        note: recordedPaymentMode === 'test'
          ? 'Pago registrado desde edición de Ristak\nModo: prueba'
          : 'Pago registrado desde edición de Ristak',
        liveMode
      })
    }

    if (invoiceId && statusChanged && nextStatus === 'void') {
      const ghlClient = await getGHLClient()
      await ghlClient.voidInvoice(invoiceId)
    }

    const finalContactId = updates.contactId ?? transaction.contact_id
    const finalAmount = updates.amount ?? transaction.amount
    const finalCurrency = accountCurrency
    const finalStatus = nextStatus
    const finalMethod = updates.method ?? transaction.payment_method
    const finalReference = updates.reference ?? transaction.reference
    const finalTitle = updates.title ?? transaction.title
    const finalDescription = updates.description ?? transaction.description
    const finalDate = updates.date ?? transaction.date
    const finalDueDate = updates.dueDate ?? transaction.due_date
    const finalPaymentMode = statusChanged && nextStatus === 'paid'
      ? recordedPaymentMode
      : (transaction.payment_mode || 'live')

    await db.run(
      `UPDATE payments
       SET contact_id = ?, amount = ?, currency = ?, status = ?, payment_method = ?,
           reference = ?, title = ?, description = ?, date = ?, due_date = ?, payment_mode = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        finalContactId,
        finalAmount,
        finalCurrency,
        finalStatus,
        finalMethod,
        finalReference,
        finalTitle,
        finalDescription,
        finalDate,
        finalDueDate,
        finalPaymentMode,
        id
      ]
    )

    if (isStripeBackedTransaction(transaction)) {
      await syncStripePaymentPlanFromLocalPayment(id)
    }

    const statsContacts = new Set([transaction.contact_id, finalContactId].filter(Boolean))
    await Promise.all([...statsContacts].map(contact => updateSingleContactStats(contact)))

    if (finalContactId && statusChanged && SUCCESS_PAYMENT_STATUSES.has(finalStatus)) {
      await triggerMetaPaymentPurchaseEvent(finalContactId, {
        id,
        amount: finalAmount,
        currency: finalCurrency,
        paymentMode: finalPaymentMode
      })
    }

    const updatedTransaction = await getTransactionByIdForResponse(id, getRequestBaseUrl(req))
    if (updatedTransaction && statusChanged) {
      dispatchProductPostWebhooksForPaymentInBackground(id, {
        status: finalStatus,
        previousStatus: transaction.status || ''
      })
      sendPaymentNotification({ ...updatedTransaction, status: finalStatus, previousStatus: transaction.status || '' }).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
      })
    }
    if (statusChanged && SUCCESS_PAYMENT_STATUSES.has(finalStatus) && finalContactId) {
      await completeConversationalAgentSalePaymentFromInvoice({
        contactId: finalContactId,
        invoiceId: transaction.ghl_invoice_id || '',
        paymentId: id,
        amount: finalAmount,
        currency: finalCurrency,
        status: finalStatus,
        paymentMode: finalPaymentMode,
        reference: finalReference || ''
      }).catch((error) => {
        logger.warn(`Pago ${id} actualizado; la reconciliación conversacional no se completó: ${error.message}`)
      })
    }

    logger.success(`Transacción actualizada: ${id}`)

    res.json({
      success: true,
      data: updatedTransaction
    })

  } catch (error) {
    logger.error(`Error actualizando transacción ${req.params.id}: ${error.message}`)
    const statusCode = error.message === 'Monto inválido' ? 400 : 500
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Error actualizando transacción'
    })
  }
}

/**
 * Elimina una transacción/pago
 */
export const deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Eliminando transacción: ${id}`)

    // Verificar que existe
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    const transferProofReview = getTransferProofReviewState(transaction)
    const isCanonicalPendingTransferProof = Boolean(
      normalizeStatus(transaction.status) === 'pending_review' &&
      cleanString(transaction.payment_mode).toLowerCase() === 'manual_review' &&
      cleanString(transaction.payment_method).toLowerCase() === 'bank_transfer' &&
      cleanString(transaction.payment_provider).toLowerCase() === 'manual'
    )
    if (transferProofReview.valid || isCanonicalPendingTransferProof) {
      return res.status(409).json({
        success: false,
        error: 'Este comprobante usa un flujo de revisión protegido y forma parte del historial de auditoría. No se puede eliminar.'
      })
    }

    const deletionGuard = await getPaymentDeletionGuard(transaction)
    const guardResponse = sendPaymentDeletionGuardError(res, deletionGuard)
    if (guardResponse) return guardResponse

    if (deletionGuard.isTestMode || deletionGuard.isDeletedRecord) {
      await hardDeleteTestPaymentRecord(id)
    } else if (deletionGuard.shouldArchive) {
      let archiveStatus = 'deleted'
      if (transaction.ghl_invoice_id) {
        const ghlClient = await getGHLClient()
        await ghlClient.voidInvoice(transaction.ghl_invoice_id)
        archiveStatus = 'void'
      }

      await db.run(
        'UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [archiveStatus, id]
      )
      dispatchProductPostWebhooksForPaymentInBackground(id, {
        status: archiveStatus,
        previousStatus: transaction.status || ''
      })
      const notificationPayment = await getTransactionByIdForResponse(id, getRequestBaseUrl(req)) || transaction
      sendPaymentNotification({ ...notificationPayment, status: archiveStatus, previousStatus: transaction.status || '' }).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
      })
      if (isStripeBackedTransaction(transaction)) {
        await syncStripePaymentPlanFromLocalPayment(id)
      }
    } else {
      await db.run('DELETE FROM payments WHERE id = ?', [id])
    }

    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
    }

    logger.success(`Transacción eliminada: ${id}`)

    res.json({
      success: true,
      message: 'Transacción eliminada correctamente'
    })

  } catch (error) {
    logger.error(`Error eliminando transacción: ${error.message}`)
    res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Error eliminando transacción'
    })
  }
}

/**
 * Marca un pago local como reembolsado. HighLevel no expone refund por API aquí,
 * así que los invoices remotos deben reembolsarse en HighLevel y sincronizarse.
 */
export const refundTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Reembolsando transacción: ${id}`)

    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    const currentStatus = normalizeStatus(transaction.status)

    if (currentStatus === 'refunded') {
      return res.json({
        success: true,
        message: 'El pago ya estaba reembolsado'
      })
    }

    if (transaction.ghl_invoice_id) {
      return res.status(422).json({
        success: false,
        error: 'Este pago viene de HighLevel. Haz el reembolso en HighLevel; Ristak lo actualizará por webhook o sincronización.'
      })
    }

    if (!SUCCESS_PAYMENT_STATUSES.has(currentStatus)) {
      return res.status(400).json({
        success: false,
        error: 'Solo se pueden reembolsar pagos completados'
      })
    }

    await db.run(
      'UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['refunded', id]
    )
    dispatchProductPostWebhooksForPaymentInBackground(id, {
      status: 'refunded',
      previousStatus: transaction.status || ''
    })
    const notificationPayment = await getTransactionByIdForResponse(id, getRequestBaseUrl(req)) || transaction
    sendPaymentNotification({ ...notificationPayment, status: 'refunded', previousStatus: transaction.status || '' }).catch((pushError) => {
      logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
    })

    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
      import('../services/automationEngine.js')
        .then(engine => engine.handleAutomationEvent('refund', buildTransactionAutomationPayload(transaction, req, {
          paymentId: transaction.id || id,
          status: 'refunded',
          paymentStatus: 'refunded'
        })))
        .catch(() => {})
    }

    logger.success(`Transacción reembolsada: ${id}`)

    res.json({
      success: true,
      message: 'Pago reembolsado correctamente'
    })
  } catch (error) {
    logger.error(`Error reembolsando transacción: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error reembolsando pago'
    })
  }
}

/**
 * Anula un pago/invoice en HighLevel
 */
export const voidTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Anulando transacción: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    if (getTransferProofReviewState(transaction).valid) {
      return res.status(409).json({
        success: false,
        error: 'Este comprobante usa un flujo de revisión protegido. Usa Aprobar o Rechazar; no se puede anular como un pago normal.'
      })
    }

    const deletionGuard = await getPaymentDeletionGuard(transaction)
    if (deletionGuard.hasPlanLink || deletionGuard.hasSubscriptionLink) {
      return sendPaymentDeletionGuardError(res, deletionGuard)
    }

    if (isSuccessfulPaymentStatus(transaction.status)) {
      return res.status(422).json({
        success: false,
        error: 'Este pago ya está completado. No se puede anular; registra un reembolso para conservar el historial.'
      })
    }

    // Anular en HighLevel si tiene invoice asociado
    if (transaction.ghl_invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.voidInvoice(transaction.ghl_invoice_id)
    }

    // Actualizar estado en BD
    await db.run('UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['void', id])
    dispatchProductPostWebhooksForPaymentInBackground(id, {
      status: 'void',
      previousStatus: transaction.status || ''
    })
    const notificationPayment = await getTransactionByIdForResponse(id, getRequestBaseUrl(req)) || transaction
    sendPaymentNotification({ ...notificationPayment, status: 'void', previousStatus: transaction.status || '' }).catch((pushError) => {
      logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
    })
    if (isStripeBackedTransaction(transaction)) {
      await syncStripePaymentPlanFromLocalPayment(id)
    }
    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
      import('../services/automationEngine.js')
        .then(engine => engine.handleAutomationEvent('payment-received', buildTransactionAutomationPayload(transaction, req, {
          paymentId: transaction.id || id,
          status: 'void',
          paymentStatus: 'void'
        })))
        .catch(() => {})
    }

    logger.success(`Transacción anulada: ${id}`)

    res.json({
      success: true,
      message: 'Pago anulado correctamente'
    })

  } catch (error) {
    logger.error(`Error anulando transacción: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error anulando pago'
    })
  }
}

function getTransferProofReviewState(transaction = {}) {
  const metadata = parseJson(transaction.metadata_json, {})
  const valid = Boolean(
    cleanString(metadata.source) === TRANSFER_PROOF_PENDING_SOURCE &&
    metadata.requiresHumanVerification === true &&
    cleanString(transaction.payment_method).toLowerCase() === 'bank_transfer' &&
    cleanString(transaction.payment_provider).toLowerCase() === 'manual'
  )
  return {
    valid,
    metadata,
    decision: cleanString(metadata.reviewDecision).toLowerCase()
  }
}

function getPaymentReviewerId(req = {}) {
  return cleanString(req.user?.id || req.user?.userId || req.userId || req.auth?.userId) || 'authenticated_user'
}

/**
 * Aprueba un comprobante v2 con un contrato separado del editor genérico.
 * Monto, moneda, contacto y ambiente salen del registro pendiente; el cliente
 * HTTP no puede sustituirlos.
 */
export const approveTransferProof = async (req, res) => {
  const { id } = req.params
  try {
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])
    if (!transaction) return res.status(404).json({ success: false, error: 'Comprobante no encontrado' })

    const review = getTransferProofReviewState(transaction)
    if (!review.valid) {
      return res.status(422).json({ success: false, error: 'Este pago no es un comprobante de transferencia revisable.' })
    }
    if (review.decision === 'rejected' || normalizeStatus(transaction.status) === 'rejected') {
      return res.status(409).json({ success: false, error: 'Este comprobante ya fue rechazado y no se puede aprobar.' })
    }

    const alreadyApproved = review.decision === 'approved' && normalizeStatus(transaction.status) === 'paid'
    const reviewedAt = cleanString(review.metadata.reviewedAt) || new Date().toISOString()
    if (!alreadyApproved) {
      if (normalizeStatus(transaction.status) !== 'pending_review' || cleanString(transaction.payment_mode) !== 'manual_review') {
        return res.status(409).json({ success: false, error: 'El comprobante ya no está pendiente de revisión.' })
      }
      const nextMetadata = {
        ...review.metadata,
        reviewDecision: 'approved',
        reviewedAt,
        reviewedBy: getPaymentReviewerId(req),
        reviewReason: null
      }
      const reference = cleanString(req.body?.reference)
      const update = await db.run(
        `UPDATE payments
         SET status = 'paid', payment_mode = 'live', paid_at = ?, date = ?,
             reference = COALESCE(NULLIF(?, ''), reference), metadata_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending_review' AND payment_mode = 'manual_review'`,
        [reviewedAt, reviewedAt, reference, JSON.stringify(nextMetadata), id]
      )
      if (Number(update?.changes ?? update?.rowCount) !== 1) {
        return res.status(409).json({ success: false, error: 'Otro proceso ya decidió este comprobante.' })
      }
    }

    const approved = await db.get('SELECT * FROM payments WHERE id = ?', [id])
    await updateSingleContactStats(approved.contact_id).catch(() => {})
    if (!alreadyApproved) {
      await triggerMetaPaymentPurchaseEvent(approved.contact_id, {
        id: approved.id,
        amount: approved.amount,
        currency: approved.currency,
        paymentMode: approved.payment_mode
      }).catch(() => {})
      dispatchProductPostWebhooksForPaymentInBackground(id, {
        status: 'paid',
        previousStatus: 'pending_review'
      })
      const notificationPayment = await getTransactionByIdForResponse(id, getRequestBaseUrl(req)).catch(() => null)
      if (notificationPayment) {
        sendPaymentNotification({ ...notificationPayment, status: 'paid', previousStatus: 'pending_review' }).catch(() => {})
      }
    }

    let conversationResume = null
    let conversationResumePending = false
    try {
      conversationResume = await completeConversationalAgentSalePaymentFromInvoice({
        contactId: approved.contact_id,
        paymentId: approved.id,
        invoiceId: approved.ghl_invoice_id || '',
        amount: approved.amount,
        currency: approved.currency,
        status: 'paid',
        paymentMode: approved.payment_mode,
        reference: approved.reference || ''
      })
      const manualReviewResolved = conversationResume?.manualReviewRequired === true || conversationResume?.needsNewSlot === true
      conversationResumePending = !manualReviewResolved && Boolean(conversationResume?.processing || (
        conversationResume?.matched && !conversationResume?.resumed && !conversationResume?.alreadyCompleted &&
        conversationResume?.signal !== 'purchase_completed'
      ))
    } catch (error) {
      conversationResumePending = true
      logger.warn(`Pago ${id} aprobado; la reanudación conversacional quedó pendiente: ${error.message}`)
    }

    const mapped = await getTransactionByIdForResponse(id, getRequestBaseUrl(req))
    return res.json({
      success: true,
      data: mapped,
      alreadyApproved,
      conversationResume,
      conversationResumePending
    })
  } catch (error) {
    logger.error(`Error aprobando comprobante ${id}: ${error.message}`)
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'No se pudo aprobar el comprobante' })
  }
}

export const rejectTransferProof = async (req, res) => {
  const { id } = req.params
  try {
    const reason = cleanString(req.body?.reason).slice(0, 500)
    if (!reason) return res.status(400).json({ success: false, error: 'Explica por qué se rechaza el comprobante.' })
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])
    if (!transaction) return res.status(404).json({ success: false, error: 'Comprobante no encontrado' })

    const review = getTransferProofReviewState(transaction)
    if (!review.valid) {
      return res.status(422).json({ success: false, error: 'Este pago no es un comprobante de transferencia revisable.' })
    }
    if (review.decision === 'approved' || normalizeStatus(transaction.status) === 'paid') {
      return res.status(409).json({ success: false, error: 'Este comprobante ya fue aprobado y no se puede rechazar.' })
    }
    if (review.decision === 'rejected' && normalizeStatus(transaction.status) === 'rejected') {
      return res.json({
        success: true,
        data: await getTransactionByIdForResponse(id, getRequestBaseUrl(req)),
        alreadyRejected: true
      })
    }
    if (normalizeStatus(transaction.status) !== 'pending_review' || cleanString(transaction.payment_mode) !== 'manual_review') {
      return res.status(409).json({ success: false, error: 'El comprobante ya no está pendiente de revisión.' })
    }

    const reviewedAt = new Date().toISOString()
    const nextMetadata = {
      ...review.metadata,
      reviewDecision: 'rejected',
      reviewReason: reason,
      reviewedAt,
      reviewedBy: getPaymentReviewerId(req)
    }
    const update = await db.run(
      `UPDATE payments
       SET status = 'rejected', paid_at = NULL, metadata_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending_review' AND payment_mode = 'manual_review'`,
      [JSON.stringify(nextMetadata), id]
    )
    if (Number(update?.changes ?? update?.rowCount) !== 1) {
      return res.status(409).json({ success: false, error: 'Otro proceso ya decidió este comprobante.' })
    }
    dispatchProductPostWebhooksForPaymentInBackground(id, {
      status: 'rejected',
      previousStatus: 'pending_review'
    })
    const mapped = await getTransactionByIdForResponse(id, getRequestBaseUrl(req))
    sendPaymentNotification({ ...mapped, status: 'rejected', previousStatus: 'pending_review' }).catch(() => {})
    return res.json({ success: true, data: mapped, alreadyRejected: false })
  } catch (error) {
    logger.error(`Error rechazando comprobante ${id}: ${error.message}`)
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || 'No se pudo rechazar el comprobante' })
  }
}

/**
 * Registra un pago manual/marca como pagado
 */
export const recordPayment = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, paymentDate, paymentMethod } = req.body

    logger.info(`Registrando pago manual para transacción: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }


    if (getTransferProofReviewState(transaction).valid) {
      return res.status(409).json({
        success: false,
        error: 'Este comprobante requiere una decisión explícita. Usa Aprobar comprobante; record-payment no puede saltarse la revisión.'
      })
    }

    if (isStripePlanAuthorizationTransaction(transaction)) {
      return sendStripePlanAuthorizationManualPaymentError(res)
    }

    // Timestamp completo del pago: si el usuario eligió fecha la respetamos
    // (hoy -> hora exacta; otra fecha -> ese día); si no, el momento actual.
    const resolvedPaymentDate = paymentDate
      ? resolvePaymentTimestamp(paymentDate, await getAccountTimezone().catch(() => DEFAULT_TIMEZONE))
      : (transaction.date || new Date().toISOString())

    // Marcar como pagado en HighLevel si tiene invoice asociado. Para pagos locales
    // sin invoice, conserva el modo del pago en vez de heredar el modo global de GHL.
    const hasHighLevelInvoice = Boolean(cleanString(transaction.ghl_invoice_id))
    const liveMode = hasHighLevelInvoice
      ? await getGhlInvoiceLiveMode()
      : normalizePaymentMode(transaction.payment_mode) === 'live'
    const paymentMode = hasHighLevelInvoice
      ? (liveMode ? 'live' : 'test')
      : normalizePaymentMode(transaction.payment_mode)

    if (hasHighLevelInvoice) {
      const ghlClient = await getGHLClient()
      await ghlClient.recordPayment(transaction.ghl_invoice_id, {
        amount: amount || transaction.amount,
        currency: transaction.currency || 'MXN',
        fulfilledAt: resolvedPaymentDate,
        mode: paymentMethod || 'cash',
        note: paymentMode === 'test' ? 'Pago registrado manualmente\nModo: prueba' : 'Pago registrado manualmente',
        liveMode
      })
    }

    // Actualizar estado en BD
    await db.run(
      'UPDATE payments SET status = ?, amount = ?, payment_method = ?, payment_mode = ?, date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['paid', amount || transaction.amount, paymentMethod || transaction.payment_method, paymentMode, resolvedPaymentDate, id]
    )
    if (isStripeBackedTransaction(transaction)) {
      await syncStripePaymentPlanFromLocalPayment(id)
    }
    if (transaction.contact_id) {
      await updateSingleContactStats(transaction.contact_id)
      await triggerMetaPaymentPurchaseEvent(transaction.contact_id, {
        id,
        amount: amount || transaction.amount,
        currency: transaction.currency || 'MXN',
        paymentMode
      })
    }

    if (!transaction.ghl_invoice_id && !isStripeBackedTransaction(transaction)) {
      try {
        const localExport = await syncLocalPaymentsToHighLevel({ paymentId: id, limit: 1 })
        if (localExport.exported > 0) {
          logger.success(`Pago registrado y exportado a HighLevel: ${id}`)
        }
      } catch (syncError) {
        logger.warn(`Pago ${id} registrado localmente; no se pudo exportar a HighLevel: ${syncError.message}`)
      }
    }

    const paidTransaction = await getTransactionByIdForResponse(id, getRequestBaseUrl(req))
    if (paidTransaction) {
      dispatchProductPostWebhooksForPaymentInBackground(id, {
        status: 'paid',
        previousStatus: transaction.status || ''
      })
      registerGigstackPaymentForTransactionInBackground(id)
      queuePaymentAutomationMessage('receipt', id)
      sendPaymentNotification(paidTransaction).catch((pushError) => {
        logger.warn(`No se pudo enviar aviso de pago ${id}: ${pushError.message}`)
      })
    }

    if (transaction.contact_id) {
      await completeConversationalAgentSalePaymentFromInvoice({
        contactId: transaction.contact_id,
        invoiceId: transaction.ghl_invoice_id || '',
        paymentId: id,
        amount: amount || transaction.amount,
        currency: transaction.currency,
        status: 'paid',
        paymentMode,
        reference: transaction.reference || ''
      }).catch((error) => {
        logger.warn(`Pago ${id} registrado; la reconciliación conversacional no se completó: ${error.message}`)
      })
    }

    logger.success(`Pago registrado para transacción: ${id}`)

    res.json({
      success: true,
      message: 'Pago registrado correctamente'
    })

  } catch (error) {
    logger.error(`Error registrando pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error registrando pago'
    })
  }
}

/**
 * Envía un pago al cliente (email/SMS)
 */
export const sendTransaction = async (req, res) => {
  try {
    const { id } = req.params

    logger.info(`Enviando pago: ${id}`)

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    // Enviar en HighLevel si tiene invoice asociado
    if (transaction.ghl_invoice_id) {
      const ghlClient = await getGHLClient()
      await ghlClient.sendInvoice(transaction.ghl_invoice_id, {
        liveMode: await getGhlInvoiceLiveMode()
      })
    } else {
      throw new Error('No se puede enviar: el pago no tiene invoice asociado')
    }

    logger.success(`Pago enviado: ${id}`)

    res.json({
      success: true,
      message: 'Pago enviado correctamente'
    })

  } catch (error) {
    logger.error(`Error enviando pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: error.message || 'Error enviando pago'
    })
  }
}

/**
 * Obtiene el enlace de pago
 */
export const getPaymentLink = async (req, res) => {
  try {
    const { id } = req.params

    // Obtener la transacción
    const transaction = await db.get('SELECT * FROM payments WHERE id = ?', [id])

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transacción no encontrada'
      })
    }

    const localLink = resolveTransactionPaymentUrl(transaction, getRequestBaseUrl(req))

    if (localLink) {
      return res.json({
        success: true,
        data: {
          link: localLink
        }
      })
    }

    if (!transaction.ghl_invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'El pago no tiene enlace asociado'
      })
    }

    // Obtener configuración para el domain
    const config = await getHighLevelConfig()
    const ghlClient = await getGHLClient()
    const link = await ghlClient.getInvoicePaymentLink(transaction.ghl_invoice_id, config.domain)

    res.json({
      success: true,
      data: {
        link
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo enlace de pago: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo enlace'
    })
  }
}
