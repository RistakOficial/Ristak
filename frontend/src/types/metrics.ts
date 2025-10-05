export interface DashboardMetrics {
  ingresosNetos: {
    value: number
    variation: number
  }
  gastosPublicidad: {
    value: number
    variation: number
  }
  gananciaBruta: {
    value: number
    variation: number
  }
  roas: {
    value: number
    variation: number
  }
  ivaPagar: {
    value: number
    variation: number
  }
  gananciaNeta: {
    value: number
    variation: number
  }
  reembolsos: {
    value: number
    variation: number
  }
  ltvPromedio: {
    value: number
    variation: number
  }
}

export interface ChartData {
  date: string
  ingresos: number
  gastado: number
  ganancia?: number
}

export interface DateRangeParams {
  start: Date
  end: Date
  tenant: string
}