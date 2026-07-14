import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, setAppConfig } from '../src/config/database.js'
import {
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsSummary,
  searchTrackingSessions
} from '../src/services/trackingAnalyticsService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

function uniquePrefix(label) {
  return `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function cleanup(prefix) {
  await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE contact_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

test('summary agrega en SQL, respeta timezone/filtros e impone facets acotadas', async () => {
  const prefix = uniquePrefix('tracking_scale_summary')
  const timezone = 'America/Ciudad_Juarez'
  const businessDate = '2088-07-14'
  const contactId = `${prefix}_contact`
  const contactCreatedAt = DateTime.fromISO(`${businessDate}T10:00:00`, { zone: timezone }).toUTC().toISO()
  const firstVisitAt = DateTime.fromISO(`${businessDate}T23:00:00`, { zone: timezone }).toUTC()
  const nextBusinessDayAt = DateTime.fromISO('2088-07-15T00:30:00', { zone: timezone }).toUTC().toISO()

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
  await cleanup(prefix)

  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, visitor_id, source, created_at, updated_at)
      VALUES (?, ?, ?, 'tracking', ?, ?)
    `, [contactId, 'Contacto escala', `${prefix}_canonical_visitor`, contactCreatedAt, contactCreatedAt])

    await db.run(`
      INSERT INTO payments (id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
      VALUES (?, ?, 250, 'succeeded', 'live', ?, ?, ?)
    `, [`${prefix}_payment`, contactId, contactCreatedAt, contactCreatedAt, contactCreatedAt])

    await db.run(`
      INSERT INTO appointments (id, contact_id, title, status, appointment_status, start_time, date_added)
      VALUES (?, ?, 'Cita de escala', 'confirmed', 'confirmed', ?, ?)
    `, [`${prefix}_appointment`, contactId, contactCreatedAt, contactCreatedAt])

    for (let index = 0; index < 35; index += 1) {
      const timestamp = firstVisitAt.plus({ minutes: index }).toISO()
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, event_name, started_at, created_at,
          page_url, utm_source, utm_campaign, utm_content, ad_id,
          channel, device_type, browser, os
        ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, 'google', ?, ?, ?, 'paid', 'mobile', 'Safari', 'iOS')
      `, [
        randomUUID(),
        `${prefix}_session_${String(index).padStart(3, '0')}`,
        `${prefix}_visitor_${String(index).padStart(3, '0')}`,
        contactId,
        timestamp,
        timestamp,
        `https://example.test/page-${index}`,
        `${prefix}_campaign_${String(index).padStart(3, '0')}`,
        `${prefix}_content_${String(index).padStart(3, '0')}`,
        `${prefix}_provider_ad_${String(index).padStart(3, '0')}`
      ])
    }

    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, device_type, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, 'desktop', ?)
    `, [
      randomUUID(),
      `${prefix}_desktop_session`,
      `${prefix}_desktop_visitor`,
      firstVisitAt.toISO(),
      firstVisitAt.toISO(),
      `${prefix}_desktop_campaign`
    ])

    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, device_type, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, 'mobile', ?)
    `, [
      randomUUID(),
      `${prefix}_tomorrow_session`,
      `${prefix}_tomorrow_visitor`,
      nextBusinessDayAt,
      nextBusinessDayAt,
      `${prefix}_tomorrow_campaign`
    ])

    const summary = await getTrackingAnalyticsSummary({
      start: businessDate,
      end: businessDate,
      groupBy: 'day',
      filters: { device_type: ['mobile'] }
    })

    assert.equal(summary.range.timezone, timezone)
    assert.equal(summary.range.groupBy, 'day')
    assert.equal(summary.metrics.current.pageViews, 35)
    assert.equal(summary.metrics.current.uniqueVisitors, 1, 'contact-first identity deduplicates visitor ids')
    assert.equal(summary.metrics.current.uniqueSessions, 35)
    assert.equal(summary.metrics.current.returningUsers, 1)
    assert.equal(summary.metrics.current.registrations, 1)
    assert.equal(summary.metrics.current.customers, 1)
    assert.equal(summary.metrics.current.appointments, 1)
    assert.equal(summary.metrics.current.purchases, 1)
    assert.deepEqual(summary.trafficSeries.map(point => point.period), [businessDate])
    assert.equal(summary.facets.campaigns.length, 25)
    assert.ok(summary.facets.campaigns.every(item => item.count === 1))
    assert.equal(summary.facets.ads.length, 25)
    assert.ok(summary.facets.ads.every(item => item.value.startsWith(`${prefix}_content_`)))
    assert.ok(summary.facets.ads.every(item => !item.value.includes('_provider_ad_')))
    assert.equal(summary.facets.adsHierarchy.length, 1)
    assert.equal(summary.facets.adsHierarchy[0].platform_id, 'google')
    assert.equal(summary.facets.adsHierarchy[0].count, 1)
    assert.equal(summary.facets.adsHierarchy[0].campaigns.length, 8, 'la poda por plataforma ocurre antes de construir el árbol')
    assert.ok(JSON.stringify(summary).length < 100_000, 'summary payload stays bounded')

    const selectedAdFacet = await getTrackingAnalyticsSummary({
      start: businessDate,
      end: businessDate,
      groupBy: 'day',
      filters: { utm_content: [`${prefix}_content_000`] }
    })
    assert.equal(selectedAdFacet.metrics.current.pageViews, 1)

    const warmSummary = await getTrackingAnalyticsSummary({
      start: businessDate,
      end: businessDate,
      groupBy: 'day',
      filters: { device_type: ['mobile'] }
    })
    assert.strictEqual(warmSummary, summary, 'reuses the short server-side snapshot')

    const customersOnly = await getTrackingAnalyticsSummary({
      start: businessDate,
      end: businessDate,
      groupBy: 'day',
      filters: { conversion_stage: ['customer'] }
    })
    assert.equal(customersOnly.metrics.current.pageViews, 35)

    const prospectsOnly = await getTrackingAnalyticsSummary({
      start: businessDate,
      end: businessDate,
      groupBy: 'day',
      filters: { conversion_stage: ['prospect'] }
    })
    assert.equal(prospectsOnly.metrics.current.pageViews, 0)
  } finally {
    clearTrackingAnalyticsSummaryCache()
    await cleanup(prefix)
  }
})

test('adsHierarchy conserva la ruta UTM filtrable y cuenta identidades sin duplicarlas', async () => {
  const prefix = uniquePrefix('tracking_ads_hierarchy')
  const timezone = 'UTC'
  const date = '2088-10-01'
  const timestamp = `${date}T12:00:00.000Z`
  const utm = value => `${prefix}_${value}`
  const contacts = Array.from({ length: 5 }, (_, index) => `${prefix}_contact_${index + 1}`)

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
  await cleanup(prefix)

  try {
    await db.transaction(async tx => {
      for (const [index, contactId] of contacts.entries()) {
        await tx.run(`
          INSERT INTO contacts (id, full_name, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `, [contactId, `Contacto jerarquía ${index + 1}`, timestamp, timestamp])
      }

      const paths = [
        { contactId: contacts[0], platform: 'meta', campaign: 'campaign_a', adset: 'adset_a', ad: 'ad_a', repeats: 2 },
        { contactId: contacts[1], platform: 'meta', campaign: 'campaign_a', adset: 'adset_a', ad: 'ad_a', repeats: 1 },
        { contactId: contacts[2], platform: 'meta', campaign: 'campaign_a', adset: 'adset_a', ad: 'ad_b', repeats: 1 },
        { contactId: contacts[3], platform: 'meta', campaign: 'campaign_b', adset: 'adset_b', ad: 'ad_c', repeats: 1 },
        { contactId: contacts[4], platform: 'google', campaign: 'campaign_g', adset: 'adset_g', ad: 'ad_g', repeats: 1 }
      ]

      let sessionIndex = 0
      for (const path of paths) {
        for (let repeat = 0; repeat < path.repeats; repeat += 1) {
          sessionIndex += 1
          await tx.run(`
            INSERT INTO sessions (
              id, session_id, visitor_id, contact_id, event_name, started_at, created_at,
              utm_source, utm_campaign, utm_medium, utm_content,
              campaign_id, adset_id, ad_id, campaign_name, adset_name, ad_name
            ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            randomUUID(),
            `${prefix}_session_${sessionIndex}`,
            `${prefix}_visitor_${sessionIndex}`,
            path.contactId,
            timestamp,
            timestamp,
            utm(path.platform),
            utm(path.campaign),
            utm(path.adset),
            utm(path.ad),
            utm(`provider_${path.campaign}`),
            utm(`provider_${path.adset}`),
            utm(`provider_${path.ad}`),
            `Nombre ${path.campaign}`,
            `Nombre ${path.adset}`,
            `Nombre ${path.ad}`
          ])
        }
      }
    })

    const summary = await getTrackingAnalyticsSummary({ start: date, end: date })
    const hierarchy = summary.facets.adsHierarchy

    assert.equal(hierarchy.length, 2)
    const meta = hierarchy.find(platform => platform.platform_id === utm('meta'))
    const google = hierarchy.find(platform => platform.platform_id === utm('google'))
    assert.ok(meta)
    assert.ok(google)
    assert.equal(meta.count, 4)
    assert.equal(google.count, 1)

    const campaignA = meta.campaigns.find(campaign => campaign.id === utm('campaign_a'))
    assert.ok(campaignA)
    assert.equal(campaignA.name, 'Nombre campaign_a')
    assert.equal(campaignA.count, 3)

    const adsetA = campaignA.adsets.find(adset => adset.id === utm('adset_a'))
    assert.ok(adsetA)
    assert.equal(adsetA.name, 'Nombre adset_a')
    assert.equal(adsetA.count, 3)
    assert.deepEqual(
      adsetA.ads.map(ad => [ad.id, ad.name, ad.count]),
      [
        [utm('ad_a'), 'Nombre ad_a', 2],
        [utm('ad_b'), 'Nombre ad_b', 1]
      ]
    )
    assert.ok(!JSON.stringify(hierarchy).includes(`${prefix}_provider_`), 'los ids del árbol deben ser los mismos valores UTM que filtra TreeFilter')

    const filtered = await getTrackingAnalyticsSummary({
      start: date,
      end: date,
      filters: { utm_content: [utm('ad_a')] }
    })
    assert.equal(filtered.metrics.current.pageViews, 3)
    assert.deepEqual(filtered.facets.adsHierarchy, [{
      platform: utm('meta'),
      platform_id: utm('meta'),
      count: 2,
      campaigns: [{
        id: utm('campaign_a'),
        name: 'Nombre campaign_a',
        count: 2,
        adsets: [{
          id: utm('adset_a'),
          name: 'Nombre adset_a',
          count: 2,
          ads: [{ id: utm('ad_a'), name: 'Nombre ad_a', count: 2 }]
        }]
      }]
    }])
  } finally {
    clearTrackingAnalyticsSummaryCache()
    await cleanup(prefix)
  }
})

test('sessions/search usa cursor started_at+id sin duplicados ni omisiones', async () => {
  const prefix = uniquePrefix('tracking_scale_cursor')
  const timezone = 'UTC'
  const date = '2088-08-01'
  const timestamp = `${date}T12:00:00.000Z`

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
  await cleanup(prefix)

  try {
    for (let index = 0; index < 25; index += 1) {
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, event_name, started_at, created_at,
          utm_campaign, device_type
        ) VALUES (?, ?, ?, 'page_view', ?, ?, ?, 'mobile')
      `, [
        randomUUID(),
        `${prefix}_session_${String(index).padStart(3, '0')}`,
        `${prefix}_visitor_${String(index).padStart(3, '0')}`,
        timestamp,
        timestamp,
        `${prefix}_campaign`
      ])
    }

    const first = await searchTrackingSessions({
      start: date,
      end: date,
      filters: { device_type: ['mobile'] },
      q: prefix,
      column: 'utm_campaign',
      limit: 20
    })

    assert.equal(first.limit, 20)
    assert.equal(first.items.length, 20)
    assert.equal(first.hasMore, true)
    assert.ok(first.nextCursor)
    assert.equal('user_agent' in first.items[0], false)
    assert.equal('identity_evidence_json' in first.items[0], false)

    const second = await searchTrackingSessions({
      start: date,
      end: date,
      filters: { device_type: ['mobile'] },
      q: prefix,
      column: 'utm_campaign',
      cursor: first.nextCursor,
      limit: 20
    })

    assert.equal(second.items.length, 5)
    assert.equal(second.hasMore, false)
    assert.equal(second.nextCursor, null)

    const ids = [...first.items, ...second.items].map(item => item.id)
    assert.equal(ids.length, 25)
    assert.equal(new Set(ids).size, 25)
    assert.deepEqual(ids, [...ids].sort().reverse())
  } finally {
    await cleanup(prefix)
  }
})

test('sessions/search pagina conversion_stage por chunks sin materializar todo el rango', async () => {
  const prefix = uniquePrefix('tracking_stage_cursor')
  const timezone = 'UTC'
  const date = '2088-09-01'
  const baseTimestamp = DateTime.fromISO(`${date}T00:00:00.000Z`).toUTC()

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
  await cleanup(prefix)

  try {
    await db.transaction(async tx => {
      for (let index = 0; index < 225; index += 1) {
        const timestamp = baseTimestamp.plus({ seconds: index }).toISO()
        const isCustomer = index % 5 === 0
        const contactId = isCustomer ? `${prefix}_contact_${String(index).padStart(3, '0')}` : null

        if (contactId) {
          await tx.run(`
            INSERT INTO contacts (id, full_name, created_at, updated_at)
            VALUES (?, ?, ?, ?)
          `, [contactId, `Cliente ${index}`, timestamp, timestamp])
          await tx.run(`
            INSERT INTO payments (id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
            VALUES (?, ?, 100, 'succeeded', 'live', ?, ?, ?)
          `, [`${prefix}_payment_${index}`, contactId, timestamp, timestamp, timestamp])
        }

        await tx.run(`
          INSERT INTO sessions (
            id, session_id, visitor_id, contact_id, event_name, started_at, created_at
          ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
        `, [
          randomUUID(),
          `${prefix}_session_${String(index).padStart(3, '0')}`,
          `${prefix}_visitor_${String(index).padStart(3, '0')}`,
          contactId,
          timestamp,
          timestamp
        ])
      }
    })

    const pages = []
    let cursor = null
    for (let page = 0; page < 3; page += 1) {
      const result = await searchTrackingSessions({
        start: date,
        end: date,
        filters: { conversion_stage: ['customer'] },
        cursor,
        limit: 20
      })
      pages.push(result)
      cursor = result.nextCursor
    }

    assert.deepEqual(pages.map(page => page.items.length), [20, 20, 5])
    assert.deepEqual(pages.map(page => page.hasMore), [true, true, false])
    assert.ok(pages[0].nextCursor)
    assert.ok(pages[1].nextCursor)
    assert.equal(pages[2].nextCursor, null)

    const ids = pages.flatMap(page => page.items.map(item => item.id))
    assert.equal(ids.length, 45)
    assert.equal(new Set(ids).size, 45)
    assert.ok(pages.flatMap(page => page.items).every(item => item.conversion_stage === 'customer'))
  } finally {
    await cleanup(prefix)
  }
})

test('summary autoagrupa rangos enormes para mantener la serie acotada', async () => {
  const summary = await getTrackingAnalyticsSummary({
    start: '2080-01-01',
    end: '2082-12-31',
    groupBy: 'day',
    filters: {}
  })

  assert.equal(summary.range.requestedGroupBy, 'day')
  assert.equal(summary.range.groupBy, 'month')
  assert.ok(summary.trafficSeries.length <= 400)
  assert.ok(summary.conversionSeries.length <= 400)
})
