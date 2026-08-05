import { db } from '../config/database.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import {
  DEFAULT_TIMEZONE,
  businessTodayDateOnly,
  getAccountTimezone
} from '../utils/dateUtils.js'
import { createPublicPaymentId, createRistakPaymentEntityId } from '../utils/idGenerator.js'
import { publishPaymentChangedEvent } from './paymentLiveEventsService.js'
import { getPaymentSettings, getPublicPaymentSettings } from './paymentSettingsService.js'
import { assertExactPaymentPlanTotal, getPaymentPlanDueSafety } from './paymentPlanSafetyService.js'

const OFFLINE_PROVIDER = 'offline'
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
  'sent'
])

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

function buildPaymentMetadata({ flowId, installmentId = '', sequence, source, contact, lineItems, tax, reminderChannel }) {
  return {
    source,
    offlineReminder: true,
    reminderTiming: 'due_date',
    reminderChannel,
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
    `SELECT * FROM installment_payments
     WHERE flow_id = ?
       AND LOWER(COALESCE(status, 'pending')) NOT IN ('deleted', 'cancelled', 'canceled', 'void')
     ORDER BY sequence ASC`,
    [id]
  )
  const metadata = parseJson(flow.metadata)
  const visibleInstallments = installments || []
  const nextInstallment = visibleInstallments.find((item) => !CLOSED_PAYMENT_STATUSES.has(cleanString(item.status, 40).toLowerCase()))
  const firstInstallment = visibleInstallments[0]
  const lastInstallment = visibleInstallments[visibleInstallments.length - 1]
  const hasFirstPayment = Number(flow.first_payment_amount || 0) > 0
  const status = mirrorStatus(flow, visibleInstallments)
  const schedule = {
    provider: OFFLINE_PROVIDER,
    flowId: id,
    remainingFrequency: metadata.remainingFrequency || 'custom',
    reminderChannel: metadata.reminderChannel || '',
    reminderChannelLabel: reminderChannelLabel(metadata.reminderChannel),
    reminderTiming: 'due_date',
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
      paymentId: item.payment_id || null,
      paymentMethod: item.payment_method || 'offline'
    }))
  }
  const raw = {
    id,
    provider: OFFLINE_PROVIDER,
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
      flow.concept || 'Plan de pagos offline',
      flow.concept || 'Plan de pagos offline',
      status,
      Number(flow.total_amount || 0),
      flow.currency,
      flow.concept || 'Plan de pagos offline',
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
          reminderTiming: 'due_date',
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
            reminderChannel
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
            reminderChannel
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
          `Recordatorio el día del vencimiento por ${reminderChannelLabel(reminderChannel)}.`
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
  if ([CANCELLED_STATE, DELETED_STATE].includes(cleanString(flow.current_state, 80).toLowerCase())) {
    throw createHttpError('Este plan offline ya no se puede editar.', 409)
  }

  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const metadata = parseJson(flow.metadata)
  const title = cleanString(input.name || input.title || input.description || flow.concept, 300) || 'Plan de pagos offline'
  const frequency = normalizeFrequency(input.remainingFrequency || metadata.remainingFrequency)
  const submitted = Array.isArray(input.installments) ? input.installments : []
  if (!submitted.length) throw createHttpError('El plan offline necesita al menos un pago futuro.')

  const existing = await db.all(
    `SELECT i.*, p.status AS payment_status, p.public_payment_id, p.payment_url, p.metadata_json
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
    const existingStatus = cleanString(existingItem?.status || existingItem?.payment_status, 40).toLowerCase()
    if (existingItem && LOCKED_SCHEDULE_STATUSES.has(existingStatus)) {
      retainedIds.add(existingItem.id)
      normalized.push({ existing: existingItem, amount: Number(existingItem.amount), dueDate: existingItem.due_date, locked: true })
      continue
    }
    normalized.push({
      existing: existingItem || null,
      amount: normalizeAmount(item.amount, `monto del pago ${index + 1}`),
      dueDate: await normalizeDueDate(item.dueDate || item.date, timezone, `El pago ${index + 1}`),
      locked: false
    })
    if (existingItem) retainedIds.add(existingItem.id)
  }

  const omittedLocked = (existing || []).find((row) => {
    const status = cleanString(row.status || row.payment_status, 40).toLowerCase()
    return LOCKED_SCHEDULE_STATUSES.has(status) && !retainedIds.has(row.id)
  })
  if (omittedLocked) {
    throw createHttpError('Los pagos enviados o registrados deben conservarse en el calendario.', 409)
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
      const paymentMetadata = {
        ...parseJson(item.existing?.metadata_json),
        offlineReminder: true,
        reminderTiming: 'due_date',
        reminderChannel: metadata.reminderChannel,
        paymentPlan: {
          flowId: id,
          installmentId,
          sequence,
          trigger: 'offline_reminder'
        }
      }

      if (!item.locked) {
        await tx.run(
          `INSERT INTO installment_payments (
            id, flow_id, sequence, amount, due_date, frequency, payment_method,
            automatic, status, payment_id, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'offline', 0, 'pending', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            sequence = excluded.sequence,
            amount = excluded.amount,
            due_date = excluded.due_date,
            frequency = excluded.frequency,
            payment_method = 'offline',
            automatic = 0,
            status = 'pending',
            payment_id = excluded.payment_id,
            notes = excluded.notes,
            updated_at = CURRENT_TIMESTAMP`,
          [installmentId, id, sequence, item.amount, item.dueDate, frequency, paymentId, `Recordatorio el día del vencimiento por ${reminderChannelLabel(metadata.reminderChannel)}.`]
        )
        await tx.run(
          `INSERT INTO payments (
            id, contact_id, amount, currency, status, payment_method, payment_mode,
            payment_provider, reference, title, description, public_payment_id,
            payment_url, metadata_json, date, due_date, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 'offline', ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            amount = excluded.amount,
            currency = excluded.currency,
            status = CASE WHEN LOWER(COALESCE(payments.status, 'pending')) IN ('paid', 'sent') THEN payments.status ELSE 'pending' END,
            payment_method = 'offline',
            payment_provider = 'offline',
            title = excluded.title,
            description = excluded.description,
            metadata_json = excluded.metadata_json,
            date = excluded.date,
            due_date = excluded.due_date,
            updated_at = CURRENT_TIMESTAMP`,
          [paymentId, flow.contact_id, item.amount, flow.currency, metadata.paymentMode || 'live', publicPaymentId, rowTitle, rowTitle, publicPaymentId, paymentUrl, JSON.stringify(paymentMetadata), item.dueDate, item.dueDate]
        )
      } else {
        await tx.run('UPDATE installment_payments SET sequence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sequence, installmentId])
        await tx.run('UPDATE payments SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [rowTitle, rowTitle, paymentId])
      }
    }

    for (const row of existing || []) {
      if (retainedIds.has(row.id)) continue
      const status = cleanString(row.status || row.payment_status, 40).toLowerCase()
      if (LOCKED_SCHEDULE_STATUSES.has(status)) continue
      await tx.run("UPDATE installment_payments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id])
      if (row.payment_id) await tx.run("UPDATE payments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.payment_id])
    }

    const nextMetadata = { ...metadata, remainingFrequency: frequency }
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
  const history = parseJson(flow.state_history, [])
  const currentState = cleanString(flow.current_state, 80).toLowerCase()

  if (currentState === DELETED_STATE) {
    if (normalizedAction === 'delete') return persistOfflinePaymentPlanMirror(id)
    throw createHttpError('Un plan offline cancelado o eliminado ya no puede cambiar de estado.', 409)
  }
  if (currentState === CANCELLED_STATE) {
    if (normalizedAction === 'cancel') return persistOfflinePaymentPlanMirror(id)
    if (normalizedAction !== 'delete') {
      throw createHttpError('Un plan offline cancelado solo puede conservarse o eliminarse.', 409)
    }
  }

  let nextState = ''
  if (normalizedAction === 'activate') {
    nextState = ACTIVE_STATE
  } else if (normalizedAction === 'pause') {
    nextState = PAUSED_STATE
  } else if (normalizedAction === 'cancel') {
    nextState = CANCELLED_STATE
  } else if (normalizedAction === 'delete') {
    nextState = DELETED_STATE
  } else {
    throw createHttpError('Esa acción no aplica para planes offline.', 409)
  }

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE payment_flows SET current_state = ?, state_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextState, JSON.stringify(flowStateHistory(nextState, Array.isArray(history) ? history : [])), id]
    )
    if (normalizedAction === 'cancel' || normalizedAction === 'delete') {
      const terminalStatus = normalizedAction === 'delete' ? 'deleted' : 'cancelled'
      await tx.run(
        `UPDATE installment_payments
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE flow_id = ? AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'registered', 'sent', 'refunded', 'void', 'deleted')`,
        [terminalStatus, id]
      )
      await tx.run(
        `UPDATE payments SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (SELECT payment_id FROM installment_payments WHERE flow_id = ?)
           AND LOWER(COALESCE(status, 'pending')) NOT IN ('paid', 'sent', 'refunded', 'void', 'deleted')`,
        [terminalStatus, id]
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
  const payment = await db.get('SELECT * FROM payments WHERE id = ? AND payment_provider = ?', [id, OFFLINE_PROVIDER])
  if (!payment) return null
  const normalizedStatus = cleanString(payment.status, 40).toLowerCase()
  const nextStatus = ['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success'].includes(normalizedStatus)
    ? 'paid'
    : normalizedStatus
  const installment = await db.get('SELECT flow_id FROM installment_payments WHERE payment_id = ? LIMIT 1', [id])
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
          firstPayment: schedule.firstPayment || null,
          installments: Array.isArray(schedule.installments) ? schedule.installments : []
        }
      : null,
    tax: metadata.tax || null,
    settings
  }
}
