import { tool } from '@openai/agents'
import { z } from 'zod'
import { DateTime } from 'luxon'
import { createHash } from 'node:crypto'
import { db } from '../../config/database.js'
import { PUBLIC_URL } from '../../config/constants.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { updateContact } from '../../controllers/contactsController.js'
import { listCalendarsTool } from '../tools/appointmentTools.js'
import { getLocalFreeSlots } from '../../services/localCalendarService.js'
import { inspectChangedAppointmentCreationReplay } from '../../services/appointmentCreationSafetyService.js'
import {
  buildConversationalPaymentLinkIdempotencyKey,
  createSinglePaymentLink,
  findRecentAgentTransferDepositPayment,
  registerAgentTransferDepositPayment,
  registerAgentTransferPaymentProofForReview
} from '../../services/paymentFlowService.js'
import { getBusinessProfileSnapshot, getOpenAIApiKey } from '../../services/aiAgentService.js'
import { getDepositPaymentMethods } from './prompt.js'
import { analyzePaymentReceiptImage } from './mediaContext.js'
import { buildTriggerLinkPublicUrl, getTriggerLink } from '../../services/triggerLinksService.js'
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
  hasRecentConversationalAgentEvent,
  applyAgentSuccessExtras,
  applyAgentCompletionAction,
  updateConversationClosingContext,
  createConversationGoalLink,
  DEFAULT_GOAL_TRACKING_PARAM
} from '../../services/conversationalAgentService.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'
import { logger } from '../../utils/logger.js'
import { requireClosingPhasesIfNeeded } from './closingPhaseGate.js'
import {
  NON_LIVE_PAYMENT_MODES,
  SUCCESS_PAYMENT_STATUSES,
  depositRequirementAmountMatches,
  findVerifiedPaymentEvidence,
  revalidateAppointmentSlot,
  validatePaymentRequestAgainstCatalog,
  verifyAppointmentConfirmationEvidence
} from './actionEvidence.js'
import {
  getConversationalCapability,
  getEnabledConversationalCapabilities,
  isToolCallingV2
} from './nativeRuntimeConfig.js'

/**
 * Tools del agente conversacional. Se crean por ejecución con una factory
 * porque necesitan el contexto de la conversación (contactId, configuración
 * y modo simulación) cerrado sobre cada tool.
 *
 * ctx = {
 *   contactId, config, dryRun,
 *   actions: [],        // acciones internas ejecutadas (para auditoría/preview)
 *   suppressReply: false // true => no enviar mensaje visible al cliente
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
    runtimeMode: ctx.runtimeMode || config.runtimeMode,
    capabilitiesConfig: ctx.capabilitiesConfig ?? config.capabilitiesConfig
  }
}

function isNativeToolRuntime(ctx = {}, config = {}) {
  return isToolCallingV2(getToolRuntimeConfig(ctx, config))
}

function getNativeCapability(ctx = {}, config = {}, capabilityId = '') {
  if (!isNativeToolRuntime(ctx, config)) return null
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
      strictEvent: true,
      allowInternalSummary: false
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

function resolveAdvanceSignal(config) {
  if (config?.successAction === 'ready_to_buy') return 'ready_to_buy'
  return 'ready_for_human'
}

function getConfiguredGoalUrl(config = {}) {
  const workflow = config.goalWorkflow || {}
  if (config.objective === 'ventas') return workflow.sales || {}
  if (config.objective === 'citas') return workflow.appointments || {}
  return {}
}

function getConfiguredTriggerLink(config = {}) {
  return config.goalWorkflow?.triggerLink || {}
}

function toBoolean(value) {
  return [true, 1, '1', 'true', 'yes', 'on'].includes(
    typeof value === 'string' ? value.trim().toLowerCase() : value
  )
}

function allowAppointmentOverlaps(config = {}) {
  const appointments = config.goalWorkflow?.appointments || {}
  return toBoolean(
    appointments.allowOverlappingAppointments ??
    appointments.allow_overlapping_appointments ??
    appointments.allowOverlaps ??
    appointments.allow_overlaps
  )
}

// El calendario del objetivo lo decide la CONFIGURACIÓN, no el modelo. Si el
// negocio fijó un calendario, toda lectura de disponibilidad y todo agendado
// ocurren en ése, aunque el modelo mande otro id.
function getConfiguredAppointmentCalendarId(config = {}) {
  const configured = String(config.goalWorkflow?.appointments?.calendarId || config.defaultCalendarId || '').trim()
  return configured || null
}

function resolveEffectiveCalendarId(config = {}, requestedCalendarId = '') {
  const configured = getConfiguredAppointmentCalendarId(config)
  const requested = String(requestedCalendarId || '').trim()
  if (configured) {
    return { calendarId: configured, overrodeModelCalendar: Boolean(requested && requested !== configured) }
  }
  return { calendarId: requested || null, overrodeModelCalendar: false }
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

function getSalesPaymentMode(config = {}) {
  const mode = String(config.goalWorkflow?.sales?.paymentMode || config.goalWorkflow?.sales?.payment_mode || '').trim()
  if (mode === 'deposit' || mode === 'full_payment') return mode
  return config.goalWorkflow?.deposit?.enabled ? 'deposit' : 'full_payment'
}

function getDepositRequirement(config = {}) {
  const deposit = config.goalWorkflow?.deposit || {}
  const actionSupportsDeposit = ['book_appointment', 'ready_for_human', 'ready_to_buy', 'send_goal_url', 'send_trigger_link'].includes(config.successAction)
  if (!actionSupportsDeposit) return null
  if (config.objective === 'ventas') {
    return getSalesPaymentMode(config) === 'deposit' ? { ...deposit, enabled: true } : null
  }
  return config.objective === 'citas' && deposit.enabled ? deposit : null
}

function getDepositRequirementForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  if (capability) {
    return capability.paymentMode === 'deposit' || capability.deposit?.enabled
      ? capability.deposit
      : null
  }
  return getDepositRequirement(config)
}

function getDepositPaymentMethodsForRuntime(ctx = {}, config = {}) {
  const capability = getNativeCapability(ctx, config, 'collect_payment')
  if (capability?.deposit) {
    return {
      paymentLink: capability.deposit.methods?.paymentLink === true,
      bankTransfer: capability.deposit.methods?.bankTransfer === true
    }
  }
  return getDepositPaymentMethods(config)
}

function getAccountCurrencyLabel(accountLocale = {}) {
  const currency = String(accountLocale?.currency || '').trim().toUpperCase()
  return currency || 'moneda configurada en la cuenta'
}

function getDepositRequirementLabel(config = {}) {
  return config.objective === 'ventas' ? 'pago solicitado' : 'anticipo'
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
  comprobanteValidado,
  accountLocale = {},
  { appointmentRequestId = '' } = {}
) {
  const deposit = getDepositRequirementForRuntime(ctx, config)
  if (!deposit) return null
  const nativeRuntime = isNativeToolRuntime(ctx, config)
  const nativePaymentPurpose = nativeRuntime ? getNativePaymentPurpose(ctx, config) : ''
  const executionId = String(ctx.executionId || '').trim()
  const reconciliationId = executionId.startsWith('payment-resume:')
    ? executionId.slice('payment-resume:'.length).trim()
    : ''
  const paymentLabel = getDepositRequirementLabel(config)
  if (ctx.dryRun && comprobanteValidado === true) {
    return null
  }
  if (!ctx.dryRun) {
    const accountCurrency = String(accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()
    const sales = config.goalWorkflow?.sales || {}
    const verification = await findVerifiedPaymentEvidence({
      database: db,
      contactId: ctx.contactId,
      agentId: config.id || ctx.agentId || null,
      accountCurrency,
      nativeRuntime,
      requiredPurpose: nativePaymentPurpose,
      reconciliationId,
      appointmentRequestId,
      requirement: {
        ...deposit,
        currency: deposit.currency || accountCurrency,
        primaryLabel: sales.productName || null,
        labels: [sales.productName, sales.priceName].filter(Boolean)
      }
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
    claimedProofIgnored: !ctx.dryRun && comprobanteValidado === true,
    error: ctx.dryRun
      ? `Falta validar el ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). En vivo se exigirá un pago confirmado o registro real; una foto sin validar o un booleano de la IA no bastan. ${collectionHint}`
      : `No existe un pago confirmado o registro verificable del ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). No se ejecutó la acción y no debes afirmar que el comprobante fue validado. ${collectionHint}`
  }
}

function compactObject(input = {}) {
  return Object.entries(input).reduce((acc, [key, value]) => {
    const clean = String(value || '').trim()
    if (clean) acc[key] = clean
    return acc
  }, {})
}

function getGoalLinkContext(config = {}, goalConfig = {}) {
  if (config.objective === 'citas') {
    const calendarId = goalConfig.calendarId || config.defaultCalendarId || ''
    return {
      linkParams: compactObject({ calendar_id: calendarId }),
      expected: compactObject({ calendarId })
    }
  }
  if (config.objective === 'ventas') {
    return {
      linkParams: compactObject({
        product_id: goalConfig.productId,
        price_id: goalConfig.priceId
      }),
      expected: compactObject({
        productId: goalConfig.productId,
        priceId: goalConfig.priceId,
        productName: goalConfig.productName,
        priceName: goalConfig.priceName
      })
    }
  }
  return { linkParams: {}, expected: {} }
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

function getPublicBaseUrl() {
  return String(process.env.RENDER_EXTERNAL_URL || PUBLIC_URL || 'http://localhost:3002').replace(/\/+$/, '')
}

function buildContactTriggerLinkUrl(publicUrl, contactId) {
  const baseUrl = getPublicBaseUrl()
  try {
    const parsed = new URL(publicUrl, `${baseUrl}/`)
    if (contactId) parsed.searchParams.set('contact_id', contactId)
    return parsed.toString()
  } catch {
    const separator = publicUrl.includes('?') ? '&' : '?'
    return contactId ? `${publicUrl}${separator}contact_id=${encodeURIComponent(contactId)}` : publicUrl
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
  if (ctx.dryRun || !ctx.contactId || signal === 'discarded') return
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
    strictEvent: true,
    allowInternalSummary: false
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
  const nativeRuntime = isToolCallingV2(runtimeConfig)
  const scheduleCapability = getNativeCapability(ctx, config, 'schedule_appointment')
  const paymentCapability = getNativeCapability(ctx, config, 'collect_payment')
  const linkCapability = getNativeCapability(ctx, config, 'send_link')
  const handoffCapability = getNativeCapability(ctx, config, 'handoff_human')
  const customCapability = getNativeCapability(ctx, config, 'custom_goal')
  const nativePaymentPurpose = nativeRuntime ? getNativePaymentPurpose(ctx, config) : ''

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
      if (!nativeRuntime || typeof ctx.loadConversationHistoryPage !== 'function') {
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
        calendars: (calendars || []).map((cal) => ({
          ...(!nativeRuntime ? { id: cal.id } : {}),
          name: cal.name
        }))
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
      if (nativeRuntime && paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.productId) {
        sql += ' AND (p.id = ? OR p.ghl_product_id = ?)'
        params.push(paymentCapability.productId, paymentCapability.productId)
      }
      if (nativeRuntime && paymentCapability?.paymentMode !== 'deposit' && paymentCapability?.priceId) {
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
            ...(!nativeRuntime ? { id: row.id } : {}),
            name: row.name,
            description: row.description || null,
            ...(nativeRuntime && paymentCapability && paymentCapability.paymentMode !== 'deposit'
              ? { configuredForPayment: true }
              : {}),
            prices: []
          })
        }
        if (row.amount !== null && row.amount !== undefined) {
          byProduct.get(row.id).prices.push({
            ...(nativeRuntime ? {
              ...(paymentCapability && paymentCapability.paymentMode !== 'deposit'
                ? { configuredForPayment: true }
                : {})
            } : {}),
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
    description: nativeRuntime && handoffCapability?.pastClientsToHuman
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
        nativeRuntime
          ? db.all(`
              SELECT title, start_time, end_time, appointment_status, status
              FROM appointments
              WHERE contact_id = ? AND deleted_at IS NULL AND start_time < ?
                AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'invalid')
              ORDER BY start_time DESC LIMIT 10
            `, [ctx.contactId, nowIso]).catch(() => [])
          : Promise.resolve([]),
        nativeRuntime
          ? db.all(`
              SELECT amount, currency, status, payment_mode, payment_provider,
                     COALESCE(paid_at, date, created_at) AS payment_at
              FROM payments
              WHERE contact_id = ?
              ORDER BY COALESCE(paid_at, date, created_at) DESC
              LIMIT 100
            `, [ctx.contactId]).catch(() => [])
          : Promise.resolve([])
      ])

      let customFields = null
      try {
        customFields = contact.custom_fields ? JSON.parse(contact.custom_fields) : null
      } catch { /* texto plano */ customFields = contact.custom_fields }

      const successfulPayments = nativeRuntime
        ? (paymentRows || []).filter((payment) => {
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
        : []
      const visiblePastAppointments = nativeRuntime
        ? (pastAppointments || []).map((appointment) => ({
            title: appointment.title || null,
            startTime: appointment.start_time,
            endTime: appointment.end_time,
            status: appointment.appointment_status || appointment.status || null
          }))
        : []

      return {
        ok: true,
        contact: {
          ...(!nativeRuntime ? { id: contact.id } : {}),
          fullName: contact.full_name || null,
          phone: contact.phone || null,
          email: contact.email || null,
          customFields,
          ...(!nativeRuntime
            ? { totalPaid: contact.total_paid || 0, purchasesCount: contact.purchases_count || 0 }
            : {})
        },
        upcomingAppointments: appointments.map((appt) => ({
          ...(!nativeRuntime ? { id: appt.id } : {}),
          title: appt.title,
          startTime: appt.start_time,
          endTime: appt.end_time,
          status: appt.appointment_status || appt.status
        })),
        ...(nativeRuntime
          ? {
              pastClientEvidence: {
                isPastClient: successfulPayments.length > 0 || visiblePastAppointments.length > 0,
                successfulPayments,
                pastAppointments: visiblePastAppointments
              }
            }
          : {})
      }
    }
  })

  const saveContactDataTool = tool({
    name: 'save_contact_data',
    description: 'Guarda datos que el contacto te comparta en la conversación (nombre completo o email). Úsala en cuanto la persona te dé un dato nuevo, sin anunciárselo.',
    parameters: z.object({
      fullName: z.string().nullable().describe('Nombre completo si lo compartió'),
      email: z.string().nullable().describe('Email si lo compartió')
    }),
    execute: async ({ fullName, email }) => {
      const body = {}
      if (fullName) body.full_name = fullName
      if (email) body.email = email
      if (!Object.keys(body).length) return { ok: false, error: 'No enviaste ningún dato a guardar' }

      pushAction(ctx, 'save_contact_data', { body })
      if (ctx.dryRun) return { ok: true, simulated: true, saved: body }

      const result = await invokeController(updateContact, { params: { id: ctx.contactId }, body })
      return toToolResult(result, (data) => ({
        ...(!nativeRuntime ? { id: data?.id } : {}),
        fullName: data?.full_name,
        email: data?.email
      }))
    }
  })

  const updateClosingContextTool = tool({
    name: 'update_closing_context',
    description: 'Memoria interna de la estrategia de cierre avanzada de fabrica. Usala en silencio cuando el contacto revele origen, motivo, por que ahora, problema real, conciencia de magnitud del problema, impacto, consecuencia logica, resultado deseado, urgencia, objecion, senal de decision, calidad real de intencion de meta, motivacion real para cumplirla o riesgo de solo comparar precio. No guarda campos personalizados del contacto.',
    parameters: z.object({
      arrivalSource: z.string().nullable().optional().describe('De donde llego si lo dijo o si el sistema lo detecto'),
      contactReason: z.string().nullable().optional().describe('Que lo hizo escribir o pedir información'),
      whyNow: z.string().nullable().optional().describe('Que cambio ahora o cual fue el detonante'),
      surfaceProblem: z.string().nullable().optional().describe('Problema inicial expresado de forma simple'),
      realProblem: z.string().nullable().optional().describe('Problema de fondo, solo si esta sustentado por la conversación'),
      problemMagnitudeAwareness: z.string().nullable().optional().describe('Que tanto la persona ya dimensiona la magnitud, gravedad o riesgo de postergar su problema; registra si lo minimiza, duda o ya entiende la consecuencia de no resolverlo ahora'),
      attemptedBefore: z.string().nullable().optional().describe('Que intento antes o que no le funciono'),
      impact: z.string().nullable().optional().describe('Como le afecta en su dia, negocio, dinero, tiempo o proceso'),
      consequenceIfNoAction: z.string().nullable().optional().describe('Consecuencia logica de quedarse igual, sin inventar miedo'),
      desiredOutcome: z.string().nullable().optional().describe('Resultado que quiere construir'),
      scenarioToAvoid: z.string().nullable().optional().describe('Escenario que quiere evitar'),
      urgencyLevel: z.enum(['baja', 'media', 'alta', 'desconocida']).nullable().optional().describe('Urgencia detectada'),
      objection: z.string().nullable().optional().describe('Freno u objecion principal'),
      decisionSignal: z.string().nullable().optional().describe('Senal de que quiere avanzar, comparar, esperar o hablar con alguien'),
      goalIntentQuality: z.string().nullable().optional().describe('Que tan real se ve que la persona quiere cumplir la meta configurada: agendar, pagar, comprar, tocar un enlace o avanzar en una meta personalizada; registra señales concretas y si es alta, media o dudosa'),
      goalMotivation: z.string().nullable().optional().describe('Por que quiere realmente cumplir esa meta ahora: dolor, urgencia, resultado deseado, consecuencia que quiere evitar, motivo de compra/pago o razon especifica de la meta personalizada'),
      appointmentIntentQuality: z.string().nullable().optional().describe('Alias especifico para agenda: que tan real se ve la intencion de agendar; preferir goalIntentQuality salvo que el detalle sea solo de cita'),
      priceShoppingRisk: z.string().nullable().optional().describe('Senales de que la persona podria estar buscando solo precio o comparando sin intencion real de avanzar; registra el patron sin juzgar ni confrontar'),
      productInterest: z.string().nullable().optional().describe('Producto o servicio especifico que le interesa'),
      valueQuestion: z.string().nullable().optional().describe('Pregunta o sensibilidad sobre valor/precio'),
      timingPreference: z.string().nullable().optional().describe('Fecha, horario o rapidez deseada'),
      nextUsefulQuestion: z.string().nullable().optional().describe('Siguiente pregunta util para no hacer interrogatorio'),
      notes: z.string().nullable().optional().describe('Nota breve de contexto util para cierre')
    }),
    execute: async (patch) => {
      const cleanPatch = Object.fromEntries(
        Object.entries(patch || {}).filter(([, value]) => value !== null && value !== undefined && String(value).trim())
      )
      pushAction(ctx, 'update_closing_context', { keys: Object.keys(cleanPatch) })
      if (!Object.keys(cleanPatch).length) return { ok: false, error: 'No enviaste ningun punto util para actualizar' }
      if (ctx.dryRun || !ctx.contactId) {
        return { ok: true, simulated: true, changedKeys: Object.keys(cleanPatch), context: cleanPatch }
      }

      const result = await updateConversationClosingContext(ctx.contactId, cleanPatch, { updatedBy: 'agent', agentId: config.id || ctx.agentId || null })
      return { ok: true, changedKeys: result.changedKeys, context: result.context }
    }
  })

  const getFreeSlotsForAgentTool = tool({
    name: 'get_free_slots',
    description: nativeRuntime
      ? [
          scheduleCapability?.allowOverlaps
            ? 'Obtiene horarios reales del calendario blindado. El negocio permite empalmar citas dentro de sus horas de atención.'
            : 'Obtiene horarios reales y libres del calendario blindado; no devuelve horarios ocupados.',
          'Cada opción incluye localLabel/localDate/localTime ya calculados en la zona del negocio: usa esos campos para hablar con la persona y NO conviertas el horario por tu cuenta.',
          'Para agendar, pasa options[].startTime exactamente como aparece, sin recalcularlo ni reconstruirlo.'
        ].join(' ')
      : (allowAppointmentOverlaps(config)
          ? 'Obtiene horarios de atención de un calendario para agendar. Este agente SÍ tiene permitido empalmar citas, así que puede devolver horarios aunque ya exista otra cita en ese mismo horario.'
          : 'Obtiene horarios libres de un calendario en un rango de fechas. Este agente NO puede empalmar citas: sólo devuelve horarios sin otra cita activa en ese horario.'),
    parameters: nativeRuntime
      ? z.object({
          startDate: z.string().describe('Fecha inicial YYYY-MM-DD en la zona horaria del negocio'),
          endDate: z.string().describe('Fecha final YYYY-MM-DD en la zona horaria del negocio')
        })
      : z.object({
          calendarId: z.string().nullable().describe('ID del calendario. Déjalo null para usar el calendario configurado del agente; sólo usa list_calendars si no hay calendario configurado.'),
          startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
          endDate: z.string().describe('Fecha final YYYY-MM-DD')
        }),
    execute: async ({ calendarId, startDate, endDate }) => {
      const nativeCalendar = nativeRuntime
        ? await resolveNativeScheduleCalendar(scheduleCapability)
        : null
      const resolvedCalendar = nativeRuntime
        ? { calendarId: nativeCalendar?.id || null, overrodeModelCalendar: false }
        : resolveEffectiveCalendarId(config, calendarId)
      const { calendarId: effectiveCalendarId, overrodeModelCalendar } = resolvedCalendar
      if (!effectiveCalendarId) {
        return { ok: false, total: 0, slots: [], error: nativeRuntime
          ? 'El calendario blindado de la capacidad no existe o ya no está activo. Pasa la conversación a una persona.'
          : 'No hay calendario configurado ni indicado: usa list_calendars para elegir uno activo.' }
      }
      const overlapsAllowed = nativeRuntime
        ? scheduleCapability?.allowOverlaps === true
        : allowAppointmentOverlaps(config)
      const accountTimezone = nativeRuntime ? await getAccountTimezone() : null
      const rawSlots = await getLocalFreeSlots(effectiveCalendarId, startDate, endDate, accountTimezone, {
        ignoreAppointmentConflicts: overlapsAllowed,
        appointmentLimit: overlapsAllowed ? undefined : 1
      })
      const slots = nativeRuntime
        ? buildNativeFreeSlotDays(rawSlots, accountTimezone)
        : rawSlots

      if (!Array.isArray(slots) || !slots.length) {
        return {
          ok: true,
          total: 0,
          slots: [],
          ...(!nativeRuntime ? { calendarId: effectiveCalendarId } : {}),
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
        ...(!nativeRuntime ? { calendarId: effectiveCalendarId } : {}),
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        note: [
          overlapsAllowed
            ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
            : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
          nativeRuntime
            ? 'Muestra localLabel a la persona y usa options[].startTime sin modificar para reservar; la hora local ya está calculada por Ristak.'
            : '',
          overrodeModelCalendar ? 'Se usó el calendario configurado del agente (el id indicado se ignoró).' : ''
        ].filter(Boolean).join(' '),
        slots
      }
    }
  })

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: nativeRuntime
      ? 'Agenda una cita real en el calendario blindado de esta capacidad. Copia exactamente options[].startTime devuelto por get_free_slots; no uses localTime ni conviertas zonas horarias. El servidor vuelve a comprobar el horario y evita carreras.'
      : 'Agenda la cita del contacto en un horario REAL obtenido con get_free_slots y confirmado por la persona. Calcula el fin con la duración del calendario automáticamente. Nunca la uses sin que la persona haya confirmado el horario.',
    parameters: nativeRuntime
      ? z.object({
          startTime: z.string().describe('Valor exacto de options[].startTime devuelto por get_free_slots; no recalcular ni convertir'),
          title: z.string().nullable().describe('Título corto de la cita; null usa el título seguro por defecto'),
          notes: z.string().nullable().describe('Resumen breve de lo que busca la persona; null usa una nota segura')
        })
      : z.object({
          calendarId: z.string().nullable().describe('ID del calendario. Déjalo null para usar el calendario configurado del agente.'),
          startTime: z.string().describe('Inicio exacto del slot elegido, ISO 8601 tal como lo devolvió get_free_slots'),
          title: z.string().nullable().describe('Título corto de la cita (ej. "Cita - Juan Pérez")'),
          notes: z.string().nullable().describe('Resumen breve de lo que busca la persona'),
          comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
          anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
        }),
    execute: async (args) => {
      const {
        calendarId: requestedCalendarId,
        startTime,
        title,
        notes,
        comprobanteValidado,
        anticipoValidado
      } = args || {}
      const nativeCalendar = nativeRuntime
        ? await resolveNativeScheduleCalendar(scheduleCapability)
        : null
      const calendarId = nativeRuntime
        ? nativeCalendar?.id || null
        : resolveEffectiveCalendarId(config, requestedCalendarId).calendarId
      if (!calendarId) {
        return { ok: false, actionCompleted: false, error: nativeRuntime
          ? 'El calendario blindado de la capacidad no existe o ya no está activo. No se agendó nada; pasa la conversación a una persona.'
          : 'No hay calendario configurado ni indicado: usa list_calendars para obtener el ID real. No se agendó nada.' }
      }
      if (!nativeRuntime) {
        const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
        if (phaseError) return phaseError
      }
      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, actionCompleted: false, error: 'startTime inválido: usa exactamente un slot devuelto por get_free_slots. No se agendó nada.' }
      }

      const nativeExecutionId = String(ctx.executionId || '').trim()
      const nativeOverlapsAllowed = scheduleCapability?.allowOverlaps === true
      const nativeDurationMinutes = Number(nativeCalendar?.slot_duration) > 0 ? Number(nativeCalendar.slot_duration) : 60
      if (nativeRuntime && !ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo identificar de forma segura el mensaje que pidió la cita. No se agendó nada; pasa la conversación a una persona.'
        }
      }
      const nativeClientRequestId = nativeRuntime
        ? buildConversationalSlotRequestId(calendarId, start.toISOString(), {
            allowOverlaps: nativeOverlapsAllowed,
            contactId: ctx.contactId,
            channel: ctx.channel,
            executionId: nativeExecutionId
          })
        : null
      // El replay exacto manda sobre el guard de cualquier cita futura: conserva
      // el contrato que informa reprogramación/cancelación de ese mismo intento.
      if (nativeRuntime && !ctx.dryRun) {
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

      const depositContract = nativeRuntime
        ? nativeAppointmentDepositContract(ctx, config)
        : { required: false, hash: '' }
      // Legacy conserva su guard amplio. V2 sólo puede declarar como propia una
      // cita unida durablemente al mismo agente y a su request canónico; una cita
      // propia en otro slot también bloquea una segunda alta y repara el cierre.
      let existing = null
      let boundExisting = null
      if (ctx.contactId && nativeRuntime) {
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
      } else if (ctx.contactId) {
        existing = await db.get(`
          SELECT id, calendar_id, contact_id, title, start_time, end_time, appointment_status, status
          FROM appointments
          WHERE contact_id = ? AND deleted_at IS NULL AND start_time >= ?
            AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow', 'deleted')
          ORDER BY start_time ASC LIMIT 1
        `, [ctx.contactId, new Date().toISOString()])
      }
      if (existing) {
        if (!nativeRuntime) {
          const sameSlot = Math.abs(new Date(existing.start_time).getTime() - start.getTime()) < 60000
          return {
            ok: false,
            actionCompleted: false,
            alreadyBooked: true,
            verifiedExistingAction: true,
            error: sameSlot
              ? 'Esa cita ya quedó agendada; no la dupliques. Confirma a la persona con los datos existentes.'
              : 'El contacto ya tiene una cita próxima activa. Confírmale la cita existente o sugiere reagendar con un humano.',
            existingAppointment: {
              id: existing.id,
              title: existing.title,
              startTime: existing.start_time,
              endTime: existing.end_time,
              status: existing.appointment_status || existing.status
            }
          }
        }
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

      const calendar = nativeRuntime
        ? nativeCalendar
        : await db.get('SELECT id, name, slot_duration FROM calendars WHERE id = ?', [calendarId])
      if (!calendar) return { ok: false, actionCompleted: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real. No se agendó nada.' }

      const durationMinutes = Number(calendar.slot_duration) > 0 ? Number(calendar.slot_duration) : 60
      const overlapsAllowed = nativeRuntime
        ? nativeOverlapsAllowed
        : allowAppointmentOverlaps(config)
      const clientRequestId = nativeRuntime
        ? nativeClientRequestId
        : null

      const depositError = await rejectMissingDepositIfNeeded(
        ctx,
        config,
        comprobanteValidado === true || anticipoValidado === true,
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
      const confirmationEvidence = nativeRuntime
        ? { ok: true, evidenceVerified: false, nativeToolDecision: true }
        : await verifyAppointmentConfirmationEvidence({
            database: db,
            contactId: ctx.contactId,
            startTime: start.toISOString(),
            timezone: businessTimezone,
            dryRun: ctx.dryRun
          })
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

      // En v2 el controller debe recibir primero la llave durable: así un retry
      // idéntico reproduce la cita ya creada antes de volver a evaluar conflicto.
      // La primera creación sí vuelve a comprobar cupo dentro del lock transaccional.
      if (!overlapsAllowed && !nativeRuntime) {
        const conflict = await db.get(`
          SELECT id, title, start_time, end_time, appointment_status, status
          FROM appointments
          WHERE calendar_id = ? AND deleted_at IS NULL
            AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'noshow')
            AND start_time < ?
            AND COALESCE(end_time, start_time) > ?
          ORDER BY start_time ASC LIMIT 1
        `, [calendarId, end.toISOString(), start.toISOString()])

        if (conflict) {
          return {
            ok: false,
            actionCompleted: false,
            overlapBlocked: true,
            error: 'Ese horario ya tiene una cita. Esta configuración no permite empalmar citas; usa get_free_slots y ofrece otro horario libre.',
            existingAppointment: {
              ...(!nativeRuntime ? { id: conflict.id } : {}),
              title: conflict.title,
              startTime: conflict.start_time,
              endTime: conflict.end_time,
              status: conflict.appointment_status || conflict.status
            }
          }
        }
      }

      const contact = await db.get('SELECT full_name, phone FROM contacts WHERE id = ?', [ctx.contactId])
      const finalTitle = title || `Cita - ${contact?.full_name || contact?.phone || 'Contacto'}`
      const action = pushAction(ctx, 'book_appointment', {
        calendarId, startTime: start.toISOString(), endTime: end.toISOString(), title: finalTitle,
        confirmationEvidence: confirmationEvidence.evidenceVerified
          ? {
              messageId: confirmationEvidence.confirmationMessageId || null,
              offerMessageId: confirmationEvidence.offerMessageId || null
            }
          : (nativeRuntime ? { nativeToolDecision: true } : { simulated: true }),
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
            ...(!nativeRuntime ? { calendarId } : {}),
            title: finalTitle,
            startTime: start.toISOString(),
            endTime: end.toISOString()
          },
          ...(!nativeRuntime && clientRequestId ? { clientRequestId } : {})
        }
      }

      let depositReservation = null
      if (nativeRuntime && ctx.verifiedPaymentEvidence?.paymentPurpose === 'appointment_deposit') {
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

      if (nativeRuntime) {
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
            ...(nativeRuntime
              ? {
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
        if (nativeRuntime && toolResult.data?.idempotencyReplay?.canonicalChanged) {
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
        if (nativeRuntime) {
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
        } else {
          const technicalSummary = `${finalTitle} · ${start.toISOString()}`
          try {
            await setConversationSignal(ctx.contactId, 'appointment_booked', {
              reason: 'Cita agendada por el agente',
              actionSummarySource: technicalSummary,
              originalSummary: technicalSummary,
              status: 'completed',
              agentId: config.id || ''
            })
            await applyAgentCompletionAction(config, ctx.contactId)
            await notifyHumanPriority(ctx, {
              reason: 'Cita agendada por el agente',
              summary: technicalSummary,
              signal: 'appointment_booked'
            })
            await recordConversationalAgentEvent({
              contactId: ctx.contactId,
              eventType: 'appointment_booked',
              detail: { appointmentId: toolResult.data?.id, startTime: start.toISOString(), calendarId }
            })
            await applyAgentSuccessExtras(config, ctx.contactId)
          } catch (error) {
            completionSyncWarning = true
            logger.error(`[Agente conversacional] La cita ${toolResult.data?.id} sí se creó, pero falló la sincronización del cierre: ${error.message}`)
          }
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
      if (nativeRuntime) {
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
      return {
        ...toolResult,
        actionCompleted: true,
        ...(completionSyncWarning
          ? { completionSyncWarning: true, note: 'La cita sí fue creada. No la repitas; el cierre interno necesita revisión humana.' }
          : {})
      }
    }
  })

  const markReadyTool = tool({
    name: 'mark_ready_to_advance',
    description: nativeRuntime
      ? `Marca como cumplido el objetivo propio configurado: ${customCapability?.description || 'objetivo personalizado'}. Registra el resultado y entrega el seguimiento al equipo.`
      : 'Marca el objetivo del agente como CUMPLIDO y pasa la conversación a un humano. Es un paso terminal: después el bot deja de responder. Ejecútala SÓLO cuando el objetivo de ESTE agente realmente se cumplió: la persona pidió avanzar/hablar con alguien o aceptó una propuesta concreta que ya le hiciste; o ya recabaste todos los datos que faltaban; o el prospecto ya cumplió tus criterios de calificación; o se cumplió la meta personalizada configurada. Mostrar interés general ("me interesa", "cuánto cuesta") NO es suficiente. Un "quiero cita / quiero agendar / quiero comprar" de entrada y sin contexto TAMPOCO cuenta: eso es momento de CALIFICAR (pregunta para qué lo quiere y qué necesita), no de cerrar. En esos casos sigue conversando. No le digas al cliente que la ejecutaste.',
    parameters: nativeRuntime
      ? z.object({
          intencionDetectada: z.string().describe('Qué condición concreta del objetivo propio ya se cumplió'),
          resumen: z.string().describe('Resumen breve y factual del resultado'),
          urgencia: z.enum(['baja', 'media', 'alta']).nullable().describe('Urgencia para el seguimiento humano; null usa media'),
          siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el equipo')
        })
      : z.object({
          intencionDetectada: z.string().describe('Qué quiere la persona o qué condición del objetivo se cumplió (ej. "pidió que un asesor lo contacte", "ya dio nombre, correo y teléfono", "calificó: tiene presupuesto y decide")'),
          resumen: z.string().describe('Resumen breve de la conversación y su situación'),
          urgencia: z.enum(['baja', 'media', 'alta']).describe('Qué tan pronto quiere avanzar'),
          siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el humano'),
          confirm: z.boolean().describe('true SÓLO cuando el objetivo del agente ya se cumplió de verdad (la persona pidió avanzar/hablar con alguien, aceptó una propuesta concreta, ya recabaste los datos pedidos, el prospecto calificó, o se cumplió la meta personalizada). Interés general ("me interesa", "cuánto cuesta") NO cuenta. Si dudas, es false y sigues conversando.'),
          comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
          anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
        }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso, confirm, comprobanteValidado, anticipoValidado }) => {
      urgencia = urgencia || 'media'
      // Candado funcional anti-falso-cierre: no marcar objetivo cumplido por interés
      // blando. Esto NO vive sólo en el prompt; es una barrera de código. Aplica a
      // TODOS los objetivos que cierran por aquí (pasar a humano, juntar datos,
      // filtrar/calificar, o meta personalizada): el disparo exige una condición real,
      // no sólo que el prospecto parezca interesado.
      if (!nativeRuntime && confirm !== true) {
        return {
          ok: false,
          error: 'Aún no. Ejecuta esto SÓLO cuando el objetivo del agente ya se cumplió de verdad: la persona pidió avanzar o aceptó una propuesta concreta, ya recabaste los datos que pedías, o el prospecto ya calificó. Si sólo mostró interés, sigue conversando: resuelve su duda real y ayúdale a definir el siguiente paso.'
        }
      }
      // Candado de FASES de cierre (persuasión media/alta): no deja marcar el objetivo
      // hasta que la conversación demuestre que se recorrió el arco DE VERDAD (problema
      // real, reto, consecuencia, invitación, objeciones, decisión), no palabras vacías.
      if (!nativeRuntime) {
        const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
        if (phaseError) return phaseError
        const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
        if (depositError) return depositError
      }

      const signal = nativeRuntime ? 'ready_for_human' : resolveAdvanceSignal(config)
      const action = pushAction(ctx, 'mark_ready_to_advance', {
        signal, intencionDetectada, urgencia,
        ...(!nativeRuntime ? { extras: config.successExtras || [] } : {}),
        effect: { liveEffect: 'MARCARÍA el objetivo como CUMPLIDO y pasaría el chat a un humano (el bot deja de responder)', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(nativeRuntime && handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        })
        return {
          ok: true,
          simulated: true,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true,
          ...(nativeRuntime && handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        if (nativeRuntime) {
          const committedHandoff = await commitNativeHandoff({
            ctx,
            config,
            capability: handoffCapability,
            signal,
            signalOptions: {
              reason: `${intencionDetectada} (urgencia ${urgencia})`,
              summary: resumen,
              actionSummarySource: resumen,
              originalSummary: resumen,
              status: 'completed'
            },
            assignmentEventSource: 'custom_goal_completed'
          })
          assignment = committedHandoff.assignment
        } else {
          await setConversationSignal(ctx.contactId, signal, {
            reason: `${intencionDetectada} (urgencia ${urgencia})`,
            summary: resumen,
            status: 'completed',
            agentId: config.id || ''
          })
        }
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el objetivo cumplido: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: nativeRuntime && error?.code
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
      if (!nativeRuntime) {
        await runPostCommitStep('completion_action', () => applyAgentCompletionAction(config, ctx.contactId))
      }
      await runPostCommitStep('priority_notification', () => notifyHumanPriority(ctx, {
        reason: intencionDetectada,
        summary: resumen,
        signal
      }))
      // Telemetría separable: distingue "objetivo cumplido (pasa a humano)" de un
      // simple signal_set, para poder auditar falsos cierres en reportería.
      await runPostCommitStep('objective_event', () => recordConversationalAgentEvent({
        contactId: ctx.contactId,
        eventType: 'objective_completed',
        detail: { agentId: config.id || ctx.agentId || null, signal, kind: 'ready_for_human', intencionDetectada, urgencia, siguientePaso: siguientePaso || null }
      }))
      if (!nativeRuntime) {
        await runPostCommitStep('success_extras', () => applyAgentSuccessExtras(config, ctx.contactId))
      }
      settleAction(action, 'ok', {
        signal,
        objectiveCompleted: true,
        ...(nativeRuntime && assignment.assigned
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
        ...(nativeRuntime && assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        ...(postCommitWarnings.length ? { postCommitWarning: true } : {}),
        note: nativeRuntime
          ? 'Objetivo registrado y entregado al equipo. Responde siempre con un cierre breve, visible y natural.'
          : 'Objetivo registrado (pasa a humano). Cierra con una frase mínima o no respondas más.'
      }
    }
  })

  const createPaymentLinkTool = tool({
    name: 'create_payment_link',
    description: nativeRuntime
      ? 'Crea el link del producto/precio blindado en la capacidad de cobro. El servidor decide concepto, monto y moneda desde la base; la herramienta nunca confirma el pago.'
      : 'Crea y envía un link de pago real al contacto actual. Úsala sólo después de confirmar concepto, monto, moneda y canal con la persona. Nunca inventes precios: usa list_products o el producto configurado del agente.',
    parameters: nativeRuntime
      ? z.object({
          quantity: z.number().int().min(1).max(100).nullable().describe('Cantidad entre 1 y 100; null equivale a 1'),
          agreedAmount: z.number().positive().nullable().describe('Monto acordado dentro del rango del anticipo; null cuando el precio es fijo')
        })
      : z.object({
          amount: z.number().positive().describe('Monto confirmado del cobro'),
          currency: z.string().nullable().describe('Moneda ISO opcional; si falta se usa la moneda de la cuenta'),
          concept: z.string().describe('Concepto breve del cobro'),
          dueDate: z.string().nullable().describe('Fecha límite de pago YYYY-MM-DD opcional'),
          channel: z.enum(['email', 'whatsapp', 'sms', 'all']).describe('Canal confirmado para enviar el link'),
          confirm: z.boolean().describe('true sólo cuando la persona ya aprobó explícitamente el cobro'),
          comprobanteValidado: z.boolean().nullable().optional().describe('Campo legacy ignorado: un booleano de la IA nunca valida un pago'),
          anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy ignorado')
        }),
    execute: async ({ amount, currency, concept, dueDate, channel, confirm, quantity, agreedAmount }) => {
      if (!nativeRuntime && !confirm) {
        return { ok: false, actionCompleted: false, error: 'Falta confirmación explícita. Resume monto, concepto y canal, y pide aprobación antes de crear el link. No se creó ni envió nada.' }
      }
      if (!nativeRuntime) {
        const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
        if (phaseError) return phaseError
      }

      // El link es el mecanismo para cobrar el pago completo o el anticipo. No exigimos
      // un comprobante previo para crearlo; sí amarramos el cobro al workflow/catálogo.
      const accountCurrency = String(
        ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')
      ).trim().toUpperCase()
      const paymentValidation = nativeRuntime
        ? await resolveNativePaymentAuthority({
            capability: paymentCapability,
            quantity: quantity || 1,
            agreedAmount,
            accountCurrency
          })
        : await validatePaymentRequestAgainstCatalog({
            database: db,
            config,
            accountCurrency,
            amount,
            currency,
            concept
          })
      if (!paymentValidation.ok) return paymentValidation
      const trustedPayment = paymentValidation.trusted
      const deliveryChannel = nativeRuntime ? String(ctx.channel || '').toLowerCase() : channel
      const paymentIdempotencyKey = nativeRuntime
        ? buildConversationalPaymentLinkIdempotencyKey({
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
        : ''
      if (nativeRuntime && !ctx.dryRun && !paymentIdempotencyKey) {
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
          dueDate: dueDate || undefined,
          channels: buildPaymentChannels(deliveryChannel),
          source: nativeRuntime ? 'conversational_agent_v2' : 'conversational_agent',
          ...(nativeRuntime
            ? {
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
              }
            : {})
        })

        const resultCurrency = String(result?.currency || '').trim().toUpperCase()
        const resultAmount = Number(result?.amount)
        const paymentLedger = nativeRuntime && result?.invoiceId
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
        const ledgerCanonicalMatch = !nativeRuntime || Boolean(
          paymentLedger?.id &&
          Number.isFinite(ledgerAmount) &&
          Math.abs(ledgerAmount - trustedPayment.amount) < 0.005 &&
          ledgerCurrency === trustedPayment.currency &&
          ['live', 'test'].includes(ledgerEnvironment)
        )
        const sent = Boolean(result?.invoiceId && result?.paymentLink && result?.sendMethod !== 'none' && result?.status !== 'draft')
        const prepared = nativeRuntime
          ? Boolean(result?.invoiceId && result?.paymentLink && paymentLedger?.id)
          : sent
        const canonicalMatch = Math.abs(resultAmount - trustedPayment.amount) < 0.005 && resultCurrency === trustedPayment.currency
        if (!prepared || !canonicalMatch || !ledgerCanonicalMatch) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'payment_link_failed',
            detail: {
              reason: !prepared
                ? (nativeRuntime ? 'link_not_prepared' : 'link_not_sent')
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
            paymentMode: nativeRuntime ? paymentCapability?.paymentMode : getSalesPaymentMode(config),
            runtimeMode: nativeRuntime ? 'tool_calling_v2' : 'legacy_v1',
            ...(nativeRuntime
              ? {
                  ledgerPaymentId: paymentLedger.id,
                  paymentEnvironment: ledgerEnvironment,
                  productId: trustedPayment.productId || null,
                  priceId: trustedPayment.priceId || null,
                  paymentPurpose: nativePaymentPurpose,
                  appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
                  executionId: String(ctx.executionId || '').trim()
                }
              : {}),
            status: result.status,
            ...(result.reused ? { reused: true } : {})
          }
          if (nativeRuntime) {
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
          } else {
            await recordConversationalAgentEvent({
              contactId: ctx.contactId,
              eventType: sourceEventType,
              detail: sourceDetail
            })
          }
        } catch (error) {
          if (!nativeRuntime) {
            logger.warn(`[Agente conversacional] El link ${result.invoiceId} sí se envió, pero falló su telemetría: ${error.message}`)
          } else {
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
        }
        settleAction(action, 'ok', {
          invoiceId: result.invoiceId,
          ...(nativeRuntime ? { paymentLink: result.paymentLink } : {}),
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
          ...(!nativeRuntime ? { invoiceId: result.invoiceId } : {}),
          paymentLink: result.paymentLink,
          sendMethod: result.sendMethod,
          amount: result.amount,
          currency: result.currency,
          status: nativeRuntime ? 'pending' : result.status,
          ...(nativeRuntime ? { providerStatus: result.status, paymentConfirmed: false, objectiveCompleted: false } : {}),
          // (AI-004) Evita que el modelo reenvíe/duplique: avísale que ya había un link equivalente.
          note: result.reused
            ? 'Ya existía un link de pago equivalente reciente para este contacto; se reutilizó en lugar de crear otro. Confirma a la persona con ese mismo link; no generes uno nuevo.'
            : nativeRuntime
              ? 'Link preparado. El pago sigue pendiente: sólo una confirmación real del proveedor puede marcarlo como pagado.'
              : 'Link enviado. La venta sigue pendiente hasta que Ristak confirme el pago real del invoice.'
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
    description: nativeRuntime
      ? 'Prepara el enlace blindado de la capacidad send_link. Nunca agrega contact_id ni marca la meta como cumplida por un clic no autenticado.'
      : 'Genera el enlace configurado para que la persona agende o compre fuera de Ristak. Úsala sólo cuando la persona ya esté lista para avanzar. El objetivo queda pendiente hasta que una integración autenticada confirme el ID real de cita, compra, orden o pago.',
    parameters: nativeRuntime
      ? z.object({
          intencionDetectada: z.string().nullable().describe('Qué quiere lograr la persona; null si no hace falta contexto extra'),
          resumen: z.string().nullable().describe('Resumen breve para auditoría; null si no hace falta contexto extra')
        })
      : z.object({
          intencionDetectada: z.string().describe('Qué quiere lograr la persona, por ejemplo agendar valoración o completar compra'),
          resumen: z.string().describe('Resumen breve del contexto útil para auditoría interna'),
          confirm: z.boolean().describe('true sólo cuando la persona ya aceptó avanzar por enlace'),
          comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
          anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
        }),
    execute: async ({ intencionDetectada, resumen, confirm, comprobanteValidado, anticipoValidado }) => {
      intencionDetectada = intencionDetectada || 'Solicitó el enlace'
      resumen = resumen || ''
      if (!nativeRuntime && !confirm) {
        return { ok: false, error: 'Falta confirmación explícita. Primero confirma que la persona quiere avanzar por enlace.' }
      }
      if (!nativeRuntime) {
        const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
        if (phaseError) return phaseError
        const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
        if (depositError) return depositError
      }

      let goalConfig = nativeRuntime
        ? {
            url: linkCapability?.url || '',
            trackingParam: linkCapability?.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
          }
        : getConfiguredGoalUrl(config)
      const nativeExecutionId = String(ctx.executionId || '').trim()
      if (nativeRuntime && !ctx.dryRun && !nativeExecutionId) {
        return {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          code: 'goal_link_execution_id_missing',
          error: 'No se pudo identificar de forma segura el mensaje que pidió este enlace. No se preparó nada; pasa la conversación a una persona.'
        }
      }

      if (nativeRuntime && linkCapability?.linkKind === 'trigger') {
        let triggerLink = null
        if (linkCapability.triggerLinkId) {
          triggerLink = await getTriggerLink(linkCapability.triggerLinkId, { baseUrl: getPublicBaseUrl() })
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
          objective: config.objective,
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
      if (!targetUrl || (nativeRuntime && !isSafeHttpUrl(targetUrl))) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = nativeRuntime
        ? { linkParams: {}, expected: { capabilityId: 'send_link' } }
        : getGoalLinkContext(config, goalConfig)

      const action = pushAction(ctx, 'send_goal_url', {
        objective: config.objective, intencionDetectada, targetUrl,
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
          objective: config.objective,
          targetUrl,
          trackingParam,
          linkParams: linkContext.linkParams,
          idempotencyKey: nativeRuntime
            ? `send_goal_url_v2:${createHash('sha256').update([
                ctx.contactId || '',
                config.id || ctx.agentId || '',
                targetUrl,
                String(ctx.channel || '').trim().toLowerCase(),
                nativeExecutionId
              ].join('\u0000')).digest('hex')}`
            : (ctx.executionId
                ? `send_goal_url:${ctx.contactId}:${config.id || ctx.agentId || ''}:${ctx.channel || ''}:${ctx.executionId}`
                : ''),
          metadata: {
            expected: linkContext.expected,
            intencionDetectada,
            resumen,
            ...(nativeRuntime
              ? { channel: String(ctx.channel || '').trim().toLowerCase(), executionId: nativeExecutionId }
              : {})
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
          ...(!nativeRuntime ? { goalId: link.id } : {}),
          confirmationMode: 'trusted_integration',
          note: 'Esta misma meta ya fue confirmada. No vuelvas a mandar el enlace.'
        }
      }

      settleAction(action, 'ok', {
        goalId: link.id,
        ...(nativeRuntime ? { sentUrl: link.sentUrl } : {}),
        linkPrepared: true,
        confirmationMode: 'trusted_integration',
        deliveryConfirmed: false,
        objectiveCompleted: false
      })

      return {
        ok: true,
        actionCompleted: true,
        ...(!nativeRuntime ? { goalId: link.id } : {}),
        sentUrl: link.sentUrl,
        trackingParam: link.trackingParam,
        linkParams: link.linkParams,
        confirmationMode: 'trusted_integration',
        idempotent: link.idempotent === true,
        note: 'Manda sentUrl visible en el chat. No digas que el objetivo ya quedó cumplido; sólo una integración autenticada puede confirmar el ID real.'
      }
    }
  })

  const sendTriggerLinkTool = tool({
    name: 'send_trigger_link',
    description: 'Manda el enlace de disparo configurado para este objetivo. Úsala sólo cuando la persona ya esté lista para tocar ese enlace. El objetivo se cumple cuando el contacto toca ese enlace; después Ristak detiene la IA y pasa el chat a humano.',
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué quiere lograr la persona antes de recibir el enlace'),
      resumen: z.string().describe('Resumen breve del contexto útil para el humano'),
      confirm: z.boolean().describe('true sólo cuando la persona ya aceptó avanzar con ese enlace'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ intencionDetectada, resumen, confirm, comprobanteValidado, anticipoValidado }) => {
      if (!confirm) {
        return { ok: false, error: 'Falta confirmación explícita. Primero confirma que la persona quiere avanzar con ese enlace.' }
      }
      const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
      if (phaseError) return phaseError
      const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const configuredLink = getConfiguredTriggerLink(config)
      const triggerLinkId = configuredLink.triggerLinkId || ''
      if (!triggerLinkId) {
        return { ok: false, error: 'No hay enlace de disparo configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }

      const baseUrl = getPublicBaseUrl()
      let link = {
        id: triggerLinkId,
        publicId: configuredLink.triggerLinkPublicId || '',
        name: configuredLink.triggerLinkName || 'Enlace de disparo',
        publicUrl: configuredLink.triggerLinkUrl || buildTriggerLinkPublicUrl(configuredLink.triggerLinkPublicId, baseUrl),
        active: true,
        archived: false
      }

      if (!ctx.dryRun) {
        const storedLink = await getTriggerLink(triggerLinkId, { baseUrl })
        if (!storedLink || storedLink.archived) {
          return { ok: false, error: 'El enlace de disparo configurado ya no existe. Manda a humano y pide revisar la configuración.' }
        }
        if (!storedLink.active) {
          return { ok: false, error: 'El enlace de disparo configurado está apagado. Manda a humano y pide revisar la configuración.' }
        }
        link = storedLink
      }

      const publicUrl = link.publicUrl || buildTriggerLinkPublicUrl(link, baseUrl)
      const sentUrl = buildContactTriggerLinkUrl(publicUrl, ctx.contactId)

      const action = pushAction(ctx, 'send_trigger_link', {
        objective: config.objective,
        intencionDetectada,
        triggerLinkId: link.id,
        triggerLinkPublicId: link.publicId || null,
        effect: { liveEffect: 'ENVIARÍA el enlace de disparo (el objetivo se cumple sólo cuando el contacto lo toque)', marksObjectiveCompleted: false }
      })

      // (AI-005) Idempotencia: si ya se envió un enlace de disparo a este contacto hace
      // poco, no repetimos el efecto (evita que el agente lo reenvíe en bucle).
      let alreadySent = false
      if (!ctx.dryRun) {
        try {
          alreadySent = await hasRecentConversationalAgentEvent({ contactId: ctx.contactId, eventType: 'trigger_link_sent' })
        } catch (error) {
          logger.warn(`[Agente conversacional] No se pudo verificar idempotencia del enlace de disparo: ${error.message}`)
          const errorResult = {
            ok: false,
            actionCompleted: false,
            transferRequired: true,
            error: 'No se pudo comprobar si el enlace ya había sido enviado. No lo reenvíes a ciegas; pasa la conversación a una persona.'
          }
          settleAction(action, 'error', {
            error: errorResult.error,
            linkPrepared: false,
            deliveryConfirmed: false,
            transferRequired: true
          })
          return errorResult
        }
      }
      if (alreadySent) {
        settleAction(action, 'ok', {
          actionCompleted: false,
          alreadySent: true,
          triggerLinkId: link.id,
          linkPrepared: true,
          priorSendEventFound: true,
          deliveryConfirmed: false,
          objectiveCompleted: false
        })
        return {
          ok: true,
          actionCompleted: false,
          alreadySent: true,
          triggerLinkId: link.id,
          triggerLinkPublicId: link.publicId || null,
          triggerLinkName: link.name,
          sentUrl,
          note: 'Ya enviaste este enlace hace poco. NO lo reenvíes salvo que el cliente lo pida explícitamente.'
        }
      }
      let telemetryWarning = false
      if (!ctx.dryRun) {
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'trigger_link_sent',
          detail: {
            agentId: config.id || ctx.agentId || null,
            intencionDetectada,
            resumen,
            triggerLinkId: link.id,
            triggerLinkPublicId: link.publicId || null,
            triggerLinkName: link.name
          }
        }).catch((error) => {
          telemetryWarning = true
          logger.warn(`[Agente conversacional] El enlace de disparo sí quedó preparado, pero falló su telemetría: ${error.message}`)
        })
      }

      settleAction(action, ctx.dryRun ? 'simulated' : 'ok', {
        actionCompleted: !ctx.dryRun,
        triggerLinkId: link.id,
        linkPrepared: !ctx.dryRun,
        deliveryConfirmed: false,
        objectiveCompleted: false,
        ...(telemetryWarning ? { warnings: ['trigger_link_event'] } : {})
      })

      return {
        ok: true,
        actionCompleted: !ctx.dryRun,
        simulated: Boolean(ctx.dryRun),
        triggerLinkId: link.id,
        triggerLinkPublicId: link.publicId || null,
        triggerLinkName: link.name,
        sentUrl,
        note: 'Manda sentUrl visible en el chat. No digas que el objetivo ya quedó cumplido; se confirma cuando el contacto toque ese enlace.'
      }
    }
  })

  const sendToHumanTool = tool({
    name: 'send_to_human',
    description: nativeRuntime
      ? `Entrega la conversación al equipo${handoffCapability?.userName ? `, asignándola a ${handoffCapability.userName}` : ''}. Úsala para las reglas configuradas${handoffCapability?.pastClientsToHuman ? ' y siempre que get_contact_profile confirme que es cliente previo' : ''}.`
      : 'Manda la conversación a un humano: preguntas delicadas, quejas serias, confusión fuerte, información que no tienes, o casos definidos por el negocio. Crea la señal interna y el agente deja de responder. No le digas al cliente que lo estás transfiriendo.',
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
          ...(nativeRuntime && handoffCapability?.userId
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
          ...(nativeRuntime && handoffCapability?.userId
            ? { wouldAssignConfiguredUser: true, assignedUserName: handoffCapability.userName || null }
            : {})
        }
      }

      let assignment = { assigned: false, alreadyAssigned: false, userName: null }
      try {
        if (nativeRuntime) {
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
        } else {
          await setConversationSignal(ctx.contactId, 'ready_for_human', {
            reason: motivo,
            summary: resumen,
            status: 'human',
            agentId: config.id || ''
          })
        }
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo transferir la conversación: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          ...(error?.code ? { code: error.code } : {}),
          error: nativeRuntime && error?.code
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
        ...(nativeRuntime && assignment.assigned
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
        ...(nativeRuntime && assignment.assigned ? { assignedUserName: assignment.userName } : {}),
        note: 'Un humano seguirá la conversación. Si hace falta, cierra con una frase breve y natural (ej. que en un momento le confirmas).'
      }
    }
  })

  const discardConversationTool = tool({
    name: 'discard_conversation',
    description: 'Herramienta interna de descarte. Ejecútala ante acoso, insultos, spam, phishing, amenazas, contenido ilegal o mensajes claramente ajenos al negocio. Detiene la conversación sin confrontar.',
    parameters: z.object({
      motivo: z.string().describe('Motivo del descarte'),
      resumen: z.string().describe('Resumen breve de lo ocurrido'),
      nivelDeRiesgo: z.enum(['bajo', 'medio', 'alto']).describe('Nivel de riesgo percibido')
    }),
    execute: async ({ motivo, resumen, nivelDeRiesgo }) => {
      const action = pushAction(ctx, 'discard_conversation', {
        motivo, nivelDeRiesgo,
        effect: { liveEffect: 'DESCARTARÍA la conversación (el bot deja de responder). NO marca el objetivo como cumplido.', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        ctx.suppressReply = true
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal: 'discarded',
          wouldSuppressReply: true,
          objectiveCompleted: false
        })
        return { ok: true, simulated: true, signal: 'discarded' }
      }

      try {
        await setConversationSignal(ctx.contactId, 'discarded', {
          reason: `${motivo} (riesgo ${nivelDeRiesgo})`,
          summary: resumen,
          status: 'discarded',
          agentId: config.id || ''
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo descartar la conversación: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          error: 'No se pudo registrar el descarte. No afirmes que la conversación quedó cerrada.'
        }
        settleAction(action, 'error', { error: errorResult.error })
        return errorResult
      }

      ctx.suppressReply = true
      settleAction(action, 'ok', {
        signal: 'discarded',
        conversationDiscarded: true,
        replySuppressed: true,
        objectiveCompleted: false
      })
      return { ok: true, actionCompleted: true, signal: 'discarded', note: 'Conversación descartada. No respondas nada más.' }
    }
  })

  const staySilentTool = tool({
    name: 'stay_silent',
    description: 'Ejecútala cuando el último mensaje no necesita respuesta (cierre de cortesía, sticker, "ok" final, o ya ejecutaste una acción interna y no hace falta texto). El sistema no enviará mensaje.',
    parameters: z.object({
      motivo: z.string().nullable().describe('Por qué no hace falta responder')
    }),
    execute: async ({ motivo }) => {
      ctx.suppressReply = true
      pushAction(ctx, 'stay_silent', { motivo: motivo || null })
      return { ok: true, note: 'No se enviará respuesta.' }
    }
  })

  const registerDepositProofTool = tool({
    name: 'register_deposit_payment_proof',
    description: nativeRuntime
      ? 'Lee la foto o PDF de una transferencia y registra el comprobante como PENDIENTE DE REVISIÓN. Nunca confirma fondos ni marca el pago como pagado.'
      : 'Valida el comprobante de transferencia que el contacto mandó en FOTO o PDF y, si el monto coincide con el anticipo configurado, registra el pago real. Ejecútala EN SILENCIO en cuanto llegue el comprobante. SOLO su resultado ok cuenta como anticipo pagado; nunca lo des por validado tú.',
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
      const paymentLabel = getDepositRequirementLabel(config)
      const expectedLabel = formatDepositRequirement(deposit, ctx.accountLocale)

      const action = pushAction(ctx, 'register_deposit_payment_proof', {
        montoIndicado: Number(montoIndicado) || null,
        referencia: referencia || null,
        effect: { liveEffect: nativeRuntime
          ? `LEERÍA el comprobante y lo registraría como pendiente de revisión; no confirma el ${paymentLabel}`
          : `VALIDARÍA el comprobante con visión y registraría el ${paymentLabel} como pago real`, marksObjectiveCompleted: false }
      })

      if (ctx.dryRun) {
        if (nativeRuntime) {
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
        settleAction(action, 'simulated', { actionCompleted: false, wouldRegisterPayment: true })
        return {
          ok: true,
          simulated: true,
          wouldRegisterPayment: true,
          note: `Simulación: en vivo se leería el comprobante real y sólo se registraría el pago si el monto coincide con ${expectedLabel}.`
        }
      }

      const accountCurrency = String(ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')).trim().toUpperCase()

      // Idempotencia: si el anticipo ya quedó registrado (por esta tool o por el
      // equipo), no se duplica el pago.
      const existingEvidence = await findVerifiedPaymentEvidence({
        database: db,
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        accountCurrency,
        nativeRuntime,
        requiredPurpose: nativePaymentPurpose,
        reconciliationId: String(ctx.executionId || '').startsWith('payment-resume:')
          ? String(ctx.executionId).slice('payment-resume:'.length).trim()
          : '',
        requirement: { ...deposit, currency: deposit.currency || accountCurrency }
      })
      if (existingEvidence.ok) {
        settleAction(action, 'ok', { actionCompleted: true, alreadyRegistered: true, paymentId: existingEvidence.evidence.paymentId })
        if (!nativeRuntime) {
          return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: existingEvidence.evidence, note: `El ${paymentLabel} ya estaba registrado; continúa con la acción de avance.` }
        }
        const visibleEvidence = nativeRuntime
          ? {
              amount: existingEvidence.evidence.amount,
              currency: existingEvidence.evidence.currency,
              status: existingEvidence.evidence.status,
              paidAt: existingEvidence.evidence.paidAt
            }
          : existingEvidence.evidence
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

      // Legacy conserva su dedupe temporal. V2 liga el comprobante exacto
      // (mensaje+contacto+agente) con el ledger dentro de una sola transacción.
      const duplicate = nativeRuntime
        ? null
        : await findRecentAgentTransferDepositPayment({ contactId: ctx.contactId, amount: analysis.amount })
      if (duplicate) {
        settleAction(action, 'ok', {
          actionCompleted: true,
          alreadyRegistered: true,
          paymentId: duplicate.id,
          ...(nativeRuntime ? { paymentConfirmed: false } : {})
        })
        if (!nativeRuntime) {
          return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: { paymentId: duplicate.id, amount: duplicate.amount, currency: duplicate.currency }, note: `Ese comprobante ya estaba registrado; continúa con la acción de avance.` }
        }
        return {
          ok: true,
          actionCompleted: true,
          alreadyRegistered: true,
          payment: {
            ...(!nativeRuntime ? { paymentId: duplicate.id } : {}),
            amount: duplicate.amount,
            currency: duplicate.currency,
            status: duplicate.status
          },
          paymentConfirmed: false,
          note: 'Ese comprobante ya está pendiente de revisión. No confirmes el pago; el equipo debe verificar los fondos.'
        }
      }

      let payment
      try {
        const registerProof = nativeRuntime
          ? registerAgentTransferPaymentProofForReview
          : registerAgentTransferDepositPayment
        payment = await registerProof({
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
          ...(nativeRuntime
            ? {
                conversationalBinding: {
                  bindingKey: receiptMedia.messageId,
                  channel: String(ctx.channel || 'whatsapp').trim().toLowerCase(),
                  executionId: String(ctx.executionId || '').trim(),
                  paymentPurpose: nativePaymentPurpose,
                  appointmentDeposit: nativePaymentPurpose === 'appointment_deposit',
                  confidence: analysis.confidence
                }
              }
            : {})
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el anticipo por transferencia: ${error.message}`)
        settleAction(action, 'error', { error: error.message })
        return { ok: false, actionCompleted: false, transferRequired: true, error: 'El comprobante se leyó bien pero no se pudo registrar el pago. Pasa la conversación a una persona con send_to_human.' }
      }

      if (!nativeRuntime) {
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'deposit_transfer_registered',
          detail: {
            agentId: config.id || null,
            paymentId: payment.paymentId,
            amount: payment.amount,
            currency: payment.currency,
            mediaMessageId: receiptMedia.messageId || null,
            confidence: analysis.confidence
          }
        }).catch(() => {})
      }
      // El equipo recibe aviso para auditar el comprobante aunque el agente continúe.
      if (!payment.alreadyRegistered) {
        await notifyHumanPriority(ctx, {
          reason: nativeRuntime
            ? `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia pendiente de revisar`
            : `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia validado por IA`,
          summary: `${payment.amount} ${payment.currency} · revisar comprobante`,
          signal: nativeRuntime ? 'deposit_transfer_pending_review' : 'deposit_transfer_registered'
        })
      }

      settleAction(action, 'ok', {
        actionCompleted: true,
        paymentId: payment.paymentId,
        amount: payment.amount,
        currency: payment.currency,
        ...(nativeRuntime
          ? {
              paymentStatus: payment.status,
              paymentConfirmed: false,
              alreadyRegistered: payment.alreadyRegistered === true
            }
          : {})
      })
      if (!nativeRuntime) {
        return {
          ok: true,
          actionCompleted: true,
          payment: { paymentId: payment.paymentId, amount: payment.amount, currency: payment.currency },
          note: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} registrado y validado. Confirma a la persona con naturalidad y continúa con la acción de avance.`
        }
      }
      return {
        ok: true,
        actionCompleted: true,
        payment: {
          ...(!nativeRuntime ? { paymentId: payment.paymentId } : {}),
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status
        },
        paymentConfirmed: false,
        note: 'Comprobante recibido y pendiente de revisión humana. No digas que el pago está confirmado y no continúes con una acción que exija fondos verificados.'
      }
    }
  })

  if (nativeRuntime) {
    const enabledCapabilities = new Set(
      getEnabledConversationalCapabilities(runtimeConfig).map((capability) => capability.id)
    )
    const nativeTools = [
      getBusinessProfileTool,
      listProductsTool,
      getContactProfileTool
    ]

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

  const tools = [
    getBusinessProfileTool,
    listProductsTool,
    getContactProfileTool,
    ...(ctx.followUpMode ? [] : [saveContactDataTool]),
    ...(ctx.followUpMode || config.closingStrategyMode === 'custom' ? [] : [updateClosingContextTool]),
    ...(ctx.followUpMode ? [] : [
    sendToHumanTool,
    discardConversationTool,
    staySilentTool
    ])
  ]

  // Disponibilidad y agenda: lectura siempre (para responder horarios reales);
  // escritura solo si el negocio configuró agenda directa.
  tools.push(listCalendarsTool, getFreeSlotsForAgentTool)
  if (!ctx.followUpMode) {
    // La herramienta de cierre que se EXPONE depende del objetivo real del agente.
    // mark_ready_to_advance marca el objetivo como CUMPLIDO (traspaso a humano), por eso
    // NO se ofrece para citas/ventas/enlaces: ésos cierran con su acción real y
    // verificable (una cita con horario, un pago confirmado, un enlace tocado), nunca por
    // "avanzar" con puro interés. Se expone para ready_for_human y para cualquier config
    // sin acción de cierre concreta (dato/filtrar/handoff), que es justo lo que el prompt
    // referencia por defecto. Todos conservan send_to_human para escalar cuando se atoran,
    // pero eso NO marca objetivo cumplido (queda como 'humano').
    const CONCRETE_CLOSE_ACTIONS = ['book_appointment', 'ready_to_buy', 'send_goal_url', 'send_trigger_link']
    if (!CONCRETE_CLOSE_ACTIONS.includes(config?.successAction)) tools.push(markReadyTool)
    if (config?.successAction === 'book_appointment') tools.push(bookAppointmentTool)
    if (config?.successAction === 'ready_to_buy') tools.push(createPaymentLinkTool)
    if (config?.successAction === 'send_goal_url') tools.push(sendGoalUrlTool)
    if (config?.successAction === 'send_trigger_link') tools.push(sendTriggerLinkTool)

    // Cobro del anticipo: el agente necesita con qué cobrarlo según los métodos
    // configurados, sin importar cuál sea su acción de cierre.
    const depositRequirement = getDepositRequirement(config)
    if (depositRequirement) {
      const depositMethods = getDepositPaymentMethods(config)
      if (depositMethods.paymentLink && config?.successAction !== 'ready_to_buy') {
        tools.push(createPaymentLinkTool)
      }
      if (depositMethods.bankTransfer) {
        tools.push(registerDepositProofTool)
      }
    }
  }
  return tools
}
