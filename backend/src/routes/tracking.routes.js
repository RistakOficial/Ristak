import express from 'express'
import {
  servePixel,
  collectEvent,
  getSessionsHandler,
  getSessionHandler
} from '../controllers/trackingController.js'

const router = express.Router()

// Servir pixel JavaScript
router.get('/snip.js', servePixel)

// Recibir eventos del pixel
router.post('/collect', collectEvent)

// Obtener sesiones (dashboard)
router.get('/sessions', getSessionsHandler)
router.get('/sessions/:id', getSessionHandler)

export default router
