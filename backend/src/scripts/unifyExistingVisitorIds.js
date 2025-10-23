/**
 * Script de migración: Unifica visitor_ids de contactos existentes
 *
 * Problema que resuelve:
 * - Usuarios que visitaron desde múltiples dispositivos/navegadores tienen múltiples visitor_ids
 * - Esto infla las métricas de visitantes únicos
 *
 * Lo que hace este script:
 * 1. Encuentra todos los contactos con sesiones
 * 2. Para cada contacto, unifica sus visitor_ids al más viejo (primera visita)
 * 3. Actualiza la tabla sessions y contacts
 *
 * Uso:
 *   node backend/src/scripts/unifyExistingVisitorIds.js
 */

import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { unifyVisitorIds } from '../services/trackingService.js'

async function runMigration() {
  try {
    logger.info('🚀 Iniciando migración de visitor_ids...')

    // PASO 1: Obtener todos los contactos que tienen sesiones
    const contacts = await db.all(`
      SELECT DISTINCT contact_id
      FROM sessions
      WHERE contact_id IS NOT NULL
      ORDER BY contact_id
    `)

    if (contacts.length === 0) {
      logger.info('✅ No hay contactos con sesiones para migrar')
      process.exit(0)
    }

    logger.info(`📊 Encontrados ${contacts.length} contactos con sesiones`)

    // PASO 2: Para cada contacto, verificar si tiene múltiples visitor_ids
    let contactsWithMultipleVisitors = 0
    let totalSessionsUnified = 0

    for (const { contact_id } of contacts) {
      // Contar visitor_ids únicos por contacto
      const visitorCount = await db.get(`
        SELECT COUNT(DISTINCT visitor_id) as count
        FROM sessions
        WHERE contact_id = ?
      `, [contact_id])

      if (visitorCount.count > 1) {
        contactsWithMultipleVisitors++
        logger.info(`🔄 Contacto ${contact_id} tiene ${visitorCount.count} visitor_ids diferentes, unificando...`)

        try {
          const result = await unifyVisitorIds(contact_id)
          if (result.success) {
            totalSessionsUnified += result.sessionsUpdated
            logger.info(`   ✅ ${result.sessionsUpdated} sesiones unificadas con visitor_id: ${result.canonicalVisitorId}`)
          }
        } catch (error) {
          logger.error(`   ❌ Error unificando contacto ${contact_id}:`, error.message)
        }
      }
    }

    // PASO 3: Resumen
    logger.info('\n' + '='.repeat(60))
    logger.success('✅ Migración completada!')
    logger.info(`📊 Estadísticas:`)
    logger.info(`   - Contactos totales con sesiones: ${contacts.length}`)
    logger.info(`   - Contactos con múltiples visitor_ids: ${contactsWithMultipleVisitors}`)
    logger.info(`   - Sesiones unificadas: ${totalSessionsUnified}`)
    logger.info('='.repeat(60))

    process.exit(0)
  } catch (error) {
    logger.error('❌ Error en migración:', error)
    process.exit(1)
  }
}

// Ejecutar migración
runMigration()
