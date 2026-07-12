import { createHash, randomUUID } from 'node:crypto'
import { db } from '../config/database.js'
import { createInternalNotification } from './notificationsService.js'
import { getLocalFreeSlots } from './localCalendarService.js'
import { getConversationalCapability } from '../agents/conversational/nativeRuntimeConfig.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone } from '../utils/dateUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { logger } from '../utils/logger.js'

const TEST_RUN_ID_PATTERN = /^[A-Za-z0-9_-]{12,160}$/
const TEST_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/
const TEST_RUN_TTL_MS = 2 * 60 * 60 * 1000
const TEST_EFFECT_LEASE_MS = 2 * 60 * 1000
const TEST_NOTIFICATION_STALE_MS = 5 * 60 * 1000
const TERMINAL_TEST_EFFECT_STATUSES = new Set([
  'recorded',
  'prepared',
  'paid_test',
  'cleaned',
  'retained_paid_test'
])

function cleanString(value) {
  return String(value ?? '').trim()
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function mutationCount(result) {
  return Number(result?.changes ?? result?.rowCount ?? 0)
}

function testError(message, statusCode = 400, code = 'invalid_test_run') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function normalizeIdentifier(value, pattern, label) {
  const normalized = cleanString(value)
  if (!pattern.test(normalized)) {
    throw testError(`${label} no es válido. Reinicia la prueba e inténtalo otra vez.`, 400, 'invalid_test_identity')
  }
  return normalized
}

function toIso(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

export function normalizeConversationalAgentTestEffects(value = {}) {
  const scheduleAppointment = value?.scheduleAppointment === true
  const collectPayment = value?.collectPayment === true
  const enabled = value?.enabled === true && (scheduleAppointment || collectPayment)
  return {
    enabled,
    scheduleAppointment: enabled && scheduleAppointment,
    collectPayment: enabled && collectPayment,
    notifyOwner: enabled && value?.notifyOwner === true
  }
}

function effectAllowed(effects, effectType) {
  if (!effects?.enabled) return false
  if (effectType === 'appointment') return effects.scheduleAppointment === true
  if (effectType === 'payment') return effects.collectPayment === true
  return false
}

function publicEffect(row = {}) {
  const payload = parseJson(row.payload_json, {})
  return {
    id: row.id,
    runId: row.run_id,
    messageId: row.message_id,
    type: row.effect_type,
    status: row.status,
    summary: cleanString(payload.summary) || null,
    message: cleanString(payload.message) || null,
    notificationStatus: row.notification_status || null,
    notificationError: row.notification_error || null,
    entityId: row.entity_id || null,
    payload,
    cleanupStatus: row.cleanup_status || null,
    cleanupError: row.cleanup_error || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    cleanedAt: row.cleaned_at || null
  }
}

async function loadOwnedRun(testRunId, requestedByUserId, { active = true } = {}) {
  const run = await db.get(
    `SELECT * FROM conversational_agent_test_runs
     WHERE id = ? AND requested_by_user_id = ?`,
    [testRunId, cleanString(requestedByUserId)]
  )
  if (!run) throw testError('Esta prueba ya no existe o pertenece a otro usuario.', 404, 'test_run_not_found')
  if (active && run.status !== 'active') {
    throw testError('Esta prueba ya fue cerrada. Inicia una nueva para registrar acciones.', 409, 'test_run_closed')
  }
  if (active && Date.parse(run.expires_at || '') <= Date.now()) {
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'active'`,
      [run.id]
    ).catch(() => undefined)
    throw testError('La prueba expiró por seguridad. Reiníciala para registrar acciones.', 409, 'test_run_expired')
  }
  return run
}

export async function prepareConversationalAgentTestRun({
  testRunId,
  testMessageId,
  agentId,
  requestedByUserId,
  contactId,
  effects
} = {}) {
  const normalizedEffects = normalizeConversationalAgentTestEffects(effects)
  if (!normalizedEffects.enabled) return null

  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const cleanAgentId = cleanString(agentId)
  const cleanUserId = cleanString(requestedByUserId)
  const cleanContactId = cleanString(contactId)
  if (!cleanAgentId || !cleanUserId || !cleanContactId) {
    throw testError('Selecciona un contacto de prueba antes de registrar citas o cobros.', 400, 'test_contact_required')
  }

  const [agent, contact] = await Promise.all([
    db.get('SELECT id, name FROM conversational_agents WHERE id = ?', [cleanAgentId]),
    db.get('SELECT id, full_name, first_name, last_name, phone, email FROM contacts WHERE id = ? AND deleted_at IS NULL', [cleanContactId])
  ])
  if (!agent) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')
  if (!contact) throw testError('El contacto de prueba ya no existe.', 404, 'test_contact_not_found')

  const effectsJson = JSON.stringify(normalizedEffects)
  const expiresAt = toIso(Date.now() + TEST_RUN_TTL_MS)
  await db.run(
    `INSERT INTO conversational_agent_test_runs (
       id, agent_id, requested_by_user_id, contact_id, effects_json, status,
       created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(id) DO NOTHING`,
    [runId, cleanAgentId, cleanUserId, cleanContactId, effectsJson, expiresAt]
  )

  const run = await db.get('SELECT * FROM conversational_agent_test_runs WHERE id = ?', [runId])
  if (
    !run ||
    cleanString(run.agent_id) !== cleanAgentId ||
    cleanString(run.requested_by_user_id) !== cleanUserId ||
    cleanString(run.contact_id) !== cleanContactId
  ) {
    throw testError('La identidad de esta prueba cambió. Reiníciala antes de continuar.', 409, 'test_run_identity_mismatch')
  }
  if (run.status !== 'active') {
    throw testError('Esta prueba ya no acepta acciones. Reiníciala para continuar.', 409, 'test_run_closed')
  }

  await db.run(
    `UPDATE conversational_agent_test_runs
     SET effects_json = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND requested_by_user_id = ? AND status = 'active'`,
    [effectsJson, expiresAt, runId, cleanUserId]
  )

  return {
    id: runId,
    messageId,
    agent,
    contact,
    effects: normalizedEffects,
    requestedByUserId: cleanUserId,
    executionId: `test:${sha256(`${runId}\u0000${messageId}`).slice(0, 48)}`,
    expiresAt
  }
}

export async function beginConversationalAgentTestEffect({
  testRunId,
  testMessageId,
  requestedByUserId,
  effectType,
  request
} = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const messageId = normalizeIdentifier(testMessageId, TEST_MESSAGE_ID_PATTERN, 'El mensaje de prueba')
  const cleanEffectType = cleanString(effectType)
  if (!['appointment', 'payment'].includes(cleanEffectType)) {
    throw testError('El efecto solicitado no está permitido en el tester.', 400, 'test_effect_not_allowed')
  }
  const run = await loadOwnedRun(runId, requestedByUserId)
  const effects = normalizeConversationalAgentTestEffects(parseJson(run.effects_json, {}))
  if (!effectAllowed(effects, cleanEffectType)) {
    throw testError('Este efecto no fue habilitado para la prueba actual.', 403, 'test_effect_not_enabled')
  }

  const requestJson = JSON.stringify(request || {})
  const requestHash = sha256(requestJson)
  const effectId = `catfx_${sha256(`${runId}\u0000${messageId}\u0000${cleanEffectType}`).slice(0, 48)}`
  const claimToken = randomUUID()
  const leaseUntilAt = toIso(Date.now() + TEST_EFFECT_LEASE_MS)
  await db.run(
    `INSERT INTO conversational_agent_test_effects (
       id, run_id, message_id, effect_type, request_hash, status, payload_json,
       attempt_count, claim_token, lease_until_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'processing', ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO NOTHING`,
    [effectId, runId, messageId, cleanEffectType, requestHash, requestJson, claimToken, leaseUntilAt]
  )

  let effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  if (!effect || effect.request_hash !== requestHash) {
    throw testError('Este mensaje ya intentó registrar otros datos. Reinicia la prueba para evitar duplicados.', 409, 'test_effect_payload_mismatch')
  }
  if (TERMINAL_TEST_EFFECT_STATUSES.has(effect.status)) {
    return { claimed: false, reused: true, inProgress: false, effect: publicEffect(effect), run, effects }
  }
  if (effect.claim_token === claimToken) {
    return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
  }

  const leaseExpired = !effect.lease_until_at || Date.parse(effect.lease_until_at) <= Date.now()
  if (effect.status === 'processing' && !leaseExpired) {
    return { claimed: false, reused: false, inProgress: true, effect: publicEffect(effect), run, effects }
  }

  const claimed = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'processing', attempt_count = attempt_count + 1,
         claim_token = ?, lease_until_at = ?, last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND request_hash = ?
       AND (status = 'failed' OR lease_until_at IS NULL OR lease_until_at <= ?)`,
    [claimToken, leaseUntilAt, effectId, requestHash, toIso()]
  )
  if (mutationCount(claimed) !== 1) {
    effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
    return { claimed: false, reused: TERMINAL_TEST_EFFECT_STATUSES.has(effect?.status), inProgress: effect?.status === 'processing', effect: publicEffect(effect || {}), run, effects }
  }
  effect = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [effectId])
  return { claimed: true, reused: false, inProgress: false, claimToken, effect: publicEffect(effect), run, effects }
}

export async function completeConversationalAgentTestEffect({
  effectId,
  claimToken,
  status = 'recorded',
  entityId = null,
  payload = {}
} = {}) {
  const result = await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = ?, entity_id = ?, payload_json = ?, claim_token = NULL,
         lease_until_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [cleanString(status) || 'recorded', cleanString(entityId) || null, JSON.stringify(payload || {}), cleanString(effectId), cleanString(claimToken)]
  )
  if (mutationCount(result) !== 1) {
    const existing = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
    if (existing && TERMINAL_TEST_EFFECT_STATUSES.has(existing.status)) return publicEffect(existing)
    throw testError('No se pudo cerrar de forma segura el efecto de prueba.', 409, 'test_effect_claim_lost')
  }
  const row = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)])
  await dispatchConversationalAgentTestEffectNotification(row).catch((error) => {
    logger.warn(`[Tester agente] No se pudo notificar el efecto ${effectId}: ${error.message}`)
  })
  return publicEffect(await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [cleanString(effectId)]))
}

export async function failConversationalAgentTestEffect({ effectId, claimToken, error } = {}) {
  await db.run(
    `UPDATE conversational_agent_test_effects
     SET status = 'failed', claim_token = NULL, lease_until_at = NULL,
         last_error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND claim_token = ?`,
    [cleanString(error?.message || error).slice(0, 1200), cleanString(effectId), cleanString(claimToken)]
  )
}

function previewActionSucceeded(action = {}) {
  const status = cleanString(action?.outcome?.status).toLowerCase()
  return status === 'simulated' || status === 'ok' || status === 'success' || status === 'completed'
}

async function loadPersistedCapabilities(run) {
  const agentId = cleanString(run?.agent_id || run?.agent?.id)
  const row = await db.get(
    'SELECT id, capabilities_config FROM conversational_agents WHERE id = ?',
    [agentId]
  )
  if (!row) throw testError('El agente de esta prueba ya no existe.', 404, 'test_agent_not_found')
  return parseJson(row.capabilities_config, {})
}

async function verifyTestAppointmentAction(action, scheduleCapability) {
  const calendarId = cleanString(action?.calendarId)
  const startTime = cleanString(action?.startTime)
  const start = new Date(startTime)
  if (
    !scheduleCapability?.enabled ||
    !calendarId ||
    cleanString(scheduleCapability.calendarId) !== calendarId ||
    Number.isNaN(start.getTime())
  ) {
    throw testError('La acción ya no coincide con el calendario guardado del agente.', 409, 'test_appointment_authority_changed')
  }

  const expectedAction = scheduleCapability.bookingOwner === 'human'
    ? 'request_human_booking'
    : 'book_appointment'
  if (cleanString(action?.type) !== expectedAction) {
    throw testError('Cambió quién termina de agendar. Vuelve a enviar el mensaje para probar la configuración vigente.', 409, 'test_booking_owner_changed')
  }

  const timezone = await getAccountTimezone()
  const windowStart = normalizeDateOnlyInTimezone(
    new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timezone
  )
  const windowEnd = normalizeDateOnlyInTimezone(
    new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    timezone
  )
  const availability = await getLocalFreeSlots(calendarId, windowStart, windowEnd, timezone, {
    ignoreAppointmentConflicts: false,
    appointmentLimit: 1
  })
  const stillFree = (Array.isArray(availability) ? availability : [])
    .flatMap((day) => Array.isArray(day?.slots) ? day.slots : [])
    .some((slot) => Math.abs(new Date(slot).getTime() - start.getTime()) < 60_000)
  if (!stillFree) {
    throw testError('Ese horario dejó de estar libre. No se registró la cita de prueba; vuelve a consultar espacios.', 409, 'test_slot_no_longer_free')
  }
}

function currencyFractionDigits(currency) {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    return Number.isInteger(digits) ? digits : 2
  } catch {
    return 2
  }
}

function normalizeMoney(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const factor = 10 ** currencyFractionDigits(currency)
  return Math.round((amount + Number.EPSILON) * factor) / factor
}

async function verifyTestPaymentAction(action, paymentCapability) {
  const accountCurrency = cleanString(await getAccountCurrency()).toUpperCase()
  const currency = cleanString(action?.currency).toUpperCase()
  const amount = normalizeMoney(action?.amount, currency)
  const quantity = Number(action?.quantity || 1)
  if (
    !paymentCapability?.enabled ||
    !/^[A-Z]{3}$/.test(accountCurrency) ||
    currency !== accountCurrency ||
    !amount ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    throw testError('El monto o la moneda del cobro ya no coinciden con la configuración guardada.', 409, 'test_payment_authority_changed')
  }

  const usesDeposit = paymentCapability.paymentMode === 'deposit' || paymentCapability.deposit?.enabled === true
  if (usesDeposit) {
    const deposit = paymentCapability.deposit || {}
    const depositCurrency = cleanString(deposit.currency || accountCurrency).toUpperCase()
    const fixed = normalizeMoney(deposit.amount, accountCurrency)
    const min = normalizeMoney(deposit.minAmount, accountCurrency)
    const max = normalizeMoney(deposit.maxAmount, accountCurrency)
    const validAmount = deposit.mode === 'range'
      ? (!min || amount >= min) && (!max || amount <= max)
      : fixed > 0 && amount === fixed
    if (quantity !== 1 || depositCurrency !== accountCurrency || !validAmount) {
      throw testError('El anticipo de prueba ya no coincide con el monto blindado del agente.', 409, 'test_payment_authority_changed')
    }
    return { amount, currency, quantity: 1 }
  }

  const productId = cleanString(paymentCapability.productId)
  const priceId = cleanString(paymentCapability.priceId)
  const row = await db.get(
    `SELECT p.id AS product_id, p.ghl_product_id, p.currency AS product_currency,
            pp.id AS price_id, pp.ghl_price_id, pp.amount, pp.currency AS price_currency
     FROM products p
     INNER JOIN product_prices pp ON pp.product_id = p.id
     WHERE p.is_active = 1
       AND (p.id = ? OR p.ghl_product_id = ?)
       AND (pp.id = ? OR pp.ghl_price_id = ?)
     LIMIT 1`,
    [productId, productId, priceId, priceId]
  )
  const catalogCurrency = cleanString(row?.price_currency || row?.product_currency).toUpperCase()
  const unitAmount = normalizeMoney(row?.amount, catalogCurrency)
  const expectedAmount = normalizeMoney(unitAmount * quantity, accountCurrency)
  const actionProductId = cleanString(action?.catalogEvidence?.productId)
  const actionPriceId = cleanString(action?.catalogEvidence?.priceId)
  if (
    !row ||
    catalogCurrency !== accountCurrency ||
    !unitAmount ||
    amount !== expectedAmount ||
    actionProductId !== cleanString(row.product_id) ||
    actionPriceId !== cleanString(row.price_id)
  ) {
    throw testError('El producto, precio o monto del cobro cambió. Vuelve a enviar el mensaje para probar el valor vigente.', 409, 'test_payment_authority_changed')
  }
  return { amount, currency, quantity, unitAmount }
}

function actionForEffect(actions, effectType) {
  const acceptedTypes = effectType === 'appointment'
    ? new Set(['book_appointment', 'request_human_booking'])
    : new Set(['create_payment_link'])
  return (Array.isArray(actions) ? actions : []).find((action) => (
    acceptedTypes.has(cleanString(action?.type)) && previewActionSucceeded(action)
  )) || null
}

async function recordPreviewEffect({ runContext, actions, effectType, capabilitiesConfig }) {
  const action = actionForEffect(actions, effectType)
  if (!action) return null

  const request = effectType === 'appointment'
    ? {
        calendarId: cleanString(action.calendarId),
        startTime: cleanString(action.startTime),
        endTime: cleanString(action.endTime),
        title: cleanString(action.title),
        bookingOwner: cleanString(action.type) === 'request_human_booking' ? 'human' : 'ai'
      }
    : {
        amount: Number(action.amount),
        unitAmount: Number(action.unitAmount),
        quantity: Number(action.quantity || 1),
        currency: cleanString(action.currency).toUpperCase(),
        concept: cleanString(action.concept),
        productId: cleanString(action.catalogEvidence?.productId),
        priceId: cleanString(action.catalogEvidence?.priceId)
      }

  const claim = await beginConversationalAgentTestEffect({
    testRunId: runContext.id,
    testMessageId: runContext.messageId,
    requestedByUserId: runContext.requestedByUserId,
    effectType,
    request
  })
  if (!claim.claimed) {
    if (claim.reused && claim.effect?.id) {
      await ensureConversationalAgentTestEffectNotification(claim.effect.id).catch((error) => {
        logger.warn(`[Tester agente] No se pudo reintentar la notificación ${claim.effect.id}: ${error.message}`)
      })
      const refreshed = await db.get('SELECT * FROM conversational_agent_test_effects WHERE id = ?', [claim.effect.id])
      return publicEffect(refreshed || {})
    }
    return claim.effect
  }

  try {
    if (effectType === 'appointment') {
      const schedule = getConversationalCapability({ capabilitiesConfig }, 'schedule_appointment')
      await verifyTestAppointmentAction(action, schedule)
      const humanBooking = action.type === 'request_human_booking'
      return await completeConversationalAgentTestEffect({
        effectId: claim.effect.id,
        claimToken: claim.claimToken,
        status: 'recorded',
        entityId: claim.effect.id,
        payload: {
          ...request,
          contactId: runContext.contact.id,
          contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
          safeTestRecord: true,
          appointmentCreated: false,
          summary: humanBooking
            ? 'Horario de prueba validado para entrega humana. No se transfirió el chat ni se creó una cita real.'
            : 'Horario de prueba validado. No se creó una cita real.'
        }
      })
    }

    const payment = getConversationalCapability({ capabilitiesConfig }, 'collect_payment')
    const verifiedPayment = await verifyTestPaymentAction(action, payment)
    return await completeConversationalAgentTestEffect({
      effectId: claim.effect.id,
      claimToken: claim.claimToken,
      status: 'prepared',
      entityId: claim.effect.id,
      payload: {
        ...request,
        ...verifiedPayment,
        contactId: runContext.contact.id,
        contactName: runContext.contact.full_name || runContext.contact.first_name || 'Contacto de prueba',
        safeTestRecord: true,
        paymentCreated: false,
        paymentConfirmed: false,
        linkSent: false,
        summary: `Intención de cobro validada por ${request.amount} ${request.currency}. No se creó ni envió un enlace y no se marcó como pagado.`
      }
    })
  } catch (error) {
    await failConversationalAgentTestEffect({
      effectId: claim.effect.id,
      claimToken: claim.claimToken,
      error
    })
    throw error
  }
}

export async function recordConversationalAgentPreviewEffects({ runContext, actions = [] } = {}) {
  if (!runContext?.effects?.enabled) return []
  const capabilitiesConfig = await loadPersistedCapabilities(runContext)
  const requested = []
  if (runContext.effects.scheduleAppointment) requested.push('appointment')
  if (runContext.effects.collectPayment) requested.push('payment')

  const results = []
  for (const effectType of requested) {
    try {
      const recorded = await recordPreviewEffect({ runContext, actions, effectType, capabilitiesConfig })
      if (recorded) results.push(recorded)
    } catch (error) {
      results.push({
        type: effectType,
        status: 'failed',
        summary: error.message || 'No se pudo registrar esta acción de prueba.'
      })
    }
  }
  return results
}

async function dispatchConversationalAgentTestEffectNotification(effectRow) {
  if (!effectRow?.id) return { skipped: true, reason: 'effect_missing' }
  const run = await db.get('SELECT * FROM conversational_agent_test_runs WHERE id = ?', [effectRow.run_id])
  const effects = normalizeConversationalAgentTestEffects(parseJson(run?.effects_json, {}))
  if (!run || effects.notifyOwner !== true) return { skipped: true, reason: 'disabled' }

  const staleBefore = toIso(Date.now() - TEST_NOTIFICATION_STALE_MS)
  const claimedAt = toIso()
  const claimed = await db.run(
    `UPDATE conversational_agent_test_effects
     SET notification_status = 'dispatching', notification_error = NULL,
         updated_at = ?
     WHERE id = ? AND (
       notification_status = 'pending' OR
       (notification_status = 'dispatching' AND updated_at <= ?)
     )`,
    [claimedAt, effectRow.id, staleBefore]
  )
  if (mutationCount(claimed) !== 1) return { skipped: true, reason: 'already_notified' }

  const payload = parseJson(effectRow.payload_json, {})
  const isAppointment = effectRow.effect_type === 'appointment'
  const title = isAppointment
    ? 'Prueba del agente · horario validado (sin crear cita)'
    : 'Prueba del agente · cobro validado (sin crear enlace)'
  const message = isAppointment
    ? `${payload.localLabel || payload.startTime || 'Horario validado'} · ${payload.contactName || 'Contacto de prueba'}`
    : `${payload.amount ?? ''} ${payload.currency || ''} · ${payload.contactName || 'Contacto de prueba'}`.trim()
  try {
    const notification = await createInternalNotification({
      recipientUserIds: [run.requested_by_user_id],
      source: 'Tester del agente',
      severity: 'info',
      title,
      message,
      actionUrl: `/ai-agent/conversational/${run.agent_id}`,
      actionLabel: 'Abrir prueba',
      category: 'conversational_agent_test',
      contactId: run.contact_id,
      metadata: { testRunId: run.id, testEffectId: effectRow.id, testEffectType: effectRow.effect_type }
    })
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'sent', notification_sent_at = CURRENT_TIMESTAMP,
           notification_error = NULL, updated_at = ?
       WHERE id = ? AND notification_status = 'dispatching'`,
      [toIso(), effectRow.id]
    )
    return notification
  } catch (error) {
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET notification_status = 'pending', notification_error = ?,
           updated_at = ?
       WHERE id = ? AND notification_status = 'dispatching'`,
      [cleanString(error.message).slice(0, 1200), toIso(), effectRow.id]
    ).catch(() => undefined)
    throw error
  }
}

export async function ensureConversationalAgentTestEffectNotification(effectId) {
  const row = await db.get(
    'SELECT * FROM conversational_agent_test_effects WHERE id = ?',
    [cleanString(effectId)]
  )
  if (!row) throw testError('El efecto de prueba ya no existe.', 404, 'test_effect_not_found')
  return dispatchConversationalAgentTestEffectNotification(row)
}

export async function listConversationalAgentTestEffects({ testRunId, requestedByUserId } = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  await loadOwnedRun(runId, requestedByUserId, { active: false })
  let rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  for (const row of rows) {
    if (TERMINAL_TEST_EFFECT_STATUSES.has(row.status) && row.notification_status === 'pending' && row.notification_error) {
      await dispatchConversationalAgentTestEffectNotification(row).catch(() => undefined)
    }
  }
  rows = await db.all(
    `SELECT * FROM conversational_agent_test_effects
     WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  return rows.map(publicEffect)
}

export async function cleanupConversationalAgentTestRun({ testRunId, requestedByUserId } = {}) {
  const runId = normalizeIdentifier(testRunId, TEST_RUN_ID_PATTERN, 'La sesión de prueba')
  const run = await loadOwnedRun(runId, requestedByUserId, { active: false })
  if (run.status === 'cleaned') {
    return { runId, cleaned: true, effects: await listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId }) }
  }
  if (!['active', 'expired', 'cleanup_failed'].includes(run.status)) {
    throw testError('Esta prueba no se puede limpiar en su estado actual.', 409, 'test_run_cleanup_blocked')
  }

  const closed = await db.run(
    `UPDATE conversational_agent_test_runs
     SET status = 'cleaning', updated_at = ?
     WHERE id = ? AND requested_by_user_id = ? AND status IN ('active', 'expired', 'cleanup_failed')`,
    [toIso(), runId, cleanString(requestedByUserId)]
  )
  if (mutationCount(closed) !== 1) {
    throw testError('La prueba cambió mientras se cerraba. Intenta limpiarla otra vez.', 409, 'test_run_cleanup_race')
  }

  try {
    const rows = await db.all('SELECT * FROM conversational_agent_test_effects WHERE run_id = ? ORDER BY created_at ASC', [runId])
    for (const row of rows) {
      await db.run(
        `UPDATE conversational_agent_test_effects
         SET cleanup_status = 'cleaned', cleanup_error = NULL, cleaned_at = CURRENT_TIMESTAMP,
             status = 'cleaned', updated_at = ?
         WHERE id = ?`,
        [toIso(), row.id]
      )
    }
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'cleaned', cleaned_at = CURRENT_TIMESTAMP, updated_at = ?
       WHERE id = ? AND requested_by_user_id = ? AND status = 'cleaning'`,
      [toIso(), runId, cleanString(requestedByUserId)]
    )
  } catch (error) {
    await db.run(
      `UPDATE conversational_agent_test_runs
       SET status = 'cleanup_failed', updated_at = ?
       WHERE id = ? AND requested_by_user_id = ? AND status = 'cleaning'`,
      [toIso(), runId, cleanString(requestedByUserId)]
    ).catch(() => undefined)
    throw error
  }
  return {
    runId,
    cleaned: true,
    effects: await listConversationalAgentTestEffects({ testRunId: runId, requestedByUserId })
  }
}

export const __conversationalAgentTestServiceTestHooks = Object.freeze({
  TEST_RUN_ID_PATTERN,
  TEST_MESSAGE_ID_PATTERN,
  publicEffect
})
