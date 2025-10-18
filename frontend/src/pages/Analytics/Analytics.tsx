import React, { useState, useEffect } from 'react'
import { useDateRange } from '../../contexts/DateRangeContext'
import {
  PageContainer,
  Card,
  KpiCard,
  DateRangePicker,
  LineChart
} from '../../components/common'
import { Eye, Users, UserCheck, Target, Activity, Clock, RefreshCw, FileText } from 'lucide-react'
import { getSessionsByDateRange } from '../../services/analyticsService'
import { formatDate, formatDateToISO, parseLocalDateString } from '../../utils/format'

interface Session {
  session_id: string
  visitor_id: string
  contact_id?: string
  created_at: string
  landing_url?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  referrer_url?: string
  browser?: string
  device_type?: string
  os?: string
  placement?: string
  source_platform?: string
  pageviews_count: number
  events_count: number
  is_bounce: number
}

interface Metrics {
  pageViews: number
  uniqueVisitors: number
  registros: number
  conversionRate: number
  avgSessionDuration: number
  bounceRate: number
  returningUsers: number
  avgPagePerSession: number
  trends: {
    pageViews: number
    uniqueVisitors: number
    registros: number
    conversionRate: number
    avgSessionDuration: number
    bounceRate: number
    returningUsers: number
    avgPagePerSession: number
  }
}

type TrafficPoint = {
  label: string
  value: number
  value2: number
}

const Analytics: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const [loading, setLoading] = useState(false)
  const [dailyTraffic, setDailyTraffic] = useState<TrafficPoint[]>([])
  const [metrics, setMetrics] = useState<Metrics>({
    pageViews: 0,
    uniqueVisitors: 0,
    registros: 0,
    conversionRate: 0,
    avgSessionDuration: 0,
    bounceRate: 0,
    returningUsers: 0,
    avgPagePerSession: 0,
    trends: {
      pageViews: 0,
      uniqueVisitors: 0,
      registros: 0,
      conversionRate: 0,
      avgSessionDuration: 0,
      bounceRate: 0,
      returningUsers: 0,
      avgPagePerSession: 0
    }
  })

  const formatTrafficAxis = (value: number) => {
    if (value >= 1000) {
      const formatted = value / 1000
      return `${formatted % 1 === 0 ? formatted.toFixed(0) : formatted.toFixed(1)}k`
    }
    return value.toString()
  }

  const formatTrafficTooltipValue = (value: number) => value.toLocaleString('es-MX')

  const formatTrafficTooltip = (value: number, _key: string) => formatTrafficTooltipValue(value)

  // Cargar datos cuando cambie el rango de fechas
  useEffect(() => {
    const fetchAnalytics = async () => {
      setLoading(true)
      try {
        const adjustedEndDate = new Date(dateRange.end)
        adjustedEndDate.setDate(adjustedEndDate.getDate() + 1)

        const startDate = dateRange.start.toISOString().split('T')[0]
        const endDate = adjustedEndDate.toISOString().split('T')[0]

        // Calcular período anterior para comparación
        const msPerDay = 24 * 60 * 60 * 1000
        const periodLength = Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / msPerDay)
        const previousEnd = new Date(dateRange.start)
        previousEnd.setDate(previousEnd.getDate() - 1)
        const previousStart = new Date(previousEnd)
        previousStart.setDate(previousStart.getDate() - periodLength)

        const prevStartDate = previousStart.toISOString().split('T')[0]
        const prevEndDate = previousEnd.toISOString().split('T')[0]

        // Fetch datos del período actual y anterior
        const [currentSessions, prevSessions] = await Promise.all([
          getSessionsByDateRange(startDate, endDate),
          getSessionsByDateRange(prevStartDate, prevEndDate)
        ])

        if (currentSessions.length > 0) {
          // Calcular métricas principales
          const uniqueVids = new Set(currentSessions.map((s: Session) => s.visitor_id)).size
          const totalPageViews = currentSessions.reduce((acc: number, s: Session) =>
            acc + (s.pageviews_count || 1), 0
          )

          // Registros = sesiones con contact_id
          const registros = new Set(
            currentSessions.filter((s: Session) => s.contact_id).map((s: Session) => s.contact_id)
          ).size

          const conversionRate = uniqueVids > 0 ? ((registros / uniqueVids) * 100) : 0
          const bounceRate = currentSessions.length > 0 ?
            ((currentSessions.filter((s: Session) => s.is_bounce === 1).length / currentSessions.length) * 100) : 0

          // Usuarios recurrentes
          const visitorCounts: { [key: string]: number } = {}
          currentSessions.forEach((s: Session) => {
            visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
          })
          const returningUsers = Object.values(visitorCounts).filter(count => count > 1).length

          const avgPagePerSession = currentSessions.length > 0 ?
            (totalPageViews / currentSessions.length) : 0

          // Duración promedio estimada
          const avgDuration = currentSessions.length > 0 ?
            Math.round(currentSessions.reduce((acc: number, s: Session) =>
              acc + (s.events_count || 1) * 45, 0) / currentSessions.length) : 0

          // Calcular métricas del período anterior para trends
          const prevUniqueVids = prevSessions.length > 0 ?
            new Set(prevSessions.map((s: Session) => s.visitor_id)).size : 0
          const prevTotalPageViews = prevSessions.length > 0 ?
            prevSessions.reduce((acc: number, s: Session) => acc + (s.pageviews_count || 1), 0) : 0
          const prevRegistros = prevSessions.length > 0 ?
            new Set(prevSessions.filter((s: Session) => s.contact_id).map((s: Session) => s.contact_id)).size : 0
          const prevConversionRate = prevUniqueVids > 0 ? ((prevRegistros / prevUniqueVids) * 100) : 0
          const prevBounceRate = prevSessions.length > 0 ?
            ((prevSessions.filter((s: Session) => s.is_bounce === 1).length / prevSessions.length) * 100) : 0

          const prevVisitorCounts: { [key: string]: number } = {}
          prevSessions.forEach((s: Session) => {
            prevVisitorCounts[s.visitor_id] = (prevVisitorCounts[s.visitor_id] || 0) + 1
          })
          const prevReturningUsers = Object.values(prevVisitorCounts).filter(count => count > 1).length
          const prevAvgPagePerSession = prevSessions.length > 0 ?
            (prevTotalPageViews / prevSessions.length) : 0
          const prevAvgDuration = prevSessions.length > 0 ?
            Math.round(prevSessions.reduce((acc: number, s: Session) =>
              acc + (s.events_count || 1) * 45, 0) / prevSessions.length) : 0

          // Calcular trends
          const calculateTrend = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0
            return ((current - previous) / Math.abs(previous)) * 100
          }

          setMetrics({
            pageViews: totalPageViews,
            uniqueVisitors: uniqueVids,
            registros,
            conversionRate,
            avgSessionDuration: avgDuration,
            bounceRate,
            returningUsers,
            avgPagePerSession,
            trends: {
              pageViews: calculateTrend(totalPageViews, prevTotalPageViews),
              uniqueVisitors: calculateTrend(uniqueVids, prevUniqueVids),
              registros: calculateTrend(registros, prevRegistros),
              conversionRate: calculateTrend(conversionRate, prevConversionRate),
              avgSessionDuration: calculateTrend(avgDuration, prevAvgDuration),
              bounceRate: calculateTrend(bounceRate, prevBounceRate),
              returningUsers: calculateTrend(returningUsers, prevReturningUsers),
              avgPagePerSession: calculateTrend(avgPagePerSession, prevAvgPagePerSession)
            }
          })

          // Preparar datos para gráfico de tráfico diario
          const dailyStats: { [key: string]: { totalVisits: number, uniqueVisitors: Set<string> } } = {}

          currentSessions.forEach((session: Session) => {
            const date = session.created_at.split('T')[0]
            if (!dailyStats[date]) {
              dailyStats[date] = {
                totalVisits: 0,
                uniqueVisitors: new Set()
              }
            }
            dailyStats[date].totalVisits++
            dailyStats[date].uniqueVisitors.add(session.visitor_id)
          })

          const chartData = Object.entries(dailyStats)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, stats]) => ({
              label: formatDate(new Date(date + 'T00:00:00'), { padDay: false }),
              value: stats.totalVisits,
              value2: stats.uniqueVisitors.size
            }))

          setDailyTraffic(chartData)
        } else {
          // Reset si no hay datos
          setMetrics({
            pageViews: 0,
            uniqueVisitors: 0,
            registros: 0,
            conversionRate: 0,
            avgSessionDuration: 0,
            bounceRate: 0,
            returningUsers: 0,
            avgPagePerSession: 0,
            trends: {
              pageViews: 0,
              uniqueVisitors: 0,
              registros: 0,
              conversionRate: 0,
              avgSessionDuration: 0,
              bounceRate: 0,
              returningUsers: 0,
              avgPagePerSession: 0
            }
          })
          setDailyTraffic([])
        }
      } catch (error) {
        console.error('Error cargando analytics:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchAnalytics()
  }, [dateRange])

  // Preparar métricas para KPICards
  const getTrend = (value: number): 'up' | 'down' | undefined => {
    return value > 0 ? 'up' : value < 0 ? 'down' : undefined
  }

  const getTrendInverted = (value: number): 'up' | 'down' | undefined => {
    return value < 0 ? 'up' : value > 0 ? 'down' : undefined
  }

  const mainMetrics = [
    {
      label: 'Visualizaciones',
      value: metrics.pageViews > 1000 ? `${(metrics.pageViews / 1000).toFixed(1)}K` : metrics.pageViews.toString(),
      change: metrics.trends.pageViews,
      trend: getTrend(metrics.trends.pageViews),
      icon: Eye
    },
    {
      label: 'Visitantes Únicos',
      value: metrics.uniqueVisitors.toString(),
      change: metrics.trends.uniqueVisitors,
      trend: getTrend(metrics.trends.uniqueVisitors),
      icon: Users
    },
    {
      label: 'Registros',
      value: metrics.registros.toString(),
      change: metrics.trends.registros,
      trend: getTrend(metrics.trends.registros),
      icon: UserCheck
    },
    {
      label: 'Conversión',
      value: `${metrics.conversionRate.toFixed(1)}%`,
      change: metrics.trends.conversionRate,
      trend: getTrend(metrics.trends.conversionRate),
      icon: Target
    }
  ]

  const secondaryMetrics = [
    {
      label: 'Tasa de Rebote',
      value: `${metrics.bounceRate.toFixed(1)}%`,
      change: metrics.trends.bounceRate,
      trend: getTrendInverted(metrics.trends.bounceRate),
      icon: Activity
    },
    {
      label: 'Duración Promedio',
      value: `${Math.floor(metrics.avgSessionDuration / 60)}:${(metrics.avgSessionDuration % 60).toString().padStart(2, '0')}`,
      change: metrics.trends.avgSessionDuration,
      trend: getTrend(metrics.trends.avgSessionDuration),
      icon: Clock
    },
    {
      label: 'Usuarios Recurrentes',
      value: metrics.returningUsers.toString(),
      change: metrics.trends.returningUsers,
      trend: getTrend(metrics.trends.returningUsers),
      icon: RefreshCw
    },
    {
      label: 'Páginas/Sesión',
      value: metrics.avgPagePerSession.toFixed(1),
      change: metrics.trends.avgPagePerSession,
      trend: getTrend(metrics.trends.avgPagePerSession),
      icon: FileText
    }
  ]

  return (
    <PageContainer>
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">Analíticas</h1>
          <DateRangePicker
            startDate={formatDateToISO(dateRange.start)}
            endDate={formatDateToISO(dateRange.end)}
            onChange={(start, end) =>
              setDateRange({
                start: parseLocalDateString(start),
                end: parseLocalDateString(end),
                preset: 'custom'
              })
            }
          />
        </div>

        {/* Métricas principales */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {mainMetrics.map((metric) => (
            <KpiCard
              key={metric.label}
              title={metric.label}
              value={metric.value}
              change={metric.change}
              trend={metric.trend}
              icon={metric.icon}
              className={loading ? 'animate-pulse' : ''}
            />
          ))}
        </div>

        {/* Métricas secundarias */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {secondaryMetrics.map((metric) => (
            <KpiCard
              key={metric.label}
              title={metric.label}
              value={metric.value}
              change={metric.change}
              trend={metric.trend}
              icon={metric.icon}
              className={loading ? 'animate-pulse' : ''}
            />
          ))}
        </div>

        {/* Gráfico de tráfico */}
        <Card className="p-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold">Tráfico del Sitio</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Visualizaciones de página y visitantes únicos
            </p>
          </div>

          <div className="h-[300px]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                Cargando datos...
              </div>
            ) : dailyTraffic.length > 0 ? (
              <LineChart
                data={dailyTraffic}
                height={300}
                showGrid
                color="#8b5cf6"
                color2="#3b82f6"
                showLegend
                legendLabels={{ label1: 'Visitas Totales', label2: 'Visitantes Únicos' }}
                formatValue={formatTrafficAxis}
                formatTooltipValue={formatTrafficTooltip}
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                Sin datos de tráfico disponibles
              </div>
            )}
          </div>
        </Card>
      </div>
    </PageContainer>
  )
}

export default Analytics
