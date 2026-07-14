// Servicio para el Dashboard principal
import { apiUrl } from './apiBaseUrl'
import { formatDateToISO, formatEndDateToISO } from '@/utils/format'
import type { CalendarEvent } from './calendarsService'
import type { ContactListItem } from './reportsService'
import type { Transaction } from './transactionsService'
import { trackingService, type CursorPage } from './trackingService'

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

const EMPTY_ORIGIN_DISTRIBUTION: OriginDistributionData = {
  traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
  leads: [],
  appointments: [],
  conversions: [],
  whatsappNumbers: []
};

class DashboardService {
  async getDashboardMetrics(params: {
    start: Date;
    end: Date;
  }): Promise<DashboardMetrics> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end)
      });

      const response = await fetch(apiUrl(`/api/dashboard/metrics?${queryParams}`));

      if (!response.ok) {
        // Si el endpoint no existe, devolver valores por defecto
        return this.getDefaultMetrics();
      }

      return await response.json();
    } catch (error) {
      // TODO: Implement proper logging service
      return this.getDefaultMetrics();
    }
  }

  async getOperationalSnapshot(params: {
    start: Date;
    end: Date;
  }): Promise<DashboardOperationalSnapshot> {
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
      const response = await fetch(apiUrl(`/api/dashboard/operational-snapshot?${queryParams}`));

      if (!response.ok) return emptySnapshot;

      const result = await response.json();
      const data = result?.data || {};

      return {
        transactions: Array.isArray(data.transactions) ? data.transactions : [],
        contacts: Array.isArray(data.contacts) ? data.contacts : [],
        appointments: Array.isArray(data.appointments) ? data.appointments : []
      };
    } catch {
      return emptySnapshot;
    }
  }

  async getFinancialChart(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
  }): Promise<ChartData[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all'
      });

      // Usar el nuevo endpoint de dashboard que muestra TODOS los ingresos y gastos
      const response = await fetch(apiUrl(`/api/dashboard/financial-overview?${queryParams}`));

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
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getRoasData(params: {
    start: Date;
    end: Date;
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end)
      });

      const response = await fetch(apiUrl(`/api/dashboard/roas?${queryParams}`));

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getNewCustomersData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(apiUrl(`/api/dashboard/new-customers?${queryParams}`));

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
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
  }): Promise<OriginDistributionData> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        includeWeb: params.includeWeb === false ? '0' : '1',
        includeWhatsapp: params.includeWhatsapp === false ? '0' : '1'
      });

      const response = await fetch(apiUrl(`/api/dashboard/origin-distribution?${queryParams}`));

      if (!response.ok) {
        return EMPTY_ORIGIN_DISTRIBUTION;
      }

      const result = await response.json();
      return result?.data || EMPTY_ORIGIN_DISTRIBUTION;
    } catch (error) {
      // TODO: Implement proper logging service
      return EMPTY_ORIGIN_DISTRIBUTION;
    }
  }

  async getFunnelData(params: {
    start: Date;
    end: Date;
    scope?: 'all' | 'attribution' | 'campaigns';
    includeWeb?: boolean;
  }): Promise<{ stage: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all',
        includeWeb: params.includeWeb === false ? '0' : '1'
      });

      const response = await fetch(apiUrl(`/api/dashboard/funnel?${queryParams}`));

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
