import { databaseDialect, db } from '../config/database.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import {
  DEFAULT_TIMEZONE,
  businessTodayDateOnly,
  getAccountTimezone
} from '../utils/dateUtils.js'
import { createPublicPaymentId, createRistakPaymentEntityId } from '../utils/idGenerator.js'
import { publishPaymentChangedEvent } from './paymentLiveEventsService.js'
import {
  getPaymentGatewayMode,
  getPaymentSettings,
  getPublicPaymentSettings
} from './paymentSettingsService.js'
import {
  isConektaConnected,
  isClipConnected,
  isMercadoPagoConnected,
  isRebillConnected,
  isStripeConnected
} from './integrationConnectionStateService.js'
import { assertExactPaymentPlanTotal, getPaymentPlanDueSafety } from './paymentPlanSafetyService.js'
import {
  getPaymentPlanAuditSummary,
  hardDeleteRemovablePaymentPlan
} from './paymentRecordSafetyService.js'
import {
  assertPaymentPlanNamingChangeAllowed,
  paymentPlanNamingFromMetadata
} from './paymentPlanNamingService.js'

const OFFLINE_PROVIDER = 'offline'
const DEFAULT_REMINDER_DAYS_BEFORE = 0
const DEFAULT_REMINDER_TIME = '12:00'
const MAX_REMINDER_DAYS_BEFORE = 365
const ACTIVE_STATE = 'offline_plan_active'
const PAUSED_STATE = 'offline_plan_paused'
const CANCELLED_STATE = 'offline_plan_cancelled'
const DELETED_STATE = 'offline_plan_deleted'
const CLOSED_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success',
  'registered',
  'refunded',
  'void',
  'deleted',
  'cancelled',
  'canceled'
])
const LOCKED_SCHEDULE_STATUSES = new Set([
  ...CLOSED_PAYMENT_STATUSES,
  'sent',
  'processing',
  'requires_action',
  'authorized',
  'card_authorized'
])
const ONLINE_PAYMENT_LINK_METHODS = Object.freeze({
  stripe: 'stripe_link',
  stripe_link: 'stripe_link',
  conekta: 'conekta_link',
  conekta_link: 'conekta_link',
  mercadopago: 'mercadopago_link',
  mercadopago_link: 'mercadopago_link',
  mercado_pago: 'mercadopago_link',
  clip: 'clip_link',
  clip_card: 'clip_link',
  clip_link: 'clip_link',
  rebill: 'rebill_link',
  rebill_checkout: 'rebill_link',
  rebill_link: 'rebill_link'
})
const ONLINE_PAYMENT_LINK_PROVIDERS = Object.freeze({
  stripe_link: 'stripe',
  conekta_link: 'conekta',
  mercadopago_link: 'mercadopago',
  clip_link: 'clip',
  rebill_link: 'rebill'
})
const PAYMENT_ROW_METHODS = Object.freeze({
  offline: 'offline',
  stripe: 'stripe',
  conekta: 'conekta',
  mercadopago: 'mercadopago',
  clip: 'clip_card',
  rebill: 'rebill_checkout'
})
const PAYMENT_GATEWAY_LABELS = Object.freeze({
  stripe: 'Stripe',
  conekta: 'Conekta',
  mercadopago: 'Mercado Pago',
  clip: 'CLIP',
  rebill: 'Rebill'
})
const PAYMENT_GATEWAY_CONNECTION_CHECKS = Object.freeze({
  stripe: isStripeConnected,
  conekta: isConektaConnected,
  mercadopago: isMercadoPagoConnected,
  clip: isClipConnected,
  rebill: isRebillConnected
})
const REBILL_SUPPORTED_CURRENCIES = new Set(['ARS', 'BRL', 'CLP', 'COP', 'MXN', 'USD'])

function cleanString(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = value ? JSON.parse(value) : fallback
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function createHttpError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function normalizeAmount(value, label = 'monto') {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createHttpError(`El ${label} debe ser mayor a cero.`)
  }
  return Math.round(amount * 100) / 100
}

function normalizeFrequency(value) {
  const normalized = cleanString(value, 40).toLowerCase()
  return ['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom'].includes(normalized)
    ? normalized
    : 'custom'
}

function normalizeInstallmentCollectionMethod(value) {
  const normalized = cleanString(value, 80).toLowerCase()
  if (!normalized || ['offline', 'manual', 'cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'other'].includes(normalized)) {
    return { method: 'offline', provider: OFFLINE_PROVIDER }
  }

  const method = ONLINE_PAYMENT_LINK_METHODS[normalized]
  const provider = method ? ONLINE_PAYMENT_LINK_PROVIDERS[method] : ''
  if (!method || !provider) {
    throw createHttpError('Forma de cobro inválida. Elige recordatorio offline o una pasarela conectada.')
  }
  return { method, provider }
}

function paymentGatewayLabel(provider) {
  return PAYMENT_GATEWAY_LABELS[provider] || provider
}

function hasGatewayCheckoutActivity(row = {}) {
  const metadata = parseJson(row.metadata_json || row.linked_payment_metadata_json)
  return Boolean(
    cleanString(row.stripe_payment_intent_id, 200) ||
    cleanString(row.stripe_charge_id, 200) ||
    cleanString(row.mercadopago_payment_id, 200) ||
    cleanString(row.mercadopago_preference_id, 200) ||
    cleanString(row.conekta_order_id, 200) ||
    cleanString(row.conekta_charge_id, 200) ||
    cleanString(row.conekta_payment_source_id, 200) ||
    cleanString(row.clip_payment_id, 200) ||
    cleanString(row.clip_receipt_no, 200) ||
    cleanString(row.rebill_payment_id, 200) ||
    cleanString(row.rebill_subscription_id, 200) ||
    cleanString(row.rebill_customer_id, 200) ||
    cleanString(row.rebill_card_id, 200) ||
    cleanString(metadata.rebillHostedPaymentLink?.id, 200) ||
    cleanString(metadata.rebillHostedPaymentLink?.url, 200) ||
    cleanString(metadata.rebill?.paymentId, 200) ||
    cleanString(metadata.clip?.paymentId, 200)
  )
}

function hasLockedScheduleStatus(row = {}) {
  return [row.status, row.payment_status]
    .map((status) => cleanString(status, 40).toLowerCase())
    .some((status) => LOCKED_SCHEDULE_STATUSES.has(status))
}

function existingInstallmentCollectionValue(row = {}) {
  const linkedProvider = cleanString(row.linked_payment_provider, 40).toLowerCase()
  return linkedProvider && linkedProvider !== OFFLINE_PROVIDER
    ? linkedProvider
    : row.payment_method || linkedProvider
}

async function resolveOnlinePaymentMode(provider, currency) {
  if (provider === OFFLINE_PROVIDER) return ''
  const connectionCheck = PAYMENT_GATEWAY_CONNECTION_CHECKS[provider]
  if (!connectionCheck || !(await connectionCheck())) {
    throw createHttpError(`Conecta ${paymentGatewayLabel(provider)} antes de usarla en este plan.`, 409)
  }

  const normalizedCurrency = cleanString(currency, 3).toUpperCase()
  const accountCurrency = cleanString(await getAccountCurrency(), 3).toUpperCase()
  if (provider === 'conekta' && normalizedCurrency !== 'MXN') {
    throw createHttpError('Conekta sólo puede usarse en este plan cuando la moneda es MXN.', 409)
  }
  if (provider === 'clip' && normalizedCurrency !== 'MXN') {
    throw createHttpError('CLIP sólo puede usarse en este plan cuando la moneda es MXN.', 409)
  }
  if (provider === 'mercadopago' && normalizedCurrency !== accountCurrency) {
    throw createHttpError(`Mercado Pago está configurado para ${accountCurrency}; este plan conserva ${normalizedCurrency}.`, 409)
  }
  if (provider === 'rebill' && !REBILL_SUPPORTED_CURRENCIES.has(normalizedCurrency)) {
    throw createHttpError(`Rebill no admite ${normalizedCurrency} en enlaces de pago.`, 409)
  }

  return getPaymentGatewayMode()
}

function recurrenceLabel(frequency) {
  return ({
    daily: 'Diario',
    weekly: 'Semanal',
    biweekly: 'Quincenal',
    monthly: 'Mensual',
    yearly: 'Anual',
    custom: 'Personalizado'
  })[normalizeFrequency(frequency)] || 'Personalizado'
}

function normalizeBaseUrl(value) {
  const normalized = cleanString(value, 2000).replace(/\/+$/, '')
  return /^https?:\/\//i.test(normalized) ? normalized : ''
}

function buildPublicPaymentUrl(baseUrl, publicPaymentId) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return normalizedBaseUrl ? `${normalizedBaseUrl}/pay/${encodeURIComponent(publicPaymentId)}` : `/pay/${encodeURIComponent(publicPaymentId)}`
}

function normalizeContact(input = {}) {
  const contact = input.contact && typeof input.contact === 'object' ? input.contact : {}
  return {
    id: cleanString(contact.id || input.contactId, 200),
    name: cleanString(contact.name || contact.fullName || input.contactName, 300),
    email: cleanString(contact.email || input.email, 320).toLowerCase(),
    phone: cleanString(contact.phone || input.phone, 80)
  }
}

function reminderChannelLabel(channel) {
  return ({
    whatsapp: 'WhatsApp',
    whatsapp_qr: 'WhatsApp QR',
    email: 'correo',
    both: 'WhatsApp y correo'
  })[cleanString(channel, 40).toLowerCase()] || 'el canal configurado'
}

function normalizeReminderDaysBefore(value, fallback = DEFAULT_REMINDER_DAYS_BEFORE) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(candidate) || candidate < 0 || candidate > MAX_REMINDER_DAYS_BEFORE) {
    throw createHttpError(`Los días de anticipación deben ser un número entero entre 0 y ${MAX_REMINDER_DAYS_BEFORE}.`)
  }
  return candidate
}

function normalizeReminderTime(value, fallback = DEFAULT_REMINDER_TIME) {
  const candidate = cleanString(value || fallback, 5)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(candidate)) {
    throw createHttpError('La hora del recordatorio debe usar el formato HH:mm de 24 horas.')
  }
  return candidate
}

function readReminderDaysBefore(value) {
  try {
    return normalizeReminderDaysBefore(value)
  } catch {
    return DEFAULT_REMINDER_DAYS_BEFORE
  }
}

function readReminderTime(value) {
  try {
    return normalizeReminderTime(value)
  } catch {
    return DEFAULT_REMINDER_TIME
  }
}

function reminderScheduleLabel(daysBefore, reminderTime) {
  const timing = daysBefore === 0
    ? 'el mismo día del vencimiento'
    : `${daysBefore} ${daysBefore === 1 ? 'día' : 'días'} antes del vencimiento`
  return `${timing} a las ${reminderTime}`
}

function validateReminderDelivery(settings, contact) {
  const automations = settings.automations || {}
  if (!automations.remindersEnabled) {
    throw createHttpError('Activa los recordatorios en Ajustes > Pagos antes de crear un plan offline.', 409)
  }

  const channel = cleanString(automations.reminderChannel, 40).toLowerCase()
  if (!['whatsapp', 'whatsapp_qr', 'email', 'both'].includes(channel)) {
    throw createHttpError('Configura un canal válido para recordatorios en Ajustes > Pagos.', 409)
  }
  if ((channel === 'whatsapp' || channel === 'whatsapp_qr') && !contact.phone) {
    throw createHttpError('El contacto necesita teléfono para recibir el recordatorio offline configurado.', 409)
  }
  if (channel === 'email' && !contact.email) {
    throw createHttpError('El contacto necesita correo para recibir el recordatorio offline configurado.', 409)
  }
  if (channel === 'both' && !contact.phone && !contact.email) {
    throw createHttpError('El contacto necesita teléfono o correo para recibir recordatorios offline.', 409)
  }

  return channel
}

async function normalizeDueDate(value, timezone, label) {
  const safety = await getPaymentPlanDueSafety(value, timezone)
  if (!safety.dueDate) throw createHttpError(`${label} necesita una fecha válida.`)
  if (safety.overdue) throw createHttpError(`${label} no puede quedar en una fecha pasada.`)
  return safety.dueDate
}

function paymentTitle(title, sequence, totalPayments) {
  return totalPayments > 1 ? `${title} - Pago ${sequence} de ${totalPayments}` : title
}

function buildPaymentMetadata({
  flowId,
  installmentId = '',
  sequence,
  source,
  contact,
  lineItems,
  tax,
  reminderChannel,
  reminderDaysBefore,
  reminderTime
}) {
  return {
    source,
    offlineReminder: true,
    reminderTiming: 'scheduled',
    reminderChannel,
    reminderDaysBefore,
    reminderTime,
    contactName: contact.name,
    contactEmail: contact.email,
    contactPhone: contact.phone,
    lineItems,
    ...(tax ? { tax } : {}),
    paymentPlan: {
      flowId,
      ...(installmentId ? { installmentId } : {}),
      sequence,
      trigger: installmentId ? 'offline_reminder' : 'first_payment_offline'
    }
  }
}

function flowStateHistory(state, history = []) {
  return [...history, { state, at: new Date().toISOString() }]
}

function mirrorStatus(flow, installments) {
  const state = cleanString(flow.current_state, 80).toLowerCase()
  if (state === DELETED_STATE) return 'deleted'
  if (state === CANCELLED_STATE) return 'cancelled'
  if (state === PAUSED_STATE) return 'paused'

  const firstRequired = Number(flow.first_payment_amount || 0) > 0
  const firstPaid = !firstRequired || ['paid', 'registered', 'completed', 'succeeded'].includes(cleanString(flow.first_payment_status, 40).toLowerCase())
  const installmentsPaid = installments.every((item) => ['paid', 'registered', 'completed', 'succeeded'].includes(cleanString(item.status, 40).toLowerCase()))
  return firstPaid && installmentsPaid ? 'completed' : 'active'
}

export async function persistOfflinePaymentPlanMirror(flowId) {
  const id = cleanString(flowId, 200)
  if (!id) return null
  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ? AND payment_provider = ?', [id, OFFLINE_PROVIDER])
  if (!flow) return null
  const installments = await db.all(
    `SELECT
       i.*,
       p.payment_provider AS linked_payment_provider,
       p.payment_method AS linked_payment_method,
       p.status AS linked_payment_status,
       p.metadata_json AS linked_payment_metadata_json,
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
       p.rebill_card_id
     FROM installment_payments i
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE i.flow_id = ?
       AND LOWER(COALESCE(i.status, 'pending')) NOT IN ('deleted', 'cancelled', 'canceled', 'void')
     ORDER BY i.sequence ASC`,
    [id]
  )
  const metadata = parseJson(flow.metadata)
  const naming = paymentPlanNamingFromMetadata(flow, metadata)
  const visibleInstallments = installments || []
  const nextInstallment = visibleInstallments.find((item) => !CLOSED_PAYMENT_STATUSES.has(cleanString(item.status, 40).toLowerCase()))
  const firstInstallment = visibleInstallments[0]
  const lastInstallment = visibleInstallments[visibleInstallments.length - 1]
  const hasFirstPayment = Number(flow.first_payment_amount || 0) > 0
  const status = mirrorStatus(flow, visibleInstallments)
  const inferredDefaultMethod = metadata.defaultPaymentMethod ||
    visibleInstallments.find((item) => !CLOSED_PAYMENT_STATUSES.has(cleanString(item.status, 40).toLowerCase()))?.payment_method ||
    'offline'
  const defaultCollection = normalizeInstallmentCollectionMethod(inferredDefaultMethod)
  const schedule = {
    provider: OFFLINE_PROVIDER,
    flowId: id,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    reminderChannel: metadata.reminderChannel || '',
    reminderChannelLabel: reminderChannelLabel(metadata.reminderChannel),
    reminderTiming: 'scheduled',
    reminderDaysBefore: readReminderDaysBefore(metadata.reminderDaysBefore),
    reminderTime: readReminderTime(metadata.reminderTime),
    defaultPaymentMethod: defaultCollection.method,
    firstPayment: hasFirstPayment
      ? {
          amount: Number(flow.first_payment_amount || 0),
          date: flow.first_payment_date || null,
          method: flow.first_payment_method || 'offline',
          status: flow.first_payment_status || null,
          paymentId: flow.first_payment_invoice_id || null
        }
      : null,
    installments: visibleInstallments.map((item) => ({
      id: item.id,
      sequence: Number(item.sequence || 0),
      amount: Number(item.amount || 0),
      percentage: item.percentage ?? null,
      dueDate: item.due_date || null,
      status: item.status || null,
      paymentStatus: item.linked_payment_status || null,
      paymentId: item.payment_id || null,
      paymentMethod: item.payment_method || 'offline',
      paymentProvider: item.linked_payment_provider || OFFLINE_PROVIDER,
      hasPaymentActivity: hasGatewayCheckoutActivity(item)
    }))
  }
  const raw = {
    id,
    provider: OFFLINE_PROVIDER,
    name: naming.planName,
    title: naming.invoiceTitle,
    description: naming.invoiceDescription,
    termsNotes: naming.termsNotes,
    paymentFlow: {
      id,
      state: flow.current_state,
      contactId: flow.contact_id
    },
    schedule
  }
  const startDate = flow.first_payment_date || firstInstallment?.due_date || flow.created_at
  const itemCount = (hasFirstPayment ? 1 : 0) + visibleInstallments.length

  await db.run(
    `INSERT INTO payment_plans (
      id, ghl_schedule_id, contact_id, contact_name, email, phone,
      name, title, status, total, currency, description, recurrence_label,
      start_date, next_run_at, end_date, live_mode, item_count,
      schedule_json, raw_json, source, last_synced_at, created_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      contact_name = excluded.contact_name,
      email = excluded.email,
      phone = excluded.phone,
      name = excluded.name,
      title = excluded.title,
      status = excluded.status,
      total = excluded.total,
      currency = excluded.currency,
      description = excluded.description,
      recurrence_label = excluded.recurrence_label,
      start_date = excluded.start_date,
      next_run_at = excluded.next_run_at,
      end_date = excluded.end_date,
      live_mode = excluded.live_mode,
      item_count = excluded.item_count,
      schedule_json = excluded.schedule_json,
      raw_json = excluded.raw_json,
      source = excluded.source,
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP`,
    [
      id,
      flow.contact_id,
      flow.contact_name || null,
      flow.contact_email || null,
      flow.contact_phone || null,
      naming.planName,
      naming.invoiceTitle,
      status,
      Number(flow.total_amount || 0),
      flow.currency,
      naming.invoiceDescription,
      recurrenceLabel(metadata.remainingFrequency),
      startDate || null,
      nextInstallment?.due_date || null,
      lastInstallment?.due_date || null,
      metadata.paymentMode === 'live' ? 1 : 0,
      itemCount,
      JSON.stringify(schedule),
      JSON.stringify(raw),
      OFFLINE_PROVIDER,
      flow.created_at || null
    ]
  )

  return db.get('SELECT * FROM payment_plans WHERE id = ?', [id])
}

export async function createOfflinePaymentPlan(input = {}, { baseUrl = '' } = {}) {
  const contact = normalizeContact(input)
  if (!contact.id) throw createHttpError('Selecciona un contacto para crear el plan offline.')

  const existingContact = await db.get('SELECT id, full_name, email, phone FROM contacts WHERE id = ? LIMIT 1', [contact.id])
  if (!existingContact) throw createHttpError('El contacto seleccionado ya no existe.', 404)
  contact.name = contact.name || cleanString(existingContact.full_name, 300)
  contact.email = contact.email || cleanString(existingContact.email, 320).toLowerCase()
  contact.phone = contact.phone || cleanString(existingContact.phone, 80)

  const settings = await getPaymentSettings()
  const reminderChannel = validateReminderDelivery(settings, contact)
  const reminderDaysBefore = normalizeReminderDaysBefore(input.reminderDaysBefore)
  const reminderTime = normalizeReminderTime(input.reminderTime)
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const currency = cleanString(await getAccountCurrency(), 10).toUpperCase()
  const totalAmount = normalizeAmount(input.totalAmount || input.total, 'total del plan')
  const title = cleanString(input.title || input.description || input.invoicePayload?.title, 300) || 'Plan de pagos offline'
  const description = cleanString(input.description || title, 1000)
  const remainingFrequency = normalizeFrequency(input.remainingFrequency)
  const firstInput = input.firstPayment && typeof input.firstPayment === 'object' ? input.firstPayment : {}
  const firstEnabled = Boolean(firstInput.enabled && Number(firstInput.amount || 0) > 0)
  const firstAmount = firstEnabled ? normalizeAmount(firstInput.amount, 'primer pago') : 0
  const firstDate = firstEnabled
    ? await normalizeDueDate(firstInput.date || businessTodayDateOnly(timezone), timezone, 'El primer pago')
    : null
  if (firstEnabled && firstDate !== businessTodayDateOnly(timezone)) {
    throw createHttpError('El primer pago inmediato debe registrarse hoy. Si vence después, déjalo como pago programado para que reciba su recordatorio.')
  }
  const firstMethod = cleanString(firstInput.method, 60).toLowerCase() || 'offline'
  if (firstEnabled && !['cash', 'bank_transfer', 'deposit'].includes(firstMethod)) {
    throw createHttpError('En un plan offline, el primer pago inmediato debe ser efectivo, transferencia o depósito. Ristak no puede registrar una tarjeta que no cobró.')
  }
  const remainingInput = Array.isArray(input.remainingPayments) ? input.remainingPayments : []
  if (!remainingInput.length) throw createHttpError('Agrega al menos un pago futuro para el plan offline.')
  const remainingPayments = []
  for (const [index, payment] of remainingInput.entries()) {
    remainingPayments.push({
      sequence: index + 1,
      amount: normalizeAmount(payment.amount, `monto del pago ${index + 1}`),
      percentage: payment.percentage ?? null,
      dueDate: await normalizeDueDate(payment.dueDate || payment.date, timezone, `El pago ${index + 1}`),
      frequency: normalizeFrequency(payment.frequency || remainingFrequency)
    })
  }
  assertExactPaymentPlanTotal({
    totalAmount,
    firstPaymentAmount: firstAmount,
    remainingPayments,
    currency
  })

  const flowId = createRistakPaymentEntityId('offline_flow')
  const createdAt = new Date().toISOString()
  const lineItems = Array.isArray(input.invoicePayload?.items)
    ? input.invoicePayload.items
    : Array.isArray(input.lineItems) ? input.lineItems : []
  const tax = input.invoicePayload?.metadata?.tax || input.metadata?.tax || null
  const totalPayments = remainingPayments.length + (firstEnabled ? 1 : 0)
  const response = {
    flowId,
    currentState: ACTIVE_STATE,
    paymentMode: settings.paymentMode,
    reminderChannel,
    reminderChannelLabel: reminderChannelLabel(reminderChannel),
    reminderDaysBefore,
    reminderTime,
    firstPaymentPaymentId: null,
    scheduledPayments: []
  }

  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO payment_flows (
        id, contact_id, contact_name, contact_email, contact_phone,
        total_amount, currency, concept, payment_type,
        first_payment_amount, first_payment_type, first_payment_value,
        first_payment_date, first_payment_method, first_payment_status,
        first_payment_invoice_id, remaining_automatic, card_setup_required,
        payment_provider, current_state, state_history,
        installment_plan_created_at, installment_plan_active_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      [
        flowId,
        contact.id,
        contact.name || null,
        contact.email || null,
        contact.phone || null,
        totalAmount,
        currency,
        title,
        firstAmount,
        firstEnabled ? 'amount' : 'none',
        firstAmount,
        firstDate,
        firstMethod,
        firstEnabled ? 'registered' : 'not_required',
        null,
        OFFLINE_PROVIDER,
        ACTIVE_STATE,
        JSON.stringify(flowStateHistory(ACTIVE_STATE)),
        createdAt,
        createdAt,
        JSON.stringify({
          source: cleanString(input.source, 160) || 'record_payment_modal_offline_plan',
          creationRequestKey: cleanString(input.idempotencyKey, 200),
          timezone,
          paymentMode: settings.paymentMode,
          remainingFrequency,
          reminderChannel,
          reminderTiming: 'scheduled',
          reminderDaysBefore,
          reminderTime,
          lineItems
        })
      ]
    )

    if (firstEnabled) {
      const paymentId = createRistakPaymentEntityId('offline_first_payment')
      const publicPaymentId = createPublicPaymentId()
      const paymentUrl = buildPublicPaymentUrl(baseUrl, publicPaymentId)
      const now = new Date().toISOString()
      await tx.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, reference, title, description, public_payment_id,
          payment_url, paid_at, metadata_json, date, due_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          paymentId,
          contact.id,
          firstAmount,
          currency,
          firstMethod,
          settings.paymentMode,
          OFFLINE_PROVIDER,
          publicPaymentId,
          paymentTitle(title, 1, totalPayments),
          paymentTitle(description, 1, totalPayments),
          publicPaymentId,
          paymentUrl,
          now,
          JSON.stringify(buildPaymentMetadata({
            flowId,
            sequence: 1,
            source: 'offline_payment_plan_first_payment',
            contact,
            lineItems,
            tax,
            reminderChannel,
            reminderDaysBefore,
            reminderTime
          })),
          now,
          firstDate
        ]
      )
      await tx.run('UPDATE payment_flows SET first_payment_invoice_id = ? WHERE id = ?', [paymentId, flowId])
      response.firstPaymentPaymentId = paymentId
    }

    for (const [index, payment] of remainingPayments.entries()) {
      const sequence = index + 1
      const displaySequence = sequence + (firstEnabled ? 1 : 0)
      const installmentId = createRistakPaymentEntityId('offline_installment')
      const paymentId = createRistakPaymentEntityId('offline_plan_payment')
      const publicPaymentId = createPublicPaymentId()
      const paymentUrl = buildPublicPaymentUrl(baseUrl, publicPaymentId)
      const rowTitle = paymentTitle(title, displaySequence, totalPayments)
      const rowDescription = paymentTitle(description, displaySequence, totalPayments)
      await tx.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, reference, title, description, public_payment_id,
          payment_url, metadata_json, date, due_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 'offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          paymentId,
          contact.id,
          payment.amount,
          currency,
          settings.paymentMode,
          OFFLINE_PROVIDER,
          publicPaymentId,
          rowTitle,
          rowDescription,
          publicPaymentId,
          paymentUrl,
          JSON.stringify(buildPaymentMetadata({
            flowId,
            installmentId,
            sequence,
            source: 'offline_payment_plan_installment',
            contact,
            lineItems,
            tax,
            reminderChannel,
            reminderDaysBefore,
            reminderTime
          })),
          payment.dueDate,
          payment.dueDate
        ]
      )
      await tx.run(
        `INSERT INTO installment_payments (
          id, flow_id, sequence, amount, percentage, due_date, frequency,
          payment_method, automatic, status, payment_id, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', 0, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          installmentId,
          flowId,
          sequence,
          payment.amount,
          payment.percentage,
          payment.dueDate,
          payment.frequency,
          paymentId,
          `Recordatorio ${reminderScheduleLabel(reminderDaysBefore, reminderTime)} por ${reminderChannelLabel(reminderChannel)}.`
        ]
      )
      response.scheduledPayments.push({
        installmentId,
        paymentId,
        publicPaymentId,
        paymentUrl,
        sequence,
        amount: payment.amount,
        currency,
        dueDate: payment.dueDate,
        status: 'pending'
      })
    }
  })

  await persistOfflinePaymentPlanMirror(flowId)
  return response
}

export async function updateOfflinePaymentPlanSchedule(flowId, input = {}) {
  const id = cleanString(flowId, 200)
  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ? AND payment_provider = ?', [id, OFFLINE_PROVIDER])
  if (!flow) throw createHttpError('Plan offline no encontrado.', 404)
  await assertPaymentPlanNamingChangeAllowed(id, input)
  if ([CANCELLED_STATE, DELETED_STATE].includes(cleanString(flow.current_state, 80).toLowerCase())) {
    throw createHttpError('Este plan offline ya no se puede editar.', 409)
  }

  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const metadata = parseJson(flow.metadata)
  const reminderDaysBefore = input.reminderDaysBefore === undefined
    ? readReminderDaysBefore(metadata.reminderDaysBefore)
    : normalizeReminderDaysBefore(input.reminderDaysBefore)
  const reminderTime = input.reminderTime === undefined
    ? readReminderTime(metadata.reminderTime)
    : normalizeReminderTime(input.reminderTime)
  const defaultCollection = normalizeInstallmentCollectionMethod(
    input.defaultPaymentMethod || metadata.defaultPaymentMethod || 'offline'
  )
  const title = cleanString(input.name || input.title || input.description || flow.concept, 300) || 'Plan de pagos offline'
  const frequency = normalizeFrequency(input.remainingFrequency || metadata.remainingFrequency)
  const submitted = Array.isArray(input.installments) ? input.installments : []
  if (!submitted.length) throw createHttpError('El plan offline necesita al menos un pago futuro.')

  const existing = await db.all(
    `SELECT
       i.*,
       p.status AS payment_status,
       p.payment_provider AS linked_payment_provider,
       p.payment_method AS linked_payment_method,
       p.payment_mode AS linked_payment_mode,
       p.public_payment_id,
       p.payment_url,
       p.metadata_json,
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
       p.rebill_card_id
     FROM installment_payments i
     LEFT JOIN payments p ON p.id = i.payment_id
     WHERE i.flow_id = ?
       AND LOWER(COALESCE(i.status, 'pending')) NOT IN ('deleted', 'cancelled', 'canceled', 'void')
     ORDER BY i.sequence`,
    [id]
  )
  const byId = new Map((existing || []).map((row) => [row.id, row]))
  const retainedIds = new Set()
  const submittedIds = new Set()
  const normalized = []

  for (const [index, item] of submitted.entries()) {
    const submittedId = cleanString(item.id, 200)
    if (submittedId && submittedIds.has(submittedId)) {
      throw createHttpError('El calendario repite la misma parcialidad. Recarga el plan e intenta de nuevo.')
    }
    if (submittedId) submittedIds.add(submittedId)
    const existingItem = byId.get(submittedId)
    const existingHasGatewayActivity = existingItem && hasGatewayCheckoutActivity(existingItem)
    if (existingItem && (hasLockedScheduleStatus(existingItem) || existingHasGatewayActivity)) {
      retainedIds.add(existingItem.id)
      normalized.push({
        existing: existingItem,
        amount: Number(existingItem.amount),
        dueDate: existingItem.due_date,
        collection: normalizeInstallmentCollectionMethod(existingInstallmentCollectionValue(existingItem)),
        gatewayActivity: Boolean(existingHasGatewayActivity),
        locked: true
      })
      continue
    }
    const collection = normalizeInstallmentCollectionMethod(
      item.method || item.paymentMethod || existingItem?.payment_method || existingItem?.linked_payment_provider || defaultCollection.method
    )
    const dueDate = await normalizeDueDate(item.dueDate || item.date, timezone, `El pago ${index + 1}`)
    if (collection.provider !== OFFLINE_PROVIDER && dueDate < businessTodayDateOnly(timezone)) {
      throw createHttpError(`El pago ${index + 1} en línea no puede programarse en una fecha pasada.`)
    }
    normalized.push({
      existing: existingItem || null,
      amount: normalizeAmount(item.amount, `monto del pago ${index + 1}`),
      dueDate,
      collection,
      locked: false
    })
    if (existingItem) retainedIds.add(existingItem.id)
  }

  const omittedLocked = (existing || []).find((row) => {
    return (hasLockedScheduleStatus(row) || hasGatewayCheckoutActivity(row)) && !retainedIds.has(row.id)
  })
  if (omittedLocked) {
    throw createHttpError('Los pagos enviados o registrados, y los que ya tienen actividad en la pasarela, deben conservarse en el calendario.', 409)
  }

  const providerModes = new Map([[OFFLINE_PROVIDER, metadata.paymentMode || 'live']])
  const providersToValidate = new Set([
    defaultCollection.provider,
    ...normalized.filter((item) => !item.locked).map((item) => item.collection.provider)
  ])
  for (const provider of providersToValidate) {
    if (provider === OFFLINE_PROVIDER) continue
    providerModes.set(provider, await resolveOnlinePaymentMode(provider, flow.currency))
  }

  const firstAmount = Number(flow.first_payment_amount || 0)
  assertExactPaymentPlanTotal({
    totalAmount: firstAmount + normalized.reduce((sum, item) => sum + item.amount, 0),
    firstPaymentAmount: firstAmount,
    remainingPayments: normalized,
    currency: flow.currency
  })
  const totalPayments = normalized.length + (firstAmount > 0 ? 1 : 0)

  await db.transaction(async (tx) => {
    for (const [index, item] of normalized.entries()) {
      const sequence = index + 1
      const displaySequence = sequence + (firstAmount > 0 ? 1 : 0)
      const installmentId = item.existing?.id || createRistakPaymentEntityId('offline_installment')
      const paymentId = item.existing?.payment_id || createRistakPaymentEntityId('offline_plan_payment')
      const publicPaymentId = item.existing?.public_payment_id || createPublicPaymentId()
      const paymentUrl = item.existing?.payment_url || buildPublicPaymentUrl('', publicPaymentId)
      const rowTitle = paymentTitle(title, displaySequence, totalPayments)
      const collection = item.collection || { method: 'offline', provider: OFFLINE_PROVIDER }
      const onlinePaymentLink = collection.provider !== OFFLINE_PROVIDER
      const paymentMode = providerModes.get(collection.provider) || metadata.paymentMode || 'live'
      const existingPaymentMetadata = parseJson(item.existing?.metadata_json)
      const paymentMetadata = {
        ...existingPaymentMetadata,
        source: onlinePaymentLink ? 'payment_plan_checkout_link' : 'offline_payment_plan_installment',
        offlineReminder: !onlinePaymentLink,
        reminderTiming: 'scheduled',
        reminderChannel: metadata.reminderChannel,
        reminderDaysBefore,
        reminderTime,
        contactName: flow.contact_name || existingPaymentMetadata.contactName || '',
        contactEmail: flow.contact_email || existingPaymentMetadata.contactEmail || '',
        contactPhone: flow.contact_phone || existingPaymentMetadata.contactPhone || '',
        paymentGateway: onlinePaymentLink
          ? { provider: collection.provider, mode: paymentMode }
          : undefined,
        stripeMode: collection.provider === 'stripe' ? paymentMode : undefined,
        conektaMode: collection.provider === 'conekta' ? paymentMode : undefined,
        mercadoPagoMode: collection.provider === 'mercadopago' ? paymentMode : undefined,
        clipMode: collection.provider === 'clip' ? paymentMode : undefined,
        rebillMode: collection.provider === 'rebill' ? paymentMode : undefined,
        paymentPlan: {
          flowId: id,
          installmentId,
          sequence,
          trigger: onlinePaymentLink ? 'scheduled_installment_link' : 'offline_reminder'
        }
      }
      const collectionNote = onlinePaymentLink
        ? `Enlace de pago con ${paymentGatewayLabel(collection.provider)}. Recordatorio ${reminderScheduleLabel(reminderDaysBefore, reminderTime)} por ${reminderChannelLabel(metadata.reminderChannel)}.`
        : `Recordatorio ${reminderScheduleLabel(reminderDaysBefore, reminderTime)} por ${reminderChannelLabel(metadata.reminderChannel)}.`

      if (!item.locked) {
        if (item.existing?.payment_id) {
          const latestPayment = await tx.get(
            `SELECT status, metadata_json, stripe_payment_intent_id, stripe_charge_id,
                    mercadopago_payment_id, mercadopago_preference_id,
                    conekta_order_id, conekta_charge_id, conekta_payment_source_id,
                    clip_payment_id, clip_receipt_no,
                    rebill_payment_id, rebill_subscription_id,
                    rebill_customer_id, rebill_card_id
             FROM payments
             WHERE id = ?${databaseDialect === 'postgres' ? ' FOR UPDATE' : ''}`,
            [item.existing.payment_id]
          )
          const latestStatus = cleanString(latestPayment?.status, 40).toLowerCase()
          if (LOCKED_SCHEDULE_STATUSES.has(latestStatus) || hasGatewayCheckoutActivity(latestPayment)) {
            throw createHttpError('Uno de los pagos recibió actividad mientras editabas el plan. Recarga antes de volver a guardar.', 409)
          }
        }

        await tx.run(
          `INSERT INTO installment_payments (
            id, flow_id, sequence, amount, due_date, frequency, payment_method,
            automatic, status, payment_id, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            sequence = excluded.sequence,
            amount = excluded.amount,
            due_date = excluded.due_date,
            frequency = excluded.frequency,
            payment_method = excluded.payment_method,
            automatic = 0,
            status = 'pending',
            payment_id = excluded.payment_id,
            notes = excluded.notes,
            updated_at = CURRENT_TIMESTAMP`,
          [installmentId, id, sequence, item.amount, item.dueDate, frequency, collection.method, paymentId, collectionNote]
        )
        await tx.run(
          `INSERT INTO payments (
            id, contact_id, amount, currency, status, payment_method, payment_mode,
            payment_provider, reference, title, description, public_payment_id,
            payment_url, metadata_json, date, due_date, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            amount = excluded.amount,
            currency = excluded.currency,
            status = 'pending',
            payment_method = excluded.payment_method,
            payment_mode = excluded.payment_mode,
            payment_provider = excluded.payment_provider,
            reference = excluded.reference,
            title = excluded.title,
            description = excluded.description,
            public_payment_id = excluded.public_payment_id,
            payment_url = excluded.payment_url,
            metadata_json = excluded.metadata_json,
            date = excluded.date,
            due_date = excluded.due_date,
            sent_at = NULL,
            paid_at = NULL,
            stripe_payment_intent_id = NULL,
            stripe_charge_id = NULL,
            mercadopago_payment_id = NULL,
            mercadopago_preference_id = NULL,
            conekta_order_id = NULL,
            conekta_charge_id = NULL,
            conekta_payment_source_id = NULL,
            clip_payment_id = NULL,
            clip_receipt_no = NULL,
            rebill_payment_id = NULL,
            rebill_subscription_id = NULL,
            rebill_customer_id = NULL,
            rebill_card_id = NULL,
            updated_at = CURRENT_TIMESTAMP`,
          [
            paymentId,
            flow.contact_id,
            item.amount,
            flow.currency,
            PAYMENT_ROW_METHODS[collection.provider] || collection.provider,
            paymentMode,
            collection.provider,
            publicPaymentId,
            rowTitle,
            rowTitle,
            publicPaymentId,
            paymentUrl,
            JSON.stringify(paymentMetadata),
            item.dueDate,
            item.dueDate
          ]
        )
      } else {
        await tx.run('UPDATE installment_payments SET sequence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sequence, installmentId])
        const canRefreshPendingGatewayReminder = item.gatewayActivity &&
          [item.existing?.status, item.existing?.payment_status]
            .map((status) => cleanString(status, 40).toLowerCase())
            .every((status) => !CLOSED_PAYMENT_STATUSES.has(status) && status !== 'sent')
        await tx.run(
          `UPDATE payments
           SET title = ?,
               description = ?,
               metadata_json = CASE WHEN ? THEN ? ELSE metadata_json END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [rowTitle, rowTitle, canRefreshPendingGatewayReminder, JSON.stringify(paymentMetadata), paymentId]
        )
      }
    }

    for (const row of existing || []) {
      if (retainedIds.has(row.id)) continue
      if (hasLockedScheduleStatus(row) || hasGatewayCheckoutActivity(row)) continue
      await tx.run("UPDATE installment_payments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id])
      if (row.payment_id) await tx.run("UPDATE payments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.payment_id])
    }

    const nextMetadata = {
      ...metadata,
      remainingFrequency: frequency,
      defaultPaymentMethod: defaultCollection.method,
      reminderTiming: 'scheduled',
      reminderDaysBefore,
      reminderTime
    }
    await tx.run(
      `UPDATE payment_flows
       SET concept = ?, total_amount = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [title, firstAmount + normalized.reduce((sum, item) => sum + item.amount, 0), JSON.stringify(nextMetadata), id]
    )
  })

  return persistOfflinePaymentPlanMirror(id)
}

export async function applyOfflinePaymentPlanAction(flowId, action) {
  const id = cleanString(flowId, 200)
  const normalizedAction = cleanString(action, 40).toLowerCase()
  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ? AND payment_provider = ?', [id, OFFLINE_PROVIDER])
  if (!flow) throw createHttpError('Plan offline no encontrado.', 404)

  if (normalizedAction === 'delete') {
    const audit = await getPaymentPlanAuditSummary(id)
    if (!audit.isTestMode && audit.hasLedgerActivity) {
      throw createHttpError(
        'Este plan ya tiene pagos, intentos, anulaciones o reembolsos registrados. No se puede eliminar; cancélalo para conservar el historial.',
        422
      )
    }

    const deletion = await hardDeleteRemovablePaymentPlan(id)
    if (!deletion.deleted) {
      throw createHttpError(
        'El plan registró actividad financiera mientras se intentaba eliminar. Se conservó el historial.',
        409
      )
    }

    return {
      id,
      status: 'deleted',
      source: OFFLINE_PROVIDER,
      deleted: true
    }
  }

  const history = parseJson(flow.state_history, [])
  const currentState = cleanString(flow.current_state, 80).toLowerCase()

  if (currentState === DELETED_STATE) {
    throw createHttpError('Un plan offline cancelado o eliminado ya no puede cambiar de estado.', 409)
  }
  if (currentState === CANCELLED_STATE) {
    if (normalizedAction === 'cancel') return persistOfflinePaymentPlanMirror(id)
    throw createHttpError('Un plan offline cancelado solo puede conservarse o eliminarse.', 409)
  }

  let nextState = ''
  if (normalizedAction === 'activate') {
    nextState = ACTIVE_STATE
  } else if (normalizedAction === 'pause') {
    nextState = PAUSED_STATE
  } else if (normalizedAction === 'cancel') {
    nextState = CANCELLED_STATE
  } else {
    throw createHttpError('Esa acción no aplica para planes offline.', 409)
  }

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE payment_flows SET current_state = ?, state_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextState, JSON.stringify(flowStateHistory(nextState, Array.isArray(history) ? history : [])), id]
    )
    if (normalizedAction === 'cancel') {
      await tx.run(
        `UPDATE installment_payments
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE flow_id = ? AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'registered', 'sent', 'refunded', 'void', 'deleted')`,
        ['cancelled', id]
      )
      await tx.run(
        `UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (SELECT payment_id FROM installment_payments WHERE flow_id = ?)
           AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'sent', 'refunded', 'void', 'deleted')`,
        ['cancelled', id]
      )
    }
  })

  return persistOfflinePaymentPlanMirror(id)
}

export async function markOfflinePaymentReminderSent(paymentId, sentAt = new Date().toISOString()) {
  const id = cleanString(paymentId, 200)
  const payment = await db.get('SELECT * FROM payments WHERE id = ? AND payment_provider = ?', [id, OFFLINE_PROVIDER])
  if (!payment || CLOSED_PAYMENT_STATUSES.has(cleanString(payment.status, 40).toLowerCase())) return null

  await db.transaction(async (tx) => {
    await tx.run(
      `UPDATE payments SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND payment_provider = 'offline'
         AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'refunded', 'void', 'deleted', 'cancelled', 'canceled')`,
      [sentAt, id]
    )
    await tx.run(
      `UPDATE installment_payments SET status = 'sent', updated_at = CURRENT_TIMESTAMP
       WHERE payment_id = ?
         AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'registered', 'refunded', 'void', 'deleted', 'cancelled', 'canceled')`,
      [id]
    )
  })

  const installment = await db.get('SELECT flow_id FROM installment_payments WHERE payment_id = ? LIMIT 1', [id])
  if (installment?.flow_id) await persistOfflinePaymentPlanMirror(installment.flow_id)
  const updated = await db.get('SELECT * FROM payments WHERE id = ?', [id])
  if (updated) publishPaymentChangedEvent(updated)
  return updated
}

export async function syncOfflinePaymentPlanFromLocalPayment(paymentId) {
  const id = cleanString(paymentId, 200)
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [id])
  if (!payment) return null
  const normalizedStatus = cleanString(payment.status, 40).toLowerCase()
  const nextStatus = ['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'].includes(normalizedStatus)
    ? 'paid'
    : normalizedStatus
  const installment = await db.get(
    `SELECT i.flow_id
     FROM installment_payments i
     JOIN payment_flows f ON f.id = i.flow_id
     WHERE i.payment_id = ? AND f.payment_provider = ?
     LIMIT 1`,
    [id, OFFLINE_PROVIDER]
  )
  const firstFlow = installment ? null : await db.get('SELECT id FROM payment_flows WHERE first_payment_invoice_id = ? AND payment_provider = ? LIMIT 1', [id, OFFLINE_PROVIDER])
  const flowId = installment?.flow_id || firstFlow?.id
  if (!flowId) return null

  if (installment) {
    await db.run('UPDATE installment_payments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE payment_id = ?', [nextStatus, id])
  } else {
    await db.run('UPDATE payment_flows SET first_payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextStatus === 'paid' ? 'registered' : nextStatus, flowId])
  }
  return persistOfflinePaymentPlanMirror(flowId)
}

export function isOfflinePaymentPlanPayment(payment = {}) {
  if (cleanString(payment.payment_provider, 40).toLowerCase() === OFFLINE_PROVIDER) return true
  const metadata = parseJson(payment.metadata_json)
  return Boolean(metadata.offlineReminder || cleanString(metadata.source, 120).startsWith('offline_payment_plan'))
}

export async function getPublicOfflinePayment(publicPaymentId, { baseUrl = '' } = {}) {
  const publicId = cleanString(publicPaymentId, 200)
  const row = await db.get(
    `SELECT p.*, c.full_name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
     FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.public_payment_id = ? AND p.payment_provider = ?
     LIMIT 1`,
    [publicId, OFFLINE_PROVIDER]
  )
  if (!row) return null

  const metadata = parseJson(row.metadata_json)
  const flowId = cleanString(metadata.paymentPlan?.flowId, 200)
  const mirror = flowId
    ? await db.get('SELECT * FROM payment_plans WHERE id = ? AND source = ? LIMIT 1', [flowId, OFFLINE_PROVIDER])
    : null
  const schedule = parseJson(mirror?.schedule_json)
  const settings = await getPublicPaymentSettings()
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const paymentUrl = /^https?:\/\//i.test(cleanString(row.payment_url, 2000))
    ? row.payment_url
    : buildPublicPaymentUrl(baseUrl, publicId)

  return {
    id: row.id,
    publicPaymentId: publicId,
    paymentUrl,
    status: row.status || 'pending',
    amount: Number(row.amount || 0),
    currency: row.currency,
    title: row.title || mirror?.title || 'Pago offline',
    description: row.description || mirror?.description || '',
    dueDate: row.due_date || null,
    sentAt: row.sent_at || null,
    paidAt: row.paid_at || null,
    timezone,
    timeZone: timezone,
    paymentMode: row.payment_mode === 'test' ? 'test' : 'live',
    provider: OFFLINE_PROVIDER,
    contact: {
      id: row.contact_id || undefined,
      name: row.contact_name || metadata.contactName || undefined,
      email: row.contact_email || metadata.contactEmail || undefined,
      phone: row.contact_phone || metadata.contactPhone || undefined
    },
    paymentPlan: mirror
      ? {
          provider: OFFLINE_PROVIDER,
          flowId,
          trigger: metadata.paymentPlan?.trigger || 'offline_reminder',
          title: mirror.title || mirror.name || 'Plan de pagos offline',
          description: mirror.description || '',
          status: mirror.status || null,
          total: Number(mirror.total || 0),
          currency: mirror.currency || row.currency,
          remainingFrequency: schedule.remainingFrequency || null,
          recurrenceLabel: mirror.recurrence_label || recurrenceLabel(schedule.remainingFrequency),
          reminderChannel: schedule.reminderChannel || metadata.reminderChannel || '',
          reminderChannelLabel: schedule.reminderChannelLabel || reminderChannelLabel(schedule.reminderChannel || metadata.reminderChannel),
          reminderDaysBefore: readReminderDaysBefore(schedule.reminderDaysBefore ?? metadata.reminderDaysBefore),
          reminderTime: readReminderTime(schedule.reminderTime || metadata.reminderTime),
          firstPayment: schedule.firstPayment || null,
          installments: Array.isArray(schedule.installments) ? schedule.installments : []
        }
      : null,
    tax: metadata.tax || null,
    settings
  }
}
