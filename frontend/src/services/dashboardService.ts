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
import { registerRistakApiReadCacheInvalidator } from './authFetch'
import { getOrCreateSharedRequest } from './sharedRequest'

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
const dashboardMetricsSnapshots = new Map<string, { data: DashboardMetrics; fetchedAt: number }>()
const dashboardMetricsInflight = new Map<string, Promise<DashboardMetrics>>()
const MOBILE_ANALYTICS_FRESH_MS = 30_000
const MOBILE_ANALYTICS_STALE_MS = 5 * 60_000
const MOBILE_ANALYTICS_CACHE_LIMIT = 8
const mobileAnalyticsSnapshots = new Map<string, { data: DashboardMobileAnalyticsSnapshot; fetchedAt: number }>()

function clearDashboardMetricSnapshots() {
  dashboardMetricsSnapshots.clear()
  dashboardMetricsInflight.clear()
}

registerAuthScopedCacheInvalidator(clearDashboardMetricSnapshots)
registerRistakApiReadCacheInvalidator(clearDashboardMetricSnapshots)

function clearMobileAnalyticsSnapshots() {
  mobileAnalyticsSnapshots.clear()
}

registerAuthScopedCacheInvalidator(clearMobileAnalyticsSnapshots)
registerRistakApiReadCacheInvalidator(clearMobileAnalyticsSnapshots)

function dashboardMetricsKey(params: { start: Date; end: Date }) {
  return `${formatDateToISO(params.start)}:${formatEndDateToISO(params.end)}`
}

function mobileAnalyticsKey(params: {
  start: Date;
  end: Date;
  includeWeb?: boolean;
  funnelScope?: DashboardFunnelScope;
  financialScope?: DashboardFunnelScope;
}) {
  return [
    formatDateToISO(params.start),
    formatEndDateToISO(params.end),
    params.includeWeb === false ? 'no-web' : 'web',
    params.funnelScope || 'all',
    params.financialScope || 'all'
  ].join(':')
}

class DashboardService {
  peekMobileAnalyticsSnapshot(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    funnelScope?: DashboardFunnelScope;
    financialScope?: DashboardFunnelScope;
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
  }, options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<DashboardMobileAnalyticsSnapshot> {
    syncAuthScopedCachePrincipal()
    const principalRevision = getAuthScopedCacheRevision()
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
    const response = await fetch(apiUrl(`/api/dashboard/mobile-analytics-snapshot?${queryParams}`), {
      signal: options.signal
    })
    if (!response.ok) throw new Error('No se pudo cargar Analíticas móvil')
    const result = await response.json()
    const data = result?.data as DashboardMobileAnalyticsSnapshot | undefined
    if (!data?.metrics || !data?.origin || !Array.isArray(data.funnel) || !Array.isArray(data.financialChart)) {
      throw new Error('El snapshot de Analíticas móvil está incompleto')
    }

    if (principalRevision === getAuthScopedCacheRevision()) {
      while (mobileAnalyticsSnapshots.size >= MOBILE_ANALYTICS_CACHE_LIMIT) {
        const oldest = mobileAnalyticsSnapshots.keys().next().value
        if (!oldest) break
        mobileAnalyticsSnapshots.delete(oldest)
      }
      mobileAnalyticsSnapshots.set(key, { data, fetchedAt: Date.now() })
    }
    return data
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
    const key = dashboardMetricsKey(params)
    const cached = dashboardMetricsSnapshots.get(key)
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < DASHBOARD_METRICS_FRESH_MS) {
      return cached.data
    }
    return getOrCreateSharedRequest({
      inflight: dashboardMetricsInflight,
      key,
      signal: options.signal,
      createRequest: async () => {
        try {
          const queryParams = new URLSearchParams({
            startDate: formatDateToISO(params.start),
            endDate: formatEndDateToISO(params.end)
          });

          // El request pertenece al rango, no al primer componente que llegó.
          // Cada consumidor cancela únicamente su espera en sharedRequest.ts.
          const response = await fetch(apiUrl(`/api/dashboard/metrics?${queryParams}`));

          if (!response.ok) {
            // Si el endpoint no existe, devolver valores por defecto
            return this.getDefaultMetrics();
          }

          const data = await response.json() as DashboardMetrics
          if (principalRevision === getAuthScopedCacheRevision()) {
            while (dashboardMetricsSnapshots.size >= 12) {
              const oldest = dashboardMetricsSnapshots.keys().next().value
              if (!oldest) break
              dashboardMetricsSnapshots.delete(oldest)
            }
            dashboardMetricsSnapshots.set(key, { data, fetchedAt: Date.now() })
          }
          return data
        } catch {
          // TODO: Implement proper logging service
          return this.getDefaultMetrics();
        }
      }
    })
  }

  async getOperationalSnapshot(params: {
    start: Date;
    end: Date;
  }, signal?: AbortSignal): Promise<DashboardOperationalSnapshot> {
    const emptySnapshot: DashboardOperationalSnapshot = {
      transactions: [],
      contacts: [],
      appointments: []
    };

    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end)
      });
      const response = await fetch(apiUrl(`/api/dashboard/operational-snapshot?${queryParams}`), { signal });

      if (!response.ok) return emptySnapshot;

      const result = await response.json();
      const data = result?.data || {};

      return {
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        contacts: Array.isArray(data.contacts) ? data.contacts : [],
        appointments: Array.isArray(data.appointments) ? data.appointments : []
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return emptySnapshot;
    }
  }

  async getFinancialChart(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
  }, signal?: AbortSignal): Promise<ChartData[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all'
      });

      // Usar el nuevo endpoint de dashboard que muestra TODOS los ingresos y gastos
      const response = await fetch(apiUrl(`/api/dashboard/financial-overview?${queryParams}`), { signal });

      if (!response.ok) {
        return [];
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
    } catch (error) {
      if (signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getRoasData(params: {
    start: Date;
    end: Date;
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end)
      });

      const response = await fetch(apiUrl(`/api/dashboard/roas?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getNewCustomersData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(apiUrl(`/api/dashboard/new-customers?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getVisitorsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });
      if (params.periods && params.periods.length > 0) {
        queryParams.set('periods', JSON.stringify(params.periods));
      }

      const response = await fetch(apiUrl(`/api/dashboard/visitors?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getVisitorsPage(params: DashboardVisitorsPageParams): Promise<CursorPage<DashboardVisitorDetail>> {
    try {
      return await trackingService.getVisitorsPage<DashboardVisitorDetail>({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all',
        cursor: params.cursor,
        search: params.search,
        limit: params.limit
      })
    } catch (error) {
      return {
        items: [],
        pagination: { limit: Math.min(100, Math.max(1, params.limit ?? 50)), hasNext: false, hasMore: false, nextCursor: null }
      }
    }
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
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(apiUrl(`/api/dashboard/leads?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getAppointmentsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });
      if (params.periods && params.periods.length > 0) {
        queryParams.set('periods', JSON.stringify(params.periods));
      }

      const response = await fetch(apiUrl(`/api/dashboard/appointments?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getAttendancesData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    periods?: { start: string; end: string }[];
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });
      if (params.periods && params.periods.length > 0) {
        queryParams.set('periods', JSON.stringify(params.periods));
      }

      const response = await fetch(apiUrl(`/api/dashboard/attendances?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getSalesData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
    signal?: AbortSignal;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(apiUrl(`/api/dashboard/sales?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getTrafficSources(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    includeWhatsapp?: boolean;
  }): Promise<{ name: string; value: number; color?: string }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        includeWeb: params.includeWeb === false ? '0' : '1',
        includeWhatsapp: params.includeWhatsapp === false ? '0' : '1'
      });

      const response = await fetch(apiUrl(`/api/dashboard/traffic-sources?${queryParams}`));

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return result?.data || [];
    } catch (error) {
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getOriginDistribution(params: {
    start: Date;
    end: Date;
    includeWeb?: boolean;
    includeWhatsapp?: boolean;
    signal?: AbortSignal;
  }): Promise<OriginDistributionData> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        includeWeb: params.includeWeb === false ? '0' : '1',
        includeWhatsapp: params.includeWhatsapp === false ? '0' : '1'
      });

      const response = await fetch(apiUrl(`/api/dashboard/origin-distribution?${queryParams}`), { signal: params.signal });

      if (!response.ok) {
        return EMPTY_ORIGIN_DISTRIBUTION;
      }

      const result = await response.json();
      return result?.data || EMPTY_ORIGIN_DISTRIBUTION;
    } catch (error) {
      if (params.signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return EMPTY_ORIGIN_DISTRIBUTION;
    }
  }

  async getFunnelData(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
    includeWeb?: boolean;
  }, signal?: AbortSignal): Promise<{ stage: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all',
        includeWeb: params.includeWeb === false ? '0' : '1'
      });

      const response = await fetch(apiUrl(`/api/dashboard/funnel?${queryParams}`), { signal });

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return result?.data || [];
    } catch (error) {
      if (signal?.aborted) throw error;
      // TODO: Implement proper logging service
      return [];
    }
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
