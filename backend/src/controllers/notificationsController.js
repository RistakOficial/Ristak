import {
  getSystemNotifications,
  markAllSystemNotificationsRead,
  markNotificationsRead
} from '../services/notificationsService.js'
import { logger } from '../utils/logger.js'

function getRequestUserId(req) {
  return req.user?.userId || req.user?.id || null
}

function getSubmittedNotifications(req) {
  const value = req.body?.notifications
  return Array.isArray(value) ? value.slice(0, 200) : []
}

export async function getNotificationsView(req, res) {
  try {
    const liveMetaCheck = String(req.query?.liveMetaCheck ?? '1') !== '0'
    const limit = Number(req.query?.limit || 30)
    const userId = getRequestUserId(req)
    const data = await getSystemNotifications({ liveMetaCheck, limit, userId })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error obteniendo notificaciones: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'No se pudieron leer las notificaciones'
    })
  }
}

export async function markNotificationsReadView(req, res) {
  try {
    const userId = getRequestUserId(req)
    const result = await markNotificationsRead({
      userId,
      notifications: getSubmittedNotifications(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error marcando notificaciones como leídas: ${error.message}`)
    res.status(400).json({
      success: false,
      error: 'No se pudieron marcar las notificaciones como leídas'
    })
  }
}

export async function markAllNotificationsReadView(req, res) {
  try {
    const userId = getRequestUserId(req)
    const result = await markAllSystemNotificationsRead({
      userId,
      notifications: getSubmittedNotifications(req)
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error marcando todas las notificaciones como leídas: ${error.message}`)
    res.status(400).json({
      success: false,
      error: 'No se pudieron marcar todas las notificaciones como leídas'
    })
  }
}
