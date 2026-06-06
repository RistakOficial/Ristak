// Servicio para el Dashboard principal
import { formatDateToISO, formatEndDateToISO } from '@/utils/format'

// Si no hay VITE_API_URL, usa rutas relativas
const API_URL = import.meta.env.VITE_API_URL || '';

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

      const response = await fetch(`${API_URL}/api/dashboard/metrics?${queryParams}`);

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
      const response = await fetch(`${API_URL}/api/dashboard/financial-overview?${queryParams}`);

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

      const response = await fetch(`${API_URL}/api/dashboard/roas?${queryParams}`);

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

      const response = await fetch(`${API_URL}/api/dashboard/new-customers?${queryParams}`);

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
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(`${API_URL}/api/dashboard/visitors?${queryParams}`);

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      // TODO: Implement proper logging service
      return [];
    }
  }

  async getVisitorsList(params: {
    start: Date;
    end: Date;
    scope?: DashboardFunnelScope;
  }): Promise<DashboardVisitorDetail[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all'
      });

      const response = await fetch(`${API_URL}/api/tracking/visitors?${queryParams}`);

      if (!response.ok) {
        return [];
      }

      const result = await response.json();
      return Array.isArray(result?.data) ? result.data : [];
    } catch (error) {
      return [];
    }
  }

  async getLeadsData(params: {
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

      const response = await fetch(`${API_URL}/api/dashboard/leads?${queryParams}`);

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
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(`${API_URL}/api/dashboard/appointments?${queryParams}`);

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
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(`${API_URL}/api/dashboard/attendances?${queryParams}`);

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
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        groupBy: params.groupBy || 'day'
      });

      const response = await fetch(`${API_URL}/api/dashboard/sales?${queryParams}`);

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

      const response = await fetch(`${API_URL}/api/dashboard/traffic-sources?${queryParams}`);

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
  }): Promise<OriginDistributionData> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end)
      });

      const response = await fetch(`${API_URL}/api/dashboard/origin-distribution?${queryParams}`);

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
  }): Promise<{ stage: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatEndDateToISO(params.end),
        scope: params.scope || 'all'
      });

      const response = await fetch(`${API_URL}/api/dashboard/funnel?${queryParams}`);

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
