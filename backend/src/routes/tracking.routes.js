import express from 'express'
import {
  servePixel,
  collectEvent,
  syncVisitorToHighLevel,
  linkVisitorToContact,
  getSessionsHandler,
  getSessionHandler,
  getTrackingConfig,
  configureTracking,
  setAnalyticsPreference
} from '../controllers/trackingController.js'

const router = express.Router()

// Servir pixel JavaScript
router.get('/snip.js', servePixel)

// Recibir eventos del pixel
router.post('/collect', collectEvent)

// Sincronizar visitor_id con HighLevel
router.post('/sync-visitor', syncVisitorToHighLevel)

// Vincular visitor_id histórico a contacto
router.post('/link-visitor', linkVisitorToContact)

// Obtener sesiones (dashboard)
router.get('/sessions', getSessionsHandler)
router.get('/sessions/:id', getSessionHandler)

// Configuración automática
router.get('/config', getTrackingConfig)
router.post('/configure', configureTracking)

// Preferencia de Analytics
router.post('/analytics-preference', setAnalyticsPreference)

export default router
