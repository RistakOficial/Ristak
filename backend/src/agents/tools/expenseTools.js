import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { createCost, updateCost, deleteCost } from '../../controllers/costsController.js'
import { invokeController, toToolResult } from '../invokeController.js'

const COST_FIELDS = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  calculationType: row.calculation_type,
  value: Number(row.value),
  appliesTo: row.applies_to,
  isActive: Boolean(row.is_active)
})

export const listCostsTool = tool({
  name: 'list_costs',
  description: 'Lista los costos variables configurados (comisiones, costos por venta, etc.). Úsala antes de editar o borrar para obtener el ID real.',
  parameters: z.object({
    includeInactive: z.boolean().nullable().describe('true para incluir costos desactivados (default false)')
  }),
  execute: async ({ includeInactive }) => {
    const rows = includeInactive
      ? await db.all('SELECT * FROM costs ORDER BY created_at DESC')
      : await db.all('SELECT * FROM costs WHERE is_active = 1 ORDER BY created_at DESC')
    return { ok: true, total: rows.length, costs: rows.map(COST_FIELDS) }
  }
})

export const createCostTool = tool({
  name: 'create_cost',
  description: 'Crea un costo variable nuevo. calculationType "percentage" aplica un % sobre los ingresos (value entre 0 y 100); "fixed" es un monto fijo por unidad.',
  parameters: z.object({
    name: z.string().describe('Nombre del costo, ej. "Comisión pasarela de pago"'),
    type: z.string().describe('Categoría del costo, ej. commission | processing | delivery | other'),
    calculationType: z.enum(['percentage', 'fixed']).describe('percentage (% sobre ingresos) o fixed (monto fijo)'),
    value: z.number().min(0).describe('Valor: porcentaje 0-100 o monto fijo'),
    appliesTo: z.string().nullable().describe('A qué aplica (opcional), ej. "ventas con tarjeta"')
  }),
  execute: async ({ name, type, calculationType, value, appliesTo }) => {
    const result = await invokeController(createCost, {
      body: {
        name,
        type,
        calculation_type: calculationType,
        value,
        applies_to: appliesTo || undefined
      }
    })
    if (result.payload?.success === false) {
      return { ok: false, error: result.payload.error }
    }
    return { ok: true, cost: result.payload?.cost ? COST_FIELDS(result.payload.cost) : null }
  }
})

export const updateCostTool = tool({
  name: 'update_cost',
  description: 'Edita un costo variable existente. Solo envía los campos que cambian. Con isActive=true puedes reactivar un costo desactivado.',
  parameters: z.object({
    costId: z.string().describe('ID del costo (usa list_costs)'),
    name: z.string().nullable().describe('Nuevo nombre'),
    type: z.string().nullable().describe('Nueva categoría'),
    calculationType: z.enum(['percentage', 'fixed']).nullable().describe('Nuevo tipo de cálculo'),
    value: z.number().min(0).nullable().describe('Nuevo valor'),
    appliesTo: z.string().nullable().describe('Nuevo campo "aplica a"'),
    isActive: z.boolean().nullable().describe('Activar o desactivar el costo')
  }),
  execute: async ({ costId, name, type, calculationType, value, appliesTo, isActive }) => {
    const body = {}
    if (name !== null && name !== undefined) body.name = name
    if (type !== null && type !== undefined) body.type = type
    if (calculationType !== null && calculationType !== undefined) body.calculation_type = calculationType
    if (value !== null && value !== undefined) body.value = value
    if (appliesTo !== null && appliesTo !== undefined) body.applies_to = appliesTo
    if (isActive !== null && isActive !== undefined) body.is_active = isActive

    if (!Object.keys(body).length) {
      return { ok: false, error: 'No enviaste ningún campo a actualizar' }
    }

    const result = await invokeController(updateCost, { params: { id: costId }, body })
    if (result.payload?.success === false) {
      return { ok: false, error: result.payload.error }
    }
    return { ok: true, cost: result.payload?.cost ? COST_FIELDS(result.payload.cost) : null }
  }
})

export const deleteCostTool = tool({
  name: 'delete_cost',
  description: 'Desactiva un costo variable (deja de aplicarse en los reportes; se puede reactivar con update_cost). Pide confirmación al usuario antes y pasa confirm=true solo cuando ya confirmó.',
  parameters: z.object({
    costId: z.string().describe('ID del costo a desactivar'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó explícitamente')
  }),
  execute: async ({ costId, confirm }) => {
    if (!confirm) {
      return { ok: false, error: 'Falta confirmación del usuario. Pregunta antes de desactivar el costo.' }
    }
    const result = await invokeController(deleteCost, { params: { id: costId } })
    return toToolResult(result)
  }
})

export const expenseReadTools = [listCostsTool]
export const expenseWriteTools = [createCostTool, updateCostTool, deleteCostTool]
export const expenseTools = [...expenseReadTools, ...expenseWriteTools]
