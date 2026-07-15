import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { databaseDialect, db } from '../src/config/database.js'
import { getCampaigns, getCampaignsPage, getContactsByType } from '../src/controllers/metaController.js'
import { invalidateTimezoneCache } from '../src/utils/dateUtils.js'
import { runContactPersonIdentityProjectionBackfill } from '../src/services/contactPersonIdentityProjectionService.js'

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await db.exec(readFileSync(
    new URL('../migrations/versioned/110_contact_person_identity.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await runContactPersonIdentityProjectionBackfill({ batchSize: 500, yieldMs: 0 })
})

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

test('getContactsByType delega a una página local, estable y acotada', () => {
  const controller = readFileSync(new URL('../src/controllers/metaController.js', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../src/services/campaignContactsPaginationService.js', import.meta.url), 'utf8')
  const handlerStart = controller.indexOf('export const getContactsByType = async')
  const handlerEnd = controller.indexOf('/**\n * Verifica el estado del token', handlerStart)
  const handler = controller.slice(handlerStart, handlerEnd)

  assert.match(handler, /listCampaignContactsPage/)
  assert.doesNotMatch(handler, /getContactsWithAppointmentsHybrid|getContactsWithShowedAppointmentsHybrid|api_token|fetch\(/)
  assert.doesNotMatch(service, /ROW_NUMBER\(\) OVER|MAX\([^)]*\) OVER/)
  assert.match(service, /contact_person_identity/)
  assert.match(service, /NOT EXISTS \([\s\S]*newer_identity/)
  assert.match(service, /ORDER BY \$\{createdAtSort\} DESC, c\.id DESC[\s\S]*LIMIT \?/)
  assert.match(service, /MAX_PAGE_LIMIT = 100/)
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

    const campaigns = await callController(getCampaigns, {
      startDate: date,
      endDate: date,
      includeHierarchy: 'full'
    })
    const campaign = campaigns.find(item => item.id === campaignId)
    const adset = campaign?.adsets?.find(item => item.id === adsetId)
    const ad = adset?.ads?.find(item => item.id === adId)

    assert.ok(campaign, 'la campaña fixture debe aparecer en la tabla')
    assert.ok(adset, 'el conjunto fixture debe aparecer en la tabla')
    assert.ok(ad, 'el anuncio fixture debe aparecer en la tabla')

    const campaignPage = await callController(getCampaignsPage, {
      startDate: date,
      endDate: date,
      level: 'campaign',
      page: '1',
      pageSize: '50'
    })
    const pagedCampaign = campaignPage.items.find(item => item.id === campaignId)
    assert.ok(pagedCampaign, 'el contrato paginado debe incluir la campaña fixture')
    assert.equal(pagedCampaign.leads, 1)
    assert.equal(pagedCampaign.sales, 1)
    assert.equal(pagedCampaign.appointments, 1)
    assert.equal(pagedCampaign.attendances, 1)
    assert.equal(pagedCampaign.revenue, 250)
    assert.equal(pagedCampaign.hasChildren, true)
    assert.deepEqual(pagedCampaign.adsets, [], 'el resumen no debe incrustar toda la jerarquía')

    const adsetPage = await callController(getCampaignsPage, {
      startDate: date,
      endDate: date,
      level: 'adset',
      campaignId,
      pageSize: '200'
    })
    const pagedAdset = adsetPage.items.find(item => item.id === adsetId)
    assert.ok(pagedAdset, 'el conjunto debe cargarse bajo demanda')
    assert.equal(pagedAdset.leads, 1)
    assert.deepEqual(pagedAdset.ads, [], 'el conjunto tampoco debe incrustar anuncios')

    const adPage = await callController(getCampaignsPage, {
      startDate: date,
      endDate: date,
      level: 'ad',
      adsetId,
      pageSize: '200'
    })
    const pagedAd = adPage.items.find(item => item.id === adId)
    assert.ok(pagedAd, 'el anuncio debe cargarse bajo demanda')
    assert.equal(pagedAd.leads, 1)

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

        assert.equal('payments' in contacts[0], false)
        assert.equal('appointments' in contacts[0], false)
        assert.equal('firstSession' in contacts[0], false)
        if (metric.type === 'appointments') assert.equal(contacts[0]?.hasAppointments, true)
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
