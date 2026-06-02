import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'
import { resolveDateRange, resolveDateRangeWithGHLTimezone } from '../utils/dateUtils.js'
import { buildContactStats } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { buildContactSearchClause, buildContactSearchRank } from '../utils/searchText.js'
import {
  buildHighLevelCustomFieldsPayload,
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'
import fetch from 'node-fetch'

const normalizePhone = (phone) => {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length < 7) return null
  return digits.slice(-10)
}

const dedupeAppointments = (appointments = []) => {
  const map = new Map()
  for (const appointment of appointments) {
    if (!appointment) continue
    const key = appointment.id || `${appointment.start_time || ''}-${appointment.title || ''}`
    if (!map.has(key)) {
      map.set(key, appointment)
    }
  }
  return Array.from(map.values())
}

const APPOINTMENT_CANCELED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'no_show',
  'noshow',
  'failed',
  'missed'
])

/**
 * Obtiene todos los contactos con paginación y filtros
 */
export const getContacts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = '',
      sortBy = 'created_at',
      sortOrder = 'DESC',
      startDate,
      endDate
    } = req.query

    const pageNumber = Number(page) || 1
    const limitNumber = Math.min(Number(limit) || 50, 500)
    const offset = Math.max((pageNumber - 1) * limitNumber, 0)

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo contactos - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    // Query base
    const params = []

    // Construir WHERE clause para filtros (para COUNT query - sin alias)
    const conditions = []

    if (search) {
      const searchClause = buildContactSearchClause('contacts', search)
      conditions.push(searchClause.condition)
      params.push(...searchClause.params)
    }

    if (range.startUtc) {
      conditions.push('created_at >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('created_at <= ?')
      params.push(range.endUtc)
    }

    // Aplicar filtro de contactos ocultos (para COUNT - sin alias)
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)
    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Obtener el total de contactos
    const countQuery = `SELECT COUNT(*) as total FROM contacts ${whereClause}`
    const countResult = await db.get(countQuery, params)
    const totalContacts = countResult.total

    // Construir WHERE clause para query principal (con alias 'c')
    const mainConditions = []

    if (search) {
      mainConditions.push(buildContactSearchClause('c', search).condition)
    }

    if (range.startUtc) {
      mainConditions.push('c.created_at >= ?')
    }

    if (range.endUtc) {
      mainConditions.push('c.created_at <= ?')
    }

    // Aplicar filtro de contactos ocultos (con alias 'c')
    const hiddenConditionAlias = buildHiddenContactsCondition(hiddenFilters, 'c', false)
    if (hiddenConditionAlias) {
      mainConditions.push(hiddenConditionAlias)
    }

    const mainWhereClause = mainConditions.length > 0 ? `WHERE ${mainConditions.join(' AND ')}` : ''

    // Obtener los contactos
    const sortableColumns = new Set([
      'created_at',
      'full_name',
      'email',
      'phone',
      'total_paid',
      'purchases_count'
    ])
    const safeSortBy = sortableColumns.has(sortBy) ? sortBy : 'created_at'
    const orderDirection = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'

    const searchRank = search ? buildContactSearchRank('c', search) : null
    const orderBy = searchRank
      ? `${searchRank.expression} DESC, ${safeSortBy} ${orderDirection}`
      : `${safeSortBy} ${orderDirection}`

    const contactsQuery = `
      WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
        FROM payments
        GROUP BY contact_id
      )
      SELECT
        c.id,
        c.phone,
        c.email,
        c.full_name,
        c.first_name,
        c.last_name,
        c.source,
        c.visitor_id,
        c.attribution_ad_name,
        c.attribution_ad_id,
        c.custom_fields,
        COALESCE(ps.total_paid, c.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, c.purchases_count, 0) AS purchases_count,
        COALESCE(ps.last_purchase_date, c.last_purchase_date) AS last_purchase_date,
        c.appointment_date,
        c.created_at,
        (SELECT COUNT(*) > 0 FROM appointments WHERE contact_id = c.id) AS has_appointments,
        (
          COALESCE(ps.purchases_count, c.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND LOWER(COALESCE(appointment_status, status, '')) = 'showed'
          )
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      ${mainWhereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `

    const contactsParams = [...params, ...(searchRank?.params ?? []), limitNumber, offset]
    const contacts = await db.all(contactsQuery, contactsParams)

    const firstSessionsByContact = new Map()
    const firstSessionsByVisitor = new Map()
    const firstSessionsByEmail = new Map()
    const contactIds = Array.from(new Set(contacts.map(c => c.id).filter(Boolean)))
    const visitorIds = Array.from(new Set(contacts.map(c => c.visitor_id).filter(Boolean)))
    const emails = Array.from(new Set(
      contacts
        .map(c => c.email)
        .filter(Boolean)
        .map(email => String(email).toLowerCase())
    ))

    if (contactIds.length > 0 || visitorIds.length > 0 || emails.length > 0) {
      const sessionConditions = []
      const sessionParams = []

      const addInCondition = (field, values) => {
        if (!values.length) return
        sessionConditions.push(`${field} IN (${values.map(() => '?').join(', ')})`)
        sessionParams.push(...values)
      }

      addInCondition('contact_id', contactIds)
      addInCondition('visitor_id', visitorIds)
      addInCondition('LOWER(email)', emails)

      const firstSessions = await db.all(`
        SELECT
          id,
          contact_id,
          visitor_id,
          email,
          started_at,
          created_at,
          page_url,
          referrer_url,
          utm_source,
          utm_medium,
          utm_campaign,
          utm_content,
          utm_term,
          source_platform,
          site_source_name,
          campaign_name,
          adset_name,
          ad_name,
          ad_id,
          device_type,
          browser,
          os,
          placement,
          geo_city,
          geo_region,
          geo_country
        FROM sessions
        WHERE ${sessionConditions.join(' OR ')}
        ORDER BY started_at ASC, created_at ASC, id ASC
      `, sessionParams)

      firstSessions.forEach(session => {
        if (session.contact_id && !firstSessionsByContact.has(session.contact_id)) {
          firstSessionsByContact.set(session.contact_id, session)
        }
        if (session.visitor_id && !firstSessionsByVisitor.has(session.visitor_id)) {
          firstSessionsByVisitor.set(session.visitor_id, session)
        }
        if (session.email) {
          const emailKey = String(session.email).toLowerCase()
          if (!firstSessionsByEmail.has(emailKey)) {
            firstSessionsByEmail.set(emailKey, session)
          }
        }
      })
    }

    const getFirstSessionForContact = (contact) =>
      firstSessionsByContact.get(contact.id) ||
      (contact.visitor_id ? firstSessionsByVisitor.get(contact.visitor_id) : null) ||
      (contact.email ? firstSessionsByEmail.get(String(contact.email).toLowerCase()) : null) ||
      null

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contacts.map(c => {
      const firstSession = getFirstSessionForContact(c)

      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: c.full_name || '',
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_purchase_date,
        purchases: c.purchases_count || 0,
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        source: c.source,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
        customFields: parseContactCustomFields(c.custom_fields),
        firstSession: firstSession ? {
          started_at: firstSession.started_at,
          page_url: firstSession.page_url,
          landing_page: firstSession.page_url,
          referrer_url: firstSession.referrer_url,
          utm_source: firstSession.utm_source,
          utm_medium: firstSession.utm_medium,
          utm_campaign: firstSession.utm_campaign,
          utm_content: firstSession.utm_content,
          utm_term: firstSession.utm_term,
          source_platform: firstSession.source_platform,
          site_source_name: firstSession.site_source_name,
          campaign_name: firstSession.campaign_name,
          adset_name: firstSession.adset_name,
          ad_name: firstSession.ad_name,
          ad_id: firstSession.ad_id,
          device_type: firstSession.device_type,
          browser: firstSession.browser,
          os: firstSession.os,
          placement: firstSession.placement,
          geo_city: firstSession.geo_city,
          geo_region: firstSession.geo_region,
          geo_country: firstSession.geo_country
        } : null,
        notes: ''
      }
    })

    // Calcular información de paginación
    const totalPages = Math.ceil(totalContacts / limitNumber)

    logger.debug(
      `Contactos obtenidos (${rangeLabel}) -> ${contacts.length} registros en esta página, ${totalContacts} total`
    )

    res.json({
      success: true,
      data: mappedContacts,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total: totalContacts,
        totalPages,
        hasNext: pageNumber < totalPages,
        hasPrev: pageNumber > 1
      }
    })

  } catch (error) {
    logger.error(`Error obteniendo contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo contactos'
    })
  }
}

/**
 * Obtiene un contacto por ID
 */
export const getContactById = async (req, res) => {
  try {
    const { id } = req.params

    const contact = await db.get(
      `WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
        FROM payments
        WHERE contact_id = ?
        GROUP BY contact_id
      )
      SELECT
        c.id,
        c.phone,
        c.email,
        c.full_name,
        c.first_name,
        c.last_name,
        c.source,
        c.visitor_id,
        c.attribution_ad_name,
        c.attribution_ad_id,
        COALESCE(ps.total_paid, c.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, c.purchases_count, 0) AS purchases_count,
        COALESCE(ps.last_purchase_date, c.last_purchase_date) AS last_purchase_date,
        c.appointment_date,
        c.created_at,
        (SELECT COUNT(*) > 0 FROM appointments WHERE contact_id = c.id) AS has_appointments,
        (
          COALESCE(ps.purchases_count, c.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND LOWER(COALESCE(appointment_status, status, '')) = 'showed'
          )
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE c.id = ?`,
      [id, id]
    )

    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Obtener pagos del contacto
    const payments = await db.all(
      `SELECT * FROM payments
       WHERE contact_id = ?
       ORDER BY date DESC`,
      [id]
    )

    // IMPORTANTE: Estrategia de obtención de citas (DB first, API as fallback)
    // 1. Primero consultamos la DB local (tabla appointments) - respuesta inmediata
    // 2. Si hay configuración de HighLevel, hacemos fallback a API en tiempo real
    // 3. Las citas nuevas de la API se guardan en DB para cache futuro
    // Esto garantiza mejor performance y resiliencia (funciona offline)
    let appointments = await db.all(
      `SELECT * FROM appointments
       WHERE contact_id = ?
       ORDER BY start_time DESC`,
      [id]
    )

    // Fallback: Intentar obtener citas de HighLevel API en tiempo real
    // Solo si no tenemos citas localmente o queremos actualizar con datos frescos
    try {
      // Obtener configuración de HighLevel
      const config = await db.get(
        'SELECT location_id, api_token FROM highlevel_config LIMIT 1'
      )

      if (config && config.api_token) {
        logger.info(`Obteniendo citas de HighLevel para contacto ${id}`)

        // Usar el endpoint correcto: /contacts/{contactId}/appointments
        const eventsResponse = await fetch(
          `https://services.leadconnectorhq.com/contacts/${id}/appointments`,
          {
            headers: {
              'Authorization': `Bearer ${config.api_token}`,
              'Version': '2021-07-28'
            }
          }
        )

        if (eventsResponse.ok) {
          const eventsData = await eventsResponse.json()

          if (eventsData.events && eventsData.events.length > 0) {
            logger.info(`Encontradas ${eventsData.events.length} citas en HighLevel para contacto ${id}`)

            // Guardar las citas en la DB para cache
            for (const appointment of eventsData.events) {
              await db.run(`
                INSERT INTO appointments (
                  id, calendar_id, contact_id, location_id, title,
                  status, appointment_status, assigned_user_id, notes,
                  address, start_time, end_time, date_added, date_updated
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                  title = excluded.title,
                  status = excluded.status,
                  appointment_status = excluded.appointment_status,
                  start_time = excluded.start_time,
                  end_time = excluded.end_time,
                  date_updated = excluded.date_updated
              `, [
                appointment.id,
                appointment.calendarId,
                appointment.contactId,
                appointment.locationId || config.location_id,
                appointment.title || '(Sin título)',
                appointment.status,
                appointment.appointmentStatus,
                appointment.assignedUserId,
                appointment.notes,
                appointment.address,
                appointment.startTime ? new Date(appointment.startTime) : null,
                appointment.endTime ? new Date(appointment.endTime) : null,
                appointment.dateAdded ? new Date(appointment.dateAdded) : new Date(),
                new Date()
              ])
            }

            // Combinar con las citas locales (evitando duplicados)
            const appointmentIds = new Set(appointments.map(a => a.id))
            for (const appointment of eventsData.events) {
              if (!appointmentIds.has(appointment.id)) {
                appointments.push({
                  id: appointment.id,
                  calendar_id: appointment.calendarId,
                  contact_id: appointment.contactId,
                  title: appointment.title,
                  status: appointment.status,
                  appointment_status: appointment.appointmentStatus,
                  assigned_user_id: appointment.assignedUserId,
                  notes: appointment.notes,
                  address: appointment.address,
                  start_time: appointment.startTime,
                  end_time: appointment.endTime
                })
              }
            }

            logger.info(`Total de citas después de combinar: ${appointments.length}`)
          } else {
            logger.info(`No se encontraron citas en HighLevel para contacto ${id}`)
          }
        } else {
          const errorText = await eventsResponse.text()
          logger.warn(`Error obteniendo citas de HighLevel: ${eventsResponse.status} - ${errorText.substring(0, 100)}`)
        }
      }
    } catch (error) {
      logger.warn(`No se pudieron obtener citas de HighLevel para contacto ${id}: ${error.message}`)
      // Continuar con las citas locales si falla HighLevel
    }

    const normalizedPhone = normalizePhone(contact.phone)
    let relatedContactIds = []

    if (normalizedPhone) {
      const relatedContacts = await db.all(
        `SELECT id, phone
         FROM contacts
         WHERE id != ?
           AND phone IS NOT NULL
           AND phone != ''
           AND phone LIKE ?`,
        [id, `%${normalizedPhone}`]
      )

      relatedContactIds = relatedContacts
        .filter(row => normalizePhone(row.phone) === normalizedPhone)
        .map(row => row.id)
    }

    if (relatedContactIds.length > 0) {
      const placeholders = relatedContactIds.map(() => '?').join(', ')
      const relatedAppointments = await db.all(
        `SELECT *
         FROM appointments
         WHERE contact_id IN (${placeholders})
         ORDER BY start_time DESC`,
        relatedContactIds
      )
      appointments = appointments.concat(relatedAppointments)
    }

    const dedupedAppointments = dedupeAppointments(appointments)
    const sortedAppointmentsAsc = [...dedupedAppointments].sort((a, b) =>
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    )

    // Calcular primera cita y próxima cita
    let firstAppointmentDate = null
    let nextAppointmentDate = null

    if (sortedAppointmentsAsc.length > 0) {
      firstAppointmentDate = sortedAppointmentsAsc[0].start_time

      const now = new Date()
      const futureAppointments = sortedAppointmentsAsc.filter(apt => {
        if (!apt?.start_time) return false
        const aptDate = new Date(apt.start_time)
        if (Number.isNaN(aptDate.getTime()) || aptDate <= now) {
          return false
        }
        const statusValue = String(apt.appointment_status || apt.status || '').toLowerCase()
        return !APPOINTMENT_CANCELED_STATUSES.has(statusValue)
      })

      if (futureAppointments.length > 0) {
        nextAppointmentDate = futureAppointments[0].start_time
      }
    }

    const appointmentsOrdered = dedupedAppointments.sort((a, b) =>
      new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
    )
    const hasShowedAppointment =
      Boolean(contact.has_showed_appointment) ||
      appointmentsOrdered.some(appointment =>
        String(appointment.appointment_status || appointment.status || '').trim().toLowerCase() === 'showed'
      )

    // Determinar status basado en la actividad del contacto
    let status = 'lead'
    if (contact.purchases_count > 0) {
      status = 'customer'
    } else if (contact.has_appointments) {
      status = 'appointment'
    }

    // Obtener primera sesión (primera atribución/primer toque) del contacto
    let firstSession = null
    try {
      // Buscar por contact_id, visitor_id o email
      let sessionQuery = `
        SELECT *
        FROM sessions
        WHERE contact_id = ?
        ORDER BY started_at ASC
        LIMIT 1
      `
      firstSession = await db.get(sessionQuery, [id])

      // Fallback: buscar por visitor_id si existe
      if (!firstSession && contact.visitor_id) {
        sessionQuery = `
          SELECT *
          FROM sessions
          WHERE visitor_id = ?
          ORDER BY started_at ASC
          LIMIT 1
        `
        firstSession = await db.get(sessionQuery, [contact.visitor_id])
      }

      // Fallback: buscar por email si existe
      if (!firstSession && contact.email) {
        sessionQuery = `
          SELECT *
          FROM sessions
          WHERE email = ?
          ORDER BY started_at ASC
          LIMIT 1
        `
        firstSession = await db.get(sessionQuery, [contact.email])
      }
    } catch (error) {
      logger.warn(`No se pudo obtener primera sesión para contacto ${id}: ${error.message}`)
    }

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContact = {
      id: contact.id,
      createdAt: contact.created_at,
      name: contact.full_name || '',
      email: contact.email || '',
      phone: contact.phone || '',
      ltv: parseFloat(contact.total_paid || 0),
      status,
      lastPurchase: contact.last_purchase_date,
      purchases: contact.purchases_count || 0,
      source: contact.source,
      ad_name: contact.attribution_ad_name,
      ad_id: contact.attribution_ad_id,
      customFields: parseContactCustomFields(contact.custom_fields),
      notes: '',
      payments,
      appointments: appointmentsOrdered,
      firstAppointmentDate,
      nextAppointmentDate,
      hasShowedAppointment,
      hasAttendedAppointment: hasShowedAppointment,
      firstSession: firstSession ? {
        started_at: firstSession.started_at,
        page_url: firstSession.page_url,
        landing_page: firstSession.landing_page,
        referrer_url: firstSession.referrer_url,
        utm_source: firstSession.utm_source,
        utm_medium: firstSession.utm_medium,
        utm_campaign: firstSession.utm_campaign,
        utm_content: firstSession.utm_content,
        utm_term: firstSession.utm_term,
        source_platform: firstSession.source_platform,
        site_source_name: firstSession.site_source_name,
        campaign_name: firstSession.campaign_name,
        adset_name: firstSession.adset_name,
        ad_name: firstSession.ad_name,
        ad_id: firstSession.ad_id,
        device_type: firstSession.device_type,
        browser: firstSession.browser,
        os: firstSession.os,
        placement: firstSession.placement,
        geo_city: firstSession.geo_city,
        geo_region: firstSession.geo_region,
        geo_country: firstSession.geo_country
      } : null
    }

    res.json({
      success: true,
      data: mappedContact
    })

  } catch (error) {
    logger.error(`Error obteniendo contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo contacto'
    })
  }
}

/**
 * Busca contactos por término de búsqueda
 */
export const searchContacts = async (req, res) => {
  try {
    const { q } = req.query

    if (!q) {
      return res.json({
        success: true,
        data: []
      })
    }

    const searchClause = buildContactSearchClause('c', q)
    const searchRank = buildContactSearchRank('c', q)

    const contacts = await db.all(
      `WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                AND ${nonTestPaymentCondition()}
                THEN date ELSE NULL END) AS last_purchase_date
        FROM payments
        GROUP BY contact_id
      )
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.phone,
        COALESCE(ps.total_paid, c.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, c.purchases_count, 0) AS purchases_count,
        c.appointment_date,
        COALESCE(ps.last_purchase_date, c.last_purchase_date) AS last_purchase_date,
        c.created_at,
        c.source,
        c.attribution_ad_name,
        c.attribution_ad_id,
        (SELECT COUNT(*) > 0 FROM appointments WHERE contact_id = c.id) AS has_appointments,
        (
          COALESCE(ps.purchases_count, c.purchases_count, 0) > 0
          OR EXISTS (
            SELECT 1
            FROM appointment_attendance_signals aas
            WHERE aas.contact_id = c.id
          )
          OR EXISTS (
            SELECT 1
            FROM appointments
            WHERE contact_id = c.id
              AND LOWER(COALESCE(appointment_status, status, '')) = 'showed'
          )
        ) AS has_showed_appointment
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE ${searchClause.condition}
      ORDER BY ${searchRank.expression} DESC, c.created_at DESC
      LIMIT 20`,
      [...searchClause.params, ...searchRank.params]
    )

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contacts.map(c => {
      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.has_appointments) {
        status = 'appointment'
      }

      return {
        id: c.id,
        createdAt: c.created_at,
        name: c.full_name || '',
        email: c.email || '',
        phone: c.phone || '',
        ltv: parseFloat(c.total_paid || 0),
        status,
        lastPurchase: c.last_purchase_date,
        purchases: c.purchases_count || 0,
        hasShowedAppointment: Boolean(c.has_showed_appointment),
        hasAttendedAppointment: Boolean(c.has_showed_appointment),
        source: c.source,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
        notes: ''
      }
    })

    res.json({
      success: true,
      data: mappedContacts
    })

  } catch (error) {
    logger.error(`Error buscando contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error buscando contactos'
    })
  }
}

/**
 * Obtiene estadísticas de contactos
 */
export const getContactStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const { range, metrics } = await buildContactStats({ startDate, endDate })

    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'} (${range.appliedTimezone})`
      : 'todos'

    logger.info(`Obteniendo estadísticas de contactos - rango: ${rangeLabel}`)

    res.json({
      success: true,
      data: metrics
    })

    logger.debug(
      `Stats contactos (${rangeLabel}) -> total: ${metrics.total}, clientes: ${metrics.customers}`
    )

  } catch (error) {
    logger.error(`Error obteniendo estadísticas de contactos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo estadísticas'
    })
  }
}

/**
 * Actualiza las estadísticas de todos los contactos (total_paid, purchases_count, last_purchase_date)
 */
export const syncContactsStats = async (req, res) => {
  try {
    const stats = await updateContactsStats()

    res.json({
      success: true,
      message: 'Estadísticas actualizadas correctamente',
      data: stats
    })
  } catch (error) {
    logger.error(`Error sincronizando estadísticas: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error sincronizando estadísticas'
    })
  }
}

/**
 * Actualiza un contacto
 */
export const updateContact = async (req, res) => {
  try {
    const { id } = req.params
    const {
      full_name,
      email,
      phone,
      source,
      attribution_ad_name,
      attribution_ad_id,
      tags,
      customFields,
      dnd,
      dndSettings
    } = req.body

    // Verificar que el contacto existe
    const existing = await db.get('SELECT id, custom_fields FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    const hasCustomFieldsUpdate = customFields !== undefined
    if (hasCustomFieldsUpdate && !Array.isArray(customFields)) {
      return res.status(400).json({
        success: false,
        error: 'customFields debe ser un arreglo'
      })
    }

    const highLevelCustomFields = hasCustomFieldsUpdate
      ? buildHighLevelCustomFieldsPayload(customFields)
      : null

    // Construir query de actualización solo con campos permitidos
    const updates = []
    const params = []

    if (full_name !== undefined) {
      updates.push('full_name = ?')
      params.push(full_name)
    }
    if (email !== undefined) {
      updates.push('email = ?')
      params.push(email)
    }
    if (phone !== undefined) {
      updates.push('phone = ?')
      params.push(phone)
    }
    if (source !== undefined) {
      updates.push('source = ?')
      params.push(source)
    }
    if (attribution_ad_name !== undefined) {
      updates.push('attribution_ad_name = ?')
      params.push(attribution_ad_name)
    }
    if (attribution_ad_id !== undefined) {
      updates.push('attribution_ad_id = ?')
      params.push(attribution_ad_id)
    }

    if (updates.length === 0 && tags === undefined && !hasCustomFieldsUpdate && dnd === undefined) {
      return res.status(400).json({
        success: false,
        error: 'No hay campos para actualizar'
      })
    }

    // Actualizar en HighLevel (el id del contacto ES el id de HighLevel)
    let mergedCustomFields = null
    try {
      const ghlClient = await getGHLClient()
      const ghlUpdateData = {}

      if (full_name) ghlUpdateData.name = full_name
      if (email) ghlUpdateData.email = email
      if (phone) ghlUpdateData.phone = phone
      if (source) ghlUpdateData.source = source
      if (tags !== undefined) ghlUpdateData.tags = tags
      if (hasCustomFieldsUpdate) ghlUpdateData.customFields = highLevelCustomFields
      if (dnd !== undefined) {
        ghlUpdateData.dnd = dnd
        if (dndSettings) ghlUpdateData.dndSettings = dndSettings
      }

      if (Object.keys(ghlUpdateData).length > 0) {
        await ghlClient.updateContact(id, ghlUpdateData)
        logger.info(`Contacto actualizado en HighLevel: ${id}`)
      }
    } catch (error) {
      if (hasCustomFieldsUpdate) {
        logger.warn(`No se pudieron actualizar custom fields en HighLevel para ${id}: ${error.message}`)
        return res.status(502).json({
          success: false,
          error: 'No se pudieron sincronizar los campos personalizados con GoHighLevel'
        })
      }

      logger.warn(`No se pudo actualizar el contacto en HighLevel: ${error.message}`)
      // Continuar con la actualización local aunque falle en GHL
    }

    if (hasCustomFieldsUpdate) {
      mergedCustomFields = mergeContactCustomFields(
        parseContactCustomFields(existing.custom_fields),
        customFields
      )
      updates.push(`custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}`)
      params.push(serializeContactCustomFieldsForDb(mergedCustomFields))
    }

    // Actualizar en la base de datos local
    if (updates.length > 0) {
      // Agregar updated_at
      updates.push('updated_at = CURRENT_TIMESTAMP')
      params.push(id)

      const query = `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`
      await db.run(query, params)
    }

    // Obtener el contacto actualizado
    const updated = await db.get(
      `SELECT * FROM contacts WHERE id = ?`,
      [id]
    )
    const updatedData = {
      ...updated,
      customFields: parseContactCustomFields(updated.custom_fields)
    }

    logger.info(`Contacto actualizado: ${id}`)

    res.json({
      success: true,
      data: updatedData
    })

  } catch (error) {
    logger.error(`Error actualizando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error actualizando contacto'
    })
  }
}

/**
 * Elimina un contacto
 */
export const deleteContact = async (req, res) => {
  try {
    const { id } = req.params

    // Verificar que el contacto existe
    const existing = await db.get('SELECT id, full_name FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Eliminar en HighLevel (el id del contacto ES el id de HighLevel)
    try {
      const ghlClient = await getGHLClient()
      await ghlClient.deleteContact(id)
      logger.info(`Contacto eliminado de HighLevel: ${id}`)
    } catch (error) {
      logger.warn(`No se pudo eliminar el contacto de HighLevel: ${error.message}`)
      // Continuar con la eliminación local aunque falle en GHL
    }

    // Eliminar el contacto (las relaciones se eliminan automáticamente por CASCADE)
    await db.run('DELETE FROM contacts WHERE id = ?', [id])

    logger.info(`Contacto eliminado: ${id} (${existing.full_name})`)

    res.json({
      success: true,
      message: 'Contacto eliminado correctamente'
    })

  } catch (error) {
    logger.error(`Error eliminando contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error eliminando contacto'
    })
  }
}

/**
 * Obtiene datos de registros agrupados por fecha para gráfico
 */
export const getContactsChart = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    const range = await resolveDateRangeWithGHLTimezone({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo datos de gráfico de registros - rango: ${rangeLabel}`)

    // Aplicar filtro de contactos ocultos
    const hiddenFilters = await getHiddenContactFilters()
    const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

    // Construir WHERE clause
    const conditions = []
    const params = []

    if (range.startUtc) {
      conditions.push('created_at >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('created_at <= ?')
      params.push(range.endUtc)
    }

    if (hiddenCondition) {
      conditions.push(hiddenCondition)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Query para obtener registros por fecha
    const query = `
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM contacts
      ${whereClause}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `

    const data = await db.all(query, params)

    logger.debug(`Datos de gráfico obtenidos: ${data.length} días con registros`)

    res.json({
      success: true,
      data
    })

  } catch (error) {
    logger.error(`Error obteniendo datos de gráfico de registros: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo datos de gráfico'
    })
  }
}

/**
 * Obtiene el journey completo del contacto (timeline de eventos)
 * Orden de eventos:
 * 1. Primer toque (sessions o whatsapp_attribution, el más antiguo)
 * 2. Se convirtió en contacto (created_at)
 * 3. Primera cita (appointments, date_added)
 * 4. Primera compra (payments, date)
 */
export const getContactJourney = async (req, res) => {
  try {
    const { id } = req.params

    // Verificar que el contacto existe y obtener info de atribución completa
    const contact = await db.get(`
      SELECT
        contacts.*,
        meta_ads.campaign_name,
        meta_ads.adset_name,
        meta_ads.ad_name as meta_ad_name
      FROM contacts
      LEFT JOIN meta_ads ON meta_ads.ad_id = contacts.attribution_ad_id
      WHERE contacts.id = ?
      LIMIT 1
    `, [id])
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    const journey = []
    const successfulPaymentsCondition = `
      contact_id = ?
      AND amount > 0
      AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
      AND ${nonTestPaymentCondition()}
    `
    const firstPayment = await db.get(
      `SELECT date FROM payments
       WHERE ${successfulPaymentsCondition}
       ORDER BY date ASC
       LIMIT 1`,
      [id]
    )
    const rawFirstPaymentTime = firstPayment?.date ? new Date(firstPayment.date).getTime() : null
    const firstPaymentTime = Number.isFinite(rawFirstPaymentTime) ? rawFirstPaymentTime : null

    const getDateTime = (value) => {
      const time = new Date(value).getTime()
      return Number.isFinite(time) ? time : 0
    }

    const getDateKey = (value) => {
      const time = getDateTime(value)
      return time ? new Date(time).toISOString().slice(0, 10) : String(value || '')
    }

    const detectWhatsAppAdPlatform = (data = {}) => {
      const haystack = [
        data.referral_source_app,
        data.referral_source_type,
        data.referral_entry_point,
        data.referral_source_url
      ].filter(Boolean).join(' ').toLowerCase()

      if (haystack.includes('instagram') || haystack.includes('ig_') || haystack.includes('ig ')) {
        return 'Instagram'
      }

      if (haystack.includes('facebook') || haystack.includes('fb_') || haystack.includes('fb ')) {
        return 'Facebook'
      }

      if (data.referral_source_id || data.referral_ctwa_clid || haystack.includes('meta')) {
        return 'Meta Ads'
      }

      return ''
    }

    const addWhatsAppJourneyEvents = (events) => {
      const dailyBeforePayment = new Map()
      const attributedAfterPayment = []

      events
        .filter(event => event?.date)
        .sort((a, b) => getDateTime(a.date) - getDateTime(b.date))
        .forEach(event => {
          const eventTime = getDateTime(event.date)
          const isAfterFirstPayment = firstPaymentTime && eventTime >= firstPaymentTime

          if (isAfterFirstPayment) {
            if (event.data?.is_ad_attributed) {
              attributedAfterPayment.push(event)
            }
            return
          }

          const dayKey = getDateKey(event.date)
          const existing = dailyBeforePayment.get(dayKey)

          if (!existing || (!existing.data?.is_ad_attributed && event.data?.is_ad_attributed)) {
            dailyBeforePayment.set(dayKey, event)
          }
        })

      journey.push(...dailyBeforePayment.values(), ...attributedAfterPayment)
    }

    // 1. TODAS las visitas/sessions (por contact_id, visitor_id o email)
    let sessions = []

    if (contact.visitor_id) {
      sessions = await db.all(
        `SELECT * FROM sessions
         WHERE contact_id = ? OR visitor_id = ?
         ORDER BY started_at ASC`,
        [id, contact.visitor_id]
      )
    } else {
      sessions = await db.all(
        `SELECT * FROM sessions
         WHERE contact_id = ?
         ORDER BY started_at ASC`,
        [id]
      )
    }

    // Fallback por email si no encontró sesiones
    if (sessions.length === 0 && contact.email) {
      sessions = await db.all(
        `SELECT * FROM sessions WHERE email = ? ORDER BY started_at ASC`,
        [contact.email]
      )
      if (sessions.length > 0) {
        logger.info(`📍 ${sessions.length} sessions encontradas por email para contacto ${id}`)
      }
    }

    // Agregar todas las visitas al journey
    sessions.forEach(session => {
      journey.push({
        type: 'page_visit',
        date: session.started_at,
        data: {
          page_url: session.page_url,
          landing_page: session.landing_page,
          referrer_url: session.referrer_url,
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          utm_content: session.utm_content,
          source_platform: session.source_platform,
          site_source_name: session.site_source_name,
          campaign_name: session.campaign_name,
          ad_name: session.ad_name,
          ad_id: session.ad_id,
          device_type: session.device_type,
          browser: session.browser,
          geo_city: session.geo_city,
          geo_region: session.geo_region,
          geo_country: session.geo_country
        }
      })
    })

    // 2. Movimientos de WhatsApp del cliente: diario antes del pago, atribuidos despues.
    const whatsappJourneyEvents = []
    const whatsappMessages = await db.all(
      `SELECT * FROM whatsapp_attribution
       WHERE contact_id = ?
       ORDER BY created_at ASC`,
      [id]
    )

    whatsappMessages.forEach(msg => {
      const data = {
        source: 'WhatsApp',
        phone: msg.phone,
        message_text: msg.message_content,
        referral_source_url: msg.referral_source_url,
        referral_source_type: msg.referral_source_type,
        referral_source_id: msg.referral_source_id || msg.ad_id_thru_message,
        referral_headline: msg.referral_headline,
        referral_body: msg.referral_body,
        referral_ctwa_clid: msg.referral_ctwa_clid,
        is_ad_attributed: true
      }

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.created_at,
        data: {
          ...data,
          ad_platform: detectWhatsAppAdPlatform(data)
        }
      })
    })

    const whatsappBusinessMessages = await db.all(
      `SELECT
          msg.message_text,
          msg.message_type,
          msg.push_name,
          msg.message_timestamp,
          msg.created_at,
          msg.phone,
          msg.direction,
          COALESCE(attr.id, '') as attribution_id,
          COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as detected_ctwa_clid,
          COALESCE(attr.detected_source_id, msg.detected_source_id) as detected_source_id,
          COALESCE(attr.detected_source_url, msg.detected_source_url) as detected_source_url,
          COALESCE(attr.detected_source_type, msg.detected_source_type) as detected_source_type,
          COALESCE(attr.detected_source_app, msg.detected_source_app) as detected_source_app,
          COALESCE(attr.detected_entry_point, msg.detected_entry_point) as detected_entry_point,
          COALESCE(attr.detected_headline, msg.detected_headline) as detected_headline,
          COALESCE(attr.detected_body, msg.detected_body) as detected_body
       FROM whatsapp_web_messages msg
       LEFT JOIN whatsapp_web_attribution attr ON attr.whatsapp_web_message_id = msg.id
       WHERE msg.contact_id = ?
         AND msg.direction = 'inbound'
       ORDER BY COALESCE(msg.message_timestamp, msg.created_at) ASC`,
      [id]
    )

    whatsappBusinessMessages.forEach(msg => {
      const isAdAttributed = Boolean(
        msg.attribution_id ||
        msg.detected_ctwa_clid ||
        msg.detected_source_id ||
        msg.detected_source_url ||
        msg.detected_headline
      )
      const data = {
        source: 'WhatsApp',
        phone: msg.phone,
        push_name: msg.push_name,
        message_text: msg.message_text,
        message_type: msg.message_type,
        referral_source_url: msg.detected_source_url,
        referral_source_type: msg.detected_source_type,
        referral_ctwa_clid: msg.detected_ctwa_clid,
        referral_source_id: msg.detected_source_id,
        referral_headline: msg.detected_headline,
        referral_body: msg.detected_body,
        referral_source_app: msg.detected_source_app,
        referral_entry_point: msg.detected_entry_point,
        is_ad_attributed: isAdAttributed
      }

      whatsappJourneyEvents.push({
        type: 'whatsapp_message',
        date: msg.message_timestamp || msg.created_at,
        data: {
          ...data,
          ad_platform: detectWhatsAppAdPlatform(data)
        }
      })
    })

    addWhatsAppJourneyEvents(whatsappJourneyEvents)

    // 3. Contacto creado
    journey.push({
      type: 'contact_created',
      date: contact.created_at,
      data: {
        name: contact.full_name,
        email: contact.email,
        phone: contact.phone,
        source: contact.source,
        attribution_ad_name: contact.attribution_ad_name || contact.meta_ad_name,
        attribution_ad_id: contact.attribution_ad_id,
        campaign_name: contact.campaign_name,
        adset_name: contact.adset_name
      }
    })

    // 4. TODAS las citas agendadas (filtradas por calendarios de atribución)
    // Obtener calendarios de atribución configurados
    const attributionConfig = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    let appointments
    if (attributionConfig && attributionConfig.config_value) {
      try {
        const calendarIds = JSON.parse(attributionConfig.config_value)
        if (calendarIds.length > 0) {
          const placeholders = calendarIds.map(() => '?').join(',')
          appointments = await db.all(
            `SELECT * FROM appointments
             WHERE contact_id = ?
               AND calendar_id IN (${placeholders})
             ORDER BY date_added ASC`,
            [id, ...calendarIds]
          )
        } else {
          // Sin calendarios configurados, usar todos
          appointments = await db.all(
            `SELECT * FROM appointments
             WHERE contact_id = ?
             ORDER BY date_added ASC`,
            [id]
          )
        }
      } catch (error) {
        logger.warn(`Error parseando calendarios de atribución: ${error.message}`)
        // Fallback: usar todos los calendarios
        appointments = await db.all(
          `SELECT * FROM appointments
           WHERE contact_id = ?
           ORDER BY date_added ASC`,
          [id]
        )
      }
    } else {
      // Sin configuración, usar todos los calendarios
      appointments = await db.all(
        `SELECT * FROM appointments
         WHERE contact_id = ?
         ORDER BY date_added ASC`,
        [id]
      )
    }

    appointments.forEach(appointment => {
      journey.push({
        type: 'appointment',
        date: appointment.date_added,
        data: {
          title: appointment.title,
          status: appointment.appointment_status || appointment.status,
          start_time: appointment.start_time,
          end_time: appointment.end_time,
          address: appointment.address,
          notes: appointment.notes
        }
      })
    })

    // 5. TODOS los pagos exitosos
    const payments = await db.all(
      `SELECT * FROM payments
       WHERE ${successfulPaymentsCondition}
       ORDER BY date ASC`,
      [id]
    )

    payments.forEach(payment => {
      journey.push({
        type: 'payment',
        date: payment.date,
        data: {
          amount: payment.amount,
          status: payment.status,
          title: payment.title,
          type: payment.type,
          payment_provider: payment.payment_provider
        }
      })
    })

    // Ordenar TODOS los eventos por fecha cronológica
    journey.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    logger.info(`Journey obtenido para contacto ${id}: ${journey.length} eventos`)

    res.json({
      success: true,
      data: journey
    })

  } catch (error) {
    logger.error(`Error obteniendo journey del contacto ${req.params.id}: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo journey del contacto'
    })
  }
}
