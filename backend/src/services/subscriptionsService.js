import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  cancelStripeRecurringSubscription,
  createStripeRecurringSubscription,
  pauseStripeRecurringSubscription,
  resumeStripeRecurringSubscription,
  syncStripeSubscriptionInvoicePayment,
  updateStripeRecurringSubscription
} from './stripePaymentService.js'
import {
  cancelMercadoPagoRecurringSubscription,
  createMercadoPagoRecurringSubscription,
  pauseMercadoPagoRecurringSubscription,
  resumeMercadoPagoRecurringSubscription,
  updateMercadoPagoRecurringSubscription
} from './mercadoPagoPaymentService.js'
import {
  cancelConektaRecurringSubscription,
  createConektaRecurringSubscription,
  pauseConektaRecurringSubscription,
  resumeConektaRecurringSubscription,
  updateConektaRecurringSubscription
} from './conektaPaymentService.js'
import { getSubscriptionAuditSummary } from './paymentRecordSafetyService.js'
import { getAccountCurrency } from '../utils/accountLocale.js'

const SUBSCRIPTION_PREFIX = 'rstk_sub'
const DEFAULT_CURRENCY = 'MXN'
const DEFAULT_INTERVAL = 'monthly'
const DEFAULT_STATUS = 'active'

const ACTIVE_STATUSES = new Set(['active', 'trialing'])
const PAUSED_STATUSES = new Set(['paused'])
const PAST_DUE_STATUSES = new Set(['past_due', 'incomplete'])

function makeId() {
  return `${SUBSCRIPTION_PREFIX}_${crypto.randomUUID()}`
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function normalizeAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100) / 100
}

function normalizeCurrency(value) {
  return cleanString(value || DEFAULT_CURRENCY).toUpperCase() || DEFAULT_CURRENCY
}

async function getDefaultSubscriptionCurrency() {
  try {
    return normalizeCurrency(await getAccountCurrency())
  } catch {
    return DEFAULT_CURRENCY
  }
}

function normalizeInterval(value) {
  const normalized = cleanString(value || DEFAULT_INTERVAL).toLowerCase()
  if (['daily', 'weekly', 'monthly', 'yearly'].includes(normalized)) return normalized
  return DEFAULT_INTERVAL
}

function normalizeIntervalCount(value) {
  const count = Number.parseInt(value, 10)
  return Number.isFinite(count) && count > 0 ? count : 1
}

function normalizeStatus(value) {
  const normalized = cleanString(value || DEFAULT_STATUS).toLowerCase()
  if (['draft', 'active', 'trialing', 'past_due', 'paused', 'cancelled', 'incomplete'].includes(normalized)) {
    return normalized
  }
  return DEFAULT_STATUS
}

function nullableString(value) {
  const cleaned = cleanString(value)
  return cleaned || null
}

function nullableDate(value) {
  if (value === undefined || value === null || value === '') return null

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    const milliseconds = value > 9999999999 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const cleaned = cleanString(value)
  if (!cleaned) return null

  const date = new Date(cleaned)
  if (!Number.isNaN(date.getTime())) return date.toISOString()

  return cleaned
}

function parseJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function addMonths(date, months) {
  const next = new Date(date)
  const originalDay = next.getDate()
  next.setMonth(next.getMonth() + months)
  if (next.getDate() !== originalDay) next.setDate(0)
  return next
}

function addInterval(date, intervalType, intervalCount) {
  const next = new Date(date)
  const count = normalizeIntervalCount(intervalCount)

  if (intervalType === 'daily') {
    next.setDate(next.getDate() + count)
    return next
  }

  if (intervalType === 'weekly') {
    next.setDate(next.getDate() + (7 * count))
    return next
  }

  if (intervalType === 'yearly') {
    return addMonths(next, 12 * count)
  }

  return addMonths(next, count)
}

function defaultNextRunAt({ startDate, nextRunAt, intervalType, intervalCount }) {
  if (nextRunAt) return nextRunAt
  const start = startDate ? new Date(startDate) : new Date()
  if (Number.isNaN(start.getTime())) return new Date().toISOString()

  const now = new Date()
  if (start > now) return start.toISOString()
  return addInterval(start, intervalType, intervalCount).toISOString()
}

function calculateMrr(row) {
  const amount = normalizeAmount(row.amount)
  const count = normalizeIntervalCount(row.interval_count)
  const interval = normalizeInterval(row.interval_type)

  if (interval === 'daily') return amount * (365 / 12) / count
  if (interval === 'weekly') return amount * (52 / 12) / count
  if (interval === 'yearly') return amount / (12 * count)
  return amount / count
}

function getContactName(row = {}) {
  const contact = row || {}
  const joined = [contact.first_name, contact.last_name].map(cleanString).filter(Boolean).join(' ')
  return cleanString(contact.full_name || contact.name || joined)
}

async function getContactSnapshot(contactId) {
  const cleanContactId = nullableString(contactId)
  if (!cleanContactId) return null

  return db.get(
    `SELECT id, full_name, first_name, last_name, email, phone
     FROM contacts
     WHERE id = ?
     LIMIT 1`,
    [cleanContactId]
  )
}

function rowToApi(row = {}) {
  const metadata = parseJson(row.metadata_json, null)
  const raw = parseJson(row.raw_json, null)

  return {
    id: row.id,
    contactId: row.contact_id || null,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || '',
    name: row.name || 'Suscripción',
    description: row.description || '',
    status: row.status || DEFAULT_STATUS,
    amount: normalizeAmount(row.amount),
    currency: row.currency || DEFAULT_CURRENCY,
    intervalType: row.interval_type || DEFAULT_INTERVAL,
    intervalCount: normalizeIntervalCount(row.interval_count),
    startDate: row.start_date || null,
    nextRunAt: row.next_run_at || null,
    currentPeriodStart: row.current_period_start || null,
    currentPeriodEnd: row.current_period_end || null,
    cancelAt: row.cancel_at || null,
    cancelledAt: row.cancelled_at || null,
    paymentMethod: row.payment_method || 'stripe_saved_card',
    paymentProvider: row.payment_provider || 'stripe',
    paymentMode: row.payment_mode || 'test',
    source: row.source || 'ristak',
    stripeCustomerId: row.stripe_customer_id || null,
    stripeSubscriptionId: row.stripe_subscription_id || null,
    stripeProductId: row.stripe_product_id || null,
    stripePriceId: row.stripe_price_id || null,
    stripePaymentMethodId: row.stripe_payment_method_id || null,
    mercadoPagoPreapprovalId: row.mercadopago_preapproval_id || null,
    mercadoPagoPreapprovalPlanId: row.mercadopago_preapproval_plan_id || null,
    mercadoPagoInitPoint: row.mercadopago_init_point || null,
    mercadoPagoSandboxInitPoint: row.mercadopago_sandbox_init_point || null,
    mercadoPagoPayerId: row.mercadopago_payer_id || null,
    mercadoPagoCardId: row.mercadopago_card_id || null,
    mercadoPagoPaymentMethodId: row.mercadopago_payment_method_id || null,
    mercadoPagoNextPaymentDate: row.mercadopago_next_payment_date || null,
    conektaCustomerId: row.conekta_customer_id || null,
    conektaPlanId: row.conekta_plan_id || null,
    conektaSubscriptionId: row.conekta_subscription_id || null,
    conektaPaymentSourceId: row.conekta_payment_source_id || null,
    conektaNextBillingAt: row.conekta_next_billing_at || null,
    metadata,
    raw,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function buildSummary(rows = []) {
  const visibleRows = rows.filter((row) => row.status !== 'deleted')
  const activeRows = visibleRows.filter((row) => ACTIVE_STATUSES.has(row.status))
  const pausedRows = visibleRows.filter((row) => PAUSED_STATUSES.has(row.status))
  const pastDueRows = visibleRows.filter((row) => PAST_DUE_STATUSES.has(row.status))
  const monthlyRevenue = activeRows.reduce((sum, row) => sum + calculateMrr(row), 0)
  const nextRow = visibleRows
    .filter((row) => row.next_run_at && !['cancelled', 'paused'].includes(row.status))
    .sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())[0]

  return {
    total: visibleRows.length,
    active: activeRows.length,
    paused: pausedRows.length,
    pastDue: pastDueRows.length,
    monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
    nextRunAt: nextRow?.next_run_at || null
  }
}

async function buildSubscriptionRow(payload = {}, existing = {}) {
  const contactId = nullableString(payload.contactId ?? payload.contact_id ?? existing.contact_id)
  const contact = await getContactSnapshot(contactId)
  const accountCurrency = await getDefaultSubscriptionCurrency()
  const intervalType = normalizeInterval(payload.intervalType ?? payload.interval_type ?? existing.interval_type)
  const intervalCount = normalizeIntervalCount(payload.intervalCount ?? payload.interval_count ?? existing.interval_count)
  const startDate = nullableDate(payload.startDate ?? payload.start_date ?? existing.start_date) || new Date().toISOString()
  const nextRunAt = nullableDate(payload.nextRunAt ?? payload.next_run_at ?? existing.next_run_at)

  return {
    id: nullableString(existing.id) || nullableString(payload.id) || makeId(),
    contact_id: contactId,
    contact_name: nullableString(payload.contactName ?? payload.contact_name) || getContactName(contact) || nullableString(existing.contact_name),
    contact_email: nullableString(payload.contactEmail ?? payload.contact_email) || nullableString(contact?.email) || nullableString(existing.contact_email),
    contact_phone: nullableString(payload.contactPhone ?? payload.contact_phone) || nullableString(contact?.phone) || nullableString(existing.contact_phone),
    name: cleanString(payload.name ?? existing.name) || 'Suscripción',
    description: cleanString(payload.description ?? existing.description),
    status: normalizeStatus(payload.status ?? existing.status),
    amount: normalizeAmount(payload.amount ?? existing.amount),
    currency: accountCurrency,
    interval_type: intervalType,
    interval_count: intervalCount,
    start_date: startDate,
    next_run_at: defaultNextRunAt({
      startDate,
      nextRunAt,
      intervalType,
      intervalCount
    }),
    current_period_start: nullableDate(payload.currentPeriodStart ?? payload.current_period_start ?? existing.current_period_start),
    current_period_end: nullableDate(payload.currentPeriodEnd ?? payload.current_period_end ?? existing.current_period_end),
    cancel_at: nullableDate(payload.cancelAt ?? payload.cancel_at ?? existing.cancel_at),
    cancelled_at: nullableDate(payload.cancelledAt ?? payload.cancelled_at ?? existing.cancelled_at),
    payment_method: cleanString(payload.paymentMethod ?? payload.payment_method ?? existing.payment_method) || 'stripe_saved_card',
    payment_provider: cleanString(payload.paymentProvider ?? payload.payment_provider ?? existing.payment_provider) || 'stripe',
    payment_mode: cleanString(payload.paymentMode ?? payload.payment_mode ?? existing.payment_mode) || 'test',
    source: cleanString(payload.source ?? existing.source) || 'ristak',
    stripe_customer_id: nullableString(payload.stripeCustomerId ?? payload.stripe_customer_id ?? existing.stripe_customer_id),
    stripe_subscription_id: nullableString(payload.stripeSubscriptionId ?? payload.stripe_subscription_id ?? existing.stripe_subscription_id),
    stripe_product_id: nullableString(payload.stripeProductId ?? payload.stripe_product_id ?? existing.stripe_product_id),
    stripe_price_id: nullableString(payload.stripePriceId ?? payload.stripe_price_id ?? existing.stripe_price_id),
    stripe_payment_method_id: nullableString(payload.stripePaymentMethodId ?? payload.stripe_payment_method_id ?? existing.stripe_payment_method_id),
    mercadopago_preapproval_id: nullableString(payload.mercadoPagoPreapprovalId ?? payload.mercadopago_preapproval_id ?? existing.mercadopago_preapproval_id),
    mercadopago_preapproval_plan_id: nullableString(payload.mercadoPagoPreapprovalPlanId ?? payload.mercadopago_preapproval_plan_id ?? existing.mercadopago_preapproval_plan_id),
    mercadopago_init_point: nullableString(payload.mercadoPagoInitPoint ?? payload.mercadopago_init_point ?? existing.mercadopago_init_point),
    mercadopago_sandbox_init_point: nullableString(payload.mercadoPagoSandboxInitPoint ?? payload.mercadopago_sandbox_init_point ?? existing.mercadopago_sandbox_init_point),
    mercadopago_payer_id: nullableString(payload.mercadoPagoPayerId ?? payload.mercadopago_payer_id ?? existing.mercadopago_payer_id),
    mercadopago_card_id: nullableString(payload.mercadoPagoCardId ?? payload.mercadopago_card_id ?? existing.mercadopago_card_id),
    mercadopago_payment_method_id: nullableString(payload.mercadoPagoPaymentMethodId ?? payload.mercadopago_payment_method_id ?? existing.mercadopago_payment_method_id),
    mercadopago_next_payment_date: nullableDate(payload.mercadoPagoNextPaymentDate ?? payload.mercadopago_next_payment_date ?? existing.mercadopago_next_payment_date),
    conekta_customer_id: nullableString(payload.conektaCustomerId ?? payload.conekta_customer_id ?? existing.conekta_customer_id),
    conekta_plan_id: nullableString(payload.conektaPlanId ?? payload.conekta_plan_id ?? existing.conekta_plan_id),
    conekta_subscription_id: nullableString(payload.conektaSubscriptionId ?? payload.conekta_subscription_id ?? existing.conekta_subscription_id),
    conekta_payment_source_id: nullableString(payload.conektaPaymentSourceId ?? payload.conekta_payment_source_id ?? payload.paymentMethodId ?? existing.conekta_payment_source_id),
    conekta_next_billing_at: nullableDate(payload.conektaNextBillingAt ?? payload.conekta_next_billing_at ?? existing.conekta_next_billing_at),
    metadata_json: jsonOrNull(payload.metadata ?? payload.metadata_json ?? existing.metadata_json),
    raw_json: jsonOrNull(payload.raw ?? payload.raw_json ?? existing.raw_json)
  }
}

async function attachStripeSubscriptionIfNeeded(row, payload = {}) {
  if (row.stripe_subscription_id) return row
  if (row.payment_provider !== 'stripe' || row.payment_method !== 'stripe_saved_card') return row

  const stripeSubscription = await createStripeRecurringSubscription({
    ristakSubscriptionId: row.id,
    contactId: row.contact_id,
    name: row.name,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    intervalType: row.interval_type,
    intervalCount: row.interval_count,
    startDate: row.start_date,
    paymentMethodId: row.stripe_payment_method_id || payload.paymentMethodId || payload.stripePaymentMethodId,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone
  })

  return {
    ...row,
    status: stripeSubscription.status || row.status,
    stripe_customer_id: stripeSubscription.stripeCustomerId || row.stripe_customer_id,
    stripe_subscription_id: stripeSubscription.stripeSubscriptionId || row.stripe_subscription_id,
    stripe_product_id: stripeSubscription.stripeProductId || row.stripe_product_id,
    stripe_price_id: stripeSubscription.stripePriceId || row.stripe_price_id,
    stripe_payment_method_id: stripeSubscription.stripePaymentMethodId || row.stripe_payment_method_id,
    payment_mode: stripeSubscription.paymentMode || row.payment_mode,
    current_period_start: stripeSubscription.currentPeriodStart || row.current_period_start,
    current_period_end: stripeSubscription.currentPeriodEnd || row.current_period_end,
    next_run_at: stripeSubscription.nextRunAt || row.next_run_at,
    stripe_initial_invoice: stripeSubscription.initialInvoice || null
  }
}

function mergeRawJson(currentRaw, providerKey, value) {
  const current = parseJson(currentRaw, {})
  return jsonOrNull({
    ...current,
    [providerKey]: value
  })
}

function applyMercadoPagoSubscriptionToRow(row, mercadoPagoSubscription) {
  if (!mercadoPagoSubscription) return row

  return {
    ...row,
    status: mercadoPagoSubscription.status || row.status,
    payment_method: 'mercadopago_subscription',
    payment_provider: 'mercadopago',
    payment_mode: mercadoPagoSubscription.paymentMode || row.payment_mode,
    mercadopago_preapproval_id: mercadoPagoSubscription.mercadoPagoPreapprovalId || row.mercadopago_preapproval_id,
    mercadopago_preapproval_plan_id: mercadoPagoSubscription.mercadoPagoPreapprovalPlanId || row.mercadopago_preapproval_plan_id,
    mercadopago_init_point: mercadoPagoSubscription.mercadoPagoInitPoint || row.mercadopago_init_point,
    mercadopago_sandbox_init_point: mercadoPagoSubscription.mercadoPagoSandboxInitPoint || row.mercadopago_sandbox_init_point,
    mercadopago_payer_id: mercadoPagoSubscription.mercadoPagoPayerId || row.mercadopago_payer_id,
    mercadopago_card_id: mercadoPagoSubscription.mercadoPagoCardId || row.mercadopago_card_id,
    mercadopago_payment_method_id: mercadoPagoSubscription.mercadoPagoPaymentMethodId || row.mercadopago_payment_method_id,
    mercadopago_next_payment_date: mercadoPagoSubscription.mercadoPagoNextPaymentDate || row.mercadopago_next_payment_date,
    next_run_at: mercadoPagoSubscription.nextRunAt || row.next_run_at,
    current_period_end: mercadoPagoSubscription.currentPeriodEnd || row.current_period_end,
    raw_json: mergeRawJson(row.raw_json, 'mercadoPago', mercadoPagoSubscription.raw)
  }
}

async function attachMercadoPagoSubscriptionIfNeeded(row) {
  if (row.mercadopago_preapproval_id) return row
  if (row.payment_provider !== 'mercadopago') return row

  if (!row.contact_email) {
    const error = new Error('Mercado Pago necesita el email del contacto para enviar la autorización de suscripción.')
    error.status = 422
    throw error
  }

  const mercadoPagoSubscription = await createMercadoPagoRecurringSubscription({
    ristakSubscriptionId: row.id,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    intervalType: row.interval_type,
    intervalCount: row.interval_count,
    startDate: row.start_date,
    cancelAt: row.cancel_at,
    contactEmail: row.contact_email
  })

  return applyMercadoPagoSubscriptionToRow(row, mercadoPagoSubscription)
}

function applyConektaSubscriptionToRow(row, conektaSubscription) {
  if (!conektaSubscription) return row

  return {
    ...row,
    status: conektaSubscription.status || row.status,
    payment_method: 'conekta_subscription',
    payment_provider: 'conekta',
    payment_mode: conektaSubscription.paymentMode || row.payment_mode,
    conekta_customer_id: conektaSubscription.conektaCustomerId || row.conekta_customer_id,
    conekta_plan_id: conektaSubscription.conektaPlanId || row.conekta_plan_id,
    conekta_subscription_id: conektaSubscription.conektaSubscriptionId || row.conekta_subscription_id,
    conekta_payment_source_id: conektaSubscription.conektaPaymentSourceId || row.conekta_payment_source_id,
    conekta_next_billing_at: conektaSubscription.nextRunAt || row.conekta_next_billing_at,
    next_run_at: conektaSubscription.nextRunAt || row.next_run_at,
    current_period_start: conektaSubscription.currentPeriodStart || row.current_period_start,
    current_period_end: conektaSubscription.currentPeriodEnd || row.current_period_end,
    raw_json: mergeRawJson(row.raw_json, 'conekta', conektaSubscription.raw)
  }
}

async function attachConektaSubscriptionIfNeeded(row, payload = {}) {
  if (row.conekta_subscription_id) return row
  if (row.payment_provider !== 'conekta') return row

  const conektaSubscription = await createConektaRecurringSubscription({
    ristakSubscriptionId: row.id,
    contactId: row.contact_id,
    name: row.name,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    intervalType: row.interval_type,
    intervalCount: row.interval_count,
    startDate: row.start_date,
    paymentMethodId: row.conekta_payment_source_id || payload.paymentMethodId || payload.conektaPaymentSourceId,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone
  })

  return applyConektaSubscriptionToRow(row, conektaSubscription)
}

async function syncStripeSubscriptionUpdateIfNeeded(row, existing) {
  if (!existing.stripe_subscription_id) return row

  if (row.payment_provider !== 'stripe' || row.payment_method !== 'stripe_saved_card') {
    const error = new Error('Esta suscripción ya está activa en Stripe. Cancélala antes de cambiarla a un método manual.')
    error.status = 422
    throw error
  }

  const stripeSubscription = await updateStripeRecurringSubscription({
    ristakSubscriptionId: row.id,
    stripeSubscriptionId: existing.stripe_subscription_id,
    contactId: row.contact_id,
    name: row.name,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    intervalType: row.interval_type,
    intervalCount: row.interval_count
  })

  return {
    ...row,
    status: stripeSubscription.status || row.status,
    stripe_subscription_id: stripeSubscription.stripeSubscriptionId || row.stripe_subscription_id,
    stripe_product_id: stripeSubscription.stripeProductId || row.stripe_product_id,
    stripe_price_id: stripeSubscription.stripePriceId || row.stripe_price_id,
    payment_mode: stripeSubscription.paymentMode || row.payment_mode,
    current_period_start: stripeSubscription.currentPeriodStart || row.current_period_start,
    current_period_end: stripeSubscription.currentPeriodEnd || row.current_period_end,
    next_run_at: stripeSubscription.nextRunAt || row.next_run_at
  }
}

async function syncMercadoPagoSubscriptionUpdateIfNeeded(row, existing = {}) {
  if (!existing.mercadopago_preapproval_id) return attachMercadoPagoSubscriptionIfNeeded(row)

  if (row.payment_provider !== 'mercadopago') {
    const error = new Error('Esta suscripción ya está activa en Mercado Pago. Cancélala antes de cambiarla a otro método.')
    error.status = 422
    throw error
  }

  const mercadoPagoSubscription = await updateMercadoPagoRecurringSubscription({
    ristakSubscriptionId: row.id,
    mercadoPagoPreapprovalId: existing.mercadopago_preapproval_id,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    cancelAt: row.cancel_at,
    nextRunAt: row.next_run_at
  })

  return applyMercadoPagoSubscriptionToRow(row, mercadoPagoSubscription)
}

async function syncConektaSubscriptionUpdateIfNeeded(row, existing = {}, payload = {}) {
  if (!existing.conekta_subscription_id) return attachConektaSubscriptionIfNeeded(row, payload)

  if (row.payment_provider !== 'conekta') {
    const error = new Error('Esta suscripción ya está activa en Conekta. Cancélala antes de cambiarla a otro método.')
    error.status = 422
    throw error
  }

  const conektaSubscription = await updateConektaRecurringSubscription({
    ristakSubscriptionId: row.id,
    conektaCustomerId: existing.conekta_customer_id,
    conektaSubscriptionId: existing.conekta_subscription_id,
    conektaPaymentSourceId: row.conekta_payment_source_id || existing.conekta_payment_source_id || payload.paymentMethodId,
    contactId: row.contact_id,
    name: row.name,
    description: row.description,
    amount: row.amount,
    currency: row.currency,
    intervalType: row.interval_type,
    intervalCount: row.interval_count
  })

  return applyConektaSubscriptionToRow(row, conektaSubscription)
}

export async function listSubscriptions({ status } = {}) {
  const cleanStatus = cleanString(status).toLowerCase()
  const params = []
  const where = ["COALESCE(status, '') <> 'deleted'"]

  if (cleanStatus && cleanStatus !== 'all') {
    where.push('status = ?')
    params.push(cleanStatus)
  }

  const rows = await db.all(
    `SELECT *
     FROM subscriptions
     WHERE ${where.join(' AND ')}
     ORDER BY
       CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END,
       next_run_at ASC,
       updated_at DESC`,
    params
  )

  return {
    subscriptions: rows.map(rowToApi),
    summary: buildSummary(rows)
  }
}

export async function getSubscription(subscriptionId) {
  const row = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ? AND COALESCE(status, '') <> 'deleted'
     LIMIT 1`,
    [subscriptionId]
  )

  return row ? rowToApi(row) : null
}

export async function createSubscription(payload = {}) {
  let row = await buildSubscriptionRow(payload)

  if (!row.name) throw new Error('El nombre de la suscripción es obligatorio.')
  if (!row.amount || row.amount <= 0) throw new Error('El monto de la suscripción debe ser mayor a cero.')
  row = await attachStripeSubscriptionIfNeeded(row, payload)
  row = await attachMercadoPagoSubscriptionIfNeeded(row, payload)
  row = await attachConektaSubscriptionIfNeeded(row, payload)

  // (PAY-003) El INSERT local va dentro de un try/catch: si falla DESPUÉS de haber
  // creado la suscripción en Stripe, cancelamos esa sub para no dejarla cobrando sin
  // registro local (suscripción huérfana). En createSubscription el row arranca vacío,
  // así que cualquier stripe_subscription_id presente se creó en ESTA llamada.
  try {
    await db.run(
    `INSERT INTO subscriptions (
      id, contact_id, contact_name, contact_email, contact_phone, name, description, status,
      amount, currency, interval_type, interval_count, start_date, next_run_at,
      current_period_start, current_period_end, cancel_at, cancelled_at,
      payment_method, payment_provider, payment_mode, source, stripe_customer_id, stripe_subscription_id,
      stripe_product_id, stripe_price_id, stripe_payment_method_id,
      mercadopago_preapproval_id, mercadopago_preapproval_plan_id, mercadopago_init_point,
      mercadopago_sandbox_init_point, mercadopago_payer_id, mercadopago_card_id,
      mercadopago_payment_method_id, mercadopago_next_payment_date,
      conekta_customer_id, conekta_plan_id, conekta_subscription_id,
      conekta_payment_source_id, conekta_next_billing_at, metadata_json, raw_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      row.id,
      row.contact_id,
      row.contact_name,
      row.contact_email,
      row.contact_phone,
      row.name,
      row.description,
      row.status,
      row.amount,
      row.currency,
      row.interval_type,
      row.interval_count,
      row.start_date,
      row.next_run_at,
      row.current_period_start,
      row.current_period_end,
      row.cancel_at,
      row.cancelled_at,
      row.payment_method,
      row.payment_provider,
      row.payment_mode,
      row.source,
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.stripe_product_id,
      row.stripe_price_id,
      row.stripe_payment_method_id,
      row.mercadopago_preapproval_id,
      row.mercadopago_preapproval_plan_id,
      row.mercadopago_init_point,
      row.mercadopago_sandbox_init_point,
      row.mercadopago_payer_id,
      row.mercadopago_card_id,
      row.mercadopago_payment_method_id,
      row.mercadopago_next_payment_date,
      row.conekta_customer_id,
      row.conekta_plan_id,
      row.conekta_subscription_id,
      row.conekta_payment_source_id,
      row.conekta_next_billing_at,
      row.metadata_json,
      row.raw_json
    ]
  )
  } catch (insertError) {
    // (PAY-003) Falló el registro local tras crear la suscripción remota: cancelamos
    // la suscripción de Stripe huérfana y propagamos el error original.
    if (row.stripe_subscription_id) {
      try {
        await cancelStripeRecurringSubscription(row.stripe_subscription_id)
        logger.error(`[Suscripciones] (PAY-003) INSERT local falló; se canceló la suscripción Stripe huérfana ${row.stripe_subscription_id}: ${insertError.message}`)
      } catch (cancelError) {
        logger.error(`[Suscripciones] (PAY-003) INSERT local falló y NO se pudo cancelar la suscripción Stripe ${row.stripe_subscription_id} (queda huérfana, revisar manualmente): ${cancelError.message}`)
      }
    }
    throw insertError
  }

  if (row.stripe_initial_invoice?.status === 'paid') {
    await syncStripeSubscriptionInvoicePayment(row.stripe_initial_invoice, 'paid')
  }

  return getSubscription(row.id)
}

export async function updateSubscription(subscriptionId, payload = {}) {
  const existing = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ? AND COALESCE(status, '') <> 'deleted'
     LIMIT 1`,
    [subscriptionId]
  )

  if (!existing) return null

  let row = await buildSubscriptionRow(payload, existing)

  if (!row.name) throw new Error('El nombre de la suscripción es obligatorio.')
  if (!row.amount || row.amount <= 0) throw new Error('El monto de la suscripción debe ser mayor a cero.')
  row = await syncStripeSubscriptionUpdateIfNeeded(row, existing)
  row = await syncMercadoPagoSubscriptionUpdateIfNeeded(row, existing)
  row = await syncConektaSubscriptionUpdateIfNeeded(row, existing, payload)

  await db.run(
    `UPDATE subscriptions
     SET contact_id = ?,
         contact_name = ?,
         contact_email = ?,
         contact_phone = ?,
         name = ?,
         description = ?,
         status = ?,
         amount = ?,
         currency = ?,
         interval_type = ?,
         interval_count = ?,
         start_date = ?,
         next_run_at = ?,
         current_period_start = ?,
         current_period_end = ?,
         cancel_at = ?,
         cancelled_at = ?,
         payment_method = ?,
         payment_provider = ?,
         payment_mode = ?,
         source = ?,
         stripe_customer_id = ?,
         stripe_subscription_id = ?,
         stripe_product_id = ?,
         stripe_price_id = ?,
         stripe_payment_method_id = ?,
         mercadopago_preapproval_id = ?,
         mercadopago_preapproval_plan_id = ?,
         mercadopago_init_point = ?,
         mercadopago_sandbox_init_point = ?,
         mercadopago_payer_id = ?,
         mercadopago_card_id = ?,
         mercadopago_payment_method_id = ?,
         mercadopago_next_payment_date = ?,
         conekta_customer_id = ?,
         conekta_plan_id = ?,
         conekta_subscription_id = ?,
         conekta_payment_source_id = ?,
         conekta_next_billing_at = ?,
         metadata_json = ?,
         raw_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      row.contact_id,
      row.contact_name,
      row.contact_email,
      row.contact_phone,
      row.name,
      row.description,
      row.status,
      row.amount,
      row.currency,
      row.interval_type,
      row.interval_count,
      row.start_date,
      row.next_run_at,
      row.current_period_start,
      row.current_period_end,
      row.cancel_at,
      row.cancelled_at,
      row.payment_method,
      row.payment_provider,
      row.payment_mode,
      row.source,
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.stripe_product_id,
      row.stripe_price_id,
      row.stripe_payment_method_id,
      row.mercadopago_preapproval_id,
      row.mercadopago_preapproval_plan_id,
      row.mercadopago_init_point,
      row.mercadopago_sandbox_init_point,
      row.mercadopago_payer_id,
      row.mercadopago_card_id,
      row.mercadopago_payment_method_id,
      row.mercadopago_next_payment_date,
      row.conekta_customer_id,
      row.conekta_plan_id,
      row.conekta_subscription_id,
      row.conekta_payment_source_id,
      row.conekta_next_billing_at,
      row.metadata_json,
      row.raw_json,
      subscriptionId
    ]
  )

  return getSubscription(subscriptionId)
}

export async function actionSubscription(subscriptionId, action, payload = {}) {
  const normalizedAction = cleanString(action).toLowerCase()
  const existing = await db.get(
    `SELECT *
     FROM subscriptions
     WHERE id = ? AND COALESCE(status, '') <> 'deleted'
     LIMIT 1`,
    [subscriptionId]
  )

  if (!existing) return null

  if (normalizedAction === 'pause') {
    if (existing.stripe_subscription_id) {
      await pauseStripeRecurringSubscription(existing.stripe_subscription_id)
    }
    if (existing.mercadopago_preapproval_id) {
      await pauseMercadoPagoRecurringSubscription(existing.mercadopago_preapproval_id)
    }
    if (existing.conekta_subscription_id) {
      await pauseConektaRecurringSubscription(existing.conekta_customer_id, existing.conekta_subscription_id)
    }

    await db.run(
      `UPDATE subscriptions
       SET status = 'paused', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [subscriptionId]
    )
  } else if (normalizedAction === 'activate' || normalizedAction === 'resume') {
    if (existing.stripe_subscription_id) {
      await resumeStripeRecurringSubscription(existing.stripe_subscription_id)
    }
    if (existing.mercadopago_preapproval_id) {
      await resumeMercadoPagoRecurringSubscription(existing.mercadopago_preapproval_id)
    }
    if (existing.conekta_subscription_id) {
      await resumeConektaRecurringSubscription(existing.conekta_customer_id, existing.conekta_subscription_id)
    }

    const nextRunAt = nullableDate(payload.nextRunAt ?? payload.next_run_at ?? existing.next_run_at) || new Date().toISOString()
    await db.run(
      `UPDATE subscriptions
       SET status = 'active',
           next_run_at = ?,
           cancelled_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextRunAt, subscriptionId]
    )
  } else if (normalizedAction === 'cancel') {
    if (existing.stripe_subscription_id) {
      await cancelStripeRecurringSubscription(existing.stripe_subscription_id)
    }
    if (existing.mercadopago_preapproval_id) {
      await cancelMercadoPagoRecurringSubscription(existing.mercadopago_preapproval_id)
    }
    if (existing.conekta_subscription_id) {
      await cancelConektaRecurringSubscription(existing.conekta_customer_id, existing.conekta_subscription_id)
    }

    await db.run(
      `UPDATE subscriptions
       SET status = 'cancelled',
           cancelled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [subscriptionId]
    )
  } else if (normalizedAction === 'mark_past_due') {
    await db.run(
      `UPDATE subscriptions
       SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [subscriptionId]
    )
  } else {
    throw new Error('Acción de suscripción no soportada.')
  }

  return getSubscription(subscriptionId)
}

export async function deleteSubscription(subscriptionId) {
  const audit = await getSubscriptionAuditSummary(subscriptionId)
  if (audit.hasPayments) {
    const error = new Error('Esta suscripción ya tiene cobros registrados. No se puede eliminar; cancélala para conservar el historial.')
    error.status = 422
    throw error
  }

  const existing = await db.get(
    `SELECT id, status, stripe_subscription_id, mercadopago_preapproval_id, conekta_customer_id, conekta_subscription_id
     FROM subscriptions
     WHERE id = ? AND COALESCE(status, '') <> 'deleted'
     LIMIT 1`,
    [subscriptionId]
  )

  // (PAY-001) Eliminar una suscripción también la cancela en Stripe: de lo contrario
  // Stripe seguiría cobrando al cliente mes a mes aunque desaparezca de Ristak.
  // Tolerante a que ya esté cancelada en Stripe (no debe bloquear el borrado local).
  if (existing?.stripe_subscription_id && existing.status !== 'cancelled') {
    try {
      await cancelStripeRecurringSubscription(existing.stripe_subscription_id)
    } catch (error) {
      logger.warn(`[Suscripciones] No se pudo cancelar en Stripe al eliminar ${subscriptionId} (¿ya cancelada?): ${error.message}`)
    }
  }
  if (existing?.mercadopago_preapproval_id && existing.status !== 'cancelled') {
    await cancelMercadoPagoRecurringSubscription(existing.mercadopago_preapproval_id)
  }
  if (existing?.conekta_subscription_id && existing.status !== 'cancelled') {
    await cancelConektaRecurringSubscription(existing.conekta_customer_id, existing.conekta_subscription_id)
  }

  const result = await db.run(
    `UPDATE subscriptions
     SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [subscriptionId]
  )

  return result.changes > 0
}
