import React, { useEffect, useState } from 'react'
import { KpiCard, Card, DateRangePicker, AreaChart, PageContainer, TrafficSourcesChart, ConversionFunnelChart, ViewSelector, Loading, ContactDetailsModal, VisitorDetailsModal } from '@/components/common'
import funnelStyles from '@/components/common/ConversionFunnelChart/ConversionFunnelChart.module.css'
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  Target,
  Receipt,
  Wallet,
  RotateCcw,
  Users,
  Layers,
  MousePointerClick
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useAppConfig, useIsRenderDomain, useMetaTimezone } from '@/hooks'
import { dashboardService, type DashboardMetrics, type ChartData, type DashboardVisitorDetail } from '@/services/dashboardService'
import { reportsService, type ContactListItem } from '@/services/reportsService'
import { formatCurrency, formatRoas, formatChartDate, formatDateToISO, parseLocalDateString, formatChartCurrency, formatChartNumber } from '@/utils/format'

const parseAnalyticsFlag = (value: unknown) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  if (typeof value === 'number') {
    return value === 1
  }
  return Boolean(value)
}

type FunnelStageKind = 'visitors' | 'leads' | 'appointments' | 'attendances' | 'customers'
type ContactModalType = 'interesados' | 'sales' | 'appointments' | 'attendances'

export const Dashboard: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { user } = useAuth()
  const { labels } = useLabels()

  // Detectar discrepancia de timezone con Meta
  const timezoneInfo = useMetaTimezone()

  // Detectar si estamos en dominio .onrender.com
  const isRenderDomain = useIsRenderDomain()

  // Sistema híbrido de configuración
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')

  // FORZAR analyticsEnabled a false si estamos en dominio .onrender.com
  const analyticsEnabled = isRenderDomain ? false : parseAnalyticsFlag(showAnalyticsConfig)

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null)
  const [chartData, setChartData] = useState<ChartData[]>([])
  const [visitorsLeadsData, setVisitorsLeadsData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [leadsAppointmentsData, setLeadsAppointmentsData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [appointmentsSalesData, setAppointmentsSalesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [trafficSources, setTrafficSources] = useState<{ name: string; value: number; color: string }[]>([])
  const [funnelData, setFunnelData] = useState<{ stage: string; value: number }[]>([])
  const [funnelScope, setFunnelScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [financialScope, setFinancialScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [funnelLoading, setFunnelLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedChartView, setSelectedChartView] = useState<'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-sales'>('revenue-spend')
  const [extendedChartDataLoaded, setExtendedChartDataLoaded] = useState(false)
  const [extendedChartDataLoading, setExtendedChartDataLoading] = useState(false)
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [contactModalTitle, setContactModalTitle] = useState('')
  const [contactModalSubtitle, setContactModalSubtitle] = useState('')
  const [contactModalType, setContactModalType] = useState<ContactModalType>('interesados')
  const [contactModalLoading, setContactModalLoading] = useState(false)
  const [contactModalContacts, setContactModalContacts] = useState<ContactListItem[]>([])
  const [visitorsModalOpen, setVisitorsModalOpen] = useState(false)
  const [visitorsModalTitle, setVisitorsModalTitle] = useState('Visitantes')
  const [visitorsModalSubtitle, setVisitorsModalSubtitle] = useState('')
  const [visitorsModalLoading, setVisitorsModalLoading] = useState(false)
  const [visitorsModalData, setVisitorsModalData] = useState<DashboardVisitorDetail[]>([])

  const funnelChartData = React.useMemo(() => {
    if (analyticsEnabled) return funnelData
    return funnelData.filter((stage) => stage.stage?.trim().toLowerCase() !== 'visitantes')
  }, [analyticsEnabled, funnelData])

  const chartsGridClass = analyticsEnabled ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'

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

  const currencyAxisFormatter = React.useCallback((value: number) => formatChartCurrency(value), [])

  // Configuración del gráfico según la vista seleccionada
  const chartConfig = React.useMemo(() => {
    const now = new Date()
    const last12Months: string[] = []

    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      last12Months.push(monthKey)
    }

    const formatData = (rawData: { label: string; value: number; value2: number }[]) => {
      const dataMap = new Map(rawData.map(d => [d.label, d]))
      return last12Months.map((monthKey, index) => ({
        label: formatChartDate(monthKey, 365, index > 0 ? last12Months[index - 1] : undefined),
        value: dataMap.get(monthKey)?.value || 0,
        value2: dataMap.get(monthKey)?.value2 || 0
      }))
    }

    switch (selectedChartView) {
      case 'revenue-spend':
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: '#10b981',
          color2: '#64748b',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
      case 'visitors-leads':
        if (!analyticsEnabled) {
          return {
            data: formatData([]),
            label1: 'Ingresos',
            label2: 'Gastos',
            color: '#10b981',
            color2: '#64748b',
            formatValue: currencyAxisFormatter,
            formatTooltipValue: (value: number) => formatCurrency(value)
          }
        }
        return {
          data: formatData(visitorsLeadsData),
          label1: 'Visitantes',
          label2: labels.leads,
          color: '#3b82f6',
          color2: '#8b5cf6',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'leads-appointments':
        return {
          data: formatData(leadsAppointmentsData),
          label1: labels.leads,
          label2: 'Citas',
          color: '#8b5cf6',
          color2: '#ec4899',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'appointments-sales':
        return {
          data: formatData(appointmentsSalesData),
          label1: 'Citas',
          label2: 'Ventas',
          color: '#ec4899',
          color2: '#10b981',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      default:
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: '#10b981',
          color2: '#64748b',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
    }
  }, [analyticsEnabled, selectedChartView, formattedFinancialData, visitorsLeadsData, leadsAppointmentsData, appointmentsSalesData, labels.leads, currencyAxisFormatter])

  const isExtendedChartView = selectedChartView !== 'revenue-spend'
  const isChartLoading = isExtendedChartView && extendedChartDataLoading

  const hasChartData = React.useMemo(
    () => chartConfig.data.some(item => (item.value ?? 0) !== 0 || (item.value2 ?? 0) !== 0),
    [chartConfig]
  )

  const chartHeight = 340

  const chartViewOptions = React.useMemo(() => {
    const options: Array<{ value: 'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-sales'; label: string }> = [
      { value: 'revenue-spend', label: 'Ingresos vs Gastos' },
      { value: 'leads-appointments', label: `${labels.leads} vs Citas` },
      { value: 'appointments-sales', label: 'Citas vs Ventas' }
    ]

    if (analyticsEnabled) {
      options.splice(1, 0, { value: 'visitors-leads', label: `Visitantes vs ${labels.leads}` })
    }

    return options
  }, [analyticsEnabled, labels.leads])

  const activeChartLabel = React.useMemo(() => {
    const active = chartViewOptions.find(option => option.value === selectedChartView)
    return active?.label ?? 'Ingresos vs Gastos'
  }, [chartViewOptions, selectedChartView])

  const selectedRangeLabel = React.useMemo(() => {
    const from = formatDateToISO(dateRange.start)
    const to = formatDateToISO(dateRange.end)
    return from === to ? from : `${from} - ${to}`
  }, [dateRange.start, dateRange.end])

  const getFunnelStageKind = React.useCallback((stage: string): FunnelStageKind | null => {
    const normalized = stage.trim().toLowerCase()
    const leadsLabel = labels.leads.trim().toLowerCase()
    const customersLabel = labels.customers.trim().toLowerCase()

    if (normalized === 'visitantes') return 'visitors'
    if ([leadsLabel, 'leads', 'interesados', 'prospectos'].includes(normalized)) return 'leads'
    if (normalized === 'citas') return 'appointments'
    if (normalized === 'asistencias') return 'attendances'
    if ([customersLabel, 'clientes', 'customers'].includes(normalized)) return 'customers'
    return null
  }, [labels.customers, labels.leads])

  const handleFunnelStageClick = React.useCallback(async (stage: { stage: string; value: number }) => {
    const kind = getFunnelStageKind(stage.stage)
    if (!kind) return

    if (kind === 'visitors') {
      if (!analyticsEnabled) return

      setContactModalOpen(false)
      setVisitorsModalOpen(true)
      setVisitorsModalTitle('Visitantes')
      setVisitorsModalSubtitle(selectedRangeLabel)
      setVisitorsModalData([])
      setVisitorsModalLoading(true)

      try {
        const visitors = await dashboardService.getVisitorsList({
          start: dateRange.start,
          end: dateRange.end,
          scope: funnelScope
        })
        setVisitorsModalData(visitors)
      } catch {
        setVisitorsModalData([])
      } finally {
        setVisitorsModalLoading(false)
      }
      return
    }

    const contactConfig = {
      leads: { listType: 'interesados', modalType: 'interesados', title: labels.leads },
      appointments: { listType: 'appointments', modalType: 'appointments', title: 'Citas' },
      attendances: { listType: 'attendances', modalType: 'attendances', title: 'Asistencias' },
      customers: { listType: 'customers', modalType: 'sales', title: labels.customers }
    }[kind] as {
      listType: 'interesados' | 'customers' | 'appointments' | 'attendances'
      modalType: ContactModalType
      title: string
    }

    setVisitorsModalOpen(false)
    setContactModalOpen(true)
    setContactModalTitle(contactConfig.title)
    setContactModalSubtitle(selectedRangeLabel)
    setContactModalType(contactConfig.modalType)
    setContactModalContacts([])
    setContactModalLoading(true)

    try {
      const result = await reportsService.getContactsList({
        from: formatDateToISO(dateRange.start),
        to: formatEndDateToISO(dateRange.end),
        type: contactConfig.listType,
        scope: funnelScope
      })

      setContactModalContacts(result.contacts.map(contact => ({
        ...contact,
        created_at: contact.created_at || (contact as any).createdAt
      })))
    } catch {
      setContactModalContacts([])
    } finally {
      setContactModalLoading(false)
    }
  }, [analyticsEnabled, dateRange.end, dateRange.start, funnelScope, getFunnelStageKind, labels.customers, labels.leads, selectedRangeLabel])

  const financialScopeOptions = React.useMemo(
    () => [
      { value: 'all' as const, label: 'Todos', icon: Layers },
      { value: 'attribution' as const, label: 'Al registro', icon: Target },
      { value: 'campaigns' as const, label: 'Identificados de anuncios', icon: MousePointerClick }
    ],
    []
  )

  useEffect(() => {
    if (!analyticsEnabled && selectedChartView === 'visitors-leads') {
      setSelectedChartView('revenue-spend')
    }
  }, [analyticsEnabled, selectedChartView])

  // Cargar datasets extendidos del gráfico solo cuando sean necesarios
  const loadExtendedChartData = React.useCallback(async () => {
    if (!user || extendedChartDataLoading || extendedChartDataLoaded) {
      return
    }

    setExtendedChartDataLoading(true)
    try {
      const now = new Date()
      const twelveMonthsAgo = new Date(now)
      twelveMonthsAgo.setMonth(now.getMonth() - 12)

      const visitorsPromise = analyticsEnabled
        ? dashboardService.getVisitorsData({ start: twelveMonthsAgo, end: now, groupBy: 'month' })
        : Promise.resolve<{ label: string; value: number }[]>([])

      const [visitorsData, leadsData, appointmentsData, salesData] = await Promise.all([
        visitorsPromise,
        dashboardService.getLeadsData({ start: twelveMonthsAgo, end: now, groupBy: 'month' }),
        dashboardService.getAppointmentsData({ start: twelveMonthsAgo, end: now, groupBy: 'month' }),
        dashboardService.getSalesData({ start: twelveMonthsAgo, end: now, groupBy: 'month' })
      ])

      const visitorsMap = new Map(visitorsData.map(d => [d.label, d.value]))
      const leadsMap = new Map(leadsData.map(d => [d.label, d.value]))
      const appointmentsMap = new Map(appointmentsData.map(d => [d.label, d.value]))
      const salesMap = new Map(salesData.map(d => [d.label, d.value]))

      const allDates = new Set([
        ...visitorsData.map(d => d.label),
        ...leadsData.map(d => d.label),
        ...appointmentsData.map(d => d.label),
        ...salesData.map(d => d.label)
      ])
      const sortedDates = Array.from(allDates).sort()

      if (analyticsEnabled) {
        const visitorsLeads = sortedDates.map(date => ({
          label: date,
          value: visitorsMap.get(date) || 0,
          value2: leadsMap.get(date) || 0
        }))
        setVisitorsLeadsData(visitorsLeads)
      } else {
        setVisitorsLeadsData([])
      }

      const leadsAppointments = sortedDates.map(date => ({
        label: date,
        value: leadsMap.get(date) || 0,
        value2: appointmentsMap.get(date) || 0
      }))
      setLeadsAppointmentsData(leadsAppointments)

      const appointmentsSales = sortedDates.map(date => ({
        label: date,
        value: appointmentsMap.get(date) || 0,
        value2: salesMap.get(date) || 0
      }))
      setAppointmentsSalesData(appointmentsSales)

      setExtendedChartDataLoaded(true)
    } catch (error) {
      // TODO: Integrate logging service
      setExtendedChartDataLoaded(false)
    } finally {
      setExtendedChartDataLoading(false)
    }
  }, [analyticsEnabled, extendedChartDataLoaded, extendedChartDataLoading, user])

  React.useEffect(() => {
    setExtendedChartDataLoaded(false)
    setExtendedChartDataLoading(false)
    setVisitorsLeadsData([])
    setLeadsAppointmentsData([])
    setAppointmentsSalesData([])
  }, [analyticsEnabled, dateRange.start, dateRange.end])

  React.useEffect(() => {
    if (selectedChartView === 'revenue-spend') return
    if (!analyticsEnabled && selectedChartView === 'visitors-leads') return
    void loadExtendedChartData()
  }, [selectedChartView, analyticsEnabled, loadExtendedChartData])

  useEffect(() => {
    const loadData = async () => {
      if (!user) return

      setLoading(true)
      try {
        // Calcular últimos 12 meses para los gráficos
        const now = new Date()
        const twelveMonthsAgo = new Date(now)
        twelveMonthsAgo.setMonth(now.getMonth() - 12)

        const trafficPromise = analyticsEnabled
          ? dashboardService.getTrafficSources({
              start: dateRange.start,
              end: dateRange.end
            })
          : Promise.resolve<{ name: string; value: number; color: string }[]>([])

        const [metricsData, chartDataResponse, trafficSourcesData, funnelDataResponse] = await Promise.all([
          dashboardService.getDashboardMetrics({
            start: dateRange.start,
            end: dateRange.end
          }),
          dashboardService.getFinancialChart({
            start: twelveMonthsAgo,
            end: now,
            scope: financialScope
          }),
          trafficPromise,
          dashboardService.getFunnelData({
            start: dateRange.start,
            end: dateRange.end,
            scope: 'all'
          })
        ])

        setMetrics(metricsData)
        setChartData(chartDataResponse)
        setTrafficSources(analyticsEnabled ? trafficSourcesData : [])
        setFunnelData(funnelDataResponse)
      } catch (error) {
        // TODO: add logging service
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [analyticsEnabled, dateRange, financialScope, user])

  // useEffect separado solo para el funnel (no recarga toda la página)
  React.useEffect(() => {
    const loadFunnelData = async () => {
      setFunnelLoading(true)
      try {
        const funnelDataResponse = await dashboardService.getFunnelData({
          start: dateRange.start,
          end: dateRange.end,
          scope: funnelScope
        })
        setFunnelData(funnelDataResponse)
      } catch (error) {
        // Error silencioso
      } finally {
        setFunnelLoading(false)
      }
    }

    loadFunnelData()
  }, [funnelScope, dateRange])

  if (loading || !metrics) {
    return <Loading message="Cargando dashboard..." />
  }

  return (
    <>
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
          title="Costos Totales"
          value={formatCurrency(metrics.totalCostos.value)}
          delta={metrics.totalCostos.variation}
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
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
                {activeChartLabel}
              </h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">Últimos 12 meses</p>
            </div>
            <div className="flex items-end gap-4">
              {selectedChartView === 'revenue-spend' && (
                <div className={funnelStyles.scopeSelector}>
                  {financialScopeOptions.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      className={`${funnelStyles.scopeButton} ${financialScope === value ? funnelStyles.scopeButtonActive : ''}`}
                      onClick={() => setFinancialScope(value)}
                    >
                      <Icon size={13} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <ViewSelector
                options={chartViewOptions}
                value={selectedChartView}
                onChange={(value) => setSelectedChartView(value as any)}
              />
            </div>
          </div>
          <div className="relative w-full" style={{ minHeight: chartHeight, height: chartHeight }}>
            {isChartLoading ? (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Cargando datos del gráfico...
              </div>
            ) : hasChartData ? (
              <AreaChart
                data={chartConfig.data}
                height={chartHeight}
                showGrid
                color={chartConfig.color}
                color2={chartConfig.color2}
                formatValue={chartConfig.formatValue}
                formatTooltipValue={chartConfig.formatTooltipValue}
                showLegend
                legendLabels={{ label1: chartConfig.label1, label2: chartConfig.label2 }}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Sin datos disponibles
              </div>
            )}
          </div>
        </Card>

        <div className={chartsGridClass}>
          <ConversionFunnelChart
            data={funnelChartData}
            loading={funnelLoading}
            showVisitors={analyticsEnabled}
            scope={funnelScope}
            onScopeChange={setFunnelScope}
            onStageClick={handleFunnelStageClick}
          />
          {analyticsEnabled && (
            <TrafficSourcesChart
              data={trafficSources}
              loading={loading}
            />
          )}
        </div>
      </div>
      </PageContainer>

      <ContactDetailsModal
        isOpen={contactModalOpen}
        onClose={() => setContactModalOpen(false)}
        title={contactModalTitle}
        subtitle={contactModalSubtitle}
        data={contactModalContacts}
        loading={contactModalLoading}
        type={contactModalType}
      />

      <VisitorDetailsModal
        isOpen={visitorsModalOpen}
        onClose={() => setVisitorsModalOpen(false)}
        title={visitorsModalTitle}
        subtitle={visitorsModalSubtitle}
        data={visitorsModalData}
        loading={visitorsModalLoading}
      />
    </>
  )
}
