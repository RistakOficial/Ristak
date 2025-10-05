// Servicio para el Dashboard principal
// En producción usa rutas relativas (mismo origen), en desarrollo localhost:3001
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001');

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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0]
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0]
      });

      const response = await fetch(`${API_URL}/api/dashboard/chart-data?${queryParams}`);

      if (!response.ok) {
        return [];
      }

      return await response.json();
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0]
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0],
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0],
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0],
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
        startDate: params.start.toISOString().split('T')[0],
        endDate: params.end.toISOString().split('T')[0],
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
