import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeReminderSendAt,
  renderMessageText,
  isAffirmativeReply,
  formatOffsetLabel
} from '../src/services/appointmentReminderLogic.js'

const TZ = 'America/Mexico_City' // UTC-6 en junio (sin DST)

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

test('renderMessageText sustituye variables de contacto y cita en la zona horaria', () => {
  const text = renderMessageText(
    'Hola {{contact.first_name}}, tu cita "{{cita.titulo}}" es el {{cita.fecha}} a las {{cita.hora}}.',
    {
      contact: { first_name: 'Ana', full_name: 'Ana López' },
      appointment: { title: 'Valoración', start_time: '2026-06-15T18:00:00.000Z' },
      timezone: TZ
    }
  )
  // El locale usa espacios no separables en "p. m."; normalizamos para comparar.
  const normalized = text.replace(/\s+/gu, ' ')
  assert.equal(normalized, 'Hola Ana, tu cita "Valoración" es el lunes 15 de junio a las 12:00 p. m..')
})

test('formatOffsetLabel genera títulos legibles', () => {
  assert.equal(formatOffsetLabel(1, 'days'), '1 día antes')
  assert.equal(formatOffsetLabel(2, 'hours'), '2 horas antes')
  assert.equal(formatOffsetLabel(30, 'minutes'), '30 min antes')
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
