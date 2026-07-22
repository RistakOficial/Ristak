import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createAppointmentReminder,
  ensureDefaultAppointmentReminder
} from '../src/services/appointmentRemindersService.js'

test('el arranque concurrente crea una sola vez el recordatorio predeterminado', async () => {
  await db.run("DELETE FROM app_config WHERE config_key = 'appointment_reminders_seeded'")
  await db.run('DELETE FROM appointment_reminders')

  await Promise.all(Array.from({ length: 8 }, () => ensureDefaultAppointmentReminder()))

  const seededRows = await db.all(`
    SELECT id, name, system_key
    FROM appointment_reminders
    WHERE system_key = 'default_one_day_before'
  `)
  assert.equal(seededRows.length, 1)
  assert.equal(seededRows[0].name, '1 día antes')
})

test('los recordatorios manuales idénticos siguen permitidos', async () => {
  await db.run('DELETE FROM appointment_reminders')

  const input = {
    name: 'Recordatorio manual repetido',
    messageType: 'reminder',
    offsetValue: 1,
    offsetUnit: 'days',
    smartEnabled: true
  }
  const first = await createAppointmentReminder(input)
  const second = await createAppointmentReminder(input)

  assert.notEqual(first.id, second.id)
  const rows = await db.all(`
    SELECT id, system_key
    FROM appointment_reminders
    WHERE name = 'Recordatorio manual repetido'
  `)
  assert.equal(rows.length, 2)
  assert.equal(rows.every(row => row.system_key === null), true)
})
