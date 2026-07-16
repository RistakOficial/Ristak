import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readBackendSource = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('los webhooks de chat no esperan la red de APNs, FCM o Installer', async () => {
  const source = await readBackendSource('services/whatsappApiService.js')
  const workerSource = await readBackendSource('jobs/metaDirectChatDelivery.cron.js')
  const serverSource = await readBackendSource('server.js')
  const registrySource = await readBackendSource('jobs/integrationCronRegistry.js')

  assert.doesNotMatch(source, /await\s+sendChatMessageNotification\s*\(/)
  assert.equal(
    (source.match(/void\s+sendChatMessageNotification\s*\(/g) || []).length,
    2,
    'QR y YCloud conservan despacho fuera de ruta; Meta Direct usa outbox durable'
  )

  const qrScope = source.slice(
    source.indexOf('export async function captureQrChatMessage'),
    source.indexOf('function directionFromCandidatePath')
  )
  const ycloudScope = source.slice(
    source.indexOf('export async function processYCloudWhatsAppWebhook'),
    source.indexOf('export async function processMetaDirectWebhookRelay')
  )
  const metaScope = source.slice(
    source.indexOf('export async function processMetaDirectWebhookRelay'),
    source.indexOf('async function sendTextViaMetaDirect')
  )
  for (const [name, scope] of [['QR', qrScope], ['YCloud', ycloudScope]]) {
    assert.ok(scope.indexOf('void sendChatMessageNotification(') >= 0, `${name} debe iniciar push`)
    assert.ok(
      scope.indexOf('void sendChatMessageNotification(') < scope.indexOf('handleInboundForConfirmation('),
      `${name} debe iniciar push antes de citas y motores secundarios`
    )
  }
  assert.doesNotMatch(metaScope, /sendChatMessageNotification\s*\(/)
  assert.match(source, /jobKind:\s*CHAT_DELIVERY_JOB_KIND\.PUSH/)
  assert.match(workerSource, /await\s+runPushJob\(job\)/)
  assert.match(workerSource, /startChatPushDeliveryCron[\s\S]*CHAT_DELIVERY_JOB_KIND\.PUSH/)
  assert.match(workerSource, /startMetaDirectChatDeliveryCron[\s\S]*CHAT_DELIVERY_JOB_KIND\.META_ENRICHMENT/)
  const laneScope = workerSource.slice(
    workerSource.indexOf('async function runDeliveryLane'),
    workerSource.indexOf('function requestDeliveryLaneDrain')
  )
  assert.match(workerSource, /async function cleanupChatDeliveryOutboxIfDue[\s\S]*cleanupCompletedChatDeliveryJobs\(\)/)
  assert.match(workerSource, /DELIVERY_CLEANUP_INTERVAL_MS\s*=\s*60\s*\*\s*60_000/)
  assert.match(laneScope, /withCronLock\([\s\S]*cleanupChatDeliveryOutboxIfDue\(\)[\s\S]*return result/)
  assert.match(serverSource, /startChatPushDeliveryCron\(\)/)
  const shutdownScope = serverSource.slice(
    serverSource.indexOf('function handleShutdown'),
    serverSource.indexOf("process.on('SIGTERM'")
  )
  assert.match(shutdownScope, /stopChatPushDeliveryCron\(\)/)
  assert.match(shutdownScope, /stopIntegrationCrons\(\)/)
  assert.match(registrySource, /startMetaDirectChatDeliveryCron/)
  assert.doesNotMatch(registrySource, /Meta directo: push y media/)
})

test('cada llamada remota del proveedor push tiene deadline y los destinatarios se filtran en SQL', async () => {
  const source = await readBackendSource('services/pushNotificationsService.js')

  assert.match(source, /DEFAULT_NATIVE_PUSH_PROVIDER_TIMEOUT_MS\s*=\s*8_000/)
  assert.match(source, /fetchPushProviderJson\('https:\/\/oauth2\.googleapis\.com\/token'/)
  assert.match(source, /fetchPushProviderJson\(\s*`https:\/\/fcm\.googleapis\.com/)
  assert.match(source, /APNs excedió \$\{nativePushProviderTimeoutMs\} ms/)
  assert.match(source, /'apns-collapse-id':\s*getNotificationCollapseId\(payload\)/)
  assert.match(source, /webPush\.sendNotification[\s\S]*timeout:\s*nativePushProviderTimeoutMs/)
  assert.match(source, /WHERE enabled = 1\s+\$\{normalizedUserIds \? `AND user_id IN/)
})

test('Meta Direct persiste inbound antes de enriquecer media y acota ambas descargas', async () => {
  const source = await readBackendSource('services/whatsappApiService.js')

  assert.match(source, /META_DIRECT_GRAPH_TIMEOUT_MS\s*=\s*20_000/)
  assert.match(source, /META_DIRECT_INBOUND_MEDIA_TIMEOUT_MS\s*=\s*8_000/)
  assert.match(source, /signal:\s*controller\.signal/)
  assert.match(source, /onInboundPersisted\(buildResult\(\)\)/)
  assert.match(source, /throwOnError:\s*true/)
  assert.match(source, /jobKind:\s*CHAT_DELIVERY_JOB_KIND\.META_ENRICHMENT/)
  assert.match(source, /WHERE id = \? AND COALESCE\(media_url, ''\) = ''/)
})
