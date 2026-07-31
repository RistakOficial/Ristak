import { DateTime } from 'luxon'

// Lógica pura de los mensajes automáticos de citas (sin base de datos) para
// poder probarla de forma aislada: cálculo de horario inteligente, render de
// variables y detección de respuestas afirmativas.

export const DEFAULT_APPOINTMENT_NOTICE_TEXT =
  'Hola {{contact.first_name}}, tu cita quedó agendada para el {{cita.fecha}} a las {{cita.hora}}. Te esperamos.\n\nEsto es un mensaje automático'

export const DEFAULT_REMINDER_TEXT =
  'Hola {{contact.first_name}}, te recordamos que tienes una cita el {{cita.fecha}} a las {{cita.hora}}. Recuerda estar al pendiente. 😄\n\nEsto es un mensaje automático'

export const DEFAULT_CONFIRMATION_TEXT =
  'Hola {{contact.first_name}}, queremos confirmar tu asistencia a la cita del {{cita.fecha}} a las {{cita.hora}}. ¿Nos confirmas, por favor?\n\nEs necesario RESPONDER para evitar errores en la agenda'

export const OFFSET_UNIT_MS = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/**
 * Las fechas guardadas por citas y recordatorios son instantes UTC. El
 * adaptador PostgreSQL ya interpreta `timestamp without time zone` como UTC en
 * el borde de base de datos, así que un Date se trata con su semántica normal:
 * un instante absoluto. SQLite entrega strings y se leen explícitamente en UTC.
 */
export function parseStoredUtcDateTime(value) {
  if (DateTime.isDateTime(value)) {
    return value.isValid ? value.toUTC() : null
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return DateTime.fromJSDate(value, { zone: 'utc' })
  }

  const text = cleanString(value)
  if (!text) return null
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const parsed = DateTime.fromISO(normalized, { zone: 'utc' })
  return parsed.isValid ? parsed : null
}

export function parseHHMM(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(cleanString(value))
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return { hour, minute }
}

function responseWindowForStartDay(startDay, startParts, endParts) {
  const startMinutes = startParts.hour * 60 + startParts.minute
  const endMinutes = endParts.hour * 60 + endParts.minute
  if (startMinutes === endMinutes) return null

  const start = startDay.set({
    hour: startParts.hour,
    minute: startParts.minute,
    second: 0,
    millisecond: 0
  })
  const endDay = endMinutes < startMinutes ? startDay.plus({ days: 1 }) : startDay
  const end = endDay.set({
    hour: endParts.hour,
    minute: endParts.minute,
    second: 0,
    millisecond: 0
  })
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) return null

  return {
    start: start.toUTC(),
    end: end.toUTC()
  }
}

function nextResponseWindow(cursor, timezone, startParts, endParts) {
  const localCursor = cursor.setZone(timezone)
  if (!localCursor.isValid) return null

  const day = localCursor.startOf('day')
  const candidates = [-1, 0, 1]
    .map(dayOffset => responseWindowForStartDay(
      day.plus({ days: dayOffset }),
      startParts,
      endParts
    ))
    .filter(window => window && window.end.toMillis() > cursor.toMillis())
    .sort((left, right) => left.start.toMillis() - right.start.toMillis())

  return candidates[0] || null
}

/**
 * Congela el instante UTC en que termina el plazo de confirmación.
 *
 * `elapsed` cuenta tiempo corrido. `response_window` sólo consume tiempo dentro
 * del horario diario configurado en la zona del negocio; fuera de ese horario
 * el contador se pausa. El horario puede cruzar medianoche (por ejemplo 21:00–
 * 09:00). `latestAt` permite fallar cerrado cuando la cita empieza antes de que
 * se alcance el plazo completo.
 */
export function computeConfirmationDeadline({
  sentAt,
  timeoutValue,
  timeoutUnit,
  timeoutMode = 'elapsed',
  responseStart = '09:00',
  responseEnd = '21:00',
  timezone = 'UTC',
  latestAt = null
} = {}) {
  const sent = parseStoredUtcDateTime(sentAt)
  const value = Number(timeoutValue)
  const unitMs = OFFSET_UNIT_MS[cleanString(timeoutUnit)]
  if (!sent || !Number.isInteger(value) || value <= 0 || !unitMs) return null

  const cutoff = latestAt ? parseStoredUtcDateTime(latestAt) : null
  if (latestAt && !cutoff) return null

  if (cleanString(timeoutMode) !== 'response_window') {
    const deadline = sent.plus({ milliseconds: value * unitMs })
    return cutoff && deadline.toMillis() >= cutoff.toMillis() ? null : deadline
  }

  const startParts = parseHHMM(responseStart, null)
  const endParts = parseHHMM(responseEnd, null)
  if (!startParts || !endParts) return null
  if (
    startParts.hour === endParts.hour &&
    startParts.minute === endParts.minute
  ) return null

  let remainingMs = value * unitMs
  let cursor = sent

  // El máximo configurable es 30 días de tiempo disponible. Incluso con una
  // ventana extrema de un minuto diario, 50 mil iteraciones cubren el contrato.
  // En producción `latestAt` corta mucho antes al llegar el inicio de la cita.
  for (let iteration = 0; iteration < 50_000; iteration += 1) {
    const window = nextResponseWindow(cursor, timezone, startParts, endParts)
    if (!window) return null

    const availableStartMs = Math.max(cursor.toMillis(), window.start.toMillis())
    if (cutoff && availableStartMs >= cutoff.toMillis()) return null

    const availableEndMs = cutoff
      ? Math.min(window.end.toMillis(), cutoff.toMillis())
      : window.end.toMillis()
    const availableMs = Math.max(0, availableEndMs - availableStartMs)

    if (remainingMs <= availableMs) {
      const deadline = DateTime.fromMillis(
        availableStartMs + remainingMs,
        { zone: 'utc' }
      )
      return cutoff && deadline.toMillis() >= cutoff.toMillis() ? null : deadline
    }

    remainingMs -= availableMs
    if (cutoff && window.end.toMillis() >= cutoff.toMillis()) return null
    cursor = window.end
  }

  return null
}

export function formatOffsetLabel(offsetValue, offsetUnit, timingAnchor = 'before_appointment') {
  const value = Number(offsetValue) || 0
  if (timingAnchor === 'after_booking') {
    if (value <= 0) return 'Al agendar'
    if (offsetUnit === 'seconds') return value === 1 ? '1 seg después de agendar' : `${value} seg después de agendar`
    if (offsetUnit === 'hours') return value === 1 ? '1 hora después de agendar' : `${value} horas después de agendar`
    return `${value} min después de agendar`
  }
  if (offsetUnit === 'minutes') return `${value} min antes`
  if (offsetUnit === 'hours') return value === 1 ? '1 hora antes' : `${value} horas antes`
  return value === 1 ? '1 día antes' : `${value} días antes`
}

export function offsetToMs(reminder) {
  return reminder.offsetValue * (OFFSET_UNIT_MS[reminder.offsetUnit] || OFFSET_UNIT_MS.days)
}

/**
 * Avisos anclados al momento de agendar (date_added), no al inicio de la
 * cita: sirven sobre todo para reservas hechas por la URL pública. El envío es
 * "agendó + offset" (offset 0 = inmediato). El envío inteligente usa la
 * misma ventana horaria: si cae antes de abrir, se manda al abrir ese día; si cae
 * después de cerrar, 'before' lo recorta al cierre de hoy y 'next_day' lo abre
 * mañana. Nunca antes de agendar ni —si se puede evitar— después de la cita.
 */
function computeAfterBookingSendAt(startTimeIso, bookingTimeIso, reminder, timezone) {
  const booking = parseStoredUtcDateTime(bookingTimeIso)
  if (!booking) return null

  const raw = booking.plus({ milliseconds: offsetToMs(reminder) })
  let sendAt = raw

  if (reminder.smartEnabled) {
    const startParts = parseHHMM(reminder.smartStart, { hour: 9, minute: 0 })
    const endParts = parseHHMM(reminder.smartEnd, { hour: 21, minute: 0 })
    const local = sendAt.setZone(timezone)
    const windowStart = local.set({ hour: startParts.hour, minute: startParts.minute, second: 0, millisecond: 0 })
    const windowEnd = local.set({ hour: endParts.hour, minute: endParts.minute, second: 0, millisecond: 0 })

    if (windowEnd > windowStart) {
      let adjusted = local
      if (local < windowStart) {
        adjusted = windowStart
      } else if (local > windowEnd) {
        adjusted = reminder.smartOverflow === 'next_day' ? windowStart.plus({ days: 1 }) : windowEnd
      }
      sendAt = adjusted.toUTC()
    }

    // Nunca antes del momento en que agendó.
    if (sendAt < booking) sendAt = booking
  }

  // Si el ajuste empuja el aviso más allá del inicio de la cita, pierde
  // sentido: se respeta el tiempo simple (agendó + offset) para que llegue antes.
  const start = parseStoredUtcDateTime(startTimeIso)
  if (start && sendAt >= start) sendAt = raw

  return sendAt
}

/**
 * Calcula el instante UTC en que debe salir el mensaje para una cita.
 * Con timingAnchor 'after_booking' se ancla al momento de agendar (bookingTimeIso).
 * Por defecto ('before_appointment') aplica la ventana de horario inteligente en
 * la zona horaria de la cuenta: si el envío cae fuera de la ventana, se adelanta
 * al día anterior antes de cerrar la ventana ('before') o se pospone al inicio del
 * día siguiente ('next_day'), según la preferencia del usuario.
 */
export function computeReminderSendAt(startTimeIso, reminder, timezone, bookingTimeIso) {
  if (reminder.timingAnchor === 'after_booking') {
    return computeAfterBookingSendAt(startTimeIso, bookingTimeIso, reminder, timezone)
  }

  const start = parseStoredUtcDateTime(startTimeIso)
  if (!start) return null

  let sendAt = start.minus({ milliseconds: offsetToMs(reminder) })

  if (reminder.smartEnabled) {
    const startParts = parseHHMM(reminder.smartStart, { hour: 9, minute: 0 })
    const endParts = parseHHMM(reminder.smartEnd, { hour: 21, minute: 0 })
    const local = sendAt.setZone(timezone)
    const windowStart = local.set({ hour: startParts.hour, minute: startParts.minute, second: 0, millisecond: 0 })
    const windowEnd = local.set({ hour: endParts.hour, minute: endParts.minute, second: 0, millisecond: 0 })

    if (windowEnd > windowStart) {
      let adjusted = local
      if (local < windowStart) {
        // Quedó en la madrugada: o el día anterior antes de cerrar la ventana,
        // o ese mismo día cuando abre la ventana.
        adjusted = reminder.smartOverflow === 'next_day' ? windowStart : windowEnd.minus({ days: 1 })
      } else if (local > windowEnd) {
        adjusted = reminder.smartOverflow === 'next_day' ? windowStart.plus({ days: 1 }) : windowEnd
      }
      sendAt = adjusted.toUTC()
    }
  }

  // Nunca después de la cita: si el ajuste lo empuja más allá del inicio,
  // se respeta la hora original sin ajuste inteligente.
  if (sendAt >= start) {
    sendAt = start.minus({ milliseconds: offsetToMs(reminder) })
  }

  return sendAt
}

export function renderMessageText(template, { contact = {}, appointment = {}, timezone }) {
  const fullName = cleanString(contact.full_name) ||
    [cleanString(contact.first_name), cleanString(contact.last_name)].filter(Boolean).join(' ')
  const firstName = cleanString(contact.first_name) || fullName.split(' ')[0] || ''

  const start = parseStoredUtcDateTime(appointment.start_time)
    ?.setZone(timezone)
    .setLocale('es')

  const values = {
    'contact.name': fullName,
    'contact.full_name': fullName,
    'contact.first_name': firstName,
    'contact.phone': cleanString(contact.phone),
    'cita.titulo': cleanString(appointment.title) || 'tu cita',
    'cita.fecha': start?.isValid ? start.toFormat("cccc d 'de' LLLL") : '',
    'cita.hora': start?.isValid ? start.toFormat('h:mm a').toLowerCase() : '',
    'cita.fecha_hora': start?.isValid
      ? `${start.toFormat("cccc, d 'de' LLLL 'de' yyyy")} ${start.toFormat('H:mm')}`
      : ''
  }

  return cleanString(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => values[key] ?? match)
}

// ---------------------------------------------------------------------------
// Detección de respuestas afirmativas a mensajes de confirmación de cita.
// Mantenerlo conservador: solo respuestas cortas y claramente afirmativas
// confirman la cita; cualquier otra cosa se deja para revisión humana.
// ---------------------------------------------------------------------------

const AFFIRMATIVE_TOKENS = new Set([
  'si', 'sii', 'siii', 'sip', 'simon', 'yes', 'ok', 'okay', 'okey', 'oki',
  'vale', 'va', 'sale', 'dale', 'claro', 'confirmo', 'confirmado', 'confirmada',
  'confirmar', 'perfecto', 'listo', 'deacuerdo', 'correcto', 'porsupuesto',
  'ahivoy', 'ahiestare', 'asistire', 'cuentaconmigo'
])

const AFFIRMATIVE_EMOJI = /[👍✅👌🙌]/u

function normalizeReplyText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isAffirmativeReply(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (raw.length <= 8 && AFFIRMATIVE_EMOJI.test(raw)) return true

  const normalized = normalizeReplyText(raw)
  if (!normalized || normalized.length > 60) return false

  if (AFFIRMATIVE_TOKENS.has(normalized.replace(/\s/g, ''))) return true

  // Frases cortas tipo "si confirmo", "si claro ahi estare", "ok perfecto".
  const words = normalized.split(' ')
  if (words.length <= 6 && words.some(word => AFFIRMATIVE_TOKENS.has(word))) return true

  return false
}
