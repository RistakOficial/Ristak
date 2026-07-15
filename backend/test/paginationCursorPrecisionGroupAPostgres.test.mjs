import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function decodeCursor(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function assertScopedCursor(value, kind, timestampField) {
  const payload = decodeCursor(value)
  assert.equal(payload.v, 2)
  assert.equal(payload.kind, kind)
  assert.match(payload.scope, /^[A-Za-z0-9_-]{40,}$/)
  assert.match(payload[timestampField], /\.123456$/)
  return payload
}

test('PostgreSQL vivo conserva microsegundos, scope v2 y cursores legacy en Grupo A', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL)
  const pg = await import('pg')
  const OriginalPool = pg.default.Pool
  if (['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
    pg.default.Pool = class LocalPostgresTestPool extends OriginalPool {
      constructor(options) {
        super({ ...options, ssl: false })
      }
    }
  }

  let database
  let reportContacts
  let reportTransactions
  let campaignContacts
  try {
    [database, reportContacts, reportTransactions, campaignContacts] = await Promise.all([
      import('../src/config/database.js'),
      import('../src/services/reportContactsPaginationService.js'),
      import('../src/services/reportTransactionsPaginationService.js'),
      import('../src/services/campaignContactsPaginationService.js')
    ])
  } finally {
    pg.default.Pool = OriginalPool
  }
  const { databaseDialect, db } = database
  assert.equal(databaseDialect, 'postgres')

  await db.exec(await readFile(
    new URL('../migrations/versioned/081a_report_transaction_summary_cache.postgres.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(await readFile(
    new URL('../migrations/versioned/110a_contact_person_identity.postgres.sql', import.meta.url),
    'utf8'
  ))
  const identityProjection = await import('../src/services/contactPersonIdentityProjectionService.js')
  await identityProjection.runContactPersonIdentityProjectionBackfill({ batchSize: 2_000, yieldMs: 0 })

  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-12-14'
  const reportMarker = `pg-report-contact-${suffix}`
  const transactionMarker = `pg-report-transaction-${suffix}`
  const campaignMarker = `pg-campaign-contact-${suffix}`
  const transactionContactId = `pg-transaction-owner-${suffix}`
  const reportContactIds = ['a', 'b', 'c'].map(letter => `${reportMarker}-${letter}`)
  const transactionIds = ['a', 'b', 'c'].map(letter => `${transactionMarker}-${letter}`)
  const campaignContactIds = ['a', 'b', 'c'].map(letter => `${campaignMarker}-${letter}`)
  const campaignId = `pg-campaign-${suffix}`
  const adsetId = `pg-adset-${suffix}`
  const adId = `pg-ad-${suffix}`
  const accountId = `pg-account-${suffix}`
  const timestamps = [
    `${date}T18:00:00.123456Z`,
    `${date}T18:00:00.123455Z`,
    `${date}T18:00:00.123454Z`
  ]

  try {
    for (let index = 0; index < reportContactIds.length; index += 1) {
      await db.run(`
        INSERT INTO contacts (id, full_name, email, source, created_at, updated_at)
        VALUES (?, ?, ?, 'pg_cursor_scope_test', ?, ?)
      `, [
        reportContactIds[index],
        `${reportMarker} ${index}`,
        `${reportContactIds[index]}@example.test`,
        timestamps[index],
        timestamps[index]
      ])
    }

    const reportFirst = await reportContacts.listReportContactsPage({
      startDate: date,
      endDate: date,
      type: 'interesados',
      scope: 'all',
      search: reportMarker,
      limit: 1
    })
    const reportCursor = assertScopedCursor(reportFirst.pagination.nextCursor, 'report-contacts', 'createdAt')
    assert.equal(Object.keys(reportFirst.contacts[0]).some(key => key.startsWith('cursor_')), false)
    const reportSecond = await reportContacts.listReportContactsPage({
      startDate: date,
      endDate: date,
      type: 'interesados',
      scope: 'all',
      search: reportMarker,
      cursor: reportFirst.pagination.nextCursor,
      limit: 1
    })
    const reportLegacySecond = await reportContacts.listReportContactsPage({
      startDate: date,
      endDate: date,
      type: 'interesados',
      scope: 'all',
      search: reportMarker,
      cursor: encodeCursor({ createdAt: reportCursor.createdAt, id: reportCursor.id }),
      limit: 1
    })
    assert.deepEqual(reportLegacySecond.contacts.map(row => row.id), reportSecond.contacts.map(row => row.id))
    await assert.rejects(
      reportContacts.listReportContactsPage({
        startDate: date,
        endDate: date,
        type: 'customers',
        scope: 'all',
        search: reportMarker,
        cursor: reportFirst.pagination.nextCursor,
        limit: 1
      }),
      error => error?.status === 400 && /ya no corresponde/.test(error.message)
    )

    await db.run(`
      INSERT INTO contacts (id, full_name, email, source, created_at, updated_at)
      VALUES (?, ?, ?, 'pg_cursor_scope_test', ?, ?)
    `, [transactionContactId, transactionMarker, `${transactionContactId}@example.test`, timestamps[0], timestamps[0]])
    for (let index = 0; index < transactionIds.length; index += 1) {
      await db.run(`
        INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_mode, payment_provider,
          payment_method, description, date, created_at, updated_at
        ) VALUES (?, ?, 1, 'MXN', 'paid', 'live', 'manual', 'card', ?, ?, ?, ?)
      `, [transactionIds[index], transactionContactId, transactionMarker, timestamps[index], timestamps[index], timestamps[index]])
    }

    const transactionFirst = await reportTransactions.listReportTransactionsPage({
      startDate: date,
      endDate: date,
      search: transactionMarker,
      limit: 1
    })
    const transactionCursor = assertScopedCursor(
      transactionFirst.pagination.nextCursor,
      'report-transactions',
      'occurredAt'
    )
    assert.equal(Object.keys(transactionFirst.transactions[0]).some(key => key.startsWith('cursor_')), false)
    const transactionSecond = await reportTransactions.listReportTransactionsPage({
      startDate: date,
      endDate: date,
      search: transactionMarker,
      cursor: transactionFirst.pagination.nextCursor,
      limit: 1
    })
    const transactionLegacySecond = await reportTransactions.listReportTransactionsPage({
      startDate: date,
      endDate: date,
      search: transactionMarker,
      cursor: encodeCursor({
        v: 1,
        kind: 'report-transactions',
        occurredAt: transactionCursor.occurredAt,
        id: transactionCursor.id
      }),
      limit: 1
    })
    assert.deepEqual(
      transactionLegacySecond.transactions.map(row => row.id),
      transactionSecond.transactions.map(row => row.id)
    )
    await assert.rejects(
      reportTransactions.listReportTransactionsPage({
        startDate: date,
        endDate: date,
        search: `${transactionMarker}-otro`,
        cursor: transactionFirst.pagination.nextCursor,
        limit: 1
      }),
      error => error?.status === 400 && /ya no corresponde/.test(error.message)
    )

    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES (?, ?, ?, 'PG cursor', ?, 'PG cursor', ?, 'PG cursor', 1, 1, 1)
    `, [date, accountId, campaignId, adsetId, adId])
    for (let index = 0; index < campaignContactIds.length; index += 1) {
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, phone, attribution_ad_id, attribution_ad_name,
          purchases_count, total_paid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'PG cursor', 0, 0, ?, ?)
      `, [
        campaignContactIds[index],
        `${campaignMarker} ${index}`,
        `${campaignContactIds[index]}@example.test`,
        `+52155500000${index}`,
        adId,
        timestamps[index],
        timestamps[index]
      ])
    }

    const campaignFirst = await campaignContacts.listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      search: campaignMarker,
      limit: 1
    })
    const campaignCursor = assertScopedCursor(campaignFirst.pagination.nextCursor, 'campaign-contacts', 'createdAt')
    assert.equal(Object.keys(campaignFirst.contacts[0]).some(key => key.startsWith('cursor_')), false)
    const campaignSecond = await campaignContacts.listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      search: campaignMarker,
      cursor: campaignFirst.pagination.nextCursor,
      limit: 1
    })
    const campaignLegacySecond = await campaignContacts.listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      search: campaignMarker,
      cursor: encodeCursor({
        v: 1,
        kind: 'campaign-contacts',
        createdAt: campaignCursor.createdAt,
        id: campaignCursor.id
      }),
      limit: 1
    })
    assert.deepEqual(campaignLegacySecond.contacts.map(row => row.id), campaignSecond.contacts.map(row => row.id))
    await assert.rejects(
      campaignContacts.listCampaignContactsPage({
        type: 'interesados',
        startDate: date,
        endDate: date,
        campaignId: `${campaignId}-otro`,
        search: campaignMarker,
        cursor: campaignFirst.pagination.nextCursor,
        limit: 1
      }),
      error => error?.status === 400 && /ya no corresponde/.test(error.message)
    )
  } finally {
    for (const id of transactionIds) await db.run('DELETE FROM payments WHERE id = ?', [id]).catch(() => undefined)
    for (const id of [...reportContactIds, transactionContactId, ...campaignContactIds]) {
      await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
    }
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
  }
})
