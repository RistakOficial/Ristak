import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const readSource = relativePath => readFile(join(repoRoot, relativePath), 'utf8')

test('Meta Business es la entrada oficial unificada y conserva compatibilidad con OAuth separado', async () => {
  const [screen, styles, select, oauthService] = await Promise.all([
    readSource('frontend/src/pages/Settings/MetaAdsIntegration.tsx'),
    readSource('frontend/src/pages/Settings/MetaAdsIntegration.module.css'),
    readSource('frontend/src/components/common/CustomSelect/CustomSelect.tsx'),
    readSource('frontend/src/services/metaOAuthService.ts')
  ])

  assert.match(screen, /Buscar cuenta publicitaria…/)
  assert.match(screen, /Buscar Dataset o pixel…/)
  assert.match(screen, /Buscar página…/)
  assert.match(screen, /Buscar cuenta de Instagram…/)
  assert.match(screen, /label: 'Meta Ads'/)
  assert.match(screen, /Facebook y Messenger/)
  assert.match(screen, /<span className=\{styles\.connectedListLabel\}>Cuenta publicitaria<\/span>/)
  assert.match(screen, /<span className=\{styles\.formLabel\}>Página \(Opcional\)<\/span>/)
  assert.match(screen, /isMetaConfigured && <SegmentTabs/)
  assert.match(screen, /!isLoading && !isMetaConfigured && !isMetaOnboarding/)
  assert.match(screen, /isMetaOnboarding && metaOAuthSession/)
  assert.match(screen, /metaConnectEmptyState/)
  assert.match(screen, /Termina de configurar Meta/)
  assert.match(screen, /Guardar configuración/)
  assert.match(screen, /Página \(Opcional\)/)
  assert.match(screen, /Facebook e Instagram \(Opcional\)/)
  assert.match(screen, /onChange=\{\(event\) => updateMetaOAuthAssetDraft/)
  assert.match(screen, /onChange=\{\(event\) => updateMetaOAuthOnboardingAssetDraft/)
  assert.match(screen, /saveMetaOnboarding\(\)/)
  assert.match(screen, /socialChannels: channels/)
  assert.match(screen, /saveMetaOAuthAssetSection\('ads'\)/)
  assert.match(screen, /saveMetaOAuthAssetSection\('social'\)/)
  assert.match(screen, /const sectionPatch = section === 'ads'/)
  assert.match(screen, /metaOAuthService\.completeIntegration\(integrationKind/)
  assert.match(screen, /metaOAuthService\.reconfigureIntegration\(metaOAuthSessionKind\)/)
  assert.match(screen, /metaOAuthService\.finalizeIntegration\(metaOAuthSessionKind, commitSelection\)/)
  assert.match(screen, /startMetaAuthorization\('legacy'\)/)
  assert.match(screen, /Conecta Meta Business/)
  assert.match(screen, /Conectar Meta Business/)
  assert.match(screen, /anuncios, páginas, Messenger e Instagram/)
  assert.match(screen, /isSocialReviewPending/)
  assert.match(screen, /Pendiente de aprobación/)
  assert.match(screen, /startMetaAuthorization\('social'\)/)
  assert.match(oauthService, /`\/api\/meta\/oauth\/\$\{integrationKind\}\/connect-url`/)
  assert.match(oauthService, /`\/api\/meta\/oauth\/\$\{integrationKind\}\/complete`/)
  assert.match(oauthService, /`\/api\/meta\/oauth\/\$\{integrationKind\}\/reconfigure`/)
  assert.match(oauthService, /`\/api\/meta\/oauth\/\$\{integrationKind\}\/finalize`/)
  assert.match(screen, /isLegacyOAuthConnection[\s\S]*?hasSplitAdsConnection[\s\S]*?hasSplitSocialConnection/)
  assert.match(screen, /const isSocialOAuthConnection = isLegacyOAuthConnection[\s\S]*?hasSplitSocialConnection/)
  assert.doesNotMatch(screen, /const isSocialOAuthConnection = isOAuthConnection/)
  assert.match(screen, /const \[savedMetaOAuthSelection, setSavedMetaOAuthSelection\]/)
  assert.match(screen, /const \[metaOnboardingChannels, setMetaOnboardingChannels\]/)
  assert.match(screen, /const availableOAuthDatasets = selectedOAuthAdAccount\?\.pixels \|\| \[\]/)
  assert.match(screen, /\{availableOAuthDatasets\.map\(dataset => \(/)
  assert.doesNotMatch(screen, /\{metaOAuthSession\.datasets\.map\(dataset => \(/)
  assert.match(screen, /selectedContent=\{renderOAuthSelectValue/)
  assert.match(screen, /const snapshot = splitMetaOAuthStatuses\[kind\]\?\.assetSnapshot/)
  assert.match(screen, /if \(snapshot\) applyMetaOAuthSession\(snapshot, kind\)/)
  assert.match(screen, /localStatus\.oauth\.connected && !localStatus\.assetSnapshot/)
  assert.match(screen, /metaOAuthService\.refreshStatus\(\)/)
  assert.match(screen, /splitMetaOAuthStatuses\.ads\?\.selectedAssets\?\.adAccount/)
  assert.match(screen, /splitMetaOAuthStatuses\.ads\?\.selectedAssets\?\.dataset/)
  assert.match(screen, /Dataset o pixel \(Opcional\)/)
  assert.doesNotMatch(screen, /Dataset de conversiones/)
  assert.doesNotMatch(screen, /\(ID: \{asset\.id\}\)/)
  assert.doesNotMatch(screen, /`\$\{asset\.name\} \(\$\{asset\.id\}\)`/)
  assert.doesNotMatch(screen, /\{account\.name\} \(\{account\.id/)
  assert.doesNotMatch(screen, /\{pixel\.name\} \(\{pixel\.id\}\)/)
  assert.doesNotMatch(screen, /\{page\.name\} \(\{page\.id\}\)/)
  assert.doesNotMatch(screen, /\} \(\{account\.sourceId\}\)/)
  assert.match(screen, /const getMetaAssetDisplayName =/)
  assert.match(screen, /normalizedName !== normalizedId \? cleanName : fallback/)
  assert.doesNotMatch(styles, /\.connectedAssetId/)
  assert.match(select, /selectedContent\?: React\.ReactNode/)
  const draftStart = screen.indexOf('const updateMetaOAuthAssetDraft')
  const onboardingDraftStart = screen.indexOf('const updateMetaOAuthOnboardingAssetDraft', draftStart)
  const saveStart = screen.indexOf('const saveMetaOAuthAssetSection')
  const callbackStart = screen.indexOf('const completeMetaOAuthHandoff', saveStart)
  assert.ok(draftStart >= 0 && onboardingDraftStart > draftStart && saveStart > onboardingDraftStart && callbackStart > saveStart)
  assert.doesNotMatch(
    screen.slice(draftStart, onboardingDraftStart),
    /fetch\(|metaOAuthService\.|campaignsService\./,
    'mover un dropdown sólo debe cambiar el borrador local; nunca debe llamar a Meta ni al backend'
  )
  assert.doesNotMatch(
    screen.slice(saveStart, callbackStart),
    /invalidateIntegrationsStatus\(\)/,
    'finalize ya refresca el snapshot global; no debe duplicar esa petición'
  )
  assert.doesNotMatch(screen, /saveMetaOAuthAssetSelection/)
  assert.doesNotMatch(screen, /Cada cambio se guarda automáticamente|Guardado automático/)
  assert.doesNotMatch(screen, /<span>No configurado<\/span>/)
  assert.doesNotMatch(screen, /Cambiar activos en Ristak/)
  assert.doesNotMatch(screen, /Método de conexión/)
  assert.doesNotMatch(screen, /Credencial de Messenger/)
  assert.doesNotMatch(screen, /Incluida en OAuth/)
  assert.doesNotMatch(screen, /Desconectar Meta OAuth|Desconectar OAuth/)
  assert.doesNotMatch(screen, /Autorizar nuevos activos/)
  assert.match(styles, /\.metaHeader\[data-ristak-page-header\][\s\S]*?border-bottom: 0/)
  assert.match(screen, /const isMetaConfigured = isOAuthConnection/)
  assert.match(screen, /aplicación oficial de Ristak aprobada por Meta/)
  assert.match(screen, /todavía faltan los accesos de mensajes, comentarios y webhooks/)
  assert.doesNotMatch(screen, /const isManualWizardRoute/)
  const renderedScreen = screen.slice(screen.indexOf('\n  return ('))
  assert.doesNotMatch(renderedScreen, /User Token de Messenger/)
  assert.doesNotMatch(renderedScreen, /Webhooks en Meta Developers/)
  assert.doesNotMatch(renderedScreen, /Configuración manual de Meta/)
  assert.doesNotMatch(renderedScreen, /onClick=\{handleEditMetaConfig\}/)
  assert.doesNotMatch(screen, /void loadMetaDeveloperSetup\(\)\s*\n\s*\}, \[\]\)/)
  assert.doesNotMatch(screen, /campaignsService\.verifyToken\(\)/)
})

test('finalize conserva los vacíos explícitos y separa selección local de cambios sociales', async () => {
  const [controller, service] = await Promise.all([
    readSource('backend/src/controllers/metaOAuthController.js'),
    readSource('backend/src/services/metaOAuthService.js')
  ])

  assert.match(controller, /adAccountId: req\.body\?\.adAccountId \?\? req\.body\?\.ad_account_id/)
  assert.match(controller, /pageId: req\.body\?\.pageId \?\? req\.body\?\.page_id/)
  assert.match(controller, /socialChannels: req\.body\?\.socialChannels \?\? req\.body\?\.social_channels/)
  assert.match(service, /return prepareMetaOAuthConnection\(options\)/)
  assert.doesNotMatch(service, /META_OAUTH_REQUIRED_ASSETS_MISSING/)
  assert.match(service, /saveMetaOAuthSocialChannels\(selectedSocialChannels\)/)
  assert.match(service, /const sameOAuthConnection = [\s\S]*?updateExistingMetaOAuthSelection/)
  assert.match(service, /const socialChanged = pageChanged \|\| instagramChanged/)
  assert.match(service, /syncCrons: socialChanged/)
  assert.match(service, /syncAds: adChanged/)
})

test('CustomSelect publica la búsqueda remota y la limpia por una sola ruta al cerrar', async () => {
  const select = await readSource('frontend/src/components/common/CustomSelect/CustomSelect.tsx')

  assert.match(select, /onSearchChange\?: \(value: string\) => void/)
  assert.match(
    select,
    /const updateSearchQuery = useCallback\(\(nextQuery: string\) => \{[\s\S]*?setSearchQuery\(nextQuery\)[\s\S]*?onSearchChange\?\.\(nextQuery\)/
  )
  assert.match(
    select,
    /const closeDropdown = useCallback\(\(\) => \{[\s\S]*?setIsOpen\(false\)[\s\S]*?updateSearchQuery\(''\)/
  )
  assert.match(select, /onChange=\{\(event\) => updateSearchQuery\(event\.target\.value\)\}/)
  assert.match(select, /if \(event\.key === 'Escape'\) \{[\s\S]{0,120}?closeDropdown\(\)/)
  assert.match(select, /if \(isOpen\) \{[\s\S]{0,120}?closeDropdown\(\)/)
  assert.equal(select.match(/\bcloseDropdown\(\)/g)?.length, 4)
  assert.equal(select.match(/\bsetSearchQuery\(/g)?.length, 1)
})
