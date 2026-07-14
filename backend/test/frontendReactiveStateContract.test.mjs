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

  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart)
  assert.ok(
    deleteSource.indexOf('mutateOverview') < deleteSource.indexOf('await apiClient.delete'),
    'la fila debe desaparecer antes de esperar otra descarga'
  )
  assert.match(deleteSource, /catch \(error\)[\s\S]*?deletedAutomationIds\.delete[\s\S]*?automations\.splice/)
  assert.match(service, /startingRevision === overviewRevision/)
  assert.match(service, /overviewListeners\.forEach\(listener => listener/)
  assert.match(library, /subscribeAutomationsOverview\([\s\S]*?setFolders[\s\S]*?setAutomations/)
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
