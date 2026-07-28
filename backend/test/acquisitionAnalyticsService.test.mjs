import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import { getAcquisitionAnalyticsSummary } from '../src/services/acquisitionAnalyticsService.js'
import { runContactOriginProjectionBackfill } from '../src/services/contactOriginProjectionService.js'
import { runCrmListProjectionBackfill } from '../src/services/crmListProjectionService.js'
import { runMessageAnalyticsProjectionBackfill } from '../src/services/messageAnalyticsProjectionService.js'
import { runTrackingAnalyticsProjectionBackfill } from '../src/services/trackingAnalyticsProjectionService.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

async function converge(run, options, label) {
  let result = null
  for (let attempt = 0; attempt < 80; attempt += 1) {
    result = await run(options)
    if (result?.ready) return result
  }
  assert.fail(`${label} no convergió: ${JSON.stringify(result)}`)
}

function distributionByKey(summary) {
  return Object.fromEntries(summary.distribution.map(item => [item.key, item.value]))
}

test('adquisición conserva poblaciones exactas de sitio, WhatsApp, conversaciones y visitantes', {
  concurrency: false,
  timeout: 60_000
}, async () => {
  await runVersionedMigrations()
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  const marker = `acquisition_${randomUUID().replaceAll('-', '')}`
  const websiteContactId = `${marker}_website`
  const whatsappPaidContactId = `${marker}_whatsapp_paid`
  const whatsappDirectContactId = `${marker}_whatsapp_direct`
  const whatsappPaidPhone = `+52155${marker.slice(-8)}1`
  const whatsappDirectPhone = `+52155${marker.slice(-8)}2`
  const websiteVisitorId = `${marker}_visitor_contact`
  const anonymousVisitorId = `${marker}_visitor_anonymous`
  const startUtc = '2291-03-10T00:00:00.000Z'
  const endUtc = '2291-03-12T23:59:59.999Z'
  const range = { startUtc, endUtc, appliedTimezone: 'UTC' }

  try {
    await db.run(`
      INSERT INTO contacts(
        id, full_name, email, phone, source, visitor_id, created_at, updated_at
      ) VALUES
        (?, 'Contacto sitio', ?, NULL, 'ristak_site:sitio-exacto', ?, ?, ?),
        (?, 'Contacto WhatsApp anuncio', NULL, ?, 'WhatsApp_API', NULL, ?, ?),
        (?, 'Contacto WhatsApp directo', NULL, ?, 'WhatsApp_API', NULL, ?, ?)
    `, [
      websiteContactId,
      `${websiteContactId}@local.invalid`,
      websiteVisitorId,
      '2291-03-10T12:05:00.000Z',
      '2291-03-10T12:05:00.000Z',
      whatsappPaidContactId,
      whatsappPaidPhone,
      '2291-03-11T14:05:00.000Z',
      '2291-03-11T14:05:00.000Z',
      whatsappDirectContactId,
      whatsappDirectPhone,
      '2291-03-11T15:05:00.000Z',
      '2291-03-11T15:05:00.000Z'
    ])

    await db.run(`
      INSERT INTO sessions(
        id, session_id, visitor_id, contact_id, event_name, started_at, created_at,
        page_url, tracking_source, site_type, site_id, site_source_name,
        utm_source, utm_medium, fbclid
      ) VALUES
        (?, ?, ?, ?, 'page_view', ?, ?, 'https://example.test/inicio',
          'native_site', 'page', 'sitio-exacto', 'Facebook', 'facebook', 'cpc', 'fb-web-paid'),
        (?, ?, ?, NULL, 'page_view', ?, ?, 'https://example.test/precios',
          'native_site', 'page', 'sitio-exacto', 'Directo', NULL, NULL, NULL)
    `, [
      `${marker}_session_contact`,
      `${marker}_session_contact`,
      websiteVisitorId,
      websiteContactId,
      '2291-03-10T12:00:00.000Z',
      '2291-03-10T12:00:00.000Z',
      `${marker}_session_anonymous`,
      `${marker}_session_anonymous`,
      anonymousVisitorId,
      '2291-03-12T09:00:00.000Z',
      '2291-03-12T09:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages(
        id, provider, origin, contact_id, phone, direction, message_type,
        message_text, detected_ctwa_clid, detected_source_app,
        message_timestamp, created_at, updated_at
      ) VALUES
        (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, 'inbound',
          'text', 'Primer mensaje', 'ctwa-comprobado', 'instagram', ?, ?, ?),
        (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, 'inbound',
          'text', 'Segundo mensaje', NULL, NULL, ?, ?, ?),
        (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, 'inbound',
          'text', 'Mensaje directo', NULL, NULL, ?, ?, ?)
    `, [
      `${marker}_message_one`,
      whatsappPaidContactId,
      whatsappPaidPhone,
      '2291-03-11T14:00:00.000Z',
      '2291-03-11T14:00:00.000Z',
      '2291-03-11T14:00:00.000Z',
      `${marker}_message_two`,
      whatsappPaidContactId,
      whatsappPaidPhone,
      '2291-03-11T14:01:00.000Z',
      '2291-03-11T14:01:00.000Z',
      '2291-03-11T14:01:00.000Z',
      `${marker}_message_direct`,
      whatsappDirectContactId,
      whatsappDirectPhone,
      '2291-03-11T15:00:00.000Z',
      '2291-03-11T15:00:00.000Z',
      '2291-03-11T15:00:00.000Z'
    ])

    await runCrmListProjectionBackfill({ batchSize: 100, yieldMs: 0 })
    await converge(runTrackingAnalyticsProjectionBackfill, {
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 4,
      maxQueueBatches: 10,
      yieldMs: 0
    }, 'tracking analytics')
    await converge(runMessageAnalyticsProjectionBackfill, {
      batchSize: 100,
      maxBackfillBatches: 4,
      maxQueueBatches: 10,
      yieldMs: 0
    }, 'message analytics')
    await converge(runContactOriginProjectionBackfill, {
      contactBatchSize: 100,
      appointmentBatchSize: 100,
      queueBatchSize: 100,
      maxQueueBatches: 10,
      maxBackfillBatches: 4,
      yieldMs: 0
    }, 'contact origin')

    const contacts = await getAcquisitionAnalyticsSummary(range, {
      population: 'contacts',
      dimension: 'channel',
      groupBy: 'day'
    })
    assert.equal(contacts.total, 3)
    assert.deepEqual(distributionByKey(contacts), {
      website: 1,
      whatsapp: 2
    })
    assert.equal(
      contacts.distribution.reduce((sum, item) => sum + item.value, 0),
      contacts.total
    )
    assert.deepEqual(contacts.availableChannels, ['website', 'whatsapp'])

    const contactEntries = await getAcquisitionAnalyticsSummary(range, {
      population: 'contacts',
      dimension: 'entry'
    })
    assert.deepEqual(distributionByKey(contactEntries), {
      'website.paid_ad': 1,
      'whatsapp.paid_ad': 1,
      'whatsapp.unattributed': 1
    })

    const instagramContacts = await getAcquisitionAnalyticsSummary(range, {
      population: 'contacts',
      dimension: 'source',
      filters: { sources: ['Instagram'] }
    })
    assert.equal(instagramContacts.total, 1)
    assert.deepEqual(distributionByKey(instagramContacts), { Instagram: 1 })
    assert.deepEqual(instagramContacts.availableChannels, ['whatsapp'])

    const visitors = await getAcquisitionAnalyticsSummary(range, {
      population: 'visitors',
      dimension: 'channel',
      groupBy: 'day'
    })
    assert.equal(visitors.total, 2)
    assert.deepEqual(distributionByKey(visitors), { website: 2 })
    assert.deepEqual(visitors.trend, [
      { label: '2291-03-10', visitors: 1 },
      { label: '2291-03-12', visitors: 1 }
    ])
    assert.deepEqual(visitors.range, {
      start: '2291-03-10',
      end: '2291-03-12',
      timezone: 'UTC'
    })
    assert.deepEqual(visitors.availableChannels, ['website'])

    const conversations = await getAcquisitionAnalyticsSummary(range, {
      population: 'conversations',
      dimension: 'entry',
      channels: ['whatsapp'],
      groupBy: 'day'
    })
    assert.equal(conversations.total, 2)
    assert.deepEqual(distributionByKey(conversations), {
      'whatsapp.paid_ad': 1,
      'whatsapp.unattributed': 1
    })
    assert.equal(
      conversations.distribution.reduce((sum, item) => sum + item.value, 0),
      conversations.total
    )
    assert.deepEqual(conversations.availableChannels, ['whatsapp'])

    const instagramConversations = await getAcquisitionAnalyticsSummary(range, {
      population: 'conversations',
      dimension: 'source',
      filters: { sources: ['Instagram'] }
    })
    assert.equal(instagramConversations.total, 1)
    assert.deepEqual(distributionByKey(instagramConversations), { instagram: 1 })
    assert.deepEqual(instagramConversations.availableChannels, ['whatsapp'])

    const websiteConversations = await getAcquisitionAnalyticsSummary(range, {
      population: 'conversations',
      dimension: 'channel',
      channels: ['website']
    })
    assert.equal(
      websiteConversations.total,
      0,
      'un canal incompatible no debe ensancharse silenciosamente a todas las conversaciones'
    )
    assert.deepEqual(websiteConversations.availableChannels, [])

    assert.notEqual(contacts.total, visitors.total + conversations.total)

    await assert.rejects(
      getAcquisitionAnalyticsSummary({
        startUtc: null,
        endUtc: null,
        appliedTimezone: 'UTC'
      }),
      error => error?.code === 'INVALID_ACQUISITION_DATE_RANGE' && error?.status === 400
    )
    await assert.rejects(
      getAcquisitionAnalyticsSummary({
        startUtc: '2291-03-12T00:00:00.000Z',
        endUtc: '2291-03-10T23:59:59.999Z',
        appliedTimezone: 'UTC'
      }),
      error => error?.code === 'INVALID_ACQUISITION_DATE_RANGE' && error?.status === 400
    )
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${marker}%`])
      .catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE id LIKE ?', [`${marker}%`])
      .catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${marker}%`])
      .catch(() => undefined)
  }
})
