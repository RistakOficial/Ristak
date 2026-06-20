import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { PUBLIC_URL } from '../../config/constants.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { updateContact } from '../../controllers/contactsController.js'
import { listCalendarsTool } from '../tools/appointmentTools.js'
import { getLocalFreeSlots } from '../../services/localCalendarService.js'
import { createSinglePaymentLink } from '../../services/paymentFlowService.js'
import { getBusinessProfileSnapshot } from '../../services/aiAgentService.js'
import { buildTriggerLinkPublicUrl, getTriggerLink } from '../../services/triggerLinksService.js'
import {
  setConversationSignal,
  setConversationStatus,
  recordConversationalAgentEvent,
  applyAgentSuccessExtras,
  applyAgentCompletionAction,
  updateConversationClosingContext,
  createConversationGoalLink,
  DEFAULT_GOAL_TRACKING_PARAM
} from '../../services/conversationalAgentService.js'
import { sendConversationalAgentPriorityNotification } from '../../services/pushNotificationsService.js'

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
  ctx.actions.push({ type, ...detail })
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

function rejectMissingDepositIfNeeded(config = {}, comprobanteValidado, accountLocale = {}) {
  const deposit = getDepositRequirement(config)
  if (!deposit || comprobanteValidado === true) return null
  const paymentLabel = getDepositRequirementLabel(config)
  return {
    ok: false,
    error: `Falta validar el ${paymentLabel} (${formatDepositRequirement(deposit, accountLocale)}). Pide foto o archivo del comprobante y sólo avanza cuando el comprobante coincida con el monto configurado.`
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
    description: 'Memoria interna de la estrategia de cierre avanzada de fabrica. Usala en silencio cuando el contacto revele origen, motivo, por que ahora, problema real, impacto, consecuencia logica, resultado deseado, urgencia, objecion o senal de decision. No guarda campos personalizados del contacto.',
    parameters: z.object({
      arrivalSource: z.string().nullable().optional().describe('De donde llego si lo dijo o si el sistema lo detecto'),
      contactReason: z.string().nullable().optional().describe('Que lo hizo escribir o pedir información'),
      whyNow: z.string().nullable().optional().describe('Que cambio ahora o cual fue el detonante'),
      surfaceProblem: z.string().nullable().optional().describe('Problema inicial expresado de forma simple'),
      realProblem: z.string().nullable().optional().describe('Problema de fondo, solo si esta sustentado por la conversación'),
      attemptedBefore: z.string().nullable().optional().describe('Que intento antes o que no le funciono'),
      impact: z.string().nullable().optional().describe('Como le afecta en su dia, negocio, dinero, tiempo o proceso'),
      consequenceIfNoAction: z.string().nullable().optional().describe('Consecuencia logica de quedarse igual, sin inventar miedo'),
      desiredOutcome: z.string().nullable().optional().describe('Resultado que quiere construir'),
      scenarioToAvoid: z.string().nullable().optional().describe('Escenario que quiere evitar'),
      urgencyLevel: z.enum(['baja', 'media', 'alta', 'desconocida']).nullable().optional().describe('Urgencia detectada'),
      objection: z.string().nullable().optional().describe('Freno u objecion principal'),
      decisionSignal: z.string().nullable().optional().describe('Senal de que quiere avanzar, comparar, esperar o hablar con alguien'),
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

      const result = await updateConversationClosingContext(ctx.contactId, cleanPatch, { updatedBy: 'agent' })
      return { ok: true, changedKeys: result.changedKeys, context: result.context }
    }
  })

  const getFreeSlotsForAgentTool = tool({
    name: 'get_free_slots',
    description: allowAppointmentOverlaps(config)
      ? 'Obtiene horarios de atención de un calendario para agendar. Este agente SÍ tiene permitido empalmar citas, así que puede devolver horarios aunque ya exista otra cita en ese mismo horario.'
      : 'Obtiene horarios libres de un calendario en un rango de fechas. Este agente NO puede empalmar citas: sólo devuelve horarios sin otra cita activa en ese horario.',
    parameters: z.object({
      calendarId: z.string().describe('ID del calendario (usa list_calendars)'),
      startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
      endDate: z.string().describe('Fecha final YYYY-MM-DD')
    }),
    execute: async ({ calendarId, startDate, endDate }) => {
      const overlapsAllowed = allowAppointmentOverlaps(config)
      const slots = await getLocalFreeSlots(calendarId, startDate, endDate, null, {
        ignoreAppointmentConflicts: overlapsAllowed,
        appointmentLimit: overlapsAllowed ? undefined : 1
      })

      if (!Array.isArray(slots) || !slots.length) {
        return { ok: true, total: 0, slots: [], note: 'Sin horarios disponibles en ese rango (o el calendario no existe).' }
      }

      return {
        ok: true,
        total: slots.reduce((total, day) => total + (Array.isArray(day.slots) ? day.slots.length : 0), 0),
        overlapPolicy: overlapsAllowed ? 'allowed' : 'blocked',
        note: overlapsAllowed
          ? 'Empalme permitido: estos horarios respetan horas de atención, pero pueden coincidir con citas existentes.'
          : 'Empalme bloqueado: estos horarios no tienen otra cita activa encima.',
        slots
      }
    }
  })

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: 'Agenda la cita del contacto en un horario REAL obtenido con get_free_slots y confirmado por la persona. Calcula el fin con la duración del calendario automáticamente. Nunca la uses sin que la persona haya confirmado el horario.',
    parameters: z.object({
      calendarId: z.string().describe('ID del calendario (usa list_calendars o get_business_profile)'),
      startTime: z.string().describe('Inicio exacto del slot elegido, ISO 8601 tal como lo devolvió get_free_slots'),
      title: z.string().nullable().describe('Título corto de la cita (ej. "Cita - Juan Pérez")'),
      notes: z.string().nullable().describe('Resumen breve de lo que busca la persona'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ calendarId, startTime, title, notes, comprobanteValidado, anticipoValidado }) => {
      const depositError = rejectMissingDepositIfNeeded(config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const start = new Date(startTime)
      if (Number.isNaN(start.getTime())) {
        return { ok: false, error: 'startTime inválido: usa exactamente un slot devuelto por get_free_slots' }
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
          alreadyBooked: true,
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
      if (!calendar) return { ok: false, error: 'Calendario no encontrado: usa list_calendars para obtener el ID real' }

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
      const finalTitle = title || `Cita - ${contact?.full_name || contact?.phone || 'WhatsApp'}`

      pushAction(ctx, 'book_appointment', { calendarId, startTime: start.toISOString(), endTime: end.toISOString(), title: finalTitle })
      if (ctx.dryRun) {
        return { ok: true, simulated: true, appointment: { calendarId, title: finalTitle, startTime: start.toISOString(), endTime: end.toISOString() } }
      }

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
      const toolResult = toToolResult(result, (data) => ({
        id: data?.id,
        title: data?.title,
        startTime: data?.startTime || data?.start_time,
        endTime: data?.endTime || data?.end_time,
        status: data?.appointmentStatus || data?.appointment_status || data?.status
      }))

      if (toolResult.ok) {
        await setConversationSignal(ctx.contactId, 'appointment_booked', {
          reason: 'Cita agendada por el agente',
          summary: `${finalTitle} · ${start.toISOString()}`,
          status: 'completed'
        })
        await applyAgentCompletionAction(config, ctx.contactId)
        await notifyHumanPriority(ctx, {
          reason: 'Cita agendada por el agente',
          summary: `${finalTitle} · ${start.toISOString()}`,
          signal: 'appointment_booked'
        })
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'appointment_booked',
          detail: { appointmentId: toolResult.data?.id, startTime: start.toISOString(), calendarId }
        })
        await applyAgentSuccessExtras(config, ctx.contactId)
      }
      return toolResult
    }
  })

  const markReadyTool = tool({
    name: 'mark_ready_to_advance',
    description: 'Herramienta interna de avance. Ejecútala cuando la persona ya está lista para el siguiente paso (intención real, dudas resueltas, pidió avanzar). Crea la señal interna y mueve la conversación a prioridad. No le digas al cliente que la ejecutaste.',
    parameters: z.object({
      intencionDetectada: z.string().describe('Qué quiere la persona (ej. "agendar valoración esta semana")'),
      resumen: z.string().describe('Resumen breve de la conversación y su situación'),
      urgencia: z.enum(['baja', 'media', 'alta']).describe('Qué tan pronto quiere avanzar'),
      siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el humano'),
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso, comprobanteValidado, anticipoValidado }) => {
      const depositError = rejectMissingDepositIfNeeded(config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const signal = resolveAdvanceSignal(config)
      pushAction(ctx, 'mark_ready_to_advance', { signal, intencionDetectada, urgencia, extras: config.successExtras || [] })
      if (ctx.dryRun) return { ok: true, simulated: true, signal }

      if (signal) {
        await setConversationSignal(ctx.contactId, signal, {
          reason: `${intencionDetectada} (urgencia ${urgencia})`,
          summary: [resumen, siguientePaso ? `Siguiente paso: ${siguientePaso}` : ''].filter(Boolean).join(' · '),
          status: 'completed'
        })
        await applyAgentCompletionAction(config, ctx.contactId)
        await notifyHumanPriority(ctx, {
          reason: intencionDetectada,
          summary: [resumen, siguientePaso ? `Siguiente paso: ${siguientePaso}` : ''].filter(Boolean).join(' · '),
          signal
        })
      } else {
        // Acción "no hacer nada": el agente cumplió y solo deja registro
        await setConversationStatus(ctx.contactId, 'completed', { updatedBy: 'agent' })
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'objective_completed',
          detail: { intencionDetectada, urgencia, resumen }
        })
      }
      await applyAgentSuccessExtras(config, ctx.contactId)
      return { ok: true, signal, note: 'Objetivo registrado. Cierra con una frase mínima o no respondas más.' }
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
      comprobanteValidado: z.boolean().nullable().optional().describe('true sólo si el negocio pidió pago previo y el contacto ya mandó comprobante válido'),
      anticipoValidado: z.boolean().nullable().optional().describe('Alias legacy de comprobanteValidado')
    }),
    execute: async ({ amount, currency, concept, dueDate, channel, confirm, comprobanteValidado, anticipoValidado }) => {
      if (!confirm) {
        return { ok: false, error: 'Falta confirmación explícita. Resume monto, concepto y canal, y pide aprobación antes de crear el link.' }
      }
      const depositError = rejectMissingDepositIfNeeded(config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const contact = await getPaymentContact(ctx.contactId)
      if (!contact) return { ok: false, error: 'Contacto no encontrado' }

      pushAction(ctx, 'create_payment_link', { amount, currency: currency || null, concept, channel })
      if (ctx.dryRun) {
        return { ok: true, simulated: true, amount, currency: currency || null, concept, channel }
      }

      try {
        const result = await createSinglePaymentLink({
          contact,
          amount,
          currency: currency || undefined,
          description: concept,
          concept,
          title: concept,
          dueDate: dueDate || undefined,
          channels: buildPaymentChannels(channel),
          source: 'conversational_agent'
        })
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'payment_link_created',
          detail: {
            agentId: config.id || ctx.agentId || null,
            invoiceId: result.invoiceId,
            amount: result.amount,
            currency: result.currency,
            channel,
            paymentMode: getSalesPaymentMode(config),
            status: result.status
          }
        })
        return {
          ok: true,
          invoiceId: result.invoiceId,
          paymentLink: result.paymentLink,
          sendMethod: result.sendMethod,
          amount: result.amount,
          currency: result.currency,
          status: result.status,
          note: 'Link enviado. La venta sigue pendiente hasta que Ristak confirme el pago real del invoice.'
        }
      } catch (error) {
        await recordConversationalAgentEvent({
          contactId: ctx.contactId,
          eventType: 'payment_link_failed',
          detail: { error: error.message, amount, currency: currency || null, concept }
        })
        return { ok: false, error: error.message }
      }
    }
  })

  const sendGoalUrlTool = tool({
    name: 'send_goal_url',
    description: 'Genera el enlace configurado para que la persona agende o compre fuera de Ristak. Úsala sólo cuando la persona ya esté lista para avanzar. El objetivo NO queda cumplido hasta que llegue la confirmación automática con el ID real de cita, compra, orden o pago.',
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
      const depositError = rejectMissingDepositIfNeeded(config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
      if (depositError) return depositError

      const goalConfig = getConfiguredGoalUrl(config)
      const targetUrl = goalConfig.url || ''
      const trackingParam = goalConfig.trackingParam || DEFAULT_GOAL_TRACKING_PARAM
      if (!targetUrl) {
        return { ok: false, error: 'No hay enlace configurado para este objetivo. Manda a humano con send_to_human y avisa que falta configurar el enlace.' }
      }
      const linkContext = getGoalLinkContext(config, goalConfig)

      pushAction(ctx, 'send_goal_url', { objective: config.objective, intencionDetectada, targetUrl })
      if (ctx.dryRun) {
        return {
          ok: true,
          simulated: true,
          sentUrl: buildGoalLinkPreview(targetUrl, trackingParam, 'goal_simulado', linkContext.linkParams),
          trackingParam,
          linkParams: linkContext.linkParams,
          note: 'Manda este enlace visible en el chat. El objetivo se confirma hasta que llegue el ID real.'
        }
      }

      const link = await createConversationGoalLink({
        contactId: ctx.contactId,
        agentId: config.id || ctx.agentId || null,
        objective: config.objective,
        targetUrl,
        trackingParam,
        linkParams: linkContext.linkParams,
        metadata: {
          expected: linkContext.expected,
          intencionDetectada,
          resumen
        }
      })

      return {
        ok: true,
        goalId: link.id,
        sentUrl: link.sentUrl,
        trackingParam: link.trackingParam,
        linkParams: link.linkParams,
        note: 'Manda sentUrl visible en el chat. No digas que el objetivo ya quedó cumplido; se confirma cuando llegue el ID real.'
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
      const depositError = rejectMissingDepositIfNeeded(config, comprobanteValidado === true || anticipoValidado === true, ctx.accountLocale)
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
      pushAction(ctx, 'send_trigger_link', {
        objective: config.objective,
        intencionDetectada,
        triggerLinkId: link.id,
        triggerLinkPublicId: link.publicId || null
      })

      return {
        ok: true,
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
      pushAction(ctx, 'send_to_human', { motivo })
      if (ctx.dryRun) return { ok: true, simulated: true, signal: 'ready_for_human' }

      await setConversationSignal(ctx.contactId, 'ready_for_human', {
        reason: motivo,
        summary: resumen,
        status: 'human'
      })
      await notifyHumanPriority(ctx, { reason: motivo, summary: resumen, signal: 'ready_for_human' })
      return { ok: true, signal: 'ready_for_human', note: 'Un humano seguirá la conversación. Si hace falta, cierra con una frase breve y natural (ej. que en un momento le confirmas).' }
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
      ctx.suppressReply = true
      pushAction(ctx, 'discard_conversation', { motivo, nivelDeRiesgo })
      if (ctx.dryRun) return { ok: true, simulated: true, signal: 'discarded' }

      await setConversationSignal(ctx.contactId, 'discarded', {
        reason: `${motivo} (riesgo ${nivelDeRiesgo})`,
        summary: resumen,
        status: 'discarded'
      })
      return { ok: true, signal: 'discarded', note: 'Conversación descartada. No respondas nada más.' }
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

  const tools = [
    getBusinessProfileTool,
    listProductsTool,
    getContactProfileTool,
    ...(ctx.followUpMode ? [] : [saveContactDataTool]),
    ...(ctx.followUpMode || config.closingStrategyMode === 'custom' ? [] : [updateClosingContextTool]),
    ...(ctx.followUpMode ? [] : [
    markReadyTool,
    sendToHumanTool,
    discardConversationTool,
    staySilentTool
    ])
  ]

  // Disponibilidad y agenda: lectura siempre (para responder horarios reales);
  // escritura solo si el negocio configuró agenda directa.
  tools.push(listCalendarsTool, getFreeSlotsForAgentTool)
  if (!ctx.followUpMode) {
    if (config?.successAction === 'book_appointment') tools.push(bookAppointmentTool)
    if (config?.successAction === 'ready_to_buy') tools.push(createPaymentLinkTool)
    if (config?.successAction === 'send_goal_url') tools.push(sendGoalUrlTool)
    if (config?.successAction === 'send_trigger_link') tools.push(sendTriggerLinkTool)
  }
  return tools
}
