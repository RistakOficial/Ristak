import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')
const requireFromFrontend = createRequire(join(repoRoot, 'frontend/package.json'))
const repoFile = path => readFile(join(repoRoot, path), 'utf8')

async function importTypeScriptSource(source, fileName) {
  const typescript = requireFromFrontend('typescript')
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2020,
      target: typescript.ScriptTarget.ES2020
    },
    fileName
  }).outputText
  const encoded = Buffer.from(transpiled, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

function createMemoryStorage(initialValues = new Map()) {
  const values = new Map(initialValues)

  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  }
}

const recoverySource = await repoFile('frontend/src/utils/routeLoadRecovery.ts')
const recovery = await importTypeScriptSource(recoverySource, 'routeLoadRecovery.ts')

test('reconoce fallos de chunks sin confundir errores normales de la página', () => {
  const recoverableErrors = [
    new TypeError('Failed to fetch dynamically imported module: https://app.test/assets/Contacts-old.js'),
    new TypeError('Importing a module script failed.'),
    new Error('error loading dynamically imported module'),
    new Error('Expected a JavaScript-or-Wasm module script'),
    new Error('Failed to load module script: the server responded with text/html'),
    new Error('Unable to preload CSS for /assets/Contacts-old.css'),
    Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' }),
    new TypeError('Load failed')
  ]

  recoverableErrors.forEach((error) => {
    assert.equal(recovery.isDynamicImportFailure(error), true, error.message)
  })

  const applicationErrors = [
    new Error('No se pudieron obtener los contactos'),
    new TypeError('Cannot read properties of undefined'),
    new Error('Load failed while calculating the report'),
    { name: 'TypeError', message: 'Failed to fetch /api/contacts' }
  ]

  applicationErrors.forEach((error) => {
    assert.equal(recovery.isDynamicImportFailure(error), false, String(error.message))
  })
})

test('cada módulo y build reserva una sola recarga automática durante el cooldown', () => {
  const storage = createMemoryStorage()
  const firstClaim = recovery.claimRouteLoadRecovery({
    storage,
    recoveryKey: 'route:contacts',
    buildFingerprint: '/assets/index-build-a.js',
    now: 1_000
  })

  assert.ok(firstClaim)
  assert.equal(
    recovery.claimRouteLoadRecovery({
      storage,
      recoveryKey: 'route:contacts',
      buildFingerprint: '/assets/index-build-a.js',
      now: 1_100
    }),
    null
  )

  const futureBuildClaim = recovery.claimRouteLoadRecovery({
    storage,
    recoveryKey: 'route:contacts',
    buildFingerprint: '/assets/index-build-b.js',
    now: 1_200
  })

  assert.ok(futureBuildClaim)
  assert.notEqual(futureBuildClaim.token, firstClaim.token)
  assert.equal(
    recovery.claimRouteLoadRecovery({
      storage,
      recoveryKey: 'route:contacts',
      buildFingerprint: '/assets/index-build-a.js',
      now: 1_300
    }),
    null
  )
})

test('cancelar una recuperación antes del reload libera exactamente su reserva', () => {
  const storage = createMemoryStorage()
  const firstClaim = recovery.claimRouteLoadRecovery({
    storage,
    recoveryKey: 'settings:/settings/payments',
    buildFingerprint: '/assets/index-build-a.js',
    now: 2_000
  })

  assert.ok(firstClaim)
  recovery.releaseRouteLoadRecovery(storage, firstClaim)

  const replacementClaim = recovery.claimRouteLoadRecovery({
    storage,
    recoveryKey: 'settings:/settings/payments',
    buildFingerprint: '/assets/index-build-a.js',
    now: 2_001
  })

  assert.ok(replacementClaim)
})

test('si sessionStorage no está disponible, falla en seguro sin autorizar reload', () => {
  const blockedStorage = {
    getItem() {
      throw new Error('storage blocked')
    },
    setItem() {
      throw new Error('storage blocked')
    },
    removeItem() {
      throw new Error('storage blocked')
    }
  }

  assert.equal(
    recovery.claimRouteLoadRecovery({
      storage: blockedStorage,
      recoveryKey: 'route:reports',
      buildFingerprint: '/assets/index-build-a.js',
      now: 3_000
    }),
    null
  )
})

test('la recuperación sólo vive en el contenido y nunca en el prefetch especulativo', async () => {
  const [routeModules, sidebar, appShell, settings, automations, boundary] = await Promise.all([
    repoFile('frontend/src/routing/routeModules.tsx'),
    repoFile('frontend/src/components/layout/Sidebar/Sidebar.tsx'),
    repoFile('frontend/src/components/layout/AppShell/AppShell.tsx'),
    repoFile('frontend/src/pages/Settings/Settings.tsx'),
    repoFile('frontend/src/pages/Automations/Automations.tsx'),
    repoFile('frontend/src/components/common/LazyLoadErrorBoundary/LazyLoadErrorBoundary.tsx')
  ])

  assert.match(routeModules, /<LazyLoadErrorBoundary recoveryKey=\{recoveryKey\}>/)
  assert.doesNotMatch(sidebar, /location\.reload|claimRouteLoadRecovery/)

  const layoutPosition = appShell.indexOf('<Layout')
  const sidebarPosition = appShell.indexOf('<Sidebar')
  const routeSuspensePosition = appShell.indexOf('<React.Suspense fallback={<Loading message="Abriendo módulo..."')
  const outletPosition = appShell.indexOf('<Outlet />')
  assert.ok(layoutPosition >= 0)
  assert.ok(sidebarPosition > layoutPosition)
  assert.ok(routeSuspensePosition > sidebarPosition)
  assert.ok(outletPosition > routeSuspensePosition)

  const settingsMenuPosition = settings.indexOf('<aside className={styles.settingsNavPanel}')
  const settingsBoundaryPosition = settings.indexOf('<LazyLoadErrorBoundary')
  assert.ok(settingsMenuPosition >= 0)
  assert.ok(settingsBoundaryPosition > settingsMenuPosition)
  assert.match(settings, /recoveryKey=\{`settings:\$\{location\.pathname\}`\}/)

  assert.doesNotMatch(automations, /class AutomationEditorBoundary/)
  assert.match(automations, /recoveryKey="route:automation-editor"/)
  assert.match(automations, /resetKey=\{automationId\}/)

  assert.match(boundary, /if \(\s*this\.recoveryStarted \|\|\s*import\.meta\.env\.DEV/)
  assert.match(boundary, /!isDynamicImportFailure\(error\)/)
  assert.match(boundary, /this\.cleanupRecovery\(true\)/)
  assert.match(boundary, /window\.removeEventListener\('online'/)
  assert.match(boundary, /<Loading[\s\S]*Actualizando esta página/)
})
