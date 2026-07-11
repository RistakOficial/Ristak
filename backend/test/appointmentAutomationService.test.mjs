import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { dispatchAppointmentCreatedAutomations } from '../src/services/appointmentAutomationService.js'

test('crear una cita dispara la automatización de cita agendada', async () => {
  const suffix = randomUUID()
  const contactId = `contact_appt_automation_${suffix}`
  const appointmentId = `appointment_appt_automation_${suffix}`
  const automationId = `automation_appt_automation_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [{
            id: 'trigger-booked',
            type: 'trigger-appointment-booked',
            config: {}
          }]
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [{ id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }],
    settings: { allowReentry: false, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?)`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, 'Contacto Cita', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?)`,
      [appointmentId, 'calendar-test', contactId, 'Consulta', '2026-06-20T18:00:00.000Z', '2026-06-20T19:00:00.000Z']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test cita agendada', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const result = await dispatchAppointmentCreatedAutomations({
      id: appointmentId,
      contactId,
      calendarId: 'calendar-test',
      appointmentStatus: 'confirmed',
      status: 'confirmed'
    })

    assert.equal(result.booked.dispatched, true)
    const enrollment = await db.get(
      'SELECT status, current_node_id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.deepEqual(enrollment, { status: 'completed', current_node_id: 'done' })
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})
