import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { processDueAppointmentReminders } from '../src/services/appointmentRemindersService.js'
import { DateTime } from 'luxon'
import {
  applyGoogleCancellationToCanonicalAppointment,
  checkSlotAvailability,
  createLocalAppointment,
  createLocalCalendar,
  deleteLocalAppointment,
  getLocalAppointment
} from '../src/services/localCalendarService.js'

async function withAppointment(callback, changes = {}) {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_cancel_${suffix}`
  const appointmentId = `rstk_appt_cancel_${suffix}`
  const contactId = `rstk_contact_cancel_${suffix}`
  const guestId = `rstk_contact_guest_${suffix}`
  const googleEventId = `google-cancel-${suffix}`
  const providerId = 'agenda@example.test'
  try {
    await createLocalCalendar({
      id: calendarId, name: 'Agenda de cancelación', googleCalendarId: providerId,
      openHours: [{ daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6, 7], hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }] }]
    }, { allowGoogleSyncMetadata: true })
    for (const id of [contactId, guestId]) {
      await db.run('INSERT INTO contacts (id, full_name, email) VALUES (?, ?, ?)', [id, 'Contacto prueba', `${id}@example.test`])
    }
    const appointment = await createLocalAppointment({
      id: appointmentId, calendarId, contactId, googleEventId,
      googleProviderCalendarId: providerId, googleSyncStatus: 'synced', googleMirrorGeneration: 4,
      title: 'Conservar esta historia', notes: 'Notas que no se deben borrar',
      startTime: '2030-07-20T16:00:00.000Z', endTime: '2030-07-20T17:00:00.000Z',
      dateUpdated: '2030-07-01T12:00:00.000Z',
      participants: [{ role: 'requester', contactId }, { role: 'primary_attendee', contactId: guestId }],
      ...changes
    }, { syncStatus: 'synced' })
    const command = { appointmentId, calendarId, googleEventId, googleProviderCalendarId: providerId }
    await callback({ appointment, command, contactId, guestId })
  } finally {
    await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId])
    await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId])
    await db.run('DELETE FROM appointment_reminders WHERE calendar_id = ?', [calendarId])
    await deleteLocalAppointment(appointmentId)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, guestId])
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId])
  }
}

test('cancelación mínima de Google libera horario, conserva historial y cierra confirmaciones una sola vez', async () => {
  await withAppointment(async ({ appointment, command, contactId, guestId }) => {
    assert.equal((await checkSlotAvailability(command.calendarId, appointment.startTime, appointment.endTime)).available, false)
    const sendId = `send-${randomUUID()}`
    await db.run(`INSERT INTO appointment_reminder_sends
      (id, reminder_id, appointment_id, contact_id, status, message_type, confirmation_timeout_status, attempt_count)
      VALUES (?, ?, ?, ?, 'sent', 'confirmation', 'pending', 2)`,
    [sendId, `reminder-${randomUUID()}`, appointment.id, contactId])
    await db.run(`INSERT INTO appointment_confirmation_windows
      (id, contact_id, appointment_id, reminder_send_id, status, last_message_at)
      VALUES (?, ?, ?, ?, 'waiting', CURRENT_TIMESTAMP)`,
    [`window-${randomUUID()}`, contactId, appointment.id, sendId])

    const result = await applyGoogleCancellationToCanonicalAppointment(command)
    assert.equal(result.applied, true)
    assert.equal(result.cancelled, true)
    assert.equal(result.appointment.appointmentStatus, 'cancelled')
    assert.equal(result.appointment.id, appointment.id)
    assert.equal(result.appointment.notes, appointment.notes)
    assert.equal(result.appointment.startTime, appointment.startTime)
    assert.deepEqual(result.appointment.participants, appointment.participants)
    assert.equal(result.appointment.googleMirrorGeneration, 4)
    assert.equal(result.appointment.googleEventId, command.googleEventId)
    assert.equal(result.appointment.googleSyncStatus, 'synced')
    assert.equal((await db.get('SELECT deleted_at FROM appointments WHERE id = ?', [appointment.id])).deleted_at, null)
    assert.equal((await checkSlotAvailability(command.calendarId, appointment.startTime, appointment.endTime)).available, true)
    for (const id of [contactId, guestId]) {
      assert.equal((await db.get('SELECT appointment_date FROM contacts WHERE id = ?', [id])).appointment_date, null)
    }
    const window = await db.get('SELECT status, result FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointment.id])
    assert.deepEqual(window, { status: 'done', result: 'cancel' })
    const send = await db.get('SELECT status, confirmation_timeout_status, attempt_count FROM appointment_reminder_sends WHERE id = ?', [sendId])
    assert.deepEqual(send, { status: 'sent', confirmation_timeout_status: 'responded', attempt_count: 2 })

    const replay = await applyGoogleCancellationToCanonicalAppointment(command)
    assert.equal(replay.applied, false)
    assert.equal(replay.reason, 'already_cancelled')
    assert.equal(replay.appointment.dateUpdated, result.appointment.dateUpdated)
  })
})

test('no acepta cancelaciones de otra generación, agenda, proveedor ni anteriores a la edición local', async () => {
  await withAppointment(async ({ appointment, command }) => {
    for (const change of [
      { googleEventId: 'old-generation-id' },
      { calendarId: 'other-local-calendar' },
      { googleProviderCalendarId: 'old-provider@example.test' },
      { remoteUpdatedAt: '2030-06-30T12:00:00.000Z' }
    ]) {
      assert.equal((await applyGoogleCancellationToCanonicalAppointment({ ...command, ...change })).applied, false)
      assert.equal((await getLocalAppointment(appointment.id)).appointmentStatus, 'confirmed')
    }
    const valid = await applyGoogleCancellationToCanonicalAppointment({
      ...command, googleProviderCalendarId: command.googleProviderCalendarId.toUpperCase(),
      remoteUpdatedAt: '2030-07-02T12:00:00.000Z'
    })
    assert.equal(valid.cancelled, true)
  })
})

test('dos consumidores concurrentes producen una sola transición a cancelada', async () => {
  await withAppointment(async ({ command }) => {
    const results = await Promise.all([
      applyGoogleCancellationToCanonicalAppointment(command),
      applyGoogleCancellationToCanonicalAppointment(command)
    ])
    assert.equal(results.filter(result => result.cancelled).length, 1)
    assert.equal(results.filter(result => result.applied).length, 1)
  })
})

test('la cancelación excluye la cita del envío de recordatorios pendientes', async () => {
  await withAppointment(async ({ appointment, command }) => {
    await db.run(`INSERT INTO appointment_reminders
      (id, calendar_id, name, enabled, channel, content_mode, timing_anchor, offset_value, offset_unit, smart_enabled, message_text)
      VALUES (?, ?, 'Recordatorio al agendar', 1, 'email', 'custom', 'after_booking', 0, 'minutes', 0, 'Cita pendiente')`,
    [`reminder-${randomUUID()}`, command.calendarId])
    await applyGoogleCancellationToCanonicalAppointment(command)
    assert.deepEqual(await processDueAppointmentReminders(), { sent: 0, errors: 0, skipped: 0 })
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM appointment_reminder_sends WHERE appointment_id = ?', [appointment.id])).total, 0)
  }, { startTime: DateTime.utc().plus({ hours: 1 }).toISO(), endTime: DateTime.utc().plus({ hours: 2 }).toISO() })
})

test('borrar el evento de una atención completada conserva asistencia sin volver a publicarla', async () => {
  await withAppointment(async ({ appointment, command }) => {
    const result = await applyGoogleCancellationToCanonicalAppointment(command)
    assert.equal(result.applied, true)
    assert.equal(result.cancelled, false)
    assert.equal(result.appointment.appointmentStatus, 'showed')
    assert.equal(result.appointment.startTime, appointment.startTime)
    assert.equal(result.appointment.googleSyncStatus, 'history_only')
    assert.equal((await applyGoogleCancellationToCanonicalAppointment(command)).applied, false)
  }, { status: 'showed', appointmentStatus: 'showed' })
})
