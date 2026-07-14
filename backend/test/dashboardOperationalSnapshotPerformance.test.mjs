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
  assert.match(handler, /db\.all\(paymentsQuery, paymentListWhere\.params\)/)
  assert.match(handler, /FROM contacts c[\s\S]*ORDER BY c\.created_at DESC/)
  assert.match(handler, /FROM appointments a[\s\S]*ORDER BY a\.start_time DESC/)
  assert.match(handler, /Promise\.all\(\[[\s\S]*db\.all\(paymentsQuery[\s\S]*db\.all\(contactsQuery[\s\S]*db\.all\(appointmentsQuery/)
  assert.doesNotMatch(handler, /fetch\(|import\(|calendarService\.|stripeService\.|highLevelService\./)
  assert.match(handler, /transactions:\s*paymentRows\.map\(mapOperationalTransaction\)/)
  assert.match(handler, /contacts:\s*contactRows\.map\(mapOperationalContact\)/)
  assert.match(handler, /appointments:\s*appointmentRows\.map\(mapOperationalAppointment\)/)
})

test('las tres consultas acotadas se apoyan en indices de fecha existentes', async () => {
  const database = await repoFile('backend/src/config/database.js')

  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_payments_date ON payments\(date\)/)
  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts\(created_at\)/)
  assert.match(database, /CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments\(start_time\)/)
})
