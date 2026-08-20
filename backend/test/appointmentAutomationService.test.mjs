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

test('los dos disparadores de cita filtran por el origen canónico del agendado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_appt_origin_${suffix}`
  const appointmentId = `appointment_appt_origin_${suffix}`
  const bookedAutomationId = `automation_appt_origin_booked_${suffix}`
  const statusAutomationId = `automation_appt_origin_status_${suffix}`
  const adminAutomationId = `automation_appt_origin_admin_${suffix}`
  const automationIds = [bookedAutomationId, statusAutomationId, adminAutomationId]
  const flowFor = (trigger) => ({
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [trigger] }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [{ id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }],
    settings: { allowReentry: false, preventDuplicateActiveEnrollment: true }
  })

  const automations = [
    {
      id: bookedAutomationId,
      name: 'Cita pública agendada',
      flow: flowFor({
        id: 'trigger-booked-public',
        type: 'trigger-appointment-booked',
        config: {
          filters: [{ field: 'booking_origin', match: 'is', value: 'public_calendar' }]
        }
      })
    },
    {
      id: statusAutomationId,
      name: 'Cita pública confirmada',
      flow: flowFor({
        id: 'trigger-status-public',
        type: 'trigger-appointment-status',
        config: {
          status: 'confirmed',
          filters: [{ field: 'booking_origin', match: 'is', value: 'public_calendar' }]
        }
      })
    },
    {
      id: adminAutomationId,
      name: 'Cita admin agendada',
      flow: flowFor({
        id: 'trigger-booked-admin',
        type: 'trigger-appointment-booked',
        config: {
          filters: [{ field: 'booking_origin', match: 'is', value: 'admin' }]
        }
      })
    }
  ]

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto calendario público', 'Contacto', '{}')`,
      [contactId, `+521${Date.now().toString().slice(-10)}`]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, booking_origin
       ) VALUES (?, 'calendar-origin', ?, 'Consulta pública', 'confirmed', 'confirmed', ?, ?, 'public_calendar')`,
      [appointmentId, contactId, '2026-09-20T18:00:00.000Z', '2026-09-20T19:00:00.000Z']
    )
    for (const automation of automations) {
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automation.id, automation.name, JSON.stringify(automation.flow), JSON.stringify(automation.flow)]
      )
    }

    await dispatchAppointmentCreatedAutomations({
      id: appointmentId,
      contactId,
      calendarId: 'calendar-origin',
      appointmentStatus: 'confirmed',
      status: 'confirmed',
      bookingOrigin: 'public_calendar'
    })

    const enrollments = await db.all(
      `SELECT automation_id, status
       FROM automation_enrollments
       WHERE contact_id = ? AND automation_id IN (?, ?, ?)
       ORDER BY automation_id`,
      [contactId, ...automationIds]
    )
    assert.deepEqual(
      enrollments.map(row => row.automation_id).sort(),
      [bookedAutomationId, statusAutomationId].sort()
    )
    assert.ok(enrollments.every(row => row.status === 'completed'))
  } finally {
    for (const automationId of automationIds) {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    }
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('una cita de Modo test valida automatizaciones sin crear inscripciones ni efectos permanentes', async () => {
  const suffix = randomUUID()
  const contactId = `contact_appt_automation_test_${suffix}`
  const appointmentId = `appointment_appt_automation_test_${suffix}`
  const automationId = `automation_appt_automation_test_${suffix}`
  const runId = `session_${suffix}`
  const effectId = `catfx_${suffix}`
  let userId = ''
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [{
            id: 'trigger-booked-test',
            type: 'trigger-appointment-booked',
            config: {}
          }]
        }
      },
      // En vivo este paso mutaría el contacto. El preview de Modo test sólo
      // valida que el nodo sea utilizable; jamás lo ejecuta.
      {
        id: 'tag-contact',
        type: 'action-contact-tag',
        label: 'Etiquetar contacto',
        config: { tagAction: 'add', tagId: `tag_test_${suffix}`, tagName: 'No debe aplicarse' }
      }
    ],
    edges: [{ id: 'edge-start-tag', sourceNodeId: 'start', targetNodeId: 'tag-contact' }],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: false }
  }

  try {
    const userResult = await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active)
       VALUES (?, 'test-hash', 'Dueño de prueba', 1)`,
      [`appointment-automation-${suffix}@example.com`]
    )
    userId = String(userResult.lastID || (await db.get(
      'SELECT id FROM users WHERE username = ?',
      [`appointment-automation-${suffix}@example.com`]
    ))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields, tags)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, 'Contacto Prueba', 'Contacto', '{}', '[]']
    )
    await db.run(`
      INSERT INTO conversational_agent_test_runs (
        id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
      ) VALUES (?, ?, ?, ?, '{}', 'active', ?)
    `, [runId, `agent_${suffix}`, userId, contactId, '2099-06-20T18:05:00.000Z'])
    await db.run(`
      INSERT INTO conversational_agent_test_effects (
        id, run_id, message_id, effect_type, request_hash, status, payload_json
      ) VALUES (?, ?, ?, 'appointment', 'hash', 'processing', '{}')
    `, [effectId, runId, `message_${suffix}`])
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, is_test, test_run_id, test_effect_id, test_expires_at
       ) VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?, 1, ?, ?, ?)`,
      [
        appointmentId,
        'calendar-test',
        contactId,
        '[PRUEBA] Consulta',
        '2026-06-20T18:00:00.000Z',
        '2026-06-20T19:00:00.000Z',
        runId,
        effectId,
        '2026-06-20T18:05:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test aislado de cita', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const result = await dispatchAppointmentCreatedAutomations({
      id: appointmentId,
      contactId,
      calendarId: 'calendar-test',
      appointmentStatus: 'confirmed',
      status: 'confirmed',
      isTest: true,
      testRunId: runId,
      testEffectId: effectId
    })

    assert.equal(result.booked.dispatched, false)
    assert.equal(result.booked.executed, true)
    assert.equal(result.booked.execution.matchedCount, 1)
    assert.equal(result.booked.execution.matched[0].name, 'Test aislado de cita')
    assert.equal(result.booked.execution.simulatedActionCount, 1)
    assert.equal(
      Number((await db.get(
        'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )).total),
      0
    )
    assert.equal((await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])).tags, '[]')
  } finally {
    await db.run('DELETE FROM conversational_appointment_test_automation_receipts WHERE test_effect_id = ?', [effectId]).catch(() => {})
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [effectId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})
