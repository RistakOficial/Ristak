import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Carga appointments desde API de HighLevel
 * @param {string} locationId
 * @param {string} apiToken
 * @param {Array<string>} calendarIds - Calendarios a consultar (opcional)
 * @returns {Promise<Array>} Array de appointments de la API
 */
export async function loadAppointmentsFromAPI(locationId, apiToken, calendarIds = null) {
  try {
    if (!locationId || !apiToken) {
      logger.warn('No se proporcionó locationId o apiToken para cargar citas')
      return []
    }

    // Si no se especifican calendarios, obtener todos
    let calendarsToFetch = []

    if (calendarIds && calendarIds.length > 0) {
      // Obtener solo los calendarios especificados
      const calendarsResponse = await fetch(
        `https://services.leadconnectorhq.com/calendars/?locationId=${locationId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Version': '2021-07-28'
          }
        }
      )

      if (!calendarsResponse.ok) {
        logger.error('Error al obtener calendarios de HighLevel')
        return []
      }

      const calendarsData = await calendarsResponse.json()
      calendarsToFetch = (calendarsData.calendars || []).filter(cal =>
        calendarIds.includes(cal.id) && cal.isActive
      )
    } else {
      // Obtener todos los calendarios activos
      const calendarsResponse = await fetch(
        `https://services.leadconnectorhq.com/calendars/?locationId=${locationId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Version': '2021-07-28'
          }
        }
      )

      if (!calendarsResponse.ok) {
        logger.error('Error al obtener calendarios de HighLevel')
        return []
      }

      const calendarsData = await calendarsResponse.json()
      calendarsToFetch = (calendarsData.calendars || []).filter(cal => cal.isActive)
    }

    if (calendarsToFetch.length === 0) {
      logger.info('No se encontraron calendarios activos')
      return []
    }

    // Cargar eventos de todos los calendarios
    const now = new Date()
    const past = new Date(now.getFullYear() - 10, 0, 1)
    const future = new Date(now.getFullYear() + 10, 11, 31)

    const allAppointments = []

    for (const calendar of calendarsToFetch) {
      try {
        const eventsResponse = await fetch(
          `https://services.leadconnectorhq.com/calendars/events?` +
          `locationId=${locationId}` +
          `&startTime=${past.getTime()}` +
          `&endTime=${future.getTime()}` +
          `&calendarId=${calendar.id}`,
          {
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Version': '2021-07-28'
            }
          }
        )

        if (eventsResponse.ok) {
          const eventsData = await eventsResponse.json()
          const events = eventsData.events || []

          events.forEach(event => {
            if (event.contactId) {
              allAppointments.push({
                id: event.id,
                contactId: event.contactId,
                calendarId: event.calendarId || calendar.id,
                locationId: event.locationId || locationId,
                title: event.title || '',
                status: event.status || 'scheduled',
                startTime: event.startTime,
                endTime: event.endTime,
                dateAdded: event.dateAdded || event.createdAt || event.createdOn || event.startTime,
                dateUpdated: event.dateUpdated || event.updatedAt || event.updatedOn,
                source: 'api'
              })
            }
          })
        }
      } catch (error) {
        logger.warn(`Error cargando eventos del calendario ${calendar.id}: ${error.message}`)
      }
    }

    logger.info(`📡 API GHL: ${allAppointments.length} citas cargadas`)
    return allAppointments

  } catch (error) {
    logger.error(`Error en loadAppointmentsFromAPI: ${error.message}`)
    return []
  }
}

/**
 * Carga appointments desde la base de datos local (webhook histórico)
 * @param {Object} filters - Filtros opcionales
 * @returns {Promise<Array>} Array de appointments de la DB
 */
export async function loadAppointmentsFromDB(filters = {}) {
  try {
    const conditions = []
    const params = []

    if (filters.contactId) {
      conditions.push('contact_id = ?')
      params.push(filters.contactId)
    }

    if (filters.calendarIds && filters.calendarIds.length > 0) {
      const placeholders = filters.calendarIds.map(() => '?').join(',')
      conditions.push(`calendar_id IN (${placeholders})`)
      params.push(...filters.calendarIds)
    }

    if (filters.startDate) {
      conditions.push('date_added >= ?')
      params.push(filters.startDate)
    }

    if (filters.endDate) {
      conditions.push('date_added <= ?')
      params.push(filters.endDate)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const query = `
      SELECT
        id,
        contact_id as "contactId",
        calendar_id as "calendarId",
        location_id as "locationId",
        title,
        status,
        start_time as "startTime",
        end_time as "endTime",
        date_added as "dateAdded",
        date_updated as "dateUpdated"
      FROM appointments
      ${whereClause}
    `

    const dbAppointments = await db.all(query, params)

    // Agregar source
    const appointments = dbAppointments.map(apt => ({
      ...apt,
      source: 'db'
    }))

    logger.info(`💾 DB local: ${appointments.length} citas cargadas`)
    return appointments

  } catch (error) {
    logger.error(`Error en loadAppointmentsFromDB: ${error.message}`)
    return []
  }
}

/**
 * Combina appointments de DB y API con deduplicación inteligente
 * @param {Array} dbAppointments - Appointments de la DB
 * @param {Array} apiAppointments - Appointments de la API
 * @param {string} strategy - Estrategia de merge: 'oldest_date', 'latest_status', 'complete'
 * @returns {Array} Array combinado y deduplicado
 */
export function mergeAppointments(dbAppointments, apiAppointments, strategy = 'oldest_date') {
  const merged = new Map()

  // PASO 1: Agregar todos de DB
  dbAppointments.forEach(apt => {
    merged.set(apt.id, { ...apt, source: 'db' })
  })

  // PASO 2: Agregar/actualizar con los de API según estrategia
  apiAppointments.forEach(apt => {
    const existing = merged.get(apt.id)

    if (!existing) {
      // No existe en DB, agregar de API
      merged.set(apt.id, { ...apt, source: 'api' })
    } else {
      // Ya existe, aplicar estrategia de merge
      let mergedData = { ...existing }

      if (strategy === 'oldest_date') {
        // Tomar dateAdded más antiguo, pero status de API
        mergedData = {
          ...existing,
          dateAdded: existing.dateAdded < apt.dateAdded ? existing.dateAdded : apt.dateAdded,
          status: apt.status, // Status de API (más fresco)
          startTime: apt.startTime, // Por si fue reprogramada
          endTime: apt.endTime,
          dateUpdated: apt.dateUpdated,
          source: 'both'
        }
      } else if (strategy === 'latest_status') {
        // Tomar todo de API (más actualizado)
        mergedData = { ...apt, source: 'both' }
      } else if (strategy === 'complete') {
        // Mantener lo más completo de ambos
        mergedData = {
          id: existing.id,
          contactId: existing.contactId || apt.contactId,
          calendarId: existing.calendarId || apt.calendarId,
          locationId: existing.locationId || apt.locationId,
          title: apt.title || existing.title, // Título de API (puede haber cambiado)
          status: apt.status || existing.status, // Status de API
          startTime: apt.startTime || existing.startTime, // Fecha de API (puede haber sido reprogramada)
          endTime: apt.endTime || existing.endTime,
          dateAdded: existing.dateAdded < apt.dateAdded ? existing.dateAdded : apt.dateAdded, // Más antiguo
          dateUpdated: apt.dateUpdated || existing.dateUpdated, // Más reciente
          source: 'both'
        }
      }

      merged.set(apt.id, mergedData)
    }
  })

  const result = Array.from(merged.values())
  logger.info(`🔀 Merge completado: ${dbAppointments.length} DB + ${apiAppointments.length} API = ${result.length} únicos (${result.filter(a => a.source === 'both').length} en ambos)`)

  return result
}

/**
 * Obtiene contact_ids únicos con appointments (DB + API deduplicado)
 * @param {string} locationId
 * @param {string} apiToken
 * @param {Array<string>} calendarIds - Calendarios de atribución
 * @returns {Promise<Set<string>>} Set de contact_ids con citas
 */
export async function getContactsWithAppointmentsHybrid(locationId, apiToken, calendarIds = null) {
  try {
    // Cargar de ambas fuentes en paralelo
    const [dbAppointments, apiAppointments] = await Promise.all([
      loadAppointmentsFromDB({ calendarIds }),
      loadAppointmentsFromAPI(locationId, apiToken, calendarIds)
    ])

    // Combinar con deduplicación
    const merged = mergeAppointments(dbAppointments, apiAppointments, 'oldest_date')

    // Extraer contact_ids únicos
    const contactIds = new Set(merged.map(apt => apt.contactId))

    logger.info(`👥 Total contactos con citas (híbrido): ${contactIds.size}`)
    return contactIds

  } catch (error) {
    logger.error(`Error en getContactsWithAppointmentsHybrid: ${error.message}`)
    return new Set()
  }
}
