import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const readSource = relativePath => readFile(join(repoRoot, relativePath), 'utf8')

test('integraciones publican un snapshot compartido y descartan respuestas viejas', async () => {
  const [service, hook, initialization, auth] = await Promise.all([
    readSource('frontend/src/services/integrationsService.ts'),
    readSource('frontend/src/hooks/useIntegrationsStatus.ts'),
    readSource('frontend/src/contexts/InitializationContext.tsx'),
    readSource('frontend/src/contexts/AuthContext.tsx')
  ])

  assert.match(service, /const statusListeners = new Set<\(\) => void>\(\)/)
  assert.match(service, /const requestVersion = \+\+statusRequestVersion/)
  assert.match(service, /requestVersion === statusRequestVersion[\s\S]*?writeStatusSnapshot\(data\)/)
  assert.match(service, /refreshIntegrationsStatusAfter<T>[\s\S]*?await refreshIntegrationsStatus\(\)/)
  assert.match(hook, /useSyncExternalStore\([\s\S]*?subscribeIntegrationsStatus[\s\S]*?getIntegrationsStatusSnapshot/)
  assert.match(initialization, /useIntegrationsStatus\(\)/)
  assert.match(auth, /useIntegrationsStatus\(\{ enabled: Boolean\(user\) \}\)/)
  assert.match(auth, /setLocationId\(highLevel\?\.locationData\?\.id \|\| highLevel\?\.locationId \|\| null\)/)
  assert.match(auth, /setAccessToken\(highLevel\?\.accessToken \|\| null\)/)
})

test('mutaciones de proveedores revalidan el estado global', async () => {
  const [ai, whatsapp, meta, calendars, highLevel] = await Promise.all([
    readSource('frontend/src/services/aiAgentService.ts'),
    readSource('frontend/src/services/whatsappApiService.ts'),
    readSource('frontend/src/services/metaOAuthService.ts'),
    readSource('frontend/src/services/calendarsService.ts'),
    readSource('frontend/src/services/highLevelService.ts')
  ])

  assert.match(ai, /saveConfig[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(ai, /deleteToken[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(whatsapp, /connect: [\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(whatsapp, /disconnectPhoneNumber:[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(meta, /finalize:[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(meta, /disconnectPreviousIntegration:[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(calendars, /claimGoogleOAuth[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(calendars, /deleteGoogleIntegration[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(highLevel, /saveConfig[\s\S]*?refreshIntegrationsStatusAfter/)
  assert.match(highLevel, /disconnect[\s\S]*?refreshIntegrationsStatusAfter/)
})

test('la disponibilidad del agente AI no reutiliza snapshots de otra cuenta', async () => {
  const source = await readSource('frontend/src/hooks/useAIAgentAvailability.ts')

  assert.match(source, /getAuthScopedCachePrincipalFingerprint/)
  assert.match(source, /principalFingerprint !== getAuthScopedCachePrincipalFingerprint\(\)/)
  assert.match(source, /AUTH_PRINCIPAL_CHANGED_EVENT/)
  assert.match(source, /currentRequestVersion === requestVersion/)
  assert.match(source, /requestVersion \+= 1/)
})

test('el tema privado espera login y descarta respuestas de una cuenta anterior', async () => {
  const [theme, principalCache] = await Promise.all([
    readSource('frontend/src/contexts/ThemeContext.tsx'),
    readSource('frontend/src/services/authPrincipalCache.ts')
  ])

  assert.match(theme, /localStorage\.getItem\('auth_token'\)/)
  assert.match(theme, /AUTH_PRINCIPAL_CHANGED_EVENT/)
  assert.match(theme, /requestVersion !== syncRequestVersion/)
  assert.match(theme, /response\.status === 401/)
  assert.match(theme, /setThemeDirState\(configuredDir \|\| DEFAULT_THEME_DIR\)/)
  assert.match(theme, /handleAuthPrincipalChanged[\s\S]*?setThemeDirState\(DEFAULT_THEME_DIR\)/)
  assert.match(theme, /handleAuthPrincipalChanged[\s\S]*?if \(authenticated\) void syncThemeConfig\(\)/)
  assert.match(principalCache, /dispatchEvent\(new CustomEvent\(AUTH_PRINCIPAL_CHANGED_EVENT/)
})

test('inicializacion conecta Meta, Google Calendar y OpenAI sin mandar a Configuracion', async () => {
  const [page, context, metaService, calendarsService] = await Promise.all([
    readSource('frontend/src/pages/Initialization/Initialization.tsx'),
    readSource('frontend/src/contexts/InitializationContext.tsx'),
    readSource('frontend/src/services/metaOAuthService.ts'),
    readSource('frontend/src/services/calendarsService.ts')
  ])

  assert.match(context, /\{ id: 'meta', required: true/)
  assert.match(context, /\{ id: 'google-calendar', required: true/)
  assert.match(context, /\{ id: 'openai', required: true/)
  assert.doesNotMatch(context, /facebook-page|meta-app|whatsapp-api/)
  assert.match(page, /metaOAuthService\.createConnectUrl\('\/initialization'\)/)
  assert.match(page, /calendarsService\.getGoogleConnectUrl\('\/initialization'\)/)
  assert.match(page, /conversationalAgentService\.connectAIProvider\('openai', apiKey\)/)
  assert.match(page, /metaOAuthService\.complete\(\{ handoffToken: metaHandoff \}\)/)
  assert.match(page, /calendarsService\.claimGoogleOAuth\(googleHandoff\)/)
  assert.doesNotMatch(page, /<Link|to=['"]\/settings/)
  assert.match(metaService, /createConnectUrl: \(returnPath = '\/settings\/meta-ads\/cuenta'\)/)
  assert.match(calendarsService, /getGoogleConnectUrl\(returnPath = ''\)/)
})

test('libreria de automatizaciones actualiza inmediatamente y revierte si falla', async () => {
  const [service, library] = await Promise.all([
    readSource('frontend/src/services/automationsService.ts'),
    readSource('frontend/src/pages/Automations/AutomationLibrary.tsx')
  ])
  const deleteStart = service.indexOf('async deleteAutomation(automationId: string)')
  const deleteEnd = service.indexOf('async createFolder', deleteStart)
  const deleteSource = service.slice(deleteStart, deleteEnd)
  const subscriptionStart = library.indexOf('useEffect(() => subscribeAutomationsOverview')
  const subscriptionEnd = library.indexOf('\n  useEffect(', subscriptionStart + 20)
  const subscriptionSource = library.slice(subscriptionStart, subscriptionEnd)

  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart)
  assert.ok(
    deleteSource.indexOf('mutateOverview') < deleteSource.indexOf('await apiClient.delete'),
    'la fila debe desaparecer antes de esperar otra descarga'
  )
  assert.match(deleteSource, /catch \(error\)[\s\S]*?deletedAutomationIds\.delete[\s\S]*?automations\.splice/)
  assert.doesNotMatch(service, /startingRevision === overviewRevision/)
  assert.match(service, /function applyOverviewMutationsSince/)
  assert.match(service, /entry\.revision > startingRevision \? entry\.mutation\(current\)/)
  assert.match(service, /function scopeOverviewToQuery/)
  assert.match(service, /if \(options\.folderId === 'root'\) return !automation\.folderId/)
  assert.match(service, /scopeOverviewToQuery\([\s\S]*?applyOverviewMutationsSince/)
  assert.match(service, /overviewListeners\.forEach\(listener => listener\(mutation\)\)/)
  assert.match(service, /publishSnapshot\?: boolean/)
  assert.match(library, /publishSnapshot: true/)
  assert.match(service, /function overviewSnapshotKey/)
  assert.match(service, /request\.queryKey !== overviewSnapshotQueryKey/)
  assert.match(service, /request\.generation !== overviewSnapshotGeneration/)
  assert.match(service, /automationsCache\.overview\.automations\.map/)
  assert.match(service, /pageInfo: overview\.pageInfo/)
  assert.match(library, /setAutomations\(current => \{[\s\S]*?applyMutation/)
  assert.doesNotMatch(subscriptionSource, /setPageInfo/)
  assert.match(service, /cacheAutomation\(automation, true\)/)
  assert.match(library, /subscribeAutomationsOverview\([\s\S]*?setFolders[\s\S]*?setAutomations/)
  assert.match(library, /normalizedQuery[\s\S]*?automation\.folderId === folderId/)
})

test('citas ignoran cargas anteriores y revalidan despues de mutar', async () => {
  const source = await readSource('frontend/src/pages/Appointments/Appointments.tsx')

  assert.match(source, /const eventsRequestRef = useRef\(0\)/)
  assert.match(source, /const upcomingEventsRequestRef = useRef\(0\)/)
  assert.match(source, /const blockedSlotsRequestRef = useRef\(0\)/)
  assert.match(source, /eventsRequestRef\.current !== requestId/)
  assert.match(source, /blockedSlotsRequestRef\.current === requestId/)
  assert.match(source, /await Promise\.all\(\[loadEvents\(\), loadUpcomingEvents\(\)\]\)/)
  assert.match(source, /setEvents\(current => current\.filter\(event => event\.id !== eventId\)\)/)
})

test('Sites no depende de permisos Meta y evita loops al cargar perfiles opcionales', async () => {
  const source = await readSource('frontend/src/pages/Sites/Sites.tsx')

  assert.match(source, /useIntegrationsStatus\(\)/)
  assert.match(source, /status\.meta\?\.connected/)
  assert.match(source, /return metaPixelConnectedRef\.current/)
  assert.doesNotMatch(source, /campaignsService\.getMetaConfig\(\)/)
  assert.match(source, /connectedSocialProfilesRef\.current/)
  assert.match(source, /campaignsService\.refreshConnectedSocialProfiles\(\)/)
  assert.match(source, /if \(!response\.success\) response = await campaignsService\.getConnectedSocialProfiles\(\)/)
  assert.match(source, /loadConnectedSocialProfiles[\s\S]*?\}, \[\]\)/)
  assert.doesNotMatch(source, /catch\(\(\) => \{[\s\S]{0,180}setConnectedSocialProfiles\(\[\]\)/)
})
