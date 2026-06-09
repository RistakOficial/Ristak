import './config/initTimezone.js'
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from './utils/logger.js'
import { initializeMasterKey } from './utils/encryption.js'
import { initializeDefaultUser } from './utils/auth.js'
import { startMetaSyncCron } from './jobs/metaSync.cron.js'
import { startHighLevelSyncCron } from './jobs/highlevelSync.cron.js'
import { startMetaVersionCron, updateMetaVersion } from './jobs/metaVersionCron.js'
import { startScheduledChatMessagesCron } from './jobs/scheduledChatMessages.cron.js'
import { initializeVersion } from './services/metaVersionService.js'
import { verifyAndUpdateWebhooks } from './startup/webhookVerification.js'
import { repairPendingPaymentFlows } from './services/paymentFlowService.js'

// Force redeploy to ensure latest logs are active

// Routes
import highlevelRoutes from './routes/highlevel.routes.js'
import metaRoutes from './routes/meta.routes.js'
import dashboardRoutes from './routes/dashboard.routes.js'
import webhooksRoutes from './routes/webhooks.routes.js'
import reportsRoutes from './routes/reports.routes.js'
import webhookConfigRoutes from './routes/webhookConfig.routes.js'
import contactsRoutes from './routes/contacts.routes.js'
import transactionsRoutes from './routes/transactions.routes.js'
import integrationsRoutes from './routes/integrations.routes.js'
import attributionRoutes from './routes/attribution.routes.js'
import settingsRoutes from './routes/settings.routes.js'
import calendarsRoutes from './routes/calendars.routes.js'
import trackingRoutes, { publicTrackingRoutes } from './routes/tracking.routes.js'
import configRoutes from './routes/config.routes.js'
import costsRoutes from './routes/costs.routes.js'
import maintenanceRoutes from './routes/maintenance.routes.js'
import authRoutes from './routes/auth.routes.js'
import apiAccessRoutes from './routes/apiAccess.routes.js'
import oauthRoutes from './routes/oauth.routes.js'
import hiddenContactsRoutes from './routes/hiddenContacts.routes.js'
import aiAgentRoutes from './routes/aiAgent.routes.js'
import searchRoutes from './routes/search.routes.js'
import externalRoutes from './routes/external.routes.js'
import mcpRoutes from './routes/mcp.routes.js'
import whatsappApiRoutes from './routes/whatsappApi.routes.js'
import productsRoutes from './routes/products.routes.js'
import sitesRoutes from './routes/sites.routes.js'
import pushRoutes from './routes/push.routes.js'
import licenseRoutes from './routes/license.routes.js'
import { publicSiteHostMiddleware } from './controllers/sitesController.js'
import { getHealthInfo } from './services/licenseService.js'
import { requireFeature } from './middleware/licenseMiddleware.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Render y la mayoría de despliegues están detrás de un proxy que envía X-Forwarded-For con la IP real
app.set('trust proxy', true)

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
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  })
})

// Health check de instalación (lo consulta el portal instalador para saber
// si la app ya está lista). Debe ir antes del host router de Sites.
app.get('/health', (req, res) => {
  res.json(getHealthInfo())
})

// Host router para Sites públicos. Debe correr antes de APIs privadas/static.
app.use(publicSiteHostMiddleware)

// API Routes
app.use('/', oauthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/api-access', apiAccessRoutes)
app.use('/api/sites', sitesRoutes)
app.use('/api/reports', requireFeature('advanced_reports'), reportsRoutes)
app.use('/api/highlevel', highlevelRoutes)
app.use('/api/products', productsRoutes)
app.use('/api/meta', requireFeature('meta_ads'), metaRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/webhook-config', webhookConfigRoutes)
app.use('/api/contacts', contactsRoutes)
app.use('/api/transactions', transactionsRoutes)
app.use('/api/integrations', integrationsRoutes)
app.use('/api/attribution', attributionRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/calendars', requireFeature('google_calendar'), calendarsRoutes)
app.use('/api/push', pushRoutes)
app.use('/api/license', licenseRoutes)
app.use('/api/config', configRoutes)
app.use('/api', costsRoutes)
app.use('/api/maintenance', maintenanceRoutes)
app.use('/api/hidden-contacts', hiddenContactsRoutes)
app.use('/api/ai-agent', requireFeature('ai'), aiAgentRoutes)
app.use('/api/search', searchRoutes)
app.use('/api/external', externalRoutes)
app.use('/api/mcp', mcpRoutes)
app.use('/api/whatsapp-api', requireFeature('whatsapp'), whatsappApiRoutes)
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

  app.get('*', (req, res) => {
    // No servir index.html para rutas de API o webhooks
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
      return res.status(404).json({ error: 'Endpoint no encontrado' })
    }
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

// Iniciar servidor. Render requiere escuchar en 0.0.0.0 y el puerto de PORT.
app.listen(PORT, '0.0.0.0', async () => {
  logger.success(`🚀 Servidor corriendo en puerto ${PORT}`)
  logger.info(`Entorno: ${process.env.NODE_ENV || 'development'}`)

  // Inicializar clave maestra de encriptación (DEBE ser lo primero)
  await initializeMasterKey()

  // Verificar si existe usuario; si no, la app muestra /setup para crear el primero.
  await initializeDefaultUser()

  // Inicializar versión de Meta API desde BD
  await initializeVersion()

  updateMetaVersion({ source: 'startup' }).catch(error => {
    logger.error(`No se pudo revisar la versión de Meta API al arrancar: ${error.message}`)
  })

  // Verificar y actualizar webhooks en producción
  await verifyAndUpdateWebhooks()

  repairPendingPaymentFlows().catch(error => {
    logger.error(`No se pudo ejecutar reparación inicial de parcialidades: ${error.message}`)
  })

  // Iniciar cron jobs
  startMetaSyncCron()              // Sincroniza anuncios de Meta Ads cada hora
  startHighLevelSyncCron()         // Sincroniza contactos, citas y pagos de HighLevel cada hora (silencioso)
  startMetaVersionCron()           // Revisa versión Meta API una vez al mes
  startScheduledChatMessagesCron() // Envía mensajes de chat cuando llegue su hora programada
})

// Manejo de errores de proceso
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada sin manejar:', reason)
})

process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada:', error)
  process.exit(1)
})
