import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createAppointmentReminder,
  ensureDefaultAppointmentReminder,
  updateAppointmentReminder
} from '../src/services/appointmentRemindersService.js'

test('el arranque concurrente crea una sola vez el recordatorio predeterminado', async () => {
  await db.run("DELETE FROM app_config WHERE config_key = 'appointment_reminders_seeded'")
  await db.run('DELETE FROM appointment_reminders')

  await Promise.all(Array.from({ length: 8 }, () => ensureDefaultAppointmentReminder()))

  const seededRows = await db.all(`
    SELECT id, name, system_key, enabled, message_type, timing_anchor,
      offset_value, offset_unit, template_name
    FROM appointment_reminders
    WHERE system_key = 'default_one_day_before'
  `)
  assert.equal(seededRows.length, 1)
  assert.equal(seededRows[0].name, 'Confirmación 1 día antes')
  assert.equal(seededRows[0].enabled, 0)
  assert.equal(seededRows[0].message_type, 'confirmation')
  assert.equal(seededRows[0].timing_anchor, 'before_appointment')
  assert.equal(seededRows[0].offset_value, 1)
  assert.equal(seededRows[0].offset_unit, 'days')
  assert.equal(seededRows[0].template_name, 'confirmacion_cita_dia_anterior')
})

test('un aviso al agendar nunca conserva la plantilla predeterminada del día anterior', async () => {
  await db.run('DELETE FROM appointment_reminders')
  const confirmationTemplate = await db.get(`
    SELECT id, name
    FROM whatsapp_message_templates
    WHERE name = 'confirmacion_cita_dia_anterior' AND language = 'es_MX'
  `)
  const noticeTemplate = await db.get(`
    SELECT id, name
    FROM whatsapp_message_templates
    WHERE name = 'cita_programada' AND language = 'es_MX'
  `)
  assert.ok(confirmationTemplate?.id)
  assert.ok(noticeTemplate?.id)

  const reminder = await createAppointmentReminder({
    name: 'Confirmación inmediata',
    enabled: false,
    messageType: 'confirmation',
    timingAnchor: 'after_booking',
    offsetValue: 0,
    offsetUnit: 'minutes',
    templateId: confirmationTemplate.id,
    templateName: confirmationTemplate.name
  })

  assert.equal(reminder.templateId, noticeTemplate.id)
  assert.equal(reminder.templateName, 'cita_programada')

  // Simula la fila incongruente que existía antes de este arreglo. El ensure de
  // arranque debe repararla aunque la cuenta ya haya terminado su seed inicial.
  await db.run(`
    UPDATE appointment_reminders
    SET template_id = ?, template_name = ?
    WHERE id = ?
  `, [confirmationTemplate.id, confirmationTemplate.name, reminder.id])
  await db.run(`
    INSERT INTO app_config (config_key, config_value, updated_at)
    VALUES ('appointment_reminders_seeded', '1', CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET config_value = '1', updated_at = CURRENT_TIMESTAMP
  `)

  await ensureDefaultAppointmentReminder()

  const repaired = await db.get(
    'SELECT template_id, template_name, message_text FROM appointment_reminders WHERE id = ?',
    [reminder.id]
  )
  assert.equal(repaired.template_id, noticeTemplate.id)
  assert.equal(repaired.template_name, 'cita_programada')
  assert.doesNotMatch(repaired.message_text || '', /mañana|dentro de 1 día/i)
})

test('bloquea recordatorios manuales configurados para el mismo momento', async () => {
  await db.run('DELETE FROM appointment_reminders')

  const input = {
    name: 'Recordatorio manual',
    messageType: 'reminder',
    offsetValue: 1,
    offsetUnit: 'days',
    smartEnabled: true
  }
  const first = await createAppointmentReminder(input)

  await assert.rejects(
    () => createAppointmentReminder({ ...input, name: 'Otro texto, mismo momento' }),
    error => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'appointment_reminder_schedule_conflict')
      assert.equal(error.conflict.id, first.id)
      assert.equal(error.conflict.label, '1 día antes')
      return true
    }
  )

  const rows = await db.all('SELECT id, system_key, schedule_key FROM appointment_reminders')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].system_key, null)
  assert.equal(rows[0].schedule_key, 'before_appointment:86400000')
})

test('normaliza unidades equivalentes y protege también las actualizaciones', async () => {
  await db.run('DELETE FROM appointment_reminders')

  const oneHour = await createAppointmentReminder({
    name: 'Una hora antes',
    timingAnchor: 'before_appointment',
    offsetValue: 1,
    offsetUnit: 'hours'
  })
  const threeHours = await createAppointmentReminder({
    name: 'Tres horas antes',
    timingAnchor: 'before_appointment',
    offsetValue: 3,
    offsetUnit: 'hours'
  })

  await assert.rejects(
    () => updateAppointmentReminder(threeHours.id, { offsetValue: 60, offsetUnit: 'minutes' }),
    error => {
      assert.equal(error.status, 409)
      assert.equal(error.conflict.id, oneHour.id)
      return true
    }
  )

  const unchanged = await db.get('SELECT offset_value, offset_unit FROM appointment_reminders WHERE id = ?', [threeHours.id])
  assert.equal(unchanged.offset_value, 3)
  assert.equal(unchanged.offset_unit, 'hours')
})

test('la restricción atómica deja una sola alta cuando varias pestañas guardan a la vez', async () => {
  await db.run('DELETE FROM appointment_reminders')

  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (
    createAppointmentReminder({
      name: `Concurrente ${index}`,
      timingAnchor: 'after_booking',
      offsetValue: 15,
      offsetUnit: 'minutes'
    })
  )))

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => (
    result.status === 'rejected' &&
    result.reason?.code === 'appointment_reminder_schedule_conflict'
  )).length, 7)

  const rows = await db.all("SELECT id FROM appointment_reminders WHERE schedule_key = 'after_booking:900000'")
  assert.equal(rows.length, 1)
})
