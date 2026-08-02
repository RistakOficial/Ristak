import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import { validateContactReferrer } from '../src/services/contactReferralService.js'
import { buildAggregatedReportMetrics } from '../src/services/reportMetricsAggregationService.js'
import { getCampaignPerformancePage, invalidateCampaignPerformanceCache } from '../src/services/campaignPerformanceService.js'
import { listCampaignContactsPage } from '../src/services/campaignContactsPaginationService.js'
import { listReportContactsPage } from '../src/services/reportContactsPaginationService.js'
import { runContactPersonIdentityProjectionBackfill } from '../src/services/contactPersonIdentityProjectionService.js'
import { invalidateTimezoneCache, resolveDateRangeWithGHLTimezone } from '../src/utils/dateUtils.js'

test('la cadena de recomendaciones respeta el límite que puede resolver la atribución', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const suffix = randomUUID()
  const chainIds = Array.from({ length: 26 }, (_, index) => `referral-depth-${index}-${suffix}`)

  try {
    for (const [index, contactId] of chainIds.entries()) {
      await db.run(
        `INSERT INTO contacts (id, full_name, referred_by_contact_id, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId, `Contacto ${index}`, index > 0 ? chainIds[index - 1] : null]
      )
    }

    assert.equal(await validateContactReferrer({
      contactId: `referral-depth-allowed-${suffix}`,
      referredByContactId: chainIds[24]
    }), chainIds[24])

    await assert.rejects(
      validateContactReferrer({
        contactId: `referral-depth-rejected-${suffix}`,
        referredByContactId: chainIds[25]
      }),
      error => error?.code === 'CONTACT_REFERRAL_DEPTH_EXCEEDED'
    )
  } finally {
    for (const contactId of chainIds.reverse()) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  }
})

test('la recomendación hereda atribución interna sin mover el pago del comprador', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const suffix = randomUUID()
  const date = '2096-05-14'
  const createdAt = `${date}T16:00:00.000Z`
  const accountId = `referral-account-${suffix}`
  const originalCampaignId = `referral-campaign-original-${suffix}`
  const ownCampaignId = `referral-campaign-own-${suffix}`
  const originalAdId = `referral-ad-original-${suffix}`
  const ownAdId = `referral-ad-own-${suffix}`
  const contacts = {
    original: `referral-original-${suffix}`,
    referred: `referral-child-${suffix}`,
    chained: `referral-grandchild-${suffix}`,
    ownAttribution: `referral-own-${suffix}`
  }
  const paymentIds = Object.values(contacts).map(() => `referral-payment-${randomUUID()}`)
  const previousTimezone = await db.get(
    'SELECT * FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )

  try {
    await db.exec(await readFile(
      new URL('../migrations/versioned/070_campaign_performance_materialized_cache.sqlite.sql', import.meta.url),
      'utf8'
    ))
    await db.exec(await readFile(
      new URL('../migrations/versioned/110_contact_person_identity.sqlite.sql', import.meta.url),
      'utf8'
    ))
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES ('account_timezone', 'UTC', CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `)
    invalidateTimezoneCache()

    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES
        (?, ?, ?, 'Campaña original', ?, 'Conjunto original', ?, 'Anuncio original', 50, 10, 100),
        (?, ?, ?, 'Campaña propia', ?, 'Conjunto propio', ?, 'Anuncio propio', 25, 5, 50)
    `, [
      date, accountId, originalCampaignId, `referral-adset-original-${suffix}`, originalAdId,
      date, accountId, ownCampaignId, `referral-adset-own-${suffix}`, ownAdId
    ])

    await db.run(`
      INSERT INTO contacts (
        id, full_name, email, attribution_ad_id, attribution_ad_name,
        referred_by_contact_id, purchases_count, total_paid, created_at, updated_at
      ) VALUES
        (?, 'Cliente original', ?, ?, 'Anuncio original', NULL, 1, 100, ?, ?),
        (?, 'Cliente recomendado', ?, NULL, NULL, ?, 1, 100, ?, ?),
        (?, 'Cliente de cadena', ?, NULL, NULL, ?, 1, 50, ?, ?),
        (?, 'Cliente con anuncio propio', ?, ?, 'Anuncio propio', ?, 1, 75, ?, ?)
    `, [
      contacts.original, `original-${suffix}@example.test`, originalAdId, createdAt, createdAt,
      contacts.referred, `referred-${suffix}@example.test`, contacts.original, createdAt, createdAt,
      contacts.chained, `chained-${suffix}@example.test`, contacts.referred, createdAt, createdAt,
      contacts.ownAttribution, `own-${suffix}@example.test`, ownAdId, contacts.original, createdAt, createdAt
    ])

    const amounts = [100, 100, 50, 75]
    for (const [index, contactId] of Object.values(contacts).entries()) {
      await db.run(`
        INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method,
          payment_mode, date, created_at, updated_at
        ) VALUES (?, ?, ?, 'MXN', 'succeeded', 'card', 'live', ?, ?, ?)
      `, [paymentIds[index], contactId, amounts[index], createdAt, createdAt, createdAt])
    }

    const effectiveRows = await db.all(`
      SELECT contact_id, attribution_contact_id, referral_depth, inherited_from_referral
      FROM contact_effective_ad_attribution
      WHERE contact_id IN (?, ?, ?, ?)
    `, Object.values(contacts))
    const effectiveByContact = new Map(effectiveRows.map(row => [row.contact_id, row]))
    assert.equal(effectiveByContact.get(contacts.original)?.attribution_contact_id, contacts.original)
    assert.equal(effectiveByContact.get(contacts.referred)?.attribution_contact_id, contacts.original)
    assert.equal(effectiveByContact.get(contacts.referred)?.referral_depth, 1)
    assert.equal(effectiveByContact.get(contacts.chained)?.attribution_contact_id, contacts.original)
    assert.equal(effectiveByContact.get(contacts.chained)?.referral_depth, 2)
    assert.equal(effectiveByContact.get(contacts.ownAttribution)?.attribution_contact_id, contacts.ownAttribution)
    assert.equal(effectiveByContact.get(contacts.ownAttribution)?.inherited_from_referral, 0)

    await assert.rejects(
      validateContactReferrer({
        contactId: contacts.original,
        referredByContactId: contacts.chained
      }),
      error => error?.code === 'CONTACT_REFERRAL_CYCLE'
    )
    await assert.rejects(
      validateContactReferrer({
        contactId: contacts.original,
        referredByContactId: contacts.original
      }),
      error => error?.code === 'CONTACT_REFERRAL_SELF_REFERENCE'
    )

    const report = await buildAggregatedReportMetrics({
      startDate: date,
      endDate: date,
      groupBy: 'day',
      scope: 'campaigns'
    })
    const reportDay = report.metrics.find(row => row.date === date)
    assert.equal(reportDay?.revenue, 325)
    assert.equal(reportDay?.sales, 4)

    const reportDrilldown = await listReportContactsPage({
      startDate: date,
      endDate: date,
      type: 'sales',
      scope: 'campaigns',
      limit: 20
    })
    const reportReferredContact = reportDrilldown.contacts.find(contact => contact.id === contacts.referred)
    assert.equal(reportReferredContact?.referredByContactId, contacts.original)
    assert.equal(reportReferredContact?.attributionContactId, contacts.original)
    assert.equal(reportReferredContact?.attributionInheritedFromReferral, true)

    invalidateCampaignPerformanceCache()
    const range = await resolveDateRangeWithGHLTimezone({ startDate: date, endDate: date })
    const performance = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 1,
      pageSize: 20,
      sortBy: 'revenue',
      sortOrder: 'desc',
      onlyWithResults: true
    })
    const originalCampaign = performance.items.find(item => item.id === originalCampaignId)
    const ownCampaign = performance.items.find(item => item.id === ownCampaignId)
    assert.equal(originalCampaign?.revenue, 250)
    assert.equal(originalCampaign?.sales, 3)
    assert.equal(ownCampaign?.revenue, 75)
    assert.equal(ownCampaign?.sales, 1)

    await runContactPersonIdentityProjectionBackfill({ batchSize: 100, yieldMs: 0 })
    const drilldown = await listCampaignContactsPage({
      type: 'sales',
      startDate: date,
      endDate: date,
      campaignId: originalCampaignId,
      limit: 20
    })
    const referredContact = drilldown.contacts.find(contact => contact.id === contacts.referred)
    assert.equal(referredContact?.referredByContactId, contacts.original)
    assert.equal(referredContact?.referredByContact?.name, 'Cliente original')
    assert.equal(referredContact?.attributionContactId, contacts.original)
    assert.equal(referredContact?.attributionInheritedFromReferral, true)

    const payerRows = await db.all(
      'SELECT contact_id, amount FROM payments WHERE id IN (?, ?, ?, ?) ORDER BY amount DESC',
      paymentIds
    )
    assert.deepEqual(
      new Set(payerRows.map(row => row.contact_id)),
      new Set(Object.values(contacts)),
      'cada pago debe seguir ligado al contacto que realmente pagó'
    )
  } finally {
    invalidateCampaignPerformanceCache()
    for (const paymentId of paymentIds) {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    }
    for (const contactId of Object.values(contacts).reverse()) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
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
