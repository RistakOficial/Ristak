const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'] as const
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const

const capitalize = (value: string): string => {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Formatea una fecha a YYYY-MM-DD usando la zona horaria LOCAL (no UTC)
 * Esto evita problemas donde toISOString() cambia el día al convertir a UTC
 */
export const formatDateToISO = (date: Date): string => {
  console.log('🔧 formatDateToISO - Input Date:', date)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const result = `${year}-${month}-${day}`
  console.log('🔧 formatDateToISO - Output:', result, '| Original ISO:', date.toISOString())
  return result
}

export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value)
}

export const formatNumber = (value: number): string => {
  return new Intl.NumberFormat('es-MX').format(value)
}

export const formatPercent = (value: number): string => {
  return `${value.toFixed(1)}%`
}

export const formatRoas = (value: number): string => {
  return `${value.toFixed(2)}x`
}

interface FormatDateOptions {
  includeYear?: boolean
  referenceDate?: Date
  padDay?: boolean
}

export const formatDate = (
  date: string | Date | null | undefined,
  options: FormatDateOptions = {}
): string => {
  if (!date) return '—'

  const parsedDate = typeof date === 'string' ? new Date(date) : date

  if (Number.isNaN(parsedDate.getTime())) return '—'

  const padDay = options.padDay ?? true
  const day = padDay
    ? parsedDate.getDate().toString().padStart(2, '0')
    : parsedDate.getDate().toString()
  const monthLabel = MONTHS_SHORT[parsedDate.getMonth()] ?? ''
  const year = parsedDate.getFullYear()

  const referenceYear = options.referenceDate?.getFullYear() ?? new Date().getFullYear()
  const shouldIncludeYear =
    typeof options.includeYear === 'boolean'
      ? options.includeYear
      : year !== referenceYear

  return shouldIncludeYear ? `${day} ${monthLabel} ${year}` : `${day} ${monthLabel}`
}

interface ParsedChartDate {
  date: Date
  hasMonth: boolean
  hasDay: boolean
  containsTime: boolean
}

const parseChartDateInput = (value: string): ParsedChartDate | null => {
  if (!value) return null

  const trimmed = value.trim()
  const isoDay = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/
  const isoMonth = /^([0-9]{4})-([0-9]{2})$/
  const isoYear = /^([0-9]{4})$/

  const dayMatch = isoDay.exec(trimmed)
  if (dayMatch) {
    const [, year, month, day] = dayMatch
    const date = new Date(Number(year), Number(month) - 1, Number(day))
    return { date, hasMonth: true, hasDay: true, containsTime: trimmed.includes('T') }
  }

  const monthMatch = isoMonth.exec(trimmed)
  if (monthMatch) {
    const [, year, month] = monthMatch
    const date = new Date(Number(year), Number(month) - 1, 1)
    return { date, hasMonth: true, hasDay: false, containsTime: false }
  }

  const yearMatch = isoYear.exec(trimmed)
  if (yearMatch) {
    const [, year] = yearMatch
    const date = new Date(Number(year), 0, 1)
    return { date, hasMonth: false, hasDay: false, containsTime: false }
  }

  const parsed = new Date(trimmed)
  if (!Number.isNaN(parsed.getTime())) {
    return {
      date: parsed,
      hasMonth: true,
      hasDay: true,
      containsTime: trimmed.includes('T')
    }
  }

  return null
}

export const formatChartDate = (dateStr: string, rangeInDays: number, previousDateStr?: string): string => {
  const parsed = parseChartDateInput(dateStr)
  if (!parsed) return dateStr

  const { date, hasMonth, hasDay, containsTime } = parsed
  const monthIndex = date.getMonth()
  const shortMonth = MONTHS_SHORT[monthIndex] ?? ''
  const year = date.getFullYear()

  if (!hasMonth) {
    return year.toString()
  }

  // Detectar si cambió el año comparando con la fecha anterior
  let yearChanged = false
  if (previousDateStr) {
    const prevParsed = parseChartDateInput(previousDateStr)
    if (prevParsed && prevParsed.date.getFullYear() !== year) {
      yearChanged = true
    }
  }

  if (!hasDay) {
    return yearChanged ? `${capitalize(shortMonth)} ${year}` : capitalize(shortMonth)
  }

  if (containsTime && rangeInDays <= 1) {
    return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
  }

  // Si tiene día específico, siempre mostrar día + mes
  if (hasDay) {
    return yearChanged ? `${date.getDate()} ${shortMonth} ${year}` : `${date.getDate()} ${shortMonth}`
  }

  return yearChanged ? `${capitalize(shortMonth)} ${year}` : capitalize(shortMonth)
}
