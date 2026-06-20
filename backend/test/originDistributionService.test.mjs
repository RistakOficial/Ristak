import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  getMessageAnalyticsSummary,
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
  await db.run('DELETE FROM meta_social_messages WHERE id LIKE ? OR contact_id LIKE ?', [`origin_${marker}%`, `origin_${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_contacts WHERE id LIKE ? OR contact_id LIKE ?', [`origin_${marker}%`, `origin_${marker}%`]).catch(() => undefined)
  await db.run('DELETE FROM email_messages WHERE id LIKE ? OR contact_id LIKE ?', [`origin_${marker}%`, `origin_${marker}%`]).catch(() => undefined)
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

test('message analytics summary combines WhatsApp, Messenger, Instagram and Email inbound messages', async () => {
  const marker = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const range = {
    startUtc: '2099-07-01T00:00:00.000Z',
    endUtc: '2099-07-31T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }
  const contactIds = {
    whatsapp: `origin_${marker}_msg_whatsapp`,
    messenger: `origin_${marker}_msg_messenger`,
    instagram: `origin_${marker}_msg_instagram`,
    email: `origin_${marker}_msg_email`
  }

  await cleanup(marker)

  try {
    for (const [index, [channel, id]] of Object.entries(contactIds).entries()) {
      await insertContact({
        id,
        phone: `+52157000${marker.slice(-4)}${index + 1}`,
        source: channel,
        createdAt: '2099-07-10T18:00:00.000Z'
      })
    }

    await insertInboundMessage({
      id: `origin_${marker}_wa`,
      contactId: contactIds.whatsapp,
      phone: `+52157000${marker.slice(-4)}1`,
      timestamp: '2099-07-10T18:00:00.000Z',
      sourceId: `meta_ad_${marker}`
    })

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, direction,
        message_type, message_text, message_timestamp, referral_json,
        created_at, updated_at
      )
      VALUES (?, 'messenger', ?, ?, ?, 'inbound', 'text', 'Hola Messenger', ?, ?, ?, ?)
    `, [
      `origin_${marker}_messenger`,
      `meta_${marker}_messenger`,
      contactIds.messenger,
      `sender_${marker}_messenger`,
      '2099-07-11T18:00:00.000Z',
      JSON.stringify({ source: 'ADS', source_id: `meta_ad_${marker}` }),
      '2099-07-11T18:00:00.000Z',
      '2099-07-11T18:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, direction,
        message_type, message_text, message_timestamp, created_at, updated_at
      )
      VALUES (?, 'instagram', ?, ?, ?, 'inbound', 'text', 'Hola Instagram', ?, ?, ?)
    `, [
      `origin_${marker}_instagram`,
      `meta_${marker}_instagram`,
      contactIds.instagram,
      `sender_${marker}_instagram`,
      '2099-07-12T18:00:00.000Z',
      '2099-07-12T18:00:00.000Z',
      '2099-07-12T18:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO email_messages (
        id, contact_id, direction, status, from_email, to_email, subject,
        message_text, message_timestamp, created_at, updated_at
      )
      VALUES (?, ?, 'inbound', 'received', ?, 'owner@example.com', 'Pregunta', 'Hola Email', ?, ?, ?)
    `, [
      `origin_${marker}_email`,
      contactIds.email,
      `lead_${marker}@example.com`,
      '2099-07-13T18:00:00.000Z',
      '2099-07-13T18:00:00.000Z',
      '2099-07-13T18:00:00.000Z'
    ])

    const summary = await getMessageAnalyticsSummary(range, { groupBy: 'month' })

    assert.equal(summary.metrics.inboundMessages, 4)
    assert.equal(summary.metrics.conversations, 4)
    assert.equal(summary.metrics.contacts, 4)
    assert.deepEqual(summary.trend, [{ label: '2099-07', messages: 4 }])

    const channels = new Map(summary.filters.channels.map(item => [item.value, item.count]))
    assert.equal(channels.get('whatsapp'), 1)
    assert.equal(channels.get('messenger'), 1)
    assert.equal(channels.get('instagram'), 1)
    assert.equal(channels.get('email'), 1)

    const sources = new Map(summary.filters.sources.map(item => [item.value, item.count]))
    assert.equal(sources.get('Meta Ads'), 1)
    assert.equal(sources.get('Messenger'), 1)
    assert.equal(sources.get('Instagram'), 1)
    assert.equal(sources.get('Email'), 1)

    const filtered = await getMessageAnalyticsSummary(range, {
      groupBy: 'month',
      filters: { channels: ['instagram'] }
    })
    assert.equal(filtered.metrics.inboundMessages, 1)
    assert.equal(filtered.metrics.conversations, 1)
  } finally {
    await cleanup(marker)
  }
})
