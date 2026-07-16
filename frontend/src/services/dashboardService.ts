// Servicio para el Dashboard principal
import { apiUrl } from './apiBaseUrl'
import { formatDateToISO, formatEndDateToISO } from '@/utils/format'
import type { CalendarEvent } from './calendarsService'
import type { ContactListItem } from './reportsService'
import type { Transaction } from './transactionsService'
import type { WhatsAppApiPhoneNumber } from './whatsappApiService'
import { trackingService, type CursorPage } from './trackingService'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import {
  registerRistakApiReadCacheInvalidator,
  type ApiReadCacheInvalidationContext
} from './authFetch'
import {
  abortAndClearSharedRequests,
  getOrCreateSharedRequest
} from './sharedRequest'
import { RequestTimeoutError, withRequestTimeout } from './requestTimeout'

export interface DashboardKPI {
  value: number;
  variation: number;
}

export interface DashboardMetrics {
  ingresosNetos: DashboardKPI;
  gastosPublicidad: DashboardKPI;
  gananciaBruta: DashboardKPI;
  roas: DashboardKPI;
  totalCostos: DashboardKPI;
  gananciaNeta: DashboardKPI;
  reembolsos: DashboardKPI;
  ltvPromedio: DashboardKPI;
}

export interface DashboardOperationalSnapshot {
  transactions: Transaction[];
  contacts: ContactListItem[];
  appointments: CalendarEvent[];
}

export interface ChartData {
  date: string;
  ingresos: number;
  gastado: number;
  ganancia?: number;
}

type DashboardFunnelScope = 'all' | 'attribution' | 'campaigns';

export interface DashboardVisitorDetail {
  visitorId: string;
  sessionId?: string;
  contactId?: string | null;
  createdAt?: string;
  firstVisit?: string;
  pageUrl?: string | null;
  referrerUrl?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  deviceType?: string | null;
  browser?: string | null;
  os?: string | null;
  language?: string | null;
  adId?: string | null;
  adName?: string | null;
  contact?: {
    id?: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    ltv?: number;
    purchases?: number;
    appointments?: any[];
    hasAttendedAppointment?: boolean;
  } | null;
}

export interface DashboardVisitorsPageParams {
  start: Date;
  end: Date;
  scope?: DashboardFunnelScope;
  cursor?: string | null;
  search?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface SourceDatum {
  name: string;
  value: number;
  color?: string;
}

export interface WhatsAppNumberOriginDatum extends SourceDatum {
  phoneNumberId?: string | null;
  phoneNumber?: string | null;
  displayPhoneNumber?: string | null;
  status?: string | null;
  apiSendEnabled?: boolean;
  qrSendEnabled?: boolean;
}

export interface OriginDistributionData {
  traffic: {
    sources: SourceDatum[];
    platforms: SourceDatum[];
    devices: SourceDatum[];
    placements: SourceDatum[];
    browsers: SourceDatum[];
    os: SourceDatum[];
  };
  leads: SourceDatum[];
  appointments: SourceDatum[];
  conversions: SourceDatum[];
  whatsappNumbers?: WhatsAppNumberOriginDatum[];
}

export type OriginTrafficDimension = 'sources' | 'platforms' | 'devices' | 'placements' | 'browsers' | 'os'

export interface DashboardMobileAnalyticsSnapshot {
  metrics: DashboardMetrics;
  origin: OriginDistributionData;
  funnel: Array<{ stage: string; value: number }>;
  financialChart: Array<{ label: string; value: number; value2: number }>;
  whatsappPhoneNumbers: WhatsAppApiPhoneNumber[];
  scopes: {
    funnel: DashboardFunnelScope;
    financial: DashboardFunnelScope;
  };
  range: {
    start: string;
    end: string;
    timezone: string;
  };
}

const EMPTY_ORIGIN_DISTRIBUTION: OriginDistributionData = {
  traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
  leads: [],
  appointments: [],
  conversions: [],
  whatsappNumbers: []
};

const DASHBOARD_METRICS_FRESH_MS = 30_000
const DASHBOARD_METRICS_STALE_MS = 5 * 60_000
const DASHBOARD_REQUEST_TIMEOUT_MS = 20_000
// La cola no extiende el loader hasta 40-45 s. Si los dos carriles siguen
// ocupados diez segundos, esa zona falla de forma local y reintentable; el
// presupuesto de ejecución de 20 s empieza sólo cuando la lectura es admitida.
const DASHBOARD_HEAVY_QUEUE_TIMEOUT_MS = 10_000
const dashboardMetricsSnapshots = new Map<string, { data: DashboardMetrics; fetchedAt: number }>()
const dashboardMetricsInflight = new Map<string, Promise<DashboardMetrics>>()
let dashboardMetricsRevision = 0
const ORIGIN_DISTRIBUTION_CACHE_LIMIT = 24
const originDistributionSnapshots = new Map<string, { data: OriginDistributionData; fetchedAt: number }>()
const originDistributionInflight = new Map<string, Promise<OriginDistributionData>>()
let originDistributionRevision = 0
const MOBILE_ANALYTICS_FRESH_MS = 30_000
const MOBILE_ANALYTICS_STALE_MS = 5 * 60_000
const MOBILE_ANALYTICS_CACHE_LIMIT = 8
const mobileAnalyticsSnapshots = new Map<string, { data: DashboardMobileAnalyticsSnapshot; fetchedAt: number }>()
const mobileAnalyticsInflight = new Map<string, Promise<DashboardMobileAnalyticsSnapshot>>()
let mobileAnalyticsRevision = 0

const DASHBOARD_HEAVY_PRIORITY = {
  metrics: 0,
  operational: 1,
  financial: 2,
  extendedChart: 3,
  funnel: 4,
  trafficSources: 5,
  origin: 6
} as const
const DASHBOARD_HEAVY_REQUEST_CONCURRENCY = 2

type DashboardHeavyRequestEntry = {
  priority: number;
  sequence: number;
  request: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  cleanup: () => void;
}

const dashboardHeavyRequestQueue: DashboardHeavyRequestEntry[] = []
let dashboardHeavyRequestActiveCount = 0
let dashboardHeavyRequestSequence = 0
let dashboardHeavyPumpScheduled = false

function dashboardQueueAbortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('La carga del Dashboard fue cancelada', 'AbortError')
}

function pumpDashboardHeavyRequestQueue() {
  if (dashboardHeavyRequestActiveCount >= DASHBOARD_HEAVY_REQUEST_CONCURRENCY) return

  dashboardHeavyRequestQueue.sort((left, right) => (
    left.priority - right.priority || left.sequence - right.sequence
  ))

  while (
    dashboardHeavyRequestActiveCount < DASHBOARD_HEAVY_REQUEST_CONCURRENCY
    && dashboardHeavyRequestQueue.length > 0
  ) {
    const entry = dashboardHeavyRequestQueue.shift()!
    entry.cleanup()
    if (entry.signal?.aborted) {
      entry.reject(dashboardQueueAbortError(entry.signal))
      continue
    }

    dashboardHeavyRequestActiveCount += 1
    Promise.resolve()
      .then(entry.request)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        dashboardHeavyRequestActiveCount = Math.max(0, dashboardHeavyRequestActiveCount - 1)
        scheduleDashboardHeavyRequestPump()
      })
  }
}

function scheduleDashboardHeavyRequestPump() {
  if (
    dashboardHeavyRequestActiveCount >= DASHBOARD_HEAVY_REQUEST_CONCURRENCY
    || dashboardHeavyPumpScheduled
  ) return
  dashboardHeavyPumpScheduled = true
  // Agrupar el mismo flush de effects permite que métricas/resumen operativo
  // ganen prioridad aunque una card hija se haya montado primero.
  void Promise.resolve().then(() => {
    dashboardHeavyPumpScheduled = false
    pumpDashboardHeavyRequestQueue()
  })
}

function scheduleDashboardHeavyRequest<T>(
  request: () => Promise<T>,
  {
    signal,
    priority,
    queueTimeoutMs = DASHBOARD_HEAVY_QUEUE_TIMEOUT_MS,
    queueTimeoutMessage = 'El Dashboard sigue ocupado. Reintenta la carga.'
  }: {
    signal?: AbortSignal;
    priority: number;
    queueTimeoutMs?: number;
    queueTimeoutMessage?: string;
  }
): Promise<T> {
  if (signal?.aborted) return Promise.reject(dashboardQueueAbortError(signal))

  return new Promise<T>((resolve, reject) => {
    let queueTimeoutId: ReturnType<typeof setTimeout> | null = null
    const entry: DashboardHeavyRequestEntry = {
      priority,
      sequence: dashboardHeavyRequestSequence++,
      request,
      resolve: value => resolve(value as T),
      reject,
      signal,
      cleanup: () => {}
    }
    const rejectWhileQueued = (error: unknown) => {
      const index = dashboardHeavyRequestQueue.indexOf(entry)
      if (index < 0) return
      dashboardHeavyRequestQueue.splice(index, 1)
      entry.cleanup()
      reject(error)
    }
    const onAbort = () => {
      rejectWhileQueued(dashboardQueueAbortError(signal))
    }
    const onQueueTimeout = () => {
      rejectWhileQueued(new RequestTimeoutError(queueTimeoutMessage))
    }
    entry.cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (queueTimeoutId !== null) {
        globalThis.clearTimeout(queueTimeoutId)
        queueTimeoutId = null
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queueTimeoutId = globalThis.setTimeout(onQueueTimeout, queueTimeoutMs)

    // Cerrar la carrera entre el check inicial y el listener: una navegación
    // rápida nunca debe dejar una entrada muerta ocupando la cola.
    if (signal?.aborted) {
      entry.cleanup()
      reject(dashboardQueueAbortError(signal))
      return
    }

    dashboardHeavyRequestQueue.push(entry)
    scheduleDashboardHeavyRequestPump()
  })
}

function scheduleDashboardHeavyRead<T>({
  request,
  signal,
  priority,
  timeoutMessage
}: {
  request: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  priority: number;
  timeoutMessage: string;
}): Promise<T> {
  // La espera de cola tiene su propio límite. El presupuesto de ejecución/red
  // empieza únicamente cuando el scheduler admite esta familia pesada.
  return scheduleDashboardHeavyRequest(
    () => withRequestTimeout({
      timeoutMs: DASHBOARD_REQUEST_TIMEOUT_MS,
      timeoutMessage,
      signal,
      request
    }),
    { signal, priority }
  )
}

function clearDashboardMetricSnapshots(
  { abortInflight = true }: Partial<ApiReadCacheInvalidationContext> = {}
) {
  if (!abortInflight) return
  dashboardMetricsRevision += 1
  originDistributionRevision += 1
  dashboardMetricsSnapshots.clear()
  originDistributionSnapshots.clear()
  abortAndClearSharedRequests(dashboardMetricsInflight)
  abortAndClearSharedRequests(originDistributionInflight)
}

registerAuthScopedCacheInvalidator(clearDashboardMetricSnapshots)
registerRistakApiReadCacheInvalidator(clearDashboardMetricSnapshots, {
  pathPrefixes: ['/api/dashboard']
})

function clearMobileAnalyticsSnapshots(
  { abortInflight = true }: Partial<ApiReadCacheInvalidationContext> = {}
) {
  if (!abortInflight) return
  mobileAnalyticsRevision += 1
  mobileAnalyticsSnapshots.clear()
  abortAndClearSharedRequests(mobileAnalyticsInflight)
}

registerAuthScopedCacheInvalidator(clearMobileAnalyticsSnapshots)
registerRistakApiReadCacheInvalidator(clearMobileAnalyticsSnapshots, {
  pathPrefixes: ['/api/dashboard']
})

function dashboardMetricsKey(params: { start: Date; end: Date }) {
  return `${formatDateToISO(params.start)}:${formatEndDateToISO(params.end)}`
}

function originDistributionKey(params: {
  start: Date;
  end: Date;
  includeWeb?: boolean;
  includeWhatsapp?: boolean;
  dimension?: OriginTrafficDimension;
  includeBreakdowns?: boolean;
  includePhoneBreakdown?: boolean;
}) {
  return [
    formatDateToISO(params.start),
    formatEndDateToISO(params.end),
    params.includeWeb === false ? 'no-web' : 'web',
    params.includeWhatsapp === false ? 'no-whatsapp' : 'whatsapp',
    params.dimension || 'all-dimensions',
    params.includeBreakdowns === false ? 'traffic-only' : 'with-breakdowns',
    params.includePhoneBreakdown === true
      ? 'with-phone-breakdown'
      : (params.includePhoneBreakdown === false ? 'without-phone-breakdown' : 'phone-default')
  ].join(':')
}

function mobileAnalyticsKey(params: {
  start: Date;
  end: Date;
  includeWeb?: boolean;
  funnelScope?: DashboardFunnelScope;
  financialScope?: DashboardFunnelScope;
  includePhoneBreakdown?: boolean;
}) {
  return [
    formatDateToISO(params.start),
    formatEndDateToISO(params.end),
    params.includeWeb === false ? 'no-web' : 'web',
    params.funnelScope || 'all',
    params.financialScope || 'all',
    params.includePhoneBreakdown === false ? 'without-phone-breakdown' : 'phone-default'
  ].join(':')
}

async function fetchDashboardSeries(
  path: string,
  queryParams: URLSearchParams,
  signal: AbortSignal | undefined,
  label: string
): Promise<{ label: string; value: number }[]> {
  return scheduleDashboardHeavyRead({
    timeoutMessage: `${label} tardó demasiado. Reintenta la carga.`,
    signal,
    priority: DASHBOARD_HEAVY_PRIORITY.extendedChart,
    request: async requestSignal => {
      const response = await fetch(apiUrl(`${path}?${queryParams}`), { signal: requestSignal })
      if (!response.ok) throw new Error(`No se pudo cargar ${label.toLocaleLowerCase('es-MX')}`)
      const data = await response.json()
      if (!Array.isArray(data)) throw new Error(`${label} respondió con datos incompletos`)
      return data
    }
  })
}

class DashboardService {
  peekMobileAnalyticsSnapshot(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    funnelScope?: DashboardFunnelScope;
    financialScope?: DashboardFunnelScope;
    includePhoneBreakdown?: boolean;
  }): DashboardMobileAnalyticsSnapshot | null {
    syncAuthScopedCachePrincipal()
    const key = mobileAnalyticsKey(params)
    const cached = mobileAnalyticsSnapshots.get(key)
    if (!cached) return null
    if (Date.now() - cached.fetchedAt >= MOBILE_ANALYTICS_STALE_MS) {
      mobileAnalyticsSnapshots.delete(key)
      return null
    }
    mobileAnalyticsSnapshots.delete(key)
    mobileAnalyticsSnapshots.set(key, cached)
    return cached.data
  }

  async getMobileAnalyticsSnapshot(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    funnelScope?: DashboardFunnelScope;
    financialScope?: DashboardFunnelScope;
    includePhoneBreakdown?: boolean;
  }, options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<DashboardMobileAnalyticsSnapshot> {
    syncAuthScopedCachePrincipal()
    const principalRevision = getAuthScopedCacheRevision()
    const snapshotRevision = mobileAnalyticsRevision
    const key = mobileAnalyticsKey(params)
    const cached = mobileAnalyticsSnapshots.get(key)
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < MOBILE_ANALYTICS_FRESH_MS) {
      return cached.data
    }

    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      includeWeb: params.includeWeb === false ? '0' : '1',
      funnelScope: params.funnelScope || 'all',
      financialScope: params.financialScope || 'all'
    })
    if (params.includePhoneBreakdown !== undefined) {
      queryParams.set('includePhoneBreakdown', params.includePhoneBreakdown ? '1' : '0')
    }
    return getOrCreateSharedRequest({
      inflight: mobileAnalyticsInflight,
      key,
      signal: options.signal,
      abortWhenUnused: true,
      createRequest: sharedSignal => scheduleDashboardHeavyRead({
        timeoutMessage: 'Analíticas móvil tardó demasiado. Reintenta la carga.',
        signal: sharedSignal,
        priority: DASHBOARD_HEAVY_PRIORITY.metrics,
        request: async signal => {
          const response = await fetch(apiUrl(`/api/dashboard/mobile-analytics-snapshot?${queryParams}`), { signal })
          if (!response.ok) throw new Error('No se pudo cargar Analíticas móvil')
          const result = await response.json()
          const data = result?.data as DashboardMobileAnalyticsSnapshot | undefined
          if (!data?.metrics || !data?.origin || !Array.isArray(data.funnel) || !Array.isArray(data.financialChart)) {
            throw new Error('El snapshot de Analíticas móvil está incompleto')
          }

          if (
            principalRevision === getAuthScopedCacheRevision()
            && snapshotRevision === mobileAnalyticsRevision
          ) {
            while (mobileAnalyticsSnapshots.size >= MOBILE_ANALYTICS_CACHE_LIMIT) {
              const oldest = mobileAnalyticsSnapshots.keys().next().value
              if (!oldest) break
              mobileAnalyticsSnapshots.delete(oldest)
            }
            mobileAnalyticsSnapshots.set(key, { data, fetchedAt: Date.now() })
          }
          return data
        }
      })
    })
  }

  peekDashboardMetrics(params: { start: Date; end: Date }): DashboardMetrics | null {
    syncAuthScopedCachePrincipal()
    const key = dashboardMetricsKey(params)
    const cached = dashboardMetricsSnapshots.get(key)
    if (!cached) return null
    if (Date.now() - cached.fetchedAt >= DASHBOARD_METRICS_STALE_MS) {
      dashboardMetricsSnapshots.delete(key)
      return null
    }
    dashboardMetricsSnapshots.delete(key)
    dashboardMetricsSnapshots.set(key, cached)
    return cached.data
  }

  async getDashboardMetrics(params: {
    start: Date;
    end: Date;
  }, options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<DashboardMetrics> {
    syncAuthScopedCachePrincipal()
    const principalRevision = getAuthScopedCacheRevision()
    const snapshotRevision = dashboardMetricsRevision
    const key = dashboardMetricsKey(params)
    const cached = dashboardMetricsSnapshots.get(key)
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < DASHBOARD_METRICS_FRESH_MS) {
      return cached.data
    }
    return getOrCreateSharedRequest({
      inflight: dashboardMetricsInflight,
      key,
      signal: options.signal,
      abortWhenUnused: true,
      createRequest: sharedSignal => scheduleDashboardHeavyRead({
        timeoutMessage: 'Las métricas del Dashboard tardaron demasiado. Reintenta la carga.',
        signal: sharedSignal,
        priority: DASHBOARD_HEAVY_PRIORITY.metrics,
        request: async signal => {
          const queryParams = new URLSearchParams({
            startDate: formatDateToISO(params.start),
            endDate: formatEndDateToISO(params.end)
          });

          const response = await fetch(apiUrl(`/api/dashboard/metrics?${queryParams}`), { signal });

          if (!response.ok) {
            throw new Error('No se pudieron cargar las métricas del Dashboard')
          }

          const data = await response.json() as DashboardMetrics
          if (
            principalRevision === getAuthScopedCacheRevision()
            && snapshotRevision === dashboardMetricsRevision
          ) {
            while (dashboardMetricsSnapshots.size >= 12) {
              const oldest = dashboardMetricsSnapshots.keys().next().value
              if (!oldest) break
              dashboardMetricsSnapshots.delete(oldest)
            }
            dashboardMetricsSnapshots.set(key, { data, fetchedAt: Date.now() })
          }
          return data
        }
      })
    })
  }

  async getOperationalSnapshot(params: {
    start: Date;
    end: Date;
  }, signal?: AbortSignal): Promise<DashboardOperationalSnapshot> {
    return scheduleDashboardHeavyRead({
      timeoutMessage: 'El resumen operativo tardó demasiado. Reintenta la carga.',
      signal,
      priority: DASHBOARD_HEAVY_PRIORITY.operational,
      request: async requestSignal => {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end)
      });
      const response = await fetch(apiUrl(`/api/dashboard/operational-snapshot?${queryParams}`), { signal: requestSignal });

      if (!response.ok) throw new Error('No se pudo cargar el resumen operativo')

      const result = await response.json();
      const data = result?.data || {};

      return {
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        contacts: Array.isArray(data.contacts) ? data.contacts : [],
        appointments: Array.isArray(data.appointments) ? data.appointments : []
      };
      }
    })
  }

  async getFinancialChart(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
  }, signal?: AbortSignal): Promise<ChartData[]> {
    return scheduleDashboardHeavyRead({
      timeoutMessage: 'La gráfica financiera tardó demasiado. Reintenta la carga.',
      signal,
      priority: DASHBOARD_HEAVY_PRIORITY.financial,
      request: async requestSignal => {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all'
      });

      // Usar el nuevo endpoint de dashboard que muestra TODOS los ingresos y gastos
      const response = await fetch(apiUrl(`/api/dashboard/financial-overview?${queryParams}`), { signal: requestSignal });

      if (!response.ok) {
        throw new Error('No se pudo cargar la gráfica financiera')
      }

      const result = await response.json();

      // El endpoint retorna { success: true, data: [...] }
      // Extraer el array de data y transformar al formato esperado
      const rawData = result?.data || [];

      return rawData.map((item: any) => ({
        date: item.label,
        ingresos: item.value || 0,
        gastado: item.value2 || 0
      }));
      }
    })
  }

  async getRoasData(params: {
    start: Date;
    end: Date;
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end)
    })
    return fetchDashboardSeries('/api/dashboard/roas', queryParams, params.signal, 'El ROAS')
  }

  async getNewCustomersData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    return fetchDashboardSeries('/api/dashboard/new-customers', queryParams, params.signal, 'Nuevos clientes')
  }

  async getVisitorsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    if (params.periods && params.periods.length > 0) {
      queryParams.set('periods', JSON.stringify(params.periods))
    }
    return fetchDashboardSeries('/api/dashboard/visitors', queryParams, params.signal, 'Visitantes')
  }

  async getVisitorsPage(params: DashboardVisitorsPageParams): Promise<CursorPage<DashboardVisitorDetail>> {
    return trackingService.getVisitorsPage<DashboardVisitorDetail>({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      scope: params.scope || 'all',
      cursor: params.cursor,
      search: params.search,
      limit: params.limit
    }, { signal: params.signal })
  }

  async getVisitorsList(params: DashboardVisitorsPageParams): Promise<DashboardVisitorDetail[]> {
    return (await this.getVisitorsPage(params)).items
  }

  async getLeadsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    return fetchDashboardSeries('/api/dashboard/leads', queryParams, params.signal, 'Leads')
  }

  async getAppointmentsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    if (params.periods && params.periods.length > 0) {
      queryParams.set('periods', JSON.stringify(params.periods))
    }
    return fetchDashboardSeries('/api/dashboard/appointments', queryParams, params.signal, 'Citas')
  }

  async getAttendancesData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    if (params.periods && params.periods.length > 0) {
      queryParams.set('periods', JSON.stringify(params.periods))
    }
    return fetchDashboardSeries('/api/dashboard/attendances', queryParams, params.signal, 'Asistencias')
  }

  async getSalesData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      groupBy: params.groupBy || 'day'
    })
    return fetchDashboardSeries('/api/dashboard/sales', queryParams, params.signal, 'Ventas')
  }

  async getTrafficSources(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    includeWhatsapp?: boolean;
    signal?: AbortSignal;
  }): Promise<{ name: string; value: number; color?: string }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      includeWeb: params.includeWeb === false ? '0' : '1',
      includeWhatsapp: params.includeWhatsapp === false ? '0' : '1'
    });
    const { response, result } = await scheduleDashboardHeavyRead({
      timeoutMessage: 'Las fuentes de tráfico tardaron demasiado. Reintenta la carga.',
      signal: params.signal,
      priority: DASHBOARD_HEAVY_PRIORITY.trafficSources,
      request: async signal => {
        const response = await fetch(apiUrl(`/api/dashboard/traffic-sources?${queryParams}`), { signal });
        const result = await response.json().catch(() => null);
        return { response, result };
      }
    });
    if (!response.ok) {
      throw new Error(result?.error || 'No se pudieron cargar las fuentes de tráfico.');
    }
    return Array.isArray(result?.data) ? result.data : [];
  }

  async getOriginDistribution(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    includeWhatsapp?: boolean;
    dimension?: OriginTrafficDimension;
    includeBreakdowns?: boolean;
    includePhoneBreakdown?: boolean;
    signal?: AbortSignal;
  }): Promise<OriginDistributionData> {
    syncAuthScopedCachePrincipal()
    const key = originDistributionKey(params)
    const cached = originDistributionSnapshots.get(key)
    if (cached && Date.now() - cached.fetchedAt < DASHBOARD_METRICS_FRESH_MS) {
      originDistributionSnapshots.delete(key)
      originDistributionSnapshots.set(key, cached)
      return cached.data
    }
    if (cached) originDistributionSnapshots.delete(key)

    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      includeWeb: params.includeWeb === false ? '0' : '1',
      includeWhatsapp: params.includeWhatsapp === false ? '0' : '1',
      includeBreakdowns: params.includeBreakdowns === false ? '0' : '1'
    });
    if (params.dimension) queryParams.set('dimension', params.dimension)
    if (params.includePhoneBreakdown !== undefined) {
      queryParams.set('includePhoneBreakdown', params.includePhoneBreakdown ? '1' : '0')
    }

    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const requestCacheRevision = originDistributionRevision
    return getOrCreateSharedRequest({
      inflight: originDistributionInflight,
      key,
      signal: params.signal,
      abortWhenUnused: true,
      createRequest: async sharedSignal => {
        const { response, result } = await scheduleDashboardHeavyRead({
          timeoutMessage: 'La distribución de origen tardó demasiado. Reintenta la carga.',
          signal: sharedSignal,
          priority: DASHBOARD_HEAVY_PRIORITY.origin,
          request: async signal => {
            const response = await fetch(apiUrl(`/api/dashboard/origin-distribution?${queryParams}`), { signal });
            const result = await response.json().catch(() => null);
            return { response, result };
          }
        });

        if (!response.ok) {
          const message = result && typeof result === 'object' && 'error' in result
            ? String(result.error)
            : 'No se pudo cargar la distribución de origen.';
          throw new Error(message);
        }

        const data = result && typeof result === 'object' && 'data' in result
          ? (result.data as OriginDistributionData)
          : EMPTY_ORIGIN_DISTRIBUTION;
        if (
          requestPrincipalRevision === getAuthScopedCacheRevision()
          && requestCacheRevision === originDistributionRevision
        ) {
          while (originDistributionSnapshots.size >= ORIGIN_DISTRIBUTION_CACHE_LIMIT) {
            const oldestKey = originDistributionSnapshots.keys().next().value
            if (!oldestKey) break
            originDistributionSnapshots.delete(oldestKey)
          }
          originDistributionSnapshots.set(key, { data, fetchedAt: Date.now() })
        }
        return data
      }
    })
  }

  async getFunnelData(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
    includeWeb?: boolean;
  }, signal?: AbortSignal): Promise<{ stage: string; value: number }[]> {
    const queryParams = new URLSearchParams({
      startDate: formatDateToISO(params.start),
      endDate: formatEndDateToISO(params.end),
      scope: params.scope || 'all',
      includeWeb: params.includeWeb === false ? '0' : '1'
    });
    const { response, result } = await scheduleDashboardHeavyRead({
      timeoutMessage: 'El embudo tardó demasiado. Reintenta la carga.',
      signal,
      priority: DASHBOARD_HEAVY_PRIORITY.funnel,
      request: async requestSignal => {
        const response = await fetch(apiUrl(`/api/dashboard/funnel?${queryParams}`), { signal: requestSignal });
        const result = await response.json().catch(() => null);
        return { response, result };
      }
    });
    if (!response.ok) {
      throw new Error(result?.error || 'No se pudo cargar el embudo.');
    }
    return Array.isArray(result?.data) ? result.data : [];
  }

  private getDefaultMetrics(): DashboardMetrics {
    // Valores por defecto mientras no hay datos reales
    return {
      ingresosNetos: { value: 0, variation: 0 },
      gastosPublicidad: { value: 0, variation: 0 },
      gananciaBruta: { value: 0, variation: 0 },
      roas: { value: 0, variation: 0 },
      totalCostos: { value: 0, variation: 0 },
      gananciaNeta: { value: 0, variation: 0 },
      reembolsos: { value: 0, variation: 0 },
      ltvPromedio: { value: 0, variation: 0 }
    };
  }
}

export const dashboardService = new DashboardService();
