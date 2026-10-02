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
import { runToolCallingV2Turn } from '../src/agents/conversational/runner.js'
import { buildConversationalAppointmentPreviewScopeId, loadConversationalPreviewContactData,
  buildConversationalAppointmentPreviewOfferEventId,
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

for (const bookingOwner of ['ai', 'human']) {
  for (const updateContact of [false, true]) {
    test(`el runtime guarda los datos recibidos después del sí y completa agenda ${bookingOwner}; actualizar ficha ${updateContact}`, async () => {
      const suffix = randomUUID()
      const agentId = `agent_data_resume_${suffix}`
      const contactId = `contact_data_resume_${suffix}`
      const calendarId = `calendar_data_resume_${suffix}`
      const scope = { agentId, contactId, previewScopeId: buildConversationalAppointmentPreviewScopeId({
        testSessionId: `session_${suffix}`, requestedByUserId: 'owner', agentId
      }) }
      const config = { id: agentId, runtimeMode: 'tool_calling_v2', capabilitiesConfig: {
        schemaVersion: 3,
        dataRequirements: { enabled: true, fields: [
          { field: 'full_name', level: 'required', scope: 'any_action' },
          { field: 'phone', level: 'required', scope: 'any_action' }
        ], updateContact: { enabled: updateContact, policy: 'replace_placeholders' } },
        items: [{ id: 'schedule_appointment', enabled: true, calendarId, bookingOwner }]
      } }
      const messages = []
      const context = (content) => {
        const executionId = `preview:${randomUUID()}`
        messages.push({ id: executionId, role: 'user', content })
        return { ...scope, config, dryRun: true, channel: 'whatsapp', executionId,
          conversationMessages: [...messages], actions: [],
          virtualContact: updateContact ? null : { id: contactId, fullName: 'Contacto de prueba' } }
      }
      const acceptPayload = { decision: 'accept', nextPreferenceScope: null, reply: null,
        title: null, notes: null, attendeeName: null, attendeeContext: null,
        primaryAttendee: null, guests: [], agreedAmount: null }
      const runTurn = async (ctx, executeAgent) => {
        return runToolCallingV2Turn({ config, runtime: {}, messages: [...messages],
          contactId, dryRun: true, channel: 'whatsapp', executionId: ctx.executionId,
          previewScopeId: scope.previewScopeId, virtualContact: ctx.virtualContact,
          conversationModel: 'gpt-4.1-mini' }, {
          resolveMandatoryHandoff: async () => ({ handled: false }),
          executeAgent
        })
      }
      try {
        await db.run("INSERT INTO contacts (id, full_name) VALUES (?, 'Contacto de prueba')", [contactId])
        await upsertLocalCalendar({ id: calendarId, name: 'Agenda datos después de confirmar',
          source: 'ristak', slotDuration: 60, slotInterval: 60, allowBookingFor: 365,
          allowBookingForUnit: 'days', openHours: [{ daysOfTheWeek: [1],
            hours: [{ openHour: 10, openMinute: 0, closeHour: 12, closeMinute: 0 }] }]
        }, { source: 'ristak', syncStatus: 'synced' })
        const timezone = await getAccountTimezone()
        const day = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
        const slot = day.plus({ days: (1 - day.weekday + 7) % 7 }).set({ hour: 10 })
        const offered = await invoke(context('El lunes a las diez.'), 'offer_appointment_slot', {
          startTime: slot.toUTC().toISO(), appointmentId: null
        })
        assert.equal(offered.ok, true, JSON.stringify(offered))
        messages.push({ id: `assistant_offer_${suffix}`, role: 'assistant', content: offered.visibleReply })
        await cleanupExpiredConversationalAppointmentPreviewOffers()
        assert.ok(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [
          buildConversationalAppointmentPreviewOfferEventId(scope.previewScopeId)
        ]), 'la limpieza periódica debe conservar el horario que el cliente todavía puede confirmar')

        const confirmation = context('Sí.')
        const missingTurn = await runTurn(confirmation, async ({ agent }) => {
          assert.equal(agent.modelSettings.toolChoice, 'resolve_active_appointment_offer')
          assert.equal(agent.resetToolChoice, true)
          assert.match(agent.instructions, /Si accept devuelve needsData/)
          const resolver = agent.tools.find((tool) => tool.name === 'resolve_active_appointment_offer')
          const missing = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal(missing.needsData, true)
          const continuation = await agent.toolUseBehavior(null, [{ tool: resolver, output: missing }])
          assert.equal(continuation.isFinalOutput, false, 'faltan datos: el SDK debe permitir leer y guardar antes de cerrar')
          return missing.visibleReply
        })
        assert.match(missingTurn.reply, /nombre completo, teléfono/)
        assert.doesNotMatch(missingTurn.reply, /confirmas|te funciona|qué fecha/i)
        messages.push({ id: `assistant_missing_${suffix}`, role: 'assistant', content: missingTurn.reply })

        const dataCtx = context('Elena Martínez +526561234567')
        const completed = await runTurn(dataCtx, async ({ agent }) => {
          const resolver = agent.tools.find((tool) => tool.name === 'resolve_active_appointment_offer')
          const missing = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal((await agent.toolUseBehavior(null, [{ tool: resolver, output: missing }])).isFinalOutput, false)
          assert.match(missing.continueWith, /save_contact_data/)
          const unchanged = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal(unchanged.code, 'appointment_offer_already_adjudicated', 'sin datos nuevos no debe repetir la prevalidación')
          const saveData = agent.tools.find((tool) => tool.name === 'save_contact_data')
          const saveFromMessage = (values) => saveData.invoke(null, JSON.stringify({
            fullName: null, phone: null, alternatePhone: null, email: null,
            company: null, address: null, customValues: [], ...values
          }))
          const savedName = await saveFromMessage({ fullName: 'Elena Martínez' })
          assert.equal(savedName.ok, true, JSON.stringify(savedName))
          const missingPhone = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal(missingPhone.needsData, true)
          assert.deepEqual(missingPhone.requiredFields.map((field) => field.field), ['phone'])
          assert.doesNotMatch(missingPhone.visibleReply, /nombre/)
          assert.equal((await agent.toolUseBehavior(null, [{ tool: resolver, output: missingPhone }])).isFinalOutput, false)
          const savedPhone = await saveFromMessage({ phone: '+526561234567' })
          assert.equal(savedPhone.ok, true, JSON.stringify(savedPhone))
          const result = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal(result.ok, true, JSON.stringify(result))
          const final = await agent.toolUseBehavior(null, [{ tool: resolver, output: result }])
          assert.equal(final.isFinalOutput, true)
          const replay = await resolver.invoke(null, JSON.stringify(acceptPayload))
          assert.equal(replay.code, 'appointment_offer_already_adjudicated')
          return final.finalOutput
        })
        assert.doesNotMatch(completed.reply, /me falta|me pasas|confirmas|te funciona/i)
        assert.equal(completed.appointmentOfferPostcondition.terminalActionSucceeded, true)
        assert.equal(completed.ctx.appointmentOfferAdjudication.preflightRetryCount, 2)
        assert.equal(completed.ctx.appointmentOfferAdjudication.output.ok, true)
        const terminalType = bookingOwner === 'human' ? 'request_human_booking' : 'book_appointment'
        assert.equal(completed.ctx.actions.filter((action) => action.type === terminalType).length, 1)
        await cleanupExpiredConversationalAppointmentPreviewOffers()
        assert.ok(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [
          buildConversationalAppointmentPreviewOfferEventId(scope.previewScopeId)
        ]), 'el resultado aceptado sin vencimiento debe conservarse hasta limpiar la sesión')
        const technical = await db.get('SELECT full_name, phone FROM contacts WHERE id = ?', [contactId])
        assert.equal(technical.full_name, 'Contacto de prueba')
        assert.ok(!technical.phone)
      } finally {
        await cleanupConversationalAppointmentPreviewOffers(scope)
        await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId])
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
        await db.run('DELETE FROM calendars WHERE id = ?', [calendarId])
      }
    })
  }
}

test('limpieza conserva ofertas activas legacy y resultados sin vencimiento; elimina terminales vencidas', async () => {
  const agentId = `agent_cleanup_${randomUUID()}`
  const contactId = `contact_cleanup_${randomUUID()}`
  const now = new Date()
  const expiredAt = new Date(now.getTime() - 60_000).toISOString()
  const fixtures = [
    { status: 'active', expiresAt: expiredAt, retained: true },
    { status: 'active', expiresAt: null, retained: true },
    { status: 'accepted', expiresAt: null, retained: true },
    { status: 'superseded', expiresAt: expiredAt, retained: false },
    { status: 'declined', expiresAt: expiredAt, retained: false }
  ].map((fixture) => {
    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: `session_${randomUUID()}`, requestedByUserId: 'owner', agentId
    })
    return { ...fixture, previewScopeId, id: buildConversationalAppointmentPreviewOfferEventId(previewScopeId) }
  })
  try {
    for (const fixture of fixtures) {
      await db.run(
        'INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json) VALUES (?, ?, ?, ?, ?)',
        [fixture.id, contactId, agentId, 'appointment_slot_preview_offer_created',
          JSON.stringify({ previewScopeId: fixture.previewScopeId, status: fixture.status, expiresAt: fixture.expiresAt })]
      )
    }
    await cleanupExpiredConversationalAppointmentPreviewOffers({ now })
    for (const fixture of fixtures) {
      assert.equal(Boolean(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [fixture.id])),
        fixture.retained, `${fixture.status}; vencimiento ${fixture.expiresAt}`)
      await cleanupConversationalAppointmentPreviewOffers({ previewScopeId: fixture.previewScopeId, agentId })
      assert.equal(await db.get('SELECT id FROM conversational_agent_events WHERE id = ?', [fixture.id]), null,
        'el reset explícito sí elimina una oferta sin vencimiento')
    }
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE agent_id = ?', [agentId])
  }
})

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
