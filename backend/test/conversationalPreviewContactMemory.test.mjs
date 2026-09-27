import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { createConversationalTools, loadConversationalAppointmentOfferDecisionContext,
  loadConversationalAppointmentSelectionProgressContext, restoreConversationalPreviewContactData } from '../src/agents/conversational/tools.js'
import { buildConversationalAppointmentPreviewScopeId, loadConversationalPreviewContactData,
  cleanupConversationalAppointmentPreviewOffers, cleanupExpiredConversationalAppointmentPreviewOffers,
  CONVERSATIONAL_PREVIEW_CONTACT_DATA_EVENT } from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { prepareConversationalAgentTestRun, recordConversationalAgentPreviewEffects,
  cleanupConversationalAgentTestRun } from '../src/services/conversationalAgentTestService.js'

await runVersionedMigrations()
const invoke = (ctx, name, args = {}) => {
  const tool = createConversationalTools(ctx).find((entry) => entry.name === name)
  assert.ok(tool, name)
  return tool.invoke(null, JSON.stringify(args))
}
const save = (ctx, values) => invoke(ctx, 'save_contact_data', {
  fullName: null, phone: null, alternatePhone: null, email: null,
  company: null, address: null, customValues: [], ...values
})

for (const virtual of [false, true]) {
  test(`datos repartidos entre turnos llegan hasta confirmar la cita; contacto ${virtual ? 'virtual' : 'persistido'}`, async () => {
    const suffix = randomUUID()
    const agentId = `agent_memory_${suffix}`
    const contactId = `contact_memory_${suffix}`
    const calendarId = `calendar_memory_${suffix}`
    const sessionId = `session_memory_${suffix}`
    const username = `memory_${suffix}`
    let userId
    const config = { id: agentId, runtimeMode: 'tool_calling_v2', capabilitiesConfig: {
      schemaVersion: 3,
      dataRequirements: { enabled: true, fields: [
        { field: 'full_name', level: 'required', scope: 'any_action' },
        { field: 'phone', level: 'required', scope: 'any_action' }
      ], updateContact: { enabled: true, policy: 'replace_placeholders' } },
      items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner: 'ai',
        allowOverlaps: false, testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false } }]
    } }
    let scope
    try {
      await db.run("INSERT INTO users (username, password_hash, full_name, is_active) VALUES (?, 'unused-test-fixture', 'Prueba memoria', 1)", [username])
      userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username])).id)
      scope = { agentId, contactId, previewScopeId: buildConversationalAppointmentPreviewScopeId({
        testSessionId: sessionId, requestedByUserId: userId, agentId
      }) }
      await db.run("INSERT INTO contacts (id, full_name, email) VALUES (?, 'Contacto de prueba', ?)", [contactId, `${suffix}@example.test`])
      await db.run("INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config) VALUES (?, 'Memoria preview', 1, 'tool_calling_v2', ?)",
        [agentId, JSON.stringify(config.capabilitiesConfig)])
      await upsertLocalCalendar({ id: calendarId, locationId: `location_${suffix}`, name: 'Agenda prueba memoria',
        source: 'ristak', slotDuration: 60, slotInterval: 60, allowBookingFor: 365, allowBookingForUnit: 'days',
        openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 10, openMinute: 0, closeHour: 12, closeMinute: 0 }] }]
      }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
      const messages = []
      const context = (content) => {
        const executionId = `preview:${randomUUID()}`
        messages.push({ id: executionId, role: 'user', content })
        return { config, agentId, contactId, dryRun: true, channel: 'whatsapp',
          previewScopeId: scope.previewScopeId, executionId, conversationMessages: [...messages], actions: [],
          virtualContact: virtual ? { id: contactId, fullName: 'Contacto de prueba' } : null }
      }
      assert.equal((await save(context('Me llamo Elena Martínez.'), { fullName: 'Elena Martínez' })).ok, true)
      assert.equal((await save(context('Mi teléfono es +526561234567.'), { phone: '+526561234567' })).ok, true)
      const profile = await invoke(context('¿Qué datos tienes?'), 'get_contact_profile')
      assert.equal(profile.contact.fullName, 'Elena Martínez')
      assert.equal(profile.contact.phone, '+526561234567')
      const timezone = await getAccountTimezone()
      const day = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
      const slot = day.plus({ days: (1 - day.weekday + 7) % 7 }).set({ hour: 10 })
      const offerCtx = context('Quiero ese lunes a las diez.')
      const offered = await invoke(offerCtx, 'offer_appointment_slot', { startTime: slot.toUTC().toISO(), appointmentId: null })
      assert.equal(offered.ok, true, JSON.stringify(offered))
      messages.push({ id: `assistant_${randomUUID()}`, role: 'assistant', content: offered.visibleReply })
      const confirmation = context('Sí, confirma esa cita.')
      let runContext
      if (!virtual) {
        runContext = await prepareConversationalAgentTestRun({ testRunId: sessionId,
          testMessageId: `message_${suffix}`, agentId, requestedByUserId: userId, contactId,
          effects: { enabled: true, scheduleAppointment: true, notifyOwner: false } })
        confirmation.executionId = runContext.executionId
      }
      await restoreConversationalPreviewContactData(confirmation)
      confirmation.appointmentOfferDecision = await loadConversationalAppointmentOfferDecisionContext({ ctx: confirmation, config })
      confirmation.appointmentSelectionProgress = await loadConversationalAppointmentSelectionProgressContext({ ctx: confirmation, config })
      const confirmed = await invoke(confirmation, 'resolve_active_appointment_offer', {
        decision: 'accept', nextPreferenceScope: null, reply: null, title: 'Consulta de prueba', notes: null,
        attendeeName: null, attendeeContext: null, primaryAttendee: null, guests: [], agreedAmount: null
      })
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
      assert.doesNotMatch(confirmed.visibleReply, /falta|me pasas|revis/i)
      assert.equal(confirmation.actions.filter((action) => action.type === 'book_appointment').length, 1)
      if (!virtual) {
        const effects = await recordConversationalAgentPreviewEffects({ runContext, actions: confirmation.actions })
        assert.equal(effects[0]?.status, 'recorded', JSON.stringify(effects))
        const appointment = await db.get('SELECT id, is_test FROM appointments WHERE id = ?', [effects[0].entityId])
        assert.equal(Number(appointment?.is_test), 1)
        const replay = await recordConversationalAgentPreviewEffects({ runContext, actions: confirmation.actions })
        assert.equal(replay[0].entityId, appointment.id)
        assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
        await cleanupConversationalAgentTestRun({ testRunId: sessionId, requestedByUserId: userId })
        assert.deepEqual(await loadConversationalPreviewContactData(scope), {})
      }
      const technical = await db.get('SELECT full_name, phone FROM contacts WHERE id = ?', [contactId])
      assert.equal(technical.full_name, 'Contacto de prueba')
      assert.ok(!technical.phone)
    } finally {
      if (scope) await cleanupConversationalAppointmentPreviewOffers(scope)
      await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId])
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId])
    }
  })
}

test('memoria aislada, correcciones, campos inválidos, reset y expiración sin editar CRM', async () => {
  const agentId = `agent_${randomUUID()}`
  const contactId = `contact_${randomUUID()}`
  const sessionId = `session_${randomUUID()}`
  const scopeFor = (userId, session = sessionId) => ({ agentId, contactId,
    previewScopeId: buildConversationalAppointmentPreviewScopeId({ testSessionId: session, requestedByUserId: userId, agentId }) })
  const scope = scopeFor('owner')
  const config = { id: agentId, capabilitiesConfig: { schemaVersion: 3,
    dataRequirements: { enabled: true, fields: [
      { field: 'full_name', level: 'required', scope: 'any_action' },
      { field: 'phone', level: 'required', scope: 'any_action' }
    ], updateContact: { enabled: false } },
    items: [{ id: 'schedule_appointment', enabled: true, calendarId: 'rstk_cal_default', bookingOwner: 'ai' }] } }
  const ctx = () => ({ ...scope, config, dryRun: true, channel: 'whatsapp', actions: [],
    virtualContact: { id: contactId, fullName: 'Contacto de prueba' } })
  try {
    const saved = await Promise.all([
      save(ctx(), { fullName: 'Elena Martínez' }),
      save(ctx(), { phone: '+526561234567' })
    ])
    assert.ok(saved.every((result) => result.ok), 'dos requests no pierden campos independientes')
    assert.equal((await save(ctx(), { phone: '12' })).ok, false)
    assert.equal((await save(ctx(), { fullName: 'Elena López' })).ok, true)
    const persisted = await loadConversationalPreviewContactData(scope)
    assert.equal(persisted.full_name, 'Elena López')
    assert.equal(persisted.phone, '+526561234567')
    assert.deepEqual(await loadConversationalPreviewContactData(scopeFor('other-user')), {})
    assert.deepEqual(await loadConversationalPreviewContactData(scopeFor('owner', `session_${randomUUID()}`)), {})
    await assert.rejects(loadConversationalPreviewContactData({ ...scope, contactId: 'other-contact' }), /no pertenecen/)
    await cleanupConversationalAppointmentPreviewOffers(scope)
    assert.deepEqual(await loadConversationalPreviewContactData(scope), {})
    await save(ctx(), { fullName: 'Elena Martínez' })
    const row = await db.get('SELECT id, detail_json FROM conversational_agent_events WHERE agent_id = ? AND event_type = ?', [agentId, CONVERSATIONAL_PREVIEW_CONTACT_DATA_EVENT])
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({ ...JSON.parse(row.detail_json), expiresAt: '2000-01-01T00:00:00.000Z' }), row.id])
    assert.deepEqual(await loadConversationalPreviewContactData(scope), {})
    await cleanupExpiredConversationalAppointmentPreviewOffers()
    assert.equal(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [row.id]), null)
  } finally {
    await cleanupConversationalAppointmentPreviewOffers(scope)
  }
})
