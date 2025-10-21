const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'] as const
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const

const capitalize = (value: string): string => {
  if (!value) return ''
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const NAME_CONNECTORS = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'da',
  'do',
  'dos',
  'das',
  'van',
  'von',
  'al'
])

const capitalizeCompoundSegment = (segment: string): string => {
  if (!segment) return ''
  return segment.charAt(0).toUpperCase() + segment.slice(1)
}

const formatCompoundWord = (word: string): string => {
  return word
    .split(/([-'])/)
    .map(segment => {
      if (segment === '-' || segment === '\'') {
        return segment
      }
      return capitalizeCompoundSegment(segment)
    })
    .join('')
}

/**
 * Formatea parámetros UTM y de campaña que vienen de URLs
 * Convierte "Retargeting+-+Testimoniales" a "Retargeting Testimoniales"
 * Limpia caracteres de codificación URL como +, -, %20, etc.
 * @param value - El parámetro URL a formatear
 * @returns El parámetro formateado y limpio
 */
export const formatUrlParameter = (value?: string | null): string => {
  if (!value) return ''

  // Primero decodificar completamente la URL si está codificada
  let decoded = value
  try {
    // Intentar decodificar si tiene caracteres encoded
    if (value.includes('%')) {
      decoded = decodeURIComponent(value)
    }
  } catch (e) {
    // Si falla la decodificación, usar el valor original
    decoded = value
  }

  // Ahora limpiar los caracteres especiales
  return decoded
    // Reemplazar + con espacio (los + son espacios en URLs)
    .replace(/\+/g, ' ')
    // Reemplazar guiones múltiples o guiones con espacios alrededor
    .replace(/\s*-+\s*/g, ' ')
    // Reemplazar underscores con espacios
    .replace(/_/g, ' ')
    // Limpiar espacios múltiples
    .replace(/\s+/g, ' ')
    // Trim espacios al inicio y final
    .trim()
    // Capitalizar primera letra de cada palabra (opcional, puedes comentar si prefieres mantener el caso original)
    .split(' ')
    .map(word => {
      if (!word) return ''
      // Si la palabra es toda mayúsculas o toda minúsculas, capitalizar
      // Si tiene mixed case, mantenerlo (ej: "iPhone" no se convierte a "Iphone")
      if (word === word.toUpperCase() || word === word.toLowerCase()) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      }
      return word
    })
    .join(' ')
}

export const formatName = (value?: string | null): string => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const lowercase = trimmed.toLowerCase()
  const uppercase = trimmed.toUpperCase()
  const shouldNormalize =
    trimmed === lowercase ||
    (trimmed === uppercase && /\s/.test(trimmed))

  if (!shouldNormalize) {
    return trimmed
  }

  const words = lowercase
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && NAME_CONNECTORS.has(word)) {
        return word
      }
      return formatCompoundWord(word)
    })

  return words.join(' ')
}

/**
 * Parsea una fecha YYYY-MM-DD como hora LOCAL (no UTC)
 * Esto evita problemas donde new Date("2025-10-05") lo parsea como UTC
 */
export const parseLocalDateString = (dateStr: string): Date => {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day, 0, 0, 0, 0)
}

/**
 * Formatea una fecha a YYYY-MM-DD usando la zona horaria LOCAL (no UTC)
 * Esto evita problemas donde toISOString() cambia el día al convertir a UTC
 */
export const formatDateToISO = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Formatea una fecha de fin para incluir TODO el día (hasta 23:59:59) en formato ISO
 * Usa esto para endDate en queries que necesitan ser inclusivos
 */
export const formatEndDateToISO = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}T23:59:59`
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
  if (!parsed) return dateStr || ''

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
    const capitalizedMonth = capitalize(shortMonth)
    return yearChanged ? `${capitalizedMonth} ${year}` : capitalizedMonth
  }

  if (containsTime && rangeInDays <= 1) {
    return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) || ''
  }

  // Si tiene día específico, siempre mostrar día + mes
  if (hasDay) {
    const day = date.getDate()
    return yearChanged ? `${day} ${shortMonth} ${year}` : `${day} ${shortMonth}`
  }

  const capitalizedMonth = capitalize(shortMonth)
  return yearChanged ? `${capitalizedMonth} ${year}` : capitalizedMonth
}

/**
 * Formatea una fecha/hora ISO a formato 12 horas (ej: "02:30 PM")
 */
export const formatTime12h = (dateStr: string): string => {
  if (!dateStr) return '—';

  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '—';

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hours12 = hours % 12 || 12;

  return `${String(hours12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

/**
 * Formatea números de manera inteligente para gráficas
 * - Menos de 1,000: muestra el número completo
 * - Entre 1,000 y 999,999: muestra en miles (K)
 * - Más de 1,000,000: muestra en millones (M)
 */
export const formatChartNumber = (value: number): string => {
  const absValue = Math.abs(value)

  if (absValue >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions.toFixed(1)}M`
  }

  if (absValue >= 1_000) {
    const thousands = value / 1_000
    return `${thousands.toFixed(1)}K`
  }

  return Math.round(value).toString()
}

/**
 * Formatea moneda de manera inteligente para gráficas
 * - Menos de $10,000: muestra el número completo con formato de moneda
 * - Entre $10,000 y $999,999: muestra en miles (K)
 * - Más de $1,000,000: muestra en millones (M)
 */
export const formatChartCurrency = (value: number): string => {
  const absValue = Math.abs(value)

  if (absValue >= 1_000_000) {
    const millions = value / 1_000_000
    return `$${millions.toFixed(1)}M`
  }

  if (absValue >= 10_000) {
    const thousands = value / 1_000
    return `$${thousands.toFixed(1)}K`
  }

  return formatCurrency(value)
}
