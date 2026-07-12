import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, databaseReady } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'
import {
  prepareConversationalAgentTestRun,
  recordConversationalAgentPreviewEffects
} from '../src/services/conversationalAgentTestService.js'
import {
  CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT,
  buildConversationalAppointmentPreviewOfferEventId,
  buildConversationalAppointmentPreviewScopeId
} from '../src/services/conversationalAppointmentPreviewOfferService.js'
import { getAccountCurrency } from '../src/utils/accountLocale.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'

await databaseReady
await runVersionedMigrations()

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

test('el webhook sandbox autoriza materializar la oferta aceptada sin cambiar su acceptedExecutionId', async () => {
  const suffix = randomUUID()
  const agentId = `agent_payment_resume_${suffix}`
  const contactId = `contact_payment_resume_${suffix}`
  const calendarId = `calendar_payment_resume_${suffix}`
  const runId = `session_payment_resume_${suffix}`
  const acceptedMessageId = `message_accepted_${suffix}`
  const unauthorizedMessageId = `message_without_payment_binding_${suffix}`
  const resumeMessageId = `message_payment_resume_${suffix}`
  const paymentEffectId = `catfx_payment_resume_${suffix}`
  const username = `tester_payment_resume_${suffix}`
  const currency = await getAccountCurrency()
  const timezone = await getAccountTimezone()
  const slot = DateTime.now().setZone(timezone).plus({ days: 35 }).startOf('day')
    .set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
  const startTime = slot.toUTC().toISO()
  const endTime = slot.plus({ hours: 1 }).toUTC().toISO()
  let userId = ''
  let offerEventId = ''

  const capabilitiesConfig = {
    schemaVersion: 2,
    testMode: { enabled: true, cleanupAfterMinutes: 5, notify: false },
    items: [
      {
        id: 'schedule_appointment',
        enabled: true,
        calendarId,
        bookingOwner: 'human',
        allowOverlaps: false
      },
      {
        id: 'collect_payment',
        enabled: true,
        paymentMode: 'deposit',
        chargeType: 'deposit',
        gateway: 'stripe',
        currency,
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 500,
          currency,
          methods: { paymentLink: true, bankTransfer: false }
        }
      }
    ]
  }
  const effects = {
    enabled: true,
    scheduleAppointment: true,
    collectPayment: true,
    assignUser: false,
    notifyOwner: false
  }

  try {
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, is_active, created_at, updated_at)
       VALUES (?, 'test-hash', 'Usuario pago sandbox', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [username]
    )
    userId = String((await db.get('SELECT id FROM users WHERE username = ?', [username]))?.id || '')
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Contacto pago sandbox', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `+521${String(Math.floor(Math.random() * 10_000_000_000)).padStart(10, '0')}`]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: `location_${suffix}`,
      name: 'Agenda pago sandbox',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [{
        daysOfTheWeek: [slot.weekday],
        hours: [{ openHour: 13, openMinute: 0, closeHour: 16, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await db.run(
      `INSERT INTO conversational_agents (id, name, enabled, runtime_mode, capabilities_config)
       VALUES (?, 'Agente pago sandbox', 1, 'tool_calling_v2', ?)`,
      [agentId, JSON.stringify(capabilitiesConfig)]
    )

    const acceptedRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: acceptedMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const previewScopeId = buildConversationalAppointmentPreviewScopeId({
      testSessionId: runId,
      requestedByUserId: userId,
      agentId
    })
    offerEventId = buildConversationalAppointmentPreviewOfferEventId(previewScopeId)
    const offerDetailJson = JSON.stringify({
      agentId,
      contactId,
      calendarId,
      startTime,
      localLabel: 'el horario confirmado',
      timezone,
      channel: 'whatsapp',
      executionId: `test_offer_${suffix}`,
      offerText: 'Tengo disponible el horario confirmado.',
      status: 'accepted',
      offeredAt: new Date().toISOString(),
      acceptedAt: new Date().toISOString(),
      acceptedExecutionId: acceptedRun.executionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      previewScopeId
    })
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [offerEventId, contactId, agentId, CONVERSATIONAL_APPOINTMENT_PREVIEW_OFFER_EVENT, offerDetailJson]
    )
    const appointmentOfferBinding = {
      previewScopeId,
      offerEventId,
      offerFingerprint: sha256(offerDetailJson),
      calendarId,
      startTime,
      acceptedExecutionId: acceptedRun.executionId
    }
    await db.run(
      `INSERT INTO conversational_agent_test_effects (
         id, run_id, message_id, effect_type, request_hash, status, payload_json,
         attempt_count, notification_status, created_at, updated_at
       ) VALUES (?, ?, ?, 'payment', ?, 'paid_test', ?, 1, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentEffectId,
        runId,
        `message_payment_${suffix}`,
        sha256(JSON.stringify(appointmentOfferBinding)),
        JSON.stringify({
          amount: 500,
          currency,
          paymentMode: 'test',
          paymentConfirmed: true,
          appointmentOfferBinding
        })
      ]
    )

    const appointmentAction = (reusedForTestPaymentResume) => ({
      type: 'request_human_booking',
      calendarId,
      startTime,
      endTime,
      title: 'Cita confirmada después del anticipo',
      confirmationEvidence: {
        evidenceVerified: true,
        nativeToolDecision: true,
        selectionMode: 'accepted_prior_offer',
        selectedStartTime: startTime,
        customerQuote: 'sí, ese horario',
        assistantOfferQuote: 'el horario confirmado',
        offerEventId,
        reusedForTestPaymentResume
      },
      participants: [],
      outcome: { status: 'simulated' }
    })
    const unauthorizedRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: unauthorizedMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    const blocked = await recordConversationalAgentPreviewEffects({
      runContext: unauthorizedRun,
      actions: [appointmentAction(false)]
    })
    assert.equal(blocked[0].status, 'failed')
    assert.match(blocked[0].summary, /oferta cambió/i)

    const resumeRun = await prepareConversationalAgentTestRun({
      testRunId: runId,
      testMessageId: resumeMessageId,
      agentId,
      requestedByUserId: userId,
      contactId,
      effects
    })
    assert.notEqual(resumeRun.executionId, acceptedRun.executionId)
    const result = await recordConversationalAgentPreviewEffects({
      runContext: resumeRun,
      actions: [appointmentAction(true)]
    })

    assert.equal(result.length, 1)
    assert.equal(result[0].status, 'recorded', JSON.stringify(result[0]))
    const materialized = JSON.parse((await db.get(
      'SELECT detail_json FROM conversational_agent_events WHERE id = ?',
      [offerEventId]
    )).detail_json)
    assert.equal(materialized.status, 'materialized')
    assert.equal(materialized.acceptedExecutionId, acceptedRun.executionId)
    assert.equal(materialized.materializationExecutionId, resumeRun.executionId)
    assert.equal(materialized.materializationPaymentEffectId, paymentEffectId)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE id = ?', [offerEventId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_effects WHERE run_id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [runId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
})
