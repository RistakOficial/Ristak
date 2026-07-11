import { tool } from '@openai/agents'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { db } from '../../config/database.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { getLocalFreeSlots } from '../../services/localCalendarService.js'
import { inspectChangedAppointmentCreationReplay } from '../../services/appointmentCreationSafetyService.js'
import {
  buildConversationalPaymentLinkIdempotencyKey,
  createSinglePaymentLink,
  registerAgentTransferPaymentProofForReview
} from '../../services/paymentFlowService.js'
import { getBusinessProfileSnapshot, getOpenAIApiKey } from '../../services/aiAgentService.js'
import { analyzePaymentReceiptImage } from './mediaContext.js'
import { getTriggerLink } from '../../services/triggerLinksService.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone, resolveTimezone } from '../../utils/dateUtils.js'
import { getAccountCurrency } from '../../utils/accountLocale.js'
import {
  bindConversationalPaymentSourceEvent,
  completeConversationalAgentSalePaymentFromInvoice,
  consumeConversationalAppointmentDepositEvidence,
  releaseConversationalAppointmentDepositEvidence,
  reserveConversationalAppointmentDepositEvidence,
  setConversationSignal,
  recordConversationalAgentEvent,
  createConversationGoalLink,
  DEFAULT_GOAL_TRACKING_PARAM
} from '../../services/conversationalAgentService.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'
import { logger } from '../../utils/logger.js'
import {
  NON_LIVE_PAYMENT_MODES,
  SUCCESS_PAYMENT_STATUSES,
  depositRequirementAmountMatches,
  findVerifiedPaymentEvidence,
  revalidateAppointmentSlot
} from './actionEvidence.js'
import {
  getConversationalCapability,
  getEnabledConversationalCapabilities
} from './nativeRuntimeConfig.js'

/**
 * Tools del agente conversacional. Se crean por ejecución con una factory
 * porque necesitan el contexto de la conversación (contactId, configuración
 * y modo simulación) cerrado sobre cada tool.
 *
 * ctx = {
 *   contactId, config, dryRun,
 *   actions: [] // acciones internas ejecutadas (para auditoría/preview)
 * }
 */

function pushAction(ctx, type, detail = {}) {
  const action = { type, ...detail }
  ctx.actions.push(action)
  return action
}

function settleAction(action, status, detail = {}) {
  if (!action) return null
  const normalizedStatus = ['ok', 'error', 'simulated'].includes(status) ? status : 'error'
  action.outcome = {
    status: normalizedStatus,
    ok: normalizedStatus !== 'error',
    simulated: normalizedStatus === 'simulated',
    actionCompleted: normalizedStatus === 'ok',
    ...detail
  }
  return action.outcome
}

function getToolRuntimeConfig(ctx = {}, config = {}) {
  return {
    ...config,
    capabilitiesConfig: ctx.capabilitiesConfig ?? config.capabilitiesConfig
  }
}

function getNativeCapability(ctx = {}, config = {}, capabilityId = '') {
  const capability = getConversationalCapability(getToolRuntimeConfig(ctx, config), capabilityId)
  return capability?.enabled ? capability : null
}

function getNativePaymentPurpose(ctx = {}, config = {}) {
  const payment = getNativeCapability(ctx, config, 'collect_payment')
  if (!payment) return ''
  if (payment.paymentMode === 'deposit' || payment.deposit?.enabled === true) {
    return getNativeCapability(ctx, config, 'schedule_appointment')
      ? 'appointment_deposit'
      : 'deposit'
  }
  return 'purchase'
}

function normalizeCurrencyCode(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizedMoney(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.round(amount * 100) / 100
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function buildConversationalSlotRequestId(calendarId, startTime, {
  allowOverlaps = false,
  contactId = '',
  channel = '',
  executionId = ''
} = {}) {
  const resource = [calendarId, startTime, contactId, channel, executionId, allowOverlaps ? 'overlap' : 'exclusive'].join('\u0000')
  const digest = createHash('sha256').update(resource).digest('hex')
  return `conv-v2-attempt:${digest}`
}

async function resolveNativePaymentAuthority({ capability, quantity = 1, agreedAmount = null, accountCurrency = '' } = {}) {
  const boundedQuantity = Number(quantity || 1)
  if (!Number.isInteger(boundedQuantity) || boundedQuantity < 1 || boundedQuantity > 100) {
    return { ok: false, actionCompleted: false, error: 'La cantidad debe ser un entero entre 1 y 100. No se creó ningún link.' }
  }

  const trustedAccountCurrency = normalizeCurrencyCode(accountCurrency)
  if (!trustedAccountCurrency) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'No se pudo leer la moneda configurada en la cuenta. No se creó ningún link.' }
  }

  const usesDeposit = capability?.paymentMode === 'deposit' || capability?.deposit?.enabled === true
  if (usesDeposit) {
    const deposit = capability.deposit || {}
    if (boundedQuantity !== 1) {
      return { ok: false, actionCompleted: false, error: 'Un anticipo se cobra una sola vez; la cantidad debe ser 1. No se creó ningún link.' }
    }
    const explicitAgreedAmount = agreedAmount === null || agreedAmount === undefined
      ? 0
      : normalizedMoney(agreedAmount)
    const minAmount = normalizedMoney(deposit.minAmount)
    const maxAmount = normalizedMoney(deposit.maxAmount)
    const fixedAmount = normalizedMoney(deposit.amount)
    let amount = fixedAmount
    if (deposit.mode === 'range') {
      if (!explicitAgreedAmount) {
        return {
          ok: false,
          actionCompleted: false,
          needsData: true,
          requiredField: 'agreedAmount',
          error: `Falta el monto acordado del anticipo${minAmount && maxAmount ? ` (debe estar entre ${minAmount} y ${maxAmount} ${trustedAccountCurrency})` : ''}. Pregúntalo antes de crear el link.`
        }
      }
      if ((minAmount && explicitAgreedAmount < minAmount) || (maxAmount && explicitAgreedAmount > maxAmount)) {
        return {
          ok: false,
          actionCompleted: false,
          amountOutOfRange: true,
          minAmount: minAmount || null,
          maxAmount: maxAmount || null,
          error: `El monto acordado (${explicitAgreedAmount} ${trustedAccountCurrency}) está fuera del rango configurado. No se creó ningún link.`
        }
      }
      amount = explicitAgreedAmount
    } else if (explicitAgreedAmount && Math.abs(explicitAgreedAmount - fixedAmount) >= 0.005) {
      return {
        ok: false,
        actionCompleted: false,
        amountMismatch: true,
        error: `El anticipo fijo configurado es ${fixedAmount} ${trustedAccountCurrency}; el monto acordado no coincide. No se creó ningún link.`
      }
    }
    const currency = normalizeCurrencyCode(deposit.currency || capability.currency || trustedAccountCurrency)
    if (!amount) {
      return { ok: false, actionCompleted: false, transferRequired: true, error: 'El anticipo configurado no tiene un monto válido. No se creó ningún link.' }
    }
    if (currency !== trustedAccountCurrency) {
      return {
        ok: false,
        actionCompleted: false,
        currencyMismatch: true,
        error: `El anticipo configurado usa ${currency || 'una moneda inválida'} y la cuenta usa ${trustedAccountCurrency}. No se creó ningún link.`
      }
    }
    return {
      ok: true,
      trusted: {
        amount,
        currency: trustedAccountCurrency,
        concept: 'Anticipo',
        quantity: 1,
        source: 'capability_deposit',
        productId: capability.productId || null,
        priceId: capability.priceId || null
      }
    }
  }

  const productId = String(capability?.productId || '').trim()
  const priceId = String(capability?.priceId || '').trim()
  if (!productId || !priceId) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'La capacidad de cobro no tiene producto y precio configurados. No se creó ningún link.' }
  }

  const row = await db.get(`
    SELECT
      p.id AS product_id,
      p.ghl_product_id,
      p.name AS product_name,
      p.currency AS product_currency,
      pp.id AS price_id,
      pp.ghl_price_id,
      pp.name AS price_name,
      pp.amount,
      pp.currency AS price_currency
    FROM products p
    INNER JOIN product_prices pp ON pp.product_id = p.id
    WHERE p.is_active = 1
      AND (p.id = ? OR p.ghl_product_id = ?)
      AND (pp.id = ? OR pp.ghl_price_id = ?)
    LIMIT 1
  `, [productId, productId, priceId, priceId])
  if (!row) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'El producto o precio configurado ya no existe o no está activo. No se creó ningún link.' }
  }

  const unitAmount = normalizedMoney(row.amount)
  const currency = normalizeCurrencyCode(row.price_currency || row.product_currency || trustedAccountCurrency)
  if (!unitAmount) {
    return { ok: false, actionCompleted: false, transferRequired: true, error: 'El precio guardado no tiene un monto válido. No se creó ningún link.' }
  }
  if (currency !== trustedAccountCurrency) {
    return {
      ok: false,
      actionCompleted: false,
      currencyMismatch: true,
      error: `El precio guardado usa ${currency || 'una moneda inválida'} y la cuenta usa ${trustedAccountCurrency}. No se creó ningún link.`
    }
  }

  const amount = normalizedMoney(unitAmount * boundedQuantity)
  const explicitAgreedAmount = agreedAmount === null || agreedAmount === undefined
    ? 0
    : normalizedMoney(agreedAmount)
  if (explicitAgreedAmount && Math.abs(explicitAgreedAmount - amount) >= 0.005) {
    return {
      ok: false,
      actionCompleted: false,
      amountMismatch: true,
      error: `El monto indicado no coincide con el precio real (${amount} ${trustedAccountCurrency}). No se creó ningún link.`
    }
  }
  return {
    ok: true,
    trusted: {
      amount,
      unitAmount,
      currency: trustedAccountCurrency,
      concept: [row.product_name, row.price_name].filter(Boolean).join(' · ') || 'Pago',
      quantity: boundedQuantity,
      source: 'product_price',
      productId: row.product_id,
      priceId: row.price_id
    }
  }
}

async function assignNativeHandoffUser({ contactId, capability } = {}) {
  const configuredUserId = String(capability?.userId || '').trim()
  if (!configuredUserId) return { assigned: false, alreadyAssigned: false, userName: null }

  return db.transaction(async () => {
    const user = await db.get(
      `SELECT id, username, email, full_name
       FROM users
       WHERE CAST(id AS TEXT) = ? AND is_active = 1
       LIMIT 1`,
      [configuredUserId]
    )
    if (!user?.id) {
      const error = new Error('La persona configurada para recibir el chat ya no está activa. No se completó la transferencia.')
      error.status = 409
      error.code = 'handoff_user_unavailable'
      throw error
    }

    const contact = await db.get('SELECT id, assigned_user_id FROM contacts WHERE id = ?', [contactId])
    if (!contact?.id) {
      const error = new Error('El contacto ya no existe. No se completó la transferencia.')
      error.status = 404
      error.code = 'handoff_contact_not_found'
      throw error
    }

    const assignedUserId = String(user.id)
    let alreadyAssigned = String(contact.assigned_user_id || '') === assignedUserId
    if (!alreadyAssigned) {
      const update = await db.run(
        `UPDATE contacts
         SET assigned_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND (assigned_user_id IS NULL OR CAST(assigned_user_id AS TEXT) <> ?)`,
        [assignedUserId, contactId, assignedUserId]
      )
      if (Number(update?.changes ?? update?.rowCount ?? 0) !== 1) {
        const current = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
        alreadyAssigned = String(current?.assigned_user_id || '') === assignedUserId
      }
      if (!alreadyAssigned && Number(update?.changes ?? update?.rowCount ?? 0) !== 1) {
        const error = new Error('No se pudo asignar el contacto a la persona configurada. No se completó la transferencia.')
        error.status = 503
        error.code = 'handoff_assignment_failed'
        throw error
      }
    }

    const userName = String(user.full_name || user.email || user.username || capability?.userName || '').trim().slice(0, 180)
    return { assigned: true, alreadyAssigned, assignedUserId, userName: userName || null }
  })
}

let nativeHandoffAfterAssignmentHookForTest = null

export function setNativeHandoffAfterAssignmentHookForTest(hook = null) {
  nativeHandoffAfterAssignmentHookForTest = typeof hook === 'function' ? hook : null
}

/**
 * El handoff v2 cambia dos fuentes de verdad: quién atiende al contacto y el
 * estado terminal de la conversación. Deben confirmar o revertirse juntas;
 * de otro modo un fallo después de asignar deja al contacto en manos de una
 * persona mientras el bot cree que la transferencia no ocurrió.
 *
 * db.transaction usa la misma conexión mediante AsyncLocalStorage tanto en
 * SQLite como en Postgres, por lo que assignNativeHandoffUser (transacción
 * anidada), setConversationSignal y sus eventos participan del mismo commit.
 */
async function commitNativeHandoff({
  ctx,
  config,
  capability,
  signal = 'ready_for_human',
  signalOptions = {},
  assignmentEventSource = 'handoff_human'
} = {}) {
  return db.transaction(async () => {
    const assignment = await assignNativeHandoffUser({
      contactId: ctx.contactId,
      capability
    })

    if (nativeHandoffAfterAssignmentHookForTest) {
      await nativeHandoffAfterAssignmentHookForTest({
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        channel: ctx.channel || 'whatsapp',
        signal,
        assignment
      })
    }

    const state = await setConversationSignal(ctx.contactId, signal, {
      ...signalOptions,
      agentId: config.id || ctx.agentId || '',
      channel: ctx.channel || 'whatsapp',
      strictEvent: true
    })
    if (!state?.id) {
      const error = new Error('No se pudo confirmar el estado de la conversación. No se completó la transferencia.')
      error.status = 503
      error.code = 'handoff_state_commit_failed'
      throw error
    }

    if (assignment.assigned && !assignment.alreadyAssigned) {
      await recordConversationalAgentEvent({
        contactId: ctx.contactId,
        eventType: 'handoff_user_assigned',
        detail: {
          agentId: config.id || ctx.agentId || null,
          assignedUserId: assignment.assignedUserId,
          assignedUserName: assignment.userName || null,
          source: assignmentEventSource
        },
        throwOnError: true
      })
    }

    return { assignment, state }
  })
}

async function resolveNativeScheduleCalendar(capability = {}) {
  const configuredId = String(capability?.calendarId || '').trim()
  if (!configuredId) return null
  const calendar = await db.get(
    `SELECT id, ghl_calendar_id, name, slot_duration, is_active
     FROM calendars
     WHERE id = ? OR ghl_calendar_id = ?
     LIMIT 1`,
    [configuredId, configuredId]
  )
  if (!calendar?.id) return null
  const activeValue = String(calendar.is_active ?? '1').trim().toLowerCase()
  if (['0', 'false', 'off'].includes(activeValue)) return null
  return calendar
}

export function buildNativeFreeSlotDays(days = [], fallbackTimezone = '') {
  const timezone = resolveTimezone(fallbackTimezone)

  return (Array.isArray(days) ? days : []).map((day) => {
    const dayTimezone = resolveTimezone(day?.timezone, timezone)
    const options = (Array.isArray(day?.slots) ? day.slots : []).flatMap((startTime) => {
      const local = DateTime.fromISO(String(startTime || ''), { setZone: true })
        .setZone(dayTimezone)
        .setLocale('es-MX')
      if (!local.isValid) return []

      return [{
        startTime: String(startTime),
        localDate: local.toISODate(),
        localTime: local.toFormat('HH:mm'),
        localLabel: local.toFormat("cccc d 'de' LLLL 'de' yyyy 'a las' h:mm a")
      }]
    })

    return {
      localDate: String(day?.date || options[0]?.localDate || '').trim() || null,
      timezone: dayTimezone,
      options
    }
  }).filter((day) => day.options.length > 0)
}

function getDepositRequirementForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  return capability && (capability.paymentMode === 'deposit' || capability.deposit?.enabled)
    ? capability.deposit
    : null
}

function getDepositPaymentMethodsForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  return {
    paymentLink: capability?.deposit?.methods?.paymentLink === true,
    bankTransfer: capability?.deposit?.methods?.bankTransfer === true
  }
}

function getAccountCurrencyLabel(accountLocale = {}) {
  const currency = String(accountLocale?.currency || '').trim().toUpperCase()
  return currency || 'moneda configurada en la cuenta'
}

function getDepositRequirementLabel(ctx = {}, config = {}) {
  return getNativeCapability(ctx, config, 'schedule_appointment') ? 'anticipo' : 'pago solicitado'
}

function formatDepositRequirement(deposit = {}, accountLocale = {}) {
  const currency = String(deposit.currency || '').trim().toUpperCase() || getAccountCurrencyLabel(accountLocale)
  if (deposit.mode === 'range') {
    const min = Number(deposit.minAmount) || 0
    const max = Number(deposit.maxAmount) || 0
    if (min > 0 && max > 0) return `entre ${min} y ${max} ${currency}`
    if (min > 0) return `desde ${min} ${currency}`
    if (max > 0) return `hasta ${max} ${currency}`
  }
  const amount = Number(deposit.amount) || 0
  return amount > 0 ? `${amount} ${currency}` : 'monto pendiente de configurar'
}

async function rejectMissingDepositIfNeeded(
  ctx,
  config = {},
  accountLocale = {},
  { appointmentRequestId = '' } = {}
) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  if (!deposit) return null
  const nativePaymentPurpose = getNativePaymentPurpose(ctx, config)
  const executionId = String(ctx.executionId || '').trim()
  const reconciliationId = executionId.startsWith('payment-resume:')
    ? executionId.slice('payment-resume:'.length).trim()
    : ''
  const paymentLabel = getDepositRequirementLabel(ctx, config)
  if (!ctx.dryRun) {
    const verification = await findVerifiedPaymentEvidence({
      database: db,
      contactId: ctx.contactId,
      agentId: config.id || ctx.agentId || null,
      requiredPurpose: nativePaymentPurpose,
      reconciliationId,
      appointmentRequestId
    })
    if (verification.ok) {
      ctx.verifiedPaymentEvidence = verification.evidence
      return null
    }
  }
  const methods = getDepositPaymentMethodsForRuntime(ctx, config)
  const collectionHints = []
  if (methods.paymentLink) collectionHints.push('manda el link de pago con create_payment_link')
  if (methods.bankTransfer) collectionHints.push('comparte los datos de transferencia y, cuando llegue la foto del comprobante, valídala con register_deposit_payment_proof')
  const collectionHint = collectionHints.length
    ? `Para cobrarlo: ${collectionHints.join('; o ')}.`
    : 'Solicita que el equipo registre el pago o pasa la conversación a una persona.'
  return {
    ok: false,
    actionCompleted: false,
    paymentEvidenceRequired: true,
    transferRequired: !ctx.dryRun && !collectionHints.length,
    error: ctx.dryRun
      ? `Falta validar el ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). En vivo se exigirá un pago confirmado o registro real; una foto sin validar o un booleano de la IA no bastan. ${collectionHint}`
      : `No existe un pago confirmado o registro verificable del ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). No se ejecutó la acción y no debes afirmar que el comprobante fue validado. ${collectionHint}`
  }
}

function buildGoalLinkPreview(targetUrl, trackingParam, goalId, linkParams = {}) {
  try {
    const parsed = new URL(targetUrl)
    parsed.searchParams.set(trackingParam, goalId)
    for (const [key, value] of Object.entries(linkParams)) {
      if (value) parsed.searchParams.set(key, value)
    }
    return parsed.toString()
  } catch {
    const separator = targetUrl.includes('?') ? '&' : '?'
    return `${targetUrl}${separator}${trackingParam}=${goalId}`
  }
}

function buildPaymentChannels(channel) {
  const normalized = String(channel || '').toLowerCase()
  return {
    email: normalized === 'email' || normalized === 'all',
    whatsapp: normalized === 'whatsapp' || normalized === 'all',
    sms: normalized === 'sms' || normalized === 'all'
  }
}

async function getPaymentContact(contactId) {
  const row = await db.get('SELECT id, full_name, email, phone FROM contacts WHERE id = ?', [contactId])
  if (!row) return null
  return { id: row.id, name: row.full_name, email: row.email, phone: row.phone }
}

const RECEIPT_MEDIA_WINDOW_HOURS = 72

// Busca la imagen o PDF ENTRANTE más reciente del contacto (WhatsApp/SMS/webchat
// y DMs de Meta) dentro de la ventana: es el comprobante que se va a validar.
async function findLatestInboundReceiptMedia(contactId) {
  if (!contactId) return null
  const sinceIso = new Date(Date.now() - RECEIPT_MEDIA_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const mediaFilter = "(LOWER(COALESCE(media_mime_type, '')) LIKE 'image/%' OR LOWER(COALESCE(media_mime_type, '')) = 'application/pdf')"

  const [whatsappRow, metaRow] = await Promise.all([
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId, sinceIso]).catch(() => null),
    db.get(`
      SELECT id, media_url, media_mime_type, COALESCE(message_timestamp, created_at) AS media_at
      FROM meta_social_messages
      WHERE contact_id = ? AND direction = 'inbound'
        AND COALESCE(media_url, '') != '' AND ${mediaFilter}
        AND COALESCE(message_timestamp, created_at) >= ?
      ORDER BY COALESCE(message_timestamp, created_at) DESC
      LIMIT 1
    `, [contactId, sinceIso]).catch(() => null)
  ])

  const candidates = [whatsappRow, metaRow].filter((row) => row?.media_url)
  if (!candidates.length) return null
  candidates.sort((a, b) => new Date(b.media_at || 0).getTime() - new Date(a.media_at || 0).getTime())
  const chosen = candidates[0]
  return { messageId: chosen.id, mediaUrl: chosen.media_url, mimeType: chosen.media_mime_type || '', receivedAt: chosen.media_at || null }
}

async function notifyHumanPriority(ctx, { reason = '', summary = '', signal = 'ready_for_human' } = {}) {
  if (ctx.dryRun || !ctx.contactId) return
  try {
    const result = await sendConversationalAgentPriorityNotification({
      contactId: ctx.contactId,
      reason,
      summary,
      signal
    })
    await recordConversationalAgentEvent({
      contactId: ctx.contactId,
      eventType: 'priority_push_notification',
      detail: { signal, sent: result?.sent || 0, skipped: Boolean(result?.skipped), reason: result?.reason || null }
    })
  } catch (error) {
    await recordConversationalAgentEvent({
      contactId: ctx.contactId,
      eventType: 'priority_push_notification_failed',
      detail: { signal, error: error.message }
    })
  }
}

async function syncNativeAppointmentCompletion({ ctx, config, appointment, calendarId }) {
  const appointmentId = String(appointment?.id || '').trim()
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  if (!ctx?.contactId || !appointmentId || !agentId) {
    throw new Error('Falta la identidad canónica para cerrar la cita')
  }
  const startTime = appointment.start_time || appointment.startTime
  const title = appointment.title || 'Cita'
  const technicalSummary = `${title} · ${startTime}`
  const digest = createHash('sha256')
    .update([ctx.contactId, agentId, appointmentId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)
  const appointmentEventId = `cae_appointment_booked_${digest}`
  const eventAlreadyRecorded = Boolean(await db.get(
    'SELECT id FROM conversational_agent_events WHERE id = ?',
    [appointmentEventId]
  ).catch(() => null))

  await setConversationSignal(ctx.contactId, 'appointment_booked', {
    reason: 'Cita agendada por el agente',
    actionSummarySource: technicalSummary,
    originalSummary: technicalSummary,
    status: 'completed',
    agentId,
    channel: ctx.channel,
    eventId: `cae_appointment_signal_${digest}`,
    strictEvent: true
  })
  await recordConversationalAgentEvent({
    eventId: appointmentEventId,
    contactId: ctx.contactId,
    eventType: 'appointment_booked',
    detail: {
      agentId,
      appointmentId,
      startTime,
      calendarId: appointment.calendar_id || appointment.calendarId || calendarId || null
    },
    throwOnError: true
  })
  if (!eventAlreadyRecorded) {
    await notifyHumanPriority(ctx, {
      reason: 'Cita agendada por el agente',
      summary: technicalSummary,
      signal: 'appointment_booked'
    })
  }
  return { completed: true }
}

async function consumeReservedDepositForExistingNativeAppointment({ ctx, config, appointment }) {
  const appointmentId = String(appointment?.id || '').trim()
  if (!appointmentId || !ctx?.contactId) return { consumed: false, reason: 'appointment_missing' }
  const request = await db.get(
    `SELECT client_request_id
     FROM appointment_creation_requests
     WHERE appointment_id = ? AND status = 'completed'
       AND client_request_id LIKE 'conv-v2-attempt:%'
     ORDER BY updated_at DESC LIMIT 1`,
    [appointmentId]
  ).catch(() => null)
  if (!request?.client_request_id) return { consumed: false, reason: 'no_payment_reservation' }

  const rows = await db.all(
    `SELECT id, detail_json
     FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = 'deposit_payment_consumed'
     ORDER BY created_at DESC LIMIT 40`,
    [ctx.contactId, config.id || ctx.agentId || '']
  ).catch(() => [])
  const matches = rows.flatMap((row) => {
    try {
      const detail = JSON.parse(row.detail_json || '{}')
      return detail.appointmentRequestId === request.client_request_id ? [{ row, detail }] : []
    } catch {
      return []
    }
  })
  if (!matches.length) return { consumed: false, reason: 'no_payment_reservation' }
  if (matches.length !== 1) throw new Error('La cita tiene más de una reserva de anticipo')
  const [{ detail }] = matches
  if (detail.status === 'consumed' && detail.appointmentId === appointmentId) {
    return { consumed: true, replayed: true }
  }
  if (detail.status !== 'reserved') {
    throw new Error('La reserva del anticipo no coincide con la cita canónica')
  }
  return consumeConversationalAppointmentDepositEvidence({
    reconciliationId: detail.reconciliationId,
    contactId: ctx.contactId,
    agentId: config.id || ctx.agentId || '',
    paymentId: detail.ledgerPaymentId,
    appointmentRequestId: request.client_request_id,
    appointmentId
  })
}

const NATIVE_APPOINTMENT_BINDING_EVENT = 'appointment_creation_binding_v2'

function nativeAppointmentDepositContract(ctx, config) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  const methods = getDepositPaymentMethodsForRuntime(ctx, config)
  const canonical = deposit
    ? {
        required: true,
        paymentPurpose: getNativePaymentPurpose(ctx, config),
        mode: String(deposit.mode || 'fixed'),
        amount: normalizedMoney(deposit.amount),
        minAmount: normalizedMoney(deposit.minAmount),
        maxAmount: normalizedMoney(deposit.maxAmount),
        currency: normalizeCurrencyCode(deposit.currency || ctx?.accountLocale?.currency || ''),
        paymentLink: methods.paymentLink === true,
        bankTransfer: methods.bankTransfer === true
      }
    : { required: false }
  return {
    required: canonical.required,
    hash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  }
}

async function reserveNativeAppointmentBinding({
  ctx,
  config,
  calendarId,
  startTime,
  endTime,
  appointmentRequestId,
  depositContract
}) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  if (!agentId || !contactId || !appointmentRequestId) {
    throw new Error('Falta la identidad durable para vincular la cita al agente')
  }
  const eventId = `cae_appointment_binding_${createHash('sha256')
    .update([agentId, appointmentRequestId].join('\u0000'))
    .digest('hex')
    .slice(0, 48)}`
  const detail = {
    agentId,
    contactId,
    calendarId,
    startTime,
    endTime,
    appointmentRequestId,
    depositRequired: depositContract.required,
    depositContractHash: depositContract.hash,
    reconciliationId: ctx.verifiedPaymentEvidence?.reconciliationId || null,
    paymentId: ctx.verifiedPaymentEvidence?.paymentId || null
  }
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [eventId, contactId, agentId, NATIVE_APPOINTMENT_BINDING_EVENT, JSON.stringify(detail)]
    )
    const stored = await db.get(
      `SELECT contact_id, agent_id, event_type, detail_json
       FROM conversational_agent_events WHERE id = ?`,
      [eventId]
    )
    let storedDetail = null
    try { storedDetail = JSON.parse(stored?.detail_json || '') } catch {}
    if (
      stored?.event_type !== NATIVE_APPOINTMENT_BINDING_EVENT ||
      String(stored?.contact_id || '') !== contactId ||
      String(stored?.agent_id || '') !== agentId ||
      JSON.stringify(storedDetail) !== JSON.stringify(detail)
    ) {
      throw new Error('El vínculo durable de la cita ya existe con datos distintos')
    }
  })
  return { eventId, detail }
}

async function findBoundNativeAppointment({ ctx, config, calendarId }) {
  const agentId = String(config?.id || ctx?.agentId || '').trim()
  const contactId = String(ctx?.contactId || '').trim()
  if (!agentId || !contactId) return null
  const rows = await db.all(
    `SELECT id, detail_json FROM conversational_agent_events
     WHERE contact_id = ? AND agent_id = ? AND event_type = ?
     ORDER BY created_at DESC LIMIT 80`,
    [contactId, agentId, NATIVE_APPOINTMENT_BINDING_EVENT]
  ).catch(() => [])
  const matches = []
  for (const row of rows) {
    let detail
    try { detail = JSON.parse(row.detail_json || '{}') } catch { continue }
    if (String(detail.calendarId || '') !== String(calendarId)) continue
    const request = await db.get(
      `SELECT client_request_id, appointment_id, status
       FROM appointment_creation_requests WHERE client_request_id = ?`,
      [detail.appointmentRequestId]
    ).catch(() => null)
    if (request?.status !== 'completed' || !request.appointment_id) continue
    const appointment = await db.get(
      `SELECT id, calendar_id, contact_id, title, start_time, end_time, appointment_status, status, deleted_at
       FROM appointments WHERE id = ?`,
      [request.appointment_id]
    ).catch(() => null)
    const appointmentStatus = String(appointment?.appointment_status || appointment?.status || '').toLowerCase()
    if (
      !appointment || appointment.deleted_at ||
      String(appointment.contact_id || '') !== contactId ||
      String(appointment.calendar_id || '') !== String(calendarId) ||
      new Date(appointment.start_time).getTime() < Date.now() ||
      ['cancelled', 'canceled', 'noshow', 'deleted'].includes(appointmentStatus)
    ) continue
    matches.push({ appointment, request, detail })
  }
  if (matches.length > 1) throw new Error('Hay más de una cita vinculada al mismo agente, calendario y horario')
  return matches[0] || null
}

export function createConversationalTools(ctx) {
  const { config } = ctx
  const runtimeConfig = getToolRuntimeConfig(ctx, config)
  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  const paymentCapability = getNativeCapability(ctx, config, 'collect_payment')
  const linkCapability = getNativeCapability(ctx, config, 'send_link')
  const handoffCapability = getNativeCapability(ctx, config, 'handoff_human')
  const customCapability = getNativeCapability(ctx, config, 'custom_goal')
  const nativePaymentPurpose = getNativePaymentPurpose(ctx, config)

  const getConversationHistoryTool = tool({
    name: 'get_conversation_history',
    description: 'Consulta mensajes omitidos del mismo hilo sin otra IA. Usa mode=previous para la página inmediatamente anterior, oldest para empezar por el inicio, offset para saltar a una posición contada desde el mensaje omitido más antiguo, o search para buscar texto literal. Reutiliza nextCursor sólo con el mismo mode y query. Es sólo lectura y el servidor la liga al contacto y canal actuales.',
    parameters: z.object({
      mode: z.enum(['previous', 'oldest', 'offset', 'search']).describe('Forma de acceso al historial omitido'),
      cursor: z.string().nullable().describe('Cursor opaco devuelto por una llamada anterior del mismo modo y búsqueda; null para iniciar'),
      offset: z.number().int().min(0).nullable().describe('Posición desde el mensaje omitido más antiguo; sólo para mode=offset, null en los demás modos'),
      query: z.string().max(200).nullable().describe('Texto literal a buscar; sólo para mode=search, null en los demás modos'),
      limit: z.number().int().min(1).max(30).describe('Cantidad máxima de mensajes enteros a consultar')
    }),
    execute: async ({ mode, cursor, offset, query, limit }) => {
      if (typeof ctx.loadConversationHistoryPage !== 'function') {
        return { ok: false, error: 'No hay historial anterior disponible en esta conversación.' }
      }
      try {
        return await ctx.loadConversationHistoryPage({ mode, cursor, offset, query, limit })
      } catch (error) {
        logger.warn(`[Agente conversacional] No se pudo consultar una página anterior del hilo: ${error.message}`)
        return { ok: false, error: 'No se pudo consultar el historial anterior en este momento.' }
      }
    }
  })

  const getBusinessProfileTool = tool({
    name: 'get_business_profile',
    description: 'Devuelve los datos reales y estructurados del negocio: giro, oferta, ubicación, horarios, teléfonos, pagos, facturación, precios resumidos y calendarios. Úsala antes de responder preguntas del negocio.',
    parameters: z.object({}),
    execute: async () => {
      const [hlRow, userRow, calendars, businessProfile] = await Promise.all([
        db.get('SELECT location_data FROM highlevel_config LIMIT 1').catch(() => null),
        db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null),
        db.all("SELECT id, name, is_active FROM calendars WHERE is_active = 1 ORDER BY name ASC LIMIT 20").catch(() => []),
        getBusinessProfileSnapshot().catch(() => null)
      ])

      let location = null
      try {
        location = hlRow?.location_data ? JSON.parse(hlRow.location_data) : null
      } catch { /* JSON inválido */ }

      return {
        ok: true,
        business: {
          name: businessProfile?.businessName || businessProfile?.profile?.businessName || location?.name || userRow?.business_name || null,
          industry: businessProfile?.industry || businessProfile?.profile?.industry || null,
          businessType: businessProfile?.businessType || businessProfile?.profile?.businessType || null,
          summary: businessProfile?.summary || null,
          offeringsSummary: businessProfile?.offeringsSummary || null,
          pricingSummary: businessProfile?.pricingSummary || null,
          locationSummary: businessProfile?.locationSummary || null,
          paymentSummary: businessProfile?.paymentSummary || null,
          contactSummary: businessProfile?.contactSummary || null,
          address: location?.address || null,
          city: location?.city || null,
          phone: location?.phone || null,
          email: location?.email || null,
          timezone: location?.timezone || null,
          structuredProfile: businessProfile?.profile || null
        },
        promptParameters: businessProfile?.promptParameters || null,
        profileStatus: businessProfile?.extractionStatus || businessProfile?.status || 'empty',
        calendars: (calendars || []).map((cal) => ({ name: cal.name }))
      }
    }
  })

  const listProductsTool = tool({
    name: 'list_products',
    description: 'Lista los servicios/productos reales del negocio con su valor (precio). Úsala antes de hablar de valor o de lo que incluye un servicio. Nunca inventes valores.',
    parameters: z.object({
      query: z.string().nullable().describe('Texto para filtrar por nombre (opcional)')
    }),
    execute: async ({ query }) => {
      const params = []
      let sql = `
        SELECT p.id, p.ghl_product_id, p.name, p.description,
               pp.id AS price_id, pp.ghl_price_id, pp.name AS price_name,
               pp.amount, pp.currency, pp.type AS price_type
        FROM products p
        LEFT JOIN product_prices pp ON pp.product_id = p.id
        WHERE p.is_active = 1`
      if (paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.productId) {
        sql += ' AND (p.id = ? OR p.ghl_product_id = ?)'
        params.push(paymentCapability.productId, paymentCapability.productId)
      }
      if (paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.priceId) {
        sql += ' AND (pp.id = ? OR pp.ghl_price_id = ?)'
        params.push(paymentCapability.priceId, paymentCapability.priceId)
      }
      if (query) {
        sql += ' AND LOWER(p.name) LIKE ?'
        params.push(`%${String(query).toLowerCase()}%`)
      }
      sql += ' ORDER BY p.name ASC LIMIT 60'

      const rows = await db.all(sql, params)
      const byProduct = new Map()
      for (const row of rows) {
        if (!byProduct.has(row.id)) {
          byProduct.set(row.id, {
            name: row.name,
            description: row.description || null,
            ...(paymentCapability && paymentCapability.paymentMode !== 'deposit'
              ? { configuredForPayment: true }
              : {}),
            prices: []
          })
        }
        if (row.amount !== null && row.amount !== undefined) {
          byProduct.get(row.id).prices.push({
            ...(paymentCapability && paymentCapability.paymentMode !== 'deposit'
              ? { configuredForPayment: true }
              : {}),
            name: row.price_name || null,
            amount: row.amount,
            currency: row.currency || ctx.accountLocale?.currency || null,
            type: row.price_type || 'one_time'
          })
        }
      }
      const products = [...byProduct.values()]
      return { ok: true, total: products.length, products }
    }
  })

  const getContactProfileTool = tool({
    name: 'get_contact_profile',
    description: handoffCapability?.pastClientsToHuman
      ? 'Consulta obligatoria antes de seguir: devuelve datos reales del contacto, citas próximas y evidencia factual de cliente previo. Si pastClientEvidence.isPastClient es true, usa send_to_human; no sigas vendiendo ni interrogando.'
      : 'Devuelve los datos reales del contacto con el que conversas (nombre, teléfono, email, datos personalizados) y sus citas próximas. Úsala para no pedir datos que ya existen y para saber si ya tiene cita agendada.',
    parameters: z.object({}),
    execute: async () => {
      const contact = await db.get(`
        SELECT id, full_name, first_name, last_name, phone, email, custom_fields, total_paid, purchases_count
        FROM contacts WHERE id = ?
      `, [ctx.contactId])
      if (!contact) return { ok: false, error: 'Contacto no encontrado' }

      const nowIso = new Date().toISOString()
      const [appointments, pastAppointments, paymentRows] = await Promise.all([
        db.all(`
          SELECT id, title, start_time, end_time, appointment_status, status
          FROM appointments
          WHERE contact_id = ? AND deleted_at IS NULL AND start_time >= ?
          ORDER BY start_time ASC LIMIT 5
        `, [ctx.contactId, nowIso]),
        db.all(`
              SELECT title, start_time, end_time, appointment_status, status
              FROM appointments
              WHERE contact_id = ? AND deleted_at IS NULL AND start_time < ?
                AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
              ORDER BY start_time DESC LIMIT 10
            `, [ctx.contactId, nowIso]).catch(() => []),
        db.all(`
              SELECT amount, currency, status, payment_mode, payment_provider,
                     COALESCE(paid_at, date, created_at) AS payment_at
              FROM payments
              WHERE contact_id = ?
              ORDER BY COALESCE(paid_at, date, created_at) DESC
              LIMIT 100
            `, [ctx.contactId]).catch(() => [])
      ])

      let customFields = null
      try {
        customFields = contact.custom_fields ? JSON.parse(contact.custom_fields) : null
      } catch { /* texto plano */ customFields = contact.custom_fields }

      const successfulPayments = (paymentRows || []).filter((payment) => {
            const status = String(payment.status || '').trim().toLowerCase()
            const rawMode = String(payment.payment_mode || '').trim().toLowerCase()
            const normalizedMode = rawMode.replace(/_/g, ' ')
            return SUCCESS_PAYMENT_STATUSES.has(status) &&
              !NON_LIVE_PAYMENT_MODES.has(rawMode) &&
              !NON_LIVE_PAYMENT_MODES.has(normalizedMode)
          }).slice(0, 10).map((payment) => ({
            amount: Number(payment.amount) || 0,
            currency: normalizeCurrencyCode(payment.currency || ctx.accountLocale?.currency),
            status: String(payment.status || '').trim().toLowerCase(),
            paidAt: payment.payment_at || null,
            provider: payment.payment_provider || null
          }))
      const visiblePastAppointments = (pastAppointments || []).map((appointment) => ({
            title: appointment.title || null,
            startTime: appointment.start_time,
            endTime: appointment.end_time,
            status: appointment.appointment_status || appointment.status || null
          }))

      return {
        ok: true,
        contact: {
          fullName: contact.full_name || null,
          phone: contact.phone || null,
          email: contact.email || null,
          customFields
        },
        upcomingAppointments: appointments.map((appt) => ({
          title: appt.title,
          startTime: appt.start_time,
          endTime: appt.end_time,
          status: appt.appointment_status || appt.status
        })),
        pastClientEvidence: {
          isPastClient: successfulPayments.length > 0 || visiblePastAppointments.length > 0,
          successfulPayments,
          pastAppointments: visiblePastAppointments
        }
      }
    }
  })

  const getFreeSlotsForAgentTool = tool({
    name: 'get_free_slots',
    description: [
      scheduleCapability?.allowOverlaps
        ? 'Obtiene horarios reales del calendario blindado. El negocio permite empalmar citas dentro de sus horas de atención.'
        : 'Obtiene horarios reales y libres del calendario blindado; no devuelve horarios ocupados.',
      'Cada opción incluye localLabel/localDate/localTime ya calculados en la zona del negocio: usa esos campos para hablar con la persona y NO conviertas el horario por tu cuenta.',
      'Para agendar, pasa options[].startTime exactamente como aparece, sin recalcularlo ni reconstruirlo.'
    ].join(' '),
    parameters: z.object({
      startDate: z.string().describe('Fecha inicial YYYY-MM-DD en la zona horaria del negocio'),
      endDate: z.string().describe('Fecha final YYYY-MM-DD en la zona horaria del negocio')
    }),
    execute: async ({ startDate, endDate }) => {
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const effectiveCalendarId = nativeCalendar?.id || null
      if (!effectiveCalendarId) {
        return { ok: false, total: 0, slots: [], error: 'El calendario blindado de la capacidad no existe o ya no está activo. Pasa la conversación a una persona.' }
      }
      const overlapsAllowed = scheduleCapability?.allowOverlaps === true
      const accountTimezone = await getAccountTimezone()
      const rawSlots = await getLocalFreeSlots(effectiveCalendarId, startDate, endDate, accountTimezone, {
        ignoreAppointmentConflicts: overlapsAllowed,
        appointmentLimit: overlapsAllowed ? undefined : 1
      })
      const slots = buildNativeFreeSlotDays(rawSlots, accountTimezone)

      if (!Array.isArray(slots) || !slots.length) {
        return {
          ok: true,
          total: 0,
          slots: [],
          note: 'Sin horarios disponibles en ese rango (o el calendario no existe).'
        }
      }

      return {
        ok: true,
        total: slots.reduce((total, day) => total + (
          Array.isArray(day.options)
            ? day.options.length
            : (Array.isArray(day.slots) ? day.slots.length : 0)
        ), 0),
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        note: [
          overlapsAllowed
            ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
            : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
          'Muestra localLabel a la persona y usa options[].startTime sin modificar para reservar; la hora local ya está calculada por Ristak.'
        ].filter(Boolean).join(' '),
        slots
      }
    }
  })

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: 'Agenda una cita real en el calendario blindado de esta capacidad. Copia exactamente options[].startTime devuelto por get_free_slots; no uses localTime ni conviertas zonas horarias. El servidor vuelve a comprobar el horario y evita carreras.',
    parameters: z.object({
      startTime: z.string().describe('Valor exacto de options[].startTime devuelto por get_free_slots; no recalcular ni convertir'),
      title: z.string().nullable().describe('Título corto de la cita; null usa el título seguro por defecto'),
      notes: z.string().nullable().describe('Resumen breve de lo que busca la persona; null usa una nota segura')
    }),
    execute: async (args) => {
      const {
        startTime,
        title,
        notes
      } = args || {}
      const nativeCalendar = await resolveNativeScheduleCalendar(scheduleCapability)
      const calendarId = nativeCalendar?.id || null
      if (!calendarId) {
        return { ok: false, actionCompleted: false, error: 'El calendario blindado de la capacidad no existe o ya no está activo. No se agendó nada; pasa la conversación a una persona.' }
      }
      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, actionCompleted: false, error: 'startTime inválido: usa exactamente un slot devuelto por get_free_slots. No se agendó nada.' }
      }

      const nativeExecutionId = String(ctx.executionId || '').trim()
      const nativeOverlapsAllowed = scheduleCapability?.allowOverlaps === true
      const nativeDurationMinutes = Number(nativeCalendar?.slot_duration) > 0 ? Number(nativeCalendar.slot_duration) : 60
      if (!ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo identificar de forma segura el mensaje que pidió la cita. No se agendó nada; pasa la conversación a una persona.'
        }
      }
      const nativeClientRequestId = buildConversationalSlotRequestId(calendarId, start.toISOString(), {
        allowOverlaps: nativeOverlapsAllowed,
        contactId: ctx.contactId,
        channel: ctx.channel,
        executionId: nativeExecutionId
      })
      // El replay exacto manda sobre el guard de cualquier cita futura: conserva
      // el contrato que informa reprogramación/cancelación de ese mismo intento.
      if (!ctx.dryRun) {
        const provisionalEnd = new Date(start.getTime() + nativeDurationMinutes * 60000)
        const changedReplay = await inspectChangedAppointmentCreationReplay({
          clientRequestId: nativeClientRequestId,
          payload: {
            calendarId,
            contactId: ctx.contactId,
            startTime: start.toISOString(),
            endTime: provisionalEnd.toISOString(),
            source: 'conversational_agent_v2'
          }
        })
        if (changedReplay?.idempotencyReplay?.canonicalChanged) {
          const replayState = changedReplay.idempotencyReplay.state
          const replayError = replayState === 'appointment_rescheduled'
            ? 'La cita vinculada a este intento ya fue reprogramada. No se reservó otra vez el horario anterior; usa únicamente la fecha y hora vigentes que aparecen en existingAppointment.'
            : 'La cita vinculada a este intento ya no está activa. No se creó una cita nueva; ofrece volver a consultar horarios o pasa la conversación a una persona.'
          const replayAction = pushAction(ctx, 'book_appointment', {
            calendarId,
            startTime: start.toISOString(),
            endTime: provisionalEnd.toISOString(),
            clientRequestId: nativeClientRequestId,
            confirmationEvidence: { nativeToolDecision: true }
          })
          settleAction(replayAction, 'error', {
            appointmentCreated: false,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            canonicalAppointment: {
              calendarId: changedReplay.calendarId || null,
              startTime: changedReplay.startTime || null,
              endTime: changedReplay.endTime || null,
              status: changedReplay.appointmentStatus || changedReplay.status || null
            },
            error: replayError
          })
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            existingAppointment: {
              title: changedReplay.title || 'Cita',
              startTime: changedReplay.startTime || null,
              endTime: changedReplay.endTime || null,
              status: changedReplay.appointmentStatus || changedReplay.status || null
            },
            error: replayError
          }
        }
      }

      const depositContract = nativeAppointmentDepositContract(ctx, config)
      // Sólo una cita unida durablemente al mismo agente y a su request canónico
      // puede declararse propia; una cita propia en otro slot también bloquea una
      // segunda alta y repara el cierre.
      let existing = null
      let boundExisting = null
      if (ctx.contactId) {
        const candidates = await db.all(`
          SELECT id, calendar_id, contact_id, title, start_time, end_time, appointment_status, status, deleted_at
          FROM appointments
          WHERE contact_id = ? AND calendar_id = ? AND deleted_at IS NULL AND start_time >= ?
            AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'deleted')
          ORDER BY start_time ASC LIMIT 20
        `, [ctx.contactId, calendarId, new Date().toISOString()])
        const exactSlotExisting = (candidates || []).find((appointment) => (
          Math.abs(new Date(appointment.start_time).getTime() - start.getTime()) < 60000
        )) || null
        try {
          const ownedExisting = await findBoundNativeAppointment({
            ctx,
            config,
            calendarId
          })
          if (ownedExisting) {
            existing = ownedExisting.appointment
            boundExisting = ownedExisting
          } else {
            existing = exactSlotExisting
          }
        } catch (error) {
          logger.error(`[Agente conversacional] No se pudo probar el vínculo de las citas existentes: ${error.message}`)
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'No se pudo comprobar de forma única qué cita pertenece a este agente. No se agendó nada; pasa la conversación a una persona.'
          }
        }
      }
      if (existing) {
        if (!boundExisting) {
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            verifiedExistingAction: false,
            transferRequired: true,
            existingAppointment: {
              title: existing.title || 'Cita',
              startTime: existing.start_time,
              endTime: existing.end_time,
              status: existing.appointment_status || existing.status || null
            },
            error: 'Ya existe una cita real, pero no coincide con el vínculo y contrato actuales de este agente. No se creó ni se cerró nada; pasa la conversación a una persona.'
          }
        }
        existing = boundExisting.appointment
        const existingClientRequestId = boundExisting.request.client_request_id
        const existingAction = pushAction(ctx, 'book_appointment', {
          calendarId: existing.calendar_id,
          startTime: existing.start_time,
          endTime: existing.end_time,
          appointmentId: existing.id,
          clientRequestId: existingClientRequestId,
          verifiedExistingAction: true,
          effect: { liveEffect: 'REUTILIZA la cita real existente y repara su cierre interno', marksObjectiveCompleted: true }
        })
        if (boundExisting.detail.depositRequired === true) {
          try {
            const depositConsumption = await consumeReservedDepositForExistingNativeAppointment({ ctx, config, appointment: existing })
            if (!depositConsumption?.consumed) {
              throw new Error('La cita vinculada no conserva una reserva de anticipo válida')
            }
          } catch (error) {
            settleAction(existingAction, 'error', {
              appointmentCreated: false,
              verifiedExistingAction: false,
              transferRequired: true,
              error: error.message
            })
            return {
              ok: false,
              actionCompleted: false,
              alreadyBooked: true,
              verifiedExistingAction: false,
              transferRequired: true,
              error: 'La cita existe, pero no se pudo demostrar que su anticipo siga válido y ligado a ella. No se cerró el objetivo; pasa la conversación a una persona.'
            }
          }
        }
        let completionSyncWarning = false
        try {
          await syncNativeAppointmentCompletion({
            ctx,
            config,
            appointment: existing,
            calendarId: existing.calendar_id
          })
        } catch (error) {
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${existing.id} ya existía, pero no se pudo reparar su cierre: ${error.message}`)
        }
        settleAction(existingAction, 'ok', {
          appointmentId: existing.id,
          calendarId: existing.calendar_id,
          startTime: existing.start_time,
          appointmentCreated: false,
          verifiedExistingAction: true,
          objectiveCompleted: !completionSyncWarning,
          completionSyncWarning
        })
        return {
          ok: true,
          actionCompleted: true,
          alreadyBooked: true,
          verifiedExistingAction: true,
          appointment: {
            title: existing.title || 'Cita',
            startTime: existing.start_time,
            endTime: existing.end_time,
            status: existing.appointment_status || existing.status || 'confirmed'
          },
          ...(completionSyncWarning
            ? { completionSyncWarning: true, note: 'La cita real ya existe y no se duplicó; el cierre interno seguirá reintentándose.' }
            : { note: 'La cita real ya existía y su cierre quedó confirmado; no crees otra.' })
        }
      }

      const calendar = nativeCalendar
      if (!calendar) return { ok: false, actionCompleted: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real. No se agendó nada.' }

      const durationMinutes = Number(calendar.slot_duration) > 0 ? Number(calendar.slot_duration) : 60
      const overlapsAllowed = nativeOverlapsAllowed
      const clientRequestId = nativeClientRequestId

      const depositError = await rejectMissingDepositIfNeeded(
        ctx,
        config,
        ctx.accountLocale,
        { appointmentRequestId: clientRequestId || '' }
      )
      if (depositError) return depositError

      // Candado funcional anti-cita-inventada: el horario debe ser un slot REAL del
      // calendario (dentro del horario de atención, en el futuro y no bloqueado).
      // Validamos la FORMA del horario ignorando la ocupación: la política de empalme
      // la aplica el chequeo dedicado de más abajo (que da un mensaje específico).
      // Aquí sólo atajamos horas inventadas, fuera de horario o en el pasado, sin
      // importar en qué turno se ofreció el slot (revalidación al momento de agendar).
      const startMs = start.getTime()
      const businessTimezone = await getAccountTimezone()
      const confirmationEvidence = { ok: true, evidenceVerified: false, nativeToolDecision: true }
      if (!confirmationEvidence.ok) return confirmationEvidence

      const slotWindowStart = normalizeDateOnlyInTimezone(new Date(startMs - 24 * 60 * 60 * 1000).toISOString(), businessTimezone)
      const slotWindowEnd = normalizeDateOnlyInTimezone(new Date(startMs + 24 * 60 * 60 * 1000).toISOString(), businessTimezone)
      const slotValidation = await revalidateAppointmentSlot({
        calendarId,
        requestedStartTime: start.toISOString(),
        windowStart: slotWindowStart,
        windowEnd: slotWindowEnd,
        lookupSlots: getLocalFreeSlots
      })
      if (!slotValidation.ok) {
        if (slotValidation.availabilityCheckFailed) {
          logger.warn(`[Agente conversacional] Revalidación de slot bloqueada: ${slotValidation.technicalError || slotValidation.error}`)
        }
        return slotValidation
      }
      // Snap al slot exacto para no arrastrar deriva de segundos del modelo.
      start.setTime(new Date(slotValidation.matchedStartTime).getTime())

      const end = new Date(start.getTime() + durationMinutes * 60000)

      // El controller debe recibir primero la llave durable: así un retry
      // idéntico reproduce la cita ya creada antes de volver a evaluar conflicto.
      // La primera creación sí vuelve a comprobar cupo dentro del lock transaccional.
      const contact = await db.get('SELECT full_name, phone FROM contacts WHERE id = ?', [ctx.contactId])
      const finalTitle = title || `Cita - ${contact?.full_name || contact?.phone || 'Contacto'}`
      const action = pushAction(ctx, 'book_appointment', {
        calendarId, startTime: start.toISOString(), endTime: end.toISOString(), title: finalTitle,
        confirmationEvidence: { nativeToolDecision: true },
        ...(clientRequestId ? { clientRequestId } : {}),
        effect: { liveEffect: 'AGENDARÍA UNA CITA REAL y marcaría el objetivo como CUMPLIDO', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          wouldMarkObjectiveCompleted: true,
          calendarId,
          startTime: start.toISOString()
        })
        return {
          ok: true,
          simulated: true,
          wouldMarkObjectiveCompleted: true,
          appointment: {
            title: finalTitle,
            startTime: start.toISOString(),
            endTime: end.toISOString()
          }
        }
      }

      let depositReservation = null
      if (ctx.verifiedPaymentEvidence?.paymentPurpose === 'appointment_deposit') {
        try {
          depositReservation = await reserveConversationalAppointmentDepositEvidence({
            reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
            contactId: ctx.contactId,
            agentId: config.id || ctx.agentId || '',
            paymentId: ctx.verifiedPaymentEvidence.paymentId,
            appointmentRequestId: clientRequestId
          })
        } catch (error) {
          const reservationError = {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'El anticipo verificado ya está reservado para otra cita o perdió su vínculo seguro. No se agendó nada; pasa la conversación a una persona.'
          }
          settleAction(action, 'error', { error: error.message, transferRequired: true })
          return reservationError
        }
      }

      const releaseDepositReservationAfterDefinitiveFailure = async (reason) => {
        if (!depositReservation?.reserved || !ctx.verifiedPaymentEvidence) return
        const request = await db.get(
          'SELECT status FROM appointment_creation_requests WHERE client_request_id = ?',
          [clientRequestId]
        ).catch(() => null)
        // processing es incierto: conservar la reserva hasta que el retry exacto
        // reconcilie si alcanzó a existir una cita. completed nunca se libera.
        if (request?.status === 'processing' || request?.status === 'completed') return
        await releaseConversationalAppointmentDepositEvidence({
          reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
          contactId: ctx.contactId,
          agentId: config.id || ctx.agentId || '',
          paymentId: ctx.verifiedPaymentEvidence.paymentId,
          appointmentRequestId: clientRequestId,
          reason
        }).catch((error) => {
          logger.warn(`[Agente conversacional] No se pudo liberar la reserva del anticipo: ${error.message}`)
        })
      }

      try {
        await reserveNativeAppointmentBinding({
          ctx,
          config,
          calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          appointmentRequestId: clientRequestId,
          depositContract
        })
      } catch (error) {
        await releaseDepositReservationAfterDefinitiveFailure('appointment_binding_failed')
        settleAction(action, 'error', { error: error.message, transferRequired: true })
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo guardar el vínculo seguro entre esta conversación y la cita. No se agendó nada; pasa la conversación a una persona.'
        }
      }

      // Renueva y vuelve a comprobar la propiedad de la reserva justo antes de
      // entrar al controller. Si otro recovery tomó una lease vencida mientras
      // se preparaba el vínculo, este proceso viejo queda cercado y no crea una
      // cita con un anticipo que ya pertenece a otro intento.
      if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
        try {
          depositReservation = await reserveConversationalAppointmentDepositEvidence({
            reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
            contactId: ctx.contactId,
            agentId: config.id || ctx.agentId || '',
            paymentId: ctx.verifiedPaymentEvidence.paymentId,
            appointmentRequestId: clientRequestId
          })
        } catch (error) {
          settleAction(action, 'error', { error: error.message, transferRequired: true })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'La reserva segura del anticipo cambió antes de crear la cita. No se agendó nada; pasa la conversación a una persona.'
          }
        }
      }

      let toolResult
      try {
        const result = await invokeController(createAppointment, {
          body: {
            calendarId,
            contactId: ctx.contactId,
            title: finalTitle,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            notes: notes || 'Agendada por el agente conversacional',
            clientRequestId,
            strictAvailabilityCheck: true,
            source: 'conversational_agent_v2',
            ignoreAppointmentConflicts: overlapsAllowed,
            ...(depositReservation?.reserved
              ? {
                  depositReservationEventId: depositReservation.eventId,
                  depositReservationClaimToken: depositReservation.claimToken,
                  depositReservationAgentId: config.id || ctx.agentId || ''
                }
              : {})
          }
        })
        toolResult = toToolResult(result, (data) => ({
          id: data?.id,
          calendarId: data?.calendarId || data?.calendar_id,
          title: data?.title,
          startTime: data?.startTime || data?.start_time,
          endTime: data?.endTime || data?.end_time,
          status: data?.appointmentStatus || data?.appointment_status || data?.status,
          idempotencyReplay: data?.idempotencyReplay || null
        }))
        if (result.statusCode >= 400 || !toolResult.ok || !toolResult.data?.id) {
          await releaseDepositReservationAfterDefinitiveFailure(`appointment_controller_${result.statusCode || 'failed'}`)
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: result.statusCode >= 500,
            statusCode: result.statusCode,
            error: `No se pudo agendar la cita y no debes afirmar que quedó confirmada.${toolResult.error ? ` ${toolResult.error}` : ''}`
          }
          settleAction(action, 'error', {
            statusCode: result.statusCode,
            error: errorResult.error,
            transferRequired: errorResult.transferRequired
          })
          return errorResult
        }
        if (toolResult.data?.idempotencyReplay?.canonicalChanged) {
          const replayState = toolResult.data.idempotencyReplay.state
          if (replayState === 'appointment_rescheduled' && toolResult.data.id) {
            let completionSyncWarning = false
            try {
              if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
                await consumeConversationalAppointmentDepositEvidence({
                  reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
                  contactId: ctx.contactId,
                  agentId: config.id || ctx.agentId || '',
                  paymentId: ctx.verifiedPaymentEvidence.paymentId,
                  appointmentRequestId: clientRequestId,
                  appointmentId: toolResult.data.id
                })
              }
              await syncNativeAppointmentCompletion({
                ctx,
                config,
                appointment: {
                  id: toolResult.data.id,
                  calendarId: toolResult.data.calendarId,
                  title: toolResult.data.title || finalTitle,
                  startTime: toolResult.data.startTime,
                  endTime: toolResult.data.endTime,
                  status: toolResult.data.status
                },
                calendarId: toolResult.data.calendarId
              })
            } catch (error) {
              completionSyncWarning = true
              logger.error(`[Agente conversacional] La cita reprogramada ${toolResult.data.id} existe, pero falló su cierre durable: ${error.message}`)
            }
            settleAction(action, 'ok', {
              appointmentCreated: false,
              appointmentRescheduled: true,
              verifiedExistingAction: true,
              objectiveCompleted: !completionSyncWarning,
              completionSyncWarning,
              canonicalAppointment: {
                calendarId: toolResult.data.calendarId || null,
                startTime: toolResult.data.startTime || null,
                endTime: toolResult.data.endTime || null,
                status: toolResult.data.status || null
              }
            })
            return {
              ok: true,
              actionCompleted: true,
              alreadyBooked: true,
              appointmentRescheduled: true,
              appointment: {
                title: toolResult.data.title || finalTitle,
                startTime: toolResult.data.startTime || null,
                endTime: toolResult.data.endTime || null,
                status: toolResult.data.status || null
              },
              note: 'La cita ya existía y fue reprogramada; confirma únicamente estos datos canónicos y no reserves el horario anterior.'
            }
          }
          if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
            await releaseConversationalAppointmentDepositEvidence({
              reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
              contactId: ctx.contactId,
              agentId: config.id || ctx.agentId || '',
              paymentId: ctx.verifiedPaymentEvidence.paymentId,
              appointmentRequestId: clientRequestId,
              reason: replayState
            }).catch((error) => {
              logger.warn(`[Agente conversacional] No se pudo liberar el anticipo de una cita inactiva: ${error.message}`)
            })
          }
          const replayError = replayState === 'appointment_rescheduled'
            ? 'La cita vinculada a este intento ya fue reprogramada. No se reservó otra vez el horario anterior; usa únicamente la fecha y hora vigentes que aparecen en existingAppointment.'
            : 'La cita vinculada a este intento ya no está activa. No se creó una cita nueva; ofrece volver a consultar horarios o pasa la conversación a una persona.'
          settleAction(action, 'error', {
            appointmentCreated: false,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            canonicalAppointment: {
              calendarId: toolResult.data.calendarId || null,
              startTime: toolResult.data.startTime || null,
              endTime: toolResult.data.endTime || null,
              status: toolResult.data.status || null
            },
            error: replayError
          })
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            appointmentRescheduled: replayState === 'appointment_rescheduled',
            existingAppointment: {
              title: toolResult.data.title || finalTitle,
              startTime: toolResult.data.startTime || null,
              endTime: toolResult.data.endTime || null,
              status: toolResult.data.status || null
            },
            error: replayError
          }
        }
      } catch (error) {
        logger.error(`[Agente conversacional] Falló la creación real de la cita: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo crear la cita. No se agendó nada y no debes afirmar lo contrario; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          transferRequired: true
        })
        return errorResult
      }

      let completionSyncWarning = false
      if (toolResult.ok) {
        try {
          if (depositReservation?.reserved && ctx.verifiedPaymentEvidence) {
            await consumeConversationalAppointmentDepositEvidence({
              reconciliationId: ctx.verifiedPaymentEvidence.reconciliationId,
              contactId: ctx.contactId,
              agentId: config.id || ctx.agentId || '',
              paymentId: ctx.verifiedPaymentEvidence.paymentId,
              appointmentRequestId: clientRequestId,
              appointmentId: toolResult.data.id
            })
          }
          await syncNativeAppointmentCompletion({
            ctx,
            config,
            appointment: {
              id: toolResult.data.id,
              calendarId,
              title: toolResult.data.title || finalTitle,
              startTime: toolResult.data.startTime || start.toISOString(),
              endTime: toolResult.data.endTime || end.toISOString(),
              status: toolResult.data.status || 'confirmed'
            },
            calendarId
          })
        } catch (error) {
          completionSyncWarning = true
          logger.error(`[Agente conversacional] La cita ${toolResult.data?.id} sí se creó, pero falló la sincronización durable del cierre: ${error.message}`)
        }
      }
      settleAction(action, 'ok', {
        appointmentId: toolResult.data?.id || null,
        calendarId,
        startTime: start.toISOString(),
        appointmentCreated: true,
        objectiveCompleted: !completionSyncWarning,
        completionSyncWarning
      })
      return {
        ok: true,
        actionCompleted: true,
        appointment: {
          title: toolResult.data?.title || finalTitle,
          startTime: toolResult.data?.startTime || start.toISOString(),
          endTime: toolResult.data?.endTime || end.toISOString(),
          status: toolResult.data?.status || 'confirmed'
        },
        ...(completionSyncWarning
          ? { completionSyncWarning: true, note: 'La cita sí fue creada. No la repitas; el cierre interno necesita revisión humana.' }
          : {})
      }
    }
  })

  const markReadyTool = tool({
    name: 'mark_ready_to_advance',
    description: `Marca como cumplido el objetivo propio configurado: ${customCapability?.description || 'objetivo personalizado'}. Registra el resultado y entrega el seguimiento al equipo.`,
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué condición concreta del objetivo propio ya se cumplió'),
      resumen: z.string().describe('Resumen breve y factual del resultado'),
      urgencia: z.enum(['baja', 'media', 'alta']).nullable().describe('Urgencia para el seguimiento humano; null usa media'),
      siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el equipo')
    }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso }) => {
      const resolvedUrgency = urgencia || 'media'
      const signal = 'ready_for_human'
      const action = pushAction(ctx, 'mark_ready_to_advance', {
        signal,
        intencionDetectada,
        urgencia: resolvedUrgency,
        effect: { liveEffect: 'MARCARÍA el objetivo como CUMPLIDO y pasaría el chat a un humano (el bot deja de responder)', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        })
        return {
          ok: true,
          simulated: true,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        const committedHandoff = await commitNativeHandoff({
          ctx,
          config,
          capability: handoffCapability,
          signal,
          signalOptions: {
            reason: `${intencionDetectada} (urgencia ${resolvedUrgency})`,
            summary: resumen,
            actionSummarySource: resumen,
            originalSummary: resumen,
            status: 'completed'
          },
          assignmentEventSource: 'custom_goal_completed'
        })
        assignment = committedHandoff.assignment
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el objetivo cumplido: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: error?.code
            ? error.message
            : 'No se pudo registrar el objetivo como cumplido. No afirmes que se transfirió ni que terminó; requiere revisión humana.'
        }
        settleAction(action, 'error', { error: errorResult.error, transferRequired: true })
        return errorResult
      }

      const postCommitWarnings = []
      const runPostCommitStep = async (label, callback) => {
        try {
          await callback()
        } catch (error) {
          postCommitWarnings.push(label)
          logger.warn(`[Agente conversacional] Objetivo ${signal} sí quedó registrado, pero falló ${label}: ${error.message}`)
        }
      }
      await runPostCommitStep('priority_notification', () => notifyHumanPriority(ctx, {
        reason: intencionDetectada,
        summary: resumen,
        signal
      }))
      await runPostCommitStep('objective_event', () => recordConversationalAgentEvent({
        contactId: ctx.contactId,
        eventType: 'objective_completed',
        detail: {
          agentId: config.id || ctx.agentId || null,
          signal,
          kind: 'ready_for_human',
          intencionDetectada,
          urgencia: resolvedUrgency,
          siguientePaso: siguientePaso || null
        }
      }))
      settleAction(action, 'ok', {
        signal,
        objectiveCompleted: true,
        ...(assignment.assigned
          ? {
              assignedUserId: assignment.assignedUserId,
              assignedUserName: assignment.userName,
              assignmentReused: assignment.alreadyAssigned
            }
          : {}),
        ...(postCommitWarnings.length ? { warnings: postCommitWarnings } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        signal,
        ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        ...(postCommitWarnings.length ? { postCommitWarning: true } : {}),
        note: 'Objetivo registrado y entregado al equipo. Responde siempre con un cierre breve, visible y natural.'
      }
    }
  })
  const createPaymentLinkTool = tool({
    name: 'create_payment_link',
    description: 'Crea el link del producto/precio blindado en la capacidad de cobro. El servidor decide concepto, monto y moneda desde la base; la herramienta nunca confirma el pago.',
    parameters: z.object({
      quantity: z.number().int().min(1).max(100).nullable().describe('Cantidad entre 1 y 100; null equivale a 1'),
      agreedAmount: z.number().positive().nullable().describe('Monto acordado dentro del rango del anticipo; null cuando el precio es fijo')
    }),
    execute: async ({ quantity, agreedAmount }) => {

      // El link es el mecanismo para cobrar el pago completo o el anticipo. No exigimos
      // un comprobante previo para crearlo; sí amarramos el cobro al workflow/catálogo.
      const accountCurrency = String(
        ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')
      ).trim().toUpperCase()
      const paymentValidation = await resolveNativePaymentAuthority({
        capability: paymentCapability,
        quantity: quantity || 1,
        agreedAmount,
        accountCurrency
      })
      if (!paymentValidation.ok) return paymentValidation
      const trustedPayment = paymentValidation.trusted
      const deliveryChannel = String(ctx.channel || '').toLowerCase()
      const paymentIdempotencyKey = buildConversationalPaymentLinkIdempotencyKey({
        agentId: config.id || ctx.agentId || '',
        contactId: ctx.contactId || '',
        productId: trustedPayment.productId || '',
        priceId: trustedPayment.priceId || '',
        amount: trustedPayment.amount,
        currency: trustedPayment.currency,
        channel: deliveryChannel,
        paymentPurpose: nativePaymentPurpose,
        executionId: ctx.executionId
      })
      if (!ctx.dryRun && !paymentIdempotencyKey) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          code: 'payment_execution_id_missing',
          error: 'No se pudo identificar de forma segura el mensaje que autorizó este cobro. No se creó ningún link; pasa la conversación a una persona.'
        }
      }

      const contact = await getPaymentContact(ctx.contactId)
      if (!contact) return { ok: false, actionCompleted: false, error: 'Contacto no encontrado. No se creó ni envió ningún link.' }

      const action = pushAction(ctx, 'create_payment_link', {
        amount: trustedPayment.amount,
        currency: trustedPayment.currency,
        concept: trustedPayment.concept,
        catalogEvidence: {
          source: trustedPayment.source,
          productId: trustedPayment.productId,
          priceId: trustedPayment.priceId
        },
        channel: deliveryChannel,
        effect: { liveEffect: 'ENVIARÍA un link de pago real (la venta sigue PENDIENTE hasta que se pague)', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          channel: deliveryChannel,
          wouldCreateAndSendLink: true
        })
        return {
          ok: true,
          simulated: true,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          concept: trustedPayment.concept,
          channel: deliveryChannel,
          catalogEvidence: trustedPayment.source
        }
      }

      try {
        const result = await createSinglePaymentLink({
          contact,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          description: trustedPayment.concept,
          concept: trustedPayment.concept,
          title: trustedPayment.concept,
          channels: buildPaymentChannels(deliveryChannel),
          source: 'conversational_agent_v2',
          idempotencyKey: paymentIdempotencyKey,
          idempotencyPayload: {
            agentId: config.id || ctx.agentId || null,
            contactId: ctx.contactId,
            productId: trustedPayment.productId,
            priceId: trustedPayment.priceId,
            amount: trustedPayment.amount,
            currency: trustedPayment.currency,
            channel: deliveryChannel,
            paymentPurpose: nativePaymentPurpose,
            executionId: String(ctx.executionId || '').trim()
          }
        })

        const resultCurrency = String(result?.currency || '').trim().toUpperCase()
        const resultAmount = Number(result?.amount)
        const paymentLedger = result?.invoiceId
          ? await db.get(
              `SELECT id, contact_id, amount, currency, status, payment_mode, ghl_invoice_id
               FROM payments
               WHERE contact_id = ? AND (id = ? OR ghl_invoice_id = ?)
               ORDER BY CASE WHEN ghl_invoice_id = ? THEN 0 ELSE 1 END
               LIMIT 1`,
              [ctx.contactId, result.invoiceId, result.invoiceId, result.invoiceId]
            ).catch(() => null)
          : null
        const ledgerCurrency = String(paymentLedger?.currency || '').trim().toUpperCase()
        const ledgerAmount = Number(paymentLedger?.amount)
        const ledgerEnvironment = String(paymentLedger?.payment_mode || '').trim().toLowerCase()
        const ledgerCanonicalMatch = Boolean(
          paymentLedger?.id &&
          Number.isFinite(ledgerAmount) &&
          Math.abs(ledgerAmount - trustedPayment.amount) < 0.005 &&
          ledgerCurrency === trustedPayment.currency &&
          ['live', 'test'].includes(ledgerEnvironment)
        )
        const sent = Boolean(result?.invoiceId && result?.paymentLink && result?.sendMethod !== 'none' && result?.status !== 'draft')
        const prepared = Boolean(result?.invoiceId && result?.paymentLink && paymentLedger?.id)
        const canonicalMatch = Math.abs(resultAmount - trustedPayment.amount) < 0.005 && resultCurrency === trustedPayment.currency
        if (!prepared || !canonicalMatch || !ledgerCanonicalMatch) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'payment_link_failed',
            detail: {
              reason: !prepared
                ? 'link_not_prepared'
                : (!ledgerCanonicalMatch ? 'payment_ledger_mismatch' : 'canonical_payment_mismatch'),
              invoiceId: result?.invoiceId || null,
              expectedAmount: trustedPayment.amount,
              expectedCurrency: trustedPayment.currency,
              actualAmount: result?.amount || null,
              actualCurrency: result?.currency || null,
              ledgerAmount: Number.isFinite(ledgerAmount) ? ledgerAmount : null,
              ledgerCurrency: ledgerCurrency || null,
              ledgerEnvironment: ledgerEnvironment || null
            }
          }).catch(() => undefined)
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            invoiceCreated: Boolean(result?.invoiceId),
            error: result?.invoiceId
              ? 'El cobro pudo crear un borrador, pero no hay evidencia de que el link correcto se haya enviado. No afirmes que se envió; pasa la conversación a una persona.'
              : 'No se pudo crear ni enviar el link de pago. No afirmes lo contrario; pasa la conversación a una persona.'
          }
          settleAction(action, 'error', {
            error: errorResult.error,
            invoiceId: result?.invoiceId || null,
            invoiceCreated: errorResult.invoiceCreated,
            deliveryConfirmed: false,
            canonicalMatch,
            ledgerCanonicalMatch,
            transferRequired: true
          })
          return errorResult
        }

        try {
          const sourceEventType = result.reused ? 'payment_link_reused' : 'payment_link_created'
          const sourceDetail = {
            agentId: config.id || ctx.agentId || null,
            invoiceId: result.invoiceId,
            amount: result.amount,
            currency: result.currency,
            channel: deliveryChannel,
            paymentMode: paymentCapability?.paymentMode,
            runtimeMode: 'tool_calling_v2',
            ledgerPaymentId: paymentLedger.id,
            paymentEnvironment: ledgerEnvironment,
            productId: trustedPayment.productId || null,
            priceId: trustedPayment.priceId || null,
            paymentPurpose: nativePaymentPurpose,
            appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
            executionId: String(ctx.executionId || '').trim(),
            status: result.status,
            ...(result.reused ? { reused: true } : {})
          }
          await bindConversationalPaymentSourceEvent({
            eventId: `cae_payment_${createHash('sha256').update(paymentIdempotencyKey).digest('hex').slice(0, 48)}`,
            contactId: ctx.contactId,
            eventType: sourceEventType,
            detail: sourceDetail
          })
          const alreadyPaid = ['paid', 'succeeded', 'completed', 'success'].includes(
            String(paymentLedger.status || '').trim().toLowerCase()
          ) && ledgerEnvironment === 'live'
          if (alreadyPaid) {
            const completion = await completeConversationalAgentSalePaymentFromInvoice({
              contactId: ctx.contactId,
              invoiceId: result.invoiceId,
              paymentId: paymentLedger.id,
              amount: paymentLedger.amount,
              currency: paymentLedger.currency,
              status: paymentLedger.status,
              paymentMode: paymentLedger.payment_mode
            })
            if (!completion?.matched) {
              await db.run(
                `UPDATE conversational_payment_link_requests
                 SET binding_status = 'pending', binding_error = ?, updated_at = ?
                 WHERE idempotency_key = ? AND binding_status = 'bound'`,
                ['El pago ya estaba confirmado pero su reconciliación quedó pendiente.', new Date().toISOString(), paymentIdempotencyKey]
              ).catch(() => {})
              throw new Error('El pago ya estaba confirmado, pero no se pudo reconciliar con el agente')
            }
          }
        } catch (error) {
          const bindingError = 'El link quedó preparado, pero no se pudo guardar su vínculo seguro con este cobro. No generes otro: vuelve a intentar esta misma acción para reparar el registro o pasa la conversación a una persona.'
          settleAction(action, 'error', {
            error: bindingError,
            linkAvailable: true,
            deliveryConfirmed: sent,
            retryUsesSameLink: true,
            transferRequired: true
          })
          return {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            retryUsesSameLink: true,
            error: bindingError
          }
        }
        settleAction(action, 'ok', {
          invoiceId: result.invoiceId,
          paymentLink: result.paymentLink,
          amount: result.amount,
          currency: result.currency,
          sendMethod: result.sendMethod,
          linkAvailable: true,
          deliveryConfirmed: sent && !result.reused,
          priorEquivalentLinkFound: Boolean(result.reused),
          reused: Boolean(result.reused),
          objectiveCompleted: false
        })
        return {
          ok: true,
          actionCompleted: true,
          paymentLink: result.paymentLink,
          sendMethod: result.sendMethod,
          amount: result.amount,
          currency: result.currency,
          status: 'pending',
          providerStatus: result.status,
          paymentConfirmed: false,
          objectiveCompleted: false,
          // (AI-004) Evita que el modelo reenvíe/duplique: avísale que ya había un link equivalente.
          note: result.reused
            ? 'Ya existía un link de pago equivalente reciente para este contacto; se reutilizó en lugar de crear otro. Confirma a la persona con ese mismo link; no generes uno nuevo.'
            : 'Link preparado. El pago sigue pendiente: sólo una confirmación real del proveedor puede marcarlo como pagado.'
        }
      } catch (error) {
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'payment_link_failed',
          detail: {
            error: error.message,
            amount: trustedPayment.amount,
            currency: trustedPayment.currency,
            concept: trustedPayment.concept
          }
        }).catch(() => undefined)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo crear ni enviar el link de pago. No afirmes que se envió; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          deliveryConfirmed: false,
          transferRequired: true
        })
        return errorResult
      }
    }
  })

  const sendGoalUrlTool = tool({
    name: 'send_goal_url',
    description: 'Prepara el enlace blindado de la capacidad send_link. Nunca agrega contact_id ni marca la meta como cumplida por un clic no autenticado.',
    parameters: z.object({
      intencionDetectada: z.string().nullable().describe('Qué quiere lograr la persona; null si no hace falta contexto extra'),
      resumen: z.string().nullable().describe('Resumen breve para auditoría; null si no hace falta contexto extra')
    }),
    execute: async ({ intencionDetectada, resumen }) => {
      intencionDetectada = intencionDetectada || 'Solicitó el enlace'
      resumen = resumen || ''

      let goalConfig = {
        url: linkCapability?.url || '',
        trackingParam: linkCapability?.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      }
      const nativeExecutionId = String(ctx.executionId || '').trim()
      if (!ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          code: 'goal_link_execution_id_missing',
          error: 'No se pudo identificar de forma segura el mensaje que pidió este enlace. No se preparó nada; pasa la conversación a una persona.'
        }
      }

      if (linkCapability?.linkKind === 'trigger') {
        let triggerLink = null
        if (linkCapability.triggerLinkId) {
          triggerLink = await getTriggerLink(linkCapability.triggerLinkId)
          if (!triggerLink || triggerLink.archived || !triggerLink.active) {
            return { ok: false, actionCompleted: false, transferRequired: true, error: 'El enlace configurado ya no existe o está apagado. No se envió nada; pasa la conversación a una persona.' }
          }
          goalConfig = { ...goalConfig, url: triggerLink.destinationUrl }
        }

        const targetUrl = String(goalConfig.url || '').trim()
        if (!isSafeHttpUrl(targetUrl)) {
          return { ok: false, actionCompleted: false, transferRequired: true, error: 'El destino configurado no es un enlace web seguro. No se envió nada; pasa la conversación a una persona.' }
        }
        const action = pushAction(ctx, 'send_goal_url', {
          objective: 'custom',
          intencionDetectada,
          targetUrl,
          triggerLinkId: triggerLink?.id || null,
          effect: { liveEffect: 'ENVIARÍA el destino configurado sin identidad en la URL y sin completar la meta', marksObjectiveCompleted: false }
        })
        if (!ctx.dryRun) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'safe_link_sent',
            detail: {
              agentId: config.id || ctx.agentId || null,
              triggerLinkId: triggerLink?.id || null,
              intencionDetectada,
              resumen
            }
          }).catch(() => {})
        }
        settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
          actionCompleted: !ctx.dryRun,
          linkPrepared: true,
          sentUrl: targetUrl,
          deliveryConfirmed: false,
          objectiveCompleted: false,
          confirmationMode: 'none'
        })
        return {
          ok: true,
          actionCompleted: !ctx.dryRun,
          simulated: Boolean(ctx.dryRun),
          sentUrl: targetUrl,
          confirmationMode: 'none',
          objectiveCompleted: false,
          note: 'Manda sentUrl visible en el chat. Este envío no confirma ni completa ninguna meta.'
        }
      }

      const targetUrl = goalConfig.url || ''
      const trackingParam = goalConfig.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      if (!targetUrl || !isSafeHttpUrl(targetUrl)) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = { linkParams: {}, expected: { capabilityId: 'send_link' } }

      const action = pushAction(ctx, 'send_goal_url', {
        objective: 'custom', intencionDetectada, targetUrl,
        effect: { liveEffect: 'ENVIARÍA el enlace configurado (el objetivo sigue PENDIENTE hasta la confirmación con ID real)', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: false,
          objectiveCompleted: false
        })
        return {
          ok: true,
          simulated: true,
          sentUrl: buildGoalLinkPreview(targetUrl, trackingParam, 'goal_simulado', linkContext.linkParams),
          trackingParam,
          linkParams: linkContext.linkParams,
          confirmationMode: 'trusted_integration',
          note: 'Vista previa solamente: en vivo se manda el enlace y la meta queda pendiente hasta que una integración autenticada confirme el resultado real.'
        }
      }

      let link
      try {
        link = await createConversationGoalLink({
          contactId: ctx.contactId,
          agentId: config.id || ctx.agentId || null,
          objective: 'custom',
          targetUrl,
          trackingParam,
          linkParams: linkContext.linkParams,
          idempotencyKey: `send_goal_url_v2:${createHash('sha256').update([
            ctx.contactId || '',
            config.id || ctx.agentId || '',
            targetUrl,
            String(ctx.channel || '').trim().toLowerCase(),
            nativeExecutionId
          ].join('\u0000')).digest('hex')}`,
          metadata: {
            expected: linkContext.expected,
            intencionDetectada,
            resumen,
            channel: String(ctx.channel || '').trim().toLowerCase(),
            executionId: nativeExecutionId
          }
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo preparar el enlace del objetivo: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo preparar el enlace del objetivo. No afirmes que se envió; pasa la conversación a una persona.'
        }
        settleAction(action, 'error', {
          error: errorResult.error,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: false,
          transferRequired: true
        })
        return errorResult
      }

      if (link.status === 'completed') {
        settleAction(action, 'ok', {
          goalId: link.id,
          linkPrepared: false,
          confirmationMode: 'trusted_integration',
          deliveryConfirmed: true,
          objectiveCompleted: true,
          idempotent: true
        })
        return {
          ok: true,
          actionCompleted: false,
          objectiveCompleted: true,
          alreadyCompleted: true,
          confirmationMode: 'trusted_integration',
          note: 'Esta misma meta ya fue confirmada. No vuelvas a mandar el enlace.'
        }
      }

      settleAction(action, 'ok', {
        goalId: link.id,
        sentUrl: link.sentUrl,
        linkPrepared: true,
        confirmationMode: 'trusted_integration',
        deliveryConfirmed: false,
        objectiveCompleted: false
      })

      return {
        ok: true,
        actionCompleted: true,
        sentUrl: link.sentUrl,
        trackingParam: link.trackingParam,
        linkParams: link.linkParams,
        confirmationMode: 'trusted_integration',
        idempotent: link.idempotent === true,
        note: 'Manda sentUrl visible en el chat. No digas que el objetivo ya quedó cumplido; sólo una integración autenticada puede confirmar el ID real.'
      }
    }
  })

  const sendToHumanTool = tool({
    name: 'send_to_human',
    description: `Entrega la conversación al equipo${handoffCapability?.userName ? `, asignándola a ${handoffCapability.userName}` : ''}. Úsala para las reglas configuradas${handoffCapability?.pastClientsToHuman ? ' y siempre que get_contact_profile confirme que es cliente previo' : ''}.`,
    parameters: z.object({
      motivo: z.string().describe('Por qué necesita humano'),
      resumen: z.string().describe('Resumen breve de la situación')
    }),
    execute: async ({ motivo, resumen }) => {
      const action = pushAction(ctx, 'send_to_human', {
        motivo,
        effect: { liveEffect: 'PASARÍA el chat a un humano (el bot deja de responder). NO marca el objetivo como cumplido.', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal: 'ready_for_human',
          wouldNotifyHuman: true,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {}),
          objectiveCompleted: false
        })
        return {
          ok: true,
          simulated: true,
          signal: 'ready_for_human',
          wouldNotifyHuman: true,
          wouldMarkObjectiveCompleted: false,
          ...(handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        const committedHandoff = await commitNativeHandoff({
          ctx,
          config,
          capability: handoffCapability,
          signal: 'ready_for_human',
          signalOptions: {
            reason: motivo,
            summary: resumen,
            status: 'human'
          },
          assignmentEventSource: 'handoff_human'
        })
        assignment = committedHandoff.assignment
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo transferir la conversación: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: error?.code
            ? error.message
            : 'No se pudo registrar la transferencia. No afirmes que un humano ya tomó el chat; requiere revisión manual.'
        }
        settleAction(action, 'error', { error: errorResult.error, transferRequired: true })
        return errorResult
      }

      let notificationWarning = false
      try {
        await notifyHumanPriority(ctx, { reason: motivo, summary: resumen, signal: 'ready_for_human' })
      } catch (error) {
        notificationWarning = true
        logger.warn(`[Agente conversacional] El handoff sí quedó registrado, pero falló la notificación: ${error.message}`)
      }
      settleAction(action, 'ok', {
        signal: 'ready_for_human',
        transferredToHuman: true,
        ...(assignment.assigned
          ? {
              assignedUserId: assignment.assignedUserId,
              assignedUserName: assignment.userName,
              assignmentReused: assignment.alreadyAssigned
            }
          : {}),
        objectiveCompleted: false,
        ...(notificationWarning ? { warnings: ['priority_notification'] } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        signal: 'ready_for_human',
        ...(assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        note: 'Un humano seguirá la conversación. Si hace falta, cierra con una frase breve y natural (ej. que en un momento le confirmas).'
      }
    }
  })

  const registerDepositProofTool = tool({
    name: 'register_deposit_payment_proof',
    description: 'Lee la foto o PDF de una transferencia y registra el comprobante como PENDIENTE DE REVISIÓN. Nunca confirma fondos ni marca el pago como pagado.',
    parameters: z.object({
      montoIndicado: z.number().nullable().describe('Monto que la persona dijo haber transferido, si lo mencionó (solo referencia; la validación usa el comprobante)'),
      referencia: z.string().nullable().describe('Referencia o folio si la persona lo compartió en texto')
    }),
    execute: async ({ montoIndicado, referencia }) => {
      const deposit = getDepositRequirementForRuntime(ctx, config)
      if (!deposit) {
        return { ok: false, actionCompleted: false, error: 'Este agente no tiene anticipo configurado; no hay nada que validar.' }
      }
      const methods = getDepositPaymentMethodsForRuntime(ctx, config)
      if (!methods.bankTransfer) {
        return { ok: false, actionCompleted: false, error: 'La transferencia bancaria no está habilitada para este anticipo. Usa el método configurado o manda a humano.' }
      }
      const paymentLabel = getDepositRequirementLabel(ctx, config)
      const expectedLabel = formatDepositRequirement(deposit, ctx.accountLocale)

      const action = pushAction(ctx, 'register_deposit_payment_proof', {
        montoIndicado: Number(montoIndicado) || null,
        referencia: referencia || null,
        effect: { liveEffect: `LEERÍA el comprobante y lo registraría como pendiente de revisión; no confirma el ${paymentLabel}`, marksObjectiveCompleted: false }
      })

      if (ctx.dryRun) {
        settleAction(action, 'simulated', { actionCompleted: false, wouldRegisterPayment: false, wouldRegisterPendingReview: true })
        return {
          ok: true,
          simulated: true,
          wouldRegisterPayment: false,
          wouldRegisterPendingReview: true,
          paymentConfirmed: false,
          note: `Simulación: en vivo se leería el comprobante y, si coincide con ${expectedLabel}, quedaría pendiente de revisión humana; no se marcaría pagado.`
        }
      }

      const accountCurrency = String(ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()

      // Idempotencia: si el anticipo ya quedó registrado (por esta tool o por el
      // equipo), no se duplica el pago.
      const existingEvidence = await findVerifiedPaymentEvidence({
        database: db,
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        requiredPurpose: nativePaymentPurpose,
        reconciliationId: String(ctx.executionId || '').startsWith('payment-resume:')
          ? String(ctx.executionId).slice('payment-resume:'.length).trim()
          : ''
      })
      if (existingEvidence.ok) {
        settleAction(action, 'ok', { actionCompleted: true, alreadyRegistered: true, paymentId: existingEvidence.evidence.paymentId })
        const visibleEvidence = {
          amount: existingEvidence.evidence.amount,
          currency: existingEvidence.evidence.currency,
          status: existingEvidence.evidence.status,
          paidAt: existingEvidence.evidence.paidAt
        }
        return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: visibleEvidence, paymentConfirmed: true, note: `El ${paymentLabel} ya estaba registrado; continúa con la acción de avance.` }
      }

      const receiptMedia = await findLatestInboundReceiptMedia(ctx.contactId)
      if (!receiptMedia) {
        settleAction(action, 'error', { error: 'no_receipt_media' })
        return { ok: false, actionCompleted: false, error: 'No encontré una foto o PDF reciente del comprobante en la conversación. Pide a la persona que mande la foto del comprobante y vuelve a intentar.' }
      }

      const apiKey = await getOpenAIApiKey().catch(() => null)
      const analysis = await analyzePaymentReceiptImage({
        mediaUrl: receiptMedia.mediaUrl,
        expectedCurrency: accountCurrency,
        apiKey
      })
      if (!analysis.ok) {
        settleAction(action, 'error', { error: analysis.reason || 'analysis_failed' })
        return { ok: false, actionCompleted: false, error: 'No pude leer el comprobante con claridad. Pide una foto más clara y completa (que se vea el monto) o manda a humano con send_to_human.' }
      }
      if (!analysis.isPaymentReceipt || !analysis.amount) {
        settleAction(action, 'error', { error: 'not_a_receipt', analysis: { isPaymentReceipt: analysis.isPaymentReceipt, amount: analysis.amount } })
        return { ok: false, actionCompleted: false, error: 'La imagen recibida no parece un comprobante de pago legible (no se distingue un monto transferido). Pide la foto del comprobante real de la transferencia.' }
      }
      if (analysis.currency && accountCurrency && analysis.currency !== accountCurrency) {
        settleAction(action, 'error', { error: 'currency_mismatch', detected: analysis.currency })
        return { ok: false, actionCompleted: false, error: `El comprobante indica moneda ${analysis.currency} y la cuenta cobra en ${accountCurrency}. No se registró el pago; manda a humano con send_to_human para revisarlo.` }
      }
      if (!depositRequirementAmountMatches(deposit, analysis.amount)) {
        settleAction(action, 'error', { error: 'amount_mismatch', detected: analysis.amount })
        return { ok: false, actionCompleted: false, detectedAmount: analysis.amount, error: `El comprobante muestra ${analysis.amount} ${accountCurrency} y el ${paymentLabel} configurado es ${expectedLabel}. No se registró el pago: dile con naturalidad la diferencia y pide el comprobante por el monto correcto, o manda a humano.` }
      }

      let payment
      try {
        payment = await registerAgentTransferPaymentProofForReview({
          contactId: ctx.contactId,
          amount: analysis.amount,
          currency: accountCurrency,
          concept: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia`,
          reference: analysis.reference || (referencia || null),
          agentId: config.id || ctx.agentId || null,
          mediaUrl: receiptMedia.mediaUrl,
          mediaMessageId: receiptMedia.messageId || null,
          receivedAt: receiptMedia.receivedAt || null,
          extracted: {
            amount: analysis.amount,
            currency: analysis.currency,
            date: analysis.date,
            bank: analysis.bank,
            reference: analysis.reference,
            recipientHint: analysis.recipientHint,
            confidence: analysis.confidence
          },
          conversationalBinding: {
            bindingKey: receiptMedia.messageId,
            channel: String(ctx.channel || 'whatsapp').trim().toLowerCase(),
            executionId: String(ctx.executionId || '').trim(),
            paymentPurpose: nativePaymentPurpose,
            appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
            confidence: analysis.confidence
          }
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el anticipo por transferencia: ${error.message}`)
        settleAction(action, 'error', { error: error.message })
        return { ok: false, actionCompleted: false, transferRequired: true, error: 'El comprobante se leyó bien pero no se pudo registrar el pago. Pasa la conversación a una persona con send_to_human.' }
      }

      // El equipo recibe aviso para auditar el comprobante aunque el agente continúe.
      if (!payment.alreadyRegistered) {
        await notifyHumanPriority(ctx, {
          reason: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia pendiente de revisar`,
          summary: `${payment.amount} ${payment.currency} · revisar comprobante`,
          signal: 'deposit_transfer_pending_review'
        })
      }

      settleAction(action, 'ok', {
        actionCompleted: true,
        paymentId: payment.paymentId,
        amount: payment.amount,
        currency: payment.currency,
        paymentStatus: payment.status,
        paymentConfirmed: false,
        alreadyRegistered: payment.alreadyRegistered === true
      })
      return {
        ok: true,
        actionCompleted: true,
        payment: {
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status
        },
        paymentConfirmed: false,
        note: 'Comprobante recibido y pendiente de revisión humana. No digas que el pago está confirmado y no continúes con una acción que exija fondos verificados.'
      }
    }
  })

  const enabledCapabilities = new Set(
    getEnabledConversationalCapabilities(runtimeConfig).map((capability) => capability.id)
  )
  const nativeTools = [getBusinessProfileTool, listProductsTool, getContactProfileTool]

  if (
    Number(ctx.historyContext?.telemetry?.omittedMessages || 0) > 0 &&
    typeof ctx.loadConversationHistoryPage === 'function'
  ) {
    nativeTools.push(getConversationHistoryTool)
  }
  if (!ctx.followUpMode && enabledCapabilities.has('handoff_human')) {
    nativeTools.push(sendToHumanTool)
  }
  if (!ctx.followUpMode && enabledCapabilities.has('schedule_appointment')) {
    nativeTools.push(getFreeSlotsForAgentTool, bookAppointmentTool)
  }
  if (!ctx.followUpMode && enabledCapabilities.has('collect_payment')) {
    const methods = paymentCapability?.deposit?.methods || {}
    if (paymentCapability?.paymentMode !== 'deposit' || methods.paymentLink === true) {
      nativeTools.push(createPaymentLinkTool)
    }
    if (paymentCapability?.deposit?.enabled && methods.bankTransfer === true) {
      nativeTools.push(registerDepositProofTool)
    }
  }
  if (!ctx.followUpMode && enabledCapabilities.has('send_link')) {
    nativeTools.push(sendGoalUrlTool)
  }
  if (
    !ctx.followUpMode &&
    enabledCapabilities.has('custom_goal') &&
    customCapability?.completion === 'handoff'
  ) {
    nativeTools.push(markReadyTool)
  }
  return nativeTools
}
