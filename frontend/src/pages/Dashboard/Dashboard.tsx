import React, { useEffect, useState } from 'react'
import { KpiCard, Card, DateRangePicker, AreaChart, PageContainer, ViewSelector } from '@/components/common'
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  Target,
  Receipt,
  Wallet,
  RotateCcw,
  Users
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { dashboardService, type DashboardMetrics, type ChartData } from '@/services/dashboardService'
import { formatCurrency, formatRoas, formatChartDate, formatNumber, formatDateToISO, parseLocalDateString } from '@/utils/format'

type ChartView = 'financial' | 'conversion' | 'sales'

interface ChartConfig {
  title: string
  subtitle: string
  data: Array<{ label: string; value: number; value2?: number }>
  color: string
  color2?: string
  showLegend: boolean
  legendLabels?: { label1: string; label2?: string }
  formatAxis: (value: number) => string
  formatTooltip: (value: number, key?: string) => string
  emptyMessage: string
}

export const Dashboard: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { user } = useAuth()
  const { labels } = useLabels()

  const CHART_OPTIONS: Array<{ value: ChartView; label: string }> = [
    { value: 'financial', label: 'Ingresos vs Gastos' },
    { value: 'conversion', label: `${labels.leads} vs ${labels.customers}` },
    { value: 'sales', label: 'Citas vs Ventas' }
  ]
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [chartData, setChartData] = useState<ChartData[]>([])
  const [newCustomersData, setNewCustomersData] = useState<{ label: string; value: number }[]>([])
  const [leadsData, setLeadsData] = useState<{ label: string; value: number }[]>([])
  const [appointmentsData, setAppointmentsData] = useState<{ label: string; value: number }[]>([])
  const [salesData, setSalesData] = useState<{ label: string; value: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedChart, setSelectedChart] = useState<ChartView>('financial')

  // Agrupar datos financieros por mes para últimos 12 meses
  const formattedFinancialData = React.useMemo(() => {
    // Crear los últimos 12 meses
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    // Agrupar datos por mes
    const monthlyData = chartData.reduce((acc, item) => {
      const date = new Date(item.date)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

      if (!acc[monthKey]) {
        acc[monthKey] = { ingresos: 0, gastado: 0 }
      }

      acc[monthKey].ingresos += item.ingresos
      acc[monthKey].gastado += item.gastado

      return acc
    }, {} as Record<string, { ingresos: number; gastado: number }>)

    // Crear array con todos los 12 meses (con o sin datos)
    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: monthlyData[monthKey]?.ingresos || 0,
      value2: monthlyData[monthKey]?.gastado || 0
    }))
  }, [chartData])

  // Agrupar datos de nuevos clientes por mes para últimos 12 meses (gráfico individual)
  const formattedCustomersData = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    const monthlyData = newCustomersData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: monthlyData[monthKey] || 0
    }))
  }, [newCustomersData])

  // Agrupar datos de interesados por mes para últimos 12 meses (gráfico individual)
  const formattedLeadsData = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    const monthlyData = leadsData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: monthlyData[monthKey] || 0
    }))
  }, [leadsData])

  // Agrupar datos de citas por mes para últimos 12 meses (gráfico individual)
  const formattedAppointmentsData = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    const monthlyData = appointmentsData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: monthlyData[monthKey] || 0
    }))
  }, [appointmentsData])

  // Agrupar Interesados vs Clientes nuevos por mes
  const formattedConversionData = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    // Agrupar interesados por mes
    const leadsMonthly = leadsData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    // Agrupar clientes por mes
    const customersMonthly = newCustomersData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: leadsMonthly[monthKey] || 0,
      value2: customersMonthly[monthKey] || 0
    }))
  }, [leadsData, newCustomersData])

  // Agrupar Citas vs Ventas por mes
  const formattedSalesData = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    // Agrupar citas por mes
    const appointmentsMonthly = appointmentsData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    // Agrupar ventas por mes
    const salesMonthly = salesData.reduce((acc, item) => {
      const date = new Date(item.label)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!acc[monthKey]) acc[monthKey] = 0
      acc[monthKey] += item.value
      return acc
    }, {} as Record<string, number>)

    return last12Months.map((monthKey, index) => ({
      label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
      value: appointmentsMonthly[monthKey] || 0,
      value2: salesMonthly[monthKey] || 0
    }))
  }, [appointmentsData, salesData])

  const chartConfigs = React.useMemo<Record<ChartView, ChartConfig>>(() => {
    const currencyAxisFormatter = (value: number) => {
      if (Math.abs(value) >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(1)}M`
      }
      if (Math.abs(value) >= 1_000) {
        return `$${(value / 1_000).toFixed(0)}k`
      }
      return `$${Math.round(value)}`
    }

    return {
      financial: {
        title: 'Ingresos vs Gastos',
        subtitle: 'Últimos 12 meses',
        data: formattedFinancialData,
        color: '#10b981',
        color2: '#64748b',
        showLegend: true,
        legendLabels: { label1: 'Ingresos', label2: 'Gastos' },
        formatAxis: currencyAxisFormatter,
        formatTooltip: (value: number) => formatCurrency(value),
        emptyMessage: 'Sin datos financieros disponibles'
      },
      conversion: {
        title: `${labels.leads} vs ${labels.customers} Nuevos`,
        subtitle: 'Últimos 12 meses',
        data: formattedConversionData,
        color: '#3b82f6',
        color2: '#10b981',
        showLegend: true,
        legendLabels: { label1: labels.leads, label2: labels.customers },
        formatAxis: (value: number) => formatNumber(value),
        formatTooltip: (value: number) => formatNumber(value),
        emptyMessage: 'Sin datos de conversión disponibles'
      },
      sales: {
        title: 'Citas vs Ventas',
        subtitle: 'Últimos 12 meses',
        data: formattedSalesData,
        color: '#8b5cf6',
        color2: '#10b981',
        showLegend: true,
        legendLabels: { label1: 'Citas', label2: 'Ventas' },
        formatAxis: (value: number) => formatNumber(value),
        formatTooltip: (value: number) => formatNumber(value),
        emptyMessage: 'Sin datos de ventas disponibles'
      }
    }
  }, [formattedFinancialData, formattedConversionData, formattedSalesData])

  const selectedConfig = chartConfigs[selectedChart]

  const handleChartChange = (value: string) => {
    if (CHART_OPTIONS.some((option) => option.value === value)) {
      setSelectedChart(value as ChartView)
    }
  }

  const chartHeight = 340

  useEffect(() => {
    const loadData = async () => {
      if (!user) return

      setLoading(true)
      try {
        // Calcular últimos 12 meses para los gráficos
        const now = new Date()
        const twelveMonthsAgo = new Date(now)
        twelveMonthsAgo.setMonth(now.getMonth() - 12)

        const [metricsData, chartDataResponse, customersData, leadsDataResponse, appointmentsDataResponse, salesDataResponse] = await Promise.all([
          dashboardService.getDashboardMetrics({
            start: dateRange.start,
            end: dateRange.end
          }),
          dashboardService.getFinancialChart({
            start: twelveMonthsAgo,
            end: now
          }),
          dashboardService.getNewCustomersData({
            start: twelveMonthsAgo,
            end: now,
            groupBy: 'day'
          }),
          dashboardService.getLeadsData({
            start: twelveMonthsAgo,
            end: now,
            groupBy: 'day'
          }),
          dashboardService.getAppointmentsData({
            start: twelveMonthsAgo,
            end: now,
            groupBy: 'day'
          }),
          dashboardService.getSalesData({
            start: twelveMonthsAgo,
            end: now,
            groupBy: 'day'
          })
        ])

        setMetrics(metricsData)
        setChartData(chartDataResponse)
        setNewCustomersData(customersData)
        setLeadsData(leadsDataResponse)
        setAppointmentsData(appointmentsDataResponse)
        setSalesData(salesDataResponse)
      } catch (error) {
        // TODO: add logging service
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [dateRange, user])

  if (loading || !metrics) {
    return null
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-start gap-3 mb-10">
          <h1 className="m-0 text-[var(--font-size-3xl)] font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="m-0 text-base text-[var(--color-text-secondary)]">Resumen financiero y de marketing</p>
          <DateRangePicker
            startDate={formatDateToISO(dateRange.start)}
            endDate={formatDateToISO(dateRange.end)}
            onChange={(start, end) => setDateRange({
              start: parseLocalDateString(start),
              end: parseLocalDateString(end),
              preset: 'custom'
            })}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
          <KpiCard
            title="Ingresos Netos"
            value={formatCurrency(metrics.ingresosNetos.value)}
            delta={metrics.ingresosNetos.variation}
            deltaLabel="vs periodo anterior"
          icon={<DollarSign className="w-5 h-5" />}
        />
        <KpiCard
          title="Gastos de Publicidad"
          value={formatCurrency(metrics.gastosPublicidad.value)}
          delta={metrics.gastosPublicidad.variation}
          deltaLabel="vs periodo anterior"
          icon={<Megaphone className="w-5 h-5" />}
        />
        <KpiCard
          title="Ganancia Bruta"
          value={formatCurrency(metrics.gananciaBruta.value)}
          delta={metrics.gananciaBruta.variation}
          deltaLabel="vs periodo anterior"
          icon={<TrendingUp className="w-5 h-5" />}
        />
        <KpiCard
          title="Retorno de Inversión"
          value={formatRoas(metrics.roas.value)}
          delta={metrics.roas.variation}
          deltaLabel="vs periodo anterior"
          icon={<Target className="w-5 h-5" />}
        />
        <KpiCard
          title="IVA a Pagar"
          value={formatCurrency(metrics.ivaPagar.value)}
          delta={metrics.ivaPagar.variation}
          deltaLabel="vs periodo anterior"
          icon={<Receipt className="w-5 h-5" />}
        />
        <KpiCard
          title="Ganancia Neta"
          value={formatCurrency(metrics.gananciaNeta.value)}
          delta={metrics.gananciaNeta.variation}
          deltaLabel="vs periodo anterior"
          icon={<Wallet className="w-5 h-5" />}
        />
        <KpiCard
          title="Reembolsos"
          value={formatCurrency(metrics.reembolsos.value)}
          delta={metrics.reembolsos.variation}
          deltaLabel="vs periodo anterior"
          icon={<RotateCcw className="w-5 h-5" />}
        />
        <KpiCard
          title="Pagos totales promedio"
          value={formatCurrency(metrics.ltvPromedio.value)}
          delta={metrics.ltvPromedio.variation}
          deltaLabel="vs periodo anterior"
          icon={<Users className="w-5 h-5" />}
        />
        </div>

        <Card variant="glass" className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">{selectedConfig.title}</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">{selectedConfig.subtitle}</p>
            </div>
            <ViewSelector
              value={selectedChart}
              options={CHART_OPTIONS}
              onChange={handleChartChange}
              className="w-full sm:w-auto"
            />
          </div>
          <div className="relative w-full" style={{ minHeight: chartHeight, height: chartHeight }}>
            {selectedConfig.data.length > 0 ? (
              <AreaChart
                data={selectedConfig.data}
                height={chartHeight}
                showGrid
                color={selectedConfig.color}
                color2={selectedConfig.color2}
                formatValue={selectedConfig.formatAxis}
                formatTooltipValue={(value, key) => selectedConfig.formatTooltip(value, key)}
                showLegend={selectedConfig.showLegend}
                legendLabels={selectedConfig.legendLabels}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                {selectedConfig.emptyMessage}
              </div>
            )}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <Card variant="glass">
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-4">Nuevos {labels.customers}</h2>
            <div className="h-[280px]">
              <AreaChart
                data={formattedCustomersData.length > 0
                  ? formattedCustomersData
                  : [{ label: 'Sin datos', value: 0 }]}
                height={250}
                showGrid
                color="#10b981"
                formatValue={(v) => v.toFixed(0)}
                formatTooltipValue={(v) => v.toFixed(0)}
              />
            </div>
          </Card>

          <Card variant="glass">
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-4">{labels.leads}</h2>
            <div className="h-[280px]">
              <AreaChart
                data={formattedLeadsData.length > 0
                  ? formattedLeadsData
                  : [{ label: 'Sin datos', value: 0 }]}
                height={250}
                showGrid
                color="#3b82f6"
                formatValue={(v) => v.toFixed(0)}
                formatTooltipValue={(v) => v.toFixed(0)}
              />
            </div>
          </Card>

          <Card variant="glass">
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-4">Nuevas Citas</h2>
            <div className="h-[280px]">
              <AreaChart
                data={formattedAppointmentsData.length > 0
                  ? formattedAppointmentsData
                  : [{ label: 'Sin datos', value: 0 }]}
                height={250}
                showGrid
                color="#8b5cf6"
                formatValue={(v) => v.toFixed(0)}
                formatTooltipValue={(v) => v.toFixed(0)}
              />
            </div>
          </Card>
        </div>
      </div>
    </PageContainer>
  )
}
