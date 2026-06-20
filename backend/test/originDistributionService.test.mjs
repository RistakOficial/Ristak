import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  getWhatsAppApiAnalyticsSummary,
  getWhatsAppApiSourceBreakdown
} from '../src/services/originDistributionService.js'

async function cleanup(marker) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id LIKE ?', [`origin_${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ? OR contact_id LIKE ? OR phone LIKE ?', [
    `origin_${marker}%`,
    `origin_${marker}%`,
    `%${marker}%`
  ]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [`phone_${marker}`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ? OR phone LIKE ?', [`origin_${marker}%`, `%${marker}%`]).catch(() => undefined)
}

async function insertContact({ id, phone, source = 'WhatsApp_API', attributionAdId = null, createdAt = '2099-06-10T18:00:00.000Z' }) {
  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, source, attribution_ad_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    phone,
    `${id}@local.invalid`,
    `Contacto ${id}`,
    source,
    attributionAdId,
    createdAt,
    createdAt
  ])
}

async function insertInboundMessage({ id, contactId, phone, timestamp, sourceId = null }) {
  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, provider, origin, ycloud_message_id, contact_id, phone,
      direction, message_type, message_text, detected_source_id,
      message_timestamp, created_at, updated_at
    )
    VALUES (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, ?, 'inbound', 'text', 'Hola', ?, ?, ?, ?)
  `, [
    id,
    id,
    contactId,
    phone,
    sourceId,
    timestamp,
    timestamp,
    timestamp
  ])
}

test('WhatsApp origin distribution attributes ad-backed contacts to Meta Ads before WhatsApp direct', async () => {
  const marker = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const adContactId = `origin_${marker}_ad`
  const directContactId = `origin_${marker}_direct`
  const range = {
    startUtc: '2099-06-01T00:00:00.000Z',
    endUtc: '2099-06-30T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  await cleanup(marker)

  try {
    await insertContact({
      id: adContactId,
      phone: `+52155000${marker.slice(-5)}1`,
      attributionAdId: `meta_ad_${marker}`
    })
    await insertContact({
      id: directContactId,
      phone: `+52155000${marker.slice(-5)}2`
    })

    await insertInboundMessage({
      id: `origin_${marker}_msg_ad`,
      contactId: adContactId,
      phone: `+52155000${marker.slice(-5)}1`,
      timestamp: '2099-06-10T18:00:00.000Z'
    })
    await insertInboundMessage({
      id: `origin_${marker}_msg_direct`,
      contactId: directContactId,
      phone: `+52155000${marker.slice(-5)}2`,
      timestamp: '2099-06-11T18:00:00.000Z'
    })

    const breakdown = await getWhatsAppApiSourceBreakdown(range, { limit: 10 })
    const byName = new Map(breakdown.map(item => [item.name, item.value]))

    assert.equal(byName.get('Meta Ads'), 1)
    assert.equal(byName.get('WhatsApp'), 1)
  } finally {
    await cleanup(marker)
  }
})

test('WhatsApp analytics summary returns card metrics and trend for the selected range', async () => {
  const marker = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const adContactId = `origin_${marker}_ad_summary`
  const directContactId = `origin_${marker}_direct_summary`
  const adPhone = `+52156000${marker.slice(-5)}1`
  const directPhone = `+52156000${marker.slice(-5)}2`
  const range = {
    startUtc: '2099-06-01T00:00:00.000Z',
    endUtc: '2099-06-30T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  await cleanup(marker)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, phone_number, display_phone_number, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'connected', '2099-06-01T00:00:00.000Z', '2099-06-01T00:00:00.000Z')
    `, [`phone_${marker}`, '+5215555555555', '+52 1 555 555 5555'])

    await insertContact({
      id: adContactId,
      phone: adPhone,
      attributionAdId: `meta_ad_${marker}`
    })
    await insertContact({
      id: directContactId,
      phone: directPhone
    })

    await insertInboundMessage({
      id: `origin_${marker}_msg_ad_1`,
      contactId: adContactId,
      phone: adPhone,
      timestamp: '2099-06-10T18:00:00.000Z'
    })
    await insertInboundMessage({
      id: `origin_${marker}_msg_ad_2`,
      contactId: adContactId,
      phone: adPhone,
      timestamp: '2099-06-10T18:05:00.000Z',
      sourceId: `meta_ad_${marker}`
    })
    await insertInboundMessage({
      id: `origin_${marker}_msg_direct`,
      contactId: directContactId,
      phone: directPhone,
      timestamp: '2099-06-11T18:00:00.000Z'
    })

    const summary = await getWhatsAppApiAnalyticsSummary(range, { groupBy: 'month' })

    assert.equal(summary.metrics.inboundMessages, 3)
    assert.equal(summary.metrics.conversations, 2)
    assert.equal(summary.metrics.contacts, 2)
    assert.equal(summary.metrics.attributionRate, 50)
    assert.deepEqual(summary.trend, [{ label: '2099-06', messages: 3 }])
    assert.equal(summary.status.connected, true)
    assert.equal(summary.status.hasData, true)
  } finally {
    await cleanup(marker)
  }
})
