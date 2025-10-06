// Servicio para el Dashboard principal
import { formatDateToISO } from '@/utils/format'

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
  ivaPagar: DashboardKPI;
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

class DashboardService {
  async getDashboardMetrics(params: {
    start: Date;
    end: Date;
  }): Promise<DashboardMetrics> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end)
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
  }): Promise<ChartData[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end)
      });

      // Usar el endpoint de Meta que sabemos que funciona correctamente
      const response = await fetch(`${API_URL}/api/meta/spend-over-time?${queryParams}`);

      if (!response.ok) {
        return [];
      }

      const result = await response.json();

      // El endpoint de Meta retorna { success: true, data: [...] }
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
        endDate: formatDateToISO(params.end)
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
        endDate: formatDateToISO(params.end),
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

  async getLeadsData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end),
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
        endDate: formatDateToISO(params.end),
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

  async getSalesData(params: {
    start: Date;
    end: Date;
    groupBy?: 'day' | 'month';
  }): Promise<{ label: string; value: number }[]> {
    try {
      const queryParams = new URLSearchParams({
        startDate: formatDateToISO(params.start),
        endDate: formatDateToISO(params.end),
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

  private getDefaultMetrics(): DashboardMetrics {
    // Valores por defecto mientras no hay datos reales
    return {
      ingresosNetos: { value: 0, variation: 0 },
      gastosPublicidad: { value: 0, variation: 0 },
      gananciaBruta: { value: 0, variation: 0 },
      roas: { value: 0, variation: 0 },
      ivaPagar: { value: 0, variation: 0 },
      gananciaNeta: { value: 0, variation: 0 },
      reembolsos: { value: 0, variation: 0 },
      ltvPromedio: { value: 0, variation: 0 }
    };
  }
}

export const dashboardService = new DashboardService();
