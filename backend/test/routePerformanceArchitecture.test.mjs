import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('las rutas principales se descargan por modulo y no inflan el bundle inicial', async () => {
  const [app, routeModules, sitesRoute] = await Promise.all([
    repoFile('frontend/src/App.tsx'),
    repoFile('frontend/src/routing/routeModules.tsx'),
    repoFile('frontend/src/pages/Sites/SitesRoute.tsx')
  ])

  assert.match(app, /from '@\/routing\/routeModules'/)
  assert.doesNotMatch(app, /from '@\/pages\//)
  assert.match(app, /<RouteModuleSuspense>[\s\S]*?<Routes>/)

  assert.match(routeModules, /const LazyComponent = lazy\(preload\)/)
  assert.match(routeModules, /module\[exportName\] \?\? module\.default/)
  assert.match(routeModules, /<LazyLoadErrorBoundary>/)
  const errorBoundary = await repoFile('frontend/src/components/common/LazyLoadErrorBoundary/LazyLoadErrorBoundary.tsx')
  assert.match(errorBoundary, /window\.location\.reload\(\)/)
  assert.match(routeModules, /export const prefetchRouteModule/)
  assert.match(routeModules, /import\('@\/pages\/Dashboard\/Dashboard'\)/)
  assert.match(routeModules, /import\('@\/pages\/DesktopChat\/DesktopChat'\)/)
  assert.match(routeModules, /import\('@\/pages\/Analytics\/Analytics'\)/)
  assert.match(routeModules, /createLazyRoute\(\(\) => import\('@\/pages\/Analytics\/Analytics'\), 'default'\)/)
  assert.match(routeModules, /import\('@\/pages\/Sites\/SitesRoute'\)/)
  const sitesLoader = routeModules.slice(
    routeModules.indexOf('const sites = createLazyRoute'),
    routeModules.indexOf('const automations = createLazyRoute')
  )
  assert.doesNotMatch(sitesLoader, /prefetchSitesWorkspace|\.then\s*\(/)
  assert.match(sitesRoute, /export function prefetchSitesWorkspace/)
  assert.match(sitesRoute, /sitesWorkspacePromise = import\('\.\/Sites'\)/)
  assert.match(sitesRoute, /React\.Suspense/)
  assert.match(routeModules, /import\('@\/pages\/PhoneChat\/PhoneChat'\)/)
  assert.match(routeModules, /import\('@\/pages\/PublicPayment\/PublicPayment'\)/)
  assert.doesNotMatch(routeModules, /import\('@\/pages\/(?:Dashboard|DesktopChat|Analytics|Sites|PhoneChat)'\)/)
})

test('el AppShell permanece montado y ya no bloquea la vista por cada request', async () => {
  const [appShell, appShellStyles] = await Promise.all([
    repoFile('frontend/src/components/layout/AppShell/AppShell.tsx'),
    repoFile('frontend/src/components/layout/AppShell/AppShell.module.css')
  ])

  assert.doesNotMatch(appShell, /useRouteDataLoadGate|routeDataLoadGate/)
  assert.match(appShell, /<React\.Suspense[\s\S]*?<Outlet \/>[\s\S]*?<\/React\.Suspense>/)
  assert.doesNotMatch(appShellStyles, /routeContentLoading|routeDataLoader/)
  assert.doesNotMatch(appShellStyles, /backdrop-filter:\s*blur\(6px\)/)
})

test('el sidebar precarga chunks cuando el usuario expresa intencion de navegar', async () => {
  const sidebar = await repoFile('frontend/src/components/layout/Sidebar/Sidebar.tsx')

  assert.match(sidebar, /import \{ prefetchRouteModule \} from '@\/routing\/routeModules'/)
  assert.match(sidebar, /ROUTE_PREFETCH_POINTER_DWELL_MS = 150/)
  assert.match(sidebar, /onPointerEnter:\s*\(\) => scheduleSidebarRoutePrefetch\(destination\)/)
  assert.match(sidebar, /onPointerLeave:\s*\(\) => cancelSidebarRoutePrefetch\(destination\)/)
  assert.match(sidebar, /onPointerDown:\s*\(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /onFocus:\s*\(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /onTouchStart:\s*\(\) => prefetchSidebarRoute\(destination\)/)
  assert.match(sidebar, /\.\.\.routePrefetchIntentProps\(item\.href\)/)
  assert.match(sidebar, /\.\.\.routePrefetchIntentProps\(child\.to\)/)
})

test('cada panel de Configuracion queda aislado en su propio chunk', async () => {
  const settings = await repoFile('frontend/src/pages/Settings/Settings.tsx')

  assert.doesNotMatch(settings, /import \{ (?:HighLevelIntegration|Costs|PaymentsConfiguration|AccountSettings) \} from '\.\//)
  assert.match(settings, /React\.lazy\(preload\)/)
  assert.match(settings, /module\[exportName\] \?\? module\.default/)
  assert.match(settings, /import\('\.\/HighLevelIntegration'\)/)
  assert.match(settings, /import\('\.\/PaymentsConfiguration'\)/)
  assert.match(settings, /import\('\.\/AccountSettings'\)/)
  assert.match(settings, /<React\.Suspense[\s\S]*?<Routes>[\s\S]*?<\/React\.Suspense>/)
})
