import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import { getContactsByType } from '../src/controllers/metaController.js'
import {
  CAMPAIGN_CONTACTS_PAGE_LIMITS,
  listCampaignContactsPage
} from '../src/services/campaignContactsPaginationService.js'
import {
  REPORT_TRANSACTIONS_PAGE_LIMITS,
  listReportTransactionsPage
} from '../src/services/reportTransactionsPaginationService.js'
import {
  buildReportTransactionSummaryCacheKey,
  getReportTransactionSummary
} from '../src/services/reportTransactionSummaryCacheService.js'

async function ensureReportTransactionSummaryMigration() {
  if (databaseDialect !== 'sqlite') return
  const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_transaction_summary_cache'")
  if (table) return
  await db.exec(await readFile(new URL('../migrations/versioned/081_report_transaction_summary_cache.sqlite.sql', import.meta.url), 'utf8'))
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    set(name, value) {
      this.headers[name] = value
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function callController(handler, query) {
  const response = createResponse()
  await handler({ query }, response)
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  return response
}

test('contactos de Campañas pagina/deduplica/busca en SQL y sólo entrega DTOs ligeros', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-10-19'
  const campaignId = `campaign-drill-${suffix}`
  const adsetId = `adset-drill-${suffix}`
  const adId = `ad-drill-${suffix}`
  const accountId = `account-drill-${suffix}`
  const contactIds = []
  const appointmentId = `appointment-drill-${suffix}`

  try {
    if (databaseDialect === 'sqlite') {
      await db.exec(await readFile(new URL('../migrations/versioned/054_campaign_performance_indexes.sqlite.sql', import.meta.url), 'utf8'))
    }
    await db.run(`
      INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, spend, clicks, reach
      ) VALUES (?, ?, ?, 'Campaña escala', ?, 'Conjunto escala', ?, 'Anuncio escala', 10, 2, 20)
    `, [date, accountId, campaignId, adsetId, adId])

    for (let index = 0; index < 105; index += 1) {
      const id = `campaign-contact-${suffix}-${String(index).padStart(3, '0')}`
      const createdAt = `${date}T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
      contactIds.push(id)
      await db.run(`
        INSERT INTO contacts (
          id, full_name, email, phone, attribution_ad_id, attribution_ad_name,
          purchases_count, total_paid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'Anuncio escala', ?, ?, ?, ?)
      `, [
        id,
        index === 77 ? `Contacto Aguja ${suffix}` : `Contacto escala ${String(index).padStart(3, '0')}`,
        index < 2 ? `identidad-duplicada-${suffix}-${index}` : `persona-${suffix}-${index}@example.test`,
        index === 0
          ? '+52 1 555 123 4567'
          : index === 1
            ? '5215551234567'
            : `+521555${String(index).padStart(7, '0')}`,
        adId,
        index === 104 ? 1 : 0,
        index === 104 ? 250 : 0,
        createdAt,
        createdAt
      ])
    }

    await db.run(`
      INSERT INTO appointments (
        id, contact_id, title, status, appointment_status, start_time, end_time,
        date_added, date_updated
      ) VALUES (?, ?, 'Cita local', 'confirmed', 'showed', ?, ?, ?, ?)
    `, [
      appointmentId,
      contactIds[104],
      '2099-10-20T18:00:00.000Z',
      '2099-10-20T18:30:00.000Z',
      '2099-10-19T18:00:00.000Z',
      '2099-10-19T18:00:00.000Z'
    ])

    const first = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      limit: 50
    })
    assert.equal(first.contacts.length, 50)
    assert.equal(first.pagination.limit, 50)
    assert.equal(first.pagination.hasNext, true)
    assert.ok(first.pagination.nextCursor)
    assert.equal(first.summary.pageCount, 50)
    assert.equal('payments' in first.contacts[0], false)
    assert.equal('appointments' in first.contacts[0], false)
    assert.equal('firstSession' in first.contacts[0], false)

    const second = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      cursor: first.pagination.nextCursor,
      limit: 50
    })
    assert.equal(second.contacts.length, 50)
    assert.equal(second.contacts.some(contact => first.contacts.some(item => item.id === contact.id)), false)

    const third = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      cursor: second.pagination.nextCursor,
      limit: 50
    })
    assert.equal(third.contacts.length, 4, '105 registros con una persona duplicada producen 104 personas')
    assert.equal(third.pagination.hasNext, false)

    const maxGuard = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      limit: 999_999
    })
    assert.equal(maxGuard.contacts.length, 100)
    assert.equal(maxGuard.pagination.limit, 100)

    const legacyResponse = await callController(getContactsByType, {
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaign_id: campaignId,
      limit: '999999'
    })
    assert.equal(Array.isArray(legacyResponse.body.data), true)
    assert.equal(legacyResponse.body.data.length, 100)
    assert.equal(legacyResponse.body.pagination.limit, 100)
    assert.equal(legacyResponse.headers.Deprecation, 'true')

    const modernResponse = await callController(getContactsByType, {
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaign_id: campaignId,
      paginated: 'true',
      limit: '2'
    })
    assert.equal(Array.isArray(modernResponse.body.data.contacts), true)
    assert.equal(modernResponse.body.data.contacts.length, 2)
    assert.equal(modernResponse.body.data.pagination.hasNext, true)

    const search = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      search: `Aguja ${suffix}`
    })
    assert.deepEqual(search.contacts.map(contact => contact.id), [contactIds[77]])

    const escapedWildcard = await listCampaignContactsPage({
      type: 'interesados',
      startDate: date,
      endDate: date,
      campaignId,
      search: '%'
    })
    assert.equal(escapedWildcard.contacts.length, 0)

    for (const type of ['sales', 'appointments', 'attendances']) {
      const typed = await listCampaignContactsPage({
        type,
        startDate: date,
        endDate: date,
        adId
      })
      assert.deepEqual(typed.contacts.map(contact => contact.id), [contactIds[104]], `${type} debe resolverse sólo con datos locales`)
    }

    await assert.rejects(
      listCampaignContactsPage({
        type: 'interesados',
        startDate: date,
        endDate: date,
        campaignId,
        cursor: 'cursor-inválido'
      }),
      /Cursor inválido/
    )
    assert.deepEqual(CAMPAIGN_CONTACTS_PAGE_LIMITS, { default: 50, max: 100 })

    const explain = await db.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM contacts
      WHERE attribution_ad_id = ?
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 51
    `, [adId, `${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`])
    assert.match(explain.map(row => row.detail).join('\n'), /idx_contacts_attribution_ad_created/)
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    for (const id of contactIds) await db.run('DELETE FROM contacts WHERE id = ?', [id]).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
  }
})

test('transacciones de Reportes usa cursor estable, búsqueda remota y summary global separado', async () => {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-11-23'
  const contactId = `transaction-contact-${suffix}`
  const paymentIds = []

  try {
    if (databaseDialect === 'sqlite') {
      await db.exec(await readFile(new URL('../migrations/versioned/066_report_transaction_cursor.sqlite.sql', import.meta.url), 'utf8'))
      await ensureReportTransactionSummaryMigration()
    }
    await db.run(`
      INSERT INTO contacts (id, full_name, email, phone, created_at, updated_at)
      VALUES (?, ?, ?, '+5215550000000', ?, ?)
    `, [contactId, `Cliente transacciones ${suffix}`, `${suffix}@example.test`, `${date}T10:00:00.000Z`, `${date}T10:00:00.000Z`])

    for (let index = 0; index < 125; index += 1) {
      const id = `report-transaction-${suffix}-${String(index).padStart(3, '0')}`
      const occurredAt = `${date}T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
      paymentIds.push(id)
      await db.run(`
        INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_mode, payment_provider,
          payment_method, description, date, created_at, updated_at
        ) VALUES (?, ?, ?, 'MXN', 'paid', 'live', 'manual', 'card', ?, ?, ?, ?)
      `, [
        id,
        contactId,
        index + 1,
        index === 77 ? `Aguja transacción ${suffix}` : `Pago escala ${index}`,
        occurredAt,
        occurredAt,
        occurredAt
      ])
    }

    const first = await listReportTransactionsPage({ startDate: date, endDate: date, limit: 50 })
    assert.equal(first.transactions.length, 50)
    assert.equal(first.pagination.mode, 'cursor')
    assert.equal(first.pagination.hasNext, true)
    assert.ok(first.pagination.nextCursor)
    assert.equal(first.summary.count, 125)
    assert.equal(first.summary.totalAmount, 7_875)

    const second = await listReportTransactionsPage({
      startDate: date,
      endDate: date,
      cursor: first.pagination.nextCursor,
      limit: 50
    })
    assert.equal(second.transactions.length, 50)
    assert.equal(second.transactions.some(transaction => first.transactions.some(item => item.id === transaction.id)), false)

    const search = await listReportTransactionsPage({
      startDate: date,
      endDate: date,
      search: `Aguja transacción ${suffix}`
    })
    assert.deepEqual(search.transactions.map(transaction => transaction.id), [paymentIds[77]])
    assert.equal(search.pagination.total, 1)
    assert.equal(search.summary.count, 125, 'buscar no debe alterar el summary global del periodo')
    assert.equal(search.summary.totalAmount, 7_875)

    await assert.rejects(
      listReportTransactionsPage({ startDate: date, endDate: date, page: 2, limit: 999_999 }),
      /requieren cursor/
    )

    await assert.rejects(
      listReportTransactionsPage({ startDate: date, endDate: date, cursor: 'cursor-inválido' }),
      /Cursor inválido/
    )
    assert.deepEqual(REPORT_TRANSACTIONS_PAGE_LIMITS, { default: 50, max: 100 })

    const indexes = await db.all("PRAGMA index_list('payments')")
    assert.equal(indexes.some(row => row.name === 'idx_report_transactions_live_date_id'), true)
    const explain = await db.all(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM payments
      WHERE date >= ?
        AND date <= ?
        AND COALESCE(payment_mode, 'live') != 'test'
      ORDER BY date DESC, id DESC
      LIMIT 51
    `, [`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`])
    assert.match(explain.map(row => row.detail).join('\n'), /idx_report_transactions_live_date_id/)
  } finally {
    for (const id of paymentIds) await db.run('DELETE FROM payments WHERE id = ?', [id]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('contrato estático evita descargas completas, fetch remoto y doble agregado de visitantes', async () => {
    const [campaignBackend, transactionsBackend, campaigns, reports, modal, postgresMigration] = await Promise.all([
    readFile(new URL('../src/services/campaignContactsPaginationService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/reportTransactionsPaginationService.js', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/pages/Campaigns/Campaigns.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/pages/Reports/Reports.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/components/common/TransactionsModal/TransactionsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/081b_report_transaction_effective_at.postgres.sql', import.meta.url), 'utf8')
  ])

  assert.doesNotMatch(campaignBackend, /leadconnectorhq|getContactsWithAppointmentsHybrid|getContactsWithShowedAppointmentsHybrid|api_token|fetch\(/i)
  assert.match(campaignBackend, /pageLimit \+ 1/)
  assert.match(campaignBackend, /MAX_PAGE_LIMIT = 100/)
  assert.match(transactionsBackend, /pageLimit \+ 1/)
  assert.match(transactionsBackend, /MAX_PAGE_LIMIT = 100/)
  assert.match(transactionsBackend, /nextCursor/)

  assert.match(campaigns, /getContactsPage\(params, controller\.signal\)/)
  assert.match(campaigns, /onPageChange=\{handleCampaignContactsPageChange\}/)
  assert.match(campaigns, /onSearchChange=\{handleCampaignContactsSearch\}/)
  assert.match(campaigns, /onSelectContact=\{hydrateCampaignContact\}/)
  assert.doesNotMatch(campaigns, /campaignsService\.getContactsByType\(/)

  assert.doesNotMatch(reports, /while \(hasNext|MODAL_MAX_ROWS|PAGE_SIZE = 500/)
  assert.doesNotMatch(reports, /\/api\/tracking\/visitors-by-period/)
  assert.match(reports, /getTransactionsPage\(/)
  assert.match(reports, /transactionsModalAbortRef/)
  assert.match(modal, /<SearchField/)
  assert.match(modal, />\s*Anterior\s*<\/Button>/)
  assert.match(modal, />\s*Siguiente\s*<\/Button>/)
  assert.match(postgresMigration, /CREATE INDEX CONCURRENTLY/)
})

test('summary durable de transacciones ejecuta el agregado una sola vez por revisión y rango', async () => {
  if (databaseDialect !== 'sqlite') return
  await ensureReportTransactionSummaryMigration()
  const cacheKey = buildReportTransactionSummaryCacheKey({
    startUtc: '2098-01-01T00:00:00.000Z',
    endUtc: '2098-01-31T23:59:59.999Z',
    hiddenFilters: [{ text: `cache-${Date.now()}`, type: 'contains' }]
  })
  let builds = 0
  const buildSummary = async () => {
    builds += 1
    return { count: 17, totalAmount: 1250 }
  }

  const first = await getReportTransactionSummary({ cacheKey, buildSummary })
  const second = await getReportTransactionSummary({ cacheKey, buildSummary })

  assert.equal(first.count, 17)
  assert.equal(second.totalAmount, 1250)
  assert.equal(second.cache.stale, false)
  assert.equal(builds, 1)
})
