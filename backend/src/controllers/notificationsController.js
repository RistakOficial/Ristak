import { getSystemNotifications } from '../services/notificationsService.js'
import { logger } from '../utils/logger.js'

export async function getNotificationsView(req, res) {
  try {
    const liveMetaCheck = String(req.query?.liveMetaCheck ?? '1') !== '0'
    const limit = Number(req.query?.limit || 30)
    const userId = req.user?.userId || req.user?.id || null
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
