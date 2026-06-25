import { db } from '../config/database.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export const MANUAL_BUSINESS_EXPENSE_PERIODS = new Set(['day', 'month', 'year'])

const parseDateKeyParts = (value) => {
  const sanitized = String(value || '').includes('T')
    ? String(value || '').split('T')[0]
    : String(value || '')
  const [yearRaw, monthRaw = '01', dayRaw = '01'] = sanitized.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null
  }

  return { year, month, day }
}

const toUtcDayIndex = (value) => {
  const parts = parseDateKeyParts(value)
  if (!parts) return null
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY)
}

const getLastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export const normalizeManualBusinessExpensePeriodStart = (periodType, periodStart) => {
  const raw = String(periodStart || '').trim()

  if (periodType === 'day') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
    return raw
  }

  if (periodType === 'month') {
    const match = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/)
    if (!match) return null
    const month = Number(match[2])
    if (month < 1 || month > 12) return null
    return `${match[1]}-${match[2]}-01`
  }

  if (periodType === 'year') {
    const match = raw.match(/^(\d{4})(?:-\d{2}-\d{2})?$/)
    if (!match) return null
    return `${match[1]}-01-01`
  }

  return null
}

export const normalizeManualBusinessExpenseRow = (row) => ({
  period_type: row.period_type,
  period_start: row.period_start,
  amount: Number(row.amount || 0)
})

export const getManualBusinessExpenseRange = (expense) => {
  const parts = parseDateKeyParts(expense.period_start)
  if (!parts) return null

  if (expense.period_type === 'day') {
    return { from: expense.period_start, to: expense.period_start }
  }

  if (expense.period_type === 'month') {
    const month = String(parts.month).padStart(2, '0')
    const lastDay = String(getLastDayOfMonth(parts.year, parts.month)).padStart(2, '0')
    return { from: `${parts.year}-${month}-01`, to: `${parts.year}-${month}-${lastDay}` }
  }

  if (expense.period_type === 'year') {
    return { from: `${parts.year}-01-01`, to: `${parts.year}-12-31` }
  }

  return null
}

export const getManualBusinessExpenseDescendantScope = (periodType, periodStart) => {
  const normalizedPeriodStart = normalizeManualBusinessExpensePeriodStart(periodType, periodStart)
  if (!normalizedPeriodStart || periodType === 'day') return null

  const range = getManualBusinessExpenseRange({
    period_type: periodType,
    period_start: normalizedPeriodStart
  })
  if (!range) return null

  if (periodType === 'month') {
    return {
      from: range.from,
      to: range.to,
      periodTypes: ['day']
    }
  }

  if (periodType === 'year') {
    return {
      from: range.from,
      to: range.to,
      periodTypes: ['day', 'month']
    }
  }

  return null
}

export const deleteManualBusinessExpenseDescendants = async (database, periodType, periodStart) => {
  const scope = getManualBusinessExpenseDescendantScope(periodType, periodStart)
  if (!scope) return 0

  const periodTypePlaceholders = scope.periodTypes.map(() => '?').join(', ')
  const result = await database.run(`
    DELETE FROM report_manual_business_expenses
    WHERE period_type IN (${periodTypePlaceholders})
      AND period_start >= ?
      AND period_start <= ?
  `, [...scope.periodTypes, scope.from, scope.to])

  return Number(result?.changes || 0)
}

export const roundCurrencyValue = (value) => Math.round((value + Number.EPSILON) * 100) / 100

// (RPT-001) Prorrateo de costos fijos mensuales por la longitud del rango.
// Los costos fijos configurados son MENSUALES: cada mes aporta su monto completo.
// Para cualquier rango objetivo (día, mes, año o rango libre) se prorratea mes a mes:
// cada mes contribuye monthlyValue * (díasDelMesDentroDelRango / díasTotalesDelMes).
// Así un día = monthlyValue / díasDelMes, un mes completo = monthlyValue
// y un año completo = monthlyValue * 12. Misma fórmula que el reporte (Reports.tsx).
export const calculateMonthlyFixedCostForRange = (targetRange, monthlyValue) => {
  const value = Number(monthlyValue)
  if (!Number.isFinite(value) || value <= 0) return 0

  const startParts = parseDateKeyParts(targetRange?.from)
  const endParts = parseDateKeyParts(targetRange?.to)
  if (!startParts || !endParts) return 0

  const targetStart = toUtcDayIndex(targetRange.from)
  const targetEnd = toUtcDayIndex(targetRange.to)
  if (targetStart === null || targetEnd === null || targetEnd < targetStart) return 0

  let total = 0
  let year = startParts.year
  let month = startParts.month

  while (year < endParts.year || (year === endParts.year && month <= endParts.month)) {
    const daysInMonth = getLastDayOfMonth(year, month)
    const monthStart = toUtcDayIndex(`${year}-${String(month).padStart(2, '0')}-01`)

    if (monthStart !== null) {
      const monthEnd = monthStart + daysInMonth - 1
      const overlapStart = Math.max(targetStart, monthStart)
      const overlapEnd = Math.min(targetEnd, monthEnd)

      if (overlapEnd >= overlapStart) {
        const overlapDays = overlapEnd - overlapStart + 1
        total += (value * overlapDays) / daysInMonth
      }
    }

    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }

  return total
}

const MANUAL_BUSINESS_EXPENSE_PRIORITY = {
  year: 1,
  month: 2,
  day: 3
}

const buildManualBusinessExpenseAllocation = (expense) => {
  const amount = Number(expense.amount ?? 0)
  if (!Number.isFinite(amount) || amount < 0) return null

  const sourceRange = getManualBusinessExpenseRange(expense)
  if (!sourceRange) return null

  const sourceStart = toUtcDayIndex(sourceRange.from)
  const sourceEnd = toUtcDayIndex(sourceRange.to)
  if (sourceStart === null || sourceEnd === null || sourceEnd < sourceStart) return null

  const sourceDays = sourceEnd - sourceStart + 1
  const priority = MANUAL_BUSINESS_EXPENSE_PRIORITY[expense.period_type] || 0
  if (priority <= 0) return null

  return {
    start: sourceStart,
    end: sourceEnd,
    priority,
    amountPerDay: amount / sourceDays
  }
}

export const calculateManualBusinessExpensesForRange = (targetRange, expenses = []) => {
  const targetStart = toUtcDayIndex(targetRange?.from)
  const targetEnd = toUtcDayIndex(targetRange?.to)

  if (targetStart === null || targetEnd === null || targetEnd < targetStart) return 0

  const allocations = expenses
    .map(buildManualBusinessExpenseAllocation)
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority)

  let total = 0

  for (let day = targetStart; day <= targetEnd; day += 1) {
    const allocation = allocations.find((item) => day >= item.start && day <= item.end)
    if (allocation) {
      total += allocation.amountPerDay
    }
  }

  return roundCurrencyValue(total)
}

export const getManualBusinessExpensesTotalForRange = async (targetRange) => {
  if (!targetRange?.from || !targetRange?.to) return 0

  const expenses = await db.all(`
    SELECT period_type, period_start, amount
    FROM report_manual_business_expenses
  `)

  return calculateManualBusinessExpensesForRange(
    targetRange,
    expenses.map(normalizeManualBusinessExpenseRow)
  )
}
