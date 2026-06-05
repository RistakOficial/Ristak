import {
  disablePushSubscription,
  getPublicPushConfig,
  savePushSubscription
} from '../services/pushNotificationsService.js'
import { logger } from '../utils/logger.js'

export async function getPushPublicKey(req, res) {
  try {
    res.json({
      success: true,
      data: getPublicPushConfig()
    })
  } catch (error) {
    logger.error(`[Push Controller] Error obteniendo llave pública: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudo leer la configuración de avisos'
    })
  }
}

export async function saveSubscription(req, res) {
  try {
    const { subscription, calendarIds } = req.body || {}
    const saved = await savePushSubscription({
      subscription,
      calendarIds,
      userId: req.user?.userId || null,
      userAgent: req.headers['user-agent'] || ''
    })

    res.status(201).json({
      success: true,
      data: saved
    })
  } catch (error) {
    logger.warn(`[Push Controller] Suscripción rechazada: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo guardar este celular'
    })
  }
}

export async function disableSubscription(req, res) {
  try {
    await disablePushSubscription(req.body?.endpoint)
    res.json({
      success: true,
      data: { disabled: true }
    })
  } catch (error) {
    logger.warn(`[Push Controller] No se pudo apagar suscripción: ${error.message}`)
    res.status(400).json({
      success: false,
      error: 'No se pudo apagar este celular'
    })
  }
}
