import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { db } from '../src/config/database.js'
import { getCampaigns, getContactsByType } from '../src/controllers/metaController.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
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
  assert.equal(response.body?.success, true)
  return response.body.data
}

function quotedIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

async function restoreRows(table, rows) {
  for (const row of rows) {
    const columns = Object.keys(row)
    if (columns.length === 0) continue

    await db.run(
      `INSERT INTO ${quotedIdentifier(table)} (${columns.map(quotedIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map(column => row[column])
    )
  }
}

test('getContactsByType no combina DISTINCT con el orden calculado que PostgreSQL rechaza', () => {
  const source = readFileSync(new URL('../src/controllers/metaController.js', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('export const getContactsByType = async')
  const queryStart = source.indexOf('let contactsQuery = `', handlerStart)
  const queryEnd = source.indexOf('const contactsParams =', queryStart)

  assert.ok(handlerStart >= 0 && queryStart >= 0 && queryEnd > queryStart, 'no se encontro la consulta de getContactsByType')

  const contactsQuerySource = source.slice(queryStart, queryEnd)
  assert.doesNotMatch(
    contactsQuerySource,
    /SELECT\s+DISTINCT\b[\s\S]*ORDER BY\s+\$\{timestampSortExpression\('c\.created_at'\)\}/i,
    'PostgreSQL exige que una expresion de ORDER BY aparezca en SELECT cuando se usa DISTINCT; el GROUP BY ya deduplica estas filas'
  )
})

test('Publicidad mantiene paridad entre sus cifras y el modal en campaña, conjunto y anuncio', async () => {
  const suffix = randomUUID()
  const date = '2099-08-17'
  const createdAt = '2099-08-17T18:00:00.000Z'
  const accountId = `act_parity_${suffix}`
  const campaignId = `campaign_parity_${suffix}`
  const adsetId = `adset_parity_${suffix}`
  const adId = `ad_parity_${suffix}`
  const contactId = `contact_parity_${suffix}`
  const calendarId = `calendar_parity_${suffix}`
  const appointmentId = `appointment_parity_${suffix}`
  const configKeys = ['account_timezone', 'attribution_calendar_ids']
  const configPlaceholders = configKeys.map(() => '?').join(', ')

  const previousAppConfig = await db.all(
    `SELECT * FROM app_config WHERE config_key IN (${configPlaceholders})`,
    configKeys
  )
  const previousHighLevelConfig = await db.all('SELECT * FROM highlevel_config')
  const previousHiddenFilters = await db.all('SELECT * FROM hidden_contact_filters')

  const cleanupFixture = async () => {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
  }

  await cleanupFixture()

  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${configPlaceholders})`, configKeys)
    await db.run('DELETE FROM highlevel_config')
    await db.run('DELETE FROM hidden_contact_filters')
    await db.run(
      'INSERT INTO app_config (config_key, config_value) VALUES (?, ?), (?, ?)',
      ['account_timezone', 'UTC', 'attribution_calendar_ids', JSON.stringify([calendarId])]
    )
    invalidateTimezoneCache()

    await db.run(
      `INSERT INTO meta_ads (
        date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, creative_id, creative_type, creative_image_url, spend, clicks, reach
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'image', ?, 100, 12, 300)`,
      [
        date,
        accountId,
        campaignId,
        'Campaña Paridad',
        adsetId,
        'Conjunto Paridad',
        adId,
        'Anuncio Paridad',
        `creative_${suffix}`,
        'https://example.test/ad-parity.png'
      ]
    )

    await db.run(
      `INSERT INTO contacts (
        id, phone, email, full_name, attribution_ad_id, attribution_ad_name,
        purchases_count, total_paid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 250, ?, ?)`,
      [
        contactId,
        `+521${suffix.replace(/\D/g, '').padEnd(10, '7').slice(0, 10)}`,
        `${suffix}@parity.invalid`,
        'Contacto Paridad',
        adId,
        'Anuncio Paridad',
        createdAt,
        createdAt
      ]
    )

    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, ?, ?, ?, 'confirmed', 'showed', ?, ?, ?, ?)`,
      [
        appointmentId,
        calendarId,
        contactId,
        'Cita atribuida',
        '2099-08-20T18:00:00.000Z',
        '2099-08-20T18:30:00.000Z',
        '2099-08-18T18:00:00.000Z',
        '2099-08-18T18:00:00.000Z'
      ]
    )

    const campaigns = await callController(getCampaigns, { startDate: date, endDate: date })
    const campaign = campaigns.find(item => item.id === campaignId)
    const adset = campaign?.adsets?.find(item => item.id === adsetId)
    const ad = adset?.ads?.find(item => item.id === adId)

    assert.ok(campaign, 'la campaña fixture debe aparecer en la tabla')
    assert.ok(adset, 'el conjunto fixture debe aparecer en la tabla')
    assert.ok(ad, 'el anuncio fixture debe aparecer en la tabla')

    const levels = [
      { label: 'campaña', filter: { campaign_id: campaignId }, row: campaign },
      { label: 'conjunto', filter: { adset_id: adsetId }, row: adset },
      { label: 'anuncio', filter: { ad_id: adId }, row: ad }
    ]
    const metrics = [
      { key: 'leads', type: 'interesados' },
      { key: 'appointments', type: 'appointments' },
      { key: 'attendances', type: 'attendances' },
      { key: 'sales', type: 'sales' }
    ]

    for (const level of levels) {
      for (const metric of metrics) {
        assert.equal(level.row[metric.key], 1, `la fila de ${level.label} debe contar ${metric.key}`)

        const contacts = await callController(getContactsByType, {
          type: metric.type,
          startDate: date,
          endDate: date,
          ...level.filter
        })

        assert.equal(
          contacts.length,
          level.row[metric.key],
          `el modal de ${metric.key} en ${level.label} debe empatar su cifra`
        )
        assert.equal(contacts[0]?.id, contactId)

        if (metric.type === 'appointments') {
          assert.deepEqual(contacts[0]?.appointments?.map(item => item.id), [appointmentId])
        }
      }
    }
  } finally {
    await cleanupFixture()
    await db.run(`DELETE FROM app_config WHERE config_key IN (${configPlaceholders})`, configKeys).catch(() => undefined)
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    await db.run('DELETE FROM hidden_contact_filters').catch(() => undefined)
    await restoreRows('app_config', previousAppConfig)
    await restoreRows('highlevel_config', previousHighLevelConfig)
    await restoreRows('hidden_contact_filters', previousHiddenFilters)
    invalidateTimezoneCache()
  }
})
