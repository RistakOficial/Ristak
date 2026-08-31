import test from 'node:test'
import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import {
  computeConfirmationDeadline,
  computeMaximumResponseWindowDuration,
  computeReminderSendAt,
  DEFAULT_APPOINTMENT_NOTICE_TEXT,
  renderMessageText,
  parseStoredUtcDateTime,
  isAffirmativeReply,
  formatOffsetLabel
} from '../src/services/appointmentReminderLogic.js'

const TZ = 'America/Mexico_City' // UTC-6 en junio (sin DST)
const DST_TZ = 'America/Ciudad_Juarez'

const baseReminder = {
  offsetValue: 1,
  offsetUnit: 'days',
  smartEnabled: false,
  smartStart: '09:00',
  smartEnd: '21:00',
  smartOverflow: 'before'
}

test('sin horario inteligente el envío es exactamente el offset antes de la cita', () => {
  // Cita: 15 jun 18:00 UTC → envío 14 jun 18:00 UTC
  const sendAt = computeReminderSendAt('2026-06-15T18:00:00.000Z', baseReminder, TZ)
  assert.equal(sendAt.toISO(), '2026-06-14T18:00:00.000Z')
})

test('horario inteligente: cita en la madrugada se adelanta al cierre de ventana del día anterior (before)', () => {
  // Cita: 5:00 am hora local (11:00 UTC). 1 día antes = 5:00 am local, fuera
  // de la ventana 09:00-21:00 → con 'before' se envía el día ANTERIOR a las 21:00.
  const reminder = { ...baseReminder, smartEnabled: true }
  const sendAt = computeReminderSendAt('2026-06-15T11:00:00.000Z', reminder, TZ)
  const local = sendAt.setZone(TZ)
  assert.equal(local.toFormat('yyyy-MM-dd HH:mm'), '2026-06-13 21:00')
})

test('horario inteligente: cita en la madrugada se pospone a la apertura de ventana (next_day)', () => {
  const reminder = { ...baseReminder, smartEnabled: true, smartOverflow: 'next_day' }
  const sendAt = computeReminderSendAt('2026-06-15T11:00:00.000Z', reminder, TZ)
  const local = sendAt.setZone(TZ)
  // 5:00 am queda antes de la ventana → ese mismo día a las 09:00
  assert.equal(local.toFormat('yyyy-MM-dd HH:mm'), '2026-06-14 09:00')
})

test('horario inteligente: envío nocturno se recorta al cierre de ventana (before)', () => {
  // Cita: 23:30 local del 15 jun → 1 día antes = 23:30 local del 14, fuera de
  // ventana → 'before' lo deja ese mismo día a las 21:00.
  const reminder = { ...baseReminder, smartEnabled: true }
  const sendAt = computeReminderSendAt('2026-06-16T05:30:00.000Z', reminder, TZ)
  const local = sendAt.setZone(TZ)
  assert.equal(local.toFormat('yyyy-MM-dd HH:mm'), '2026-06-14 21:00')
})

test('horario inteligente: envío dentro de la ventana no se mueve', () => {
  // Cita 15 jun 12:00 local → envío 14 jun 12:00 local, dentro de 09:00-21:00.
  const reminder = { ...baseReminder, smartEnabled: true }
  const sendAt = computeReminderSendAt('2026-06-15T18:00:00.000Z', reminder, TZ)
  assert.equal(sendAt.toISO(), '2026-06-14T18:00:00.000Z')
})

test('el ajuste nunca empuja el envío después de la cita', () => {
  // Recordatorio de 30 min antes de una cita a las 22:00 local: moverlo al día
  // siguiente a las 09:00 sería DESPUÉS de la cita → se respeta la hora original.
  const reminder = {
    ...baseReminder,
    offsetValue: 30,
    offsetUnit: 'minutes',
    smartEnabled: true,
    smartOverflow: 'next_day'
  }
  const appointment = '2026-06-16T04:00:00.000Z' // 22:00 local del 15 jun
  const sendAt = computeReminderSendAt(appointment, reminder, TZ)
  assert.ok(sendAt.toISO() < appointment)
  assert.equal(sendAt.toISO(), '2026-06-16T03:30:00.000Z')
})

test('el plazo corrido conserva la suma absoluta anterior', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-15T20:00:00.000Z',
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'elapsed',
    timezone: TZ
  })

  assert.equal(deadline?.toISO(), '2026-06-16T08:00:00.000Z')
})

test('la fecha límite fija vence exactamente antes de la cita y no depende del envío', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-15T18:00:00.000Z',
    timeoutValue: 5,
    timeoutUnit: 'hours',
    timeoutMode: 'appointment_cutoff',
    timezone: TZ,
    latestAt: '2026-06-16T18:00:00.000Z'
  })

  assert.equal(deadline?.toISO(), '2026-06-16T13:00:00.000Z')
})

test('la fecha límite fija falla cerrado si el mensaje llega después del corte', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-16T14:00:00.000Z',
    timeoutValue: 5,
    timeoutUnit: 'hours',
    timeoutMode: 'appointment_cutoff',
    timezone: TZ,
    latestAt: '2026-06-16T18:00:00.000Z'
  })

  assert.equal(deadline, null)
})

test('detecta cuando un plazo jamás cabe en el horario de respuesta disponible', () => {
  assert.equal(
    computeMaximumResponseWindowDuration({
      intervalMs: 24 * 60 * 60 * 1000,
      responseStart: '11:00',
      responseEnd: '22:00'
    }),
    11 * 60 * 60 * 1000
  )
  assert.equal(
    computeMaximumResponseWindowDuration({
      intervalMs: 24 * 60 * 60 * 1000,
      responseStart: '21:00',
      responseEnd: '09:00'
    }),
    12 * 60 * 60 * 1000
  )
})

test('el horario de respuesta pausa el plazo durante la noche', () => {
  // 20:00 local: queda 1 hora disponible hoy. Las otras 11 se cuentan mañana
  // desde las 09:00, por lo que el límite cae a las 20:00 local.
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-16T02:00:00.000Z',
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'response_window',
    responseStart: '09:00',
    responseEnd: '21:00',
    timezone: TZ
  })

  assert.equal(
    deadline?.setZone(TZ).toFormat('yyyy-MM-dd HH:mm'),
    '2026-06-16 20:00'
  )
})

test('el horario de respuesta conserva horas de pared al cruzar el cambio de verano', () => {
  // El sábado todavía usa UTC-7 y el domingo ya usa UTC-6. El resultado debe
  // seguir siendo 20:00 local, no desplazarse una hora por sumar milisegundos.
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-03-08T03:00:00.000Z', // sábado 20:00 local
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'response_window',
    responseStart: '09:00',
    responseEnd: '21:00',
    timezone: DST_TZ
  })

  assert.equal(
    deadline?.setZone(DST_TZ).toFormat('yyyy-MM-dd HH:mm'),
    '2026-03-08 20:00'
  )
  assert.equal(deadline?.toISO(), '2026-03-09T02:00:00.000Z')
})

test('un mensaje enviado en la madrugada empieza a contar cuando abre el horario de respuesta', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-15T09:00:00.000Z', // 03:00 local
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'response_window',
    responseStart: '09:00',
    responseEnd: '21:00',
    timezone: TZ
  })

  assert.equal(
    deadline?.setZone(TZ).toFormat('yyyy-MM-dd HH:mm'),
    '2026-06-15 21:00'
  )
})

test('el horario de respuesta también admite jornadas que cruzan medianoche', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-15T08:00:00.000Z', // 02:00 local, dentro de 21:00–09:00
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'response_window',
    responseStart: '21:00',
    responseEnd: '09:00',
    timezone: TZ
  })

  assert.equal(
    deadline?.setZone(TZ).toFormat('yyyy-MM-dd HH:mm'),
    '2026-06-16 02:00'
  )
})

test('el plazo protegido falla cerrado si la cita empieza antes de completarlo', () => {
  const deadline = computeConfirmationDeadline({
    sentAt: '2026-06-16T02:00:00.000Z', // 20:00 local
    timeoutValue: 12,
    timeoutUnit: 'hours',
    timeoutMode: 'response_window',
    responseStart: '09:00',
    responseEnd: '21:00',
    timezone: TZ,
    latestAt: '2026-06-16T18:00:00.000Z' // 12:00 local del día siguiente
  })

  assert.equal(deadline, null)
})

test('renderMessageText sustituye variables de contacto y cita en la zona horaria', () => {
  const text = renderMessageText(
    'Hola {{contact.first_name}}, tu cita "{{cita.titulo}}" es el {{cita.fecha}} a las {{cita.hora}} ({{cita.fecha_hora}}).',
    {
      contact: { first_name: 'Ana', full_name: 'Ana López' },
      appointment: { title: 'Valoración', start_time: '2026-06-15T18:00:00.000Z' },
      timezone: TZ
    }
  )
  // El locale usa espacios no separables en "p. m."; normalizamos para comparar.
  const normalized = text.replace(/\s+/gu, ' ')
  assert.equal(normalized, 'Hola Ana, tu cita "Valoración" es el lunes 15 de junio a las 12:00 p. m. (lunes, 15 de junio de 2026 12:00).')
})

test('el aviso directo al agendar conserva el copy y formato canónicos', () => {
  const text = renderMessageText(DEFAULT_APPOINTMENT_NOTICE_TEXT, {
    contact: { first_name: 'Ana' },
    appointment: {
      title: 'Consulta',
      start_time: '2026-07-31T19:00:00.000Z'
    },
    timezone: DST_TZ
  })

  assert.equal(
    text,
    '*🗓️ Cita programada para el viernes, 31 de julio de 2026 13:00*\n\n' +
      '🔔 *Importante:* Te llegarán varios recordatorios para *NO* olvidar que tienes una cita programada.\n\n' +
      'Te pedimos de la manera más atenta que *respondas* los mensajes cuando se te solicite, para mantener una comunicación clara y evitar cualquier confusión con las citas.\n\n' +
      '¡Gracias!\n\n' +
      'Este es un mensaje AUTOMÁTICO'
  )
})

test('timestamps Date de PostgreSQL conservan el instante UTC en recordatorios', () => {
  // El adaptador de base ya interpreta los timestamp naive como UTC. Date
  // conserva su semántica de instante y no se rehidrata con la zona del proceso.
  const postgresTimestamp = new Date('2026-06-15T18:00:00.000Z')
  const parsed = parseStoredUtcDateTime(postgresTimestamp)
  assert.equal(parsed?.toISO(), '2026-06-15T18:00:00.000Z')
  assert.equal(
    parseStoredUtcDateTime(DateTime.fromISO('2026-06-15T18:00:00.000Z'))?.toISO(),
    '2026-06-15T18:00:00.000Z'
  )

  const reminder = { ...baseReminder, offsetValue: 30, offsetUnit: 'minutes' }
  const sendAt = computeReminderSendAt(postgresTimestamp, reminder, TZ)
  assert.equal(sendAt?.toISO(), '2026-06-15T17:30:00.000Z')

  const text = renderMessageText('Cita: {{cita.fecha_hora}}', {
    contact: { first_name: 'Ana' },
    appointment: { title: 'Consulta', start_time: postgresTimestamp },
    timezone: TZ
  })
  assert.match(text, /lunes, 15 de junio de 2026 12:00/)
})

test('formatOffsetLabel genera títulos legibles', () => {
  assert.equal(formatOffsetLabel(1, 'days'), '1 día antes')
  assert.equal(formatOffsetLabel(2, 'hours'), '2 horas antes')
  assert.equal(formatOffsetLabel(30, 'minutes'), '30 min antes')
})

test('formatOffsetLabel después de agendar', () => {
  assert.equal(formatOffsetLabel(0, 'minutes', 'after_booking'), 'Al agendar')
  assert.equal(formatOffsetLabel(5, 'minutes', 'after_booking'), '5 min después de agendar')
  assert.equal(formatOffsetLabel(30, 'seconds', 'after_booking'), '30 seg después de agendar')
  assert.equal(formatOffsetLabel(2, 'hours', 'after_booking'), '2 horas después de agendar')
  assert.equal(formatOffsetLabel(1, 'hours', 'after_booking'), '1 hora después de agendar')
})

// ---------------------------------------------------------------------------
// Avisos anclados al momento de agendar (timingAnchor: 'after_booking').
// ---------------------------------------------------------------------------

const afterBase = {
  timingAnchor: 'after_booking',
  offsetValue: 5,
  offsetUnit: 'minutes',
  smartEnabled: false,
  smartStart: '09:00',
  smartEnd: '21:00',
  smartOverflow: 'before'
}

test('después de agendar: offset 0 envía justo al momento de la reserva', () => {
  const reminder = { ...afterBase, offsetValue: 0 }
  // Agendó 18:00 UTC, cita el día siguiente: el envío es exactamente al agendar.
  const sendAt = computeReminderSendAt('2026-06-16T18:00:00.000Z', reminder, TZ, '2026-06-15T18:00:00.000Z')
  assert.equal(sendAt.toISO(), '2026-06-15T18:00:00.000Z')
})

test('después de agendar: 5 minutos suma el offset al momento de la reserva', () => {
  const sendAt = computeReminderSendAt('2026-06-20T18:00:00.000Z', afterBase, TZ, '2026-06-15T18:00:00.000Z')
  assert.equal(sendAt.toISO(), '2026-06-15T18:05:00.000Z')
})

test('envío inteligente después de agendar: reserva de madrugada se mueve a la apertura de la ventana', () => {
  // Agendó 08:30 UTC = 02:30 local; con +5min sigue antes de las 09:00 → se mueve a las 09:00 local.
  const reminder = { ...afterBase, smartEnabled: true }
  const sendAt = computeReminderSendAt('2026-06-25T20:00:00.000Z', reminder, TZ, '2026-06-15T08:30:00.000Z')
  const local = sendAt.setZone(TZ)
  assert.equal(local.toFormat('yyyy-MM-dd HH:mm'), '2026-06-15 09:00')
})

test('envío inteligente después de agendar: reserva nocturna con next_day abre al día siguiente', () => {
  // Agendó 04:30 UTC = 22:30 local (después de cerrar 21:00) → next_day = 09:00 del día siguiente.
  const reminder = { ...afterBase, smartEnabled: true, smartOverflow: 'next_day' }
  const sendAt = computeReminderSendAt('2026-06-25T20:00:00.000Z', reminder, TZ, '2026-06-16T04:30:00.000Z')
  const local = sendAt.setZone(TZ)
  assert.equal(local.toFormat('yyyy-MM-dd HH:mm'), '2026-06-16 09:00')
})

test('después de agendar: dentro de la ventana no se mueve', () => {
  const reminder = { ...afterBase, smartEnabled: true }
  // Agendó 18:00 UTC = 12:00 local, +5min = 12:05 dentro de 09:00-21:00.
  const sendAt = computeReminderSendAt('2026-06-25T20:00:00.000Z', reminder, TZ, '2026-06-15T18:00:00.000Z')
  assert.equal(sendAt.toISO(), '2026-06-15T18:05:00.000Z')
})

test('isAffirmativeReply acepta respuestas afirmativas comunes', () => {
  for (const reply of ['Sí', 'si', 'SI confirmo', 'Claro que sí', 'ok', '👍', 'Confirmada', 'ahí estaré']) {
    assert.equal(isAffirmativeReply(reply), true, `debería aceptar: ${reply}`)
  }
})

test('isAffirmativeReply rechaza respuestas negativas o ambiguas', () => {
  for (const reply of ['no', 'no puedo', '¿pueden cambiarla?', 'quién eres', '', 'cancelar', 'mejor otro día por favor que sea más tarde y avisame con tiempo']) {
    assert.equal(isAffirmativeReply(reply), false, `debería rechazar: ${reply}`)
  }
})
