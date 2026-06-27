import { logger } from '../utils/logger.js'
import { syncWebhookCustomValues, getHighLevelConfig } from '../services/webhookSyncService.js'

/**
 * Verifica y actualiza webhooks al iniciar el servidor.
 * Solo se ejecuta en producción (Render) y delega en la fuente única
 * de verdad (webhookSyncService), que crea/actualiza todos los custom
 * values definidos en WEBHOOK_CUSTOM_VALUE_MAP y limpia los obsoletos.
 */
export async function verifyAndUpdateWebhooks() {
  try {
    // Solo ejecutar si estamos en producción (Render)
    if (!process.env.RENDER_EXTERNAL_URL) {
      logger.info('📌 Servidor en desarrollo - webhooks usando localhost')
      return
    }

    logger.info('🚀 Servidor en producción - verificando webhooks...')

    const config = await getHighLevelConfig()
    if (!config?.location_id || !config?.api_token) {
      logger.warn('Sin integración opcional de HighLevel; se omite la verificación de webhooks externos')
      return
    }

    const { results } = await syncWebhookCustomValues({ config })

    const created = results.filter(r => r.status === 'created').length
    const updated = results.filter(r => r.status === 'updated').length
    const errors = results.filter(r => r.status === 'error').length

    logger.info(`✅ Verificación de webhooks completada: ${created} creados, ${updated} actualizados, ${errors} errores`)

  } catch (error) {
    logger.error('❌ Error en verificación de webhooks:', error)
  }
}
