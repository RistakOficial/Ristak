import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('Contactos no descarga años de citas para complementar una página de veinte filas', async () => {
  const source = await repoFile('frontend/src/pages/Contacts/Contacts.tsx')

  assert.doesNotMatch(source, /calendarsService\.getEvents/)
  assert.doesNotMatch(source, /setAllEvents|loadingEvents|allEvents\.some/)
  assert.match(source, /contact\.hasShowedAppointment \|\| contact\.hasAttendedAppointment/)
  assert.match(source, /contact\.appointments\?\.some/)
})

test('Contactos no recalcula KPIs globales al cambiar únicamente de página u orden', async () => {
  const source = await repoFile('frontend/src/pages/Contacts/Contacts.tsx')
  const pageLoader = source.match(/const fetchData = async[\s\S]*?\n  const fetchStats = async/)?.[0] || ''
  const statsLoader = source.match(/const fetchStats = async[\s\S]*?\n  const refreshContactsAndStats/)?.[0] || ''

  assert.doesNotMatch(pageLoader, /contactsService\.getStats/)
  assert.match(statsLoader, /contactsService\.getStats/)
  assert.match(source, /const contactsStatsQueryKey = useMemo/)
  assert.match(source, /sort: _sort, \.\.\.filtersWithoutSort/)
  assert.match(source, /contactsStatsQueryKeyRef\.current === contactsStatsQueryKey/)
})

test('los drill-downs de contactos acotan citas y paginan sin mentir sobre el total', async () => {
  const [tracking, reportsService, modal] = await Promise.all([
    repoFile('backend/src/controllers/trackingController.js'),
    repoFile('frontend/src/services/reportsService.ts'),
    repoFile('frontend/src/components/common/ContactDetailsModal/ContactDetailsModal.tsx')
  ])

  assert.match(tracking, /fetchBoundedAppointmentsForContacts\(contactIds, limitPerContact = 5\)/)
  assert.match(tracking, /appointmentsTotal: appointmentSummary\.total/)
  assert.match(tracking, /appointmentsTruncated: appointmentSummary\.total > appointmentSummary\.appointments\.length/)
  assert.match(reportsService, /appointmentsTotal\?: number/)
  assert.match(reportsService, /appointmentsTruncated\?: boolean/)
  assert.match(modal, /selectedContact\?\.appointmentsTotal \?\? selectedContact\?\.appointments\?\.length/)
  assert.match(modal, /Array\.isArray\(detail\.appointments\)[\s\S]*?hydrated\.appointmentsTruncated = false/)
  assert.match(modal, /contactsService\.getContactAppointmentsPage/)
  assert.match(modal, /Cargar más citas/)
})

test('la búsqueda de Chat pinta la primera página y pagina al hacer scroll', async () => {
  const source = await repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx')
  const searchBranch = source.match(/} else if \(hasSearch\) \{[\s\S]*?} else if \(silent\) \{/)?.[0] || ''

  assert.match(searchBranch, /const pageChats = await fetchChatPage\(null\)/)
  assert.doesNotMatch(searchBranch, /while \(/)
  assert.match(searchBranch, /chatListHasMoreRef\.current = pageChats\.length >= CHAT_LIST_PAGE_SIZE && Boolean\(chatListCursorRef\.current\)/)
  assert.doesNotMatch(source, /if \(hasSearch\) return/)
})

test('Chat Desktop y Phone cargan páginas profundas con keyset exacto, no con offset', async () => {
  const [desktop, phone] = await Promise.all([
    repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'),
    repoFile('frontend/src/pages/PhoneChat/PhoneChat.tsx')
  ])

  for (const source of [desktop, phone]) {
    assert.match(source, /beforeMessageDate: cursor\.beforeMessageDate/)
    assert.match(source, /beforeMessageSort: cursor\.beforeMessageSort/)
    assert.match(source, /beforeMessageScope: cursor\.beforeMessageScope/)
    assert.match(source, /beforeContactId: cursor\.beforeContactId/)
    assert.match(source, /chatListCursorRef\.current !== cursor/)
    assert.doesNotMatch(source, /chatListOffsetRef/)
    assert.doesNotMatch(source, /offset: String\(pageOffset\)/)
  }
})

test('el asistente pesado no forma parte estática del AppShell', async () => {
  const source = await repoFile('frontend/src/components/layout/AppShell/AppShell.tsx')

  assert.doesNotMatch(source, /import \{ AIAgentPanel \} from '@\/components\/ai'/)
  assert.match(source, /React\.lazy\(\(\) => import\('@\/components\/ai\/AIAgentPanel\/AIAgentPanel'\)/)
  assert.match(source, /<React\.Suspense fallback=\{null\}>[\s\S]*<AIAgentPanel/)
})

test('Dashboard no arrastra modales y servicios de drill-down en su primer chunk', async () => {
  const source = await repoFile('frontend/src/pages/Dashboard/Dashboard.tsx')

  assert.doesNotMatch(source, /import \{ ContactDetailsModal \} from/)
  assert.doesNotMatch(source, /import \{ VisitorDetailsModal \} from/)
  assert.doesNotMatch(source, /import \{ reportsService/)
  assert.doesNotMatch(source, /import \{ campaignsService/)
  assert.match(source, /React\.lazy\(async \(\) => \{[\s\S]*ContactDetailsModal/)
  assert.match(source, /React\.lazy\(async \(\) => \{[\s\S]*VisitorDetailsModal/)
  assert.match(source, /const loadReportsService = \(\) => import/)
  assert.match(source, /const loadCampaignsService = \(\) => import/)
  assert.match(source, /Abriendo detalles\.\.\./)
})

test('Dashboard pinta su ultimo snapshot antes de revalidar y cancela rangos obsoletos', async () => {
  const [page, service] = await Promise.all([
    repoFile('frontend/src/pages/Dashboard/Dashboard.tsx'),
    repoFile('frontend/src/services/dashboardService.ts')
  ])

  assert.match(service, /peekDashboardMetrics/)
  assert.match(service, /DASHBOARD_METRICS_STALE_MS/)
  assert.match(service, /registerAuthScopedCacheInvalidator\(clearDashboardMetricSnapshots\)/)
  assert.match(service, /registerRistakApiReadCacheInvalidator\(clearDashboardMetricSnapshots\)/)
  assert.match(service, /principalRevision === getAuthScopedCacheRevision\(\)/)
  assert.match(page, /useState<DashboardMetrics \| null>\(\(\) => \(/)
  assert.match(page, /const cachedMetrics = dashboardService\.peekDashboardMetrics/)
  assert.match(page, /forceRefresh: Boolean\(cachedMetrics\)/)
  assert.match(page, /controller\.abort\(\)/)
})

test('Configuración precarga el panel permitido y evita el redirect frío del menú', async () => {
  const [sidebar, settings, routes] = await Promise.all([
    repoFile('frontend/src/components/layout/Sidebar/Sidebar.tsx'),
    repoFile('frontend/src/pages/Settings/Settings.tsx'),
    repoFile('frontend/src/routing/routeModules.tsx')
  ])

  assert.match(sidebar, /getFirstAllowedSettingsPath\(user\)/)
  assert.match(sidebar, /to=\{settingsDestination\}/)
  assert.match(settings, /export const prefetchSettingsPage/)
  assert.match(routes, /const preloadSettingsRoute/)
  assert.match(routes, /settingsModule\.prefetchSettingsPage\(destination\)/)
})

test('el sidebar distingue intención real y no baja Sites pesado por un roce accidental', async () => {
  const sidebar = await repoFile('frontend/src/components/layout/Sidebar/Sidebar.tsx')

  assert.match(sidebar, /ROUTE_PREFETCH_POINTER_DWELL_MS = 150/)
  assert.match(sidebar, /onPointerEnter: \(\) => scheduleSidebarRoutePrefetch\(destination\)/)
  assert.match(sidebar, /onPointerLeave: \(\) => cancelSidebarRoutePrefetch\(destination\)/)
  assert.match(sidebar, /onPointerDown: \(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /onFocus: \(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /onTouchStart: \(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /hasModuleAccess\(user, 'sites', 'read'\)/)
  assert.match(sidebar, /connection\?\.saveData/)
  assert.match(sidebar, /effectiveType === 'slow-2g'/)
  assert.match(sidebar, /requestIdleCallback/)
  assert.match(sidebar, /prefetchRouteModule\('\/sites'\)/)
})

test('caches de integraciones y analíticas se aíslan por cuenta y siguen invalidaciones vivas', async () => {
  const [integrations, integrationsController, analytics, authFetch] = await Promise.all([
    repoFile('frontend/src/services/integrationsService.ts'),
    repoFile('backend/src/controllers/integrationsController.js'),
    repoFile('frontend/src/services/analyticsService.ts'),
    repoFile('frontend/src/services/authFetch.ts')
  ])

  assert.match(integrations, /registerAuthScopedCacheInvalidator\(clearIntegrationsStatus\)/)
  assert.match(integrations, /requestPrincipalRevision === getAuthScopedCacheRevision\(\)/)
  assert.match(integrations, /accessToken: null/)
  assert.match(integrationsController, /highlevelStatus\.accessToken = null/)
  assert.match(integrationsController, /if \(verifyExternal\) \{[\s\S]*verifyHighLevelConnection\(config\)/)
  assert.match(authFetch, /registerRistakApiReadCacheInvalidator/)
  assert.match(analytics, /registerRistakApiReadCacheInvalidator\(invalidateTrackingAnalyticsSummaryCache\)/)
})

test('eventos backend de pagos y conversiones invalidan el resumen agregado', async () => {
  const [payments, automations] = await Promise.all([
    repoFile('backend/src/services/paymentLiveEventsService.js'),
    repoFile('backend/src/services/automationEngine.js')
  ])

  assert.match(payments, /function publishPaymentEvent[\s\S]*invalidateTrackingAnalyticsCache\(\)[\s\S]*clients\.size/)
  assert.match(automations, /eventType === 'contact-created'[\s\S]*eventType === 'appointment-status'[\s\S]*invalidateTrackingAnalyticsCache\(\)[\s\S]*canRunBackgroundJob/)
})

test('Productos pagina en servidor y carga sus precios en un solo lote', async () => {
  const [backend, page] = await Promise.all([
    repoFile('backend/src/services/localProductService.js'),
    repoFile('frontend/src/pages/Transactions/PaymentProducts.tsx')
  ])

  const listSource = backend.match(/export async function listLocalProducts[\s\S]*?\n}\n\nasync function markLocalProductSyncError/)?.[0] || ''
  assert.match(listSource, /SELECT COUNT\(\*\) AS total FROM products/)
  assert.match(listSource, /FROM product_prices[\s\S]*product_id IN/)
  assert.doesNotMatch(listSource, /for \(const row of rows\)[\s\S]*await listLocalPrices/)
  assert.match(page, /serverSidePagination=\{true\}/)
  assert.match(page, /serverSideSearch=\{true\}/)
  assert.match(page, /limit: PRODUCTS_PAGE_SIZE/)
})
