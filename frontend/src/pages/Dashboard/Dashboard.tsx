import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { KpiCard, Card, DateRangePicker, AreaChart, PageContainer, TrafficSourcesChart, ConversionFunnelChart, ViewSelector, Loading, ContactDetailsModal, VisitorDetailsModal, HelpTooltip, Modal } from '@/components/common'
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
  MousePointerClick,
  CalendarClock,
  ArrowRight,
  UserPlus,
  Clock3,
  Banknote
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig, useIsRenderDomain, useMetaTimezone } from '@/hooks'
import { dashboardService, type DashboardMetrics, type ChartData, type DashboardVisitorDetail } from '@/services/dashboardService'
import { reportsService, type ContactListItem } from '@/services/reportsService'
import { transactionsService, type Transaction } from '@/services/transactionsService'
import { calendarsService, type CalendarEvent } from '@/services/calendarsService'
import { campaignsService, type Campaign } from '@/services/campaignsService'
import { formatCurrency, formatRoas, formatChartDate, formatDateToISO, formatEndDateToISO, parseLocalDateString, formatChartCurrency, formatChartNumber, formatDate } from '@/utils/format'

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
type ChartView = 'revenue-spend' | 'visitors-leads' | 'leads-appointments' | 'appointments-attendances' | 'attendances-sales' | 'appointments-sales'
type ChartSeriesKey = 'value' | 'value2'

interface DashboardChartPoint {
  label: string
  value: number
  value2?: number
  periodStart: string
  periodEnd: string
  periodKey: string
}

type DashboardChartClickPoint = Omit<DashboardChartPoint, 'periodStart' | 'periodEnd' | 'periodKey'> & Partial<Pick<DashboardChartPoint, 'periodStart' | 'periodEnd' | 'periodKey'>>
type ChartInsightContactType = 'interesados' | 'customers' | 'sales' | 'appointments' | 'attendances'

interface DashboardChartConfig {
  data: DashboardChartPoint[]
  label1: string
  label2: string
  color: string
  color2: string
  formatValue: (value: number) => string
  formatTooltipValue: (value: number) => string
}

interface ChartInsightItem {
  id: string
  title: string
  subtitle?: string
  meta?: string
  value?: string
  status?: string
}

interface ChartInsightColumn {
  key: string
  title: string
  metricLabel: string
  metricValue: string
  emptyMessage: string
  items: ChartInsightItem[]
}

interface ChartInsightModalState {
  open: boolean
  requestKey?: string
  title: string
  subtitle: string
  loading: boolean
  columns: ChartInsightColumn[]
}

const emptyChartInsightModal: ChartInsightModalState = {
  open: false,
  title: '',
  subtitle: '',
  loading: false,
  columns: []
}

const TRANSACTION_STATUS_LABELS: Record<Transaction['status'], string> = {
  draft: 'Borrador',
  sent: 'Enviado',
  paid: 'Pagado',
  pending: 'Pendiente',
  overdue: 'Vencido',
  partial: 'Parcial',
  void: 'Anulado',
  refunded: 'Reembolsado',
  failed: 'Fallido',
  deleted: 'Eliminado'
}

const APPOINTMENT_STATUS_LABELS: Record<CalendarEvent['appointmentStatus'], string> = {
  confirmed: 'Confirmada',
  pending: 'Pendiente',
  cancelled: 'Cancelada',
  showed: 'Asistió',
  noshow: 'No asistió',
  rescheduled: 'Reagendada'
}

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])

const isSuccessfulPaymentStatus = (status?: string | null) => (
  SUCCESS_PAYMENT_STATUSES.has(status?.trim().toLowerCase() ?? '')
)

const getTimeValue = (date?: string | null) => {
  if (!date) return 0
  const time = new Date(date).getTime()
  return Number.isNaN(time) ? 0 : time
}

const getTransactionDate = (transaction: Transaction) => (
  transaction.date || transaction.createdAt || transaction.sentAt || transaction.updatedAt || ''
)

const getContactCreatedAt = (contact: ContactListItem) => (
  contact.created_at || (contact as any).createdAt || ''
)

const getContactName = (contact: ContactListItem) => (
  contact.name || contact.email || contact.phone || 'Contacto sin nombre'
)

const getAppointmentTitle = (appointment: CalendarEvent) => (
  appointment.title || appointment.description || 'Cita sin título'
)

const getLast12MonthKeys = () => {
  const now = new Date()
  const months: string[] = []

  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
  }

  return months
}

const getMonthPeriod = (monthKey: string) => {
  const [year, month] = monthKey.split('-').map(Number)
  const start = new Date(year, month - 1, 1)
  const end = new Date(year, month, 0)

  return {
    periodStart: formatDateToISO(start),
    periodEnd: formatEndDateToISO(end)
  }
}

const formatPeriodRange = (from: string, to: string) => {
  const startDate = parseLocalDateString(from.slice(0, 10))
  const endDate = to.includes('T') ? new Date(to) : parseLocalDateString(to.slice(0, 10))

  return `${formatDate(startDate, { includeYear: true })} - ${formatDate(endDate, { includeYear: true })}`
}

export const Dashboard: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { user, locationId, accessToken } = useAuth()
  const { labels } = useLabels()
  const { formatLocalDateTime } = useTimezone()

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
  const [appointmentsAttendancesData, setAppointmentsAttendancesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [attendancesSalesData, setAttendancesSalesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [appointmentsSalesData, setAppointmentsSalesData] = useState<{ label: string; value: number; value2: number }[]>([])
  const [trafficSources, setTrafficSources] = useState<{ name: string; value: number; color: string }[]>([])
  const [funnelData, setFunnelData] = useState<{ stage: string; value: number }[]>([])
  const [funnelScope, setFunnelScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [financialScope, setFinancialScope] = useState<'all' | 'attribution' | 'campaigns'>('all')
  const [funnelLoading, setFunnelLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selectedChartView, setSelectedChartView] = useState<ChartView>('revenue-spend')
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
  const [operationsLoading, setOperationsLoading] = useState(false)
  const [recentTransactions, setRecentTransactions] = useState<Transaction[]>([])
  const [recentAppointments, setRecentAppointments] = useState<CalendarEvent[]>([])
  const [recentContacts, setRecentContacts] = useState<ContactListItem[]>([])
  const [chartInsightModal, setChartInsightModal] = useState<ChartInsightModalState>(emptyChartInsightModal)

  const funnelChartData = React.useMemo(() => {
    if (analyticsEnabled) return funnelData
    return funnelData.filter((stage) => stage.stage?.trim().toLowerCase() !== 'visitantes')
  }, [analyticsEnabled, funnelData])

  const chartsGridClass = analyticsEnabled ? 'grid gap-4 lg:grid-cols-2' : 'grid gap-4'
  const last12MonthKeys = React.useMemo(() => getLast12MonthKeys(), [])

  // Agrupar datos financieros por mes para últimos 12 meses
  const formattedFinancialData = React.useMemo<DashboardChartPoint[]>(() => {
    // Agrupar datos por mes
    const monthlyData = chartData.reduce((acc, item) => {
      const monthMatch = /^(\d{4})-(\d{2})/.exec(item.date)
      const date = monthMatch ? null : new Date(item.date)
      if (!monthMatch && (!date || Number.isNaN(date.getTime()))) {
        return acc
      }
      const monthKey = monthMatch
        ? `${monthMatch[1]}-${monthMatch[2]}`
        : `${date?.getFullYear()}-${String((date?.getMonth() ?? 0) + 1).padStart(2, '0')}`

      if (!acc[monthKey]) {
        acc[monthKey] = { ingresos: 0, gastado: 0 }
      }

      acc[monthKey].ingresos += item.ingresos
      acc[monthKey].gastado += item.gastado

      return acc
    }, {} as Record<string, { ingresos: number; gastado: number }>)

    // Crear array con todos los 12 meses (con o sin datos)
    return last12MonthKeys.map((monthKey, index) => {
      const period = getMonthPeriod(monthKey)

      return {
        label: formatChartDate(monthKey, 365, index > 0 ? last12MonthKeys[index - 1] : undefined),
        value: monthlyData[monthKey]?.ingresos || 0,
        value2: monthlyData[monthKey]?.gastado || 0,
        periodKey: monthKey,
        ...period
      }
    })
  }, [chartData, last12MonthKeys])

  const currencyAxisFormatter = React.useCallback((value: number) => formatChartCurrency(value), [])

  // Configuración del gráfico según la vista seleccionada
  const chartConfig = React.useMemo<DashboardChartConfig>(() => {
    const formatData = (rawData: { label: string; value: number; value2: number }[]): DashboardChartPoint[] => {
      const dataMap = new Map(rawData.map(d => [d.label, d]))
      return last12MonthKeys.map((monthKey, index) => {
        const period = getMonthPeriod(monthKey)

        return {
          label: formatChartDate(monthKey, 365, index > 0 ? last12MonthKeys[index - 1] : undefined),
          value: dataMap.get(monthKey)?.value || 0,
          value2: dataMap.get(monthKey)?.value2 || 0,
          periodKey: monthKey,
          ...period
        }
      })
    }

    switch (selectedChartView) {
      case 'revenue-spend':
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-secondary, #64748b)',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
      case 'visitors-leads':
        if (!analyticsEnabled) {
          return {
            data: formatData([]),
            label1: 'Ingresos',
            label2: 'Gastos',
            color: 'var(--design-chart-primary, #10b981)',
            color2: 'var(--design-chart-secondary, #64748b)',
            formatValue: currencyAxisFormatter,
            formatTooltipValue: (value: number) => formatCurrency(value)
          }
        }
        return {
          data: formatData(visitorsLeadsData),
          label1: 'Visitantes',
          label2: labels.leads,
          color: 'var(--design-chart-tertiary, #3b82f6)',
          color2: 'var(--design-chart-accent, #8b5cf6)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'leads-appointments':
        return {
          data: formatData(leadsAppointmentsData),
          label1: labels.leads,
          label2: 'Citas',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-warning, #f59e0b)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'appointments-attendances':
        return {
          data: formatData(appointmentsAttendancesData),
          label1: 'Citas',
          label2: 'Asistencias',
          color: 'var(--design-chart-warning, #f59e0b)',
          color2: 'var(--design-chart-tertiary, #3b82f6)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'attendances-sales':
        return {
          data: formatData(attendancesSalesData),
          label1: 'Asistencias',
          label2: 'Ventas',
          color: 'var(--design-chart-tertiary, #3b82f6)',
          color2: 'var(--design-chart-primary, #10b981)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      case 'appointments-sales':
        return {
          data: formatData(appointmentsSalesData),
          label1: 'Citas',
          label2: 'Ventas',
          color: 'var(--design-chart-warning, #f59e0b)',
          color2: 'var(--design-chart-primary, #10b981)',
          formatValue: formatChartNumber,
          formatTooltipValue: (value: number) => value.toLocaleString('es-MX')
        }
      default:
        return {
          data: formattedFinancialData,
          label1: 'Ingresos',
          label2: 'Gastos',
          color: 'var(--design-chart-primary, #10b981)',
          color2: 'var(--design-chart-secondary, #64748b)',
          formatValue: currencyAxisFormatter,
          formatTooltipValue: (value: number) => formatCurrency(value)
        }
    }
  }, [analyticsEnabled, selectedChartView, formattedFinancialData, visitorsLeadsData, leadsAppointmentsData, appointmentsAttendancesData, attendancesSalesData, appointmentsSalesData, labels.leads, currencyAxisFormatter, last12MonthKeys])

  const isExtendedChartView = selectedChartView !== 'revenue-spend'
  const isChartLoading = isExtendedChartView && extendedChartDataLoading

  const hasChartData = React.useMemo(
    () => chartConfig.data.some(item => (item.value ?? 0) !== 0 || (item.value2 ?? 0) !== 0),
    [chartConfig]
  )

  const chartHeight = 340

  const chartViewOptions = React.useMemo(() => {
    const options: Array<{ value: ChartView; label: string }> = [
      { value: 'revenue-spend', label: 'Ingresos vs Gastos' },
      { value: 'leads-appointments', label: `${labels.leads} vs Citas` },
      { value: 'appointments-attendances', label: 'Citas vs Asistencias' },
      { value: 'attendances-sales', label: 'Asistencias vs Ventas' },
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
      {
        value: 'all' as const,
        label: 'Todos',
        icon: Layers,
        description: 'Muestra ingresos y gasto por la fecha real en que ocurrió cada evento.'
      },
      {
        value: 'attribution' as const,
        label: 'Al registro',
        icon: Target,
        description: 'Agrupa los resultados en la fecha de creación del contacto para evaluar qué registros convirtieron.'
      },
      {
        value: 'campaigns' as const,
        label: 'Identificados de anuncios',
        icon: MousePointerClick,
        description: 'Filtra a contactos identificados desde anuncios y atribuye sus resultados al día de registro.'
      }
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

      const [visitorsData, leadsData, appointmentsData, attendancesData, salesData] = await Promise.all([
        visitorsPromise,
        dashboardService.getLeadsData({ start: twelveMonthsAgo, end: now, groupBy: 'month' }),
        dashboardService.getAppointmentsData({ start: twelveMonthsAgo, end: now, groupBy: 'month' }),
        dashboardService.getAttendancesData({ start: twelveMonthsAgo, end: now, groupBy: 'month' }),
        dashboardService.getSalesData({ start: twelveMonthsAgo, end: now, groupBy: 'month' })
      ])

      const visitorsMap = new Map(visitorsData.map(d => [d.label, d.value]))
      const leadsMap = new Map(leadsData.map(d => [d.label, d.value]))
      const appointmentsMap = new Map(appointmentsData.map(d => [d.label, d.value]))
      const attendancesMap = new Map(attendancesData.map(d => [d.label, d.value]))
      const salesMap = new Map(salesData.map(d => [d.label, d.value]))

      const allDates = new Set([
        ...visitorsData.map(d => d.label),
        ...leadsData.map(d => d.label),
        ...appointmentsData.map(d => d.label),
        ...attendancesData.map(d => d.label),
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

      const appointmentsAttendances = sortedDates.map(date => ({
        label: date,
        value: appointmentsMap.get(date) || 0,
        value2: attendancesMap.get(date) || 0
      }))
      setAppointmentsAttendancesData(appointmentsAttendances)

      const attendancesSales = sortedDates.map(date => ({
        label: date,
        value: attendancesMap.get(date) || 0,
        value2: salesMap.get(date) || 0
      }))
      setAttendancesSalesData(attendancesSales)

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
    setAppointmentsAttendancesData([])
    setAttendancesSalesData([])
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

  useEffect(() => {
    if (!user) return

    let mounted = true

    const loadOperationalSnapshot = async () => {
      setOperationsLoading(true)

      const from = formatDateToISO(dateRange.start)
      const to = formatEndDateToISO(dateRange.end)
      const rangeStart = new Date(dateRange.start)
      rangeStart.setHours(0, 0, 0, 0)
      const rangeEnd = new Date(dateRange.end)
      rangeEnd.setHours(23, 59, 59, 999)

      const appointmentsPromise = locationId && accessToken
        ? (async () => {
            const calendars = await calendarsService.getCalendars(locationId, accessToken)
            const activeCalendars = calendars.filter(calendar => calendar.isActive)

            if (!activeCalendars.length) {
              return calendarsService.getEvents(
                locationId,
                rangeStart.getTime(),
                rangeEnd.getTime(),
                accessToken
              )
            }

            const results = await Promise.allSettled(
              activeCalendars.map(calendar => calendarsService.getEvents(
                locationId,
                rangeStart.getTime(),
                rangeEnd.getTime(),
                accessToken,
                calendar.id
              ))
            )

            const uniqueEvents = new Map<string, CalendarEvent>()

            results.forEach(result => {
              if (result.status !== 'fulfilled') return

              result.value.forEach(event => {
                const eventKey = event.id || `${event.calendarId}-${event.startTime}-${event.title}`
                uniqueEvents.set(eventKey, event)
              })
            })

            return Array.from(uniqueEvents.values())
          })()
        : Promise.resolve<CalendarEvent[]>([])

      try {
        const [transactionsData, contactsResult, appointmentsData] = await Promise.all([
          transactionsService.getTransactions(from, to),
          reportsService.getContactsList({
            from,
            to,
            type: 'interesados',
            scope: 'all'
          }).then(result => result.contacts).catch(() => [] as ContactListItem[]),
          appointmentsPromise
        ])

        if (!mounted) return

        const sortedTransactions = [...transactionsData]
          .sort((a, b) => getTimeValue(getTransactionDate(b)) - getTimeValue(getTransactionDate(a)))
          .slice(0, 5)

        const sortedContacts = [...contactsResult]
          .sort((a, b) => getTimeValue(getContactCreatedAt(b)) - getTimeValue(getContactCreatedAt(a)))
          .slice(0, 5)

        const sortedAppointments = [...appointmentsData]
          .sort((a, b) => getTimeValue(b.startTime) - getTimeValue(a.startTime))
          .slice(0, 5)

        setRecentTransactions(sortedTransactions)
        setRecentContacts(sortedContacts)
        setRecentAppointments(sortedAppointments)
      } catch {
        if (!mounted) return
        setRecentTransactions([])
        setRecentContacts([])
        setRecentAppointments([])
      } finally {
        if (mounted) {
          setOperationsLoading(false)
        }
      }
    }

    loadOperationalSnapshot()

    return () => {
      mounted = false
    }
  }, [accessToken, dateRange.end, dateRange.start, locationId, user])

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

  const renderOperationsLoadingRows = (count = 4) => (
    Array.from({ length: count }).map((_, index) => (
      <div key={`operations-loading-${index}`} className="flex items-center justify-between gap-4 border-b border-[rgba(148,163,184,0.12)] py-3 last:border-b-0">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--color-text-primary)_9%,transparent)]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[color-mix(in_srgb,var(--color-text-primary)_7%,transparent)]" />
        </div>
        <div className="h-6 w-20 animate-pulse rounded-full bg-[color-mix(in_srgb,var(--color-text-primary)_7%,transparent)]" />
      </div>
    ))
  )

  const renderEmptyOperationsState = (message: string) => (
    <div className="flex min-h-[156px] items-center justify-center rounded-xl border border-dashed border-[rgba(148,163,184,0.2)] px-4 text-center text-sm text-[var(--color-text-tertiary)]">
      {message}
    </div>
  )

  const getStatusClassName = (status?: string | null) => {
    const normalized = status?.toLowerCase()

    if (normalized === 'paid' || normalized === 'succeeded' || normalized === 'success' || normalized === 'completed' || normalized === 'confirmed' || normalized === 'showed') {
      return 'border-[rgba(16,185,129,0.34)] text-[var(--color-status-success)]'
    }

    if (normalized === 'pending' || normalized === 'sent' || normalized === 'partial' || normalized === 'rescheduled') {
      return 'border-[rgba(245,158,11,0.34)] text-[var(--color-status-warning)]'
    }

    if (normalized === 'failed' || normalized === 'overdue' || normalized === 'refunded' || normalized === 'void' || normalized === 'cancelled' || normalized === 'noshow') {
      return 'border-[rgba(220,38,38,0.34)] text-[var(--color-status-error)]'
    }

    return 'border-[rgba(148,163,184,0.22)] text-[var(--color-text-secondary)]'
  }

  const normalizeContacts = React.useCallback((contacts: ContactListItem[]) => (
    contacts.map(contact => ({
      ...contact,
      created_at: contact.created_at || (contact as any).createdAt || ''
    }))
  ), [])

  const fetchContactsForInsight = React.useCallback(async (
    type: ChartInsightContactType,
    from: string,
    to: string,
    scope: 'all' | 'attribution' | 'campaigns' = 'all'
  ) => {
    const result = await reportsService.getContactsList({ from, to, type, scope })
    return normalizeContacts(result.contacts)
  }, [normalizeContacts])

  const mapContactsToInsightItems = React.useCallback((
    contacts: ContactListItem[],
    context: 'lead' | 'appointment' | 'attendance' | 'payment' = 'lead'
  ): ChartInsightItem[] => {
    const getPrimaryDate = (contact: ContactListItem) => {
      if (context === 'payment') {
        const payment = [...(contact.payments ?? [])]
          .filter(paymentItem => isSuccessfulPaymentStatus(paymentItem.status))
          .sort((a, b) => getTimeValue(b.date) - getTimeValue(a.date))[0]
        return payment?.date || getContactCreatedAt(contact)
      }

      if (context === 'appointment' || context === 'attendance') {
        const appointment = [...(contact.appointments ?? [])]
          .sort((a, b) => getTimeValue(b.start_time) - getTimeValue(a.start_time))[0]
        return appointment?.start_time || getContactCreatedAt(contact)
      }

      return getContactCreatedAt(contact)
    }

    return [...contacts]
      .sort((a, b) => getTimeValue(getPrimaryDate(b)) - getTimeValue(getPrimaryDate(a)))
      .map(contact => {
        const successfulPayments = [...(contact.payments ?? [])]
          .filter(payment => isSuccessfulPaymentStatus(payment.status))
          .sort((a, b) => getTimeValue(b.date) - getTimeValue(a.date))
        const primaryPayment = successfulPayments[0]
        const paymentTotal = successfulPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        const appointments = [...(contact.appointments ?? [])]
          .sort((a, b) => getTimeValue(b.start_time) - getTimeValue(a.start_time))
        const primaryAppointment = appointments[0]
        const contactValue = context === 'payment'
          ? paymentTotal || contact.ltv || contact.lifetimeLtv || 0
          : contact.ltv || contact.lifetimeLtv || 0
        const subtitle = contact.email || contact.phone || contact.source || contact.firstSession?.campaign_name || 'Sin datos de contacto'
        const meta = context === 'payment'
          ? primaryPayment
            ? `Pago ${formatDate(primaryPayment.date, { includeYear: true })}`
            : `Registro ${formatDate(getContactCreatedAt(contact), { includeYear: true })}`
          : (context === 'appointment' || context === 'attendance') && primaryAppointment
            ? formatLocalDateTime(primaryAppointment.start_time)
            : `Registro ${formatDate(getContactCreatedAt(contact), { includeYear: true })}`

        return {
          id: `contact-${contact.id}`,
          title: getContactName(contact),
          subtitle,
          meta,
          value: contactValue > 0 ? formatCurrency(contactValue) : undefined,
          status: context === 'payment'
            ? 'Pagó'
            : context === 'attendance'
              ? 'Asistió'
              : context === 'appointment'
                ? 'Citado'
                : contact.attributed
                  ? 'Anuncio'
                  : undefined
        }
      })
  }, [formatLocalDateTime])

  const mapVisitorsToInsightItems = React.useCallback((visitors: DashboardVisitorDetail[]): ChartInsightItem[] => (
    [...visitors]
      .sort((a, b) => getTimeValue(b.createdAt || b.firstVisit) - getTimeValue(a.createdAt || a.firstVisit))
      .map(visitor => {
        const contact = visitor.contact
        const source = visitor.utmCampaign || visitor.adName || visitor.utmSource || visitor.pageUrl || 'Sin fuente'
        const title = contact?.name || contact?.email || contact?.phone || `Visitante ${visitor.visitorId.slice(0, 8)}`
        const subtitle = contact?.email || contact?.phone || source
        const device = [visitor.deviceType, visitor.browser].filter(Boolean).join(' · ')

        return {
          id: `visitor-${visitor.visitorId}-${visitor.sessionId ?? 'session'}`,
          title,
          subtitle,
          meta: `${formatDate(visitor.createdAt || visitor.firstVisit, { includeYear: true })}${device ? ` · ${device}` : ''}`,
          value: contact?.ltv && contact.ltv > 0 ? formatCurrency(contact.ltv) : undefined,
          status: visitor.contactId ? 'Con contacto' : 'Visitante'
        }
      })
  ), [])

  const mapCampaignsToInsightItems = React.useCallback((campaigns: Campaign[]): ChartInsightItem[] => (
    campaigns
      .filter(campaign => Number(campaign.spend || 0) > 0)
      .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0))
      .map(campaign => ({
        id: `campaign-${campaign.id}`,
        title: campaign.name || 'Campaña sin nombre',
        subtitle: `${(campaign.clicks || 0).toLocaleString('es-MX')} clicks · ${(campaign.reach || 0).toLocaleString('es-MX')} alcance`,
        meta: `ROAS ${formatRoas(campaign.roas || 0)}`,
        value: formatCurrency(campaign.spend || 0),
        status: 'Gasto'
      }))
  ), [])

  const buildInsightColumn = React.useCallback((
    key: string,
    title: string,
    metricLabel: string,
    metricValue: string,
    emptyMessage: string,
    items: ChartInsightItem[]
  ): ChartInsightColumn => ({
    key,
    title,
    metricLabel,
    metricValue,
    emptyMessage,
    items
  }), [])

  const handleChartPointClick = React.useCallback(async (
    point: DashboardChartClickPoint,
    _index: number,
    _seriesKey: ChartSeriesKey
  ) => {
    const inferredPeriod = point.periodKey ? getMonthPeriod(point.periodKey) : null
    const periodStart = point.periodStart ?? inferredPeriod?.periodStart
    const periodEnd = point.periodEnd ?? inferredPeriod?.periodEnd

    if (!periodStart || !periodEnd) return

    const requestKey = `${selectedChartView}-${periodStart}-${periodEnd}-${Date.now()}`
    const metricValue1 = chartConfig.formatTooltipValue(point.value || 0)
    const metricValue2 = chartConfig.formatTooltipValue(point.value2 || 0)
    const modalTitle = `${activeChartLabel} · ${point.label}`

    setChartInsightModal({
      open: true,
      requestKey,
      title: modalTitle,
      subtitle: formatPeriodRange(periodStart, periodEnd),
      loading: true,
      columns: []
    })

    const commitColumns = (columns: ChartInsightColumn[]) => {
      setChartInsightModal(prev => (
        prev.requestKey === requestKey
          ? { ...prev, loading: false, columns }
          : prev
      ))
    }

    try {
      let columns: ChartInsightColumn[] = []

      if (selectedChartView === 'revenue-spend') {
        const [payingContacts, campaigns] = await Promise.all([
          fetchContactsForInsight('sales', periodStart, periodEnd, financialScope),
          campaignsService.getCampaigns(periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'revenue',
            'Personas que pagaron',
            chartConfig.label1,
            metricValue1,
            'Sin pagos registrados en este mes.',
            mapContactsToInsightItems(payingContacts, 'payment')
          ),
          buildInsightColumn(
            'spend',
            'Gastos de publicidad',
            chartConfig.label2,
            metricValue2,
            'Sin gasto publicitario en este mes.',
            mapCampaignsToInsightItems(campaigns)
          )
        ]
      } else if (selectedChartView === 'visitors-leads') {
        const [visitors, leads] = await Promise.all([
          dashboardService.getVisitorsList({
            start: parseLocalDateString(periodStart.slice(0, 10)),
            end: new Date(periodEnd),
            scope: 'all'
          }),
          fetchContactsForInsight('interesados', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'visitors',
            'Visitantes',
            chartConfig.label1,
            metricValue1,
            'Sin visitantes registrados en este mes.',
            mapVisitorsToInsightItems(visitors)
          ),
          buildInsightColumn(
            'leads',
            labels.leads,
            chartConfig.label2,
            metricValue2,
            `Sin ${labels.leads.toLowerCase()} registrados en este mes.`,
            mapContactsToInsightItems(leads, 'lead')
          )
        ]
      } else if (selectedChartView === 'leads-appointments') {
        const [leads, appointments] = await Promise.all([
          fetchContactsForInsight('interesados', periodStart, periodEnd),
          fetchContactsForInsight('appointments', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'leads',
            labels.leads,
            chartConfig.label1,
            metricValue1,
            `Sin ${labels.leads.toLowerCase()} registrados en este mes.`,
            mapContactsToInsightItems(leads, 'lead')
          ),
          buildInsightColumn(
            'appointments',
            'Citados',
            chartConfig.label2,
            metricValue2,
            'Sin citas registradas en este mes.',
            mapContactsToInsightItems(appointments, 'appointment')
          )
        ]
      } else if (selectedChartView === 'appointments-attendances') {
        const [appointments, attendances] = await Promise.all([
          fetchContactsForInsight('appointments', periodStart, periodEnd),
          fetchContactsForInsight('attendances', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'appointments',
            'Citados',
            chartConfig.label1,
            metricValue1,
            'Sin citas registradas en este mes.',
            mapContactsToInsightItems(appointments, 'appointment')
          ),
          buildInsightColumn(
            'attendances',
            'Asistieron',
            chartConfig.label2,
            metricValue2,
            'Sin asistencias registradas en este mes.',
            mapContactsToInsightItems(attendances, 'attendance')
          )
        ]
      } else if (selectedChartView === 'attendances-sales') {
        const [attendances, payingContacts] = await Promise.all([
          fetchContactsForInsight('attendances', periodStart, periodEnd),
          fetchContactsForInsight('sales', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'attendances',
            'Asistieron',
            chartConfig.label1,
            metricValue1,
            'Sin asistencias registradas en este mes.',
            mapContactsToInsightItems(attendances, 'attendance')
          ),
          buildInsightColumn(
            'sales',
            'Clientes que pagaron',
            chartConfig.label2,
            metricValue2,
            'Sin clientes con pago en este mes.',
            mapContactsToInsightItems(payingContacts, 'payment')
          )
        ]
      } else if (selectedChartView === 'appointments-sales') {
        const [appointments, payingContacts] = await Promise.all([
          fetchContactsForInsight('appointments', periodStart, periodEnd),
          fetchContactsForInsight('sales', periodStart, periodEnd)
        ])

        columns = [
          buildInsightColumn(
            'appointments',
            'Citados',
            chartConfig.label1,
            metricValue1,
            'Sin citas registradas en este mes.',
            mapContactsToInsightItems(appointments, 'appointment')
          ),
          buildInsightColumn(
            'sales',
            'Clientes que pagaron',
            chartConfig.label2,
            metricValue2,
            'Sin clientes con pago en este mes.',
            mapContactsToInsightItems(payingContacts, 'payment')
          )
        ]
      }

      commitColumns(columns)
    } catch {
      commitColumns([
        buildInsightColumn(
          'error',
          'Detalle del punto',
          'Estado',
          'Sin cargar',
          'No se pudo cargar el detalle de este punto.',
          []
        )
      ])
    }
  }, [
    activeChartLabel,
    buildInsightColumn,
    chartConfig,
    fetchContactsForInsight,
    financialScope,
    labels.leads,
    mapCampaignsToInsightItems,
    mapContactsToInsightItems,
    mapVisitorsToInsightItems,
    selectedChartView
  ])

  const renderInsightLoadingColumns = () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {[0, 1].map(columnIndex => (
        <div key={`chart-insight-loading-${columnIndex}`} className="rounded-xl border border-[rgba(148,163,184,0.18)]">
          <div className="border-b border-[rgba(148,163,184,0.14)] p-4">
            <div className="h-4 w-32 animate-pulse rounded bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)]" />
            <div className="mt-3 h-7 w-24 animate-pulse rounded bg-[color-mix(in_srgb,var(--color-text-primary)_10%,transparent)]" />
          </div>
          <div className="p-4">
            {renderOperationsLoadingRows(5)}
          </div>
        </div>
      ))}
    </div>
  )

  const renderInsightItem = (item: ChartInsightItem) => (
    <div key={item.id} className="flex items-start justify-between gap-4 border-b border-[rgba(148,163,184,0.12)] py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="m-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">{item.title}</p>
        {item.subtitle && (
          <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">{item.subtitle}</p>
        )}
        {item.meta && (
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{item.meta}</p>
        )}
      </div>
      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
        {item.value && (
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{item.value}</span>
        )}
        {item.status && (
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusClassName(item.status)}`}>
            {item.status}
          </span>
        )}
      </div>
    </div>
  )

  if (loading || !metrics) {
    return <Loading message="Cargando dashboard..." />
  }

  return (
    <>
      <PageContainer>
      <div data-ristak-dashboard className="flex flex-col" style={{ gap: '18px' }}>
        <div data-dashboard-topbar className="flex flex-col items-start justify-between gap-3 md:flex-row md:items-end">
          <div data-dashboard-heading className="flex flex-col items-start gap-1">
            <h1 className="m-0 text-[24px] font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          </div>
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

        <div data-dashboard-kpi-grid className="grid grid-cols-2 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-4">
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

        <Card data-dashboard-chart-card variant="glass" className="space-y-5">
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-[var(--color-text-primary)]">
                {activeChartLabel}
              </h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">Últimos 12 meses</p>
            </div>
            <div className="flex items-end gap-4">
              {selectedChartView === 'revenue-spend' && (
                <div className={funnelStyles.scopeSelector} data-ristak-scope-selector>
                  {financialScopeOptions.map(({ value, label, icon: Icon, description }) => {
                    const button = (
                      <button
                        className={`${funnelStyles.scopeButton} ${financialScope === value ? funnelStyles.scopeButtonActive : ''}`}
                        data-ristak-scope-button
                        data-active={financialScope === value ? 'true' : undefined}
                        onClick={() => setFinancialScope(value)}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    )

                    return (
                      <HelpTooltip key={value} content={description}>
                        {button}
                      </HelpTooltip>
                    )
                  })}
                </div>
              )}
              <ViewSelector
                options={chartViewOptions}
                value={selectedChartView}
                onChange={(value) => setSelectedChartView(value as ChartView)}
              />
            </div>
          </div>
          <div className="relative w-full" style={{ minHeight: chartHeight, height: chartHeight }}>
            {isChartLoading ? (
              <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
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
                  onPointClick={handleChartPointClick}
                />
            ) : (
              <div data-ristak-chart-empty className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
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

        <section data-dashboard-operations className="grid gap-4 xl:grid-cols-3">
          <Card variant="glass" className="flex min-h-[320px] flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <Banknote className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Pagos</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Últimos pagos</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Movimientos del rango activo</p>
              </div>
              <Link
                to="/transactions"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentTransactions.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentTransactions.map((transaction) => (
                    <div key={transaction.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">
                          {transaction.contactName || transaction.email || 'Cliente sin nombre'}
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                          {formatDate(getTransactionDate(transaction), { includeYear: true })}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                          {formatCurrency(transaction.amount)}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusClassName(transaction.status)}`}>
                          {TRANSACTION_STATUS_LABELS[transaction.status] ?? transaction.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                renderEmptyOperationsState('Sin pagos registrados en este rango.')
              )}
            </div>
          </Card>

          <Card variant="glass" className="flex min-h-[320px] flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <CalendarClock className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Citas</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Últimas citas</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Eventos del rango activo</p>
              </div>
              <Link
                to="/appointments"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentAppointments.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentAppointments.map((appointment) => (
                    <div key={appointment.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">
                          {getAppointmentTitle(appointment)}
                        </p>
                        <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatLocalDateTime(appointment.startTime)}
                        </p>
                      </div>
                      <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getStatusClassName(appointment.appointmentStatus)}`}>
                        {APPOINTMENT_STATUS_LABELS[appointment.appointmentStatus] ?? appointment.appointmentStatus}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                renderEmptyOperationsState(locationId && accessToken ? 'No hay citas en el rango activo.' : 'Conecta HighLevel para ver citas aquí.')
              )}
            </div>
          </Card>

          <Card variant="glass" className="flex min-h-[320px] flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2 text-[var(--color-text-tertiary)]">
                  <UserPlus className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]">Contactos</span>
                </div>
                <h3 className="m-0 text-lg font-semibold text-[var(--color-text-primary)]">Nuevos contactos</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Registros recientes del rango activo</p>
              </div>
              <Link
                to="/contacts"
                className="inline-flex flex-shrink-0 items-center gap-1 text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              >
                Ver
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            <div className="flex-1">
              {operationsLoading ? renderOperationsLoadingRows() : recentContacts.length > 0 ? (
                <div className="divide-y divide-[rgba(148,163,184,0.12)]">
                  {recentContacts.map((contact) => (
                    <div key={contact.id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="m-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">
                          {getContactName(contact)}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--color-text-tertiary)]">
                          {contact.email || contact.phone || 'Sin datos de contacto'}
                        </p>
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                        <span className="text-xs text-[var(--color-text-tertiary)]">
                          {formatDate(getContactCreatedAt(contact), { includeYear: true })}
                        </span>
                        {contact.ltv > 0 && (
                          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
                            {formatCurrency(contact.ltv)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                renderEmptyOperationsState('Sin contactos nuevos en este rango.')
              )}
            </div>
          </Card>
        </section>
        </div>
        </PageContainer>

        <Modal
          isOpen={chartInsightModal.open}
          onClose={() => setChartInsightModal(emptyChartInsightModal)}
          title={chartInsightModal.title}
          size="xl"
          type="custom"
        >
          <div className="space-y-5 p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="m-0 text-sm text-[var(--color-text-secondary)]">{chartInsightModal.subtitle}</p>
              {!chartInsightModal.loading && chartInsightModal.columns.length > 0 && (
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  {chartInsightModal.columns.reduce((total, column) => total + column.items.length, 0).toLocaleString('es-MX')} registros
                </span>
              )}
            </div>

            {chartInsightModal.loading ? renderInsightLoadingColumns() : chartInsightModal.columns.length > 0 ? (
              <div className={`grid gap-4 ${chartInsightModal.columns.length > 1 ? 'lg:grid-cols-2' : ''}`}>
                {chartInsightModal.columns.map(column => (
                  <div key={column.key} className="min-w-0 rounded-xl border border-[rgba(148,163,184,0.18)]">
                    <div className="flex items-start justify-between gap-4 border-b border-[rgba(148,163,184,0.14)] p-4">
                      <div className="min-w-0">
                        <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                          {column.metricLabel}
                        </p>
                        <h3 className="mt-1 truncate text-base font-semibold text-[var(--color-text-primary)]">
                          {column.title}
                        </h3>
                      </div>
                      <span className="flex-shrink-0 text-lg font-semibold text-[var(--color-text-primary)]">
                        {column.metricValue}
                      </span>
                    </div>
                    <div className="max-h-[52vh] overflow-y-auto px-4">
                      {column.items.length > 0 ? (
                        column.items.map(renderInsightItem)
                      ) : (
                        <div className="flex min-h-[180px] items-center justify-center px-4 text-center text-sm text-[var(--color-text-tertiary)]">
                          {column.emptyMessage}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[240px] items-center justify-center rounded-xl border border-dashed border-[rgba(148,163,184,0.2)] px-4 text-center text-sm text-[var(--color-text-tertiary)]">
                Sin detalles disponibles para este punto.
              </div>
            )}
          </div>
        </Modal>

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
