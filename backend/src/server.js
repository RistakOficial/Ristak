import './config/initTimezone.js'
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { databaseReady } from './config/database.js'
import { logger } from './utils/logger.js'
import { initializeMasterKey } from './utils/encryption.js'
import { initializeDefaultUser } from './utils/auth.js'
import { startMetaSyncCron } from './jobs/metaSync.cron.js'
import { startHighLevelSyncCron } from './jobs/highlevelSync.cron.js'
import { startMetaVersionCron, updateMetaVersion } from './jobs/metaVersionCron.js'
import { startScheduledChatMessagesCron } from './jobs/scheduledChatMessages.cron.js'
import { startContactBulkActionsCron } from './jobs/contactBulkActions.cron.js'
import { startAppointmentRemindersCron } from './jobs/appointmentReminders.cron.js'
import { startWhatsAppQrWatchdogCron } from './jobs/whatsappQrWatchdog.cron.js'
import { startStripePaymentPlansCron } from './jobs/stripePaymentPlans.cron.js'
import { startConektaPaymentPlansCron } from './jobs/conektaPaymentPlans.cron.js'
import { startPaymentAutomationsCron } from './jobs/paymentAutomations.cron.js'
import { initializeVersion } from './services/metaVersionService.js'
import { verifyAndUpdateWebhooks } from './startup/webhookVerification.js'
import { repairPendingPaymentFlows } from './services/paymentFlowService.js'
import { ensureBunnyStreamRuntimeConfigured } from './services/mediaStorageService.js'
import { repairDefaultMessageTemplatesForCurrentConnection } from './services/messageTemplatesService.js'

// Force redeploy to ensure latest logs are active

// Routes
import highlevelRoutes from './routes/highlevel.routes.js'
import metaRoutes from './routes/meta.routes.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import webhooksRoutes from './routes/webhooks.routes.js'
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
import sitesRoutes from './routes/sites.routes.js'
import mediaRoutes from './routes/media.routes.js'
import internalStorageRoutes from './routes/internalStorage.routes.js'
import automationsRoutes from './routes/automations.routes.js'
import appointmentRemindersRoutes from './routes/appointmentReminders.routes.js'
import pushRoutes from './routes/push.routes.js'
import licenseRoutes from './routes/license.routes.js'
import chatEventsRoutes from './routes/chatEvents.routes.js'
import { publicSiteHostMiddleware } from './controllers/sitesController.js'
import { getHealthInfo } from './services/licenseService.js'
import { requireFeature } from './middleware/licenseMiddleware.js'
import { recoverPendingConversationalAgentConversations } from './agents/conversational/runner.js'
import { repairStoredYCloudHistoryMessageDirections } from './services/whatsappApiService.js'

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

function requestPath(req) {
  return String(req.path || req.originalUrl || '').split('?')[0]
}

function isHealthRequest(req) {
  const path = requestPath(req)
  return path === '/health' || path === '/api/health'
}

function isProtectedUploadRequest(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return false
  const path = requestPath(req)
  return (
    path === '/media/upload' ||
    path === '/api/media/upload' ||
    /^\/media\/assets\/[^/]+\/replace$/.test(path) ||
    /^\/api\/media\/assets\/[^/]+\/replace$/.test(path)
  )
}

function getStartupStatus() {
  if (shuttingDown) return 'shutting_down'
  if (startupState.ready) return 'ready'
  if (startupState.error) return 'error'
  return 'starting'
}

// Render y la mayoría de despliegues están detrás de un proxy que envía X-Forwarded-For con la IP real
app.set('trust proxy', true)

app.use((req, res, next) => {
  if (shuttingDown && !isHealthRequest(req)) {
    res.set('Connection', 'close')
    return res.status(503).json({
      error: 'Aplicación actualizándose',
      message: 'La app está aplicando una actualización. Reintenta en unos segundos.'
    })
  }

  const protectedUpload = isProtectedUploadRequest(req)
  activeRequests += 1
  if (protectedUpload) activeUploadRequests += 1
  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    activeRequests = Math.max(0, activeRequests - 1)
    if (protectedUpload) activeUploadRequests = Math.max(0, activeUploadRequests - 1)
  }
  res.on('finish', finish)
  res.on('close', finish)
  return next()
})

// Middlewares
app.use(cors())
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
  res.status(startupState.error || shuttingDown ? 503 : 200).json({
    status: 'ok',
    startup: getStartupStatus(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.APP_VERSION || '0.0.0'
  })
})

// Health check de instalación (lo consulta el portal instalador para saber
// si la app ya está lista). Debe ir antes del host router de Sites.
app.get('/health', (req, res) => {
  res.status(startupState.error || shuttingDown ? 503 : 200).json({
    ...getHealthInfo(),
    startup: getStartupStatus()
  })
})

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
app.use('/api/automations', requireFeature('automations'), automationsRoutes)
app.use('/api/appointment-reminders', appointmentRemindersRoutes)
app.use('/api/reports', requireFeature('advanced_reports'), reportsRoutes)
app.use('/api/highlevel', highlevelRoutes)
app.use('/api/products', productsRoutes)
app.use('/api/subscriptions', subscriptionsRoutes)
app.use('/api/stripe', stripeRoutes)
app.use('/api/mercadopago', mercadoPagoRoutes)
app.use('/api/conekta', conektaRoutes)
app.use('/api/meta', requireFeature('meta_ads'), metaRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/webhook-config', webhookConfigRoutes)
app.use('/api/contacts', contactsRoutes)
app.use('/api/contact-tags', contactTagsRoutes)
app.use('/api/transactions', transactionsRoutes)
app.use('/api/integrations', integrationsRoutes)
app.use('/api/attribution', attributionRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/calendars', requireFeature('google_calendar'), publicCalendarsRoutes)
app.use('/api/calendars', requireFeature('google_calendar'), calendarsRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/license', licenseRoutes)
app.use('/api/chat-events', chatEventsRoutes)
app.use('/api/config', configRoutes)
app.use('/api', costsRoutes)
app.use('/api/hidden-contacts', hiddenContactsRoutes)
app.use('/api/ai-agent', requireFeature('app_assistant_ai'), aiAgentRoutes)
app.use('/api/conversational-agent', requireFeature('conversational_ai'), conversationalAgentRoutes)
app.use('/api/search', searchRoutes)
app.use('/api/external', externalRoutes)
app.use('/api/mcp', mcpRoutes)
app.use('/api/whatsapp-api', requireFeature('whatsapp'), whatsappApiRoutes)
app.use('/api/email', requireFeature('email'), emailRoutes)
app.use('/webhook', webhooksRoutes)
app.use('/webhooks', webhooksRoutes) // Alias para webhooks con 's'

// Tracking público y privado. El router público no debe capturar "/" porque bloquearía el frontend.
app.use('/', publicTrackingRoutes) // Maneja /snip.js, /collect, /sync-visitor y /link-visitor
app.use('/api/tracking', publicTrackingRoutes)
app.use('/api/tracking', trackingRoutes)

// Servir frontend en producción
if (process.env.NODE_ENV === 'production') {
  const frontendPath = join(__dirname, '../../frontend/dist')
  app.use(express.static(frontendPath))

  app.get('/assets/*', (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.status(404).type('text/plain').send('Static asset not found')
  })

  app.get('*', (req, res) => {
    // No servir index.html para rutas de API o webhooks
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
      return res.status(404).json({ error: 'Endpoint no encontrado' })
    }
    res.set('Cache-Control', 'no-cache')
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

  // Inicializar clave maestra de encriptación (DEBE ser lo primero)
  await initializeMasterKey()

  // Verificar si existe usuario; si no, la app muestra /setup para crear el primero.
  await initializeDefaultUser()

  // Inicializar versión de Meta API desde BD
  await initializeVersion()

  ensureBunnyStreamRuntimeConfigured().catch(error => {
    logger.error(`No se pudo preparar Bunny Stream al arrancar: ${error.message}`)
  })

  updateMetaVersion({ source: 'startup' }).catch(error => {
    logger.error(`No se pudo revisar la versión de Meta API al arrancar: ${error.message}`)
  })

  // Verificar y actualizar webhooks en producción
  await verifyAndUpdateWebhooks()

  repairPendingPaymentFlows().catch(error => {
    logger.error(`No se pudo ejecutar reparación inicial de parcialidades: ${error.message}`)
  })

  repairDefaultMessageTemplatesForCurrentConnection()
    .then((result) => {
      if (result?.submitted > 0) {
        logger.info(`[WhatsApp] Plantillas default preparadas y enviadas a revisión: ${result.submitted}`)
      }
    })
    .catch(error => {
      logger.error(`No se pudo ejecutar reparación inicial de plantillas default de WhatsApp: ${error.message}`)
    })

  repairStoredYCloudHistoryMessageDirections().catch(error => {
    logger.error(`No se pudo recalcular historial WhatsApp API afectado: ${error.message}`)
  })

  recoverPendingConversationalAgentConversations().catch(error => {
    logger.error(`No se pudo recuperar conversaciones pendientes del agente: ${error.message}`)
  })

  // Iniciar cron jobs
  import('./services/automationEngine.js')
    .then((engine) => engine.startAutomationScheduler())
    .catch((error) => logger.error(`No se pudo iniciar el motor de automatizaciones: ${error.message}`))
  startMetaSyncCron()              // Sincroniza anuncios de Meta Ads cada hora
  startHighLevelSyncCron()         // Sincroniza contactos, citas y pagos de HighLevel cada hora (silencioso)
  startMetaVersionCron()           // Revisa versión Meta API una vez al mes
  startScheduledChatMessagesCron() // Envía mensajes de chat cuando llegue su hora programada
  startContactBulkActionsCron()    // Ejecuta lotes masivos de contactos programados o en goteo
  startAppointmentRemindersCron()  // Envía recordatorios y confirmaciones de citas
  startWhatsAppQrWatchdogCron()    // Reabre sesiones de WhatsApp Web al arrancar y las mantiene vivas
  startStripePaymentPlansCron()    // Cobra parcialidades Stripe vencidas con tarjetas guardadas
  startConektaPaymentPlansCron()   // Cobra parcialidades Conekta vencidas con tarjetas guardadas
  startPaymentAutomationsCron()    // Envía recordatorios, comprobantes y cobros fallidos de pagos
  startupState.ready = true
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
  startupState.ready = false
  logger.warn(
    `[Shutdown] ${signal} recibido. Drenando ${activeRequests} request(s) activa(s), ` +
      `${activeUploadRequests} upload(s) protegido(s), por hasta ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms.`
  )

  server.close((error) => {
    if (error) {
      logger.error('[Shutdown] Error cerrando servidor:', error)
      process.exit(1)
    }
    logger.info('[Shutdown] Servidor cerrado correctamente.')
    process.exit(0)
  })

  const timeout = setTimeout(() => {
    logger.warn(
      `[Shutdown] Tiempo agotado con ${activeRequests} request(s) activa(s), ` +
        `${activeUploadRequests} upload(s) protegido(s). Cerrando proceso.`
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
  logger.error('Excepción no capturada:', error)
  process.exit(1)
})
