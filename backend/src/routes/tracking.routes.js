import express from 'express'
import {
  servePixel,
  collectEvent,
  syncVisitorToHighLevel,
  linkVisitorToContactHandler,
  getSessionsHandler,
  getSessionHandler,
  updateSessionHandler,
  deleteSessionsHandler,
  getTrackingConfig,
  configureTracking,
  setAnalyticsPreference,
  setVisitorSourcePreference,
  getVisitorsByAd,
  getVisitorsByPeriod,
  getVisitorsList,
  getContactsByDate,
  getContactConversionsByDate
} from '../controllers/trackingController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// Servir pixel JavaScript
router.get('/snip.js', servePixel)

// Recibir eventos del pixel
router.post('/collect', collectEvent)

// Sincronizar visitor_id con HighLevel
router.post('/sync-visitor', syncVisitorToHighLevel)

// Vincular visitor_id histórico a contacto
router.post('/link-visitor', linkVisitorToContactHandler)

router.use(requireAuth)

// CRUD de sesiones
router.get('/sessions', getSessionsHandler)
router.get('/sessions/:id', getSessionHandler)
router.put('/sessions/:id', updateSessionHandler)
router.delete('/sessions', deleteSessionsHandler)

// Configuración automática
router.get('/config', getTrackingConfig)
router.post('/configure', configureTracking)

// Preferencia de Analytics
router.post('/analytics-preference', setAnalyticsPreference)

// Preferencia de fuente de visitantes
router.post('/visitor-source-preference', setVisitorSourcePreference)

// Obtener visitantes por ad_id desde sessions
router.get('/visitors-by-ad', getVisitorsByAd)

// Obtener visitantes agrupados por período (día/semana/mes/año)
router.get('/visitors-by-period', getVisitorsByPeriod)

// Obtener lista detallada de visitantes (para modal)
router.get('/visitors', getVisitorsList)

// Obtener contactos con visitor_id por fecha (para gráfico de registros)
router.get('/contacts-by-date', getContactsByDate)

// Obtener conversiones por fecha de creación del contacto
router.get('/contact-conversions-by-date', getContactConversionsByDate)

export default router
