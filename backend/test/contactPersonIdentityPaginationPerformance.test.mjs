import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { listCampaignContactsPage } from '../src/services/campaignContactsPaginationService.js'
import {
  runContactPersonIdentityProjectionBackfill
} from '../src/services/contactPersonIdentityProjectionService.js'
import { listReportContactsPage } from '../src/services/reportContactsPaginationService.js'

async function applySqliteMigration(name) {
  await db.exec(await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8'))
}

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await applySqliteMigration('054_campaign_performance_indexes.sqlite.sql')
  await applySqliteMigration('094_cursor_index_alignment.sqlite.sql')
  await applySqliteMigration('110_contact_person_identity.sqlite.sql')
})

test('warming falla cerrado para dedupe y un GET no escribe ni dispara el backfill', async (context) => {
  if (databaseDialect !== 'sqlite') {
    context.skip('prueba focal SQLite')
    return
  }

  let writes = 0
  const originalRun = db.run
  db.run = async function observedRun(...args) {
    writes += 1
    return originalRun.apply(this, args)
  }
  try {
    await assert.rejects(
      listReportContactsPage({
        startDate: '2099-01-01',
        endDate: '2099-01-01',
        dedupeByPerson: true
      }),
      error => error?.status === 503 &&
        error?.code === 'CONTACT_PERSON_IDENTITY_WARMING' &&
        error?.retriable === true
    )
    await assert.rejects(
      listCampaignContactsPage({
        type: 'interesados',
        startDate: '2099-01-01',
        endDate: '2099-01-01',
        campaignId: 'warming-campaign'
      }),
      error => error?.status === 503 && error?.retryAfter === 2
    )

    const recordPage = await listReportContactsPage({
      startDate: '2099-01-01',
      endDate: '2099-01-01',
      dedupeByPerson: false
    })
    assert.deepEqual(recordPage.contacts, [])
    assert.equal(writes, 0, 'ningún GET debe mantener o rellenar la proyección')
  } finally {
    db.run = originalRun
  }

  assert.deepEqual(
    await runContactPersonIdentityProjectionBackfill({ batchSize: 500, yieldMs: 0 }),
    { ready: true, processed: 0 }
  )
})

test('SQLite congela las dos identidades legacy y reacciona a teléfonos alternos', async (context) => {
  if (databaseDialect !== 'sqlite') {
    context.skip('prueba focal SQLite')
    return
  }

  const suffix = `${process.pid}-${Date.now()}`
  const firstId = `identity-first-${suffix}`
  const secondId = `identity-second-${suffix}`
  const alternateId = `identity-phone-${suffix}`
  try {
    await db.run(
      'INSERT INTO contacts (id, email, phone) VALUES (?, ?, ?), (?, ?, ?)',
      [firstId, 'sin-arroba', '+52 1 111 111 1111', secondId, 'tambien-sin-arroba', '+52 1 222 222 2222']
    )
    await db.run(`
      INSERT INTO contact_phone_numbers (
        id, contact_id, phone, is_primary, created_at, updated_at
      ) VALUES (?, ?, '+529999999999', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [alternateId, firstId])

    let rows = await db.all(`
      SELECT contact_id, campaign_person_key, report_person_key
      FROM contact_person_identity
      WHERE contact_id IN (?, ?)
      ORDER BY contact_id
    `, [firstId, secondId])
    const first = rows.find(row => row.contact_id === firstId)
    assert.equal(first.campaign_person_key, 'phone::1111111111')
    assert.equal(first.report_person_key, 'phone::9999999999')

    await db.run('UPDATE contact_phone_numbers SET contact_id = ? WHERE id = ?', [secondId, alternateId])
    rows = await db.all(`
      SELECT contact_id, campaign_person_key, report_person_key
      FROM contact_person_identity
      WHERE contact_id IN (?, ?)
      ORDER BY contact_id
    `, [firstId, secondId])
    assert.equal(rows.find(row => row.contact_id === firstId).report_person_key, 'phone::1111111111')
    assert.equal(rows.find(row => row.contact_id === secondId).report_person_key, 'phone::9999999999')
    assert.equal(rows.find(row => row.contact_id === secondId).campaign_person_key, 'phone::2222222222')
  } finally {
    await db.run('DELETE FROM contact_phone_numbers WHERE id = ?', [alternateId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [firstId, secondId]).catch(() => undefined)
  }
})

test('las páginas usan keyset/anti-join indexado y el total no se recalcula después del cursor', async (context) => {
  if (databaseDialect !== 'sqlite') {
    context.skip('prueba focal SQLite')
    return
  }

  const suffix = `${process.pid}-${Date.now()}`
  const date = '2099-04-17'
  const campaignId = `identity-plan-campaign-${suffix}`
  const adsetId = `identity-plan-adset-${suffix}`
  const adId = `identity-plan-ad-${suffix}`
  const accountId = `identity-plan-account-${suffix}`
  const contactIds = []
  try {
    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES (?, ?, ?, 'Plan', ?, 'Plan', ?, 'Plan', 1, 1, 1)
    `, [date, accountId, campaignId, adsetId, adId])

    for (let index = 0; index < 180; index += 1) {
      const id = `identity-plan-contact-${suffix}-${String(index).padStart(3, '0')}`
      contactIds.push(id)
      const createdAt = `${date}T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, phone, attribution_ad_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        `Plan ${index}`,
        `identity-plan-${suffix}-${index}@example.test`,
        `+521555${String(index).padStart(7, '0')}`,
        adId,
        createdAt,
        createdAt
      ])
    }

    const observedPageQueries = []
    let cappedCounts = 0
    const originalAll = db.all
    const originalGet = db.get
    db.all = async function observedAll(sql, params, options) {
      if (/FROM contacts c[\s\S]*contact_person_identity/i.test(String(sql)) && /ORDER BY/i.test(String(sql))) {
        observedPageQueries.push({ sql: String(sql), params: [...(params || [])] })
      }
      return originalAll.call(this, sql, params, options)
    }
    db.get = async function observedGet(sql, params, options) {
      if (/capped_contacts/i.test(String(sql))) cappedCounts += 1
      return originalGet.call(this, sql, params, options)
    }

    let reportFirst
    let reportSecond
    let campaignFirst
    try {
      reportFirst = await listReportContactsPage({
        startDate: date,
        endDate: date,
        dedupeByPerson: true,
        search: `identity-plan-${suffix}`,
        limit: 50
      })
      reportSecond = await listReportContactsPage({
        startDate: date,
        endDate: date,
        dedupeByPerson: true,
        search: `identity-plan-${suffix}`,
        cursor: reportFirst.pagination.nextCursor,
        limit: 50
      })
      campaignFirst = await listCampaignContactsPage({
        type: 'interesados',
        startDate: date,
        endDate: date,
        campaignId,
        limit: 50
      })
    } finally {
      db.all = originalAll
      db.get = originalGet
    }

    assert.equal(reportFirst.contacts.length, 50)
    assert.equal(reportSecond.contacts.length, 50)
    assert.equal(reportSecond.pagination.total, 180)
    assert.equal(campaignFirst.contacts.length, 50)
    assert.equal(cappedCounts, 1, 'el COUNT acotado viaja en el cursor y no se repite por página')

    const reportQuery = observedPageQueries.find(query => !/WITH query_args/i.test(query.sql))
    const campaignQuery = observedPageQueries.find(query => /WITH query_args/i.test(query.sql))
    assert.ok(reportQuery)
    assert.ok(campaignQuery)
    for (const query of [reportQuery, campaignQuery]) {
      assert.doesNotMatch(query.sql, /\b(?:ROW_NUMBER|RANK|DENSE_RANK)\s*\(|\bOVER\s*\(/i)
    }

    const reportPlan = await originalAll.call(
      db,
      `EXPLAIN QUERY PLAN ${reportQuery.sql}`,
      reportQuery.params
    )
    const campaignPlan = await originalAll.call(
      db,
      `EXPLAIN QUERY PLAN ${campaignQuery.sql}`,
      campaignQuery.params
    )
    const reportDetails = reportPlan.map(row => row.detail).join('\n')
    const campaignDetails = campaignPlan.map(row => row.detail).join('\n')
    assert.match(reportDetails, /idx_contacts_cursor_effective_created_at_id/)
    assert.match(reportDetails, /idx_contact_person_identity_report/)
    assert.doesNotMatch(reportDetails, /USE TEMP B-TREE FOR ORDER BY/)
    assert.match(campaignDetails, /idx_campaign_contacts_cursor_created_at_id/)
    assert.match(campaignDetails, /idx_contact_person_identity_campaign/)
    assert.doesNotMatch(campaignDetails, /USE TEMP B-TREE FOR ORDER BY/)
  } finally {
    for (const id of contactIds) await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
  }
})

test('la migración PostgreSQL congela el contrato legacy sin teléfonos alternos', async () => {
  const migration = await readFile(
    new URL('../migrations/versioned/110a_contact_person_identity.postgres.sql', import.meta.url),
    'utf8'
  )
  const reportCase = migration.slice(
    migration.indexOf('END AS campaign_person_key') + 'END AS campaign_person_key'.length,
    migration.indexOf('END AS report_person_key')
  )
  assert.match(reportCase, /REGEXP_REPLACE\(COALESCE\(c\.phone/)
  assert.doesNotMatch(reportCase, /contact_phone_numbers|cpn\./)
  assert.doesNotMatch(migration, /trg_contact_person_identity_phone/)
})
