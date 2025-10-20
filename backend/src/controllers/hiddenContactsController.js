import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'

/**
 * Obtiene todos los filtros de contactos ocultos
 */
export const getHiddenFilters = async (req, res) => {
  try {
    const filters = await db.all(
      'SELECT id, filter_text, match_type, created_at FROM hidden_contact_filters ORDER BY created_at DESC'
    )

    res.json({
      success: true,
      data: filters.map(f => ({
        id: f.id.toString(),
        filterText: f.filter_text,
        matchType: f.match_type || 'contains',
        createdAt: f.created_at
      }))
    })
  } catch (error) {
    logger.error(`Error obteniendo filtros de contactos ocultos: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error obteniendo filtros'
    })
  }
}

/**
 * Agrega un nuevo filtro de contacto oculto
 */
export const addHiddenFilter = async (req, res) => {
  try {
    const { filterText, matchType = 'contains' } = req.body

    if (!filterText || typeof filterText !== 'string' || filterText.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'El texto del filtro es requerido'
      })
    }

    if (!['contains', 'exact'].includes(matchType)) {
      return res.status(400).json({
        success: false,
        error: 'El tipo de coincidencia debe ser "contains" o "exact"'
      })
    }

    const trimmedFilter = filterText.trim()

    // Verificar si ya existe el mismo filtro con el mismo tipo
    const existing = await db.get(
      'SELECT id FROM hidden_contact_filters WHERE LOWER(filter_text) = LOWER(?) AND match_type = ?',
      [trimmedFilter, matchType]
    )

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Este filtro ya existe'
      })
    }

    // Insertar nuevo filtro
    const usePostgres = Boolean(process.env.DATABASE_URL)

    let newFilter
    if (usePostgres) {
      // PostgreSQL: usar RETURNING
      newFilter = await db.get(
        'INSERT INTO hidden_contact_filters (filter_text, match_type) VALUES ($1, $2) RETURNING id, filter_text, match_type, created_at',
        [trimmedFilter, matchType]
      )
    } else {
      // SQLite: usar lastID
      const result = await db.run(
        'INSERT INTO hidden_contact_filters (filter_text, match_type) VALUES (?, ?)',
        [trimmedFilter, matchType]
      )
      newFilter = await db.get(
        'SELECT id, filter_text, match_type, created_at FROM hidden_contact_filters WHERE id = ?',
        [result.lastID]
      )
    }

    logger.info(`Filtro de contacto oculto agregado: "${trimmedFilter}" (${matchType})`)

    res.json({
      success: true,
      data: {
        id: newFilter.id.toString(),
        filterText: newFilter.filter_text,
        matchType: newFilter.match_type,
        createdAt: newFilter.created_at
      }
    })
  } catch (error) {
    logger.error(`Error agregando filtro de contacto oculto: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error agregando filtro'
    })
  }
}

/**
 * Elimina un filtro de contacto oculto
 */
export const deleteHiddenFilter = async (req, res) => {
  try {
    const { id } = req.params

    const result = await db.run(
      'DELETE FROM hidden_contact_filters WHERE id = ?',
      [id]
    )

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        error: 'Filtro no encontrado'
      })
    }

    logger.info(`Filtro de contacto oculto eliminado: ID ${id}`)

    res.json({
      success: true,
      message: 'Filtro eliminado correctamente'
    })
  } catch (error) {
    logger.error(`Error eliminando filtro de contacto oculto: ${error.message}`)
    res.status(500).json({
      success: false,
      error: 'Error eliminando filtro'
    })
  }
}
