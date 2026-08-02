import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { enrollContactManually } from '../src/services/automationEngine.js'

test('Marcar asistencia actualiza la cita exacta y registra una señal idempotente', async () => {
  const suffix = randomUUID()
  const automationId = `automation_attendance_${suffix}`
  const contactId = `contact_attendance_${suffix}`
  const selectedCalendarId = `calendar_attendance_${suffix}`
  const otherCalendarId = `calendar_attendance_other_${suffix}`
  const selectedAppointmentId = `appointment_attendance_${suffix}`
  const otherAppointmentId = `appointment_attendance_other_${suffix}`
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'mark-attendance',
        type: 'action-appointment-upsert',
        label: 'Crear / actualizar cita',
        config: {
          mode: 'mark_attendance',
          calendar: selectedCalendarId
        }
      }
    ],
    edges: [
      {
        id: 'edge-start-attendance',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: 'mark-attendance',
        targetHandle: 'in'
      }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+521${Date.now().toString().slice(-10)}`,
        `attendance-${suffix}@test.com`,
        'Contacto Asistencia',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO calendars (
         id, name, event_title, is_active, slot_duration, slot_duration_unit,
         source, open_hours, availability_schedule_configured
       ) VALUES (?, ?, 'Consulta', 1, 60, 'mins', 'ristak', '[]', 0),
                (?, ?, 'Consulta alterna', 1, 60, 'mins', 'ristak', '[]', 0)`,
      [selectedCalendarId, 'Calendario atribuido', otherCalendarId, 'Otro calendario']
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, date_added, date_updated
       ) VALUES (?, ?, ?, 'Consulta correcta', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                (?, ?, ?, 'Consulta de otro calendario', 'confirmed', 'confirmed', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        selectedAppointmentId,
        selectedCalendarId,
        contactId,
        start.toISOString(),
        end.toISOString(),
        otherAppointmentId,
        otherCalendarId,
        contactId,
        start.toISOString(),
        end.toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Test marcar asistencia', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    const firstEnrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(firstEnrollment.status, 'completed')

    const selected = await db.get(
      'SELECT status, appointment_status FROM appointments WHERE id = ?',
      [selectedAppointmentId]
    )
    const other = await db.get(
      'SELECT status, appointment_status FROM appointments WHERE id = ?',
      [otherAppointmentId]
    )
    assert.equal(selected.status, 'showed')
    assert.equal(selected.appointment_status, 'showed')
    assert.equal(other.status, 'confirmed')
    assert.equal(other.appointment_status, 'confirmed')

    const signal = await db.get(
      `SELECT contact_id, appointment_id, source
       FROM appointment_attendance_signals
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, selectedAppointmentId]
    )
    assert.deepEqual(signal, {
      contact_id: contactId,
      appointment_id: selectedAppointmentId,
      source: 'automation_mark_attendance'
    })

    const secondEnrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(secondEnrollment.status, 'completed')
    const signalCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM appointment_attendance_signals
       WHERE contact_id = ? AND appointment_id = ?`,
      [contactId, selectedAppointmentId]
    )
    assert.equal(Number(signalCount.total), 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [selectedAppointmentId, otherAppointmentId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [selectedCalendarId, otherCalendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
