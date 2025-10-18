import React, { useState, useEffect } from 'react'
import { useDateRange } from '../../contexts/DateRangeContext'
import {
  PageContainer,
  Card,
  KpiCard,
  DateRangePicker,
  LineChart,
  TreeFilter,
  TrafficSourcesChart
} from '../../components/common'
import { Eye, Users, UserCheck, Target, Smartphone, Monitor, Tablet, Globe } from 'lucide-react'
import { FaFacebook, FaGoogle, FaInstagram, FaTiktok, FaTwitter, FaLinkedin, FaMicrosoft, FaChrome, FaFirefox, FaSafari, FaEdge, FaOpera, FaApple, FaWindows, FaAndroid, FaLinux } from 'react-icons/fa'
import { SiMacos, SiIos } from 'react-icons/si'
import { getSessionsByDateRange } from '../../services/analyticsService'
import { TrackingSession } from '../../services/trackingService'
import { formatDate, formatDateToISO, parseLocalDateString } from '../../utils/format'

// Helper para obtener icono de plataforma
const getPlatformIcon = (platformName: string) => {
  const name = platformName.toLowerCase()
  if (name.includes('facebook')) return FaFacebook
  if (name.includes('google')) return FaGoogle
  if (name.includes('instagram')) return FaInstagram
  if (name.includes('tiktok')) return FaTiktok
  if (name.includes('twitter')) return FaTwitter
  if (name.includes('linkedin')) return FaLinkedin
  if (name.includes('microsoft')) return FaMicrosoft
  return Globe
}

// Helper para obtener icono de navegador
const getBrowserIcon = (browserName: string) => {
  const name = browserName.toLowerCase()
  if (name.includes('chrome')) return FaChrome
  if (name.includes('firefox')) return FaFirefox
  if (name.includes('safari')) return FaSafari
  if (name.includes('edge')) return FaEdge
  if (name.includes('opera')) return FaOpera
  return Globe
}

// Helper para obtener icono de sistema operativo
const getOSIcon = (osName: string) => {
  const name = osName.toLowerCase()
  if (name.includes('windows')) return FaWindows
  if (name.includes('mac') || name.includes('macos')) return SiMacos
  if (name.includes('ios') || name.includes('iphone') || name.includes('ipad')) return SiIos
  if (name.includes('android')) return FaAndroid
  if (name.includes('linux')) return FaLinux
  return Monitor
}

// Helper para obtener icono de dispositivo
const getDeviceIcon = (deviceName: string) => {
  const name = deviceName.toLowerCase()
  if (name.includes('mobile') || name.includes('phone')) return Smartphone
  if (name.includes('tablet')) return Tablet
  if (name.includes('desktop')) return Monitor
  return Smartphone
}

// Helper para obtener icono de ubicación (placement)
const getPlacementIcon = (placementName: string) => {
  const name = placementName.toLowerCase()
  if (name.includes('facebook')) return FaFacebook
  if (name.includes('instagram')) return FaInstagram
  if (name.includes('tiktok')) return FaTiktok
  if (name.includes('google')) return FaGoogle
  if (name.includes('twitter')) return FaTwitter
  if (name.includes('linkedin')) return FaLinkedin
  if (name.includes('microsoft')) return FaMicrosoft
  return Target
}

// Usar TrackingSession directamente
type Session = TrackingSession & {
  browser?: string
  os?: string
  placement?: string
  source_platform?: string
}

interface Metrics {
  pageViews: number
  uniqueVisitors: number
  registros: number
  conversionRate: number
  returningUsers: number
  avgPagePerSession: number
  trends: {
    pageViews: number
    uniqueVisitors: number
    registros: number
    conversionRate: number
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

  // Estado para filtros
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string[]>>({})
  const [availableFilterData, setAvailableFilterData] = useState<any>({})
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  // Estado para visualizaciones
  const [dailyTraffic, setDailyTraffic] = useState<TrafficPoint[]>([])
  const [dailyConversions, setDailyConversions] = useState<any[]>([])
  const [trafficSources, setTrafficSources] = useState<{ name: string; value: number; color: string }[]>([])
  const [platformsData, setPlatformsData] = useState<any[]>([])
  const [placementsData, setPlacementsData] = useState<any[]>([])
  const [devicesData, setDevicesData] = useState<any[]>([])
  const [osData, setOsData] = useState<any[]>([])
  const [browserData, setBrowserData] = useState<any[]>([])
  const [topVisitors, setTopVisitors] = useState<any[]>([])

  const [metrics, setMetrics] = useState<Metrics>({
    pageViews: 0,
    uniqueVisitors: 0,
    registros: 0,
    conversionRate: 0,
    returningUsers: 0,
    avgPagePerSession: 0,
    trends: {
      pageViews: 0,
      uniqueVisitors: 0,
      registros: 0,
      conversionRate: 0,
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
          // Usar 1 sesión = 1 page view (simplificado)
          const totalPageViews = currentSessions.length

          // Registros = sesiones con contact_id
          const registros = new Set(
            currentSessions.filter((s: Session) => s.contact_id).map((s: Session) => s.contact_id)
          ).size

          const conversionRate = uniqueVids > 0 ? ((registros / uniqueVids) * 100) : 0

          // Usuarios recurrentes
          const visitorCounts: { [key: string]: number } = {}
          currentSessions.forEach((s: Session) => {
            visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
          })
          const returningUsers = Object.values(visitorCounts).filter(count => count > 1).length

          const avgPagePerSession = currentSessions.length > 0 ?
            (totalPageViews / currentSessions.length) : 0

          // Calcular métricas del período anterior para trends
          const prevUniqueVids = prevSessions.length > 0 ?
            new Set(prevSessions.map((s: Session) => s.visitor_id)).size : 0
          const prevTotalPageViews = prevSessions.length
          const prevRegistros = prevSessions.length > 0 ?
            new Set(prevSessions.filter((s: Session) => s.contact_id).map((s: Session) => s.contact_id)).size : 0
          const prevConversionRate = prevUniqueVids > 0 ? ((prevRegistros / prevUniqueVids) * 100) : 0

          const prevVisitorCounts: { [key: string]: number } = {}
          prevSessions.forEach((s: Session) => {
            prevVisitorCounts[s.visitor_id] = (prevVisitorCounts[s.visitor_id] || 0) + 1
          })
          const prevReturningUsers = Object.values(prevVisitorCounts).filter(count => count > 1).length
          const prevAvgPagePerSession = prevSessions.length > 0 ?
            (prevTotalPageViews / prevSessions.length) : 0

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
            returningUsers,
            avgPagePerSession,
            trends: {
              pageViews: calculateTrend(totalPageViews, prevTotalPageViews),
              uniqueVisitors: calculateTrend(uniqueVids, prevUniqueVids),
              registros: calculateTrend(registros, prevRegistros),
              conversionRate: calculateTrend(conversionRate, prevConversionRate),
              returningUsers: calculateTrend(returningUsers, prevReturningUsers),
              avgPagePerSession: calculateTrend(avgPagePerSession, prevAvgPagePerSession)
            }
          })

          // Preparar datos para gráfico de tráfico diario (incluyendo período anterior)
          const dailyStats: { [key: string]: { totalVisits: number, uniqueVisitors: Set<string> } } = {}

          // Incluir sesiones del período anterior para contexto visual
          prevSessions.forEach((session: Session) => {
            const date = session.started_at.split('T')[0]
            if (!dailyStats[date]) {
              dailyStats[date] = {
                totalVisits: 0,
                uniqueVisitors: new Set()
              }
            }
            dailyStats[date].totalVisits++
            dailyStats[date].uniqueVisitors.add(session.visitor_id)
          })

          // Incluir sesiones del período actual
          currentSessions.forEach((session: Session) => {
            const date = session.started_at.split('T')[0]
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

          // Gráfico de conversiones (sesiones con contact_id agrupadas por día, incluyendo período anterior)
          const conversionStats: { [key: string]: Set<string> } = {}

          // Incluir conversiones del período anterior para contexto visual
          prevSessions.forEach((session: Session) => {
            if (session.contact_id) {
              const date = session.started_at.split('T')[0]
              if (!conversionStats[date]) {
                conversionStats[date] = new Set()
              }
              conversionStats[date].add(session.contact_id)
            }
          })

          // Incluir conversiones del período actual
          currentSessions.forEach((session: Session) => {
            if (session.contact_id) {
              const date = session.started_at.split('T')[0]
              if (!conversionStats[date]) {
                conversionStats[date] = new Set()
              }
              conversionStats[date].add(session.contact_id)
            }
          })

          const conversionChartData = Object.entries(conversionStats)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, contactIds]) => ({
              label: formatDate(new Date(date + 'T00:00:00'), { padDay: false }),
              value: contactIds.size
            }))

          setDailyConversions(conversionChartData)

          // Guardar todas las sesiones y sesiones filtradas
          setAllSessions(currentSessions)
          setSessions(currentSessions)

          // Recopilar datos disponibles para el TreeFilter
          const filterData: any = {
            pages: [],
            campaigns: [],
            ads: [],
            sources: [],
            devices: [],
            browsers: [],
            os: [],
            placements: []
          }

          // Páginas
          const pageMap: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            if (session.landing_url) {
              const urlPath = session.landing_url.split('?')[0]
              const pageName = urlPath.split('/').pop() || 'home'
              pageMap[pageName] = (pageMap[pageName] || 0) + 1
            }
          })

          filterData.pages = Object.entries(pageMap)
            .map(([page, count]) => ({ page, count }))
            .sort((a, b) => b.count - a.count)

          // Campañas, Ads, Sources, etc.
          const campaignsMap: { [key: string]: number } = {}
          const adsMap: { [key: string]: number } = {}
          const sourcesMap: { [key: string]: number } = {}
          const devicesMap: { [key: string]: number } = {}
          const browsersMap: { [key: string]: number } = {}
          const osMap: { [key: string]: number } = {}
          const placementsMap: { [key: string]: number } = {}

          currentSessions.forEach((session: Session) => {
            if (session.utm_campaign) {
              campaignsMap[session.utm_campaign] = (campaignsMap[session.utm_campaign] || 0) + 1
            }
            if (session.utm_content) {
              adsMap[session.utm_content] = (adsMap[session.utm_content] || 0) + 1
            }
            if (session.utm_source) {
              sourcesMap[session.utm_source] = (sourcesMap[session.utm_source] || 0) + 1
            }
            if (session.device_type) {
              devicesMap[session.device_type] = (devicesMap[session.device_type] || 0) + 1
            }
            if (session.browser) {
              browsersMap[session.browser] = (browsersMap[session.browser] || 0) + 1
            }
            if (session.os) {
              osMap[session.os] = (osMap[session.os] || 0) + 1
            }
            if (session.placement) {
              placementsMap[session.placement] = (placementsMap[session.placement] || 0) + 1
            }
          })

          filterData.campaigns = Object.entries(campaignsMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.ads = Object.entries(adsMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.sources = Object.entries(sourcesMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.devices = Object.entries(devicesMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.browsers = Object.entries(browsersMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.os = Object.entries(osMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          filterData.placements = Object.entries(placementsMap)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)

          setAvailableFilterData(filterData)

          // Calcular stats para las cards
          const browsers: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const browser = session.browser || 'Desconocido'
            browsers[browser] = (browsers[browser] || 0) + 1
          })
          const browserStats = Object.entries(browsers)
            .map(([browser, count]) => ({
              name: browser,
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setBrowserData(browserStats)

          const platforms: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const platform = session.source_platform || session.utm_source || 'Directo'
            platforms[platform] = (platforms[platform] || 0) + 1
          })
          const platformStats = Object.entries(platforms)
            .map(([platform, count]) => ({
              name: platform,
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlatformsData(platformStats)

          // Preparar datos para la dona de fuentes de tráfico
          const colorMap: { [key: string]: string } = {
            'facebook': '#1877f2',
            'google': '#4285f4',
            'instagram': '#c32aa3',
            'tiktok': '#ee1d52',
            'microsoft': '#00a4ef',
            'twitter': '#1da1f2',
            'linkedin': '#0a66c2',
            'directo': '#6b7280'
          }
          const trafficSourcesData = Object.entries(platforms)
            .map(([platform, count]) => ({
              name: platform.charAt(0).toUpperCase() + platform.slice(1),
              value: count,
              color: colorMap[platform.toLowerCase()] || '#6b7280'
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10)
          setTrafficSources(trafficSourcesData)

          const placements: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const placement = session.placement || 'Sin ubicación'
            placements[placement] = (placements[placement] || 0) + 1
          })
          const placementStats = Object.entries(placements)
            .map(([placement, count]) => ({
              name: placement.replace(/_/g, ' '),
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlacementsData(placementStats)

          const devices: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const device = session.device_type || 'Desconocido'
            devices[device] = (devices[device] || 0) + 1
          })
          const deviceStats = Object.entries(devices)
            .map(([device, count]) => ({
              name: device,
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setDevicesData(deviceStats)

          const operatingSystems: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const os = session.os || 'Desconocido'
            operatingSystems[os] = (operatingSystems[os] || 0) + 1
          })
          const osStats = Object.entries(operatingSystems)
            .map(([os, count]) => ({
              name: os,
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setOsData(osStats)

          const topVisitorsList = Object.entries(visitorCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([visitorId, count]) => ({
              id: visitorId.substring(0, 24) + '...',
              requests: count
            }))
          setTopVisitors(topVisitorsList)
        } else {
          // Reset si no hay datos
          setMetrics({
            pageViews: 0,
            uniqueVisitors: 0,
            registros: 0,
            conversionRate: 0,
            returningUsers: 0,
            avgPagePerSession: 0,
            trends: {
              pageViews: 0,
              uniqueVisitors: 0,
              registros: 0,
              conversionRate: 0,
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

  // Efecto para filtrar sesiones cuando cambian los filtros seleccionados
  useEffect(() => {
    if (Object.keys(selectedFilters).length === 0) {
      setSessions(allSessions)
    } else {
      const filtered = allSessions.filter((session: Session) => {
        for (const [field, values] of Object.entries(selectedFilters)) {
          if (values.length === 0) continue

          let fieldMatch = false

          for (const value of values) {
            switch (field) {
              case 'landing_url':
                if (session.landing_url) {
                  const urlPath = session.landing_url.split('?')[0]
                  const pageName = urlPath.split('/').pop() || 'home'
                  if (pageName === value) fieldMatch = true
                }
                break
              case 'utm_campaign':
                if (session.utm_campaign === value) fieldMatch = true
                break
              case 'utm_content':
                if (session.utm_content === value) fieldMatch = true
                break
              case 'utm_source':
                if (session.utm_source === value) fieldMatch = true
                break
              case 'device_type':
                if (session.device_type === value) fieldMatch = true
                break
              case 'browser':
                if (session.browser === value) fieldMatch = true
                break
              case 'os':
                if (session.os === value) fieldMatch = true
                break
              case 'placement':
                if (session.placement === value) fieldMatch = true
                break
            }
          }

          if (!fieldMatch) return false
        }

        return true
      })

      setSessions(filtered)
    }
  }, [selectedFilters, allSessions])

  // Preparar métricas para KPICards
  const getTrend = (value: number): 'up' | 'down' | undefined => {
    return value > 0 ? 'up' : value < 0 ? 'down' : undefined
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

  return (
    <PageContainer>
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">Analíticas</h1>

          {/* Selector de fechas y Filtro en árbol juntos */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
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
            <TreeFilter
              availableData={availableFilterData}
              selectedFilters={selectedFilters}
              onFilterChange={setSelectedFilters}
            />
          </div>
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

        {/* Gráfica de Registros y Fuentes de Tráfico */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">Registros</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Contactos identificados por día
              </p>
            </div>

            <div className="h-[300px]">
              {loading ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-500">
                  Cargando datos...
                </div>
              ) : dailyConversions.length > 0 ? (
                <LineChart
                  data={dailyConversions}
                  height={300}
                  showGrid
                  color="#10b981"
                  showLegend={false}
                  formatValue={formatTrafficAxis}
                  formatTooltipValue={formatTrafficTooltip}
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                  Sin datos de conversiones disponibles
                </div>
              )}
            </div>
          </Card>

          <TrafficSourcesChart
            data={trafficSources}
            loading={loading}
          />
        </div>

        {/* Grid de stats cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Plataformas */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Plataformas</h3>
            </div>
            <div className="p-5 space-y-4">
              {platformsData.map((platform, index) => {
                const PlatformIcon = getPlatformIcon(platform.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlatformIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{platform.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{platform.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${platform.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Ubicaciones */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Ubicaciones</h3>
            </div>
            <div className="p-5 space-y-4">
              {placementsData.map((placement, index) => {
                const PlacementIcon = getPlacementIcon(placement.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlacementIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{placement.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{placement.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${placement.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Dispositivos */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Dispositivos</h3>
            </div>
            <div className="p-5 space-y-4">
              {devicesData.map((device, index) => {
                const DeviceIcon = getDeviceIcon(device.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <DeviceIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{device.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{device.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${device.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Sistemas */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Sistemas</h3>
            </div>
            <div className="p-5 space-y-4">
              {osData.map((os, index) => {
                const OSIcon = getOSIcon(os.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <OSIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{os.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{os.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${os.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Navegadores */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Navegadores</h3>
            </div>
            <div className="p-5 space-y-4">
              {browserData.map((browser, index) => {
                const BrowserIcon = getBrowserIcon(browser.name)
                return (
                  <div key={index} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BrowserIcon className="w-4 h-4 text-gray-500" />
                        <span className="text-sm">{browser.name}</span>
                      </div>
                      <span className="text-sm font-semibold">{browser.users}</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-500 dark:bg-gray-400 opacity-60 transition-all duration-500"
                        style={{ width: `${browser.percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Top Visitors */}
          <Card>
            <div className="p-4 border-b border-[var(--color-border)]">
              <h3 className="text-sm font-semibold">Top Visitantes</h3>
            </div>
            <div className="p-5">
              <div className="space-y-3">
                {topVisitors.map((visitor, index) => (
                  <div key={index} className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-gray-400 font-mono">{visitor.id}</span>
                    <span className="text-sm font-semibold">{visitor.requests} requests</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </PageContainer>
  )
}

export default Analytics
