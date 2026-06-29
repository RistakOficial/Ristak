import {
  disableMobilePushDevice,
  disablePushSubscription,
  getPublicPushConfig,
  saveMobilePushDevice,
  savePushSubscription
} from '../services/pushNotificationsService.js'
// (NOTI-005)(MOB-008) acceso a DB para verificar propiedad antes de apagar suscripciones/dispositivos
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

export async function getPushPublicKey(req, res) {
  try {
    res.json({
      success: true,
      data: await getPublicPushConfig()
    })
  } catch (error) {
    logger.error(`[Push Controller] Error obteniendo llave pública: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudo leer la configuración de notificaciones'
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
    const endpoint = String(req.body?.endpoint || '').trim()
    // (NOTI-005) verificar propiedad: solo el dueño (o filas sin dueño) puede apagar la suscripción
    if (endpoint) {
      const requesterId = String(req.user?.userId || '').trim()
      const row = await db.get(
        'SELECT user_id FROM push_subscriptions WHERE endpoint = ?',
        [endpoint]
      ).catch(() => null)
      const ownerId = String(row?.user_id || '').trim()
      if (row && ownerId && ownerId !== requesterId) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          error: 'No puedes apagar este celular'
        })
      }
    }

    await disablePushSubscription(endpoint)
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

export async function saveMobileDevice(req, res) {
  try {
    const saved = await saveMobilePushDevice({
      token: req.body?.token,
      platform: req.body?.platform,
      calendarIds: req.body?.calendarIds,
      appVersion: req.body?.appVersion,
      appBuild: req.body?.appBuild,
      deviceModel: req.body?.deviceModel,
      osVersion: req.body?.osVersion,
      userId: req.user?.userId || null
    })

    res.status(201).json({
      success: true,
      data: saved
    })
  } catch (error) {
    logger.warn(`[Push Controller] Celular nativo rechazado: ${error.message}`)
    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo guardar este celular'
    })
  }
}

export async function disableMobileDevice(req, res) {
  try {
    const token = String(req.body?.token || '').trim()
    // (MOB-008)(NOTI-005) verificar propiedad: solo el dueño (o filas sin dueño) puede apagar el dispositivo
    if (token) {
      const requesterId = String(req.user?.userId || '').trim()
      const row = await db.get(
        'SELECT user_id FROM mobile_push_devices WHERE token = ?',
        [token]
      ).catch(() => null)
      const ownerId = String(row?.user_id || '').trim()
      if (row && ownerId && ownerId !== requesterId) {
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          error: 'No puedes apagar este celular'
        })
      }
    }

    await disableMobilePushDevice(token)
    res.json({
      success: true,
      data: { disabled: true }
    })
  } catch (error) {
    logger.warn(`[Push Controller] No se pudo apagar celular nativo: ${error.message}`)
    res.status(400).json({
      success: false,
      error: 'No se pudo apagar este celular'
    })
  }
}
