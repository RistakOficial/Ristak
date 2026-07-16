import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { db, setAppConfig } from '../src/config/database.js'
import {
  getFinancialOverview,
  getFunnelData,
  getMetrics,
  getMobileAnalyticsSnapshot,
  getOriginDistribution
} from '../src/controllers/dashboardController.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = path => readFile(join(repoRoot, path), 'utf8')

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    writableEnded: false,
    finished: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      this.finished = true
      return payload
    }
  }
}

test('Analíticas móvil abre con una petición abortable y deja los cambios de vista como cargas focales', async () => {
  const [phone, frontendService, controller, routes, whatsappService, iosViewModel] = await Promise.all([
    repoFile('frontend/src/pages/PhoneAnalytics/PhoneAnalytics.tsx'),
    repoFile('frontend/src/services/dashboardService.ts'),
    repoFile('backend/src/controllers/dashboardController.js'),
    repoFile('backend/src/routes/dashboard.routes.js'),
    repoFile('backend/src/services/whatsappApiService.js'),
    repoFile('ios/app/Ristak/Features/Analytics/AnalyticsViewModel.swift')
  ])

  assert.equal((phone.match(/dashboardService\.getMobileAnalyticsSnapshot\(/g) || []).length, 1)
  assert.doesNotMatch(phone, /whatsappApiService\.getStatus/)
  const snapshotEffectStart = phone.indexOf('dashboardService.getMobileAnalyticsSnapshot(snapshotParams')
  const snapshotEffectEnd = phone.indexOf('useEffect(() => {', snapshotEffectStart)
  const snapshotEffect = phone.slice(snapshotEffectStart, snapshotEffectEnd)
  assert.doesNotMatch(snapshotEffect, /getDashboardMetrics|getOriginDistribution|getFunnelData|getFinancialChart/)
  assert.match(phone, /requestId !== snapshotRequestIdRef\.current/)
  assert.match(phone, /snapshotReadyRangeRef\.current !== rangeKey/)
  assert.match(phone, /controller\.abort\(\)/)
  assert.match(phone, /financialScope: requestedFinancialScope,\s*includePhoneBreakdown: false/)

  assert.match(frontendService, /MOBILE_ANALYTICS_CACHE_LIMIT = 8/)
  assert.match(frontendService, /registerAuthScopedCacheInvalidator\(clearMobileAnalyticsSnapshots\)/)
  assert.match(frontendService, /principalRevision === getAuthScopedCacheRevision\(\)/)
  assert.match(frontendService, /mobile-analytics-snapshot\?\$\{queryParams\}/)
  assert.match(frontendService, /queryParams\.set\('includePhoneBreakdown', params\.includePhoneBreakdown \? '1' : '0'\)/)
  assert.match(frontendService, /signal: options\.signal/)
  assert.match(frontendService, /inflight: mobileAnalyticsInflight/)
  assert.match(frontendService, /abortWhenUnused: true/)
  assert.match(frontendService, /createRequest: sharedSignal => scheduleDashboardHeavyRead\(\{[\s\S]*Analíticas móvil tardó demasiado/)
  const schedulerStart = frontendService.indexOf('function scheduleDashboardHeavyRead')
  const schedulerEnd = frontendService.indexOf('function clearDashboardMetricSnapshots', schedulerStart)
  const scheduler = frontendService.slice(schedulerStart, schedulerEnd)
  assert.match(scheduler, /return scheduleDashboardHeavyRequest\(/)
  assert.match(scheduler, /\(\) => withRequestTimeout\(\{/)
  assert.ok(
    scheduler.indexOf('scheduleDashboardHeavyRequest(') < scheduler.indexOf('withRequestTimeout({'),
    'el timeout de ejecución debe empezar después de obtener un carril pesado'
  )

  assert.match(routes, /router\.get\('\/mobile-analytics-snapshot', requireWebAnalyticsWhenIncluded, getMobileAnalyticsSnapshot\)/)
  const handlerStart = controller.indexOf('export const getMobileAnalyticsSnapshot')
  const handlerEnd = controller.indexOf('async function getAttributionCalendarIds', handlerStart)
  const handler = controller.slice(handlerStart, handlerEnd)
  assert.match(handler, /computeDashboardMetrics\(range, requestScope\.signal/)
  assert.match(handler, /computeOriginDistribution\(range/)
  assert.match(handler, /dimension:\s*'sources'/)
  assert.match(handler, /includePhoneBreakdown === undefined\s*\? true\s*:\s*String\(includePhoneBreakdown\) === '1'/)
  assert.match(handler, /includePhoneBreakdown: shouldIncludePhoneBreakdown/)
  assert.match(handler, /computeFunnelData\(range/)
  assert.match(handler, /computeFinancialOverview\(range/)
  assert.match(handler, /getLocalWhatsAppAnalyticsPhoneNumbers\(\{ signal: requestScope\.signal \}\)/)
  assert.doesNotMatch(handler, /getMetrics\(|getOriginDistribution\(|getFunnelData\(|getFinancialOverview\(|fetch\(/)
  assert.match(whatsappService, /getPhoneNumbersFromDb\(\{ signal, limit: 100, connectedOnly: true \}\)/)
  assert.match(whatsappService, /Lectura estrictamente local y ligera/)

  const reloadStart = iosViewModel.indexOf('func reloadAll() async -> Bool')
  const reloadEnd = iosViewModel.indexOf('func retryMetrics()', reloadStart)
  const reloadContract = iosViewModel.slice(reloadStart, reloadEnd)
  assert.match(reloadContract, /guard let range else \{ return false \}[\s\S]*cancelOriginPhoneBreakdown\(clearCompleted: true\)[\s\S]*primaryReloadInProgress = true/)
  assert.doesNotMatch(reloadContract, /if phoneOriginRequested[\s\S]*cancelOriginPhoneBreakdown\(clearCompleted: true\)/)
  const stopStart = iosViewModel.indexOf('func stopOriginPhoneBreakdown()')
  const stopEnd = iosViewModel.indexOf('// MARK: - Cargas', stopStart)
  assert.match(
    iosViewModel.slice(stopStart, stopEnd),
    /phoneOriginRequested = false[\s\S]*cancelOriginPhoneBreakdown\(clearCompleted: false\)/
  )
})

test('el snapshot conserva payload acotado con más de cien números y no toca proveedores', async () => {
  const marker = `mobile_analytics_${Date.now()}_${Math.random().toString(16).slice(2)}`
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()

  try {
    for (let index = 0; index < 125; index += 1) {
      const suffix = String(index).padStart(3, '0')
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          api_send_enabled, qr_send_enabled, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, 1, 0, ?)
      `, [
        `${marker}_${suffix}`,
        `521555${suffix}`,
        `+52 1 555 ${suffix}`,
        `${marker} ${suffix}`,
        `2199-12-31T23:59:${String(index % 60).padStart(2, '0')}.000Z`
      ])
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('El snapshot móvil no debe consultar proveedores externos')
    }
    const response = responseRecorder()
    try {
      await getMobileAnalyticsSnapshot({
        query: {
          startDate: '2199-01-01',
          endDate: '2199-01-30',
          includeWeb: '0',
          funnelScope: 'all',
          financialScope: 'all',
          includePhoneBreakdown: '0'
        }
      }, response)
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.success, true)
    assert.ok(response.payload.data.metrics?.ingresosNetos)
    assert.ok(Array.isArray(response.payload.data.origin?.leads))
    assert.ok(Array.isArray(response.payload.data.funnel))
    assert.ok(Array.isArray(response.payload.data.financialChart))
    assert.equal(response.payload.data.funnel.some(item => item.stage === 'Visitantes'), false)
    assert.equal(response.payload.data.whatsappPhoneNumbers.length, 100)
    assert.ok(response.payload.data.whatsappPhoneNumbers.every(item => item.verified_name?.startsWith(marker)))
    assert.equal(response.payload.data.range.timezone, 'UTC')
  } finally {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id LIKE ?', [`${marker}%`])
  }
})

test('el snapshot y Dashboard conservan una sola definición de cada métrica', async () => {
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()
  const query = {
    startDate: '2197-05-01',
    endDate: '2197-05-30',
    includeWeb: '0',
    includeWhatsapp: '1',
    scope: 'all',
    dimension: 'sources',
    includePhoneBreakdown: '0'
  }
  const snapshotResponse = responseRecorder()
  const metricsResponse = responseRecorder()
  const originResponse = responseRecorder()
  const funnelResponse = responseRecorder()
  const financialResponse = responseRecorder()

  await Promise.all([
    getMobileAnalyticsSnapshot({
      query: { ...query, funnelScope: 'all', financialScope: 'all' }
    }, snapshotResponse),
    getMetrics({ query }, metricsResponse),
    getOriginDistribution({ query }, originResponse),
    getFunnelData({ query }, funnelResponse),
    getFinancialOverview({ query }, financialResponse)
  ])

  assert.deepEqual(snapshotResponse.payload.data.metrics, metricsResponse.payload)
  assert.deepEqual(snapshotResponse.payload.data.origin, originResponse.payload.data)
  assert.deepEqual(snapshotResponse.payload.data.funnel, funnelResponse.payload.data)
  assert.deepEqual(snapshotResponse.payload.data.financialChart, financialResponse.payload.data)
})
