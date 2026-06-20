import apiClient from './apiClient'

export type CostType = string

export interface Cost {
  id: string
  name: string
  type: CostType
  calculation_type: 'percentage' | 'fixed'
  value: number
  applies_to?: 'revenue' | 'profit' | null
  is_active: number
  created_at: string
  updated_at: string
}

interface CostCalculation {
  revenue: number
  total_costs: number
  net_profit: number
  breakdown: Array<{
    id: string
    name: string
    type: string
    calculation_type: string
    value: number
    amount: number
  }>
}

export interface CreateCostDto {
  name: string
  type: CostType
  calculation_type: 'percentage' | 'fixed'
  value: number
  applies_to?: 'revenue' | 'profit' | null
}

interface UpdateCostDto extends Partial<CreateCostDto> {
  is_active?: boolean
}

export const costsService = {
  /**
   * Obtiene todos los costos activos
   */
  async getAllCosts(): Promise<Cost[]> {
    const response = await apiClient.get<{ success: boolean; costs: Cost[] }>('/api/costs')
    return response.costs || []
  },

  /**
   * Obtiene un costo específico por ID
   */
  async getCostById(id: string): Promise<Cost> {
    const response = await apiClient.get<{ success: boolean; cost: Cost }>(`/api/costs/${id}`)
    return response.cost
  },

  /**
   * Crea un nuevo costo
   */
  async createCost(data: CreateCostDto): Promise<Cost> {
    const response = await apiClient.post<{ success: boolean; cost: Cost; message: string }>(
      '/api/costs',
      data
    )
    return response.cost
  },

  /**
   * Actualiza un costo existente
   */
  async updateCost(id: string, data: UpdateCostDto): Promise<Cost> {
    const response = await apiClient.put<{ success: boolean; cost: Cost; message: string }>(
      `/api/costs/${id}`,
      data
    )
    return response.cost
  },

  /**
   * Elimina un costo (soft delete)
   */
  async deleteCost(id: string): Promise<void> {
    await apiClient.delete(`/api/costs/${id}`)
  },

  /**
   * Calcula el total de costos para un monto de ingresos
   */
  async calculateCosts(revenue: number): Promise<CostCalculation> {
    const response = await apiClient.post<{
      success: boolean
      revenue: number
      total_costs: number
      net_profit: number
      breakdown: CostCalculation['breakdown']
    }>('/api/costs/calculate', { revenue })

    return {
      revenue: response.revenue,
      total_costs: response.total_costs,
      net_profit: response.net_profit,
      breakdown: response.breakdown
    }
  },

  /**
   * Traduce el tipo de costo a español
   */
  translateType(type: Cost['type']): string {
    const translations: Record<string, string> = {
      payroll: 'Sueldos',
      payroll_taxes: 'Cargas sociales y nómina',
      bonuses: 'Bonos y comisiones internas',
      contractors: 'Honorarios y contratistas',
      rent: 'Renta',
      utilities: 'Servicios básicos',
      internet_phone: 'Internet y telefonía',
      software: 'Software y suscripciones',
      equipment: 'Equipo y herramientas',
      maintenance: 'Mantenimiento',
      office_supplies: 'Papelería e insumos de oficina',
      cleaning: 'Limpieza',
      security: 'Seguridad',
      insurance: 'Seguros',
      marketing: 'Publicidad y marketing',
      sales_commission: 'Comisiones de venta',
      payment_processing: 'Comisiones de pasarela',
      product_cost: 'Costo de producto',
      inventory: 'Inventario',
      raw_materials: 'Materia prima',
      packaging: 'Empaque',
      shipping: 'Envíos y logística',
      storage: 'Almacenamiento',
      transport: 'Transporte y gasolina',
      tax: 'Impuesto',
      accounting: 'Contabilidad',
      legal: 'Legal',
      bank_fees: 'Comisiones bancarias',
      loan_interest: 'Intereses y financiamiento',
      licenses: 'Permisos y licencias',
      training: 'Capacitación',
      travel: 'Viajes y viáticos',
      customer_support: 'Atención al cliente',
      refunds: 'Reembolsos y garantías',
      service: 'Servicio',
      commission: 'Comisión',
      other: 'Otro'
    }
    return translations[type] || type
  },

  /**
   * Formatea el valor del costo para mostrar
   */
  formatValue(cost: Cost): string {
    if (cost.calculation_type === 'percentage') {
      return `${cost.value}%`
    }
    return `$${cost.value.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}
