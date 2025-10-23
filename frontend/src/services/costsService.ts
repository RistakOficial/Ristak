import apiClient from './apiClient'

export interface Cost {
  id: string
  name: string
  type: 'tax' | 'commission' | 'rent' | 'service' | 'other'
  calculation_type: 'percentage' | 'fixed'
  value: number
  applies_to?: 'revenue' | 'profit' | null
  is_active: number
  created_at: string
  updated_at: string
}

export interface CostCalculation {
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
  type: 'tax' | 'commission' | 'rent' | 'service' | 'other'
  calculation_type: 'percentage' | 'fixed'
  value: number
  applies_to?: 'revenue' | 'profit' | null
}

export interface UpdateCostDto extends Partial<CreateCostDto> {
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
    const translations: Record<Cost['type'], string> = {
      tax: 'Impuesto',
      commission: 'Comisión',
      rent: 'Renta',
      service: 'Servicio',
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
