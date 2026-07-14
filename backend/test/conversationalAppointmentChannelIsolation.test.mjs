import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { __conversationalToolsTestHooks } from '../src/agents/conversational/tools.js'

const {
  persistNativeAppointmentOffer,
  hasNativeAppointmentDepositCollectionScope
} = __conversationalToolsTestHooks

test('una oferta nueva en otro canal no reemplaza la oferta pendiente del canal original', async () => {
  const suffix = randomUUID()
  const contactId = `contact_channel_offer_${suffix}`
  const agentId = `agent_channel_offer_${suffix}`
  const calendarId = `calendar_channel_offer_${suffix}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto multicanal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    const common = {
      config: {
        id: agentId,
        capabilitiesConfig: {
          items: [{
            id: 'schedule_appointment',
            enabled: true,
            calendarId,
            bookingOwner: 'ai'
          }]
        }
      },
      calendarId,
      startTime: '2099-01-05T17:00:00.000Z',
      localLabel: 'lunes 5 de enero de 2099 a las 11:00 a.m.',
      timezone: 'America/Ciudad_Juarez'
    }
    const whatsapp = await persistNativeAppointmentOffer({
      ...common,
      ctx: {
        contactId,
        agentId,
        channel: 'whatsapp',
        executionId: `message_whatsapp_${suffix}`,
        dryRun: false
      }
    })
    const instagram = await persistNativeAppointmentOffer({
      ...common,
      ctx: {
        contactId,
        agentId,
        channel: 'instagram',
        executionId: `message_instagram_${suffix}`,
        dryRun: false
      }
    })

    assert.equal(whatsapp.ok, true, JSON.stringify(whatsapp))
    assert.equal(instagram.ok, true, JSON.stringify(instagram))
    const rows = await db.all(
      `SELECT detail_json FROM conversational_agent_events
       WHERE contact_id = ? AND agent_id = ? AND event_type = 'appointment_slot_offer_created'`,
      [contactId, agentId]
    )
    const details = rows.map((row) => JSON.parse(row.detail_json))
    assert.equal(details.length, 2)
    assert.deepEqual(
      details.map((detail) => [detail.channel, detail.status]).sort(),
      [['instagram', 'active'], ['whatsapp', 'active']]
    )
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un intento de anticipo de otro canal no convierte un cobro normal en anticipo de cita', async () => {
  const suffix = randomUUID()
  const contactId = `contact_channel_intent_${suffix}`
  const agentId = `agent_channel_intent_${suffix}`
  const intentId = `intent_channel_${suffix}`

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto multicanal', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO conversational_agent_events (id, contact_id, agent_id, event_type, detail_json)
       VALUES (?, ?, ?, 'appointment_deposit_intent_pending', ?)`,
      [intentId, contactId, agentId, JSON.stringify({
        channel: 'instagram',
        status: 'pending',
        methods: { paymentLink: true, bankTransfer: false }
      })]
    )

    const config = { id: agentId }
    assert.equal(await hasNativeAppointmentDepositCollectionScope({
      ctx: { contactId, agentId, channel: 'whatsapp', dryRun: false },
      config,
      method: 'paymentLink'
    }), false)
    assert.equal(await hasNativeAppointmentDepositCollectionScope({
      ctx: { contactId, agentId, channel: 'instagram', dryRun: false },
      config,
      method: 'paymentLink'
    }), true)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
