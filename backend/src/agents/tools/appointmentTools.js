import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { listLocalCalendars, getLocalFreeSlots } from '../../services/localCalendarService.js'
import { createAppointment, updateAppointment, deleteEvent } from '../../controllers/calendarsController.js'
import { invokeController, toToolResult } from '../invokeController.js'

const APPOINTMENT_FIELDS = (row) => ({
  id: row.id,
  title: row.title,
  contactId: row.contact_id,
  contactName: row.contact_name || null,
  calendarId: row.calendar_id,
  startTime: row.start_time,
  endTime: row.end_time,
  status: row.appointment_status || row.status,
  notes: row.notes
})

export const listCalendarsTool = tool({
  name: 'list_calendars',
  description: 'Lista los calendarios disponibles con su ID. Úsala para saber en qué calendario agendar una cita.',
  parameters: z.object({}),
  execute: async () => {
    const calendars = await listLocalCalendars()
    return {
      ok: true,
      calendars: (calendars || []).map((cal) => ({
        id: cal.id,
        name: cal.name,
        source: cal.source || (cal.ghlCalendarId ? 'ghl' : 'ristak'),
        isActive: cal.isActive !== false
      }))
    }
  }
})

export const listAppointmentsTool = tool({
  name: 'list_appointments',
  description: 'Lista citas en un rango de fechas, opcionalmente filtradas por calendario o contacto. Las fechas se guardan en UTC (ISO 8601).',
  parameters: z.object({
    startDate: z.string().describe('Inicio del rango, ISO 8601 (ej. 2026-06-01T00:00:00Z)'),
    endDate: z.string().describe('Fin del rango, ISO 8601'),
    calendarId: z.string().nullable().describe('Filtrar por calendario'),
    contactId: z.string().nullable().describe('Filtrar por contacto'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de citas (default 50)')
  }),
  execute: async ({ startDate, endDate, calendarId, contactId, limit }) => {
    const params = [startDate, endDate]
    let sql = `
      SELECT a.id, a.title, a.contact_id, a.calendar_id, a.start_time, a.end_time,
             a.status, a.appointment_status, a.notes, c.full_name AS contact_name
      FROM appointments a
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.deleted_at IS NULL AND a.start_time >= ? AND a.start_time <= ?`
    if (calendarId) {
      sql += ' AND a.calendar_id = ?'
      params.push(calendarId)
    }
    if (contactId) {
      sql += ' AND a.contact_id = ?'
      params.push(contactId)
    }
    sql += ' ORDER BY a.start_time ASC LIMIT ?'
    params.push(limit || 50)

    const rows = await db.all(sql, params)
    return { ok: true, total: rows.length, appointments: rows.map(APPOINTMENT_FIELDS) }
  }
})

export const getFreeSlotsTool = tool({
  name: 'get_free_slots',
  description: 'Obtiene los horarios disponibles de un calendario en un rango de fechas, según su configuración de horarios y las citas ya agendadas. Úsala antes de proponer horarios al usuario.',
  parameters: z.object({
    calendarId: z.string().describe('ID del calendario (usa list_calendars)'),
    startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
    endDate: z.string().describe('Fecha final YYYY-MM-DD')
  }),
  execute: async ({ calendarId, startDate, endDate }) => {
    const slots = await getLocalFreeSlots(calendarId, startDate, endDate, null)
    if (!Array.isArray(slots) || !slots.length) {
      return { ok: true, total: 0, slots: [], note: 'Sin horarios disponibles en ese rango (o el calendario no existe).' }
    }
    return { ok: true, total: slots.length, slots }
  }
})

export const createAppointmentTool = tool({
  name: 'create_appointment',
  description: 'Agenda una cita nueva. Necesita contactId real (usa search_contacts) y calendarId (usa list_calendars). La cita se guarda localmente y se sincroniza con HighLevel/Google si están conectados.',
  parameters: z.object({
    calendarId: z.string().describe('ID del calendario donde agendar'),
    contactId: z.string().describe('ID del contacto'),
    title: z.string().describe('Título de la cita'),
    startTime: z.string().describe('Inicio en ISO 8601 con zona horaria (ej. 2026-06-15T10:00:00-06:00)'),
    endTime: z.string().describe('Fin en ISO 8601 con zona horaria'),
    notes: z.string().nullable().describe('Notas opcionales de la cita')
  }),
  execute: async ({ calendarId, contactId, title, startTime, endTime, notes }) => {
    const result = await invokeController(createAppointment, {
      body: {
        calendarId,
        contactId,
        title,
        startTime,
        endTime,
        notes: notes || undefined
      }
    })
    return toToolResult(result, (data) => ({
      id: data?.id,
      title: data?.title,
      startTime: data?.startTime || data?.start_time,
      endTime: data?.endTime || data?.end_time,
      status: data?.appointmentStatus || data?.appointment_status || data?.status
    }))
  }
})

export const updateAppointmentTool = tool({
  name: 'update_appointment',
  description: 'Reprograma o modifica una cita existente (horario, título, notas o estatus). Solo envía los campos que cambian. Estatus válidos: confirmed, pending, cancelled, showed, noshow.',
  parameters: z.object({
    appointmentId: z.string().describe('ID de la cita (usa list_appointments para obtenerlo)'),
    title: z.string().nullable().describe('Nuevo título'),
    startTime: z.string().nullable().describe('Nuevo inicio ISO 8601 con zona horaria'),
    endTime: z.string().nullable().describe('Nuevo fin ISO 8601 con zona horaria'),
    notes: z.string().nullable().describe('Nuevas notas'),
    appointmentStatus: z.string().nullable().describe('Nuevo estatus: confirmed | pending | cancelled | showed | noshow')
  }),
  execute: async ({ appointmentId, title, startTime, endTime, notes, appointmentStatus }) => {
    const body = {}
    if (title !== null && title !== undefined) body.title = title
    if (startTime !== null && startTime !== undefined) body.startTime = startTime
    if (endTime !== null && endTime !== undefined) body.endTime = endTime
    if (notes !== null && notes !== undefined) body.notes = notes
    if (appointmentStatus !== null && appointmentStatus !== undefined) body.appointmentStatus = appointmentStatus

    if (!Object.keys(body).length) {
      return { ok: false, error: 'No enviaste ningún campo a actualizar' }
    }

    const result = await invokeController(updateAppointment, { params: { id: appointmentId }, body })
    return toToolResult(result, (data) => ({
      id: data?.id,
      title: data?.title,
      startTime: data?.startTime || data?.start_time,
      endTime: data?.endTime || data?.end_time,
      status: data?.appointmentStatus || data?.appointment_status || data?.status
    }))
  }
})

export const cancelAppointmentTool = tool({
  name: 'delete_appointment',
  description: 'Elimina/cancela una cita definitivamente (también en HighLevel/Google si está sincronizada). ACCIÓN DESTRUCTIVA: pide confirmación al usuario antes y pasa confirm=true solo cuando ya confirmó. Si solo quieren marcarla como cancelada sin borrarla, usa update_appointment con appointmentStatus=cancelled.',
  parameters: z.object({
    appointmentId: z.string().describe('ID de la cita a eliminar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ appointmentId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Pregunta antes de eliminar la cita.' }
    }
    const result = await invokeController(deleteEvent, { params: { id: appointmentId } })
    return toToolResult(result)
  }
})

export const appointmentReadTools = [listCalendarsTool, listAppointmentsTool, getFreeSlotsTool]
export const appointmentWriteTools = [createAppointmentTool, updateAppointmentTool, cancelAppointmentTool]
export const appointmentTools = [...appointmentReadTools, ...appointmentWriteTools]
