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

test('la búsqueda de Chat pinta la primera página y pagina al hacer scroll', async () => {
  const source = await repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx')
  const searchBranch = source.match(/} else if \(hasSearch\) \{[\s\S]*?} else if \(silent\) \{/)?.[0] || ''

  assert.match(searchBranch, /const pageChats = await fetchChatPage\(0\)/)
  assert.doesNotMatch(searchBranch, /while \(/)
  assert.match(searchBranch, /chatListHasMoreRef\.current = pageChats\.length >= CHAT_LIST_PAGE_SIZE/)
  assert.doesNotMatch(source, /if \(hasSearch\) return/)
})

test('el asistente pesado no forma parte estática del AppShell', async () => {
  const source = await repoFile('frontend/src/components/layout/AppShell/AppShell.tsx')

  assert.doesNotMatch(source, /import \{ AIAgentPanel \} from '@\/components\/ai'/)
  assert.match(source, /React\.lazy\(\(\) => import\('@\/components\/ai\/AIAgentPanel\/AIAgentPanel'\)/)
  assert.match(source, /<React\.Suspense fallback=\{null\}>[\s\S]*<AIAgentPanel/)
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
