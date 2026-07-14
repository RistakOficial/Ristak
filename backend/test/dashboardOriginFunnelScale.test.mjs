import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { db } from '../src/config/database.js'
import {
  getAppointmentsData,
  getAttendancesData,
  getFunnelData,
  getTrafficSources
} from '../src/controllers/dashboardController.js'
import {
  CONTACT_SOURCE_SELECTION_COLUMNS,
  getContactSourceBreakdownForSelection
} from '../src/services/contactSourceService.js'
import { getTrafficDistributions } from '../src/services/originDistributionService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

async function readRepoFile(path) {
  return readFile(join(repoRoot, path), 'utf8')
}

function controllerRequest(handler, query) {
  let statusCode = 200
  let payload
  const res = {
    status(code) {
      statusCode = code
      return this
    },
    json(value) {
      payload = value
      return value
    }
  }

  return handler({ query }, res).then(() => ({ statusCode, payload }))
}

const funnelRequest = (query) => controllerRequest(getFunnelData, query)

test('origen y funnel conservan el trabajo pesado en SQL y no cargan proveedores durante el GET', async () => {
  const [controller, contactSources, origin] = await Promise.all([
    readRepoFile('backend/src/controllers/dashboardController.js'),
    readRepoFile('backend/src/services/contactSourceService.js'),
    readRepoFile('backend/src/services/originDistributionService.js')
  ])

  const originStart = controller.indexOf('export const getOriginDistribution')
  const originEnd = controller.indexOf('export const getFinancialOverview', originStart)
  const originHandler = controller.slice(originStart, originEnd)
  assert.match(originHandler, /getSourceBreakdownByMetric\('leads'/)
  assert.doesNotMatch(originHandler, /getLeadsContactIds|getContactSourceBreakdown\(|contactIds/)

  const funnelStart = controller.indexOf('export const getFunnelData')
  const funnelEnd = controller.indexOf('async function getAttributionCalendarIds', funnelStart)
  const funnelHandler = controller.slice(funnelStart, funnelEnd)
  assert.match(funnelHandler, /COUNT\(DISTINCT a\.contact_id\)/)
  assert.match(funnelHandler, /Promise\.all\(\[[\s\S]*db\.get\(visitorsQuery[\s\S]*db\.get\(customersQuery/)
  assert.doesNotMatch(funnelHandler, /getContactsWithAppointmentsHybrid|getContactsWithShowedAppointmentsHybrid/)
  assert.doesNotMatch(funnelHandler, /loadAppointmentsFromAPI|loadAppointmentsFromDB|fetch\(|await import\(/)
  assert.doesNotMatch(funnelHandler, /contactsRaw|allAppointments|appointmentsInRange/)

  for (const [handlerName, nextHandlerName] of [
    ['getAppointmentsData', 'getAttendancesData'],
    ['getAttendancesData', 'getSalesData']
  ]) {
    const handlerStart = controller.indexOf(`export const ${handlerName}`)
    const handlerEnd = controller.indexOf(`export const ${nextHandlerName}`, handlerStart)
    const chartHandler = controller.slice(handlerStart, handlerEnd)
    assert.match(chartHandler, /COUNT\(DISTINCT/)
    assert.match(chartHandler, /created_at >= \?|date_added >= \?/)
    assert.doesNotMatch(chartHandler, /getContactsWithAppointmentsHybrid|getContactsWithShowedAppointmentsHybrid/)
    assert.doesNotMatch(chartHandler, /loadAppointmentsFromAPI|loadAppointmentsFromDB|fetch\(|await import\(/)
    assert.doesNotMatch(chartHandler, /new Set\(|contactsRaw|allAppointments/)
  }

  const trafficStart = controller.indexOf('export const getTrafficSources')
  const trafficEnd = controller.indexOf('async function getSourceBreakdownByMetric', trafficStart)
  const trafficHandler = controller.slice(trafficStart, trafficEnd)
  assert.match(trafficHandler, /getTrafficDistributions\(range/)
  assert.doesNotMatch(trafficHandler, /FROM sessions|sessions\.forEach|new Map\(/)
  assert.match(controller, /const isPostgres = databaseDialect === 'postgres'/)

  assert.match(contactSources, /COUNT\(\*\) AS source_count/)
  assert.match(contactSources, /WHERE source_rank <= \?/)
  assert.doesNotMatch(contactSources, /sessionConditions\.join\(' OR '\)/)
  assert.match(origin, /COUNT\(DISTINCT identity\) AS item_count/)
  assert.match(origin, /WHERE item_rank <= \$\{rawFacetLimit\}/)
})

test('la distribución devuelve payload acotado aun con muchas facetas y agrega fuentes sin sacar contactos a Node', async () => {
  const marker = `dash_scale_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const start = '2189-04-01T00:00:00.000Z'
  const end = '2189-04-30T23:59:59.999Z'
  const sources = ['facebook_ads', 'google_ads', 'instagram_ads']

  try {
    for (let index = 0; index < 120; index += 1) {
      const id = `${marker}_contact_${String(index).padStart(3, '0')}`
      const visitorId = `${marker}_visitor_${String(index).padStart(3, '0')}`
      const timestamp = `2189-04-${String((index % 20) + 1).padStart(2, '0')}T12:00:00.000Z`
      await db.run(`
        INSERT INTO contacts (id, full_name, email, source, visitor_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [id, id, `${id}@local.invalid`, sources[index % sources.length], visitorId, timestamp, timestamp])
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, email, event_name,
          started_at, created_at, utm_source, device_type, browser, os, placement
        ) VALUES (?, ?, ?, ?, ?, 'page_view', ?, ?, ?, ?, ?, ?, ?)
      `, [
        `${marker}_session_${index}`,
        `${marker}_session_key_${index}`,
        visitorId,
        id,
        `${id}@local.invalid`,
        timestamp,
        timestamp,
        sources[index % sources.length],
        `Device ${String(index).padStart(3, '0')}`,
        `Browser ${String(index).padStart(3, '0')}`,
        `OS ${String(index).padStart(3, '0')}`,
        `placement_${String(index).padStart(3, '0')}`
      ])
    }

    const range = { startUtc: start, endUtc: end, appliedTimezone: 'UTC' }
    const traffic = await getTrafficDistributions(range, {
      includeWeb: true,
      includeWhatsapp: false,
      hiddenFilters: []
    })
    assert.equal(traffic.devices.length, 10)
    assert.equal(traffic.browsers.length, 10)
    assert.equal(traffic.os.length, 10)
    assert.equal(traffic.placements.length, 10)
    assert.equal(traffic.sources.reduce((sum, row) => sum + row.value, 0), 120)

    const legacyResponse = await controllerRequest(getTrafficSources, {
      startDate: '2189-04-01',
      endDate: '2189-04-30',
      includeWeb: '1',
      includeWhatsapp: '0'
    })
    assert.equal(legacyResponse.statusCode, 200)
    assert.equal(legacyResponse.payload.success, true)
    assert.ok(legacyResponse.payload.data.length <= 10)
    assert.equal(legacyResponse.payload.data.reduce((sum, row) => sum + row.value, 0), 120)
    assert.ok(legacyResponse.payload.data.every(row => typeof row.color === 'string'))

    const breakdown = await getContactSourceBreakdownForSelection({
      selectionSql: `
        SELECT ${CONTACT_SOURCE_SELECTION_COLUMNS}
        FROM contacts c
        WHERE c.id LIKE ?
      `,
      params: [`${marker}%`],
      limit: 10
    })
    assert.equal(breakdown.reduce((sum, row) => sum + row.value, 0), 120)
    assert.deepEqual(new Set(breakdown.map(row => row.name)), new Set(['Facebook', 'Google', 'Instagram']))
  } finally {
    await db.run('DELETE FROM sessions WHERE id LIKE ?', [`${marker}%`])
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${marker}%`])
  }
})

test('el funnel cuenta rangos locales en SQL y nunca intenta llamar HighLevel', async () => {
  const marker = `dash_funnel_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const query = { startDate: '2188-03-01', endDate: '2188-03-31', scope: 'all', includeWeb: '1' }
  const timestamp = '2188-03-15T12:00:00.000Z'
  const config = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['attribution_calendar_ids']
  )
  let calendarId = `${marker}_calendar`
  try {
    const configured = JSON.parse(config?.config_value || '[]')
    if (Array.isArray(configured) && configured[0]) calendarId = configured[0]
  } catch {}

  const chartQuery = {
    startDate: query.startDate,
    endDate: query.endDate,
    groupBy: 'day',
    scope: 'all'
  }
  const attributionQuery = { ...query, scope: 'attribution' }
  const attributionChartQuery = { ...chartQuery, scope: 'attribution' }
  const periodChartQuery = {
    ...chartQuery,
    periods: JSON.stringify([{ start: query.startDate, end: query.endDate }])
  }
  const [
    before,
    beforeAttribution,
    beforeAppointments,
    beforeAttributionAppointments,
    beforeAttendances,
    beforePeriodAppointments
  ] = await Promise.all([
    funnelRequest(query),
    funnelRequest(attributionQuery),
    controllerRequest(getAppointmentsData, chartQuery),
    controllerRequest(getAppointmentsData, attributionChartQuery),
    controllerRequest(getAttendancesData, chartQuery),
    controllerRequest(getAppointmentsData, periodChartQuery)
  ])
  assert.equal(before.statusCode, 200)
  assert.equal(beforeAttribution.statusCode, 200)

  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, source, visitor_id, created_at, updated_at)
      VALUES (?, ?, ?, 'direct', ?, ?, ?)
    `, [marker, marker, `${marker}@local.invalid`, `${marker}_visitor`, timestamp, timestamp])
    await db.run(`
      INSERT INTO sessions (id, session_id, visitor_id, contact_id, event_name, started_at, created_at)
      VALUES (?, ?, ?, ?, 'page_view', ?, ?)
    `, [`${marker}_session`, `${marker}_session`, `${marker}_visitor`, marker, timestamp, timestamp])
    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, ?, ?, 'showed', 'showed', ?, ?, ?, ?)
    `, [`${marker}_appointment`, calendarId, marker, timestamp, timestamp, timestamp, timestamp])
    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, status, appointment_status,
        start_time, end_time, date_added, date_updated
      ) VALUES (?, ?, ?, 'confirmed', 'confirmed', ?, ?, ?, ?)
    `, [
      `${marker}_appointment_duplicate`,
      calendarId,
      marker,
      '2188-03-16T12:00:00.000Z',
      '2188-03-16T12:30:00.000Z',
      '2188-03-16T12:00:00.000Z',
      '2188-03-16T12:00:00.000Z'
    ])

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('Las gráficas y el funnel no deben tocar proveedores externos')
    }
    let results
    try {
      results = await Promise.all([
        funnelRequest(query),
        funnelRequest(attributionQuery),
        controllerRequest(getAppointmentsData, chartQuery),
        controllerRequest(getAppointmentsData, attributionChartQuery),
        controllerRequest(getAttendancesData, chartQuery),
        controllerRequest(getAppointmentsData, periodChartQuery)
      ])
    } finally {
      globalThis.fetch = originalFetch
    }

    const [
      after,
      afterAttribution,
      afterAppointments,
      afterAttributionAppointments,
      afterAttendances,
      afterPeriodAppointments
    ] = results
    assert.equal(after.statusCode, 200)
    assert.equal(afterAttribution.statusCode, 200)
    const value = (payload, stage) => payload.data.find(row => row.stage === stage)?.value || 0
    const chartTotal = (response) => response.payload.reduce((sum, row) => sum + row.value, 0)
    assert.equal(value(after.payload, 'Visitantes'), value(before.payload, 'Visitantes') + 1)
    assert.equal(value(after.payload, 'Citas'), value(before.payload, 'Citas') + 1)
    assert.equal(value(after.payload, 'Asistencias'), value(before.payload, 'Asistencias') + 1)
    assert.equal(value(afterAttribution.payload, 'Citas'), value(beforeAttribution.payload, 'Citas') + 1)
    // La serie diaria cuenta al contacto una vez por día; el bucket exacto de mes
    // y el funnel lo deduplican una sola vez en toda la ventana.
    assert.equal(chartTotal(afterAppointments), chartTotal(beforeAppointments) + 2)
    assert.equal(chartTotal(afterAttributionAppointments), chartTotal(beforeAttributionAppointments) + 1)
    assert.equal(chartTotal(afterAttendances), chartTotal(beforeAttendances) + 1)
    assert.equal(chartTotal(afterPeriodAppointments), chartTotal(beforePeriodAppointments) + 1)
    assert.equal(afterPeriodAppointments.payload.length, 1)
  } finally {
    await db.run('DELETE FROM appointments WHERE id LIKE ?', [`${marker}_appointment%`])
    await db.run('DELETE FROM sessions WHERE id = ?', [`${marker}_session`])
    await db.run('DELETE FROM contacts WHERE id = ?', [marker])
  }
})
