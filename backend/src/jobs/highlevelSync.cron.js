import cron from 'node-cron'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { syncHighLevelData, setSyncTriggerSource } from '../services/highlevelSyncService.js'
import { syncHighLevelConversationHistory } from '../services/highlevelConversationsSyncService.js'

async function isHighLevelConnected(config) {
  const locationId = String(config?.location_id || '').trim()
  const apiToken = String(config?.api_token || '').trim().replace(/[\r\n\t]/g, '')

  if (!locationId || !apiToken) return false

  try {
    const response = await fetch(API_URLS.HIGHLEVEL_LOCATIONS(locationId), {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': '2021-07-28'
      }
    })

    if (!response.ok) {
      logger.warn(`HighLevel no está conectado (${response.status}), saltando sincronización automática`)
      return false
    }

    return true
  } catch (error) {
    logger.warn(`No se pudo verificar conexión con HighLevel, saltando sincronización automática: ${error.message}`)
    return false
  }
}

/**
 * Cron job para sincronizar TODOS los datos de HighLevel cada hora
 * Sincroniza: Contactos, Citas (Appointments), Pagos (Invoices/Transacciones)
 *
 * Este proceso es SILENCIOSO - no muestra la barra lateral de progreso en el frontend
 * Mantiene la DB actualizada automáticamente en caso de cambios externos,
 * solo cuando HighLevel sigue conectado.
 */
export function startHighLevelSyncCron() {
  logger.info('🔄 Iniciando cron job de sincronización completa de HighLevel (cada hora, solo si está conectado)')

  // Ejecutar cada hora (minuto 17) para no competir con el cron de Meta Ads
  cron.schedule('17 * * * *', async () => {
    logger.info('⏰ Revisando conexión de HighLevel antes de sincronizar...')

    try {
      // Obtener configuración de HighLevel
      const config = await db.get(
        'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
      )

      if (!config || !config.location_id || !config.api_token) {
        logger.warn('⚠️  No hay configuración de HighLevel, saltando sincronización')
        return
      }

      const connected = await isHighLevelConnected(config)
      if (!connected) {
        return
      }

      logger.info('⏰ Ejecutando sincronización automática de HighLevel (contactos, citas, pagos)...')

      // IMPORTANTE: Establecer triggerSource como 'cron' para que NO aparezca la barra lateral
      setSyncTriggerSource('cron')

      // Ejecutar sincronización completa (contactos, citas, pagos/invoices)
      const result = await syncHighLevelData(config.location_id, config.api_token, 'cron')

      if (result.success) {
        logger.success(
          `✅ Sincronización HighLevel completada: ` +
          `${result.contacts.saved} contactos, ` +
          `${result.appointments.saved} citas, ` +
          `${result.products?.pulled?.savedProducts || 0} productos GHL→Ristak, ` +
          `${result.payments.saved} pagos/invoices`
        )
      } else {
        logger.warn('⚠️  Sincronización HighLevel terminó con advertencias')
      }
    } catch (error) {
      logger.error('❌ Error en sincronización automática de HighLevel:', error.message)
    }
  })

  logger.success('✅ Cron job de HighLevel configurado (cada hora a las XX:17)')

  // Sincronización incremental de conversaciones (chats) cada 10 minutos.
  // Es ligera: solo pide a HighLevel los mensajes desde el último checkpoint,
  // para que los mensajes entrantes aparezcan en el chat de la app
  // aunque el workflow de webhook no esté configurado en GHL.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const config = await db.get(
        'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
      )

      if (!config || !config.location_id || !config.api_token) {
        return
      }

      const result = await syncHighLevelConversationHistory({
        locationId: config.location_id,
        apiToken: String(config.api_token).trim().replace(/[\r\n\t]/g, ''),
        fullSync: false,
        notifyNewInbound: true
      })

      if (result.saved > 0) {
        logger.info(`💬 Chats HighLevel actualizados: ${result.saved} mensajes nuevos/actualizados`)
      }
    } catch (error) {
      logger.warn(`No se pudieron actualizar conversaciones de HighLevel: ${error.message}`)
    }
  })

  logger.success('✅ Cron job de conversaciones HighLevel configurado (cada 10 minutos)')
}
