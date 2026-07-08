import express from 'express'
import {
  servePixel,
  serveMetaParamBuilderClient,
  serveMetaParamBuilderClientIp,
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
  getMessagesSummary,
  getWhatsAppSummary,
  getContactConversionsList
} from '../controllers/trackingController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

export const publicTrackingRoutes = express.Router()
const router = express.Router()

// Servir pixel JavaScript
publicTrackingRoutes.get('/snip.js', servePixel)
publicTrackingRoutes.get('/meta-param-builder.js', serveMetaParamBuilderClient)
publicTrackingRoutes.get('/meta-param-builder-ip', serveMetaParamBuilderClientIp)

// Recibir eventos del pixel
publicTrackingRoutes.post('/collect', collectEvent)

// Recibir eventos de reproduccion de video en sitios publicos
publicTrackingRoutes.post('/video-event', collectVideoEvent)

// Sincronizar visitor_id con HighLevel
publicTrackingRoutes.post('/sync-visitor', syncVisitorToHighLevel)

// Vincular visitor_id histórico a contacto
publicTrackingRoutes.post('/link-visitor', linkVisitorToContactHandler)

router.use(requireAuth)
// (ACL-001) El panel de analytics se protege con AccessRoute en el frontend; aquí
// exigimos el módulo 'analytics' para que la API directa también respete el rol.
router.use(requireModuleAccess('analytics'))
const requireWebAnalyticsFeature = requireFeature('web_analytics')

// CRUD de sesiones
router.get('/sessions', requireWebAnalyticsFeature, getSessionsHandler)
router.get('/sessions/:id', requireWebAnalyticsFeature, getSessionHandler)
router.put('/sessions/:id', requireWebAnalyticsFeature, updateSessionHandler)
router.delete('/sessions', requireWebAnalyticsFeature, deleteSessionsHandler)

// Configuración automática
router.get('/config', requireWebAnalyticsFeature, getTrackingConfig)
router.post('/configure', requireWebAnalyticsFeature, configureTracking)

// Preferencia de Analytics
router.post('/analytics-preference', requireWebAnalyticsFeature, setAnalyticsPreference)

// Preferencia de fuente de visitantes
router.post('/visitor-source-preference', requireWebAnalyticsFeature, setVisitorSourcePreference)

// Obtener visitantes por ad_id desde sessions
router.get('/visitors-by-ad', requireWebAnalyticsFeature, getVisitorsByAd)

// Obtener visitantes agrupados por período (día/semana/mes/año)
router.get('/visitors-by-period', requireWebAnalyticsFeature, getVisitorsByPeriod)

// Obtener lista detallada de visitantes (para modal)
router.get('/visitors', requireWebAnalyticsFeature, getVisitorsList)

// Obtener contactos con visitor_id por fecha (para gráfico de registros)
router.get('/contacts-by-date', getContactsByDate)

// Obtener conversiones por fecha de creación del contacto
router.get('/contact-conversions-by-date', getContactConversionsByDate)

// Obtener resumen de mensajes WhatsApp por rango
router.get('/whatsapp-summary', getWhatsAppSummary)

// Obtener resumen de mensajes por canal
router.get('/messages-summary', getMessagesSummary)

// Obtener contactos de una bolita del gráfico de conversiones
router.get('/contact-conversions-list', getContactConversionsList)

export default router
