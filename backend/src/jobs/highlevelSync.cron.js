import cron from 'node-cron'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { syncHighLevelData, setSyncTriggerSource } from '../services/highlevelSyncService.js'
import { syncHighLevelConversationHistory } from '../services/highlevelConversationsSyncService.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { withCronLock } from '../utils/cronLock.js'
import { canRunBackgroundJob } from '../services/licenseService.js'

// (GHL-005) El heartbeat renueva los leases mientras el trabajo sigue vivo. Si
// el proceso cae, el lease debe vencer ANTES del siguiente tick; igualarlo al
// intervalo deja una carrera de milisegundos que puede saltarse otro ciclo.
export const HIGHLEVEL_SYNC_LOCK_TTL_MS = 55 * 60 * 1000 // sync completa: cada hora
export const HIGHLEVEL_CONVERSATIONS_LOCK_TTL_MS = 9 * 60 * 1000 // conversaciones: cada 10 min

// (GHL-010) Prueba ligera de que el token tenga acceso a un scope concreto.
// NO rompe la conexión base: solo loguea claramente si el scope falta, para que
// quede registrado por qué la sync de calendarios o conversaciones no traerá nada.
// Un 401/403 indica scope ausente; otros errores (red, 5xx) se reportan pero no
// se interpretan como falta de scope.
async function probeHighLevelScope({ url, apiToken, version, scopeLabel }) {
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Version': version
      }
    })

    if (response.ok) return true

    if (response.status === 401 || response.status === 403) {
      logger.warn(`HighLevel: el token NO tiene acceso al scope de ${scopeLabel} (${response.status}). La sincronización de ${scopeLabel} no traerá datos hasta reconectar con ese permiso.`)
    } else {
      logger.warn(`HighLevel: no se pudo verificar el scope de ${scopeLabel} (${response.status}); se continúa de todos modos.`)
    }
    return false
  } catch (error) {
    logger.warn(`HighLevel: error verificando el scope de ${scopeLabel}: ${error.message}; se continúa de todos modos.`)
    return false
  }
}

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

    // (GHL-010) La conexión base (locations) funciona. Además validamos que el
    // token tenga acceso a calendarios y conversaciones, ya que la sync completa
    // y la sync incremental los necesitan. Si falta alguno, lo dejamos claro en
    // los logs PERO no abortamos: el resto de la sync (contactos, pagos) sí debe
    // correr. Versiones por endpoint consistentes con el resto del código:
    //   /calendars        -> v3 (contrato vigente para listar/crear calendarios)
    //   /conversations    -> 2021-07-28 (versión estándar del cliente, ver GHL-008)
    const calendarsUrl = `${API_URLS.HIGHLEVEL_CALENDARS}?locationId=${encodeURIComponent(locationId)}`
    const conversationsUrl = `${API_URLS.HIGHLEVEL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=1`

    await probeHighLevelScope({ url: calendarsUrl, apiToken, version: 'v3', scopeLabel: 'calendarios' })
    await probeHighLevelScope({ url: conversationsUrl, apiToken, version: '2021-07-28', scopeLabel: 'conversaciones' })

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
// (CRON-008) Guards anti-solape intra-proceso: una sync completa de HighLevel
// (contactos+citas+pagos) puede tardar más que el intervalo de 1h, y la sync
// incremental de conversaciones más que sus 10 min. Si un tick anterior aún
// corre (o un deploy zero-downtime dispara dos veces en el mismo proceso), no
// encimamos otra ejecución de la misma tarea. Mismo patrón que metaSync (META-006).
let highLevelSyncRunning = false
let highLevelConversationsSyncRunning = false
let highLevelSyncTask = null
let highLevelConversationsTask = null

export function startHighLevelSyncCron() {
  if (highLevelSyncTask || highLevelConversationsTask) return
  logger.info('🔄 Iniciando cron job de sincronización completa de HighLevel (cada hora, solo si está conectado)')

  // Ejecutar cada hora (minuto 17) para no competir con el cron de Meta Ads
  highLevelSyncTask = cron.schedule('17 * * * *', async () => {
    if (isDeployShutdownStarted()) return
    try {
      if (!(await canRunBackgroundJob('integrations'))) return
    } catch (error) {
      logger.warn(`No se pudo validar el plan antes de sincronizar HighLevel: ${error.message}`)
      return
    }
    // (CRON-008) Claim intra-proceso antes de actuar.
    if (highLevelSyncRunning) {
      logger.warn('Sincronización automática de HighLevel saltada: ya hay un tick en curso')
      return
    }
    highLevelSyncRunning = true
    logger.info('⏰ Revisando conexión de HighLevel antes de sincronizar...')

    try {
      await trackDeployDrainWork('cron:highlevel-sync', async () => {
       // (GHL-005) Lock global además del guard intra-proceso (CRON-008): si hay
       // varias réplicas, solo una corre la sync completa por hora (evita doble
       // escritura/borrado al sincronizar HL→local). Defensivo con 1 instancia.
       const { ran } = await withCronLock('highlevel-sync', HIGHLEVEL_SYNC_LOCK_TTL_MS, async () => {
        // Obtener configuración de HighLevel
        const config = await db.get(
          'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
        )

        if (!config || !config.location_id || !config.api_token) {
      logger.warn('Sin integración opcional de HighLevel; se omite la sincronización automática externa')
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
       })
       if (!ran) logger.info('Sincronización HighLevel omitida: otra instancia tiene el lock')
      })
    } catch (error) {
      logger.error('❌ Error en sincronización automática de HighLevel:', error.message)
    } finally {
      highLevelSyncRunning = false // (CRON-008)
    }
  })

  logger.success('✅ Cron job de HighLevel configurado (cada hora a las XX:17)')

  // Sincronización incremental de conversaciones (chats) cada 10 minutos.
  // Es ligera: solo pide a HighLevel los mensajes desde el último checkpoint,
  // para que los mensajes entrantes aparezcan en el chat de la app
  // aunque el workflow de webhook no esté configurado en GHL.
  highLevelConversationsTask = cron.schedule('*/10 * * * *', async () => {
    if (isDeployShutdownStarted()) return
    try {
      if (!(await canRunBackgroundJob('integrations')) || !(await canRunBackgroundJob('chat'))) return
    } catch (error) {
      logger.warn(`No se pudo validar el plan antes de sincronizar conversaciones HighLevel: ${error.message}`)
      return
    }
    // (CRON-008) Claim intra-proceso antes de actuar.
    if (highLevelConversationsSyncRunning) {
      logger.warn('Sincronización de conversaciones de HighLevel saltada: ya hay un tick en curso')
      return
    }
    highLevelConversationsSyncRunning = true
    try {
      await trackDeployDrainWork('cron:highlevel-conversations', async () => {
       // (GHL-005) Lock global también para la sync incremental de conversaciones.
       await withCronLock('highlevel-conversations', HIGHLEVEL_CONVERSATIONS_LOCK_TTL_MS, async () => {
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
       })
      })
    } catch (error) {
      logger.warn(`No se pudieron actualizar conversaciones de HighLevel: ${error.message}`)
    } finally {
      highLevelConversationsSyncRunning = false // (CRON-008)
    }
  })

  logger.success('✅ Cron job de conversaciones HighLevel configurado (cada 10 minutos)')
}

export function stopHighLevelSyncCron() {
  for (const task of [highLevelSyncTask, highLevelConversationsTask]) {
    task?.stop()
    task?.destroy?.()
  }
  highLevelSyncTask = null
  highLevelConversationsTask = null
}
