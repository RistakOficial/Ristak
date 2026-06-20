import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { createCost, updateCost, deleteCost } from '../../controllers/costsController.js'
import { invokeController, toToolResult } from '../invokeController.js'
import {
  MANUAL_BUSINESS_EXPENSE_PERIODS,
  deleteManualBusinessExpenseDescendants,
  getManualBusinessExpenseRange,
  getManualBusinessExpensesTotalForRange,
  normalizeManualBusinessExpensePeriodStart,
  normalizeManualBusinessExpenseRow,
  roundCurrencyValue
} from '../../services/manualBusinessExpensesService.js'

const COST_FIELDS = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  calculationType: row.calculation_type,
  value: Number(row.value),
  appliesTo: row.applies_to,
  isActive: Boolean(row.is_active)
})

const MANUAL_EXPENSE_FIELDS = (row) => ({
  periodType: row.period_type,
  periodStart: row.period_start,
  amount: Number(row.amount || 0)
})

function cleanText(value) {
  return String(value || '').trim()
}

function normalizePeriodType(value) {
  const text = cleanText(value).toLowerCase()
  if (['day', 'dia', 'día', 'daily'].includes(text)) return 'day'
  if (['month', 'mes', 'monthly', 'mensual'].includes(text)) return 'month'
  if (['year', 'año', 'ano', 'yearly', 'anual'].includes(text)) return 'year'
  return text
}

function normalizeAdjustmentMode(value) {
  const text = cleanText(value || 'replace').toLowerCase()
  if (['add', 'sum', 'sumar', 'suma'].includes(text)) return 'add'
  if (['clear', 'delete', 'remove', 'borrar', 'limpiar'].includes(text)) return 'clear'
  return 'replace'
}

async function getManualExpense(periodType, periodStart) {
  return db.get(
    `SELECT period_type, period_start, amount
     FROM report_manual_business_expenses
     WHERE period_type = ? AND period_start = ?`,
    [periodType, periodStart]
  )
}

export async function listManualBusinessExpenseRecords({ periodType = null, startDate = null, endDate = null } = {}) {
  const params = []
  const conditions = ['1 = 1']
  const normalizedPeriodType = periodType ? normalizePeriodType(periodType) : null

  if (normalizedPeriodType) {
    if (!MANUAL_BUSINESS_EXPENSE_PERIODS.has(normalizedPeriodType)) {
      return { ok: false, error: 'periodType debe ser day, month o year' }
    }
    conditions.push('period_type = ?')
    params.push(normalizedPeriodType)
  }

  if (startDate) {
    conditions.push('period_start >= ?')
    params.push(startDate)
  }
  if (endDate) {
    conditions.push('period_start <= ?')
    params.push(endDate)
  }

  const rows = await db.all(
    `SELECT period_type, period_start, amount
     FROM report_manual_business_expenses
     WHERE ${conditions.join(' AND ')}
     ORDER BY period_start ASC, period_type ASC`,
    params
  )

  const effectiveTotal = startDate && endDate
    ? await getManualBusinessExpensesTotalForRange({ from: startDate, to: endDate })
    : null

  return {
    ok: true,
    total: rows.length,
    effectiveTotal,
    expenses: rows.map(MANUAL_EXPENSE_FIELDS)
  }
}

export async function applyManualBusinessExpenseAdjustment({
  periodType,
  periodStart,
  amount = null,
  mode = 'replace',
  resetChildren = true,
  confirm = false
} = {}) {
  if (!confirm) {
    return {
      ok: false,
      error: 'Falta confirmación. Si ya existe un gasto para ese periodo, pregunta si quiere reemplazarlo o sumarlo al actual.'
    }
  }

  const normalizedPeriodType = normalizePeriodType(periodType)
  if (!MANUAL_BUSINESS_EXPENSE_PERIODS.has(normalizedPeriodType)) {
    return { ok: false, error: 'periodType debe ser day, month o year' }
  }

  const normalizedPeriodStart = normalizeManualBusinessExpensePeriodStart(normalizedPeriodType, periodStart)
  if (!normalizedPeriodStart) {
    return { ok: false, error: 'periodStart no tiene formato válido para el periodo indicado' }
  }

  const safeMode = normalizeAdjustmentMode(mode)
  const existing = await getManualExpense(normalizedPeriodType, normalizedPeriodStart)
  const previousAmount = roundCurrencyValue(Number(existing?.amount || 0))
  let nextAmount = 0

  if (safeMode !== 'clear') {
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount < 0) {
      return { ok: false, error: 'amount debe ser un número mayor o igual a 0' }
    }
    nextAmount = safeMode === 'add'
      ? roundCurrencyValue(previousAmount + numericAmount)
      : roundCurrencyValue(numericAmount)
  }

  const mutation = async (database) => {
    const deletedChildCount = resetChildren
      ? await deleteManualBusinessExpenseDescendants(database, normalizedPeriodType, normalizedPeriodStart)
      : 0

    if (safeMode === 'clear') {
      await database.run(
        `DELETE FROM report_manual_business_expenses
         WHERE period_type = ? AND period_start = ?`,
        [normalizedPeriodType, normalizedPeriodStart]
      )
      return { deletedChildCount, row: null }
    }

    await database.run(
      `INSERT INTO report_manual_business_expenses (period_type, period_start, amount, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(period_type, period_start) DO UPDATE SET
         amount = excluded.amount,
         updated_at = CURRENT_TIMESTAMP`,
      [normalizedPeriodType, normalizedPeriodStart, nextAmount]
    )

    const row = await getManualExpense(normalizedPeriodType, normalizedPeriodStart)
    return { deletedChildCount, row }
  }

  const result = resetChildren
    ? await db.transaction(mutation)
    : await mutation(db)

  const range = getManualBusinessExpenseRange({
    period_type: normalizedPeriodType,
    period_start: normalizedPeriodStart
  })
  const effectiveTotalForRange = range
    ? await getManualBusinessExpensesTotalForRange(range)
    : null

  return {
    ok: true,
    mode: safeMode,
    periodType: normalizedPeriodType,
    periodStart: normalizedPeriodStart,
    previousAmount,
    newAmount: safeMode === 'clear' ? 0 : Number(result.row?.amount || nextAmount),
    amountDelta: roundCurrencyValue((safeMode === 'clear' ? 0 : nextAmount) - previousAmount),
    deletedChildCount: result.deletedChildCount,
    effectiveRange: range,
    effectiveTotalForRange,
    expense: result.row ? MANUAL_EXPENSE_FIELDS(normalizeManualBusinessExpenseRow(result.row)) : null
  }
}

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

export const listManualBusinessExpensesTool = tool({
  name: 'list_manual_business_expenses',
  description: 'Lista los gastos/costos variables manuales de reportes guardados por día, mes o año. Úsala antes de cambiar "este mes gasté X" para saber si ya existe un monto.',
  parameters: z.object({
    periodType: z.enum(['day', 'month', 'year']).nullable().describe('Periodo a filtrar'),
    startDate: z.string().nullable().describe('Fecha inicial YYYY-MM-DD para filtrar'),
    endDate: z.string().nullable().describe('Fecha final YYYY-MM-DD para filtrar y calcular total efectivo')
  }),
  execute: async ({ periodType, startDate, endDate }) => listManualBusinessExpenseRecords({ periodType, startDate, endDate })
})

export const setManualBusinessExpenseTool = tool({
  name: 'set_manual_business_expense',
  description: 'Ajusta los costos variables manuales que afectan reportes. mode=add suma al monto actual; mode=replace reemplaza el monto del periodo; mode=clear borra el override. Pregunta y confirma si el usuario quiere sumar o reemplazar antes de ejecutar.',
  parameters: z.object({
    periodType: z.enum(['day', 'month', 'year']).describe('day, month o year'),
    periodStart: z.string().describe('Fecha del periodo. Para mes puede ser YYYY-MM o YYYY-MM-DD; se normaliza al día 01.'),
    amount: z.number().min(0).nullable().describe('Monto a sumar o reemplazar; null solo para clear'),
    mode: z.enum(['add', 'replace', 'clear']).describe('add suma al actual, replace reemplaza el total del periodo, clear borra el registro'),
    resetChildren: z.boolean().nullable().describe('true para borrar overrides hijos (días dentro del mes, meses/días dentro del año) y evitar mezclas raras; default true'),
    confirm: z.boolean().describe('true solo cuando el usuario ya confirmó sumar/reemplazar/borrar')
  }),
  execute: async ({ periodType, periodStart, amount, mode, resetChildren, confirm }) => applyManualBusinessExpenseAdjustment({
    periodType,
    periodStart,
    amount,
    mode,
    resetChildren: resetChildren !== false,
    confirm
  })
})

export const expenseReadTools = [listCostsTool, listManualBusinessExpensesTool]
export const expenseWriteTools = [createCostTool, updateCostTool, deleteCostTool, setManualBusinessExpenseTool]
export const expenseTools = [...expenseReadTools, ...expenseWriteTools]
