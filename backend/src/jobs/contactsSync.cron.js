import cron from 'node-cron'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { syncHighLevelData, setSyncTriggerSource } from '../services/highlevelSyncService.js'

/**
 * Cron job para sincronizar contactos con HighLevel cada hora
 * Este proceso es SILENCIOSO - no muestra la barra lateral de progreso en el frontend
 */
export function startContactsSyncCron() {
  logger.info('Iniciando cron job de sincronización de contactos (cada hora)')

  // Ejecutar cada hora (minuto 0)
  cron.schedule('0 * * * *', async () => {
    logger.info('Ejecutando sincronización automática de contactos desde HighLevel...')

    try {
      // Obtener configuración de HighLevel
      const config = await db.get(
        'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
      )

      if (!config || !config.location_id || !config.api_token) {
        logger.warn('No hay configuración de HighLevel, saltando sincronización de contactos')
        return
      }

      // IMPORTANTE: Establecer triggerSource como 'cron' para que NO aparezca la barra lateral
      setSyncTriggerSource('cron')

      // Ejecutar sincronización completa (contactos, citas, pagos)
      const result = await syncHighLevelData(config.location_id, config.api_token, 'cron')

      if (result.success) {
        logger.success(
          `✅ Sincronización automática completada: ${result.contacts.saved} contactos, ` +
          `${result.appointments.saved} citas, ${result.payments.saved} pagos`
        )
      } else {
        logger.warn('Sincronización automática terminó con advertencias')
      }
    } catch (error) {
      logger.error('Error en sincronización automática de contactos:', error.message)
    }
  })

  logger.success('Cron job de sincronización de contactos configurado (cada hora a las XX:00)')
}
