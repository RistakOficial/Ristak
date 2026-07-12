import test from 'node:test'
import assert from 'node:assert/strict'

import { db, databaseReady } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  createLocalAppointment,
  createConversationalTestHighLevelAppointment,
  getLocalAppointment,
  normalizeAppointmentParticipants,
  recordConversationalTestAppointmentProviderReceipt,
  resolveExistingHighLevelContactForTestAppointment
} from '../src/services/localCalendarService.js'
import { buildGoogleEventPayload, googleTestEventIdForEffect } from '../src/services/googleCalendarService.js'
import {
  appendHighLevelTestAppointmentMarker,
  createAppointment as createHighLevelAppointment,
  findHighLevelTestAppointmentByCommand,
  highLevelTestAppointmentMarker
} from '../src/services/highlevelCalendarService.js'
import { createAppointment } from '../src/controllers/calendarsController.js'
import {
  cleanupExpiredConversationalTestAppointments,
  cleanupConversationalTestAppointment,
  setConversationalAppointmentTestCleanupDependenciesForTests
} from '../src/services/conversationalAppointmentTestCleanupService.js'
import { buildConversationalAgentTestRuntimeEventContext } from '../src/services/conversationalAgentTestService.js'

await databaseReady
await runVersionedMigrations()

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

async function deleteFixture({ appointmentId, effectId, runId, contactId, extraContactId = null, agentId = null }) {
  await db.run('DELETE FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId]).catch(() => {})
  await db.run('DELETE FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId]).catch(() => {})
  await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId]).catch(() => {})
  await db.run('DELETE FROM conversational_appointment_test_provider_receipts WHERE test_effect_id = ?', [effectId]).catch(() => {})
  await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [effectId]).catch(() => {})
  await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => {})
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  if (extraContactId) await db.run('DELETE FROM contacts WHERE id = ?', [extraContactId]).catch(() => {})
  if (agentId) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => {})
}

test('normaliza roles, limita primarios y conserva invitados distintos', () => {
  const result = normalizeAppointmentParticipants([
    { role: 'requester', contactId: 'contact_1', name: 'Raúl' },
    { role: 'requester', contactId: 'contact_2', name: 'Duplicado' },
    { role: 'primary_attendee', name: 'Paty', email: 'PATY@example.com' },
    { role: 'guest', name: 'Invitado', email: 'guest@example.com' },
    { role: 'guest', name: 'Invitado', email: 'guest@example.com' },
    { role: 'invalid', name: 'No entra' }
  ])

  assert.deepEqual(result.map(participant => participant.role), [
    'requester',
    'primary_attendee',
    'guest'
  ])
  assert.equal(result[1].email, 'paty@example.com')
  assert.equal(result[2].position, 0)
})

test('Google deduplica invitados por correo y marca el evento de prueba', () => {
  const payload = buildGoogleEventPayload({
    id: 'appointment_test_1',
    calendarId: 'calendar_1',
    title: 'Consulta',
    startTime: '2026-07-12T16:00:00.000Z',
    endTime: '2026-07-12T17:00:00.000Z',
    isTest: true,
    testRunId: 'run_test_1',
    testEffectId: 'effect_test_1',
    testExpiresAt: '2026-07-12T16:05:00.000Z',
    participants: [
      { role: 'requester', name: 'Raúl', email: 'raul@example.com' },
      { role: 'primary_attendee', name: 'Raúl duplicado', email: 'RAUL@example.com' },
      { role: 'guest', name: 'Paty', email: 'paty@example.com' }
    ]
  }, 'America/Ciudad_Juarez')

  assert.deepEqual(payload.attendees, [
    { email: 'raul@example.com', displayName: 'Raúl' },
    { email: 'paty@example.com', displayName: 'Paty' }
  ])
  assert.equal(payload.extendedProperties.private.source, 'ristak_test')
  assert.equal(payload.extendedProperties.private.ristakTestEffectId, 'effect_test_1')
})

test('Google usa un ID client-side determinista y válido para reintentar sin duplicar', () => {
  const first = googleTestEventIdForEffect('effect_test_deterministic_1')
  const second = googleTestEventIdForEffect('effect_test_deterministic_1')
  assert.equal(first, second)
  assert.match(first, /^[0-9a-v]{5,1024}$/)
})

test('HighLevel sólo reconcilia por marcador, calendario, contacto y horas exactas', () => {
  const marker = highLevelTestAppointmentMarker('effect_highlevel_exact')
  const command = {
    marker,
    calendarId: 'ghl_calendar_1',
    contactId: 'ghl_contact_1',
    startTime: '2026-07-12T16:00:00.000Z',
    endTime: '2026-07-12T17:00:00.000Z'
  }
  const exact = {
    id: 'ghl_event_exact',
    description: `Consulta\n${marker}`,
    calendarId: command.calendarId,
    contactId: command.contactId,
    startTime: command.startTime,
    endTime: command.endTime
  }
  assert.equal(findHighLevelTestAppointmentByCommand([
    { ...exact, id: 'wrong-contact', contactId: 'other' },
    { ...exact, id: 'wrong-time', endTime: '2026-07-12T17:01:00.000Z' },
    exact
  ], command)?.id, exact.id)
  assert.equal(findHighLevelTestAppointmentByCommand([
    { ...exact, description: 'Sin marcador' }
  ], command), null)
})

test('HighLevel activa avisos y adjunta marcador únicamente para citas de Modo test', async () => {
  const previousFetch = global.fetch
  const bodies = []
  global.fetch = async (_url, options = {}) => {
    bodies.push(JSON.parse(options.body || '{}'))
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'ghl_test_created' })
    }
  }
  try {
    await createHighLevelAppointment({
      calendarId: 'ghl_calendar_notify',
      contactId: 'ghl_contact_notify',
      assignedUserId: 'ghl_user_notify',
      title: 'Prueba',
      notes: 'Mensaje visible',
      startTime: '2026-07-12T16:00:00.000Z',
      endTime: '2026-07-12T17:00:00.000Z',
      isTest: true,
      testEffectId: 'effect_notify'
    }, 'location_notify', 'token_notify')
    assert.equal(bodies[0].toNotify, true)
    assert.match(bodies[0].description, /\[RISTAK-TEST:[0-9a-f]{64}\]/)

    bodies.length = 0
    await createHighLevelAppointment({
      calendarId: 'ghl_calendar_live',
      contactId: 'ghl_contact_live',
      assignedUserId: 'ghl_user_live',
      title: 'Real',
      notes: 'Sin marcador',
      startTime: '2026-07-12T16:00:00.000Z',
      endTime: '2026-07-12T17:00:00.000Z'
    }, 'location_live', 'token_live')
    assert.equal(bodies[0].toNotify, false)
    assert.equal(bodies[0].description, 'Sin marcador')
  } finally {
    global.fetch = previousFetch
  }
})

test('Modo test reutiliza un contacto HighLevel exacto sin crearlo ni ligarlo permanentemente', async () => {
  const contactId = `rstk_contact_test_highlevel_${uniqueId('identity')}`
  let createCalls = 0
  const searches = []
  const client = {
    async searchContacts(query) {
      searches.push(query)
      return {
        contacts: [{
          id: 'ghl_contact_exact_test',
          email: 'paty.test@example.com',
          phone: '+526567426612'
        }]
      }
    },
    async createContact() {
      createCalls += 1
      return { contact: { id: 'ghl_contact_created_forbidden' } }
    }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, phone, created_at, updated_at)
       VALUES (?, 'Paty Prueba', 'paty.test@example.com', '+526567426612', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    const remoteId = await resolveExistingHighLevelContactForTestAppointment(client, { contactId })
    assert.equal(remoteId, 'ghl_contact_exact_test')
    assert.equal(createCalls, 0)
    assert.equal(searches.length, 2)
    assert.equal(
      (await db.get('SELECT ghl_contact_id FROM contacts WHERE id = ?', [contactId])).ghl_contact_id,
      null
    )
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('Modo test falla cerrado si el contacto no existe en HighLevel y jamás llama createContact', async () => {
  const contactId = `rstk_contact_test_highlevel_missing_${uniqueId('identity')}`
  let createCalls = 0
  const client = {
    async searchContacts() { return { contacts: [] } },
    async createContact() {
      createCalls += 1
      return { contact: { id: 'ghl_contact_created_forbidden' } }
    }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, created_at, updated_at)
       VALUES (?, 'Contacto sin GHL', 'missing-ghl@example.test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await assert.rejects(
      resolveExistingHighLevelContactForTestAppointment(client, { contactId }),
      (error) => error?.code === 'test_appointment_highlevel_contact_not_synced' && error?.status === 409
    )
    assert.equal(createCalls, 0)
    assert.equal(
      (await db.get('SELECT ghl_contact_id FROM contacts WHERE id = ?', [contactId])).ghl_contact_id,
      null
    )
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('la API normal rechaza marcas test aunque el cliente intente mandarlas', async () => {
  const req = {
    body: {
      calendarId: 'calendar_fake',
      contactId: 'contact_fake',
      startTime: '2026-07-12T16:00:00.000Z',
      endTime: '2026-07-12T17:00:00.000Z',
      isTest: true,
      testRunId: 'run_fake',
      testEffectId: 'effect_fake',
      testExpiresAt: '2026-07-12T16:05:00.000Z'
    }
  }
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
  await createAppointment(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body?.code, 'test_appointment_internal_only')
})

test('crea participantes con snapshot y limpia exactamente la cita de prueba vencida', async () => {
  const contactId = uniqueId('contact_test_appt')
  const guestContactId = uniqueId('contact_guest_appt')
  const runId = uniqueId('test_run')
  const effectId = uniqueId('test_effect')
  const agentId = uniqueId('agent_test')
  const appointmentId = uniqueId('appointment_test')
  const reminderSendId = uniqueId('reminder_send')
  const confirmationId = uniqueId('confirmation')

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, email, full_name, first_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, `+521${Date.now().toString().slice(-10)}`, `${contactId}@example.com`, 'Paty Jiménez', 'Paty'])
    await db.run(`
      INSERT INTO contacts (id, email, full_name, first_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [guestContactId, `${guestContactId}@example.com`, 'Luis Invitado', 'Luis'])
    await db.run(`
      INSERT INTO conversational_agents (id, name, capabilities_config)
      VALUES (?, 'Agente de prueba', ?)
    `, [agentId, JSON.stringify({ schemaVersion: 2, testMode: { enabled: true }, items: [] })])
    await db.run(`
      INSERT INTO conversational_agent_test_runs (
        id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
      ) VALUES (?, ?, '1', ?, ?, 'active', ?)
    `, [runId, agentId, contactId, JSON.stringify({ enabled: true, scheduleAppointment: true }), new Date(Date.now() + 60_000).toISOString()])
    const calendarId = uniqueId('calendar')
    const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const participants = [
      { role: 'requester', contactId },
      { role: 'primary_attendee', name: 'Paty Jiménez', email: `${contactId}@example.com` },
      { role: 'guest', contactId: guestContactId, relation: 'Hijo' }
    ]
    await db.run(`
      INSERT INTO conversational_agent_test_effects (
        id, run_id, message_id, effect_type, request_hash, status, entity_id,
        payload_json, cleanup_status, claim_token, lease_until_at
      ) VALUES (?, ?, ?, 'appointment', 'hash', 'processing', NULL, ?, 'pending', 'claim-test', ?)
    `, [
      effectId,
      runId,
      uniqueId('message'),
      JSON.stringify({ calendarId, startTime, endTime, bookingOwner: 'ai', participants }),
      new Date(Date.now() + 60_000).toISOString()
    ])

    const appointment = await createLocalAppointment({
      id: appointmentId,
      calendarId,
      contactId,
      title: 'Consulta de prueba',
      startTime,
      endTime,
      isTest: true,
      testRunId: runId,
      testEffectId: effectId,
      testExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      participants
    })
    await db.run(`
      UPDATE conversational_agent_test_effects
      SET status = 'recorded', entity_id = ?, claim_token = NULL, lease_until_at = NULL
      WHERE id = ?
    `, [appointmentId, effectId])

    assert.equal(appointment.isTest, true)
    assert.equal(appointment.participants.length, 3)
    assert.equal(appointment.participants[0].name, 'Paty Jiménez')
    assert.equal(appointment.participants[2].name, 'Luis Invitado')
    assert.ok((await db.get('SELECT appointment_date FROM contacts WHERE id = ?', [guestContactId])).appointment_date)

    await assert.rejects(
      cleanupConversationalTestAppointment({ appointmentId, testEffectId: uniqueId('wrong_effect') }),
      error => error?.code === 'test_cleanup_ledger_required'
    )
    assert.ok(await getLocalAppointment(appointmentId))

    await db.run(`
      INSERT INTO appointment_reminder_sends (
        id, reminder_id, appointment_id, contact_id, status, message_type
      ) VALUES (?, ?, ?, ?, 'sent', 'confirmation')
    `, [reminderSendId, uniqueId('reminder'), appointmentId, contactId])
    await db.run(`
      INSERT INTO appointment_confirmation_windows (
        id, contact_id, appointment_id, reminder_send_id, status,
        accumulated_messages, last_message_at
      ) VALUES (?, ?, ?, ?, 'waiting', '[]', CURRENT_TIMESTAMP)
    `, [confirmationId, contactId, appointmentId, reminderSendId])

    const result = await cleanupConversationalTestAppointment({ appointmentId, testEffectId: effectId })
    assert.equal(result.status, 'cleaned')
    assert.equal(await getLocalAppointment(appointmentId), null)
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM appointment_participants WHERE appointment_id = ?', [appointmentId])).total, 0)
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM appointment_reminder_sends WHERE appointment_id = ?', [appointmentId])).total, 0)
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM appointment_confirmation_windows WHERE appointment_id = ?', [appointmentId])).total, 0)
    const effect = await db.get(
      'SELECT status, cleanup_status, payload_json FROM conversational_agent_test_effects WHERE id = ?',
      [effectId]
    )
    const effectPayload = JSON.parse(effect.payload_json)
    assert.equal(effect.status, 'cleaned')
    assert.equal(effect.cleanup_status, 'cleaned')
    assert.equal(effectPayload.appointmentCreated, false)
    assert.equal(effectPayload.appointmentCleaned, true)
    const runtimeContext = await buildConversationalAgentTestRuntimeEventContext({
      runContext: { id: runId, requestedByUserId: '1' }
    })
    assert.doesNotMatch(runtimeContext, /cita temporal.*ya fue creada/i)
    await db.run(
      `UPDATE conversational_agent_test_effects
       SET status = 'recorded', payload_json = ?
       WHERE id = ?`,
      [JSON.stringify({ ...effectPayload, appointmentCreated: true, appointmentCleaned: false }), effectId]
    )
    const legacyRuntimeContext = await buildConversationalAgentTestRuntimeEventContext({
      runContext: { id: runId, requestedByUserId: '1' }
    })
    assert.equal(legacyRuntimeContext, '')
    assert.equal((await db.get('SELECT appointment_date FROM contacts WHERE id = ?', [guestContactId])).appointment_date, null)
  } finally {
    await deleteFixture({ appointmentId, effectId, runId, contactId, extraContactId: guestContactId, agentId })
  }
})

test('la limpieza se niega a tocar una cita real aunque reciba ids válidos', async () => {
  const contactId = uniqueId('contact_real_appt')
  const appointmentId = uniqueId('appointment_real')
  const effectId = uniqueId('effect_fake')

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto real']
    )
    const appointment = await createLocalAppointment({
      id: appointmentId,
      calendarId: uniqueId('calendar'),
      contactId,
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    })

    await assert.rejects(
      cleanupConversationalTestAppointment({ appointmentId, testEffectId: effectId }),
      error => error?.code === 'test_cleanup_ledger_required'
    )
    assert.ok(await getLocalAppointment(appointmentId))
  } finally {
    await deleteFixture({ appointmentId, effectId, runId: uniqueId('none'), contactId })
  }
})

test('una bandera is_test falsificada no autoriza creación ni cleanup', async () => {
  const contactId = uniqueId('contact_forged_test')
  const appointmentId = uniqueId('appointment_forged_test')
  const effectId = uniqueId('effect_forged_test')
  const runId = uniqueId('run_forged_test')

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto protegido']
    )
    await assert.rejects(
      createLocalAppointment({
        id: appointmentId,
        calendarId: uniqueId('calendar'),
        contactId,
        startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        isTest: true,
        testRunId: runId,
        testEffectId: effectId,
        testExpiresAt: new Date(Date.now() - 1_000).toISOString()
      }),
      error => error?.code === 'test_appointment_effect_required'
    )
    assert.equal(await getLocalAppointment(appointmentId), null)

    // Simula una fila legacy/tampered: incluso con is_test=1 el cleanup debe
    // negarse si no existe el ledger server-side.
    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, is_test, test_run_id, test_effect_id, test_expires_at
      ) VALUES (?, ?, ?, 'No borrar', 'confirmed', 'confirmed', ?, ?, 1, ?, ?, ?)
    `, [
      appointmentId,
      uniqueId('calendar'),
      contactId,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      runId,
      effectId,
      new Date(Date.now() - 1_000).toISOString()
    ])
    await assert.rejects(
      cleanupConversationalTestAppointment({ appointmentId, testEffectId: effectId }),
      error => error?.code === 'test_cleanup_ledger_required'
    )
    assert.ok(await getLocalAppointment(appointmentId))
  } finally {
    await deleteFixture({ appointmentId, effectId, runId, contactId })
  }
})

test('el recibo externo permite limpiar Google aunque se pierda la fila local', async () => {
  const contactId = uniqueId('contact_receipt_test')
  const appointmentId = uniqueId('appointment_receipt_test')
  const effectId = uniqueId('effect_receipt_test')
  const runId = uniqueId('run_receipt_test')
  const agentId = uniqueId('agent_receipt_test')
  const calendarId = uniqueId('calendar_receipt_test')
  const externalId = uniqueId('google_event_test')
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  const expiresAt = new Date(Date.now() - 1_000).toISOString()
  const participants = [
    { role: 'requester', contactId },
    { role: 'primary_attendee', contactId }
  ]
  let deletedExternalId = ''

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto con recibo']
    )
    await db.run(
      'INSERT INTO conversational_agents (id, name, capabilities_config) VALUES (?, ?, ?)',
      [agentId, 'Agente recibo', JSON.stringify({ schemaVersion: 2, testMode: { enabled: true }, items: [] })]
    )
    await db.run(`
      INSERT INTO conversational_agent_test_runs (
        id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
      ) VALUES (?, ?, '1', ?, ?, 'active', ?)
    `, [runId, agentId, contactId, JSON.stringify({ enabled: true, scheduleAppointment: true }), new Date(Date.now() + 60_000).toISOString()])
    await db.run(`
      INSERT INTO conversational_agent_test_effects (
        id, run_id, message_id, effect_type, request_hash, status, payload_json,
        cleanup_status, claim_token, lease_until_at
      ) VALUES (?, ?, ?, 'appointment', 'hash', 'processing', ?, 'pending', 'claim-receipt', ?)
    `, [
      effectId,
      runId,
      uniqueId('message'),
      JSON.stringify({ calendarId, startTime, endTime, bookingOwner: 'ai', participants }),
      new Date(Date.now() + 60_000).toISOString()
    ])
    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      contactId,
      startTime,
      endTime,
      isTest: true,
      testRunId: runId,
      testEffectId: effectId,
      testExpiresAt: expiresAt,
      participants
    })
    await recordConversationalTestAppointmentProviderReceipt({
      appointmentId,
      testEffectId: effectId,
      testRunId: runId,
      provider: 'google',
      externalId,
      calendarId,
      cleanupDueAt: expiresAt
    })
    await db.run(`
      UPDATE conversational_agent_test_effects
      SET status = 'recorded', entity_id = ?, claim_token = NULL, lease_until_at = NULL
      WHERE id = ?
    `, [appointmentId, effectId])
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])

    setConversationalAppointmentTestCleanupDependenciesForTests({
      deleteGoogleEventForAppointment: async (appointment) => {
        deletedExternalId = appointment.googleEventId
        return { enabled: true, deleted: true }
      }
    })
    const result = await cleanupConversationalTestAppointment({ appointmentId, testEffectId: effectId })
    assert.equal(result.status, 'cleaned')
    assert.equal(result.alreadyAbsent, true)
    assert.equal(deletedExternalId, externalId)
    assert.equal(
      (await db.get('SELECT cleanup_status FROM conversational_appointment_test_provider_receipts WHERE test_effect_id = ?', [effectId])).cleanup_status,
      'cleaned'
    )
  } finally {
    setConversationalAppointmentTestCleanupDependenciesForTests()
    await deleteFixture({ appointmentId, effectId, runId, contactId, agentId })
  }
})

test('cleanup reconcilia un POST HighLevel incierto por marcador antes de borrar', async () => {
  const contactId = uniqueId('contact_hl_unknown')
  const appointmentId = uniqueId('appointment_hl_unknown')
  const effectId = uniqueId('effect_hl_unknown')
  const runId = uniqueId('run_hl_unknown')
  const agentId = uniqueId('agent_hl_unknown')
  const calendarId = uniqueId('calendar_hl_unknown')
  const remoteCalendarId = uniqueId('ghl_calendar')
  const remoteContactId = uniqueId('ghl_contact')
  const locationId = uniqueId('ghl_location')
  const remoteId = uniqueId('ghl_event')
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  const expiresAt = new Date(Date.now() - 1_000).toISOString()
  const marker = highLevelTestAppointmentMarker(effectId)
  let deletedId = ''
  let reconciliations = 0

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto HighLevel incierto']
    )
    await db.run(
      'INSERT INTO conversational_agents (id, name, capabilities_config) VALUES (?, ?, ?)',
      [agentId, 'Agente HighLevel', JSON.stringify({ schemaVersion: 2, testMode: { enabled: true }, items: [] })]
    )
    await db.run(`
      INSERT INTO conversational_agent_test_runs (
        id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
      ) VALUES (?, ?, '1', ?, ?, 'active', ?)
    `, [runId, agentId, contactId, JSON.stringify({ enabled: true, scheduleAppointment: true }), new Date(Date.now() + 60_000).toISOString()])
    await db.run(`
      INSERT INTO conversational_agent_test_effects (
        id, run_id, message_id, effect_type, request_hash, status, payload_json,
        cleanup_status, claim_token, lease_until_at
      ) VALUES (?, ?, ?, 'appointment', 'hash', 'processing', ?, 'pending', 'claim-hl', ?)
    `, [
      effectId,
      runId,
      uniqueId('message'),
      JSON.stringify({
        calendarId,
        startTime,
        endTime,
        bookingOwner: 'ai',
        participants: [
          { role: 'requester', contactId },
          { role: 'primary_attendee', contactId }
        ]
      }),
      new Date(Date.now() + 60_000).toISOString()
    ])
    const appointment = await createLocalAppointment({
      id: appointmentId,
      calendarId,
      contactId,
      startTime,
      endTime,
      isTest: true,
      testRunId: runId,
      testEffectId: effectId,
      testExpiresAt: expiresAt
    })
    const previousFetch = global.fetch
    let remoteCall = 0
    global.fetch = async (_url, options = {}) => {
      remoteCall += 1
      if (remoteCall === 1 && options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ events: [] }) }
      }
      if (remoteCall === 2 && options.method === 'POST') {
        throw new Error('Request timeout después de 15000ms')
      }
      throw new Error('HighLevel no respondió durante reconciliación')
    }
    try {
      await assert.rejects(
        createConversationalTestHighLevelAppointment({
          appointment,
          appointmentData: { assignedUserId: 'ghl_user_test', notes: 'Prueba incierta' },
          locationId,
          remoteCalendarId,
          contactId: remoteContactId,
          apiToken: 'test-token'
        }),
        error => error?.code === 'test_appointment_remote_outcome_unknown'
      )
    } finally {
      global.fetch = previousFetch
    }
    const unknownReceipt = await db.get(`
      SELECT remote_status, remote_error, command_json
      FROM conversational_appointment_test_provider_receipts
      WHERE test_effect_id = ? AND provider = 'highlevel'
    `, [effectId])
    assert.equal(unknownReceipt.remote_status, 'remote_outcome_unknown')
    assert.match(unknownReceipt.remote_error, /reconcile/i)
    assert.equal(JSON.parse(unknownReceipt.command_json).marker, marker)

    const retryMethods = []
    global.fetch = async (_url, options = {}) => {
      retryMethods.push(options.method)
      return { ok: true, status: 200, json: async () => ({ events: [] }) }
    }
    try {
      await assert.rejects(
        createConversationalTestHighLevelAppointment({
          appointment,
          appointmentData: { assignedUserId: 'ghl_user_test', notes: 'Prueba incierta' },
          locationId,
          remoteCalendarId,
          contactId: remoteContactId,
          apiToken: 'test-token'
        }),
        error => error?.code === 'test_appointment_remote_outcome_unknown'
      )
      assert.deepEqual(retryMethods, ['GET'], 'un receipt incierto sólo reconcilia; jamás repite POST')
    } finally {
      global.fetch = previousFetch
    }
    await db.run(`
      UPDATE conversational_agent_test_effects
      SET status = 'recorded', entity_id = ?, claim_token = NULL, lease_until_at = NULL
      WHERE id = ?
    `, [appointmentId, effectId])
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [appointmentId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])

    setConversationalAppointmentTestCleanupDependenciesForTests({
      getHighLevelAccessToken: async () => 'test-token',
      getHighLevelCalendarEvents: async () => {
        reconciliations += 1
        return [{
          id: remoteId,
          description: appendHighLevelTestAppointmentMarker('Prueba', effectId),
          calendarId: remoteCalendarId,
          contactId: remoteContactId,
          startTime,
          endTime
        }]
      },
      deleteHighLevelEvent: async (eventId) => {
        deletedId = eventId
      }
    })

    const result = await cleanupConversationalTestAppointment({ appointmentId, testEffectId: effectId })
    assert.equal(result.status, 'cleaned')
    assert.equal(reconciliations, 1)
    assert.equal(deletedId, remoteId)
    const receipt = await db.get(`
      SELECT external_id, remote_status, cleanup_status, command_json
      FROM conversational_appointment_test_provider_receipts
      WHERE test_effect_id = ? AND provider = 'highlevel'
    `, [effectId])
    assert.equal(receipt.external_id, remoteId)
    assert.equal(receipt.remote_status, 'created')
    assert.equal(receipt.cleanup_status, 'cleaned')
    assert.equal(JSON.parse(receipt.command_json).marker, marker)
  } finally {
    setConversationalAppointmentTestCleanupDependenciesForTests()
    await deleteFixture({ appointmentId, effectId, runId, contactId, agentId })
  }
})

test('cleanup repara un efecto vencido aunque la fila local ya no exista', async () => {
  const contactId = uniqueId('contact_repair_missing')
  const appointmentId = uniqueId('appointment_repair_missing')
  const effectId = uniqueId('effect_repair_missing')
  const runId = uniqueId('run_repair_missing')
  const agentId = uniqueId('agent_repair_missing')
  const cleanupDueAt = new Date(Date.now() - 60_000).toISOString()

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto repair sin cita']
    )
    await db.run(
      'INSERT INTO conversational_agents (id, name, capabilities_config) VALUES (?, ?, ?)',
      [agentId, 'Agente repair sin cita', JSON.stringify({ schemaVersion: 2, testMode: { enabled: true }, items: [] })]
    )
    await db.run(`
      INSERT INTO conversational_agent_test_runs (
        id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
      ) VALUES (?, ?, '1', ?, '{}', 'active', ?)
    `, [runId, agentId, contactId, new Date(Date.now() + 60_000).toISOString()])
    await db.run(`
      INSERT INTO conversational_agent_test_effects (
        id, run_id, message_id, effect_type, request_hash, status, entity_id,
        payload_json, cleanup_status
      ) VALUES (?, ?, ?, 'appointment', 'repair-hash', 'recorded', ?, ?, 'pending')
    `, [
      effectId,
      runId,
      uniqueId('message_repair_missing'),
      appointmentId,
      JSON.stringify({ appointmentId, appointmentCreated: true, cleanupDueAt })
    ])

    const result = await cleanupExpiredConversationalTestAppointments({ now: new Date(), limit: 10 })
    assert.ok(result.cleaned >= 1)
    const effect = await db.get(
      'SELECT status, cleanup_status, payload_json FROM conversational_agent_test_effects WHERE id = ?',
      [effectId]
    )
    assert.equal(effect.status, 'cleaned')
    assert.equal(effect.cleanup_status, 'cleaned')
    assert.equal(JSON.parse(effect.payload_json).appointmentCreated, false)
  } finally {
    await deleteFixture({ appointmentId, effectId, runId, contactId, agentId })
  }
})
