import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import {
  getMobileAnalyticsSnapshot,
  getOriginDistribution
} from '../src/controllers/dashboardController.js'
import { runMessageAnalyticsProjectionBackfill } from '../src/services/messageAnalyticsProjectionService.js'
import { runTrackingAnalyticsProjectionBackfill } from '../src/services/trackingAnalyticsProjectionService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

const rangeQuery = {
  startDate: '2192-08-01',
  endDate: '2192-08-31',
  includeWeb: '1',
  includeWhatsapp: '1',
  includeBreakdowns: '0',
  dimension: 'sources'
}

class ResponseRecorder extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 200
    this.payload = undefined
    this.headers = new Map()
    this.writableEnded = false
    this.finished = false
  }

  status(code) {
    this.statusCode = code
    return this
  }

  set(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value))
    return this
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value))
  }

  json(payload) {
    this.payload = payload
    return this
  }
}

async function requestOrigin(query = rangeQuery, response = new ResponseRecorder()) {
  await getOriginDistribution({ query }, response)
  return response
}

async function installProjectionSchemas() {
  for (const migrationName of [
    '113_tracking_analytics_projection.sqlite.sql',
    '114_message_analytics_projection.sqlite.sql',
    '115_message_analytics_range_rollup.sqlite.sql',
    '118_message_analytics_phone_projection.sqlite.sql',
    '119_tracking_analytics_hot_identity.sqlite.sql',
    '120_tracking_analytics_identity_source_parity.sqlite.sql'
  ]) {
    await db.exec(await readFile(
      new URL(`../migrations/versioned/${migrationName}`, import.meta.url),
      'utf8'
    ))
  }
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()
}

async function convergeProjections() {
  let trackingResult = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    trackingResult = await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 20,
      maxQueueBatches: 20,
      yieldMs: 0
    })
    if (trackingResult.ready) break
  }
  assert.equal(trackingResult?.ready, true, `tracking no convergió: ${JSON.stringify(trackingResult)}`)

  let messageResult = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    messageResult = await runMessageAnalyticsProjectionBackfill({
      batchSize: 100,
      maxBackfillBatches: 4,
      maxQueueBatches: 8
    })
    if (messageResult.ready) break
  }
  assert.equal(messageResult?.ready, true, `mensajes no convergió: ${JSON.stringify(messageResult)}`)
}

async function cleanup(prefix) {
  await db.run('DELETE FROM hidden_contact_filters WHERE filter_text LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
}

test('phone breakdown usa sólo su proyección y respeta el override aunque WhatsApp esté apagado', async () => {
  const prefix = `phone_projection_${randomUUID().replaceAll('-', '')}`
  const timestamp = '2192-08-18T12:00:00.000Z'
  const phoneId = `${prefix}_phone`

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name,
        api_send_enabled, qr_send_enabled, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, 1, 0, ?)
    `, [phoneId, '5215550101010', '+52 1 555 010 1010', `${prefix} principal`, timestamp])
    await insertMessageContact({
      id: `${prefix}_contact`,
      fullName: `${prefix}_visible`,
      phone: '5215550202020',
      timestamp
    })
    await db.run(`
      UPDATE whatsapp_api_messages
      SET business_phone_number_id = ?, business_phone = ?, updated_at = ?
      WHERE id = ?
    `, [phoneId, '5215550101010', timestamp, `${prefix}_contact_message`])
    await convergeProjections()

    const originals = { all: db.all, get: db.get }
    const queries = []
    for (const method of ['all', 'get']) {
      db[method] = async function observedPhoneProjectionRead(...args) {
        queries.push(String(args[0] || ''))
        return originals[method].apply(this, args)
      }
    }

    let response
    try {
      response = await requestOrigin({
        startDate: '2192-08-01',
        endDate: '2192-08-31',
        includeWeb: '0',
        includeWhatsapp: '0',
        includeBreakdowns: '0',
        includePhoneBreakdown: '1',
        dimension: 'sources'
      })
    } finally {
      db.all = originals.all
      db.get = originals.get
    }

    assert.equal(response.statusCode, 200)
    const expectedPhoneRows = [{
      name: `${prefix} principal`,
      value: 1,
      phoneNumberId: phoneId,
      phoneNumber: '5215550101010',
      displayPhoneNumber: '+52 1 555 010 1010',
      status: null,
      apiSendEnabled: true,
      qrSendEnabled: false
    }]
    assert.deepEqual(response.payload.data.whatsappNumbers, expectedPhoneRows)
    assert.equal(
      queries.some(sql => /FROM\s+whatsapp_api_messages\b/i.test(sql)),
      false,
      queries.join('\n---\n')
    )

    const omittedByCompatibility = await requestOrigin({
      startDate: '2192-08-01',
      endDate: '2192-08-31',
      includeWeb: '0',
      includeWhatsapp: '1',
      includeBreakdowns: '0',
      dimension: 'sources'
    })
    assert.deepEqual(omittedByCompatibility.payload.data.whatsappNumbers, [])

    const legacySnapshot = new ResponseRecorder()
    await getMobileAnalyticsSnapshot({
      query: {
        startDate: '2192-08-01',
        endDate: '2192-08-31',
        includeWeb: '0',
        funnelScope: 'all',
        financialScope: 'all'
      }
    }, legacySnapshot)
    assert.equal(legacySnapshot.statusCode, 200)
    assert.deepEqual(legacySnapshot.payload.data.origin.whatsappNumbers, expectedPhoneRows)

    const newSnapshot = new ResponseRecorder()
    await getMobileAnalyticsSnapshot({
      query: {
        startDate: '2192-08-01',
        endDate: '2192-08-31',
        includeWeb: '0',
        funnelScope: 'all',
        financialScope: 'all',
        includePhoneBreakdown: '0'
      }
    }, newSnapshot)
    assert.equal(newSnapshot.statusCode, 200)
    assert.deepEqual(newSnapshot.payload.data.origin.whatsappNumbers, [])
  } finally {
    await cleanup(prefix)
  }
})

async function insertSession({ id, visitorId, source, timestamp }) {
  await db.run(`
    INSERT INTO sessions (
      id, session_id, visitor_id, event_name, started_at, created_at, utm_source
    ) VALUES (?, ?, ?, 'page_view', ?, ?, ?)
  `, [id, `${id}_session`, visitorId, timestamp, timestamp, source])
}

async function insertMessageContact({ id, fullName, phone, attributed = false, timestamp }) {
  await db.run(`
    INSERT INTO contacts (
      id, full_name, phone, email, source, attribution_ad_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'WhatsApp_API', ?, ?, ?)
  `, [
    id,
    fullName,
    phone,
    `${id}@local.invalid`,
    attributed ? `${id}_ad` : null,
    timestamp,
    timestamp
  ])
  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, provider, origin, ycloud_message_id, contact_id, phone, direction,
      message_type, message_text, detected_source_id,
      message_timestamp, created_at, updated_at
    ) VALUES (?, 'ycloud', 'whatsapp.inbound_message.received', ?, ?, ?, 'inbound',
      'text', 'Hola', ?, ?, ?, ?)
  `, [
    `${id}_message`,
    `${id}_provider`,
    id,
    phone,
    attributed ? `${id}_source` : null,
    timestamp,
    timestamp,
    timestamp
  ])
}

test.before(async () => {
  await installProjectionSchemas()
  await convergeProjections()
})

test('origin sources combina ambos ledgers y aplica ocultos sin tocar historiales crudos', async () => {
  const prefix = `origin_projection_${randomUUID().replaceAll('-', '')}`
  const timestamp = '2192-08-12T12:00:00.000Z'
  const hiddenName = `${prefix}_oculto`

  try {
    await insertSession({
      id: `${prefix}_web_google_1`,
      visitorId: `${prefix}_visitor_google`,
      source: 'google',
      timestamp
    })
    await insertSession({
      id: `${prefix}_web_google_2`,
      visitorId: `${prefix}_visitor_google`,
      source: 'google_ads',
      timestamp: '2192-08-13T12:00:00.000Z'
    })
    await insertSession({
      id: `${prefix}_web_facebook`,
      visitorId: `${prefix}_visitor_facebook`,
      source: 'facebook_ads',
      timestamp
    })
    await insertMessageContact({
      id: `${prefix}_direct`,
      fullName: `${prefix}_visible`,
      phone: `+52155${prefix.slice(-8)}`,
      timestamp
    })
    await insertMessageContact({
      id: `${prefix}_ad`,
      fullName: hiddenName,
      phone: `+52156${prefix.slice(-8)}`,
      attributed: true,
      timestamp
    })
    await convergeProjections()

    const originals = { all: db.all, get: db.get }
    const queries = []
    for (const method of ['all', 'get']) {
      db[method] = async function observedOriginRead(...args) {
        queries.push(String(args[0] || ''))
        return originals[method].apply(this, args)
      }
    }

    let response
    try {
      response = await requestOrigin()
    } finally {
      db.all = originals.all
      db.get = originals.get
    }

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.success, true)
    assert.deepEqual(response.payload.data.traffic.sources, [
      { name: 'Facebook', value: 1 },
      { name: 'Google', value: 1 },
      { name: 'Meta Ads', value: 1 },
      { name: 'WhatsApp', value: 1 }
    ])
    assert.equal(
      response.payload.data.performance.readPath,
      'tracking_analytics_facet_range_delta+origin_range_rollup'
    )
    assert.equal(
      response.headers.get('x-ristak-read-path'),
      response.payload.data.performance.readPath
    )
    assert.equal(
      queries.some(sql => /FROM\s+sessions\b|FROM\s+whatsapp_api_messages\b|FROM\s+meta_social_messages\b|FROM\s+email_messages\b/i.test(sql)),
      false,
      queries.join('\n---\n')
    )

    await db.run(`
      INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
      VALUES (?, 'exact', CURRENT_TIMESTAMP)
    `, [hiddenName])
    const filtered = await requestOrigin()
    assert.deepEqual(filtered.payload.data.traffic.sources, [
      { name: 'Facebook', value: 1 },
      { name: 'Google', value: 1 },
      { name: 'WhatsApp', value: 1 }
    ])
    assert.match(filtered.payload.data.performance.messageReadPath, /hidden_correction/)
  } finally {
    await cleanup(prefix)
  }
})

test('origin sources falla cerrado con Retry-After si tracking no está disponible', async () => {
  await db.run(`
    UPDATE tracking_analytics_projection_state_v4
    SET account_timezone = 'America/New_York'
    WHERE singleton_id = 1
  `)
  try {
    const response = await requestOrigin()
    assert.equal(response.statusCode, 503)
    assert.equal(response.payload.success, false)
    assert.equal(response.payload.code, 'tracking_analytics_projection_warming')
    assert.equal(response.payload.retryable, true)
    assert.equal(response.headers.get('retry-after'), '2')
  } finally {
    await db.run(`
      UPDATE tracking_analytics_projection_state_v4
      SET account_timezone = 'UTC'
      WHERE singleton_id = 1
    `)
  }
})

test('cerrar origin sources aborta la consulta proyectada en curso', async () => {
  const originalAll = db.all
  let databaseSignal = null
  let resolveStarted
  const started = new Promise(resolve => {
    resolveStarted = resolve
  })

  db.all = async function cancellableOriginRead(sql, params, options) {
    if (/tracking_analytics_facet_range_delta/i.test(String(sql || ''))) {
      databaseSignal = options?.signal || null
      resolveStarted()
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR'
        }))
        databaseSignal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    return originalAll.apply(this, arguments)
  }

  try {
    const response = new ResponseRecorder()
    const request = requestOrigin(rangeQuery, response)
    await started
    response.emit('close')
    await request
    assert.equal(databaseSignal?.aborted, true)
    assert.equal(response.payload, undefined)
  } finally {
    db.all = originalAll
  }
})

test('el fast path de Edge queda aislado de los scans legacy y no agenda backfills', async () => {
  const [controller, originService, messageProjection, trackingQuery] = await Promise.all([
    readFile(new URL('../src/controllers/dashboardController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/originDistributionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/messageAnalyticsProjectionService.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/trackingAnalyticsProjectionQueryService.js', import.meta.url), 'utf8')
  ])
  const projectedOrigin = originService.slice(
    originService.indexOf('export async function getProjectedOriginSourceDistribution'),
    originService.indexOf('/**\n * Distribución de tráfico')
  )
  const computeOrigin = controller.slice(
    controller.indexOf('async function computeOriginDistribution'),
    controller.indexOf('export const getOriginDistribution')
  )
  const messageOrigin = messageProjection.slice(
    messageProjection.indexOf('export async function queryMessageAnalyticsProjectionOriginSources'),
    messageProjection.indexOf('export async function queryMessageAnalyticsProjectionPhoneNumbers')
  )
  const handler = controller.slice(
    controller.indexOf('export const getOriginDistribution'),
    controller.indexOf('/**\n * Obtiene TODOS los ingresos')
  )

  assert.match(computeOrigin, /!includeBreakdowns && includeWeb && includeWhatsapp && dimension === 'sources'/)
  assert.match(computeOrigin, /getProjectedOriginSourceDistribution/)
  assert.match(projectedOrigin, /queryTrackingAnalyticsProjectionFacet/)
  assert.match(projectedOrigin, /queryMessageAnalyticsProjectionOriginSources/)
  assert.match(projectedOrigin, /schedule:\s*false/)
  assert.doesNotMatch(projectedOrigin, /FROM\s+sessions\b|whatsapp_api_messages|meta_social_messages|email_messages/)
  assert.match(trackingQuery, /tracking_analytics_facet_range_delta/)
  assert.doesNotMatch(trackingQuery, /FROM\s+sessions\b/)
  assert.match(messageOrigin, /schedule = false/)
  assert.match(messageOrigin, /\}, \{ schedule \}\)/)
  const phoneProjection = messageProjection.slice(
    messageProjection.indexOf('export async function queryMessageAnalyticsProjectionPhoneNumbers'),
    messageProjection.indexOf('export const MESSAGE_ANALYTICS_PROJECTION_LIMITS')
  )
  assert.match(phoneProjection, /schedule = false/)
  assert.match(phoneProjection, /\}, \{ schedule \}\)/)
  assert.match(handler, /includePhoneBreakdown === undefined[\s\S]*String\(includeBreakdowns\) !== '0' && shouldIncludeWhatsapp/)
  assert.match(handler, /X-Ristak-Read-Path/)
  assert.match(handler, /tracking_analytics_projection_warming/)
  assert.match(handler, /Retry-After[\s\S]*status\(503\)/)
})
