import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsSummary,
  TRACKING_ANALYTICS_BUILD_LIMITS
} from '../src/services/trackingAnalyticsService.js'
import { invalidateTrackingAnalyticsCache } from '../src/services/trackingAnalyticsCache.js'
import { getMessageAnalyticsSummary } from '../src/services/originDistributionService.js'

function observeDatabaseConcurrency({ shouldObserve = () => true } = {}) {
  const originals = {
    all: db.all,
    get: db.get
  }
  let active = 0
  let calls = 0
  let maxActive = 0

  for (const method of ['all', 'get']) {
    db[method] = async function observedDatabaseRead(...args) {
      if (!shouldObserve(...args)) return originals[method].apply(this, args)
      active += 1
      calls += 1
      maxActive = Math.max(maxActive, active)
      try {
        // Ensancha la ventana de observación: un Promise.all entre consultas
        // independientes se vuelve determinísticamente visible en esta prueba.
        await new Promise(resolve => setTimeout(resolve, 5))
        return await originals[method].apply(this, args)
      } finally {
        active -= 1
      }
    }
  }

  return {
    snapshot: () => ({ calls, maxActive }),
    restore() {
      db.all = originals.all
      db.get = originals.get
    }
  }
}

test('una carga de Analíticas usa dos carriles, nunca seis consultas simultáneas', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const observer = observeDatabaseConcurrency()
  try {
    const result = await getTrackingAnalyticsSummary({
      start: '2097-04-10',
      end: '2097-04-10',
      groupBy: 'day',
      filters: { utm_campaign: [`no-data-${process.pid}-${Date.now()}`] }
    })

    assert.equal(result.range.start, '2097-04-10')
    assert.ok(observer.snapshot().calls >= 5, 'el resumen debe ejecutar sus agregados reales')
    assert.equal(
      observer.snapshot().maxActive,
      TRACKING_ANALYTICS_BUILD_LIMITS.maxConcurrentQueries,
      'sesiones, conversiones y facetas deben compartir exactamente dos carriles pesados'
    )
  } finally {
    observer.restore()
    clearTrackingAnalyticsSummaryCache()
  }
})

test('rangos distintos de Analíticas respetan el límite global de builds pesados', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const observer = observeDatabaseConcurrency({
    shouldObserve: sql => /filtered_sessions|dimension_counts|hierarchy_base/i.test(String(sql || ''))
  })
  try {
    const unique = `${process.pid}-${Date.now()}`
    const results = await Promise.all([0, 1, 2].map(index => getTrackingAnalyticsSummary({
      start: `2097-04-${String(11 + index).padStart(2, '0')}`,
      end: `2097-04-${String(11 + index).padStart(2, '0')}`,
      groupBy: 'day',
      filters: { utm_campaign: [`no-data-${unique}-${index}`] }
    })))

    assert.equal(results.length, 3)
    assert.ok(observer.snapshot().calls >= 3, 'los tres rangos deben ejecutar sus agregados reales')
    assert.ok(
      observer.snapshot().maxActive <= TRACKING_ANALYTICS_BUILD_LIMITS.maxConcurrentQueries,
      'ningún burst de rangos puede rebasar el límite global de consultas'
    )
    assert.ok(observer.snapshot().maxActive >= 2, 'la prueba debe observar el carril doble permitido')
  } finally {
    observer.restore()
    clearTrackingAnalyticsSummaryCache()
  }
})

test('un snapshot que cruza una revisión queda stale y se reconstruye antes de declararse fresco', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originals = { all: db.all, get: db.get }
  const realDateNow = Date.now
  let now = realDateNow()
  Date.now = () => now
  let observedQueries = 0
  let releaseQueries
  let resolveFirstPair
  let holdQueries = true
  const firstPairStarted = new Promise(resolve => {
    resolveFirstPair = resolve
  })
  const queryGate = new Promise(resolve => {
    releaseQueries = resolve
  })

  for (const method of ['all', 'get']) {
    db[method] = async function revisionAwareRead(...args) {
      const sql = String(args[0] || '')
      if (/filtered_sessions|candidate_contacts|dimension_counts|hierarchy_base/i.test(sql)) {
        observedQueries += 1
        if (observedQueries === TRACKING_ANALYTICS_BUILD_LIMITS.maxConcurrentQueries) resolveFirstPair()
        if (holdQueries) await queryGate
      }
      return originals[method].apply(this, args)
    }
  }

  const input = {
    start: '2097-04-18',
    end: '2097-04-18',
    groupBy: 'day',
    filters: { utm_campaign: [`revision-${process.pid}-${Date.now()}`] }
  }

  try {
    const firstRequest = getTrackingAnalyticsSummary(input)
    await firstPairStarted
    invalidateTrackingAnalyticsCache()
    holdQueries = false
    releaseQueries()

    const crossedRevision = await firstRequest
    assert.equal(crossedRevision.snapshot.stale, true)
    assert.equal(crossedRevision.snapshot.exactAtBuiltAt, false)
    assert.equal(crossedRevision.snapshot.consistency, 'moving-window')
    const firstBuildCalls = observedQueries

    const coalesced = await getTrackingAnalyticsSummary(input)
    assert.equal(observedQueries, firstBuildCalls, 'waitForFresh no debe reconstruir sin límite durante un stream activo')
    assert.equal(coalesced.snapshot.stale, true)

    now += TRACKING_ANALYTICS_BUILD_LIMITS.coalesceWindowMs + 1
    const rebuilt = await getTrackingAnalyticsSummary(input)
    assert.ok(observedQueries > firstBuildCalls, 'el snapshot stale no debe cerrar el cache como fresco')
    assert.equal(rebuilt.snapshot.stale, false)

    const freshBuildCalls = observedQueries
    const warm = await getTrackingAnalyticsSummary(input)
    assert.equal(warm.snapshot.stale, false)
    assert.equal(observedQueries, freshBuildCalls, 'el snapshot reconstruido sí debe reutilizarse')
  } finally {
    holdQueries = false
    releaseQueries()
    db.all = originals.all
    db.get = originals.get
    Date.now = realDateNow
    clearTrackingAnalyticsSummaryCache()
  }
})

test('un stream continuo coalesce varios builds de Analíticas sin declarar exactitud falsa', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originals = { all: db.all, get: db.get }
  const realDateNow = Date.now
  let now = realDateNow()
  let mutateNextBuild = false
  let observedQueries = 0
  let mutations = 0
  Date.now = () => now

  for (const method of ['all', 'get']) {
    db[method] = async function continuouslyMutatedRead(...args) {
      const sql = String(args[0] || '')
      if (/filtered_sessions|candidate_contacts|dimension_counts|hierarchy_base/i.test(sql)) {
        observedQueries += 1
        if (mutateNextBuild) {
          mutateNextBuild = false
          mutations += 1
          invalidateTrackingAnalyticsCache()
        }
      }
      return originals[method].apply(this, args)
    }
  }

  const input = {
    start: '2097-04-19',
    end: '2097-04-19',
    groupBy: 'day',
    filters: { utm_campaign: [`continuous-${process.pid}-${realDateNow()}`] }
  }

  try {
    for (let build = 0; build < 3; build += 1) {
      mutateNextBuild = true
      const moving = await getTrackingAnalyticsSummary(input)
      assert.equal(moving.snapshot.stale, true)
      assert.equal(moving.snapshot.exactAtBuiltAt, false)
      assert.equal(moving.snapshot.consistency, 'moving-window')
      assert.ok(Date.parse(moving.snapshot.revalidateAfter) > now)

      const callsAfterBuild = observedQueries
      const coalesced = await getTrackingAnalyticsSummary(input)
      assert.equal(coalesced.snapshot.stale, true)
      assert.equal(observedQueries, callsAfterBuild, 'la ventana debe evitar un rebuild por cada request')

      now += TRACKING_ANALYTICS_BUILD_LIMITS.coalesceWindowMs + 1
    }

    assert.equal(mutations, 3)
    mutateNextBuild = false
    const exact = await getTrackingAnalyticsSummary(input)
    assert.equal(exact.snapshot.stale, false)
    assert.equal(exact.snapshot.exactAtBuiltAt, true)
    assert.equal(exact.snapshot.consistency, 'exact')
  } finally {
    mutateNextBuild = false
    db.all = originals.all
    db.get = originals.get
    Date.now = realDateNow
    clearTrackingAnalyticsSummaryCache()
  }
})

test('al irse el último consumidor se cancela la consulta pesada real', { concurrency: false }, async () => {
  clearTrackingAnalyticsSummaryCache()
  const originals = { all: db.all, get: db.get }
  let resolveQueryStarted
  const queryStarted = new Promise(resolve => {
    resolveQueryStarted = resolve
  })
  let databaseSignal = null
  let intercepted = false

  for (const method of ['all', 'get']) {
    db[method] = async function cancellableDatabaseRead(...args) {
      const sql = String(args[0] || '')
      if (!intercepted && /filtered_sessions/i.test(sql)) {
        intercepted = true
        databaseSignal = args[2]?.signal
        resolveQueryStarted()
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(databaseSignal?.reason || Object.assign(new Error('aborted'), {
            name: 'AbortError',
            code: 'ABORT_ERR'
          }))
          databaseSignal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      return originals[method].apply(this, args)
    }
  }

  try {
    const controller = new AbortController()
    const request = getTrackingAnalyticsSummary({
      start: '2097-04-20',
      end: '2097-04-20',
      groupBy: 'day',
      filters: { utm_campaign: [`cancel-${process.pid}-${Date.now()}`] },
      signal: controller.signal
    })
    await queryStarted
    controller.abort()

    await assert.rejects(request, error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(databaseSignal?.aborted, true, 'la señal debe llegar hasta la lectura de base')
  } finally {
    db.all = originals.all
    db.get = originals.get
    clearTrackingAnalyticsSummaryCache()
  }
})

test('el resumen multicanal no solapa el agregado pesado con lecturas auxiliares', { concurrency: false }, async () => {
  const observer = observeDatabaseConcurrency()
  try {
    const result = await getMessageAnalyticsSummary({
      startUtc: '2097-05-01T00:00:00.000Z',
      endUtc: '2097-05-01T23:59:59.999Z',
      appliedTimezone: 'UTC'
    }, {
      groupBy: 'day',
      // Un filtro activo evita depender del estado del read model first-seen;
      // el agregado y los estados de conexión sí recorren el camino productivo.
      filters: { channels: [`no-data-${process.pid}-${Date.now()}`] }
    })

    assert.ok(result.metrics)
    assert.ok(observer.snapshot().calls >= 4, 'el endpoint debe ejecutar agregado y estados reales')
    assert.ok(
      observer.snapshot().maxActive <= 2,
      'sólo se permite el par interno de configuración Meta; el agregado pesado y los estados deben ser secuenciales'
    )
  } finally {
    observer.restore()
  }
})

test('el resumen multicanal reduce auxiliares a dos olas acotadas sin cambiar el payload', { concurrency: false }, async () => {
  const originals = { all: db.all, get: db.get }
  const calls = []
  let active = 0
  let maxActive = 0
  let aggregateActive = false
  let auxiliaryOverlap = 0

  const enter = async (sql) => {
    const text = String(sql || '')
    const aggregate = /WITH\s+message_base\s+AS/i.test(text)
    if (!aggregate && aggregateActive) auxiliaryOverlap += 1
    if (aggregate) aggregateActive = true
    active += 1
    maxActive = Math.max(maxActive, active)
    calls.push(text)
    await new Promise(resolve => setTimeout(resolve, 8))
    return aggregate
  }
  const leave = (aggregate) => {
    active -= 1
    if (aggregate) aggregateActive = false
  }

  db.all = async function boundedAnalyticsAll(sql) {
    const aggregate = await enter(sql)
    try {
      if (/FROM\s+hidden_contact_filters/i.test(String(sql || ''))) return []
      if (aggregate) {
        return [
          {
            row_type: 'metrics',
            label: '',
            value: '',
            count_value: 4,
            secondary_value: 3,
            tertiary_value: 1,
            all_messages_value: 4
          },
          {
            row_type: 'trend',
            label: '2097-06-01',
            value: '',
            count_value: 4,
            secondary_value: 0,
            tertiary_value: 0,
            all_messages_value: 0
          },
          {
            row_type: 'channel_filter',
            label: 'WhatsApp',
            value: 'whatsapp',
            count_value: 3,
            secondary_value: 0,
            tertiary_value: 0,
            all_messages_value: 0
          },
          {
            row_type: 'source_filter',
            label: 'Meta Ads',
            value: 'Meta Ads',
            count_value: 1,
            secondary_value: 0,
            tertiary_value: 0,
            all_messages_value: 0
          }
        ]
      }
      throw new Error(`Lectura all inesperada en prueba: ${String(sql || '').slice(0, 120)}`)
    } finally {
      leave(aggregate)
    }
  }

  db.get = async function boundedAnalyticsGet(sql) {
    const aggregate = await enter(sql)
    try {
      const text = String(sql || '')
      if (/AS\s+whatsapp_total[\s\S]+AS\s+meta_contact_total[\s\S]+AS\s+email_config_value/i.test(text)) {
        return {
          whatsapp_total: 1,
          meta_contact_total: 0,
          email_config_value: JSON.stringify({ connected: true })
        }
      }
      if (/SELECT\s+\*\s+FROM\s+meta_config\s+LIMIT\s+1/i.test(text)) return null
      if (/FROM\s+meta_oauth_integrations/i.test(text)) {
        return {
          id: 'social-fixture',
          integration_kind: 'social',
          status: 'active',
          connection_id: 'social-fixture',
          page_id: 'page-fixture',
          instagram_account_id: 'instagram-fixture',
          granted_scopes_json: '[]',
          missing_scopes_json: '[]',
          granular_scopes_json: '[]'
        }
      }
      if (/FROM\s+message_first_seen_projection_state/i.test(text)) {
        return { singleton_id: 1, projection_version: 1, status: 'ready', last_error: null }
      }
      if (/FROM\s+message_identity_first_seen_global/i.test(text)) return { total: 2 }
      throw new Error(`Lectura get inesperada en prueba: ${text.slice(0, 120)}`)
    } finally {
      leave(aggregate)
    }
  }

  try {
    const summary = await getMessageAnalyticsSummary({
      startUtc: '2097-06-01T00:00:00.000Z',
      endUtc: '2097-06-01T23:59:59.999Z',
      appliedTimezone: 'UTC'
    }, { groupBy: 'day' })

    assert.deepEqual(summary, {
      metrics: {
        inboundMessages: 4,
        conversations: 3,
        contacts: 2,
        attributionRate: 33.3
      },
      trend: [{ label: '2097-06-01', messages: 4 }],
      filters: {
        channels: [{ name: 'WhatsApp', value: 'whatsapp', count: 3 }],
        sources: [{ name: 'Meta Ads', value: 'Meta Ads', count: 1 }]
      },
      status: {
        connected: true,
        hasData: true,
        channels: {
          whatsapp: true,
          messenger: true,
          instagram: true,
          email: true
        },
        firstSeenProjection: 'ready',
        firstSeenProjectionComplete: true
      }
    })
    assert.equal(auxiliaryOverlap, 0, 'ninguna lectura auxiliar debe empezar mientras corre el agregado')
    assert.equal(maxActive, 3, 'first-seen mas el par interno Meta deben quedar acotados a tres conexiones')

    const localStatusCalls = calls.filter(sql => (
      /whatsapp_api_phone_numbers/i.test(sql) &&
      /meta_social_contacts/i.test(sql) &&
      /email_smtp_config/i.test(sql)
    ))
    assert.equal(localStatusCalls.length, 1, 'los tres estados locales deben compartir un solo SELECT')
    assert.equal(calls.length, 7, 'hidden, agregado y cinco lecturas auxiliares forman el camino completo')
  } finally {
    db.all = originals.all
    db.get = originals.get
  }
})

test('cancelar el resumen multicanal aborta el SELECT auxiliar combinado', { concurrency: false }, async () => {
  const originals = { all: db.all, get: db.get }
  let resolveAuxiliaryStarted
  const auxiliaryStarted = new Promise(resolve => {
    resolveAuxiliaryStarted = resolve
  })
  let auxiliarySignal = null
  let metaConfigReads = 0

  db.all = async function cancellableAnalyticsAll(sql) {
    if (/FROM\s+hidden_contact_filters/i.test(String(sql || ''))) return []
    if (/WITH\s+message_base\s+AS/i.test(String(sql || ''))) {
      return [{
        row_type: 'metrics',
        count_value: 0,
        secondary_value: 0,
        tertiary_value: 0,
        all_messages_value: 0
      }]
    }
    return originals.all.apply(this, arguments)
  }

  db.get = async function cancellableAnalyticsGet(sql, params, options) {
    const text = String(sql || '')
    if (/AS\s+whatsapp_total[\s\S]+AS\s+meta_contact_total[\s\S]+AS\s+email_config_value/i.test(text)) {
      auxiliarySignal = options?.signal || null
      resolveAuxiliaryStarted()
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR'
        }))
        auxiliarySignal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (/meta_config|meta_oauth_integrations/i.test(text)) metaConfigReads += 1
    return originals.get.apply(this, arguments)
  }

  try {
    const controller = new AbortController()
    const request = getMessageAnalyticsSummary({
      startUtc: '2097-06-02T00:00:00.000Z',
      endUtc: '2097-06-02T23:59:59.999Z',
      appliedTimezone: 'UTC'
    }, {
      groupBy: 'day',
      filters: { channels: ['whatsapp'] },
      signal: controller.signal
    })

    await auxiliaryStarted
    controller.abort()

    await assert.rejects(request, error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
    assert.equal(auxiliarySignal?.aborted, true, 'la señal del request debe llegar al SELECT combinado')
    assert.equal(metaConfigReads, 0, 'después de abortar no debe abrirse la siguiente ola Meta')
  } finally {
    db.all = originals.all
    db.get = originals.get
  }
})
