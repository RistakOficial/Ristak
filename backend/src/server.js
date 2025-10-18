import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { logger } from './utils/logger.js'
import { startMetaSyncCron } from './jobs/metaSync.cron.js'
import { startContactsSyncCron } from './jobs/contactsSync.cron.js'
// import { startInvoicesReconciliation } from './jobs/invoicesReconciliation.cron.js' // DESACTIVADO: Solo usar webhooks
import { verifyAndUpdateWebhooks } from './startup/webhookVerification.js'

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
import paymentMethodsRoutes from './routes/paymentMethods.routes.js'
import calendarsRoutes from './routes/calendars.routes.js'
import trackingRoutes from './routes/tracking.routes.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001

// Middlewares
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  })
})

// API Routes
app.use('/api/reports', reportsRoutes)
app.use('/api/highlevel', highlevelRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/webhook-config', webhookConfigRoutes)
app.use('/api/contacts', contactsRoutes)
app.use('/api/transactions', transactionsRoutes)
app.use('/api/integrations', integrationsRoutes)
app.use('/api/attribution', attributionRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/payment-methods', paymentMethodsRoutes)
app.use('/api/calendars', calendarsRoutes)
app.use('/webhook', webhooksRoutes)
app.use('/webhooks', webhooksRoutes) // Alias para webhooks con 's'

// Tracking routes (pixel)
app.use('/', trackingRoutes) // Maneja /snip.js y /collect
app.use('/api/tracking', trackingRoutes) // Maneja /api/tracking/sessions

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

// Iniciar servidor
app.listen(PORT, async () => {
  logger.success(`🚀 Servidor corriendo en puerto ${PORT}`)
  logger.info(`Entorno: ${process.env.NODE_ENV || 'development'}`)

  // Verificar y actualizar webhooks en producción
  await verifyAndUpdateWebhooks()

  // Iniciar cron jobs
  startMetaSyncCron()
  startContactsSyncCron() // Sincroniza contactos cada hora de manera silenciosa
  // startInvoicesReconciliation() // DESACTIVADO: Solo usar webhooks para sincronización en tiempo real
})

// Manejo de errores de proceso
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa rechazada sin manejar:', reason)
})

process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada:', error)
  process.exit(1)
})
