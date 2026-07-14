import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { db } from '../src/config/database.js'
import {
  CAMPAIGN_PAGE_MAX_SIZE,
  getCampaignPerformancePage,
  invalidateCampaignPerformanceCache
} from '../src/services/campaignPerformanceService.js'
import { invalidateTimezoneCache, resolveDateRangeWithGHLTimezone } from '../src/utils/dateUtils.js'

test.before(async () => {
  await db.exec(readFileSync(
    new URL('../migrations/versioned/070_campaign_performance_materialized_cache.sqlite.sql', import.meta.url),
    'utf8'
  ))
})

test('Publicidad pagina antes de devolver jerarquía y acota visitantes al nivel solicitado', async () => {
  const suffix = randomUUID()
  const date = '2098-04-12'
  const startedAt = '2098-04-12T15:00:00.000Z'
  const accountId = `act_scale_${suffix}`
  const campaignIds = Array.from({ length: 145 }, (_, index) => `campaign_scale_${String(index).padStart(3, '0')}_${suffix}`)

  const previousTimezone = await db.get(
    'SELECT * FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )

  try {
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone'])
    await db.run(
      'INSERT INTO app_config (config_key, config_value) VALUES (?, ?)',
      ['account_timezone', 'UTC']
    )
    invalidateTimezoneCache()

    await db.transaction(async transaction => {
      for (let index = 0; index < campaignIds.length; index += 1) {
        const campaignId = campaignIds[index]
        const adsetId = `adset_scale_${index}_${suffix}`
        const adId = `ad_scale_${index}_${suffix}`
        await transaction.run(`
          INSERT INTO meta_ads (
            date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
            ad_id, ad_name, spend, reach, clicks, cpc, cpm
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          date,
          accountId,
          campaignId,
          `Campaña escala ${index}`,
          adsetId,
          `Conjunto escala ${index}`,
          adId,
          `Anuncio escala ${index}`,
          index + 1,
          100 + index,
          10 + index,
          1,
          2
        ])

        await transaction.run(`
          INSERT INTO sessions (
            id, session_id, visitor_id, event_name, started_at, created_at,
            campaign_id, adset_id, ad_id
          ) VALUES (?, ?, ?, 'page_view', ?, ?, ?, ?, ?)
        `, [
          randomUUID(),
          `session_scale_${index}_${suffix}`,
          `visitor_scale_${index}_${suffix}`,
          startedAt,
          startedAt,
          campaignId,
          adsetId,
          adId
        ])

        if (index < 2) {
          await transaction.run(`
            INSERT INTO contacts (
              id, email, full_name, attribution_ad_id, attribution_ad_name,
              purchases_count, total_paid, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
          `, [
            `contact_scale_${index}_${suffix}`,
            `scale-${index}-${suffix}@example.invalid`,
            `Contacto escala ${index}`,
            adId,
            `Anuncio escala ${index}`,
            index === 0 ? 10_000 : 5_000,
            startedAt,
            startedAt
          ])
        }
      }
    })

    invalidateCampaignPerformanceCache()
    const range = await resolveDateRangeWithGHLTimezone({ startDate: date, endDate: date })
    const result = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 1,
      pageSize: 500,
      includeVisitors: true
    })

    assert.equal(result.pagination.totalItems, campaignIds.length)
    assert.equal(result.pagination.pageSize, CAMPAIGN_PAGE_MAX_SIZE)
    assert.equal(result.items.length, CAMPAIGN_PAGE_MAX_SIZE)
    assert.equal(result.pagination.hasMore, true)
    assert.ok(result.items.every(item => item.visitors === 1))
    assert.ok(result.items.every(item => item.hasChildren === true))
    assert.ok(result.items.every(item => Array.isArray(item.adsets) && item.adsets.length === 0))
    assert.ok(
      Buffer.byteLength(JSON.stringify(result), 'utf8') < 180_000,
      'el payload de una página no debe crecer con toda la cuenta'
    )

    const secondPage = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 2,
      pageSize: 100,
      includeVisitors: true
    })
    assert.equal(secondPage.items.length, 45)
    assert.equal(secondPage.pagination.hasMore, false)

    const winners = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 1,
      pageSize: 10,
      sortBy: 'revenue',
      sortOrder: 'desc',
      onlyWithResults: true
    })
    assert.equal(winners.pagination.totalItems, 2)
    assert.equal(winners.items.length, 2)
    assert.equal(winners.items[0]?.id, campaignIds[0])
    assert.equal(winners.items[0]?.revenue, 10_000)
    assert.equal(winners.items[0]?.appointments, 0)
    assert.equal(winners.items[1]?.id, campaignIds[1])
    assert.equal(winners.items[1]?.revenue, 5_000)
    assert.equal(winners.items[1]?.appointments, 0)

    const clampedWinners = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 99,
      pageSize: 1,
      sortBy: 'revenue',
      sortOrder: 'desc',
      onlyWithResults: true
    })
    assert.equal(clampedWinners.pagination.totalItems, 2)
    assert.equal(clampedWinners.pagination.totalPages, 2)
    assert.equal(clampedWinners.pagination.page, 2)
    assert.equal(clampedWinners.items[0]?.id, campaignIds[1])
  } finally {
    invalidateCampaignPerformanceCache()
    await db.run('DELETE FROM sessions WHERE campaign_id LIKE ?', [`campaign_scale_%_${suffix}`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`contact_scale_%_${suffix}`]).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone']).catch(() => undefined)
    if (previousTimezone) {
      await db.run(
        'INSERT INTO app_config (config_key, config_value, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [
          previousTimezone.config_key,
          previousTimezone.config_value,
          previousTimezone.created_at,
          previousTimezone.updated_at
        ]
      ).catch(async () => {
        await db.run(
          'INSERT INTO app_config (config_key, config_value) VALUES (?, ?)',
          [previousTimezone.config_key, previousTimezone.config_value]
        )
      })
    }
    invalidateTimezoneCache()
  }
})

test('el contrato de Publicidad no vuelve a cargar contactos o jerarquías completas en el navegador', () => {
  const backendSource = readFileSync(
    new URL('../src/services/campaignPerformanceService.js', import.meta.url),
    'utf8'
  )
  const pageSource = readFileSync(
    new URL('../../frontend/src/pages/Campaigns/Campaigns.tsx', import.meta.url),
    'utf8'
  )
  const serviceSource = readFileSync(
    new URL('../../frontend/src/services/campaignsService.ts', import.meta.url),
    'utf8'
  )

  assert.doesNotMatch(backendSource, /contactsRaw|contactIdsForFinancials|\.map\(\(\) => '\?'\)\.join\(','\)/)
  assert.match(backendSource, /selected_entities AS/)
  assert.match(backendSource, /INNER JOIN selected_entities se/)
  assert.match(backendSource, /CAMPAIGN_PAGE_MAX_SIZE = 100/)
  assert.doesNotMatch(pageSource, /tracking\/visitors-by-ad/)
  assert.match(pageSource, /serverSidePagination=\{true\}/)
  assert.match(pageSource, /loadCampaignAdSetsPage/)
  assert.match(pageSource, /loadAdSetAdsPage/)
  assert.match(pageSource, /childrenHasMore/)
  assert.match(pageSource, /Cargar más conjuntos/)
  assert.match(serviceSource, /getCampaignPerformancePage/)
})
