import { renderTemplateVariables } from './templateVariablesService.js'
import { DEFAULT_TIMEZONE, resolveTimezone } from '../utils/dateUtils.js'

function cleanString(value, max = 5000) {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned.slice(0, max) : ''
}

function firstValue(...values) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return ''
}

function datePartsFrom(value, timezone = DEFAULT_TIMEZONE) {
  const raw = cleanString(value)
  if (!raw) return { date: '', time: '' }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return { date: '', time: '' }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(parsed)
  const get = (type) => parts.find((part) => part.type === type)?.value || ''

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  }
}

export function buildCalendarAppointmentTemplateVariables({ calendar = {}, appointmentData = {} } = {}) {
  const startTime = firstValue(appointmentData.startTime, appointmentData.start_time)
  const timezone = firstValue(appointmentData.timeZone, appointmentData.timezone, calendar.timeZone, calendar.timezone) || DEFAULT_TIMEZONE
  const { date, time } = datePartsFrom(startTime, timezone)
  const appointmentId = firstValue(appointmentData.id, appointmentData.appointmentId, appointmentData.appointment_id)
  const appointmentNotes = firstValue(appointmentData.notes, appointmentData.description)
  const appointmentStatus = firstValue(appointmentData.appointmentStatus, appointmentData.appointment_status, appointmentData.status)
  const calendarId = firstValue(calendar.id, appointmentData.calendarId, appointmentData.calendar_id)
  const calendarName = firstValue(calendar.name, appointmentData.calendarName, appointmentData.calendar_name, calendarId)
  const appointmentType = firstValue(appointmentData.title, calendar.eventTitle, calendar.event_title, calendar.name)

  return {
    'appointment.id': appointmentId,
    'appointment.date': date,
    'appointment.time': time,
    'appointment.calendar': calendarName,
    'appointment.type': appointmentType,
    'appointment.status': appointmentStatus,
    'appointment.notes': appointmentNotes,
    'cita.id_cita': appointmentId,
    'cita.fecha': date,
    'cita.hora': time,
    'cita.calendario': calendarName,
    'cita.servicio': appointmentType,
    'cita.estado': appointmentStatus,
    'cita.notas': appointmentNotes,
    'calendar.id': calendarId,
    'calendar.name': calendarName,
    'calendar.google_calendar': firstValue(calendar.googleCalendarSummary, calendar.googleCalendarId),
    'calendar.google_calendar_id': firstValue(calendar.googleCalendarId)
  }
}

export async function renderCalendarAppointmentTemplates({
  calendar = {},
  appointmentData = {},
  titleTemplate = '',
  notesTemplate = '',
  contact = null,
  contactId = '',
  userId = null,
  publicBaseUrl = ''
} = {}) {
  const templateVariables = buildCalendarAppointmentTemplateVariables({ calendar, appointmentData })
  const options = {
    contact,
    contactId: firstValue(contactId, appointmentData.contactId, appointmentData.contact_id),
    userId,
    publicBaseUrl,
    extraVariables: templateVariables
  }

  const titleSource = firstValue(titleTemplate, appointmentData.title, calendar.eventTitle, calendar.event_title, calendar.name, 'Cita')
  const notesSource = notesTemplate === null || notesTemplate === undefined
    ? firstValue(appointmentData.notes, appointmentData.description)
    : String(notesTemplate)

  const [title, notes] = await Promise.all([
    renderTemplateVariables(titleSource, options),
    renderTemplateVariables(notesSource, options)
  ])

  return {
    title: firstValue(title, calendar.name, 'Cita'),
    notes: cleanString(notes)
  }
}
