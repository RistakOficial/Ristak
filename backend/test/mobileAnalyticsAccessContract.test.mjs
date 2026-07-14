import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const repoFile = (path) => readFile(join(repoRoot, path), 'utf8')

test('Android y /movil protegen Analiticas con el contrato Dashboard', async () => {
  const [nativeAccess, frontendApp, phoneChat, dashboardRoutes, server] = await Promise.all([
    repoFile('mobile/src/access.ts'),
    repoFile('frontend/src/App.tsx'),
    repoFile('frontend/src/pages/PhoneChat/PhoneChat.tsx'),
    repoFile('backend/src/routes/dashboard.routes.js'),
    repoFile('backend/src/server.js')
  ])

  assert.match(nativeAccess, /analytics:\s*'dashboard'/)
  assert.match(
    frontendApp,
    /path=\{`\$\{PHONE_APP_PREFIX\}\/analytics`\}[\s\S]*?<AccessRoute moduleKey="dashboard">[\s\S]*?<LazyPhoneAnalytics \/>/
  )
  assert.match(phoneChat, /hasMobileAnalyticsAccess\s*=\s*hasModuleAccess\(user, 'dashboard', 'read'\)/)
  assert.match(phoneChat, /section === 'analytics' && !hasMobileAnalyticsAccess/)
  assert.match(dashboardRoutes, /router\.use\(requireModuleAccess\('dashboard'\)\)/)
  assert.match(server, /app\.use\('\/api\/dashboard', requireAuth, requireFeature\('dashboard'\), dashboardRoutes\)/)
})
