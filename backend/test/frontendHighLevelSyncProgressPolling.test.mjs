import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const repoFile = path => readFile(join(repoRoot, path), 'utf8')
const requireFromFrontend = createRequire(join(repoRoot, 'frontend/package.json'))

async function importPollingPolicy() {
  const source = await repoFile('frontend/src/utils/highLevelSyncProgress.ts')
  const typescript = requireFromFrontend('typescript')
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
      target: typescript.ScriptTarget.ES2020
    },
    fileName: 'highLevelSyncProgress.ts'
  }).outputText
  const encoded = Buffer.from(transpiled, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

test('el polling de progreso exige simultáneamente feature, permiso y conexión', async () => {
  const { isHighLevelSyncProgressPollingAllowed } = await importPollingPolicy()

  for (const hasFeature of [false, true]) {
    for (const hasPermission of [false, true]) {
      for (const connected of [false, true]) {
        assert.equal(
          isHighLevelSyncProgressPollingAllowed({ hasFeature, hasPermission, connected }),
          hasFeature && hasPermission && connected,
          `feature=${hasFeature}, permission=${hasPermission}, connected=${connected}`
        )
      }
    }
  }
})

test('AppShell conserva el evento manual y sólo sondea bajo el contrato autorizado', async () => {
  const [appShell, highLevelRoutes] = await Promise.all([
    repoFile('frontend/src/components/layout/AppShell/AppShell.tsx'),
    repoFile('backend/src/routes/highlevel.routes.js')
  ])

  assert.match(appShell, /hasLicenseFeature\(user, \['highlevel_integration'\]\)/)
  assert.match(appShell, /hasModuleAccess\(user, 'settings_integrations', 'read'\)/)
  assert.match(appShell, /useIntegrationsStatus\(\{ enabled: canAccessHighLevelSyncProgress \}\)/)
  assert.match(appShell, /connected: Boolean\(integrationsStatus\?\.highlevel\?\.connected\)/)
  assert.match(appShell, /if \(!highLevelSyncProgressPollingAllowed\) return undefined/)
  assert.match(appShell, /if \(cancelled \|\| pollingDisabled \|\| activeController\) return/)
  assert.match(appShell, /response\.status === 401 \|\| response\.status === 403 \|\| response\.status === 404/)
  assert.match(appShell, /response\.status === 401[\s\S]{0,180}stopPolling\(\)/)
  assert.match(appShell, /if \(!response\.ok\) return/)
  assert.match(appShell, /activeController\?\.abort\(\)/)
  assert.match(appShell, /wasAllowed && !highLevelSyncProgressPollingAllowed[\s\S]{0,100}setSyncProgressVisible\(false\)/)
  assert.match(appShell, /window\.addEventListener\(HIGHLEVEL_SYNC_STARTED_EVENT, handleSyncStarted\)/)
  assert.match(appShell, /\}, \[highLevelSyncProgressPollingAllowed\]\)/)

  assert.match(
    highLevelRoutes,
    /router\.get\('\/sync\/progress', requireModuleAccess\('settings_integrations'\), getSyncProgressEndpoint\)/,
    'el frontend no debe sustituir ni relajar la autorización del backend'
  )
})
