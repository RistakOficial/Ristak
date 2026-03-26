import cron from 'node-cron'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { syncHighLevelData, setSyncTriggerSource } from '../services/highlevelSyncService.js'

/**
 * Cron job para sincronizar TODOS los datos de HighLevel cada hora
 * Sincroniza: Contactos, Citas (Appointments), Pagos (Invoices/Transacciones)
 *
 * Este proceso es SILENCIOSO - no muestra la barra lateral de progreso en el frontend
 * Mantiene la DB actualizada automáticamente en caso de cambios externos
 */
export function startHighLevelSyncCron() {
  logger.info('🔄 Iniciando cron job de sincronización completa de HighLevel (cada hora)')

  // Ejecutar cada hora (minuto 17) para no competir con el cron de Meta Ads
  cron.schedule('17 * * * *', async () => {
    logger.info('⏰ Ejecutando sincronización automática de HighLevel (contactos, citas, pagos)...')

    try {
      // Obtener configuración de HighLevel
      const config = await db.get(
        'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
      )

      if (!config || !config.location_id || !config.api_token) {
        logger.warn('⚠️  No hay configuración de HighLevel, saltando sincronización')
        return
      }

      // IMPORTANTE: Establecer triggerSource como 'cron' para que NO aparezca la barra lateral
      setSyncTriggerSource('cron')

      // Ejecutar sincronización completa (contactos, citas, pagos/invoices)
      const result = await syncHighLevelData(config.location_id, config.api_token, 'cron')

      if (result.success) {
        logger.success(
          `✅ Sincronización HighLevel completada: ` +
          `${result.contacts.saved} contactos, ` +
          `${result.appointments.saved} citas, ` +
          `${result.payments.saved} pagos/invoices`
        )
      } else {
        logger.warn('⚠️  Sincronización HighLevel terminó con advertencias')
      }
    } catch (error) {
      logger.error('❌ Error en sincronización automática de HighLevel:', error.message)
    }
  })

  logger.success('✅ Cron job de HighLevel configurado (cada hora a las XX:00)')
}
