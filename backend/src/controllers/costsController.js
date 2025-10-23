import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { randomBytes } from 'crypto'

/**
 * Obtiene todos los costos activos
 * GET /api/costs
 */
export async function getAllCosts(req, res) {
  try {
    const costs = await db.all(`
      SELECT * FROM costs
      WHERE is_active = 1
      ORDER BY created_at DESC
    `)

    res.json({
      success: true,
      costs
    })
  } catch (error) {
    logger.error('Error obteniendo costos:', error)
    res.status(500).json({
      success: false,
      error: 'Error al obtener costos'
    })
  }
}

/**
 * Obtiene un costo específico por ID
 * GET /api/costs/:id
 */
export async function getCostById(req, res) {
  try {
    const { id } = req.params

    const cost = await db.get('SELECT * FROM costs WHERE id = ?', [id])

    if (!cost) {
      return res.status(404).json({
        success: false,
        error: 'Costo no encontrado'
      })
    }

    res.json({
      success: true,
      cost
    })
  } catch (error) {
    logger.error('Error obteniendo costo:', error)
    res.status(500).json({
      success: false,
      error: 'Error al obtener costo'
    })
  }
}

/**
 * Crea un nuevo costo
 * POST /api/costs
 * Body: { name, type, calculation_type, value, applies_to }
 */
export async function createCost(req, res) {
  try {
    const { name, type, calculation_type, value, applies_to } = req.body

    // Validaciones
    if (!name || !type || !calculation_type || value === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Faltan campos requeridos: name, type, calculation_type, value'
      })
    }

    // Validar calculation_type
    if (!['percentage', 'fixed'].includes(calculation_type)) {
      return res.status(400).json({
        success: false,
        error: 'calculation_type debe ser "percentage" o "fixed"'
      })
    }

    // Validar valor
    const numValue = parseFloat(value)
    if (isNaN(numValue) || numValue < 0) {
      return res.status(400).json({
        success: false,
        error: 'value debe ser un número positivo'
      })
    }

    if (calculation_type === 'percentage' && numValue > 100) {
      return res.status(400).json({
        success: false,
        error: 'Para porcentajes, value debe estar entre 0 y 100'
      })
    }

    // Generar ID único
    const id = randomBytes(16).toString('hex')

    // Insertar en DB
    const usePostgres = !!process.env.DATABASE_URL

    const query = usePostgres
      ? `INSERT INTO costs (id, name, type, calculation_type, value, applies_to, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      : `INSERT INTO costs (id, name, type, calculation_type, value, applies_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`

    await db.run(query, [
      id,
      name,
      type,
      calculation_type,
      numValue,
      applies_to || null
    ])

    logger.info(`Costo creado: ${name} (${type})`)

    // Obtener el costo recién creado
    const newCost = await db.get('SELECT * FROM costs WHERE id = ?', [id])

    res.status(201).json({
      success: true,
      message: 'Costo creado exitosamente',
      cost: newCost
    })
  } catch (error) {
    logger.error('Error creando costo:', error)
    res.status(500).json({
      success: false,
      error: 'Error al crear costo'
    })
  }
}

/**
 * Actualiza un costo existente
 * PUT /api/costs/:id
 * Body: { name, type, calculation_type, value, applies_to, is_active }
 */
export async function updateCost(req, res) {
  try {
    const { id } = req.params
    const { name, type, calculation_type, value, applies_to, is_active } = req.body

    // Verificar que el costo existe
    const existingCost = await db.get('SELECT * FROM costs WHERE id = ?', [id])

    if (!existingCost) {
      return res.status(404).json({
        success: false,
        error: 'Costo no encontrado'
      })
    }

    // Validar calculation_type si se proporciona
    if (calculation_type && !['percentage', 'fixed'].includes(calculation_type)) {
      return res.status(400).json({
        success: false,
        error: 'calculation_type debe ser "percentage" o "fixed"'
      })
    }

    // Validar valor si se proporciona
    if (value !== undefined) {
      const numValue = parseFloat(value)
      if (isNaN(numValue) || numValue < 0) {
        return res.status(400).json({
          success: false,
          error: 'value debe ser un número positivo'
        })
      }

      const calcType = calculation_type || existingCost.calculation_type
      if (calcType === 'percentage' && numValue > 100) {
        return res.status(400).json({
          success: false,
          error: 'Para porcentajes, value debe estar entre 0 y 100'
        })
      }
    }

    // Construir query de actualización (solo actualizar campos proporcionados)
    const updates = []
    const values = []

    if (name !== undefined) {
      updates.push('name = ?')
      values.push(name)
    }
    if (type !== undefined) {
      updates.push('type = ?')
      values.push(type)
    }
    if (calculation_type !== undefined) {
      updates.push('calculation_type = ?')
      values.push(calculation_type)
    }
    if (value !== undefined) {
      updates.push('value = ?')
      values.push(parseFloat(value))
    }
    if (applies_to !== undefined) {
      updates.push('applies_to = ?')
      values.push(applies_to || null)
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?')
      values.push(is_active ? 1 : 0)
    }

    updates.push('updated_at = CURRENT_TIMESTAMP')

    values.push(id)

    const usePostgres = !!process.env.DATABASE_URL
    let query = `UPDATE costs SET ${updates.join(', ')} WHERE id = ?`

    if (usePostgres) {
      // Convertir placeholders ? a $1, $2, etc. para PostgreSQL
      let index = 1
      query = query.replace(/\?/g, () => `$${index++}`)
    }

    await db.run(query, values)

    logger.info(`Costo actualizado: ${id}`)

    // Obtener el costo actualizado
    const updatedCost = await db.get('SELECT * FROM costs WHERE id = ?', [id])

    res.json({
      success: true,
      message: 'Costo actualizado exitosamente',
      cost: updatedCost
    })
  } catch (error) {
    logger.error('Error actualizando costo:', error)
    res.status(500).json({
      success: false,
      error: 'Error al actualizar costo'
    })
  }
}

/**
 * Elimina un costo (soft delete)
 * DELETE /api/costs/:id
 */
export async function deleteCost(req, res) {
  try {
    const { id } = req.params

    // Verificar que el costo existe
    const existingCost = await db.get('SELECT * FROM costs WHERE id = ?', [id])

    if (!existingCost) {
      return res.status(404).json({
        success: false,
        error: 'Costo no encontrado'
      })
    }

    // Soft delete: marcar como inactivo
    const usePostgres = !!process.env.DATABASE_URL
    const query = usePostgres
      ? 'UPDATE costs SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1'
      : 'UPDATE costs SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'

    await db.run(query, [id])

    logger.info(`Costo eliminado: ${id}`)

    res.json({
      success: true,
      message: 'Costo eliminado exitosamente'
    })
  } catch (error) {
    logger.error('Error eliminando costo:', error)
    res.status(500).json({
      success: false,
      error: 'Error al eliminar costo'
    })
  }
}

/**
 * Calcula el total de costos para un período y monto de ingresos
 * POST /api/costs/calculate
 * Body: { revenue, date_start, date_end }
 */
export async function calculateCosts(req, res) {
  try {
    const { revenue } = req.body

    if (revenue === undefined || isNaN(parseFloat(revenue))) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere un monto de revenue válido'
      })
    }

    const numRevenue = parseFloat(revenue)

    // Obtener todos los costos activos
    const costs = await db.all('SELECT * FROM costs WHERE is_active = 1')

    let totalCosts = 0
    const breakdown = []

    for (const cost of costs) {
      let amount = 0

      if (cost.calculation_type === 'percentage') {
        // Porcentaje sobre revenue
        if (cost.applies_to === 'revenue') {
          amount = (numRevenue * cost.value) / 100
        }
      } else if (cost.calculation_type === 'fixed') {
        // Monto fijo
        amount = cost.value
      }

      totalCosts += amount

      breakdown.push({
        id: cost.id,
        name: cost.name,
        type: cost.type,
        calculation_type: cost.calculation_type,
        value: cost.value,
        amount
      })
    }

    res.json({
      success: true,
      revenue: numRevenue,
      total_costs: totalCosts,
      net_profit: numRevenue - totalCosts,
      breakdown
    })
  } catch (error) {
    logger.error('Error calculando costos:', error)
    res.status(500).json({
      success: false,
      error: 'Error al calcular costos'
    })
  }
}
