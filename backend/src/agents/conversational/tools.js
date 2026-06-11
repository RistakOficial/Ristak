import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { invokeController, toToolResult } from '../invokeController.js'
import { createAppointment } from '../../controllers/calendarsController.js'
import { updateContact } from '../../controllers/contactsController.js'
import { listCalendarsTool, getFreeSlotsTool } from '../tools/appointmentTools.js'
import {
  setConversationSignal,
  setConversationStatus,
  recordConversationalAgentEvent,
  applyAgentSuccessExtras
} from '../../services/conversationalAgentService.js'

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
  if (config.successAction === 'none') return null
  if (config.successAction === 'ready_for_human') return 'ready_for_human'
  if (config.successAction === 'ready_to_buy') return 'ready_to_buy'
  if (config.successAction === 'book_appointment') return 'ready_to_schedule'
  // internal_signal: depende del objetivo configurado
  if (config.objective === 'citas') return 'ready_to_schedule'
  if (config.objective === 'ventas' || config.objective === 'detectar') return 'ready_to_buy'
  return 'ready_for_human'
}

export function createConversationalTools(ctx) {
  const { config } = ctx

  const getBusinessProfileTool = tool({
    name: 'get_business_profile',
    description: 'Devuelve los datos generales reales del negocio: nombre, dirección/ubicación, teléfono, email y zona horaria. Úsala antes de responder preguntas de ubicación o datos de contacto del negocio.',
    parameters: z.object({}),
    execute: async () => {
      const [hlRow, userRow, calendars] = await Promise.all([
        db.get('SELECT location_data FROM highlevel_config LIMIT 1').catch(() => null),
        db.get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1').catch(() => null),
        db.all("SELECT id, name, is_active FROM calendars WHERE is_active = 1 ORDER BY name ASC LIMIT 20").catch(() => [])
      ])

      let location = null
      try {
        location = hlRow?.location_data ? JSON.parse(hlRow.location_data) : null
      } catch { /* JSON inválido */ }

      return {
        ok: true,
        business: {
          name: location?.name || userRow?.business_name || null,
          address: location?.address || null,
          city: location?.city || null,
          phone: location?.phone || null,
          email: location?.email || null,
          timezone: location?.timezone || null
        },
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
            currency: row.currency || 'MXN',
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

  const bookAppointmentTool = tool({
    name: 'book_appointment',
    description: 'Agenda la cita del contacto en un horario REAL obtenido con get_free_slots y confirmado por la persona. Calcula el fin con la duración del calendario automáticamente. Nunca la uses sin que la persona haya confirmado el horario.',
    parameters: z.object({
      calendarId: z.string().describe('ID del calendario (usa list_calendars o get_business_profile)'),
      startTime: z.string().describe('Inicio exacto del slot elegido, ISO 8601 tal como lo devolvió get_free_slots'),
      title: z.string().nullable().describe('Título corto de la cita (ej. "Cita - Juan Pérez")'),
      notes: z.string().nullable().describe('Resumen breve de lo que busca la persona')
    }),
    execute: async ({ calendarId, startTime, title, notes }) => {
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
      siguientePaso: z.string().nullable().describe('Siguiente paso recomendado para el humano')
    }),
    execute: async ({ intencionDetectada, resumen, urgencia, siguientePaso }) => {
      const signal = resolveAdvanceSignal(config)
      pushAction(ctx, 'mark_ready_to_advance', { signal, intencionDetectada, urgencia, extras: config.successExtras || [] })
      if (ctx.dryRun) return { ok: true, simulated: true, signal }

      if (signal) {
        await setConversationSignal(ctx.contactId, signal, {
          reason: `${intencionDetectada} (urgencia ${urgencia})`,
          summary: [resumen, siguientePaso ? `Siguiente paso: ${siguientePaso}` : ''].filter(Boolean).join(' · '),
          status: 'completed'
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
    saveContactDataTool,
    markReadyTool,
    sendToHumanTool,
    discardConversationTool,
    staySilentTool
  ]

  // Disponibilidad y agenda: lectura siempre (para responder horarios reales);
  // escritura solo si el negocio configuró agenda directa.
  tools.push(listCalendarsTool, getFreeSlotsTool)
  if (config.successAction === 'book_appointment') {
    tools.push(bookAppointmentTool)
  }

  return tools
}
