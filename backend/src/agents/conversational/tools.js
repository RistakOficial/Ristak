import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { PUBLIC_URL } from '../../config/constants.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { updateContact } from '../../controllers/contactsController.js'
import { listCalendarsTool } from '../tools/appointmentTools.js'
import { getLocalFreeSlots } from '../../services/localCalendarService.js'
import {
  createSinglePaymentLink,
  findRecentAgentTransferDepositPayment,
  registerAgentTransferDepositPayment
} from '../../services/paymentFlowService.js'
import { getBusinessProfileSnapshot, getOpenAIApiKey } from '../../services/aiAgentService.js'
import { getDepositPaymentMethods } from './prompt.js'
import { analyzePaymentReceiptImage } from './mediaContext.js'
import { buildTriggerLinkPublicUrl, getTriggerLink } from '../../services/triggerLinksService.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone } from '../../utils/dateUtils.js'
import { getAccountCurrency } from '../../utils/accountLocale.js'
import {
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
  depositRequirementAmountMatches,
  findVerifiedPaymentEvidence,
  revalidateAppointmentSlot,
  validatePaymentRequestAgainstCatalog,
  verifyAppointmentConfirmationEvidence
} from './actionEvidence.js'

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

async function rejectMissingDepositIfNeeded(ctx, config = {}, comprobanteValidado, accountLocale = {}) {
  const deposit = getDepositRequirement(config)
  if (!deposit) return null
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
  const methods = getDepositPaymentMethods(config)
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

export function createConversationalTools(ctx) {
  const { config } = ctx

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
        calendars: (calendars || []).map((cal) => ({ id: cal.id, name: cal.name }))
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
        SELECT p.id, p.name, p.description, pp.name AS price_name, pp.amount, pp.currency, pp.type AS price_type
        FROM products p
        LEFT JOIN product_prices pp ON pp.product_id = p.id
        WHERE p.is_active = 1`
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
            id: row.id,
            name: row.name,
            description: row.description || null,
            prices: []
          })
        }
        if (row.amount !== null && row.amount !== undefined) {
          byProduct.get(row.id).prices.push({
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
    description: 'Devuelve los datos reales del contacto con el que conversas (nombre, teléfono, email, datos personalizados) y sus citas próximas. Úsala para no pedir datos que ya existen y para saber si ya tiene cita agendada.',
    parameters: z.object({}),
    execute: async () => {
      const contact = await db.get(`
        SELECT id, full_name, first_name, last_name, phone, email, custom_fields, total_paid, purchases_count
        FROM contacts WHERE id = ?
      `, [ctx.contactId])
      if (!contact) return { ok: false, error: 'Contacto no encontrado' }

      const appointments = await db.all(`
        SELECT id, title, start_time, end_time, appointment_status, status
        FROM appointments
        WHERE contact_id = ? AND deleted_at IS NULL AND start_time >= ?
        ORDER BY start_time ASC LIMIT 5
      `, [ctx.contactId, new Date().toISOString()])

      let customFields = null
      try {
        customFields = contact.custom_fields ? JSON.parse(contact.custom_fields) : null
      } catch { /* texto plano */ customFields = contact.custom_fields }

      return {
        ok: true,
        contact: {
          id: contact.id,
          fullName: contact.full_name || null,
          phone: contact.phone || null,
          email: contact.email || null,
          customFields,
          totalPaid: contact.total_paid || 0,
          purchasesCount: contact.purchases_count || 0
        },
        upcomingAppointments: appointments.map((appt) => ({
          id: appt.id,
          title: appt.title,
          startTime: appt.start_time,
          endTime: appt.end_time,
          status: appt.appointment_status || appt.status
        }))
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
      return toToolResult(result, (data) => ({ id: data?.id, fullName: data?.full_name, email: data?.email }))
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
    description: allowAppointmentOverlaps(config)
      ? 'Obtiene horarios de atención de un calendario para agendar. Este agente SÍ tiene permitido empalmar citas, así que puede devolver horarios aunque ya exista otra cita en ese mismo horario.'
      : 'Obtiene horarios libres de un calendario en un rango de fechas. Este agente NO puede empalmar citas: sólo devuelve horarios sin otra cita activa en ese horario.',
    parameters: z.object({
      calendarId: z.string().nullable().describe('ID del calendario. Déjalo null para usar el calendario configurado del agente; sólo usa list_calendars si no hay calendario configurado.'),
      startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
      endDate: z.string().describe('Fecha final YYYY-MM-DD')
    }),
    execute: async ({ calendarId, startDate, endDate }) => {
      const { calendarId: effectiveCalendarId, overrodeModelCalendar } = resolveEffectiveCalendarId(config, calendarId)
      if (!effectiveCalendarId) {
        return { ok: false, total: 0, slots: [], error: 'No hay calendario configurado ni indicado: usa list_calendars para elegir uno activo.' }
      }
      const overlapsAllowed = allowAppointmentOverlaps(config)
      const slots = await getLocalFreeSlots(effectiveCalendarId, startDate, endDate, null, {
        ignoreAppointmentConflicts: overlapsAllowed,
        appointmentLimit: overlapsAllowed ? undefined : 1
      })

      if (!Array.isArray(slots) || !slots.length) {
        return { ok: true, total: 0, slots: [], calendarId: effectiveCalendarId, note: 'Sin horarios disponibles en ese rango (o el calendario no existe).' }
      }

      return {
        ok: true,
        total: slots.reduce((total, day) => total + (Array.isArray(day.slots) ? day.slots.length : 0), 0),
        calendarId: effectiveCalendarId,
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        note: [
          overlapsAllowed
            ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
            : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
          overrodeModelCalendar ? 'Se usó el calendario configurado del agente (el id indicado se ignoró).' : ''
        ].filter(Boolean).join(' '),
        slots
      }
    }
  })

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: 'Agenda la cita del contacto en un horario REAL obtenido con get_free_slots y confirmado por la persona. Calcula el fin con la duración del calendario automáticamente. Nunca la uses sin que la persona haya confirmado el horario.',
    parameters: z.object({
      calendarId: z.string().nullable().describe('ID del calendario. Déjalo null para usar el calendario configurado del agente.'),
      startTime: z.string().describe('Inicio exacto del slot elegido, ISO 8601 tal como lo devolvió get_free_slots'),
      title: z.string().nullable().describe('Título corto de la cita (ej. "Cita - Juan Pérez")'),
      notes: z.string().nullable().describe('Resumen breve de lo que busca la persona'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ calendarId: requestedCalendarId, startTime, title, notes, comprobanteValidado, anticipoValidado }) => {
      const { calendarId } = resolveEffectiveCalendarId(config, requestedCalendarId)
      if (!calendarId) {
        return { ok: false, actionCompleted: false, error: 'No hay calendario configurado ni indicado: usa list_calendars para obtener el ID real. No se agendó nada.' }
      }
      const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
      if (phaseError) return phaseError
      const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, actionCompleted: false, error: 'startTime inválido: usa exactamente un slot devuelto por get_free_slots. No se agendó nada.' }
      }

      // Idempotencia: si ya existe una cita próxima activa del contacto en ese
      // horario (u otra futura), no crear una doble.
      const existing = await db.get(`
        SELECT id, title, start_time, end_time, appointment_status, status
        FROM appointments
        WHERE contact_id = ? AND deleted_at IS NULL AND start_time >= ?
          AND COALESCE(appointment_status, status, '') NOT IN ('cancelled', 'noshow')
        ORDER BY start_time ASC LIMIT 1
      `, [ctx.contactId, new Date().toISOString()])
      if (existing) {
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

      const calendar = await db.get('SELECT id, name, slot_duration FROM calendars WHERE id = ?', [calendarId])
      if (!calendar) return { ok: false, actionCompleted: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real. No se agendó nada.' }

      // Candado funcional anti-cita-inventada: el horario debe ser un slot REAL del
      // calendario (dentro del horario de atención, en el futuro y no bloqueado).
      // Validamos la FORMA del horario ignorando la ocupación: la política de empalme
      // la aplica el chequeo dedicado de más abajo (que da un mensaje específico).
      // Aquí sólo atajamos horas inventadas, fuera de horario o en el pasado, sin
      // importar en qué turno se ofreció el slot (revalidación al momento de agendar).
      const startMs = start.getTime()
      const businessTimezone = await getAccountTimezone()
      const confirmationEvidence = await verifyAppointmentConfirmationEvidence({
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

      const durationMinutes = Number(calendar.slot_duration) > 0 ? Number(calendar.slot_duration) : 60
      const end = new Date(start.getTime() + durationMinutes * 60000)

      if (!allowAppointmentOverlaps(config)) {
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
              id: conflict.id,
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
          : { simulated: true },
        effect: { liveEffect: 'AGENDARÍA UNA CITA REAL y marcaría el objetivo como CUMPLIDO', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          wouldMarkObjectiveCompleted: true,
          calendarId,
          startTime: start.toISOString()
        })
        return { ok: true, simulated: true, wouldMarkObjectiveCompleted: true, appointment: { calendarId, title: finalTitle, startTime: start.toISOString(), endTime: end.toISOString() } }
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
            notes: notes || 'Agendada por el agente conversacional'
          }
        })
        toolResult = toToolResult(result, (data) => ({
          id: data?.id,
          title: data?.title,
          startTime: data?.startTime || data?.start_time,
          endTime: data?.endTime || data?.end_time,
          status: data?.appointmentStatus || data?.appointment_status || data?.status
        }))
        if (result.statusCode >= 400 || !toolResult.ok || !toolResult.data?.id) {
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
      settleAction(action, 'ok', {
        appointmentId: toolResult.data?.id || null,
        calendarId,
        startTime: start.toISOString(),
        appointmentCreated: true,
        objectiveCompleted: !completionSyncWarning,
        completionSyncWarning
      })
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
    description: 'Marca el objetivo del agente como CUMPLIDO y pasa la conversación a un humano. Es un paso terminal: después el bot deja de responder. Ejecútala SÓLO cuando el objetivo de ESTE agente realmente se cumplió: la persona pidió avanzar/hablar con alguien o aceptó una propuesta concreta que ya le hiciste; o ya recabaste todos los datos que faltaban; o el prospecto ya cumplió tus criterios de calificación; o se cumplió la meta personalizada configurada. Mostrar interés general ("me interesa", "cuánto cuesta") NO es suficiente. Un "quiero cita / quiero agendar / quiero comprar" de entrada y sin contexto TAMPOCO cuenta: eso es momento de CALIFICAR (pregunta para qué lo quiere y qué necesita), no de cerrar. En esos casos sigue conversando. No le digas al cliente que la ejecutaste.',
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué quiere la persona o qué condición del objetivo se cumplió (ej. "pidió que un asesor lo contacte", "ya dio nombre, correo y teléfono", "calificó: tiene presupuesto y decide")'),
      resumen: z.string().describe('Resumen breve de la conversación y su situación'),
      urgencia: z.enum(['baja', 'media', 'alta']).describe('Qué tan pronto quiere avanzar'),
      siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el humano'),
      confirm: z.boolean().describe('true SÓLO cuando el objetivo del agente ya se cumplió de verdad (la persona pidió avanzar/hablar con alguien, aceptó una propuesta concreta, ya recabaste los datos pedidos, el prospecto calificó, o se cumplió la meta personalizada). Interés general ("me interesa", "cuánto cuesta") NO cuenta. Si dudas, es false y sigues conversando.'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso, confirm, comprobanteValidado, anticipoValidado }) => {
      // Candado funcional anti-falso-cierre: no marcar objetivo cumplido por interés
      // blando. Esto NO vive sólo en el prompt; es una barrera de código. Aplica a
      // TODOS los objetivos que cierran por aquí (pasar a humano, juntar datos,
      // filtrar/calificar, o meta personalizada): el disparo exige una condición real,
      // no sólo que el prospecto parezca interesado.
      if (confirm !== true) {
        return {
          ok: false,
          error: 'Aún no. Ejecuta esto SÓLO cuando el objetivo del agente ya se cumplió de verdad: la persona pidió avanzar o aceptó una propuesta concreta, ya recabaste los datos que pedías, o el prospecto ya calificó. Si sólo mostró interés, sigue conversando: resuelve su duda real y ayúdale a definir el siguiente paso.'
        }
      }
      // Candado de FASES de cierre (persuasión media/alta): no deja marcar el objetivo
      // hasta que la conversación demuestre que se recorrió el arco DE VERDAD (problema
      // real, reto, consecuencia, invitación, objeciones, decisión), no palabras vacías.
      const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
      if (phaseError) return phaseError
      const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const signal = resolveAdvanceSignal(config)
      const action = pushAction(ctx, 'mark_ready_to_advance', {
        signal, intencionDetectada, urgencia, extras: config.successExtras || [],
        effect: { liveEffect: 'MARCARÍA el objetivo como CUMPLIDO y pasaría el chat a un humano (el bot deja de responder)', marksObjectiveCompleted: true }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          signal,
          wouldMarkObjectiveCompleted: true,
          wouldNotifyHuman: true
        })
        return { ok: true, simulated: true, signal, wouldMarkObjectiveCompleted: true, wouldNotifyHuman: true }
      }

      try {
        await setConversationSignal(ctx.contactId, signal, {
          reason: `${intencionDetectada} (urgencia ${urgencia})`,
          summary: resumen,
          status: 'completed',
          agentId: config.id || ''
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el objetivo cumplido: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo registrar el objetivo como cumplido. No afirmes que se transfirió ni que terminó; requiere revisión humana.'
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
      await runPostCommitStep('completion_action', () => applyAgentCompletionAction(config, ctx.contactId))
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
      await runPostCommitStep('success_extras', () => applyAgentSuccessExtras(config, ctx.contactId))
      settleAction(action, 'ok', {
        signal,
        objectiveCompleted: true,
        ...(postCommitWarnings.length ? { warnings: postCommitWarnings } : {})
      })
      return {
        ok: true,
        actionCompleted: true,
        signal,
        ...(postCommitWarnings.length ? { postCommitWarning: true } : {}),
        note: 'Objetivo registrado (pasa a humano). Cierra con una frase mínima o no respondas más.'
      }
    }
  })

  const createPaymentLinkTool = tool({
    name: 'create_payment_link',
    description: 'Crea y envía un link de pago real al contacto actual. Úsala sólo después de confirmar concepto, monto, moneda y canal con la persona. Nunca inventes precios: usa list_products o el producto configurado del agente.',
    parameters: z.object({
      amount: z.number().positive().describe('Monto confirmado del cobro'),
      currency: z.string().nullable().describe('Moneda ISO opcional; si falta se usa la moneda de la cuenta'),
      concept: z.string().describe('Concepto breve del cobro'),
      dueDate: z.string().nullable().describe('Fecha límite de pago YYYY-MM-DD opcional'),
      channel: z.enum(['email', 'whatsapp', 'sms', 'all']).describe('Canal confirmado para enviar el link'),
      confirm: z.boolean().describe('true sólo cuando la persona ya aprobó explícitamente el cobro'),
      comprobanteValidado: z.boolean().nullable().optional().describe('Campo legacy ignorado: un booleano de la IA nunca valida un pago'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy ignorado')
    }),
    execute: async ({ amount, currency, concept, dueDate, channel, confirm }) => {
      if (!confirm) {
        return { ok: false, actionCompleted: false, error: 'Falta confirmación explícita. Resume monto, concepto y canal, y pide aprobación antes de crear el link. No se creó ni envió nada.' }
      }
      const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
      if (phaseError) return phaseError

      // El link es el mecanismo para cobrar el pago completo o el anticipo. No exigimos
      // un comprobante previo para crearlo; sí amarramos el cobro al workflow/catálogo.
      const accountCurrency = String(
        ctx.accountLocale?.currency || await getAccountCurrency().catch(() => '')
      ).trim().toUpperCase()
      const paymentValidation = await validatePaymentRequestAgainstCatalog({
        database: db,
        config,
        accountCurrency,
        amount,
        currency,
        concept
      })
      if (!paymentValidation.ok) return paymentValidation
      const trustedPayment = paymentValidation.trusted

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
        channel,
        effect: { liveEffect: 'ENVIARÍA un link de pago real (la venta sigue PENDIENTE hasta que se pague)', marksObjectiveCompleted: false }
      })
      if (ctx.dryRun) {
        settleAction(action, 'simulated', {
          actionCompleted: false,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          channel,
          wouldCreateAndSendLink: true
        })
        return {
          ok: true,
          simulated: true,
          amount: trustedPayment.amount,
          currency: trustedPayment.currency,
          concept: trustedPayment.concept,
          channel,
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
          channels: buildPaymentChannels(channel),
          source: 'conversational_agent'
        })

        const resultCurrency = String(result?.currency || '').trim().toUpperCase()
        const resultAmount = Number(result?.amount)
        const sent = Boolean(result?.invoiceId && result?.paymentLink && result?.sendMethod !== 'none' && result?.status !== 'draft')
        const canonicalMatch = Math.abs(resultAmount - trustedPayment.amount) < 0.005 && resultCurrency === trustedPayment.currency
        if (!sent || !canonicalMatch) {
          await recordConversationalAgentEvent({
            contactId: ctx.contactId,
            eventType: 'payment_link_failed',
            detail: {
              reason: !sent ? 'link_not_sent' : 'canonical_payment_mismatch',
              invoiceId: result?.invoiceId || null,
              expectedAmount: trustedPayment.amount,
              expectedCurrency: trustedPayment.currency,
              actualAmount: result?.amount || null,
              actualCurrency: result?.currency || null
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
            transferRequired: true
          })
          return errorResult
        }

        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          // (AI-004) Distingue link reutilizado (idempotencia) de uno nuevo.
          eventType: result.reused ? 'payment_link_reused' : 'payment_link_created',
          detail: {
            agentId: config.id || ctx.agentId || null,
            invoiceId: result.invoiceId,
            amount: result.amount,
            currency: result.currency,
            channel,
            paymentMode: getSalesPaymentMode(config),
            status: result.status,
            ...(result.reused ? { reused: true } : {})
          }
        }).catch((error) => {
          logger.warn(`[Agente conversacional] El link ${result.invoiceId} sí se envió, pero falló su telemetría: ${error.message}`)
        })
        settleAction(action, 'ok', {
          invoiceId: result.invoiceId,
          amount: result.amount,
          currency: result.currency,
          sendMethod: result.sendMethod,
          linkAvailable: true,
          deliveryConfirmed: !result.reused,
          priorEquivalentLinkFound: Boolean(result.reused),
          reused: Boolean(result.reused),
          objectiveCompleted: false
        })
        return {
          ok: true,
          actionCompleted: true,
          invoiceId: result.invoiceId,
          paymentLink: result.paymentLink,
          sendMethod: result.sendMethod,
          amount: result.amount,
          currency: result.currency,
          status: result.status,
          // (AI-004) Evita que el modelo reenvíe/duplique: avísale que ya había un link equivalente.
          note: result.reused
            ? 'Ya existía un link de pago equivalente reciente para este contacto; se reutilizó en lugar de crear otro. Confirma a la persona con ese mismo link; no generes uno nuevo.'
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
    description: 'Genera el enlace configurado para que la persona agende o compre fuera de Ristak. Úsala sólo cuando la persona ya esté lista para avanzar. El objetivo queda pendiente hasta que una integración autenticada confirme el ID real de cita, compra, orden o pago.',
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué quiere lograr la persona, por ejemplo agendar valoración o completar compra'),
      resumen: z.string().describe('Resumen breve del contexto útil para auditoría interna'),
      confirm: z.boolean().describe('true sólo cuando la persona ya aceptó avanzar por enlace'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ intencionDetectada, resumen, confirm, comprobanteValidado, anticipoValidado }) => {
      if (!confirm) {
        return { ok: false, error: 'Falta confirmación explícita. Primero confirma que la persona quiere avanzar por enlace.' }
      }
      const phaseError = await requireClosingPhasesIfNeeded(config, ctx)
      if (phaseError) return phaseError
      const depositError = await rejectMissingDepositIfNeeded(ctx, config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const goalConfig = getConfiguredGoalUrl(config)
      const targetUrl = goalConfig.url || ''
      const trackingParam = goalConfig.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      if (!targetUrl) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = getGoalLinkContext(config, goalConfig)

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
          idempotencyKey: ctx.executionId
            ? `send_goal_url:${ctx.contactId}:${config.id || ctx.agentId || ''}:${ctx.channel || ''}:${ctx.executionId}`
            : '',
          metadata: {
            expected: linkContext.expected,
            intencionDetectada,
            resumen
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
          goalId: link.id,
          confirmationMode: 'trusted_integration',
          note: 'Esta misma meta ya fue confirmada. No vuelvas a mandar el enlace.'
        }
      }

      settleAction(action, 'ok', {
        goalId: link.id,
        linkPrepared: true,
        confirmationMode: 'trusted_integration',
        deliveryConfirmed: false,
        objectiveCompleted: false
      })

      return {
        ok: true,
        actionCompleted: true,
        goalId: link.id,
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
    description: 'Manda la conversación a un humano: preguntas delicadas, quejas serias, confusión fuerte, información que no tienes, o casos definidos por el negocio. Crea la señal interna y el agente deja de responder. No le digas al cliente que lo estás transfiriendo.',
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
          objectiveCompleted: false
        })
        return { ok: true, simulated: true, signal: 'ready_for_human', wouldNotifyHuman: true, wouldMarkObjectiveCompleted: false }
      }

      try {
        await setConversationSignal(ctx.contactId, 'ready_for_human', {
          reason: motivo,
          summary: resumen,
          status: 'human',
          agentId: config.id || ''
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo transferir la conversación: ${error.message}`)
        const errorResult = {
          ok: false,
          actionCompleted: false,
          transferRequired: true,
          error: 'No se pudo registrar la transferencia. No afirmes que un humano ya tomó el chat; requiere revisión manual.'
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
        objectiveCompleted: false,
        ...(notificationWarning ? { warnings: ['priority_notification'] } : {})
      })
      return { ok: true, actionCompleted: true, signal: 'ready_for_human', note: 'Un humano seguirá la conversación. Si hace falta, cierra con una frase breve y natural (ej. que en un momento le confirmas).' }
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
    description: 'Valida el comprobante de transferencia que el contacto mandó en FOTO o PDF y, si el monto coincide con el anticipo configurado, registra el pago real. Ejecútala EN SILENCIO en cuanto llegue el comprobante. SOLO su resultado ok cuenta como anticipo pagado; nunca lo des por validado tú.',
    parameters: z.object({
      montoIndicado: z.number().nullable().describe('Monto que la persona dijo haber transferido, si lo mencionó (solo referencia; la validación usa el comprobante)'),
      referencia: z.string().nullable().describe('Referencia o folio si la persona lo compartió en texto')
    }),
    execute: async ({ montoIndicado, referencia }) => {
      const deposit = getDepositRequirement(config)
      if (!deposit) {
        return { ok: false, actionCompleted: false, error: 'Este agente no tiene anticipo configurado; no hay nada que validar.' }
      }
      const methods = getDepositPaymentMethods(config)
      if (!methods.bankTransfer) {
        return { ok: false, actionCompleted: false, error: 'La transferencia bancaria no está habilitada para este anticipo. Usa el método configurado o manda a humano.' }
      }
      const paymentLabel = getDepositRequirementLabel(config)
      const expectedLabel = formatDepositRequirement(deposit, ctx.accountLocale)

      const action = pushAction(ctx, 'register_deposit_payment_proof', {
        montoIndicado: Number(montoIndicado) || null,
        referencia: referencia || null,
        effect: { liveEffect: `VALIDARÍA el comprobante con visión y registraría el ${paymentLabel} como pago real`, marksObjectiveCompleted: false }
      })

      if (ctx.dryRun) {
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
        requirement: { ...deposit, currency: deposit.currency || accountCurrency }
      })
      if (existingEvidence.ok) {
        settleAction(action, 'ok', { actionCompleted: true, alreadyRegistered: true, paymentId: existingEvidence.evidence.paymentId })
        return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: existingEvidence.evidence, note: `El ${paymentLabel} ya estaba registrado; continúa con la acción de avance.` }
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

      // Doble idempotencia por monto/ventana: evita registrar el mismo comprobante dos veces.
      const duplicate = await findRecentAgentTransferDepositPayment({ contactId: ctx.contactId, amount: analysis.amount })
      if (duplicate) {
        settleAction(action, 'ok', { actionCompleted: true, alreadyRegistered: true, paymentId: duplicate.id })
        return { ok: true, actionCompleted: true, alreadyRegistered: true, payment: { paymentId: duplicate.id, amount: duplicate.amount, currency: duplicate.currency }, note: `Ese comprobante ya estaba registrado; continúa con la acción de avance.` }
      }

      let payment
      try {
        payment = await registerAgentTransferDepositPayment({
          contactId: ctx.contactId,
          amount: analysis.amount,
          currency: accountCurrency,
          concept: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia`,
          reference: analysis.reference || (referencia || null),
          agentId: config.id || ctx.agentId || null,
          mediaUrl: receiptMedia.mediaUrl,
          extracted: {
            amount: analysis.amount,
            currency: analysis.currency,
            date: analysis.date,
            bank: analysis.bank,
            reference: analysis.reference,
            recipientHint: analysis.recipientHint,
            confidence: analysis.confidence
          }
        })
      } catch (error) {
        logger.error(`[Agente conversacional] No se pudo registrar el anticipo por transferencia: ${error.message}`)
        settleAction(action, 'error', { error: error.message })
        return { ok: false, actionCompleted: false, transferRequired: true, error: 'El comprobante se leyó bien pero no se pudo registrar el pago. Pasa la conversación a una persona con send_to_human.' }
      }

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
      // El equipo recibe aviso para auditar el comprobante aunque el agente continúe.
      await notifyHumanPriority(ctx, {
        reason: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} por transferencia validado por IA`,
        summary: `${payment.amount} ${payment.currency} · revisar comprobante`,
        signal: 'deposit_transfer_registered'
      })

      settleAction(action, 'ok', { actionCompleted: true, paymentId: payment.paymentId, amount: payment.amount, currency: payment.currency })
      return {
        ok: true,
        actionCompleted: true,
        payment: { paymentId: payment.paymentId, amount: payment.amount, currency: payment.currency },
        note: `${paymentLabel === 'anticipo' ? 'Anticipo' : 'Pago'} registrado y validado. Confirma a la persona con naturalidad y continúa con la acción de avance.`
      }
    }
  })

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
