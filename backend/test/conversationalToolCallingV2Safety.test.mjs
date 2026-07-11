import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import {
  buildNativeFreeSlotDays,
  createConversationalTools,
  setNativeHandoffAfterAssignmentHookForTest
} from '../src/agents/conversational/tools.js'
import { resumeToolCallingV2AfterVerifiedPayment } from '../src/agents/conversational/runner.js'
import { findVerifiedPaymentEvidence } from '../src/agents/conversational/actionEvidence.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import { registerAgentTransferPaymentProofForReview } from '../src/services/paymentFlowService.js'
import {
  completeConversationalAgentSalePaymentFromInvoice,
  consumeConversationalAppointmentDepositEvidence,
  createConversationalAgent,
  recordConversationalAgentEvent,
  reserveConversationalAppointmentDepositEvidence,
  setConversationalPaymentResumeHandlerForTest
} from '../src/services/conversationalAgentService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import {
  approveTransferProof,
  deleteTransaction,
  recordPayment,
  rejectTransferProof,
  voidTransaction
} from '../src/controllers/transactionsController.js'

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

function v2Context(items, overrides = {}) {
  return {
    runtimeMode: 'tool_calling_v2',
    contactId: `contact_v2_${randomUUID()}`,
    agentId: `agent_v2_${randomUUID()}`,
    channel: 'whatsapp',
    dryRun: true,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    config: {
      id: `agent_v2_${randomUUID()}`,
      runtimeMode: 'tool_calling_v2',
      objective: 'custom',
      capabilitiesConfig: { schemaVersion: 1, items }
    },
    ...overrides
  }
}

test('v2 presenta la hora local del servidor y conserva el startTime UTC sin recalcularlo', () => {
  const startTime = '2026-07-14T22:00:00.000Z'
  const [day] = buildNativeFreeSlotDays([{
    date: '2026-07-14',
    timezone: 'America/Mexico_City',
    slots: [startTime]
  }], 'UTC')
  const [option] = day.options

  assert.equal(day.timezone, 'America/Mexico_City')
  assert.equal(option.startTime, startTime)
  assert.equal(option.localDate, '2026-07-14')
  assert.equal(option.localTime, '16:00')
  assert.match(option.localLabel, /martes 14 de julio de 2026/)
  assert.match(option.localLabel, /4:00/)
  assert.doesNotMatch(option.localLabel, /5:00/)
})

test('v2 expone la unión exacta de capacidades y nunca las tools de silencio/descarte legacy', () => {
  const ctx = v2Context([
    { id: 'schedule_appointment', enabled: true, calendarId: 'calendar_locked' },
    { id: 'collect_payment', enabled: true, productId: 'product_locked', priceId: 'price_locked' },
    { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.com/avanzar' },
    { id: 'handoff_human', enabled: true },
    { id: 'custom_goal', enabled: true, description: 'Recabar los datos del proyecto', completion: 'handoff' }
  ])
  const names = createConversationalTools(ctx).map((item) => item.name)

  for (const expected of [
    'get_business_profile',
    'list_products',
    'get_contact_profile',
    'get_free_slots',
    'book_appointment',
    'create_payment_link',
    'send_goal_url',
    'send_to_human',
    'mark_ready_to_advance'
  ]) assert.ok(names.includes(expected), `${expected} debe estar expuesta`)

  for (const forbidden of [
    'list_calendars',
    'send_trigger_link',
    'update_closing_context',
    'discard_conversation',
    'stay_silent',
    'save_contact_data'
  ]) assert.ok(!names.includes(forbidden), `${forbidden} no debe estar expuesta en v2`)

  const noActions = createConversationalTools(v2Context([
    { id: 'schedule_appointment', enabled: false, calendarId: 'calendar_off' },
    { id: 'handoff_human', enabled: false },
    { id: 'custom_goal', enabled: true, description: 'Enviar el recurso', completion: 'send_link' }
  ])).map((item) => item.name)
  assert.ok(!noActions.includes('get_free_slots'))
  assert.ok(!noActions.includes('book_appointment'))
  assert.ok(!noActions.includes('send_to_human'))
  assert.ok(!noActions.includes('mark_ready_to_advance'))
  assert.ok(!noActions.includes('send_goal_url'))
  assert.ok(!noActions.includes('save_contact_data'))
})

test('todas las tools v2 conservan JSON Schema estricto y todos sus campos son requeridos', () => {
  const tools = createConversationalTools(v2Context([
    { id: 'schedule_appointment', enabled: true, calendarId: 'calendar_locked' },
    { id: 'collect_payment', enabled: true, productId: 'product_locked', priceId: 'price_locked' },
    { id: 'send_link', enabled: true, linkKind: 'verified_goal', url: 'https://example.com/avanzar' },
    { id: 'handoff_human', enabled: true },
    { id: 'custom_goal', enabled: true, description: 'Meta propia', completion: 'handoff' }
  ]))

  for (const currentTool of tools) {
    assert.equal(currentTool.strict, true, `${currentTool.name} debe ser strict`)
    assert.equal(currentTool.parameters.additionalProperties, false, `${currentTool.name} debe cerrar properties extra`)
    const properties = Object.keys(currentTool.parameters.properties || {}).sort()
    const required = [...(currentTool.parameters.required || [])].sort()
    assert.deepEqual(required, properties, `${currentTool.name} debe requerir todas sus properties`)
  }
  const paymentTool = tools.find((item) => item.name === 'create_payment_link')
  assert.equal('dueDate' in paymentTool.parameters.properties, false, 'v2 no debe permitir que el modelo invente fecha límite')
})

test('v2 agenda una frase natural sin pasar por el detector léxico legacy', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_v2_natural_${suffix}`
  const ghlCalendarId = `ghl_calendar_v2_natural_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slot = nextTuesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId,
      locationId: 'location_v2_natural',
      name: 'Agenda v2 natural',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [2], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId: ghlCalendarId, allowOverlaps: false }
    ], {
      conversationMessages: [{ role: 'user', content: 'Va, el martes tipo tardecita.' }]
    })
    const getFreeSlots = createConversationalTools(ctx).find((item) => item.name === 'get_free_slots')
    const availability = await getFreeSlots.invoke(null, JSON.stringify({
      startDate: slot.toISODate(),
      endDate: slot.toISODate()
    }))
    assert.equal(availability.ok, true, JSON.stringify(availability))
    assert.ok(availability.total > 0)
    assert.equal('calendarId' in availability, false)
    const returnedSlot = availability.slots
      .flatMap((day) => day.options)
      .find((option) => option.localDate === slot.toISODate() && option.localTime === '16:00')
    assert.ok(returnedSlot, JSON.stringify(availability))
    assert.equal(returnedSlot.startTime, slot.toUTC().toISO())
    assert.match(returnedSlot.localLabel, /4:00/)
    assert.equal(availability.slots[0]?.timezone, timezone)
    assert.match(availability.note, /localLabel/)
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const result = await book.invoke(null, JSON.stringify({
      startTime: returnedSlot.startTime,
      title: null,
      notes: null
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.simulated, true)
    assert.equal('calendarId' in result.appointment, false)
    assert.equal('id' in result.appointment, false)
    assert.match(ctx.actions[0]?.clientRequestId, /^conv-v2-attempt:/)
    assert.equal(ctx.actions[0]?.calendarId, calendarId)
    assert.equal(ctx.actions[0]?.confirmationEvidence?.nativeToolDecision, true)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('book_appointment v2 reintenta con la misma llave y reproduce una sola cita real', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_v2_replay_${suffix}`
  const contactId = `contact_v2_replay_${suffix}`
  const username = `user_v2_replay_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 28 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = nextMonday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  let clientRequestId = ''
  let userId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente replay v2']
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario legacy oculto', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_v2_replay',
      name: 'Agenda v2 replay',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [1], hours: [{ openHour: 15, openMinute: 0, closeHour: 18, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId, allowOverlaps: false }
    ], { contactId, dryRun: false, agentId: null, executionId: `message_replay_${suffix}` })
    ctx.config.id = `agent_v2_replay_${suffix}`
    ctx.config.goalWorkflow = { completion: { mode: 'assign_user', userId } }
    ctx.config.successExtras = [{ type: 'add_tag', tag: 'legacy-hidden-effect' }]
    const book = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const payload = {
      startTime: slot.toUTC().toISO(),
      title: 'Valoración inicial',
      notes: 'Requiere valoración'
    }
    const first = await book.invoke(null, JSON.stringify(payload))
    clientRequestId = ctx.actions[0]?.clientRequestId || ''
    const replay = await book.invoke(null, JSON.stringify({
      ...payload,
      title: 'Título cosmético distinto'
    }))

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.deepEqual(replay.appointment, first.appointment)
    assert.equal('id' in first.appointment, false)
    assert.match(clientRequestId, /^conv-v2-attempt:/)
    assert.equal(ctx.actions[1]?.clientRequestId, clientRequestId)
    const rows = await db.all(
      `SELECT id FROM appointments
       WHERE calendar_id = ? AND contact_id = ? AND start_time = ?`,
      [calendarId, contactId, slot.toUTC().toISO()]
    )
    assert.equal(rows.length, 1)
    const movedSlot = slot.plus({ days: 1, hours: 1 })
    await db.run(
      `UPDATE appointments SET start_time = ?, end_time = ?, title = 'Valoración reprogramada'
       WHERE id = ?`,
      [movedSlot.toUTC().toISO(), movedSlot.plus({ hours: 1 }).toUTC().toISO(), rows[0].id]
    )
    const movedReplay = await book.invoke(null, JSON.stringify(payload))
    assert.equal(movedReplay.ok, false)
    assert.equal(movedReplay.actionCompleted, false)
    assert.equal(movedReplay.appointmentRescheduled, true)
    assert.equal(movedReplay.existingAppointment.startTime, movedSlot.toUTC().toISO())
    assert.equal(movedReplay.existingAppointment.endTime, movedSlot.plus({ hours: 1 }).toUTC().toISO())
    assert.match(movedReplay.error, /ya fue reprogramada/i)
    assert.equal(ctx.actions[2]?.clientRequestId, clientRequestId)
    assert.equal(ctx.actions[2]?.outcome?.status, 'error')
    assert.equal(ctx.actions[2]?.outcome?.appointmentRescheduled, true)
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.assigned_user_id, null)
    const signalEvent = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    assert.notEqual(JSON.parse(signalEvent.detail_json).summarySource, 'internal_summary_agent')
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    if (clientRequestId) {
      await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [clientRequestId]).catch(() => {})
    }
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('book_appointment v2 nunca adopta como propia una cita futura de otro calendario', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_bound_target_${suffix}`
  const foreignCalendarId = `calendar_bound_foreign_${suffix}`
  const contactId = `contact_bound_target_${suffix}`
  const agentId = `agent_bound_target_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 30 }).startOf('day')
  const targetDay = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const targetSlot = targetDay.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })
  const foreignSlot = targetSlot.minus({ days: 1 })

  try {
    for (const [id, day] of [[calendarId, 1], [foreignCalendarId, 7]]) {
      await upsertLocalCalendar({
        id,
        locationId: `location_${id}`,
        name: id === calendarId ? 'Agenda blindada' : 'Agenda ajena',
        source: 'ristak',
        slotDuration: 60,
        slotInterval: 60,
        openHours: [{ daysOfTheWeek: [day], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
      }, { source: 'ristak', syncStatus: 'synced' })
    }
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con cita ajena', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES (?, ?, ?, 'Cita ajena', 'confirmed', 'confirmed', ?, ?)`,
      [
        `appointment_foreign_${suffix}`,
        foreignCalendarId,
        contactId,
        foreignSlot.toUTC().toISO(),
        foreignSlot.plus({ hours: 1 }).toUTC().toISO()
      ]
    )

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `message_bound_${suffix}` })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({ startTime: targetSlot.toUTC().toISO(), title: null, notes: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.alreadyBooked, undefined)
    assert.equal(result.appointment.startTime, targetSlot.toUTC().toISO())
    const rows = await db.all(
      'SELECT calendar_id, start_time FROM appointments WHERE contact_id = ? ORDER BY start_time',
      [contactId]
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[1].calendar_id, calendarId)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarId, foreignCalendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('v2 toma producto, monto y moneda de la base aunque la capacidad traiga snapshots viejos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_v2_price_${suffix}`
  const productId = `product_v2_price_${suffix}`
  const priceId = `price_v2_price_${suffix}`
  const currency = await getAccountCurrency()

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente precio v2']
    )
    await db.run(
      `INSERT INTO products (id, name, currency, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [productId, 'Servicio real', currency]
    )
    await db.run(
      `INSERT INTO product_prices (id, product_id, name, amount, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [priceId, productId, 'Precio vigente', 123.45, currency]
    )

    const ctx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      productId,
      priceId,
      paymentMode: 'full_payment',
      amount: 99999,
      currency: currency === 'USD' ? 'MXN' : 'USD'
    }], {
      contactId,
      accountLocale: { currency }
    })
    const paymentTool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const result = await paymentTool.invoke(null, JSON.stringify({ quantity: 2, agreedAmount: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.simulated, true)
    assert.equal(result.amount, 246.9)
    assert.equal(result.currency, currency)
    assert.equal(result.concept, 'Servicio real · Precio vigente')
    assert.equal(result.catalogEvidence, 'product_price')
    assert.equal('invoiceId' in result, false)

    const catalog = createConversationalTools(ctx).find((item) => item.name === 'list_products')
    const visibleOffer = await catalog.invoke(null, JSON.stringify({ query: null }))
    assert.equal(visibleOffer.total, 1)
    assert.equal(visibleOffer.products[0].name, 'Servicio real')
    assert.equal(visibleOffer.products[0].configuredForPayment, true)
    assert.equal('id' in visibleOffer.products[0], false)
    assert.equal('id' in visibleOffer.products[0].prices[0], false)

    const missingExecutionCtx = v2Context([{
      id: 'collect_payment', enabled: true, productId, priceId, paymentMode: 'full_payment'
    }], { contactId, accountLocale: { currency }, dryRun: false, executionId: '' })
    const blocked = await createConversationalTools(missingExecutionCtx)
      .find((item) => item.name === 'create_payment_link')
      .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'payment_execution_id_missing')
  } finally {
    await db.run('DELETE FROM product_prices WHERE id = ?', [priceId]).catch(() => {})
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('anticipo v2 de rango exige agreedAmount real y bloquea montos fuera del rango', async () => {
  const contactId = `contact_v2_range_${randomUUID()}`
  const currency = await getAccountCurrency()
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente rango v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const rangeCtx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      currency,
      deposit: {
        enabled: true,
        mode: 'range',
        minAmount: 50,
        maxAmount: 200,
        currency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }], { contactId, accountLocale: { currency } })
    const rangeTool = createConversationalTools(rangeCtx).find((item) => item.name === 'create_payment_link')

    const missing = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(missing.ok, false)
    assert.equal(missing.needsData, true)
    assert.equal(missing.requiredField, 'agreedAmount')

    const outside = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 225 }))
    assert.equal(outside.ok, false)
    assert.equal(outside.amountOutOfRange, true)

    const middle = await rangeTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 125 }))
    assert.equal(middle.ok, true, JSON.stringify(middle))
    assert.equal(middle.simulated, true)
    assert.equal(middle.amount, 125)

    const fixedCtx = v2Context([{
      id: 'collect_payment',
      enabled: true,
      paymentMode: 'deposit',
      currency,
      deposit: {
        enabled: true,
        mode: 'fixed',
        amount: 100,
        currency,
        methods: { paymentLink: true, bankTransfer: false }
      }
    }], { contactId, accountLocale: { currency } })
    const fixedTool = createConversationalTools(fixedCtx).find((item) => item.name === 'create_payment_link')
    const fixedMismatch = await fixedTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: 90 }))
    assert.equal(fixedMismatch.ok, false)
    assert.equal(fixedMismatch.amountMismatch, true)
    const fixedCanonical = await fixedTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(fixedCanonical.ok, true)
    assert.equal(fixedCanonical.amount, 100)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('handoff_human v2 asigna sólo al usuario activo configurado y el retry es idempotente', async () => {
  const suffix = randomUUID()
  const username = `handoff_v2_${suffix}`
  const contactId = `contact_handoff_v2_${suffix}`
  const inactiveContactId = `contact_handoff_inactive_v2_${suffix}`
  let userId = ''
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Andrea del equipo', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente handoff v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              (?, 'Cliente handoff inactivo v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, inactiveContactId]
    )

    const ctx = v2Context([{
      id: 'handoff_human',
      enabled: true,
      userId,
      userName: 'Nombre viejo que no manda'
    }], { contactId, dryRun: false })
    const handoff = createConversationalTools(ctx).find((item) => item.name === 'send_to_human')
    const first = await handoff.invoke(null, JSON.stringify({ motivo: 'Necesita especialista', resumen: 'Caso listo para el equipo' }))
    const replay = await handoff.invoke(null, JSON.stringify({ motivo: 'Necesita especialista', resumen: 'Retry del mismo handoff' }))

    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.assignedUserName, 'Andrea del equipo')
    assert.equal(replay.ok, true)
    const assigned = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(String(assigned.assigned_user_id), userId)
    const assignmentEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
      [contactId]
    )
    assert.equal(Number(assignmentEvents.total), 1)

    await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [userId])
    const inactiveCtx = v2Context([{
      id: 'handoff_human', enabled: true, userId, userName: 'Andrea del equipo'
    }], { contactId: inactiveContactId, dryRun: false })
    const inactiveHandoff = createConversationalTools(inactiveCtx).find((item) => item.name === 'send_to_human')
    const blocked = await inactiveHandoff.invoke(null, JSON.stringify({ motivo: 'Escalar', resumen: 'Usuario apagado' }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'handoff_user_unavailable')
    const inactiveContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [inactiveContactId])
    assert.equal(inactiveContact.assigned_user_id, null)
  } finally {
    for (const id of [contactId, inactiveContactId]) {
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [id]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [id]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => {})
    }
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('handoff v2 revierte asignación y estado juntos si falla entre pasos, y el retry completa ambos', async () => {
  const scenarios = [
    {
      label: 'handoff_human',
      toolName: 'send_to_human',
      capabilities: (userId) => [{
        id: 'handoff_human', enabled: true, userId, userName: 'Responsable atómico'
      }],
      input: {
        motivo: 'Necesita revisión humana',
        resumen: 'El equipo debe continuar el caso'
      },
      expectedStatus: 'human'
    },
    {
      label: 'custom_goal',
      toolName: 'mark_ready_to_advance',
      capabilities: (userId) => [{
        id: 'custom_goal', enabled: true, description: 'Recabar requisitos', completion: 'handoff'
      }, {
        id: 'handoff_human', enabled: true, userId, userName: 'Responsable atómico'
      }],
      input: {
        intencionDetectada: 'Entregó todos los requisitos',
        resumen: 'El equipo ya puede preparar la propuesta',
        urgencia: 'media',
        siguientePaso: 'Preparar propuesta'
      },
      expectedStatus: 'completed'
    }
  ]

  for (const scenario of scenarios) {
    const suffix = randomUUID()
    const username = `handoff_atomic_${scenario.label}_${suffix}`
    const contactId = `contact_handoff_atomic_${scenario.label}_${suffix}`
    const agentId = `agent_handoff_atomic_${scenario.label}_${suffix}`
    const stateId = `state_handoff_atomic_${scenario.label}_${suffix}`
    let userId = ''
    try {
      await db.run(
        `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
         VALUES (?, 'test-hash', 'Responsable atómico', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [username]
      )
      userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
      await db.run(
        `INSERT INTO contacts (id, full_name, created_at, updated_at)
         VALUES (?, 'Cliente handoff atómico', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId]
      )
      await db.run(
        `INSERT INTO conversational_agent_state (id, contact_id, agent_id, channel, status, updated_at)
         VALUES (?, ?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
        [stateId, contactId, agentId]
      )

      const ctx = v2Context(scenario.capabilities(userId), {
        contactId,
        agentId,
        dryRun: false,
        executionId: `message_handoff_atomic_${suffix}`
      })
      ctx.config.id = agentId
      const handoffTool = createConversationalTools(ctx).find((item) => item.name === scenario.toolName)
      assert.ok(handoffTool, `${scenario.label} debe exponer ${scenario.toolName}`)

      let injectedFailures = 0
      setNativeHandoffAfterAssignmentHookForTest(async ({ contactId: hookContactId, assignment }) => {
        if (hookContactId !== contactId || injectedFailures > 0) return
        injectedFailures += 1
        assert.equal(String(assignment.assignedUserId), userId)
        const error = new Error('Fallo inyectado entre asignación y estado')
        error.code = 'forced_handoff_midpoint_failure'
        throw error
      })

      const failed = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(failed.ok, false, `${scenario.label} debe reportar el fallo intermedio`)
      assert.equal(failed.code, 'forced_handoff_midpoint_failure')
      assert.equal(injectedFailures, 1)

      const rolledBackContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
      assert.equal(rolledBackContact.assigned_user_id, null, `${scenario.label} debe revertir la asignación`)
      const rolledBackState = await db.get(
        'SELECT status, signal FROM conversational_agent_state WHERE id = ?',
        [stateId]
      )
      assert.equal(rolledBackState.status, 'active')
      assert.equal(rolledBackState.signal, null, `${scenario.label} no debe dejar una señal parcial`)
      const rolledBackEvents = await db.get(
        `SELECT COUNT(*) AS total
         FROM conversational_agent_events
         WHERE contact_id = ? AND event_type IN ('signal_set', 'handoff_user_assigned')`,
        [contactId]
      )
      assert.equal(Number(rolledBackEvents.total), 0, `${scenario.label} debe revertir también su auditoría`)

      setNativeHandoffAfterAssignmentHookForTest(null)
      const retried = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(retried.ok, true, JSON.stringify(retried))
      assert.equal(retried.assignedUserName, 'Responsable atómico')

      const committedContact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
      assert.equal(String(committedContact.assigned_user_id), userId)
      const committedState = await db.get(
        'SELECT status, signal FROM conversational_agent_state WHERE id = ?',
        [stateId]
      )
      assert.equal(committedState.status, scenario.expectedStatus)
      assert.equal(committedState.signal, 'ready_for_human')
      const committedEvents = await db.all(
        `SELECT event_type, COUNT(*) AS total
         FROM conversational_agent_events
         WHERE contact_id = ? AND event_type IN ('signal_set', 'handoff_user_assigned')
         GROUP BY event_type`,
        [contactId]
      )
      assert.deepEqual(
        Object.fromEntries(committedEvents.map((row) => [row.event_type, Number(row.total)])),
        { handoff_user_assigned: 1, signal_set: 1 }
      )

      const replay = await handoffTool.invoke(null, JSON.stringify(scenario.input))
      assert.equal(replay.ok, true, JSON.stringify(replay))
      const assignmentEventsAfterReplay = await db.get(
        `SELECT COUNT(*) AS total FROM conversational_agent_events
         WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
        [contactId]
      )
      assert.equal(Number(assignmentEventsAfterReplay.total), 1, `${scenario.label} no debe duplicar la asignación`)
    } finally {
      setNativeHandoffAfterAssignmentHookForTest(null)
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    }
  }
})

test('custom_goal v2 asigna por capacidad de forma idempotente sin resumen ni efectos legacy invisibles', async () => {
  const suffix = randomUUID()
  const capabilityUsername = `capability_handoff_v2_${suffix}`
  const legacyUsername = `legacy_hidden_effect_v2_${suffix}`
  const contactId = `contact_hidden_effect_v2_${suffix}`
  let capabilityUserId = ''
  let legacyUserId = ''
  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario asignado por capacidad', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [capabilityUsername]
    )
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario efecto legacy', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [legacyUsername]
    )
    capabilityUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [capabilityUsername]))?.id || '')
    legacyUserId = String((await db.get('SELECT id FROM users WHERE username = ?', [legacyUsername]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente custom v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const ctx = v2Context([{
      id: 'custom_goal', enabled: true, description: 'Recabar requisitos', completion: 'handoff'
    }, {
      id: 'handoff_human', enabled: true, userId: capabilityUserId, userName: 'Usuario asignado por capacidad'
    }], { contactId, dryRun: false })
    ctx.config.id = `agent_custom_v2_${suffix}`
    ctx.config.goalWorkflow = { completion: { mode: 'assign_user', userId: legacyUserId } }
    ctx.config.successExtras = [{ type: 'add_tag', tag: 'legacy-hidden-effect' }]
    const mark = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
    const result = await mark.invoke(null, JSON.stringify({
      intencionDetectada: 'Compartió todos los requisitos',
      resumen: 'Necesita una propuesta para un proyecto de tres sedes',
      urgencia: 'media',
      siguientePaso: 'Preparar propuesta'
    }))
    const replay = await mark.invoke(null, JSON.stringify({
      intencionDetectada: 'Compartió todos los requisitos',
      resumen: 'Necesita una propuesta para un proyecto de tres sedes',
      urgencia: 'media',
      siguientePaso: 'Preparar propuesta'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.assignedUserName, 'Usuario asignado por capacidad')
    assert.equal(replay.ok, true, JSON.stringify(replay))
    const contact = await db.get('SELECT assigned_user_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(String(contact.assigned_user_id), capabilityUserId)
    assert.notEqual(String(contact.assigned_user_id), legacyUserId)
    const assignmentEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'handoff_user_assigned'`,
      [contactId]
    )
    assert.equal(Number(assignmentEvents.total), 1)
    const legacyExtrasEvents = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'success_extras_applied'`,
      [contactId]
    )
    assert.equal(Number(legacyExtrasEvents.total), 0)
    const signalEvent = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const detail = JSON.parse(signalEvent.detail_json)
    assert.equal(detail.summarySource, 'tool_fallback')
    assert.match(detail.summary, /proyecto de tres sedes/i)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    for (const userId of [capabilityUserId, legacyUserId]) {
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    }
  }
})

test('confirmación real de pago v2 no levanta sub-IA ni aplica asignación o extras legacy ocultos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_completion_v2_${suffix}`
  const invoiceId = `invoice_payment_completion_v2_${suffix}`
  let agent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente pago v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago v2 sin efectos legacy ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'collect_payment',
          enabled: true,
          productId: `product_${suffix}`,
          priceId: `price_${suffix}`,
          paymentMode: 'full_payment'
        }]
      },
      goalWorkflow: {
        completion: { mode: 'assign_user', userId: 'legacy_hidden_user', userName: 'Legacy oculto' }
      },
      successExtras: [{ type: 'add_tag', tag: 'legacy-hidden-payment-extra' }]
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        invoiceId,
        amount: 725,
        currency: 'MXN',
        runtimeMode: 'tool_calling_v2',
        ledgerPaymentId: invoiceId,
        paymentEnvironment: 'live',
        paymentMode: 'full_payment',
        paymentPurpose: 'purchase',
        appointmentDeposit: false
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 725, 'MXN', 'paid', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [invoiceId, contactId, invoiceId]
    )

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      amount: 725,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })

    assert.equal(result.matched, true)
    const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = JSON.parse(contact.custom_fields || '{}')
    assert.equal(customFields.assignedUser, undefined)
    const hiddenEffects = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type IN ('completion_user_assigned', 'success_extras_applied')`,
      [contactId]
    )
    assert.equal(Number(hiddenEffects.total), 0)

    const retry = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId,
      amount: 725,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    })
    assert.equal(retry.alreadyCompleted, true)
    const idempotentEvents = await db.get(
      `SELECT
         SUM(CASE WHEN event_type = 'signal_set' THEN 1 ELSE 0 END) AS signals,
         SUM(CASE WHEN event_type = 'payment_link_goal_completed' THEN 1 ELSE 0 END) AS completions
       FROM conversational_agent_events WHERE contact_id = ?`,
      [contactId]
    )
    assert.equal(Number(idempotentEvents.signals), 1)
    assert.equal(Number(idempotentEvents.completions), 1)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('reconciliación v2 falla cerrado ante status, monto, moneda, ambiente o ledger insuficientes', async () => {
  const suffix = randomUUID()
  const contactId = `contact_payment_reject_v2_${suffix}`
  const invoiceId = `invoice_payment_reject_v2_${suffix}`
  let agent = null
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente rechazo factual v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Pago v2 factual ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{ id: 'collect_payment', enabled: true, paymentMode: 'full_payment' }]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        invoiceId,
        ledgerPaymentId: invoiceId,
        amount: 910.25,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'full_payment',
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        ghl_invoice_id, created_at, updated_at
      ) VALUES (?, ?, 910.25, 'MXN', 'paid', 'live', 'highlevel', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [invoiceId, contactId, invoiceId]
    )

    const base = {
      contactId,
      invoiceId,
      amount: 910.25,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const cases = [
      [{ ...base, status: '' }, 'payment_status_missing'],
      [{ ...base, status: 'pending' }, 'payment_status_not_successful'],
      [{ ...base, amount: 910.24 }, 'payment_amount_mismatch'],
      [{ ...base, currency: 'USD' }, 'payment_currency_mismatch'],
      [{ ...base, paymentMode: '' }, 'payment_environment_missing'],
      [{ ...base, paymentMode: 'test' }, 'payment_environment_mismatch']
    ]
    for (const [input, reason] of cases) {
      const result = await completeConversationalAgentSalePaymentFromInvoice(input)
      assert.equal(result.matched, false, reason)
      assert.equal(result.reason, reason)
    }

    const sourceEvent = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_created'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    const testModeDetail = { ...JSON.parse(sourceEvent.detail_json), paymentEnvironment: 'test' }
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(testModeDetail), sourceEvent.id])
    await db.run("UPDATE payments SET payment_mode = 'test' WHERE id = ?", [invoiceId])
    const sandbox = await completeConversationalAgentSalePaymentFromInvoice({ ...base, paymentMode: 'test' })
    assert.equal(sandbox.reason, 'payment_environment_not_live')
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify({ ...testModeDetail, paymentEnvironment: 'live' }), sourceEvent.id])
    await db.run("UPDATE payments SET payment_mode = 'live' WHERE id = ?", [invoiceId])

    await db.run("UPDATE payments SET status = 'pending' WHERE id = ?", [invoiceId])
    const unpaid = await completeConversationalAgentSalePaymentFromInvoice(base)
    assert.equal(unpaid.reason, 'payment_ledger_not_paid')
    await db.run("UPDATE payments SET status = 'paid' WHERE id = ?", [invoiceId])
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId])
    const missingLedger = await completeConversationalAgentSalePaymentFromInvoice(base)
    assert.equal(missingLedger.reason, 'payment_ledger_missing')

    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    const completions = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_link_goal_completed'`,
      [contactId]
    )
    assert.equal(Number(completions.total), 0)
  } finally {
    await db.run('DELETE FROM payments WHERE id = ?', [invoiceId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('anticipo de cita v2 conserva la conversación activa y reanuda una sola vez tras validar el ledger', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_resume_v2_${suffix}`
  const paymentId = `transfer_review_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente anticipo v2', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Cita con anticipo v2 ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_${suffix}` },
          {
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            deposit: { enabled: true, mode: 'fixed', amount: 300, currency: 'MXN' }
          }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId,
        ledgerPaymentId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, metadata_json, paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'bank_transfer', 'live', 'manual', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async (payload) => {
      resumeCalls += 1
      assert.equal(payload.paymentPurpose, 'appointment_deposit')
      assert.equal(payload.amount, 300)
      assert.equal(payload.currency, 'MXN')
      return { resumed: true, sent: true }
    })

    const input = {
      contactId,
      paymentId,
      amount: 300,
      currency: 'MXN',
      status: 'paid',
      paymentMode: 'live'
    }
    const result = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(result.signal, 'deposit_payment_verified')
    assert.equal(result.objectiveCompleted, false)
    assert.equal(result.resumed, true)
    const retry = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(retry.alreadyCompleted, true)
    assert.equal(resumeCalls, 1)

    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)
    const purchaseSignals = await db.get(
      `SELECT COUNT(*) AS total FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'signal_set'
         AND detail_json LIKE '%purchase_completed%'`,
      [contactId]
    )
    assert.equal(Number(purchaseSignals.total), 0)
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('recovery después de book_appointment no borra appointment_booked ni reenvía la respuesta', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_recovery_${suffix}`
  const paymentId = `transfer_recovery_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente recovery anticipo', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Recovery anticipo ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_recovery_${suffix}` },
          { id: 'collect_payment', enabled: true, paymentMode: 'deposit', deposit: { enabled: true, mode: 'fixed', amount: 400, currency: 'MXN' } }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId,
        ledgerPaymentId: paymentId,
        amount: 400,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        runtimeMode: 'tool_calling_v2'
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, paid_at, created_at, updated_at
      ) VALUES (?, ?, 400, 'MXN', 'paid', 'bank_transfer', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('crash simulado antes de cerrar el ledger')
    })
    const input = { contactId, paymentId, amount: 400, currency: 'MXN', status: 'paid', paymentMode: 'live' }
    await assert.rejects(completeConversationalAgentSalePaymentFromInvoice(input), /crash simulado/)
    assert.equal(resumeCalls, 1)

    const reconciliation = await db.get(
      `SELECT id, detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND event_type = 'payment_reconciliation_v2'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    )
    assert.equal(JSON.parse(reconciliation.detail_json).status, 'pending')
    await db.run(
      `UPDATE conversational_agent_state
       SET status = 'completed', signal = 'appointment_booked', updated_at = CURRENT_TIMESTAMP
       WHERE contact_id = ? AND agent_id = ?`,
      [contactId, agent.id]
    )
    await recordConversationalAgentEvent({
      eventId: `${reconciliation.id}_turn`,
      contactId,
      eventType: 'payment_resume_turn_completed',
      detail: { agentId: agent.id, actionTypes: ['book_appointment'], reconciliationId: reconciliation.id }
    })
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      throw new Error('no debe reanudarse otra vez')
    })

    const recovered = await completeConversationalAgentSalePaymentFromInvoice(input)
    assert.equal(recovered.resumed, true)
    assert.equal(resumeCalls, 1)
    const state = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agent.id]
    )
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'appointment_booked')
    assert.equal(JSON.parse((await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [reconciliation.id])).detail_json).status, 'completed')
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('aprobar o rechazar comprobante usa endpoints explícitos, sella auditoría y sólo approve reanuda', async () => {
  const suffix = randomUUID()
  const contactId = `contact_transfer_review_${suffix}`
  const approvedPaymentId = `transfer_review_approved_${suffix}`
  const rejectedPaymentId = `transfer_review_rejected_${suffix}`
  const blockedPaymentId = `transfer_review_blocked_${suffix}`
  let agent = null
  let resumeCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, custom_fields, created_at, updated_at)
       VALUES (?, 'Cliente revisión transferencia', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    agent = await createConversationalAgent({
      name: `Cita revisión transferencia ${suffix}`,
      enabled: false,
      runtimeMode: 'tool_calling_v2',
      objective: 'citas',
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'schedule_appointment', enabled: true, calendarId: `calendar_review_${suffix}` },
          {
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            deposit: { enabled: true, mode: 'fixed', amount: 250, currency: 'MXN' }
          }
        ]
      }
    })
    await db.run(
      `INSERT OR REPLACE INTO conversational_agent_state (
        contact_id, agent_id, channel, status, signal, updated_at
      ) VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP)`,
      [contactId, agent.id]
    )

    const metadata = JSON.stringify({
      source: 'conversational_agent_transfer_proof_pending_review',
      requiresHumanVerification: true,
      agentId: agent.id,
      mediaMessageId: `secret_message_${suffix}`,
      mediaUrl: 'https://example.com/proof.jpg',
      receivedAt: '2026-07-10T18:00:00.000Z',
      extracted: { bank: 'Banco Seguro', reference: 'ABC-123', confidence: 0.99 }
    })
    for (const paymentId of [approvedPaymentId, rejectedPaymentId, blockedPaymentId]) {
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, metadata_json, date, created_at, updated_at
        ) VALUES (?, ?, 250, 'MXN', 'pending_review', 'bank_transfer', 'manual_review',
          'manual', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [paymentId, contactId, metadata]
      )
    }
    await recordConversationalAgentEvent({
      contactId,
      eventType: 'deposit_transfer_pending_review',
      detail: {
        agentId: agent.id,
        paymentId: approvedPaymentId,
        ledgerPaymentId: approvedPaymentId,
        amount: 250,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentMode: 'deposit',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        runtimeMode: 'tool_calling_v2'
      }
    })
    setConversationalPaymentResumeHandlerForTest(async () => {
      resumeCalls += 1
      return { resumed: true, sent: true }
    })

    const approveRes = mockResponse()
    await approveTransferProof({
      params: { id: approvedPaymentId },
      body: { reference: 'REVISADO-OK' },
      user: { id: 'reviewer-safe' },
      headers: {},
      protocol: 'https',
      get: () => ''
    }, approveRes)
    assert.equal(approveRes.statusCode, 200)
    assert.equal(approveRes.body.success, true)
    assert.equal(approveRes.body.conversationResume.resumed, true)
    assert.equal(resumeCalls, 1)
    assert.deepEqual(approveRes.body.data.transferProof, {
      mediaUrl: 'https://example.com/proof.jpg',
      receivedAt: '2026-07-10T18:00:00.000Z',
      bank: 'Banco Seguro',
      reference: 'REVISADO-OK',
      reviewDecision: 'approved',
      reviewReason: null,
      reviewedAt: approveRes.body.data.paidAt
    })
    assert.equal('agentId' in approveRes.body.data.transferProof, false)
    assert.equal('mediaMessageId' in approveRes.body.data.transferProof, false)
    assert.equal('extracted' in approveRes.body.data.transferProof, false)

    const approveRetryRes = mockResponse()
    await approveTransferProof({
      params: { id: approvedPaymentId }, body: {}, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, approveRetryRes)
    assert.equal(approveRetryRes.statusCode, 200)
    assert.equal(approveRetryRes.body.alreadyApproved, true)
    assert.equal(resumeCalls, 1)

    const rejectApprovedRes = mockResponse()
    await rejectTransferProof({
      params: { id: approvedPaymentId }, body: { reason: 'No aplica' }, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, rejectApprovedRes)
    assert.equal(rejectApprovedRes.statusCode, 409)

    const rejectRes = mockResponse()
    await rejectTransferProof({
      params: { id: rejectedPaymentId }, body: { reason: 'Monto no aparece abonado' }, user: { id: 'reviewer-safe' }, headers: {}, protocol: 'https', get: () => ''
    }, rejectRes)
    assert.equal(rejectRes.statusCode, 200)
    assert.equal(rejectRes.body.data.status, 'rejected')
    assert.equal(rejectRes.body.data.transferProof.reviewDecision, 'rejected')
    assert.equal(rejectRes.body.data.transferProof.reviewReason, 'Monto no aparece abonado')
    assert.equal(resumeCalls, 1)

    const voidRes = mockResponse()
    await voidTransaction({ params: { id: blockedPaymentId } }, voidRes)
    assert.equal(voidRes.statusCode, 409)
    assert.match(voidRes.body.error, /revisión protegido|Aprobar o Rechazar/i)

    const genericRes = mockResponse()
    await recordPayment({
      params: { id: blockedPaymentId }, body: {}, headers: {}, protocol: 'https', get: () => ''
    }, genericRes)
    assert.equal(genericRes.statusCode, 409)
    const blocked = await db.get('SELECT status, payment_mode FROM payments WHERE id = ?', [blockedPaymentId])
    assert.equal(blocked.status, 'pending_review')
    assert.equal(blocked.payment_mode, 'manual_review')

    for (const [paymentId, expectedStatus] of [
      [blockedPaymentId, 'pending_review'],
      [approvedPaymentId, 'paid'],
      [rejectedPaymentId, 'rejected']
    ]) {
      const deleteRes = mockResponse()
      await deleteTransaction({ params: { id: paymentId } }, deleteRes)
      assert.equal(deleteRes.statusCode, 409)
      assert.match(deleteRes.body.error, /revisión protegido|historial de auditoría|no se puede eliminar/i)

      const persisted = await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])
      assert.equal(persisted.status, expectedStatus)
    }
  } finally {
    setConversationalPaymentResumeHandlerForTest(null)
    for (const paymentId of [approvedPaymentId, rejectedPaymentId, blockedPaymentId]) {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    }
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_policy_versions WHERE agent_id = ?', [agent.id]).catch(() => {})
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => {})
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('la reanudación por pago usa el mismo Agent/Runner, el hilo completo y entrega respuesta sin fingir un mensaje del cliente', async () => {
  const suffix = randomUUID()
  const contactId = `contact_resume_runner_${suffix}`
  const agentId = `agent_resume_runner_${suffix}`
  const reconciliationId = `reconciliation_runner_${suffix}`
  const history = [
    { role: 'user', content: 'el martes tipo tardecita' },
    { role: 'assistant', content: 'va, te mando el anticipo para apartar' }
  ]
  let nativeTurnCalls = 0
  let deliveryCalls = 0
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Cliente runner pago', '+5215550007777', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const result = await resumeToolCallingV2AfterVerifiedPayment({
      reconciliationId,
      contactId,
      agentId,
      channel: 'whatsapp',
      amount: 300,
      currency: 'MXN',
      paymentEnvironment: 'live',
      paymentPurpose: 'appointment_deposit'
    }, {
      getRuntimeConfig: async () => ({ enabled: true, aiProvider: 'openai' }),
      hasFeature: async () => true,
      getAgent: async () => ({
        id: agentId,
        enabled: true,
        runtimeMode: 'tool_calling_v2',
        model: 'test-model',
        aiProvider: 'openai',
        capabilitiesConfig: { schemaVersion: 1, items: [] },
        replyDelivery: { mode: 'single', splitMessagesEnabled: false }
      }),
      getState: async () => ({ status: 'active', signal: null }),
      getLatestInbound: async () => ({
        id: `message_${suffix}`,
        phone: '+5215550007777',
        channel: 'whatsapp'
      }),
      getHistoryEnvelope: async () => ({ messages: history, telemetry: { total: history.length, included: history.length, omitted: 0 } }),
      hydrateMessages: async (messages) => messages,
      resolveRuntime: async () => ({ apiKey: 'test-only', modelProvider: {} }),
      runNativeTurn: async (args) => {
        nativeTurnCalls += 1
        assert.deepEqual(args.messages, history)
        assert.match(args.runtimeEventContext, /anticipo requerido para la cita fue confirmado/i)
        assert.match(args.runtimeEventContext, /vuelve a consultar disponibilidad real/i)
        assert.equal(args.executionId, `payment-resume:${reconciliationId}`)
        return {
          ctx: { actions: [{ type: 'book_appointment', outcome: { status: 'ok', ok: true } }] },
          model: 'test-model',
          reply: 'listo, tu cita quedó confirmada',
          runtimeMode: 'tool_calling_v2',
          modelCallCount: 1
        }
      },
      deliverReply: async ({ reply }) => {
        deliveryCalls += 1
        assert.equal(reply, 'listo, tu cita quedó confirmada')
        return { parts: [reply], sentParts: 1, interruptedBy: null }
      },
      recordEvent: async () => {}
    })
    assert.equal(result.resumed, true)
    assert.equal(result.sent, true)
    assert.equal(nativeTurnCalls, 1)
    assert.equal(deliveryCalls, 1)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('get_contact_profile v2 expone evidencia factual de cliente previo sin IDs internos', async () => {
  const suffix = randomUUID()
  const contactId = `contact_past_v2_${suffix}`
  const currency = await getAccountCurrency()
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente previo v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider, paid_at, created_at, updated_at
       ) VALUES
        (?, ?, 500, ?, 'paid', 'live', 'stripe', '2025-01-10T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, 999, ?, 'paid', 'test', 'stripe', '2025-01-11T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        (?, ?, 700, ?, 'paid', 'manual_review', 'manual', '2025-01-12T18:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        `payment_live_${suffix}`, contactId, currency,
        `payment_test_${suffix}`, contactId, currency,
        `payment_review_${suffix}`, contactId, currency
      ]
    )
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
       ) VALUES
        (?, 'calendar_history', ?, 'Consulta previa', 'confirmed', 'confirmed', '2025-02-01T16:00:00.000Z', '2025-02-01T17:00:00.000Z'),
        (?, 'calendar_history', ?, 'Cita cancelada', 'cancelled', 'cancelled', '2025-02-02T16:00:00.000Z', '2025-02-02T17:00:00.000Z')`,
      [`appointment_live_${suffix}`, contactId, `appointment_cancelled_${suffix}`, contactId]
    )

    const ctx = v2Context([{
      id: 'handoff_human', enabled: true, pastClientsToHuman: true
    }], { contactId })
    const profileTool = createConversationalTools(ctx).find((item) => item.name === 'get_contact_profile')
    assert.match(profileTool.description, /consulta obligatoria/i)
    const result = await profileTool.invoke(null, '{}')

    assert.equal(result.ok, true)
    assert.equal(result.pastClientEvidence.isPastClient, true)
    assert.equal(result.pastClientEvidence.successfulPayments.length, 1)
    assert.equal(result.pastClientEvidence.successfulPayments[0].amount, 500)
    assert.equal(result.pastClientEvidence.pastAppointments.length, 1)
    assert.equal(result.pastClientEvidence.pastAppointments[0].title, 'Consulta previa')
    assert.equal('id' in result.contact, false)
    assert.equal('totalPaid' in result.contact, false)
    assert.equal('purchasesCount' in result.contact, false)
    assert.equal('id' in result.pastClientEvidence.successfulPayments[0], false)
    assert.equal('id' in result.pastClientEvidence.pastAppointments[0], false)
  } finally {
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('send_link tipo trigger entrega sólo el destino y jamás agrega contact_id', async () => {
  const targetUrl = 'https://example.com/recurso?utm_source=ristak'
  const ctx = v2Context([{
    id: 'send_link',
    enabled: true,
    linkKind: 'trigger',
    url: targetUrl
  }], { contactId: 'contacto_que_no_debe_salir' })
  const sendLink = createConversationalTools(ctx).find((item) => item.name === 'send_goal_url')
  const result = await sendLink.invoke(null, JSON.stringify({ intencionDetectada: null, resumen: null }))

  assert.equal(result.ok, true)
  assert.equal(result.sentUrl, targetUrl)
  assert.equal(result.objectiveCompleted, false)
  assert.equal('goalId' in result, false)
  assert.ok(!result.sentUrl.includes('contact_id'))
  assert.equal(ctx.actions[0]?.outcome?.sentUrl, targetUrl)
})

test('send_link verificable reusa el mismo inbound, crea otra meta en otro inbound y nunca expone goalId', async () => {
  const contactId = `contact_v2_goal_${randomUUID()}`
  const targetUrl = 'https://example.com/finalizar'
  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente goal v2']
    )
    const ctx = v2Context([{
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: targetUrl
    }], { contactId, dryRun: false, agentId: null, executionId: `message_goal_1_${randomUUID()}` })
    ctx.config.id = null
    const sendLink = createConversationalTools(ctx).find((item) => item.name === 'send_goal_url')
    const result = await sendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar',
      resumen: 'Solicitó el enlace configurado'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal('goalId' in result, false)
    assert.match(result.sentUrl, /^https:\/\/example\.com\/finalizar\?/)
    assert.ok(ctx.actions[0]?.outcome?.goalId)
    assert.equal(ctx.actions[0]?.outcome?.sentUrl, result.sentUrl)

    const replay = await sendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar',
      resumen: 'Retry del mismo mensaje'
    }))
    assert.equal(replay.sentUrl, result.sentUrl)

    const nextCtx = v2Context([{
      id: 'send_link',
      enabled: true,
      linkKind: 'verified_goal',
      url: targetUrl
    }], { contactId, dryRun: false, agentId: null, executionId: `message_goal_2_${randomUUID()}` })
    nextCtx.config.id = null
    const nextSendLink = createConversationalTools(nextCtx).find((item) => item.name === 'send_goal_url')
    const nextResult = await nextSendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Quiere finalizar una meta nueva',
      resumen: 'Otro mensaje entrante'
    }))
    assert.equal(nextResult.ok, true, JSON.stringify(nextResult))
    assert.notEqual(nextResult.sentUrl, result.sentUrl)

    const count = await db.get(
      'SELECT COUNT(*) AS total FROM conversational_agent_goal_links WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(Number(count.total), 2)

    const missingCtx = v2Context([{
      id: 'send_link', enabled: true, linkKind: 'verified_goal', url: targetUrl
    }], { contactId, dryRun: false, agentId: null, executionId: '' })
    missingCtx.config.id = null
    const missingResult = await createConversationalTools(missingCtx)
      .find((item) => item.name === 'send_goal_url')
      .invoke(null, JSON.stringify({ intencionDetectada: null, resumen: null }))
    assert.equal(missingResult.ok, false)
    assert.equal(missingResult.code, 'goal_link_execution_id_missing')
  } finally {
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un comprobante v2 queda pending_review/manual_review y no cuenta como pago verificado', async () => {
  const contactId = `contact_v2_proof_${randomUUID()}`
  const currency = await getAccountCurrency()
  let paymentId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Cliente comprobante v2']
    )
    const payment = await registerAgentTransferPaymentProofForReview({
      contactId,
      amount: 75,
      currency,
      agentId: 'agent_v2_proof',
      mediaUrl: 'https://example.com/proof.jpg',
      mediaMessageId: 'message_v2_proof'
    })
    paymentId = payment.paymentId

    const row = await db.get(
      `SELECT status, payment_mode, payment_provider, paid_at, metadata_json
       FROM payments WHERE id = ?`,
      [paymentId]
    )
    assert.equal(row.status, 'pending_review')
    assert.equal(row.payment_mode, 'manual_review')
    assert.equal(row.payment_provider, 'manual')
    assert.equal(row.paid_at, null)
    assert.equal(JSON.parse(row.metadata_json).requiresHumanVerification, true)

    const requirement = { mode: 'fixed', amount: 75, currency }
    const pendingEvidence = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      requirement,
      accountCurrency: currency
    })
    assert.equal(pendingEvidence.ok, false)

    // Defensa extra: ni un cambio accidental de status desbloquea manual_review.
    await db.run(
      `UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [paymentId]
    )
    const mislabeledEvidence = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      requirement,
      accountCurrency: currency
    })
    assert.equal(mislabeledEvidence.ok, false)
  } finally {
    if (paymentId) await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('evidencia v2 exige reconciliación y ledger exactos, respeta la reserva y no recicla el anticipo consumido', async () => {
  const suffix = randomUUID()
  const contactId = `contact_bound_evidence_${suffix}`
  const agentId = `agent_bound_evidence_${suffix}`
  const paymentId = `payment_bound_evidence_${suffix}`
  const reconciliationId = `carec_bound_evidence_${suffix}`
  const appointmentRequestId = `conv-v2-attempt:${createHash('sha256').update(suffix).digest('hex')}`
  const requirement = { mode: 'fixed', amount: 999, currency: 'USD' }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente evidencia ligada', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )

    const unrelated = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(unrelated.ok, false)

    const processingDetail = {
      agentId,
      status: 'processing',
      attempts: 1,
      claimToken: `claim_${suffix}`,
      leaseUntilAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      verifiedEventAppliedAt: new Date().toISOString(),
      ledgerPaymentId: paymentId,
      sourceEventId: `source_${suffix}`,
      amount: 300,
      currency: 'MXN',
      paymentEnvironment: 'live',
      paymentPurpose: 'appointment_deposit',
      appointmentDeposit: true
    }
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: processingDetail,
      throwOnError: true
    })

    const exactResume = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(exactResume.ok, true, JSON.stringify(exactResume))
    assert.equal(exactResume.evidence.paymentId, paymentId)
    assert.equal(exactResume.evidence.amount, 300)
    assert.equal(exactResume.evidence.currency, 'MXN')

    const wrongAgent = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId: `other_${agentId}`,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(wrongAgent.ok, false)

    const completedDetail = {
      ...processingDetail,
      status: 'completed',
      claimToken: null,
      leaseUntilAt: null,
      result: { matched: true, signal: 'deposit_payment_verified' }
    }
    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify(completedDetail), reconciliationId]
    )
    const completed = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(completed.ok, true)

    const consumptionId = `${reconciliationId}_consumed`
    await recordConversationalAgentEvent({
      eventId: consumptionId,
      contactId,
      eventType: 'deposit_payment_consumed',
      detail: {
        status: 'reserved',
        agentId,
        reconciliationId,
        ledgerPaymentId: paymentId,
        appointmentRequestId,
        paymentPurpose: 'appointment_deposit'
      },
      throwOnError: true
    })
    const sameReservation = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(sameReservation.ok, true)
    const differentRequest = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      appointmentRequestId: `conv-v2-attempt:${createHash('sha256').update(`other_${suffix}`).digest('hex')}`,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(differentRequest.ok, false)

    await db.run(
      'UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?',
      [JSON.stringify({
        status: 'consumed',
        agentId,
        reconciliationId,
        ledgerPaymentId: paymentId,
        appointmentRequestId,
        appointmentId: `appointment_${suffix}`,
        paymentPurpose: 'appointment_deposit'
      }), consumptionId]
    )
    const consumed = await findVerifiedPaymentEvidence({
      database: db,
      contactId,
      agentId,
      nativeRuntime: true,
      requiredPurpose: 'appointment_deposit',
      reconciliationId,
      appointmentRequestId,
      requirement,
      accountCurrency: 'USD'
    })
    assert.equal(consumed.ok, false)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('consume del anticipo revalida el ledger y conserva la reserva si el pago dejó de estar confirmado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_consume_revalidation_${suffix}`
  const agentId = `agent_consume_revalidation_${suffix}`
  const paymentId = `payment_consume_revalidation_${suffix}`
  const reconciliationId = `carec_consume_revalidation_${suffix}`
  const appointmentId = `appointment_consume_revalidation_${suffix}`
  const appointmentRequestId = `conv-v2-attempt:${createHash('sha256').update(suffix).digest('hex')}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente revalidación consumo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 300, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 300,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })
    await reserveConversationalAppointmentDepositEvidence({
      reconciliationId,
      contactId,
      agentId,
      paymentId,
      appointmentRequestId
    })
    await db.run(
      `INSERT INTO appointments (
        id, contact_id, status, appointment_status, start_time, end_time
      ) VALUES (?, ?, 'confirmed', 'confirmed', '2026-08-04T22:00:00.000Z', '2026-08-04T23:00:00.000Z')`,
      [appointmentId, contactId]
    )
    await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, appointment_id, response_json,
        created_at, updated_at
      ) VALUES (?, ?, 'completed', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [appointmentRequestId, createHash('sha256').update(`request_${suffix}`).digest('hex'), appointmentId]
    )

    await db.run(
      `UPDATE payments
       SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [paymentId]
    )

    await assert.rejects(
      consumeConversationalAppointmentDepositEvidence({
        reconciliationId,
        contactId,
        agentId,
        paymentId,
        appointmentRequestId,
        appointmentId
      }),
      /anticipo ya no coincide/i
    )
    const reservation = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(reservation.detail_json).status, 'reserved')
  } finally {
    await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [appointmentRequestId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('lease vencida recupera un anticipo sólo antes de la cita y una cita activa impide doble gasto', async () => {
  const suffix = randomUUID()
  const contactId = `contact_deposit_lease_${suffix}`
  const agentId = `agent_deposit_lease_${suffix}`
  const paymentId = `payment_deposit_lease_${suffix}`
  const reconciliationId = `carec_deposit_lease_${suffix}`
  const initialRequestId = `conv-v2-attempt:${createHash('sha256').update(`initial_${suffix}`).digest('hex')}`
  const candidateRequestIds = ['candidate_a', 'candidate_b'].map((label) => (
    `conv-v2-attempt:${createHash('sha256').update(`${label}_${suffix}`).digest('hex')}`
  ))
  const finalRequestId = `conv-v2-attempt:${createHash('sha256').update(`final_${suffix}`).digest('hex')}`
  const appointmentId = `appointment_deposit_lease_${suffix}`

  const reserve = (appointmentRequestId) => reserveConversationalAppointmentDepositEvidence({
    reconciliationId,
    contactId,
    agentId,
    paymentId,
    appointmentRequestId
  })
  const expireReservation = async () => {
    const row = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    const detail = JSON.parse(row.detail_json)
    detail.leaseUntilAt = '2000-01-01T00:00:00.000Z'
    await db.run(
      `UPDATE conversational_agent_events SET detail_json = ?
       WHERE id = ? AND detail_json = ?`,
      [JSON.stringify(detail), `${reconciliationId}_consumed`, row.detail_json]
    )
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente lease anticipo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
      ) VALUES (?, ?, 500, 'MXN', 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 500,
        currency: 'MXN',
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })

    const initial = await reserve(initialRequestId)
    assert.equal(initial.reserved, true)
    assert.ok(initial.claimToken)
    assert.ok(initial.leaseUntilAt)
    await expireReservation()

    const raced = await Promise.allSettled(candidateRequestIds.map((requestId) => reserve(requestId)))
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(raced.filter((result) => result.status === 'rejected').length, 1)
    const winnerIndex = raced.findIndex((result) => result.status === 'fulfilled')
    const winnerRequestId = candidateRequestIds[winnerIndex]
    assert.equal(raced[winnerIndex].value.recovered, true)
    const recoveredRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    const recoveredDetail = JSON.parse(recoveredRow.detail_json)
    assert.equal(recoveredDetail.appointmentRequestId, winnerRequestId)
    assert.equal(recoveredDetail.previousAppointmentRequestId, initialRequestId)
    assert.equal(recoveredDetail.recoveryReason, 'appointment_request_missing')

    await db.run(
      `INSERT INTO appointments (
        id, contact_id, status, appointment_status, start_time, end_time
      ) VALUES (?, ?, 'confirmed', 'confirmed', '2026-08-11T22:00:00.000Z', '2026-08-11T23:00:00.000Z')`,
      [appointmentId, contactId]
    )
    await db.run(
      `INSERT INTO appointment_creation_requests (
        client_request_id, request_hash, status, appointment_id, response_json,
        created_at, updated_at
      ) VALUES (?, ?, 'completed', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [winnerRequestId, createHash('sha256').update(`winner_${suffix}`).digest('hex'), appointmentId]
    )
    await expireReservation()

    await assert.rejects(
      reserve(finalRequestId),
      /cita activa|estado incierto|reservado para otra cita/i
    )
    const protectedRow = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(protectedRow.detail_json).appointmentRequestId, winnerRequestId)

    await db.run(
      `UPDATE appointments SET appointment_status = 'cancelled', status = 'cancelled'
       WHERE id = ?`,
      [appointmentId]
    )
    const afterCancellation = await reserve(finalRequestId)
    assert.equal(afterCancellation.recovered, true)
    const releasedCanonical = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_payment_consumed'`,
      [`${reconciliationId}_consumed`]
    )
    assert.equal(JSON.parse(releasedCanonical.detail_json).appointmentRequestId, finalRequestId)
    assert.equal(JSON.parse(releasedCanonical.detail_json).recoveryReason, 'canonical_appointment_inactive')
  } finally {
    await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id IN (?, ?)', [
      candidateRequestIds[0],
      candidateRequestIds[1]
    ]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('book_appointment recupera end-to-end una lease vencida y el controller consume el fencing vigente', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_deposit_fence_${suffix}`
  const contactId = `contact_deposit_fence_${suffix}`
  const agentId = `agent_deposit_fence_${suffix}`
  const paymentId = `payment_deposit_fence_${suffix}`
  const reconciliationId = `carec_deposit_fence_${suffix}`
  const oldRequestId = `conv-v2-attempt:${createHash('sha256').update(`old_${suffix}`).digest('hex')}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 42 }).startOf('day')
  const monday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = monday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_${suffix}`,
      name: 'Agenda fencing anticipo',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente fencing anticipo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_mode, payment_provider,
        paid_at, created_at, updated_at
       ) VALUES (?, ?, 500, ?, 'paid', 'live', 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, currency]
    )
    await recordConversationalAgentEvent({
      eventId: reconciliationId,
      contactId,
      eventType: 'payment_reconciliation_v2',
      detail: {
        agentId,
        status: 'completed',
        ledgerPaymentId: paymentId,
        amount: 500,
        currency,
        paymentEnvironment: 'live',
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        result: { matched: true, signal: 'deposit_payment_verified' }
      },
      throwOnError: true
    })
    await reserveConversationalAppointmentDepositEvidence({
      reconciliationId,
      contactId,
      agentId,
      paymentId,
      appointmentRequestId: oldRequestId
    })
    const reservationId = `${reconciliationId}_consumed`
    const reservation = await db.get('SELECT detail_json FROM conversational_agent_events WHERE id = ?', [reservationId])
    const expired = JSON.parse(reservation.detail_json)
    expired.leaseUntilAt = '2000-01-01T00:00:00.000Z'
    await db.run('UPDATE conversational_agent_events SET detail_json = ? WHERE id = ?', [JSON.stringify(expired), reservationId])

    const ctx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId },
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        deposit: { enabled: true, mode: 'fixed', amount: 500, currency, methods: { paymentLink: true } }
      }
    ], {
      contactId,
      agentId,
      dryRun: false,
      executionId: `message_deposit_fence_${suffix}`,
      accountLocale: { currency }
    })
    ctx.config.id = agentId
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({ startTime: slot.toUTC().toISO(), title: null, notes: null }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const finalReservation = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [reservationId]
    )).detail_json)
    assert.equal(finalReservation.status, 'consumed')
    assert.notEqual(finalReservation.appointmentRequestId, oldRequestId)
    assert.ok(finalReservation.claimToken)
    assert.ok(finalReservation.appointmentId)
  } finally {
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('binding de comprobante v2 es atómico, idempotente por mensaje y falla cerrado ante mutación', async () => {
  const suffix = randomUUID()
  const contactId = `contact_proof_binding_${suffix}`
  const agentId = `agent_proof_binding_${suffix}`
  const mediaMessageId = `media_proof_binding_${suffix}`
  const triggerName = `fail_proof_binding_${suffix.replaceAll('-', '_')}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente proof binding', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    const input = {
      contactId,
      amount: 250,
      currency: 'MXN',
      agentId,
      mediaUrl: 'https://example.com/proof-binding.jpg',
      mediaMessageId,
      conversationalBinding: {
        bindingKey: mediaMessageId,
        executionId: `message_${suffix}`,
        paymentPurpose: 'appointment_deposit',
        appointmentDeposit: true,
        confidence: 0.99
      }
    }
    const [first, crossAgentRace] = await Promise.all([
      registerAgentTransferPaymentProofForReview(input),
      registerAgentTransferPaymentProofForReview({
        ...input,
        agentId: `other_${agentId}`
      })
    ])
    assert.equal(crossAgentRace.paymentId, first.paymentId)
    assert.equal([first, crossAgentRace].filter((result) => result.alreadyRegistered === false).length, 1)
    const replay = await registerAgentTransferPaymentProofForReview(input)
    assert.equal(replay.paymentId, first.paymentId)
    assert.equal(replay.alreadyRegistered, true)

    await assert.rejects(
      registerAgentTransferPaymentProofForReview({ ...input, amount: 275 }),
      /incompatible|revisión humana/i
    )
    const rows = await db.all('SELECT id FROM payments WHERE contact_id = ?', [contactId])
    assert.equal(rows.length, 1)
    const binding = await db.get(
      `SELECT detail_json FROM conversational_agent_events
       WHERE id = ? AND event_type = 'deposit_transfer_pending_review'`,
      [first.bindingEventId]
    )
    assert.equal(JSON.parse(binding.detail_json).ledgerPaymentId, first.paymentId)

    await db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON conversational_agent_events
      WHEN NEW.contact_id = '${contactId}' AND NEW.event_type = 'deposit_transfer_pending_review'
      BEGIN
        SELECT RAISE(ABORT, 'binding failure injected');
      END
    `)
    await assert.rejects(
      registerAgentTransferPaymentProofForReview({
        ...input,
        mediaMessageId: `media_rollback_${suffix}`,
        conversationalBinding: {
          ...input.conversationalBinding,
          bindingKey: `media_rollback_${suffix}`,
          executionId: `message_rollback_${suffix}`
        }
      }),
      /binding failure injected/
    )
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM payments WHERE contact_id = ?', [contactId])).total), 1)
  } finally {
    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('si el cierre de una cita v2 falla, el siguiente inbound repara la cita existente sin duplicarla', async () => {
  const suffix = randomUUID()
  const calendarId = `calendar_completion_recovery_${suffix}`
  const contactId = `contact_completion_recovery_${suffix}`
  const agentId = `agent_completion_recovery_${suffix}`
  const triggerName = `fail_appointment_signal_${suffix.replaceAll('-', '_')}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slot = nextTuesday.set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `ghl_${calendarId}`,
      locationId: `location_${suffix}`,
      name: 'Agenda recovery cierre',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{ daysOfTheWeek: [2], hours: [{ openHour: 16, openMinute: 0, closeHour: 17, closeMinute: 0 }] }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente recovery cierre', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_state (contact_id, agent_id, channel, status, signal, created_at, updated_at)
       VALUES (?, ?, 'whatsapp', 'active', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, agentId]
    )
    await db.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF signal ON conversational_agent_state
      WHEN OLD.contact_id = '${contactId}' AND NEW.signal = 'appointment_booked'
      BEGIN
        SELECT RAISE(ABORT, 'signal failure injected');
      END
    `)

    const firstCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `first_message_${suffix}` })
    firstCtx.config.id = agentId
    const first = await createConversationalTools(firstCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({ startTime: slot.toUTC().toISO(), title: null, notes: null }))
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.completionSyncWarning, true)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const failedState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(failedState.status, 'active')
    assert.equal(failedState.signal, null)

    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`)
    const retryCtx = v2Context([
      { id: 'schedule_appointment', enabled: true, calendarId }
    ], { contactId, dryRun: false, agentId, executionId: `second_message_${suffix}` })
    retryCtx.config.id = agentId
    const retry = await createConversationalTools(retryCtx)
      .find((item) => item.name === 'book_appointment')
      .invoke(null, JSON.stringify({ startTime: slot.plus({ weeks: 1 }).toUTC().toISO(), title: null, notes: null }))
    assert.equal(retry.ok, true, JSON.stringify(retry))
    assert.equal(retry.alreadyBooked, true)
    assert.equal(retry.appointment.startTime, slot.toUTC().toISO())
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE contact_id = ?', [contactId])).total), 1)
    const repairedState = await db.get(
      'SELECT status, signal FROM conversational_agent_state WHERE contact_id = ? AND agent_id = ?',
      [contactId, agentId]
    )
    assert.equal(repairedState.status, 'completed')
    assert.equal(repairedState.signal, 'appointment_booked')
  } finally {
    await db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => {})
    await db.run(
      `DELETE FROM appointment_creation_requests
       WHERE appointment_id IN (SELECT id FROM appointments WHERE contact_id = ?)`,
      [contactId]
    ).catch(() => {})
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
