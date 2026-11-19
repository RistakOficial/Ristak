import {
  getPhoneDailyCacheKey, readPhoneDailyCache, removePhoneDailyCache, writePhoneDailyCache
} from '@/services/phoneDailyCache'
import { getAuthScopedCachePrincipalFingerprint } from '@/services/authPrincipalCache'
import { refreshAnalyticsRead } from './refreshAnalyticsRead'

export interface AnalyticsPeriodQuery {
  scope: string
  period: string
  rangeKey: string
  through: string
  timezone: string
}

interface PeriodReading<T> {
  through: string
  data: T
}

function periodKey(query: AnalyticsPeriodQuery, filters: string[]) {
  return getPhoneDailyCacheKey(query.scope, 'period', query.period, ...filters)
}

export function savePeriodReading<T>(query: AnalyticsPeriodQuery, filters: string[], reading: PeriodReading<T>) {
  const key = periodKey(query, filters)
  const existing = readPhoneDailyCache<PeriodReading<T>>(key, query.timezone)?.data
  if (existing && existing.through > reading.through) return
  writePhoneDailyCache(key, reading, { retainAcrossDays: true }, query.timezone)
}

// Una sola copia por selector y filtros. Su fecha es el último día incluido en
// la consulta, incluso si la respuesta cruza la medianoche del negocio.
export function refreshPeriodReading<T>(
  query: AnalyticsPeriodQuery,
  filters: string[],
  callbacks: {
    read: (signal: AbortSignal) => Promise<T>
    apply: (data: T, through: string, live: boolean) => void
    denied: () => void
    isCurrent?: () => boolean
    legacyFilters?: string[]
  }
) {
  const key = periodKey(query, filters)
  const legacyKey = getPhoneDailyCacheKey(query.scope, query.rangeKey, ...(callbacks.legacyFilters ?? filters))
  const principal = getAuthScopedCachePrincipalFingerprint()
  const isCurrent = () => principal === getAuthScopedCachePrincipalFingerprint() && (callbacks.isCurrent?.() ?? true)
  return refreshAnalyticsRead<PeriodReading<T>>({
    read: async signal => ({ data: await callbacks.read(signal), through: query.through }),
    cached: () => {
      if (!isCurrent()) return null
      const saved = readPhoneDailyCache<PeriodReading<T>>(key, query.timezone)?.data
      if (saved?.through === query.through) return saved
      const legacy = readPhoneDailyCache<T>(legacyKey, query.timezone)
      if (legacy) {
        const reading = { data: legacy.data, through: query.through }
        savePeriodReading(query, filters, reading)
        return reading
      }
      return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved.through) && saved.through < query.through ? saved : null
    },
    apply: (reading, live) => {
      if (!isCurrent()) return
      if (live) savePeriodReading(query, filters, reading)
      callbacks.apply(reading.data, reading.through, live)
    },
    denied: () => {
      if (!isCurrent()) return
      removePhoneDailyCache(key)
      removePhoneDailyCache(legacyKey)
      callbacks.denied()
    }
  })
}


// Un panel que ya se actualizó sale del aviso aunque otro siga mostrando un
// corte anterior. Las secciones en espera o sin permiso llegan sin fecha.
export function getSavedAnalyticsSections(today: string, sections: Array<[string, string | false]>) {
  const dates = new Map<string, string[]>()
  for (const [label, through] of sections) {
    if (!through || through >= today) continue
    dates.set(through, [...(dates.get(through) ?? []), label])
  }
  return dates
}
