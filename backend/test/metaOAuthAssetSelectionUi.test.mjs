import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const readSource = relativePath => readFile(join(repoRoot, relativePath), 'utf8')

test('Cuenta Meta usa dropdowns buscables con guardado inmediato y copy para usuario final', async () => {
  const [screen, select] = await Promise.all([
    readSource('frontend/src/pages/Settings/MetaAdsIntegration.tsx'),
    readSource('frontend/src/components/common/CustomSelect/CustomSelect.tsx')
  ])

  assert.match(screen, /Buscar cuenta publicitaria…/)
  assert.match(screen, /Buscar Dataset…/)
  assert.match(screen, /Buscar Facebook Page…/)
  assert.match(screen, /Buscar cuenta de Instagram…/)
  assert.match(screen, /onChange=\{\(event\) => void saveMetaOAuthAssetSelection/)
  assert.match(screen, /Cada cambio se guarda automáticamente/)
  assert.match(screen, /selectedContent=\{renderOAuthSelectValue/)
  assert.match(select, /selectedContent\?: React\.ReactNode/)
  const autosaveStart = screen.indexOf('const saveMetaOAuthAssetSelection')
  const callbackStart = screen.indexOf('const completeMetaOAuthHandoff', autosaveStart)
  assert.ok(autosaveStart >= 0 && callbackStart > autosaveStart)
  assert.doesNotMatch(
    screen.slice(autosaveStart, callbackStart),
    /invalidateIntegrationsStatus\(\)/,
    'finalize ya refresca el snapshot global; no debe duplicar esa petición'
  )
  assert.doesNotMatch(screen, /Cambiar activos en Ristak/)
  assert.doesNotMatch(screen, /Método de conexión/)
  assert.doesNotMatch(screen, /Credencial de Messenger/)
  assert.doesNotMatch(screen, /Incluida en OAuth/)
  assert.doesNotMatch(screen, /Desconectar Meta OAuth|Desconectar OAuth/)
  assert.match(screen, /const usingOAuthSocial = metaOAuthStatus\?\.oauth\.connected === true/)
  assert.match(screen, /activeMetaTab !== 'social' \|\| isLoading \|\| usingOAuthSocial/)
  assert.doesNotMatch(screen, /void loadMetaDeveloperSetup\(\)\s*\n\s*\}, \[\]\)/)
})

test('finalize conserva los vacíos explícitos y separa selección local de cambios sociales', async () => {
  const [controller, service] = await Promise.all([
    readSource('backend/src/controllers/metaOAuthController.js'),
    readSource('backend/src/services/metaOAuthService.js')
  ])

  assert.match(controller, /adAccountId: req\.body\?\.adAccountId \?\? req\.body\?\.ad_account_id/)
  assert.match(controller, /pageId: req\.body\?\.pageId \?\? req\.body\?\.page_id/)
  assert.match(service, /const sameOAuthConnection = [\s\S]*?updateExistingMetaOAuthSelection/)
  assert.match(service, /const socialChanged = pageChanged \|\| instagramChanged/)
  assert.match(service, /syncCrons: socialChanged/)
  assert.match(service, /syncAds: adChanged/)
})
