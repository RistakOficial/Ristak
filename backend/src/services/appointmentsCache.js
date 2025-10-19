/**
 * Servicio centralizado para cargar y cachear eventos de calendarios
 * Usado por Dashboard, Campaigns y Reports para mejorar performance
 *
 * ATRIBUCIÓN: Solo carga eventos de los calendarios configurados para atribución
 */

import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Obtiene los calendarios configurados para atribución
 * @returns {Promise<string[]>} Array de calendar IDs
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    if (!config || !config.config_value) {
      logger.info('No hay calendarios de atribución configurados - se usarán TODOS los calendarios')
      return null // null = usar todos
    }

    const calendarIds = JSON.parse(config.config_value)
    logger.info(`Calendarios de atribución configurados: ${calendarIds.length}`)
    return calendarIds
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución: ${error.message} - usando TODOS`)
    return null
  }
}

/**
 * Carga eventos de calendarios de atribución configurados
 * Este método es MUCHO más eficiente que verificar contacto por contacto
 *
 * @param {string} locationId - ID del location de HighLevel
 * @param {string} apiToken - Token de acceso de HighLevel
 * @returns {Promise<Set<string>>} Set de contact_ids que tienen citas
 */
export async function loadAllAppointments(locationId, apiToken) {
  try {
    if (!locationId || !apiToken) {
      logger.warn('No se proporcionó locationId o apiToken para cargar citas')
      return new Set()
    }

    // PASO 1: Obtener calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds()

    // PASO 2: Obtener todos los calendarios de HighLevel
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
      return new Set()
    }

    const calendarsData = await calendarsResponse.json()
    let calendars = calendarsData.calendars || []

    // PASO 3: Filtrar por calendarios de atribución (si están configurados)
    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const before = calendars.length
      calendars = calendars.filter(cal => attributionCalendarIds.includes(cal.id))
      logger.info(`Filtrando calendarios: ${before} → ${calendars.length} (solo atribución)`)
    }

    if (calendars.length === 0) {
      logger.info('No se encontraron calendarios activos para atribución')
      return new Set()
    }

    logger.info(`Cargando eventos de ${calendars.length} calendarios`)

    // PASO 2: Cargar eventos de TODOS los calendarios (últimos 10 años + próximos 10 años)
    const now = new Date()
    const past = new Date(now.getFullYear() - 10, 0, 1)
    const future = new Date(now.getFullYear() + 10, 11, 31)

    const contactIdsWithAppointments = new Set()
    let totalEvents = 0

    // Procesar calendarios en paralelo
    const eventPromises = calendars
      .filter(calendar => calendar.isActive)
      .map(async (calendar) => {
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

            // Guardar eventos en DB para cache futuro
            for (const event of events) {
              if (event.contactId) {
                contactIdsWithAppointments.add(event.contactId)
                totalEvents++

                // Guardar en DB (upsert)
                await db.run(`
                  INSERT INTO appointments (id, contact_id, calendar_id, location_id, title, status, start_time, end_time)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    start_time = excluded.start_time,
                    end_time = excluded.end_time
                `, [
                  event.id,
                  event.contactId,
                  event.calendarId || calendar.id,
                  event.locationId || locationId,
                  event.title || '',
                  event.status || 'scheduled',
                  event.startTime || '',
                  event.endTime || ''
                ]).catch(err => {
                  // Ignorar errores de inserción (puede ser que el evento ya exista)
                })
              }
            }

            return events.length
          }

          return 0
        } catch (error) {
          logger.error(`Error cargando eventos del calendario ${calendar.id}: ${error.message}`)
          return 0
        }
      })

    await Promise.all(eventPromises)

    logger.info(`✅ Cargados ${totalEvents} eventos de ${calendars.length} calendarios (${contactIdsWithAppointments.size} contactos únicos)`)

    return contactIdsWithAppointments

  } catch (error) {
    logger.error(`Error en loadAllAppointments: ${error.message}`)
    return new Set()
  }
}

/**
 * Obtiene contact_ids con citas desde DB local + API de HighLevel
 * Usa DB como cache y carga eventos frescos de API
 * FILTRA por calendarios de atribución configurados
 *
 * @param {string} locationId - ID del location de HighLevel
 * @param {string} apiToken - Token de acceso de HighLevel
 * @returns {Promise<Set<string>>} Set de contact_ids que tienen citas
 */
export async function getContactsWithAppointments(locationId, apiToken) {
  try {
    // PASO 1: Obtener calendarios de atribución configurados
    const attributionCalendarIds = await getAttributionCalendarIds()

    // PASO 2: Obtener contactos con citas desde DB (cache) filtrados por calendarios de atribución
    let dbContacts
    if (attributionCalendarIds && attributionCalendarIds.length > 0) {
      const placeholders = attributionCalendarIds.map(() => '?').join(',')
      dbContacts = await db.all(`
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE contact_id IS NOT NULL
          AND calendar_id IN (${placeholders})
      `, attributionCalendarIds)
    } else {
      // Si no hay calendarios configurados, usar todos
      dbContacts = await db.all(`
        SELECT DISTINCT contact_id
        FROM appointments
        WHERE contact_id IS NOT NULL
      `)
    }

    const contactsWithAppointments = new Set(
      dbContacts.map(row => row.contact_id)
    )

    logger.info(`📊 Cache DB (filtrado por atribución): ${contactsWithAppointments.size} contactos con citas`)

    // PASO 2: Actualizar cache con datos frescos de API
    const freshAppointments = await loadAllAppointments(locationId, apiToken)

    // Combinar DB + API
    freshAppointments.forEach(contactId => {
      contactsWithAppointments.add(contactId)
    })

    logger.info(`📊 Total (DB + API): ${contactsWithAppointments.size} contactos con citas`)

    return contactsWithAppointments

  } catch (error) {
    logger.error(`Error en getContactsWithAppointments: ${error.message}`)
    return new Set()
  }
}
