import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import * as localCalendarService from './localCalendarService.js'
import * as googleCalendarService from './googleCalendarService.js'
import {
  archiveSystemTriggerLink,
  getSystemTriggerLink,
  normalizeTriggerLinkDestination,
  upsertSystemTriggerLink
} from './triggerLinksService.js'
import { buildTriggerLinkRecipientUrl } from './triggerLinkRecipientTokenService.js'
import { recordAttendanceAttributionSignal } from './appointmentsMerge.js'
import { dispatchAppointmentAutomationEvent } from './appointmentAutomationService.js'
import { createInternalNotification } from './notificationsService.js'
import { resolveNotificationDeliveryTargetsForEvent } from './notificationPreferencesService.js'

export const CALENDAR_MEETING_TRIGGER_SCOPE = 'calendar_meeting'
export const CALENDAR_MEETING_MODES = new Set(['in_person', 'online'])

function cleanString(value, max = 2048) {
  return String(value ?? '').trim().slice(0, max)
}

function badRequest(message, code = 'invalid_calendar_meeting') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

export function normalizeCalendarMeetingInput(input = {}, existing = {}) {
  const requestedMode = input.meetingMode ?? input.meeting_mode ?? input.meeting?.mode
  const existingMode = existing.meetingMode ?? existing.meeting_mode ?? existing.meeting?.mode
  const mode = cleanString(requestedMode ?? existingMode ?? 'in_person', 40).toLowerCase()
  if (!CALENDAR_MEETING_MODES.has(mode)) {
    throw badRequest('Elige si la cita será presencial o en línea.', 'invalid_calendar_meeting_mode')
  }

  if (mode === 'in_person') return { meetingMode: mode, meetingUrl: '' }

  const rawUrl = input.meetingUrl ?? input.meeting_url ?? input.meeting?.url ??
    existing.meetingUrl ?? existing.meeting_url ?? existing.meeting?.url
  if (!cleanString(rawUrl)) {
    throw badRequest('Pega el enlace de Zoom, Google Meet o la plataforma que usarás.', 'calendar_meeting_url_required')
  }
  const meetingUrl = normalizeTriggerLinkDestination(rawUrl)
  let parsed
  try {
    parsed = new URL(meetingUrl)
  } catch {
    throw badRequest('Pega una URL válida para la videollamada.', 'invalid_calendar_meeting_url')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw badRequest('El enlace de la videollamada debe empezar con http:// o https://.', 'invalid_calendar_meeting_url')
  }
  return { meetingMode: mode, meetingUrl: parsed.toString() }
}

export async function syncCalendarMeetingResources(calendar = {}) {
  const calendarId = cleanString(calendar.id, 180)
  if (!calendarId) throw badRequest('No se pudo identificar el calendario.')
  const meeting = normalizeCalendarMeetingInput(calendar, calendar)

  if (meeting.meetingMode === 'online') {
    await upsertSystemTriggerLink({
      systemScope: CALENDAR_MEETING_TRIGGER_SCOPE,
      ownerId: calendarId,
      name: `Videollamada · ${cleanString(calendar.name, 120) || 'Calendario'}`,
      destinationUrl: meeting.meetingUrl,
      description: 'Enlace interno administrado por Ristak para registrar el ingreso y la asistencia.'
    })
  } else {
    await archiveSystemTriggerLink(CALENDAR_MEETING_TRIGGER_SCOPE, calendarId)
  }

  const { syncOnlineMeetingAppointmentReminder } = await import('./appointmentRemindersService.js')
  const reminder = await syncOnlineMeetingAppointmentReminder(calendarId, {
    enabled: meeting.meetingMode === 'online'
  })
  if (meeting.meetingMode === 'online' && !reminder?.id) {
    const error = new Error('Ya existe otro mensaje automático 10 minutos antes en este calendario. Edítalo o elimínalo antes de cambiar la cita a en línea.')
    error.status = 409
    error.code = 'calendar_online_reminder_conflict'
    throw error
  }
  return meeting
}

export async function archiveCalendarMeetingResources(calendarId) {
  const id = cleanString(calendarId, 180)
  if (!id) return
  await archiveSystemTriggerLink(CALENDAR_MEETING_TRIGGER_SCOPE, id)
  const { syncOnlineMeetingAppointmentReminder } = await import('./appointmentRemindersService.js')
  await syncOnlineMeetingAppointmentReminder(id, { enabled: false })
}

export async function buildAppointmentMeetingJoinUrl({
  appointment = {},
  contactId = '',
  baseUrl = '',
  triggerLinkPublicId = ''
} = {}) {
  const appointmentId = cleanString(appointment.id || appointment.appointmentId || appointment.appointment_id, 180)
  const calendarId = cleanString(appointment.calendarId || appointment.calendar_id, 180)
  const resolvedContactId = cleanString(contactId || appointment.contactId || appointment.contact_id, 180)
  if (!appointmentId || !calendarId || !resolvedContactId) return ''

  const link = triggerLinkPublicId
    ? { publicId: cleanString(triggerLinkPublicId, 80) }
    : await getSystemTriggerLink(CALENDAR_MEETING_TRIGGER_SCOPE, calendarId)
  if (!link?.publicId) return ''

  let publicBaseUrl = cleanString(baseUrl)
  if (!publicBaseUrl) {
    const status = await localCalendarService.getCalendarPublicUrlStatus()
    publicBaseUrl = cleanString(status?.baseUrl)
  }
  return buildTriggerLinkRecipientUrl({
    publicId: link.publicId,
    contactId: resolvedContactId,
    appointmentId,
    baseUrl: publicBaseUrl
  })
}

function isAlreadyAttended(status = '') {
  return ['showed', 'show', 'attended', 'completed', 'complete'].includes(cleanString(status, 40).toLowerCase())
}

function isInactive(status = '') {
  return ['cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'invalid', 'deleted', 'failed'].includes(
    cleanString(status, 40).toLowerCase()
  )
}

async function deliverMeetingJoinNotification(appointment = {}, calendar = {}) {
  const contactName = cleanString(appointment.contactName || appointment.contact_name, 180) || 'El contacto'
  const appointmentId = cleanString(appointment.id, 180)
  const actionUrl = `/movil/calendar?open=appointment&id=${encodeURIComponent(appointmentId)}`
  const basePayload = {
    source: 'Calendarios',
    severity: 'info',
    title: `${contactName} ingresó a la videollamada`,
    message: `Ristak marcó asistencia en ${cleanString(calendar.name, 140) || cleanString(appointment.title, 140) || 'la cita'}.`,
    actionUrl,
    actionLabel: 'Abrir cita',
    category: 'appointment_joined',
    contactId: cleanString(appointment.contactId || appointment.contact_id, 180),
    metadata: {
      eventId: `appointment-joined:${appointmentId}`,
      appointmentId,
      calendarId: cleanString(appointment.calendarId || appointment.calendar_id, 180)
    }
  }
  const targets = await resolveNotificationDeliveryTargetsForEvent('appointment_joined')
  const bell = targets.configured ? targets.bell : { userIds: null }
  const push = targets.configured ? targets.push : { userIds: null }

  if (bell.userIds === null || bell.userIds.length > 0) {
    await createInternalNotification({
      ...basePayload,
      recipientUserIds: bell.userIds || [],
      broadcast: bell.userIds === null,
      createBellNotification: true,
      sendPushNotification: false
    })
  }
  if (push.userIds === null || push.userIds.length > 0) {
    await createInternalNotification({
      ...basePayload,
      recipientUserIds: push.userIds || [],
      broadcast: push.userIds === null,
      createBellNotification: false,
      sendPushNotification: true
    })
  }
}

export async function handleCalendarMeetingLinkClick({ appointmentId, contactId, calendarId } = {}) {
  const exactAppointmentId = cleanString(appointmentId, 180)
  const exactContactId = cleanString(contactId, 180)
  const exactCalendarId = cleanString(calendarId, 180)
  if (!exactAppointmentId || !exactContactId || !exactCalendarId) return { marked: false, reason: 'missing_identity' }

  const result = await db.transaction(async () => {
    const appointment = await localCalendarService.getLocalAppointment(exactAppointmentId)
    if (!appointment?.id || appointment.id !== exactAppointmentId || appointment.contactId !== exactContactId || appointment.calendarId !== exactCalendarId) {
      return { marked: false, reason: 'appointment_mismatch' }
    }
    const previousStatus = appointment.appointmentStatus || appointment.status || ''
    if (isInactive(previousStatus)) return { marked: false, reason: 'inactive_appointment', appointment }
    if (isAlreadyAttended(previousStatus)) {
      await recordAttendanceAttributionSignal({
        contactId: exactContactId,
        appointmentId: exactAppointmentId,
        source: 'calendar_meeting_link_click'
      })
      return { marked: false, reason: 'already_attended', appointment }
    }

    const transition = await db.run(`
      UPDATE appointments
      SET status = 'showed',
          appointment_status = 'showed',
          sync_status = 'pending',
          date_updated = CURRENT_TIMESTAMP
      WHERE id = ?
        AND contact_id = ?
        AND calendar_id = ?
        AND deleted_at IS NULL
        AND LOWER(COALESCE(appointment_status, status, '')) NOT IN (
          'showed', 'show', 'attended', 'completed', 'complete',
          'cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'invalid', 'deleted', 'failed'
        )
    `, [exactAppointmentId, exactContactId, exactCalendarId])
    const updated = await localCalendarService.getLocalAppointment(exactAppointmentId)
    if (Number(transition?.changes || 0) === 0) {
      const alreadyAttended = isAlreadyAttended(updated?.appointmentStatus || updated?.status)
      if (alreadyAttended) {
        await recordAttendanceAttributionSignal({
          contactId: exactContactId,
          appointmentId: exactAppointmentId,
          source: 'calendar_meeting_link_click'
        })
      }
      return {
        marked: false,
        reason: alreadyAttended ? 'already_attended' : 'inactive_appointment',
        appointment: updated || appointment
      }
    }
    await recordAttendanceAttributionSignal({
      contactId: exactContactId,
      appointmentId: exactAppointmentId,
      source: 'calendar_meeting_link_click'
    })
    return { marked: true, previousStatus, appointment: updated }
  })

  if (!result.marked) return result
  const calendar = await localCalendarService.getLocalCalendar(exactCalendarId)
  Promise.allSettled([
    googleCalendarService.syncAppointmentToGoogle(result.appointment),
    dispatchAppointmentAutomationEvent('appointment-status', result.appointment, {
      previousStatus: result.previousStatus,
      appointmentChange: 'attended',
      source: 'calendar_meeting_link_click'
    }),
    deliverMeetingJoinNotification(result.appointment, calendar || {})
  ]).then((settled) => {
    settled.forEach((entry) => {
      if (entry.status === 'rejected') logger.warn(`[Calendar Meeting] Efecto secundario pendiente: ${entry.reason?.message || entry.reason}`)
    })
  }).catch(() => {})
  return result
}
