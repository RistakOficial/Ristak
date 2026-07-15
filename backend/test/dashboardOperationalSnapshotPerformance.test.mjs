import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('el Dashboard pide el funnel una sola vez con el scope activo', async () => {
  const dashboard = await repoFile('frontend/src/pages/Dashboard/Dashboard.tsx')
  const funnelRequests = dashboard.match(/dashboardService\.getFunnelData\(/g) || []

  assert.equal(funnelRequests.length, 1)
  assert.match(dashboard, /scope:\s*funnelScope/)
  assert.doesNotMatch(dashboard, /getFunnelData\([\s\S]{0,220}scope:\s*'all'/)
})

test('el snapshot operativo reemplaza descargas completas y llamadas de calendario', async () => {
  const [dashboard, dashboardService] = await Promise.all([
    repoFile('frontend/src/pages/Dashboard/Dashboard.tsx'),
    repoFile('frontend/src/services/dashboardService.ts')
  ])

  assert.match(dashboard, /dashboardService\.getOperationalSnapshot\(/)
  assert.doesNotMatch(dashboard, /transactionsService\.getTransactions\(/)
  assert.doesNotMatch(dashboard, /calendarsService\.getEvents\(/)

  const methodStart = dashboardService.indexOf('async getOperationalSnapshot')
  const methodEnd = dashboardService.indexOf('async getFinancialChart', methodStart)
  const method = dashboardService.slice(methodStart, methodEnd)
  assert.match(method, /\/api\/dashboard\/operational-snapshot/)
  assert.match(method, /endDate:\s*formatDateToISO\(params\.end\)/)
  assert.doesNotMatch(method, /formatEndDateToISO\(params\.end\)/)
})

test('el endpoint agregado usa solo DB local y limita cada lista a cinco filas', async () => {
  const [controller, routes] = await Promise.all([
    repoFile('backend/src/controllers/dashboardController.js'),
    repoFile('backend/src/routes/dashboard.routes.js')
  ])

  assert.match(routes, /router\.get\('\/operational-snapshot', getOperationalSnapshot\)/)
  assert.match(controller, /const DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT = 5/)

  const handlerStart = controller.indexOf('export const getOperationalSnapshot')
  const handlerEnd = controller.indexOf('export const getMetrics', handlerStart)
  const handler = controller.slice(handlerStart, handlerEnd)

  assert.equal((handler.match(/LIMIT \$\{DASHBOARD_OPERATIONAL_SNAPSHOT_LIMIT\}/g) || []).length, 3)
  assert.match(handler, /FROM payments p[\s\S]*ORDER BY p\.date DESC/)
  assert.match(handler, /buildTransactionListWhere\(\{/)
  assert.match(handler, /includeStatus:\s*false/)
  assert.match(handler, /extraContactConditions:\s*\[nonTestPaymentCondition\('p'\)\]/)
  assert.match(handler, /createDashboardReadLimiter\(requestScope\.signal, 2\)/)
  assert.match(handler, /runRead\(\(\) => db\.all\(paymentsQuery, paymentListWhere\.params, \{ signal: requestScope\.signal \}\)\)/)
  assert.match(handler, /FROM contacts c[\s\S]*ORDER BY c\.created_at DESC/)
  assert.match(handler, /FROM appointments a[\s\S]*ORDER BY a\.start_time DESC/)
  assert.equal((handler.match(/runRead\(\(\) => db\.all\(/g) || []).length, 3)
  assert.match(handler, /createDashboardRequestAbortScope\(res\)/)
  assert.doesNotMatch(handler, /fetch\(|import\(|calendarService\.|stripeService\.|highLevelService\./)
  assert.match(handler, /transactions:\s*paymentRows\.map\(mapOperationalTransaction\)/)
  assert.match(handler, /contacts:\s*contactRows\.map\(mapOperationalContact\)/)
  assert.match(handler, /appointments:\s*appointmentRows\.map\(mapOperationalAppointment\)/)
})

test('métricas current/previous y el contexto móvil comparten carriles de máximo dos lecturas', async () => {
  const controller = await repoFile('backend/src/controllers/dashboardController.js')
  const financialSnapshot = controller
    .split('const computeFinancialSnapshot = async')[1]
    .split('export const getOperationalSnapshot')[0]
  const metrics = controller
    .split('async function computeDashboardMetrics')[1]
    .split('export const getMetrics')[0]
  const mobile = controller
    .split('export const getMobileAnalyticsSnapshot')[1]
    .split('async function getAttributionCalendarIds')[0]

  assert.equal((financialSnapshot.match(/runRead\(\(\) =>/g) || []).length, 4)
  assert.equal((metrics.match(/createDashboardReadLimiter\(signal, 2\)/g) || []).length, 1)
  assert.match(metrics, /computeFinancialSnapshot\(range, signal, sharedHiddenFilters, runRead\)/)
  assert.match(metrics, /computeFinancialSnapshot\(previousRange, signal, sharedHiddenFilters, runRead\)/)

  assert.equal((mobile.match(/createDashboardReadLimiter\(requestScope\.signal, 2\)/g) || []).length, 1)
  assert.equal((mobile.match(/runContextRead\(\(\) =>/g) || []).length, 4)
})

test('el servicio web pone todas las familias pesadas dentro del timeout y una cola abortable', async () => {
  const service = await repoFile('frontend/src/services/dashboardService.ts')

  assert.match(service, /const dashboardHeavyRequestQueue:/)
  assert.match(service, /const DASHBOARD_HEAVY_REQUEST_CONCURRENCY = 2/)
  assert.match(service, /const DASHBOARD_HEAVY_QUEUE_TIMEOUT_MS = 10_000/)
  assert.match(service, /dashboardHeavyRequestActiveCount < DASHBOARD_HEAVY_REQUEST_CONCURRENCY/)
  assert.match(service, /signal\?\.addEventListener\('abort', onAbort, \{ once: true \}\)/)
  assert.match(service, /dashboardHeavyRequestQueue\.splice\(index, 1\)/)
  assert.match(service, /onQueueTimeout[\s\S]*new RequestTimeoutError\(queueTimeoutMessage\)/)
  assert.match(service, /scheduleDashboardHeavyRequest\([\s\S]*\(\) => withRequestTimeout\(\{/)
  assert.equal((service.match(/scheduleDashboardHeavyRead\(\{/g) || []).length, 8)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.metrics/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.operational/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.financial/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.extendedChart/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.funnel/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.trafficSources/)
  assert.match(service, /priority: DASHBOARD_HEAVY_PRIORITY\.origin/)
  assert.ok((service.match(/if \(!abortInflight\) return/g) || []).length >= 2)
})

test('la gráfica extendida pide únicamente el par visible y lo pasa por la cola pesada', async () => {
  const [dashboard, service] = await Promise.all([
    repoFile('frontend/src/pages/Dashboard/Dashboard.tsx'),
    repoFile('frontend/src/services/dashboardService.ts')
  ])
  const loaderStart = dashboard.indexOf('const loadExtendedChartData = React.useCallback')
  const loaderEnd = dashboard.indexOf('React.useEffect(() => {', loaderStart)
  const loader = dashboard.slice(loaderStart, loaderEnd)

  const expectedPairs = [
    ['visitors-leads', 'getVisitorsData', 'getLeadsData'],
    ['leads-appointments', 'getLeadsData', 'getAppointmentsData'],
    ['appointments-attendances', 'getAppointmentsData', 'getAttendancesData'],
    ['attendances-sales', 'getAttendancesData', 'getSalesData']
  ]

  for (let index = 0; index < expectedPairs.length; index += 1) {
    const [view, primaryMethod, secondaryMethod] = expectedPairs[index]
    const caseStart = loader.indexOf(`case '${view}':`)
    const nextCase = expectedPairs[index + 1]?.[0]
    const caseEnd = nextCase ? loader.indexOf(`case '${nextCase}':`, caseStart) : loader.indexOf('\n      }', caseStart)
    const branch = loader.slice(caseStart, caseEnd)

    assert.ok(caseStart >= 0, `falta la rama ${view}`)
    assert.match(branch, new RegExp(`dashboardService\\.${primaryMethod}\\(`))
    assert.match(branch, new RegExp(`dashboardService\\.${secondaryMethod}\\(`))
    assert.equal((branch.match(/dashboardService\.get[A-Z][A-Za-z]+Data\(/g) || []).length, 2)
  }

  assert.match(loader, /Promise\.all\(\[\s*primarySeriesPromise,\s*secondarySeriesPromise\s*\]\)/)
  assert.doesNotMatch(loader, /\[visitorsData, leadsData, appointmentsData, attendancesData, salesData\]/)

  const seriesLoaderStart = service.indexOf('async function fetchDashboardSeries')
  const seriesLoaderEnd = service.indexOf('\nclass DashboardService', seriesLoaderStart)
  const seriesLoader = service.slice(seriesLoaderStart, seriesLoaderEnd)
  assert.match(seriesLoader, /scheduleDashboardHeavyRead\(\{[\s\S]*timeoutMessage:/)
  assert.match(seriesLoader, /priority: DASHBOARD_HEAVY_PRIORITY\.extendedChart/)
  assert.match(seriesLoader, /request: async requestSignal/)
})

test('la dona de origen pide sólo la dimensión visible y omite desgloses que no renderiza', async () => {
  const [component, service, controller, originService] = await Promise.all([
    repoFile('frontend/src/components/common/OriginDistributionCard/OriginDistributionCard.tsx'),
    repoFile('frontend/src/services/dashboardService.ts'),
    repoFile('backend/src/controllers/dashboardController.js'),
    repoFile('backend/src/services/originDistributionService.js')
  ])

  assert.match(component, /dimension,\s*includeWhatsapp: PEOPLE_DIMENSIONS\.has\(dimension\),\s*includeBreakdowns: false/)
  assert.match(component, /\[dateRange\.start, dateRange\.end, dimension, retryKey, showToast\]/)
  const originCatch = component.slice(
    component.indexOf('.catch((error) => {'),
    component.indexOf('.finally(', component.indexOf('.catch((error) => {'))
  )
  assert.doesNotMatch(originCatch, /setData\(EMPTY\)/)
  assert.match(originCatch, /setLoadError\(message\)/)
  assert.match(component, /headerAction=\{loadError[\s\S]*setRetryKey\(current => current \+ 1\)/)
  assert.match(service, /if \(params\.dimension\) queryParams\.set\('dimension', params\.dimension\)/)
  assert.match(service, /includeBreakdowns: params\.includeBreakdowns === false \? '0' : '1'/)
  assert.match(service, /originDistributionSnapshots/)

  const originStart = controller.indexOf('async function computeOriginDistribution')
  const originEnd = controller.indexOf('export const getOriginDistribution', originStart)
  const computeOrigin = controller.slice(originStart, originEnd)
  assert.match(computeOrigin, /if \(!includeBreakdowns\) \{[\s\S]*leads: \[\][\s\S]*whatsappNumbers: \[\]/)
  assert.match(computeOrigin, /getTrafficDistributions\(range, \{[\s\S]*dimension,/)
  assert.match(originService, /const selectedBranches = selectedDimension[\s\S]*\[dimensionBranches\[selectedDimension\]\]/)
  assert.match(originService, /dimension_values AS \([\s\S]*\$\{selectedBranches\.join/)
})

test('las tres consultas acotadas se apoyan en indices de fecha existentes', async () => {
  const database = await repoFile('backend/src/config/database.js')

  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_payments_date ON payments\(date\)/)
  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts\(created_at\)/)
  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments\(start_time\)/)
})

test('las fuentes de tráfico cancelan timezone y consultas al cerrar o vencer el request', async () => {
  const controller = await repoFile('backend/src/controllers/dashboardController.js')
  const handlerStart = controller.indexOf('export const getTrafficSources')
  const handlerEnd = controller.indexOf('async function getSourceBreakdownByMetric', handlerStart)
  const handler = controller.slice(handlerStart, handlerEnd)

  assert.match(handler, /createDashboardRequestAbortScope\(res,\s*\{[\s\S]*DASHBOARD_ANALYTICS_DEADLINE_MS/)
  assert.match(handler, /resolveDateRangeWithGHLTimezone\(\{[\s\S]*signal:\s*requestScope\.signal/)
  assert.match(handler, /getHiddenContactFilters\(\{ signal: requestScope\.signal \}\)/)
  assert.match(handler, /getTrafficDistributions\(range,\s*\{[\s\S]*signal:\s*requestScope\.signal/)
  assert.match(handler, /requestScope\.timedOut[\s\S]*status\(503\)/)
  assert.match(handler, /requestScope\.cleanup\(\)/)
})
