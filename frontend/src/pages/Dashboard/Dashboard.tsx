import React, { useEffect, useState } from 'react'
import { KpiCard, Card, DateRangePicker, AreaChart, PageContainer, TrafficSourcesChart, ConversionFunnelChart } from '@/components/common'
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
import { formatCurrency, formatRoas, formatChartDate, formatDateToISO, parseLocalDateString } from '@/utils/format'

export const Dashboard: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { user } = useAuth()
  const { labels } = useLabels()

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [chartData, setChartData] = useState<ChartData[]>([])
  const [trafficSources, setTrafficSources] = useState<{ name: string; value: number; color: string }[]>([])
  const [funnelData, setFunnelData] = useState<{ stage: string; value: number }[]>([])
  const [loading, setLoading] = useState(true)

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


  const currencyAxisFormatter = (value: number) => {
    if (Math.abs(value) >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(1)}M`
    }
    if (Math.abs(value) >= 1_000) {
      return `$${(value / 1_000).toFixed(0)}k`
    }
    return `$${Math.round(value)}`
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

        const [metricsData, chartDataResponse, trafficSourcesData, funnelDataResponse] = await Promise.all([
          dashboardService.getDashboardMetrics({
            start: dateRange.start,
            end: dateRange.end
          }),
          dashboardService.getFinancialChart({
            start: twelveMonthsAgo,
            end: now
          }),
          dashboardService.getTrafficSources({
            start: dateRange.start,
            end: dateRange.end
          }),
          dashboardService.getFunnelData({
            start: dateRange.start,
            end: dateRange.end
          })
        ])

        setMetrics(metricsData)
        setChartData(chartDataResponse)
        setTrafficSources(trafficSourcesData)
        setFunnelData(funnelDataResponse)
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
      <div className="flex flex-col" style={{ gap: '18px' }}>
        <div className="flex flex-col items-start gap-1">
          <h1 className="m-0 text-[24px] font-bold text-[var(--color-text-primary)]">Dashboard</h1>
        </div>

        <div className="flex items-center justify-between">
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
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">Ingresos vs Gastos</h2>
            <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">Últimos 12 meses</p>
          </div>
          <div className="relative w-full" style={{ minHeight: chartHeight, height: chartHeight }}>
            {formattedFinancialData.length > 0 ? (
              <AreaChart
                data={formattedFinancialData}
                height={chartHeight}
                showGrid
                color="#10b981"
                color2="#64748b"
                formatValue={currencyAxisFormatter}
                formatTooltipValue={(value) => formatCurrency(value)}
                showLegend={true}
                legendLabels={{ label1: 'Ingresos', label2: 'Gastos' }}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Sin datos financieros disponibles
              </div>
            )}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <ConversionFunnelChart
            data={funnelData}
            loading={loading}
          />
          <TrafficSourcesChart
            data={trafficSources}
            loading={loading}
          />
        </div>
      </div>
    </PageContainer>
  )
}
