import express from 'express'
import {
  servePixel,
  collectEvent,
  collectVideoEvent,
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
  getContactConversionsByDate,
  getContactConversionsList
} from '../controllers/trackingController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

export const publicTrackingRoutes = express.Router()
const router = express.Router()

// Servir pixel JavaScript
publicTrackingRoutes.get('/snip.js', servePixel)

// Recibir eventos del pixel
publicTrackingRoutes.post('/collect', collectEvent)

// Recibir eventos de reproduccion de video en sitios publicos
publicTrackingRoutes.post('/video-event', collectVideoEvent)

// Sincronizar visitor_id con HighLevel
publicTrackingRoutes.post('/sync-visitor', syncVisitorToHighLevel)

// Vincular visitor_id histórico a contacto
publicTrackingRoutes.post('/link-visitor', linkVisitorToContactHandler)

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

// Obtener contactos de una bolita del gráfico de conversiones
router.get('/contact-conversions-list', getContactConversionsList)

export default router
