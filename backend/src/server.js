import './config/initTimezone.js'
import 'dotenv/config'
import ffmpegStatic from 'ffmpeg-static'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import { fileURLToPath } from 'url'
import { dirname, join, relative, sep } from 'path'
import {
  databaseReady,
  describePostgresConnectionError,
  isTransientPostgresConnectionError,
  runStartupDataMaintenance
} from './config/database.js'
import { logger } from './utils/logger.js'
import { initializeMasterKey } from './utils/encryption.js'
import { initializeDefaultUser } from './utils/auth.js'
import { updateMetaVersion } from './jobs/metaVersionCron.js'
import { startScheduledChatMessagesCron } from './jobs/scheduledChatMessages.cron.js'
import { startContactBulkActionsCron } from './jobs/contactBulkActions.cron.js'
import { startAppointmentRemindersCron } from './jobs/appointmentReminders.cron.js'
import { startPaymentAutomationsCron } from './jobs/paymentAutomations.cron.js'
import { startConversationalAgentSafetyNotificationsCron } from './jobs/conversationalAgentSafetyNotifications.cron.js'
import { startConversationalAgentTestPaymentsCleanup } from './jobs/conversationalAgentTestPaymentsCleanup.js'
import { startConversationalAppointmentTestCleanupCron } from './jobs/conversationalAppointmentTestCleanup.cron.js'
import { startConversationalAgentTestAssignmentsCleanup } from './jobs/conversationalAgentTestAssignmentsCleanup.js'
import { startConversationalAgentPauseExpiryCron } from './jobs/conversationalAgentPauseExpiry.cron.js'
import { startChatPushDeliveryCron, stopChatPushDeliveryCron } from './jobs/metaDirectChatDelivery.cron.js'
import { startAutomationReviewProjectionScheduler } from './jobs/automationReviewProjection.cron.js'
import { startReadModelProjectionMaintenanceScheduler } from './jobs/readModelProjectionMaintenance.cron.js'
import { syncRegisteredIntegrationCrons } from './jobs/integrationCronRegistry.js'
import { stopIntegrationCrons } from './jobs/integrationCronRuntime.js'
import { isMetaConnected, isMetaSocialConnected, isStripeConnected } from './services/integrationConnectionStateService.js'
import { initializeVersion } from './services/metaVersionService.js'
import { verifyAndUpdateWebhooks } from './startup/webhookVerification.js'
import { runVersionedMigrations } from './startup/runMigrations.js'
import { repairPendingPaymentFlows } from './services/paymentFlowService.js'
import { ensureBunnyStreamRuntimeConfigured } from './services/mediaStorageService.js'
import { scheduleStartupStorageTaxonomyMigration } from './services/storageTaxonomyMigration.js'
import { ensureDefaultWhatsAppApiMessageTemplates } from './services/messageTemplatesService.js'
import { ensureDefaultLocalCalendar } from './services/localCalendarService.js'
import { ensureCalendarBookingSystemFormOnce } from './services/sitesService.js'
import { shutdownWhatsAppQrService } from './services/whatsappQrService.js'
import { repairWhatsAppProtocolMessageIdentities } from './services/whatsappApiService.js'
import { startMetaOAuthPendingSessionCleanupScheduler } from './services/metaOAuthService.js'
import { startMetaOAuthIntegrationCleanupScheduler } from './services/metaOAuthIntegrationService.js'
import { scheduleAutomationTriggerIndexBootstrap } from './services/automationTriggerIndexService.js'
import { scheduleTrackingVisitorProjectionBackfill } from './services/trackingVisitorProjectionService.js'
import { scheduleCrmListProjectionBackfill } from './services/crmListProjectionService.js'
import { startWhatsAppStatusProjectionScheduler } from './services/whatsappStatusProjectionService.js'
import { reconcileStripeWebhookConfiguration } from './services/stripePaymentService.js'

// Garantiza un ffmpeg con libopus en CUALQUIER runtime (Render nativo O Docker):
// apunta FFMPEG_PATH al binario estático empaquetado. Toda la transcodificación
// (notas de voz OGG/Opus para WhatsApp, video, previews de audio) lo lee vía
// FFMPEG_PATH. Sin esto, un deploy sin ffmpeg de sistema rompía las notas de voz.
if (!process.env.FFMPEG_PATH && ffmpegStatic) {
  process.env.FFMPEG_PATH = ffmpegStatic
  logger.info(`[audio] ffmpeg estático activo: ${ffmpegStatic}`)
}

// Force redeploy to ensure latest logs are active

// Routes
import highlevelRoutes from './routes/highlevel.routes.js'
import metaRoutes from './routes/meta.routes.js'
import { renderMetaPixelTestPage, runMetaPixelTestServerEvent } from './controllers/metaController.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import webhooksRoutes from './routes/webhooks.routes.js'
import { handleMetaInstallerRelayWebhook } from './controllers/webhooksController.js'
import reportsRoutes from './routes/reports.routes.js'
import webhookConfigRoutes from './routes/webhookConfig.routes.js'
import contactsRoutes from './routes/contacts.routes.js'
import contactTagsRoutes from './routes/contactTags.routes.js'
import transactionsRoutes from './routes/transactions.routes.js'
import integrationsRoutes from './routes/integrations.routes.js'
import attributionRoutes from './routes/attribution.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import calendarsRoutes, { publicCalendarsRoutes } from './routes/calendars.routes.js'
import trackingRoutes, { publicTrackingRoutes } from './routes/tracking.routes.js'
import triggerLinksRoutes from './routes/triggerLinks.routes.js'
import configRoutes from './routes/config.routes.js'
import userConfigRoutes from './routes/userConfig.routes.js' // (MOB-006)
import costsRoutes from './routes/costs.routes.js'
import authRoutes from './routes/auth.routes.js'
import apiAccessRoutes from './routes/apiAccess.routes.js'
import oauthRoutes from './routes/oauth.routes.js'
import hiddenContactsRoutes from './routes/hiddenContacts.routes.js'
import aiAgentRoutes from './routes/aiAgent.routes.js'
import conversationalAgentRoutes from './routes/conversationalAgent.routes.js'
import searchRoutes from './routes/search.routes.js'
import externalRoutes from './routes/external.routes.js'
import mcpRoutes from './routes/mcp.routes.js'
import whatsappApiRoutes from './routes/whatsappApi.routes.js'
import emailRoutes from './routes/email.routes.js'
import productsRoutes from './routes/products.routes.js'
import subscriptionsRoutes from './routes/subscriptions.routes.js'
import stripeRoutes from './routes/stripe.routes.js'
import mercadoPagoRoutes from './routes/mercadopago.routes.js'
import conektaRoutes from './routes/conekta.routes.js'
import clipRoutes from './routes/clip.routes.js'
import rebillRoutes from './routes/rebill.routes.js'
import sitesRoutes from './routes/sites.routes.js'
import mediaRoutes from './routes/media.routes.js'
import internalStorageRoutes from './routes/internalStorage.routes.js'
import automationsRoutes from './routes/automations.routes.js'
import appointmentRemindersRoutes from './routes/appointmentReminders.routes.js'
import pushRoutes from './routes/push.routes.js'
import licenseRoutes from './routes/license.routes.js'
import centralBrokerRoutes from './routes/centralBroker.routes.js'
import mdpProgramRoutes from './routes/mdpProgram.routes.js'
import chatEventsRoutes from './routes/chatEvents.routes.js'
import paymentEventsRoutes from './routes/paymentEvents.routes.js'
import { publicSiteHostMiddleware } from './controllers/sitesController.js'
import { getCentralBrokerHealthInfo, getHealthInfo, requestPortalUserRefresh } from './services/licenseService.js'
import { requireFeature } from './middleware/licenseMiddleware.js'
// (LIC-002) requireAuth se aplica ANTES de requireFeature en los mounts gateados
// para que el tráfico no autenticado reciba 401 sin tocar el license server.
import { requireAuth } from './middleware/authMiddleware.js'
import { recoverPendingConversationalAgentConversations } from './agents/conversational/runner.js'
import {
  recoverPendingConversationGoalCompletionEffects,
  startConversationGoalEffectsRecoveryScheduler
} from './services/conversationalAgentService.js'
import {
  classifyDeployDrainRequest,
  isHealthRequest
} from './utils/deployDrainPolicy.js'
import {
  isRuntimeReadyForTraffic,
  runtimeHealthStatusCode
} from './utils/startupReadiness.js'
import {
  beginDeployDrainWork,
  formatDeployDrainSnapshot,
  getDeployDrainSnapshot,
  markDeployShutdownStarted,
  trackDeployDrainWork
} from './utils/deployDrainTracker.js'
import { PRODUCT_POST_WEBHOOK_SCHEMA } from './contracts/productPostWebhookContract.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001
const startupState = {
  ready: false,
  error: null
}
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 295_000
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS) ||
    DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS
)
let shuttingDown = false
let activeRequests = 0
let activeUploadRequests = 0
let activeDrainAllowedRequests = 0

function getStartupStatus() {
  if (shuttingDown) return 'shutting_down'
  if (startupState.ready) return 'ready'
  if (startupState.error) return 'error'
  return 'starting'
}

function getRuntimeReadiness() {
  const state = {
    ready: startupState.ready,
    error: startupState.error,
    shuttingDown
  }

  return {
    ok: isRuntimeReadyForTraffic(state),
    statusCode: runtimeHealthStatusCode(state)
  }
}

function runStartupDrainTask(kind, task, errorMessage, onSuccess) {
  trackDeployDrainWork(kind, task, 'startup')
    .then((result) => {
      if (typeof onSuccess === 'function') onSuccess(result)
    })
    .catch((error) => {
      logger.error(`${errorMessage}: ${error.message}`)
    })
}

// Render y la mayoría de despliegues están detrás de un proxy que envía X-Forwarded-For con la IP real
app.set('trust proxy', true)

app.use((req, res, next) => {
  const drainClassification = classifyDeployDrainRequest(req)
  const drainAllowed = Boolean(drainClassification && drainClassification !== 'health')

  // El healthcheck es la señal de drain para Render. El tráfico de usuario no
  // debe recibir 503 aquí; debe terminar en la instancia vieja o pasar a la nueva.
  if (shuttingDown && !isHealthRequest(req)) {
    res.set('Connection', 'close')
  }

  activeRequests += 1
  if (drainClassification === 'http:media-upload') activeUploadRequests += 1
  if (drainAllowed) activeDrainAllowedRequests += 1
  const finishDrainWork = drainAllowed
    ? beginDeployDrainWork(drainClassification, `${req.method} ${req.originalUrl || req.url || req.path || ''}`)
    : null
  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    activeRequests = Math.max(0, activeRequests - 1)
    if (drainClassification === 'http:media-upload') activeUploadRequests = Math.max(0, activeUploadRequests - 1)
    if (drainAllowed) activeDrainAllowedRequests = Math.max(0, activeDrainAllowedRequests - 1)
    finishDrainWork?.()
  }
  res.on('finish', finish)
  res.on('close', finish)
  return next()
})

// Middlewares
// (SEC-009) CORS con allowlist en lugar de reflejar cualquier origen.
// Rollout seguro: si NO hay allowlist configurada (instalación sin APP_URL/
// CORS_ALLOWED_ORIGINS), se mantiene el comportamiento permisivo + warn para no
// romper instalaciones vivas. Cuando hay allowlist, solo se reflejan los orígenes
// permitidos; peticiones sin Origin (same-origin, app nativa, server-to-server) y
// los orígenes de la app móvil (Capacitor) siempre pasan.
const CORS_NATIVE_APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'https://localhost']
const corsConfiguredOrigins = Array.from(new Set([
  process.env.APP_URL,
  process.env.RENDER_EXTERNAL_URL,
  ...String(process.env.CORS_ALLOWED_ORIGINS || '').split(',')
]
  .map((value) => String(value || '').trim().replace(/\/+$/, ''))
  .filter(Boolean)))
const corsAllowlist = new Set([...corsConfiguredOrigins, ...CORS_NATIVE_APP_ORIGINS])
const corsAllowlistEnforced = corsConfiguredOrigins.length > 0
if (!corsAllowlistEnforced) {
  logger.warn('[SEC-009] CORS sin allowlist (APP_URL/CORS_ALLOWED_ORIGINS no configurados): reflejando cualquier origen. Configura el dominio de la instalación para endurecer.')
}
app.use(cors({
  origin: (origin, callback) => {
    // Sin Origin (same-origin, app nativa, server-to-server) o allowlist no enforced: permitir.
    if (!origin || !corsAllowlistEnforced) return callback(null, true)
    const normalized = origin.replace(/\/+$/, '')
    if (corsAllowlist.has(normalized)) return callback(null, true)
    // Origen no permitido: no reflejar headers CORS (el navegador bloquea la lectura
    // cross-origin) sin rechazar la petición server-side, para no romper rutas públicas
    // (tracking/sites) ni clientes no-navegador.
    return callback(null, false)
  },
  credentials: true
}))

const HTTP_COMPRESSION_MIN_BYTES = 1024

function isHttpCompressibleContentType(contentType = '') {
  const normalized = String(contentType).split(';', 1)[0].trim().toLowerCase()
  return normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/javascript' ||
    normalized === 'application/x-javascript' ||
    normalized === 'text/javascript' ||
    normalized === 'text/css' ||
    normalized === 'image/svg+xml'
}

function shouldCompressHttpResponse(req, res) {
  const contentEncoding = String(res.getHeader('Content-Encoding') || '').trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') return false

  const contentType = String(res.getHeader('Content-Type') || '')
  if (contentType.toLowerCase().startsWith('text/event-stream')) return false
  if (!isHttpCompressibleContentType(contentType)) return false

  return compression.filter(req, res)
}

// Comprime únicamente respuestas de texto estructurado. Audio, video, imágenes
// raster, archivos ya comprimidos y SSE pasan intactos para evitar trabajo inútil
// y buffering de streams en tiempo real.
app.use(compression({
  filter: shouldCompressHttpResponse,
  threshold: HTTP_COMPRESSION_MIN_BYTES
}))

const conversationalGoalCallbackJsonParser = express.json({
  limit: '64kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8')
  }
})
const conversationalGoalCallbackFormParser = express.urlencoded({
  extended: true,
  limit: '64kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8')
  }
})

const metaInstallerRelayJsonParser = express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8')
  }
})

function runMetaInstallerRelayParser(req, res, next) {
  return metaInstallerRelayJsonParser(req, res, (error) => {
    if (!error) return next()
    if (error.type === 'entity.too.large' || error.status === 413 || error.statusCode === 413) {
      return res.status(413).json({
        success: false,
        code: 'META_INSTALLER_RELAY_BODY_TOO_LARGE',
        error: 'El evento de Meta supera el límite permitido.'
      })
    }
    return next(error)
  })
}

function runConversationalGoalCallbackParser(parser, req, res, next) {
  return parser(req, res, (error) => {
    if (!error) return next()

    if (error.type === 'entity.too.large' || error.status === 413 || error.statusCode === 413) {
      return res.status(413).json({
        success: false,
        code: 'CONVERSATIONAL_GOAL_CALLBACK_BODY_TOO_LARGE',
        error: 'El callback del agente conversacional supera el límite permitido de 64 KB.'
      })
    }

    return next(error)
  })
}

app.use((req, res, next) => {
  const isConversationalGoalCallback = /^\/webhooks?\/conversational-agent\/goal(?:\/|$)/i.test(req.path)
  const isExternalGoalCompletion = /^\/api\/external\/conversational-agent\/goals\/[^/]+\/complete\/?$/i.test(req.path)
  if (!isConversationalGoalCallback && !isExternalGoalCompletion) return next()
  if (isExternalGoalCompletion && !req.is('application/json')) {
    return res.status(415).json({
      success: false,
      code: 'CONVERSATIONAL_GOAL_JSON_REQUIRED',
      error: 'La confirmación de la meta requiere Content-Type: application/json.'
    })
  }
  if (req.is('application/json')) {
    return runConversationalGoalCallbackParser(conversationalGoalCallbackJsonParser, req, res, next)
  }
  if (isConversationalGoalCallback && req.is('application/x-www-form-urlencoded')) {
    return runConversationalGoalCallbackParser(conversationalGoalCallbackFormParser, req, res, next)
  }
  const contentLength = Number(req.get('content-length') || 0)
  if (isConversationalGoalCallback && !contentLength) return next()
  return res.status(415).json({
    success: false,
    code: 'CONVERSATIONAL_GOAL_CONTENT_TYPE_UNSUPPORTED',
    error: 'El callback debe usar JSON o application/x-www-form-urlencoded.'
  })
})

// Este endpoint público verifica HMAC sobre el body crudo y no debe atravesar
// primero el parser global de 35 MB. Se monta aquí con límite propio y ruta
// canónica; el resto de webhooks conserva su parser existente.
app.post(
  '/webhooks/meta/installer-relay',
  runMetaInstallerRelayParser,
  handleMetaInstallerRelayWebhook
)

// MCP sólo acepta JSON-RPC acotado. Se parsea antes del límite global usado por
// uploads/base64 para que un cliente externo no pueda hacer que el proceso
// materialice 35 MB por request antes de que corran OAuth y el rate limit.
app.use('/api/mcp', express.json({
  limit: '3mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8')
  }
}))

app.use(express.json({
  limit: '35mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8')
  }
}))
app.use(express.urlencoded({ extended: true, limit: '35mb' }))
app.use('/uploads', express.static(join(__dirname, '../uploads'), {
  maxAge: '7d',
  immutable: true
}))

// Health check
app.get('/api/health', (req, res) => {
  const readiness = getRuntimeReadiness()

  res.status(readiness.statusCode).json({
    status: readiness.ok ? 'ok' : getStartupStatus(),
    startup: getStartupStatus(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.0',
    contracts: {
      productPostWebhook: PRODUCT_POST_WEBHOOK_SCHEMA
    }
  })
})

// Health check de instalación (lo consulta el portal instalador para saber
// si la app ya está lista). Debe ir antes del host router de Sites.
app.get('/health', async (req, res, next) => {
  try {
    const readiness = getRuntimeReadiness()
    res.status(readiness.statusCode).json({
      ...getHealthInfo(),
      ...(await getCentralBrokerHealthInfo()),
      ok: readiness.ok,
      startup: getStartupStatus()
    })
  } catch (error) {
    next(error)
  }
})

// El broker central confirma el control de la URL mientras el runtime todavía
// termina de arrancar. La identidad ya vive cifrada en la DB y la ruta sólo
// firma retos ligados al mismo origen público que recibió la petición.
app.use('/api/central-broker', centralBrokerRoutes)

app.use((req, res, next) => {
  if (startupState.ready) {
    return next()
  }

  if (startupState.error) {
    return res.status(503).json({
      error: 'Aplicación no disponible',
      message: 'El arranque falló. Revisa los logs del servidor.'
    })
  }

  return res.status(503).json({
    error: 'Aplicación iniciando',
    message: 'La app está terminando de preparar la base de datos y servicios internos.'
  })
})

// Multimedia pública/fallback e integraciones internas del installer.
// Deben existir antes del host router de Sites para no capturar estas rutas como dominios públicos.
app.use('/media', mediaRoutes)
app.use('/internal', internalStorageRoutes)
app.use('/trigger-links', triggerLinksRoutes)

// Host router para Sites públicos. Debe correr antes de APIs privadas/static.
app.use(publicSiteHostMiddleware)

// API Routes
app.use('/', oauthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/api-access', apiAccessRoutes)
app.use('/api/media', mediaRoutes)
app.use('/api/internal', internalStorageRoutes)
app.use('/api/sites', sitesRoutes)
app.use('/api/automations', requireAuth, requireFeature('automations'), automationsRoutes) // (LIC-002) auth antes de feature
app.use('/api/appointment-reminders', appointmentRemindersRoutes)
app.use('/api/reports', requireAuth, requireFeature('advanced_reports'), reportsRoutes) // (LIC-002) auth antes de feature
app.use('/api/highlevel', highlevelRoutes)
app.use('/api/products', productsRoutes)
app.use('/api/subscriptions', subscriptionsRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/mercadopago', mercadoPagoRoutes)
app.use('/api/conekta', conektaRoutes)
app.use('/api/clip', clipRoutes)
app.use('/api/rebill', rebillRoutes)
// Página de prueba del Meta Pixel (navegador + servidor). Pública pero protegida
// por un token corto firmado; va antes del router autenticado para que se pueda
// abrir en una pestaña nueva sin el header Authorization.
app.get('/api/meta/pixel-test', renderMetaPixelTestPage)
app.post('/api/meta/pixel-test/event', runMetaPixelTestServerEvent)
app.use('/api/meta', requireAuth, requireFeature('meta_ads'), metaRoutes) // (LIC-002) auth antes de feature
// (LIC-001) Gating de features cobradas también en backend (el frontend ya las trata
// como features de licencia). Solo se gatean routers 100% autenticados sin sub-rutas
// públicas; los routers con webhooks o checkout público (stripe/conekta/mercadopago/sites)
// NO se gatean en el mount para no romper pagos en vivo ni la captura pública de leads.
// requireFeature es fail-open cuando la licencia no está enforced (instalación standalone).
app.use('/api/dashboard', requireAuth, requireFeature('dashboard'), dashboardRoutes) // (LIC-002) auth antes de feature
app.use('/api/webhook-config', webhookConfigRoutes)
app.use('/api/contacts', requireAuth, requireFeature('contacts'), contactsRoutes) // (LIC-002) auth antes de feature
app.use('/api/contact-tags', requireAuth, requireFeature('contacts'), contactTagsRoutes) // (LIC-002) auth antes de feature
app.use('/api/transactions', requireAuth, requireFeature('payments'), transactionsRoutes) // (LIC-002) auth antes de feature
app.use('/api/integrations', requireAuth, requireFeature('integrations'), integrationsRoutes) // (LIC-002) auth antes de feature
app.use('/api/attribution', requireAuth, requireFeature('analytics'), attributionRoutes) // (LIC-002) auth antes de feature
app.use('/api/settings', settingsRoutes)
// (LIC-002) Estos mounts NO anteponen requireAuth: publicCalendarsRoutes expone
// rutas públicas de booking (/public/...) que romperían con auth. calendarsRoutes
// ya aplica requireAuth internamente.
app.use('/api/calendars', requireFeature('appointments'), publicCalendarsRoutes)
app.use('/api/calendars', requireFeature('appointments'), calendarsRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/license', licenseRoutes)
app.use('/api/mdp-program', requireAuth, requireFeature('mdp_program'), mdpProgramRoutes)
app.use('/api/chat-events', chatEventsRoutes)
app.use('/api/payment-events', requireAuth, requireFeature('payments'), paymentEventsRoutes)
app.use('/api/config', configRoutes)
app.use('/api/user-config', userConfigRoutes) // (MOB-006) preferencias de notificaciones por usuario
const requireWhatsAppFeatureForWhatsAppApiRoute = (() => {
  const whatsappFeatureGate = requireFeature('whatsapp')
  return (req, res, next) => {
    // Messenger/Instagram comparten controladores históricos bajo este prefijo,
    // pero pertenecen a Campañas + Chat. No deben heredar la licencia WhatsApp.
    if (String(req.path || '').toLowerCase().startsWith('/meta/social/')) return next()
    return whatsappFeatureGate(req, res, next)
  }
})()
// Deben montarse antes de costsRoutes: ese router histórico cuelga de /api y su
// router.use(requireAuth) intercepta cualquier /api/* que aparezca después.
// Los callbacks Installer -> tenant viven antes de router.use(requireAuth) y se
// autentican con HMAC, timestamp, nonce e installation id dentro del router.
// El resto de /api/whatsapp-api sigue exigiendo la sesión humana ahí mismo.
app.use('/api/whatsapp-api', requireWhatsAppFeatureForWhatsAppApiRoute, whatsappApiRoutes)
// MCP tiene autenticación OAuth propia. Si queda después de costsRoutes, el
// middleware de sesión humana responde primero y rompe el discovery remoto.
app.use('/api/mcp', mcpRoutes)
app.use('/api', costsRoutes)
app.use('/api/hidden-contacts', hiddenContactsRoutes)
app.use('/api/ai-agent', requireAuth, requireFeature('app_assistant_ai'), aiAgentRoutes) // (LIC-002) auth antes de feature
app.use('/api/conversational-agent', requireAuth, requireFeature('conversational_ai'), conversationalAgentRoutes) // (LIC-002) auth antes de feature
app.use('/api/search', searchRoutes)
app.use('/api/external', externalRoutes)
app.use('/api/email', requireAuth, requireFeature('email'), emailRoutes) // (LIC-002) auth antes de feature
app.use('/webhook', webhooksRoutes)
app.use('/webhooks', webhooksRoutes) // Alias para webhooks con 's'

// Tracking público y privado. El router público no debe capturar "/" porque bloquearía el frontend.
app.use('/', publicTrackingRoutes) // Maneja /snip.js, /collect, /sync-visitor y /link-visitor
app.use('/api/tracking', publicTrackingRoutes)
app.use('/api/tracking', trackingRoutes)

// Servir frontend en producción
if (process.env.NODE_ENV === 'production') {
  const frontendPath = join(__dirname, '../../frontend/dist')
  const revalidatableFrontendFiles = new Set(['index.html', 'sw.js'])
  const viteHashedAssetPathPattern = /^assets\/(?:.+\/)?[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/

  app.use(express.static(frontendPath, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      const relativePath = relative(frontendPath, filePath).split(sep).join('/')

      // Vite publica los bundles versionados dentro de /assets. El hash cambia
      // cuando cambia el contenido, así que pueden vivir un año sin revalidar.
      if (viteHashedAssetPathPattern.test(relativePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        return
      }

      // El documento de entrada, el service worker y todos los manifests deben
      // poder guardarse, pero se revalidan siempre para detectar un deploy nuevo.
      if (revalidatableFrontendFiles.has(relativePath) || /^manifest(?:\.[^/]+)?\.webmanifest$/i.test(relativePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate')
        return
      }

      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
    }
  }))

  app.get('/assets/*', (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.status(404).type('text/plain').send('Static asset not found')
  })

  app.get('*', (req, res) => {
    // No servir index.html para rutas de API o webhooks
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
      return res.status(404).json({ error: 'Endpoint no encontrado' })
    }
    res.set('Cache-Control', 'no-cache, must-revalidate')
    res.sendFile(join(frontendPath, 'index.html'))
  })
}

// Manejo de errores global
app.use((err, req, res, next) => {
  logger.error('Error no manejado:', err)
  res.status(500).json({
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'production' ? 'Algo salió mal' : err.message
  })
})

async function startRuntimeServices() {
  logger.info('Preparando base de datos antes de habilitar la app...')
  await databaseReady

  // (DB-001) Aplicar migraciones versionadas (cambios de esquema aditivos) sobre el
  // schema base ya creado por initTables, antes de habilitar tráfico.
  await runVersionedMigrations()

  // Coexistence puede entregar el mismo mensaje por Baileys y por el webhook
  // oficial. Antes de aceptar tráfico, fusiona únicamente identidades exactas y
  // activa la unicidad que cierra carreras entre ambos adaptadores.
  await repairWhatsAppProtocolMessageIdentities()

  // Inicializar clave maestra de encriptación (DEBE ser lo primero)
  await initializeMasterKey()

  // El calendario semilla se crea una sola vez antes de aceptar tráfico. Nunca
  // se inicializa desde GET /api/calendars: abrir dos clientes en paralelo no
  // puede convertir una lectura en dos INSERT ni dejar calendarios duplicados.
  await ensureDefaultLocalCalendar()
  await ensureCalendarBookingSystemFormOnce()

  // Verificar si existe usuario; si no, la app muestra /setup para crear el primero.
  await initializeDefaultUser()

  // Publica el directorio de usuarios al portal para que el login móvil pueda
  // enrutar a dueño y empleados por su correo (best-effort, no bloquea el boot).
  requestPortalUserRefresh({ autoRegister: false })

  // Inicializar versión de Meta API desde BD
  await initializeVersion()

  // Cleanup de sistema: compensa subscribed_apps/relay de OAuth abandonados y
  // garantiza TTL de secretos aunque nadie vuelva a abrir Configuración.
  startMetaOAuthPendingSessionCleanupScheduler()
  startMetaOAuthIntegrationCleanupScheduler()

  // Las reparaciones de historiales grandes no forman parte de la compuerta de
  // sesión. El esquema y las rutas ya están listos; esta tarea converge datos
  // heredados por lotes mientras móvil y escritorio usan los datos existentes.
  runStartupDrainTask(
    'startup:data-maintenance',
    runStartupDataMaintenance,
    'No se pudo completar el mantenimiento histórico en segundo plano'
  )

  // Las instalaciones existentes pueden tener miles de grafos publicados. El
  // índice se reconstruye por lotes sin retrasar el healthcheck; mientras
  // converge, el motor conserva el lookup legacy para no perder eventos.
  runStartupDrainTask(
    'startup:automation-trigger-index',
    scheduleAutomationTriggerIndexBootstrap,
    'No se pudo preparar el índice de disparadores de automatizaciones'
  )

  runStartupDrainTask(
    'startup:media-runtime-config',
    ensureBunnyStreamRuntimeConfigured,
    'No se pudo preparar Bunny Stream al arrancar'
  )

  // Auto-migración de taxonomía del Bunny: re-enraíza lo viejo a accounts/<slug>
  // una sola vez por instalación, en segundo plano y SIN borrar lo viejo (respaldo
  // intacto). No bloquea el arranque. Desactivable con STORAGE_TAXONOMY_AUTOMIGRATE=off.
  runStartupDrainTask(
    'startup:storage-taxonomy-migration',
    scheduleStartupStorageTaxonomyMigration,
    'No se pudo agendar la migración de taxonomía de storage'
  )

  runStartupDrainTask(
    'startup:meta-version',
    async () => {
      if (!(await isMetaConnected())) {
        logger.info('Meta API version startup omitido: Meta no está conectado')
        return { skipped: true, reason: 'meta-disconnected' }
      }
      return updateMetaVersion({ source: 'startup' })
    },
    'No se pudo revisar la versión de Meta API al arrancar'
  )

  // La Página pudo haberse conectado antes de que Ristak necesitara un campo
  // adicional del webhook. Reconciliamos la lista completa en cada arranque
  // (idempotente) para que una instalación ya conectada no pierda eventos de
  // entrega/lectura/edición. Sólo se toca Meta cuando la integración y
  // Messenger están activos.
  runStartupDrainTask(
    'startup:meta-page-messaging-subscription',
    async () => {
      if (!(await isMetaSocialConnected())) {
        logger.info('Suscripción Meta de Messenger omitida: Meta Social no está conectado')
        return { skipped: true, reason: 'meta-social-disconnected' }
      }

      const { reconcileMetaPageMessagingSubscription } = await import('./services/metaSocialMessagingService.js')
      const result = await reconcileMetaPageMessagingSubscription()
      if (result.skipped) {
        logger.info('Suscripción Meta de Messenger omitida: Messenger está apagado')
      }
      return result
    },
    'No se pudo reconciliar la suscripción Meta de Messenger al arrancar'
  )

  // Stripe entrega un signing secret distinto para cada endpoint. Si el dominio
  // cambió o el endpoint fue eliminado desde Stripe, el secret anterior ya no
  // puede validar eventos. Reconciliamos sólo instalaciones conectadas, en
  // segundo plano y de forma idempotente, sin bloquear el healthcheck.
  runStartupDrainTask(
    'startup:stripe-webhook-reconciliation',
    async () => {
      if (!(await isStripeConnected())) {
        logger.info('Webhook Stripe omitido: Stripe no está conectado')
        return { skipped: true, reason: 'stripe-disconnected' }
      }
      return reconcileStripeWebhookConfiguration()
    },
    'No se pudo reconciliar el webhook de Stripe al arrancar'
  )

  // (CRON-006) Verificar y actualizar webhooks en producción SIN bloquear el boot:
  // si HighLevel responde lento, el await anterior dejaba la app en 'starting' y
  // devolvía 503 a todo el tráfico. Se ejecuta en segundo plano (best-effort), igual
  // que el resto de tareas de arranque no críticas (repairPendingPaymentFlows, etc.).
  runStartupDrainTask(
    'startup:webhook-verification',
    verifyAndUpdateWebhooks,
    'No se pudo verificar/actualizar webhooks al arrancar'
  )

  runStartupDrainTask(
    'startup:payment-flow-repair',
    repairPendingPaymentFlows,
    'No se pudo ejecutar reparación inicial de parcialidades'
  )

  runStartupDrainTask(
    'startup:message-template-initialization',
    ensureDefaultWhatsAppApiMessageTemplates,
    'No se pudieron inicializar localmente las plantillas default de WhatsApp'
  )

  runStartupDrainTask(
    'startup:conversational-agent-recovery',
    recoverPendingConversationalAgentConversations,
    'No se pudo recuperar conversaciones pendientes del agente'
  )

  runStartupDrainTask(
    'startup:conversational-goal-effects-recovery',
    recoverPendingConversationGoalCompletionEffects,
    'No se pudieron recuperar efectos pendientes de metas conversacionales'
  )

  // Iniciar cron jobs (desactivables en entornos de dev/prueba con RISTAK_DISABLE_CRONS=true
  // para no disparar mensajes/automatizaciones reales al levantar la app localmente).
  if (process.env.RISTAK_DISABLE_CRONS === 'true') {
    logger.warn('[dev] Cron jobs desactivados por RISTAK_DISABLE_CRONS=true')
  } else {
    import('./services/automationEngine.js')
      .then((engine) => engine.startAutomationScheduler())
      .catch((error) => logger.error(`No se pudo iniciar el motor de automatizaciones: ${error.message}`))
    startScheduledChatMessagesCron() // Envía mensajes de chat cuando llegue su hora programada
    startContactBulkActionsCron()    // Ejecuta lotes masivos de contactos programados o en goteo
    startAppointmentRemindersCron()  // Envía recordatorios y confirmaciones de citas
    startPaymentAutomationsCron()    // Envía recordatorios, comprobantes y cobros fallidos de pagos
    startConversationalAgentSafetyNotificationsCron() // Reintenta avisos preventivos auditables
    startConversationalAgentTestPaymentsCleanup() // Invalida y limpia links sandbox vencidos del tester
    startConversationalAppointmentTestCleanupCron() // Elimina citas reales de prueba tras cinco minutos
    startConversationalAgentTestAssignmentsCleanup() // Restaura asignaciones temporales y respeta cambios humanos posteriores
    startConversationalAgentPauseExpiryCron() // Reactiva pausas vencidas fuera de los GET de métricas/listados
    startChatPushDeliveryCron() // Recupera push durable y limpia terminales aunque Meta se desconecte
    startConversationGoalEffectsRecoveryScheduler() // Recupera leases/fallos de metas sin depender de un reinicio
    await syncRegisteredIntegrationCrons({ reason: 'startup' }) // Integraciones: sólo si están conectadas
  }
  startupState.ready = true

  // Primero publicamos readiness; después arrancan los backfills históricos.
  // En el primer rollout pueden recorrer millones de filas en lotes y no deben
  // competir con la llave maestra, el setup, calendarios ni crons necesarios
  // para que la instancia pase su healthcheck. La cola conserva prioridades y
  // un solo job de I/O intensivo a la vez.
  scheduleCrmListProjectionBackfill()
  scheduleTrackingVisitorProjectionBackfill()
  // Chat, first-seen, metricas del agente e identidad se agendan desde sus
  // singletons durables. Un restart caliente no vuelve a encolar ni a sondear
  // historicos que ya fueron certificados como ready.
  startReadModelProjectionMaintenanceScheduler()
  startAutomationReviewProjectionScheduler()
  startWhatsAppStatusProjectionScheduler()

  logger.success('App lista para recibir tráfico')
}

// Iniciar servidor. Render requiere escuchar en 0.0.0.0 y el puerto de PORT.
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.success(`🚀 Servidor escuchando en puerto ${PORT}`)
  logger.info(`Entorno: ${process.env.NODE_ENV || 'development'}`)

  startRuntimeServices().catch((error) => {
    startupState.error = error
    logger.error('Error durante el arranque de la app:', error)
    process.exitCode = 1
    setTimeout(() => process.exit(1), 1000)
  })
})

function handleShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  // No apagar startupState.ready: /health ya falla por shuttingDown, pero los
  // requests normales deben seguir pasando mientras la instancia vieja drena.
  markDeployShutdownStarted()
  stopChatPushDeliveryCron()
  stopIntegrationCrons()
  logger.warn(
    `[Shutdown] ${signal} recibido. Drenando ${activeRequests} request(s) activa(s), ` +
      `${activeUploadRequests} upload(s) protegido(s), ${activeDrainAllowedRequests} request(s) critico(s), ` +
      `${formatDeployDrainSnapshot()}, por hasta ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms.`
  )

  let serverClosed = false
  let exiting = false
  let poller = null
  let timeout = null
  let qrShutdownDone = false

  const finishShutdownIfIdle = () => {
    if (exiting || !serverClosed || !qrShutdownDone) return
    const snapshot = getDeployDrainSnapshot()
    if (activeRequests > 0 || snapshot.total > 0) return

    exiting = true
    if (poller) clearInterval(poller)
    if (timeout) clearTimeout(timeout)
    logger.info('[Shutdown] Servidor cerrado correctamente y trabajo critico drenado.')
    process.exit(0)
  }

  shutdownWhatsAppQrService({ reason: signal })
    .catch((error) => {
      logger.warn(`[Shutdown] No se pudieron cerrar sesiones QR: ${error.message}`)
    })
    .finally(() => {
      qrShutdownDone = true
      finishShutdownIfIdle()
    })

  server.close((error) => {
    if (error) {
      logger.error('[Shutdown] Error cerrando servidor:', error)
      process.exit(1)
    }
    serverClosed = true
    finishShutdownIfIdle()
  })

  poller = setInterval(finishShutdownIfIdle, 500)
  poller.unref?.()

  timeout = setTimeout(() => {
    exiting = true
    if (poller) clearInterval(poller)
    const snapshot = getDeployDrainSnapshot()
    logger.warn(
      `[Shutdown] Tiempo agotado con ${activeRequests} request(s) activa(s), ` +
        `${activeUploadRequests} upload(s) protegido(s), ${activeDrainAllowedRequests} request(s) critico(s), ` +
        `${formatDeployDrainSnapshot(snapshot)}. Cerrando proceso.`
    )
    process.exit(0)
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)
  timeout.unref?.()
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'))
process.on('SIGINT', () => handleShutdown('SIGINT'))

// Manejo de errores de proceso
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada sin manejar:', reason)
})

process.on('uncaughtException', (error) => {
  if (isTransientPostgresConnectionError(error)) {
    logger.warn(`PostgreSQL emitió un error transitorio fuera del flujo de request: ${describePostgresConnectionError(error)}. El proceso sigue vivo y abrirá otra conexión.`)
    return
  }

  logger.error('Excepción no capturada:', error)
  process.exit(1)
})
