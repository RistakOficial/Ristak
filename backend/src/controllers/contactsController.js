import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { updateContactsStats } from '../utils/updateContactsStats.js'
import { resolveDateRange } from '../utils/dateUtils.js'
import { buildContactStats } from '../services/analyticsService.js'
import { getGHLClient } from '../services/ghlClient.js'

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

    const range = resolveDateRange({ startDate, endDate })
    const rangeLabel = range.isFiltered
      ? `${range.startUtc || '---'} -> ${range.endUtc || '---'}`
      : 'todos'

    logger.info(`Obteniendo contactos - página ${pageNumber}, límite ${limitNumber}, rango: ${rangeLabel}`)

    // Query base
    let whereClause = ''
    const params = []

    // Construir WHERE clause para filtros
    const conditions = []

    if (search) {
      conditions.push(`(
        LOWER(full_name) LIKE LOWER(?) OR
        LOWER(email) LIKE LOWER(?) OR
        phone LIKE ?
      )`)
      const searchTerm = `%${search}%`
      params.push(searchTerm, searchTerm, searchTerm)
    }

    if (range.startUtc) {
      conditions.push('created_at >= ?')
      params.push(range.startUtc)
    }

    if (range.endUtc) {
      conditions.push('created_at <= ?')
      params.push(range.endUtc)
    }

    if (conditions.length > 0) {
      whereClause = `WHERE ${conditions.join(' AND ')}`
    }

    // Obtener el total de contactos
    const countQuery = `SELECT COUNT(*) as total FROM contacts ${whereClause}`
    const countResult = await db.get(countQuery, params)
    const totalContacts = countResult.total

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

    const contactsQuery = `
      WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
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
        c.attribution_ad_name,
        c.attribution_ad_id,
        COALESCE(ps.total_paid, c.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, c.purchases_count, 0) AS purchases_count,
        COALESCE(ps.last_purchase_date, c.last_purchase_date) AS last_purchase_date,
        c.appointment_date,
        c.created_at
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      ${whereClause}
      ORDER BY ${safeSortBy} ${orderDirection}
      LIMIT ? OFFSET ?
    `

    const contactsParams = [...params, limitNumber, offset]
    const contacts = await db.all(contactsQuery, contactsParams)

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contacts.map(c => {
      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.appointment_date) {
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
        source: c.source,
        ad_name: c.attribution_ad_name,
        ad_id: c.attribution_ad_id,
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
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
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
        c.attribution_ad_name,
        c.attribution_ad_id,
        COALESCE(ps.total_paid, c.total_paid, 0) AS total_paid,
        COALESCE(ps.purchases_count, c.purchases_count, 0) AS purchases_count,
        COALESCE(ps.last_purchase_date, c.last_purchase_date) AS last_purchase_date,
        c.appointment_date,
        c.created_at
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

    // Obtener citas del contacto
    const appointments = await db.all(
      `SELECT * FROM appointments
       WHERE contact_id = ?
       ORDER BY start_time DESC`,
      [id]
    )

    // Determinar status basado en la actividad del contacto
    let status = 'lead'
    if (contact.purchases_count > 0) {
      status = 'customer'
    } else if (contact.appointment_date) {
      status = 'appointment'
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
      notes: '',
      payments,
      appointments
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

    const searchTerm = `%${q}%`

    const contacts = await db.all(
      `WITH payment_stats AS (
        SELECT
          contact_id,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
                THEN 1 ELSE 0 END) AS purchases_count,
          MAX(CASE
                WHEN amount > 0 AND LOWER(status) IN ('succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success')
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
        c.attribution_ad_id
      FROM contacts c
      LEFT JOIN payment_stats ps ON ps.contact_id = c.id
      WHERE
        LOWER(c.full_name) LIKE LOWER(?) OR
        LOWER(c.email) LIKE LOWER(?) OR
        c.phone LIKE ?
      LIMIT 20`,
      [searchTerm, searchTerm, searchTerm]
    )

    // Mapear campos de base de datos a nombres esperados por frontend
    const mappedContacts = contacts.map(c => {
      // Determinar status basado en la actividad del contacto
      let status = 'lead'
      if (c.purchases_count > 0) {
        status = 'customer'
      } else if (c.appointment_date) {
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
    const existing = await db.get('SELECT id, ghl_contact_id FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

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

    if (updates.length === 0 && !tags && !customFields && dnd === undefined) {
      return res.status(400).json({
        success: false,
        error: 'No hay campos para actualizar'
      })
    }

    // Actualizar en HighLevel si tiene ghl_contact_id
    if (existing.ghl_contact_id) {
      try {
        const ghlClient = await getGHLClient()
        const ghlUpdateData = {}

        if (full_name) ghlUpdateData.name = full_name
        if (email) ghlUpdateData.email = email
        if (phone) ghlUpdateData.phone = phone
        if (source) ghlUpdateData.source = source
        if (tags) ghlUpdateData.tags = tags
        if (customFields) ghlUpdateData.customFields = customFields
        if (dnd !== undefined) {
          ghlUpdateData.dnd = dnd
          if (dndSettings) ghlUpdateData.dndSettings = dndSettings
        }

        if (Object.keys(ghlUpdateData).length > 0) {
          await ghlClient.updateContact(existing.ghl_contact_id, ghlUpdateData)
          logger.info(`Contacto actualizado en HighLevel: ${existing.ghl_contact_id}`)
        }
      } catch (error) {
        logger.warn(`No se pudo actualizar el contacto en HighLevel: ${error.message}`)
        // Continuar con la actualización local aunque falle en GHL
      }
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

    logger.info(`Contacto actualizado: ${id}`)

    res.json({
      success: true,
      data: updated
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
    const existing = await db.get('SELECT id, full_name, ghl_contact_id FROM contacts WHERE id = ?', [id])
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Contacto no encontrado'
      })
    }

    // Eliminar en HighLevel si tiene ghl_contact_id
    if (existing.ghl_contact_id) {
      try {
        const ghlClient = await getGHLClient()
        await ghlClient.deleteContact(existing.ghl_contact_id)
        logger.info(`Contacto eliminado de HighLevel: ${existing.ghl_contact_id}`)
      } catch (error) {
        logger.warn(`No se pudo eliminar el contacto de HighLevel: ${error.message}`)
        // Continuar con la eliminación local aunque falle en GHL
      }
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
