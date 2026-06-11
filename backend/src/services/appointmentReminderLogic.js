import { DateTime } from 'luxon'

// Lógica pura de los mensajes automáticos de citas (sin base de datos) para
// poder probarla de forma aislada: cálculo de horario inteligente, render de
// variables y detección de respuestas afirmativas.

export const DEFAULT_REMINDER_TEXT =
  'Hola {{contact.first_name}}, te recordamos tu cita "{{cita.titulo}}" el {{cita.fecha}} a las {{cita.hora}}. ¡Te esperamos!'

export const DEFAULT_CONFIRMATION_TEXT =
  'Hola {{contact.first_name}}, ¿confirmas tu cita "{{cita.titulo}}" el {{cita.fecha}} a las {{cita.hora}}? Responde SÍ para confirmarla.'

export const OFFSET_UNIT_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function parseHHMM(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(cleanString(value))
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return { hour, minute }
}

export function formatOffsetLabel(offsetValue, offsetUnit) {
  const value = Number(offsetValue) || 0
  if (offsetUnit === 'minutes') return `${value} min antes`
  if (offsetUnit === 'hours') return value === 1 ? '1 hora antes' : `${value} horas antes`
  return value === 1 ? '1 día antes' : `${value} días antes`
}

export function offsetToMs(reminder) {
  return reminder.offsetValue * (OFFSET_UNIT_MS[reminder.offsetUnit] || OFFSET_UNIT_MS.days)
}

/**
 * Calcula el instante UTC en que debe salir el mensaje para una cita.
 * Aplica la ventana de horario inteligente en la zona horaria de la cuenta:
 * si el envío cae fuera de la ventana, se adelanta al día anterior antes de
 * cerrar la ventana ('before') o se pospone al inicio del día siguiente
 * ('next_day'), según la preferencia del usuario.
 */
export function computeReminderSendAt(startTimeIso, reminder, timezone) {
  const start = DateTime.fromISO(cleanString(startTimeIso).replace(' ', 'T'), { zone: 'utc' })
  if (!start.isValid) return null

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

  const start = DateTime
    .fromISO(cleanString(appointment.start_time).replace(' ', 'T'), { zone: 'utc' })
    .setZone(timezone)
    .setLocale('es')

  const values = {
    'contact.name': fullName,
    'contact.full_name': fullName,
    'contact.first_name': firstName,
    'contact.phone': cleanString(contact.phone),
    'cita.titulo': cleanString(appointment.title) || 'tu cita',
    'cita.fecha': start.isValid ? start.toFormat("cccc d 'de' LLLL") : '',
    'cita.hora': start.isValid ? start.toFormat('h:mm a').toLowerCase() : ''
  }

  return cleanString(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => values[key] ?? '')
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
