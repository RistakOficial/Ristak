import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import {
  getMessageAnalyticsSummary,
  getWhatsAppApiAnalyticsSummary,
  getWhatsAppApiSourceBreakdown
} from '../src/services/originDistributionService.js'
import { runMessageAnalyticsProjectionBackfill } from '../src/services/messageAnalyticsProjectionService.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

async function syncMessageProjection() {
  await db.exec(await readFile(
    new URL('../migrations/versioned/114_message_analytics_projection.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/115_message_analytics_range_rollup.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/118_message_analytics_phone_projection.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.run(`
    INSERT INTO app_config(config_key, config_value, created_at, updated_at)
    VALUES ('account_timezone', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value,
      updated_at = CURRENT_TIMESTAMP
  `)
  invalidateTimezoneCache()

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await runMessageAnalyticsProjectionBackfill({
      batchSize: 100,
      maxBackfillBatches: 3,
      maxQueueBatches: 6
    })
    if (result.ready) return
  }
  assert.fail('read model de mensajes no convergió')
}

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

test('WhatsApp origin keeps the first source per identity instead of counting one conversation twice', async () => {
  const marker = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const contactId = `origin_${marker}_first_source`
  const phone = `+52158000${marker.slice(-5)}1`
  const range = {
    startUtc: '2099-06-01T00:00:00.000Z',
    endUtc: '2099-06-30T23:59:59.999Z',
    appliedTimezone: 'UTC'
  }

  await cleanup(marker)
  try {
    await insertContact({ id: contactId, phone })
    await insertInboundMessage({
      id: `origin_${marker}_first`,
      contactId,
      phone,
      timestamp: '2099-06-10T18:00:00.000Z'
    })
    await insertInboundMessage({
      id: `origin_${marker}_later_ad`,
      contactId,
      phone,
      sourceId: `meta_ad_${marker}`,
      timestamp: '2099-06-10T19:00:00.000Z'
    })

    const breakdown = await getWhatsAppApiSourceBreakdown(range, { limit: 10 })
    const byName = new Map(breakdown.map(item => [item.name, item.value]))
    assert.equal(byName.get('WhatsApp'), 1)
    assert.equal(byName.get('Meta Ads') || 0, 0)
    assert.equal(breakdown.reduce((sum, item) => sum + item.value, 0), 1)
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

    await syncMessageProjection()
    const summary = await getMessageAnalyticsSummary(range, { groupBy: 'month' })

    assert.equal(summary.metrics.inboundMessages, 4)
    assert.equal(summary.metrics.conversations, 4)
    assert.equal(summary.metrics.contacts, 4)
    assert.deepEqual(summary.trend, [{ label: '2099-07', messages: 4 }])
    assert.equal(summary.status.messageProjection, 'ready')
    assert.equal(summary.status.messageProjectionComplete, true)
    assert.equal(summary.status.messageProjectionReadPath, 'range_rollup')
    assert.equal(summary.performance.readPath, 'range_rollup')
    assert.ok(Number(summary.performance.activeGeneration) > 0)

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

    const filteredBySource = await getMessageAnalyticsSummary(range, {
      groupBy: 'month',
      filters: { sources: ['meta ads'] }
    })
    assert.equal(filteredBySource.metrics.inboundMessages, 1)
    assert.equal(filteredBySource.metrics.conversations, 1)
    assert.equal(filteredBySource.metrics.contacts, 1)

    await assert.rejects(
      getMessageAnalyticsSummary({
        ...range,
        appliedTimezone: 'America/New_York'
      }, { groupBy: 'month' }),
      error => error?.code === 'message_analytics_projection_warming' &&
        error?.status === 503 && error?.retryable === true
    )
  } finally {
    await cleanup(marker)
  }
})

test('messages-summary no conserva fallback raw y expone warming como 503 reintentable', async () => {
  const [serviceSource, controllerSource] = await Promise.all([
    readFile(new URL('../src/services/originDistributionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/trackingController.js', import.meta.url), 'utf8')
  ])
  const serviceHandler = serviceSource.slice(
    serviceSource.indexOf('export async function getMessageAnalyticsSummary'),
    serviceSource.indexOf('export async function getWhatsAppApiAnalyticsSummary')
  )
  const controllerHandler = controllerSource.slice(
    controllerSource.indexOf('export async function getMessagesSummary'),
    controllerSource.indexOf('export async function getContactConversionsList')
  )

  assert.match(serviceHandler, /queryMessageAnalyticsProjectionAggregateRows/)
  assert.match(serviceHandler, /schedule:\s*false/)
  assert.doesNotMatch(serviceHandler, /whatsapp_api_messages|meta_social_messages|email_messages/)
  assert.match(serviceHandler, /performance:\s*\{[\s\S]*readPath:/)
  assert.match(controllerHandler, /X-Ristak-Read-Path/)
  assert.match(controllerHandler, /message_analytics_projection_warming/)
  assert.match(controllerHandler, /Retry-After[\s\S]*res\.status\(503\)/)
})
