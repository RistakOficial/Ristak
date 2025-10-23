import React, { useState, useEffect, useCallback } from 'react'
import { useDateRange } from '../../contexts/DateRangeContext'
import { useTimezone } from '../../contexts/TimezoneContext'
import {
  PageContainer,
  Card,
  KpiCard,
  DateRangePicker,
  LineChart,
  TreeFilter,
  TrafficSourcesChart,
  SessionsTable
} from '../../components/common'
import { Eye, Users, UserCheck, Target, Smartphone, Monitor, Tablet, Globe } from 'lucide-react'
import { FaFacebook, FaGoogle, FaInstagram, FaTiktok, FaTwitter, FaLinkedin, FaMicrosoft, FaChrome, FaFirefox, FaSafari, FaEdge, FaOpera, FaApple, FaWindows, FaAndroid, FaLinux } from 'react-icons/fa'
import { SiMacos, SiIos } from 'react-icons/si'
import { getSessionsByDateRange, getContactsByDate } from '../../services/analyticsService'
import { TrackingSession } from '../../services/trackingService'
import { formatDate, formatDateToISO, parseLocalDateString, formatUrlParameter, formatChartNumber } from '../../utils/format'
import { normalizeTrafficSource } from '../../utils/trafficSourceNormalizer'

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

// Helper para formatear placement de manera legible (Facebook Feed, Instagram Reels, etc.)
const formatPlacementName = (placement: string): string => {
  if (!placement || placement === 'Sin ubicación') return 'Sin ubicación'

  const cleaned = placement.toLowerCase().trim()

  // Mapeo de formatos conocidos a nombres legibles
  if (cleaned.includes('facebook') && cleaned.includes('feed')) return 'Facebook Feed'
  if (cleaned.includes('facebook') && cleaned.includes('reel')) return 'Facebook Reels'
  if (cleaned.includes('facebook') && cleaned.includes('story')) return 'Facebook Stories'
  if (cleaned.includes('facebook') && cleaned.includes('right_column')) return 'Facebook Columna Derecha'
  if (cleaned.includes('facebook') && cleaned.includes('video')) return 'Facebook Video'
  if (cleaned.includes('facebook') && cleaned.includes('marketplace')) return 'Facebook Marketplace'
  if (cleaned.includes('facebook') && cleaned.includes('search')) return 'Facebook Búsqueda'

  if (cleaned.includes('instagram') && cleaned.includes('feed')) return 'Instagram Feed'
  if (cleaned.includes('instagram') && cleaned.includes('reel')) return 'Instagram Reels'
  if (cleaned.includes('instagram') && cleaned.includes('story')) return 'Instagram Stories'
  if (cleaned.includes('instagram') && cleaned.includes('explore')) return 'Instagram Explorar'
  if (cleaned.includes('instagram') && cleaned.includes('profile')) return 'Instagram Perfil'
  if (cleaned.includes('instagram') && cleaned.includes('search')) return 'Instagram Búsqueda'

  if (cleaned.includes('messenger')) return 'Messenger'
  if (cleaned.includes('audience_network')) return 'Audience Network'
  if (cleaned.includes('instant_article')) return 'Artículo Instantáneo'
  if (cleaned.includes('instream')) return 'In-Stream Video'

  // Para placements solo con "fb" o "ig"
  if (cleaned === 'fb') return 'Facebook'
  if (cleaned === 'ig') return 'Instagram'

  // Si no hay match, limpiar y capitalizar
  return placement.replace(/_/g, ' ').split(' ').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Usar TrackingSession directamente (ya incluye todos los campos necesarios)
type Session = TrackingSession

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
  const { formatLocalDateShort } = useTimezone()
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

  // Memoizar funciones de formato para evitar re-renders infinitos
  const formatTrafficAxis = useCallback((value: number) => formatChartNumber(value), [])

  const formatTrafficTooltipValue = useCallback((value: number) => value.toLocaleString('es-MX'), [])

  const formatTrafficTooltip = useCallback((value: number, _key: string) => formatTrafficTooltipValue(value), [formatTrafficTooltipValue])

  // Cargar datos cuando cambie el rango de fechas
  useEffect(() => {
    const fetchAnalytics = async () => {
      setLoading(true)
      try {
        // No agregar +1 día aquí, el backend ya lo maneja con INTERVAL '1 day'
        const startDate = dateRange.start.toISOString().split('T')[0]
        const endDate = dateRange.end.toISOString().split('T')[0]

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
        const [currentSessions, prevSessions, contactsData, prevContactsData] = await Promise.all([
          getSessionsByDateRange(startDate, endDate),
          getSessionsByDateRange(prevStartDate, prevEndDate),
          getContactsByDate(startDate, endDate),
          getContactsByDate(prevStartDate, prevEndDate)
        ])

        if (currentSessions.length > 0) {
          // Calcular métricas principales
          const uniqueVids = new Set(currentSessions.map((s: Session) => s.visitor_id)).size

          // CADA registro es un page_view ahora (cada navegación)
          const totalPageViews = currentSessions.length

          // Contar sesiones únicas (por session_id)
          const uniqueSessionIds = new Set(currentSessions.map((s: Session) => s.session_id)).size

          // Registros = contactos con visitor_id creados en el período (con fallback a array vacío)
          const registros = (contactsData || []).reduce((sum, item) => sum + item.count, 0)

          const conversionRate = uniqueVids > 0 ? ((registros / uniqueVids) * 100) : 0

          // Usuarios recurrentes: contar visitor_ids que tienen múltiples session_ids diferentes
          const visitorSessionMap: { [key: string]: Set<string> } = {}
          currentSessions.forEach((s: Session) => {
            if (!visitorSessionMap[s.visitor_id]) {
              visitorSessionMap[s.visitor_id] = new Set()
            }
            visitorSessionMap[s.visitor_id].add(s.session_id)
          })
          const returningUsers = Object.values(visitorSessionMap).filter(sessions => sessions.size > 1).length

          // Páginas por sesión = total de page_views / número de sesiones únicas
          const avgPagePerSession = uniqueSessionIds > 0 ?
            (totalPageViews / uniqueSessionIds) : 0

          // Calcular métricas del período anterior para trends
          const prevUniqueVids = prevSessions.length > 0 ?
            new Set(prevSessions.map((s: Session) => s.visitor_id)).size : 0
          const prevTotalPageViews = prevSessions.length
          const prevUniqueSessionIds = prevSessions.length > 0 ?
            new Set(prevSessions.map((s: Session) => s.session_id)).size : 0
          const prevRegistros = (prevContactsData || []).reduce((sum, item) => sum + item.count, 0)
          const prevConversionRate = prevUniqueVids > 0 ? ((prevRegistros / prevUniqueVids) * 100) : 0

          // Usuarios recurrentes del período anterior
          const prevVisitorSessionMap: { [key: string]: Set<string> } = {}
          prevSessions.forEach((s: Session) => {
            if (!prevVisitorSessionMap[s.visitor_id]) {
              prevVisitorSessionMap[s.visitor_id] = new Set()
            }
            prevVisitorSessionMap[s.visitor_id].add(s.session_id)
          })
          const prevReturningUsers = Object.values(prevVisitorSessionMap).filter(sessions => sessions.size > 1).length
          const prevAvgPagePerSession = prevUniqueSessionIds > 0 ?
            (prevTotalPageViews / prevUniqueSessionIds) : 0

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
              label: formatLocalDateShort(date),
              value: stats.totalVisits,
              value2: stats.uniqueVisitors.size
            }))

          setDailyTraffic(chartData)

          // Gráfico de conversiones (registros reales de contactos por fecha de creación)
          // Combinar período actual y anterior para contexto visual
          const allContactsData = [...(prevContactsData || []), ...(contactsData || [])]

          const conversionChartData = allContactsData
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(item => ({
              label: formatLocalDateShort(item.date),
              value: item.count
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
            if (session.page_url) {
              const urlPath = session.page_url.split('?')[0]
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
            // Normalizar fuente con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const normalized = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (normalized && normalized !== 'Desconocido' && normalized !== 'Otro') {
              sourcesMap[normalized] = (sourcesMap[normalized] || 0) + 1
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
              const formatted = formatPlacementName(session.placement)
              placementsMap[formatted] = (placementsMap[formatted] || 0) + 1
            }
          })

          filterData.campaigns = Object.entries(campaignsMap)
            .map(([name, count]) => ({ name: formatUrlParameter(name), count }))
            .sort((a, b) => b.count - a.count)

          filterData.ads = Object.entries(adsMap)
            .map(([name, count]) => ({ name: formatUrlParameter(name), count }))
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
            // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const platform = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
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

          // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.)
          const placements: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const rawPlacement = session.placement || 'Sin ubicación'
            const placement = formatPlacementName(rawPlacement)
            placements[placement] = (placements[placement] || 0) + 1
          })
          const placementStats = Object.entries(placements)
            .map(([placement, count]) => ({
              name: placement,
              users: count,
              percentage: ((count / currentSessions.length) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlacementsData(placementStats)

          // Preparar datos para la dona de fuentes de tráfico con prioridad: referrer_url → site_source_name → utm_source → source_platform
          const trafficSources: { [key: string]: number } = {}
          currentSessions.forEach((session: Session) => {
            const source = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            trafficSources[source] = (trafficSources[source] || 0) + 1
          })

          const trafficColorMap: { [key: string]: string } = {
            'Facebook': '#1877f2',
            'Google': '#4285f4',
            'Instagram': '#c32aa3',
            'TikTok': '#ee1d52',
            'Microsoft': '#00a4ef',
            'Twitter': '#1da1f2',
            'LinkedIn': '#0a66c2',
            'YouTube': '#ff0000',
            'Messenger': '#0084ff',
            'WhatsApp': '#25d366',
            'Snapchat': '#fffc00',
            'Pinterest': '#e60023',
            'Reddit': '#ff4500',
            'Email': '#ea4335',
            'Directo': '#6b7280',
            'Orgánico': '#10b981'
          }

          const trafficSourcesData = Object.entries(trafficSources)
            .map(([source, count]) => ({
              name: source,
              value: count,
              color: trafficColorMap[source] || '#6b7280'
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10)
          setTrafficSources(trafficSourcesData)

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

          // Calcular top visitors (visitantes con más requests)
          const visitorCounts: { [key: string]: number } = {}
          currentSessions.forEach((s: Session) => {
            visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
          })
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
              case 'page_url':
                if (session.page_url) {
                  const urlPath = session.page_url.split('?')[0]
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
                // Normalizar fuente con todas las prioridades para match correcto
                const normalizedSource = normalizeTrafficSource({
                  referrer_url: session.referrer_url,
                  site_source_name: session.site_source_name,
                  utm_source: session.utm_source,
                  source_platform: session.source_platform
                })
                if (normalizedSource === value) fieldMatch = true
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
                if (formatPlacementName(session.placement || '') === value) fieldMatch = true
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

  // Efecto para recalcular visualizaciones cuando cambien las sesiones filtradas
  useEffect(() => {
    if (sessions.length === 0) {
      // Si no hay sesiones filtradas, resetear todo a 0
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
      return
    }

    // Recalcular KPIs principales con las sesiones filtradas
    const uniqueVids = new Set(sessions.map((s: Session) => s.visitor_id)).size
    const totalPageViews = sessions.length

    // Registros = sesiones con contact_id
    const registros = new Set(
      sessions
        .filter((s: Session) => {
          if (!s.contact_id || !s.contact_created_at) return false
          return new Date(s.started_at) >= new Date(s.contact_created_at)
        })
        .map((s: Session) => s.contact_id)
    ).size

    const conversionRate = uniqueVids > 0 ? ((registros / uniqueVids) * 100) : 0

    // Usuarios recurrentes
    const visitorCountsForMetrics: { [key: string]: number } = {}
    sessions.forEach((s: Session) => {
      visitorCountsForMetrics[s.visitor_id] = (visitorCountsForMetrics[s.visitor_id] || 0) + 1
    })
    const returningUsers = Object.values(visitorCountsForMetrics).filter(count => count > 1).length

    const avgPagePerSession = sessions.length > 0 ?
      (totalPageViews / sessions.length) : 0

    // Actualizar métricas (sin trends, ya que los filtros no tienen período anterior)
    setMetrics(prev => ({
      pageViews: totalPageViews,
      uniqueVisitors: uniqueVids,
      registros,
      conversionRate,
      returningUsers,
      avgPagePerSession,
      trends: prev.trends // Mantener trends del período original
    }))

    // Recalcular stats para las cards
    const browsers: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      const browser = session.browser || 'Desconocido'
      browsers[browser] = (browsers[browser] || 0) + 1
    })
    const browserStats = Object.entries(browsers)
      .map(([browser, count]) => ({
        name: browser,
        users: count,
        percentage: ((count / sessions.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setBrowserData(browserStats)

    const platforms: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
      const platform = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })

      platforms[platform] = (platforms[platform] || 0) + 1
    })
    const platformStats = Object.entries(platforms)
      .map(([platform, count]) => ({
        name: platform,
        users: count,
        percentage: ((count / sessions.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlatformsData(platformStats)

    // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.)
    const placements: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      const rawPlacement = session.placement || 'Sin ubicación'
      const placement = formatPlacementName(rawPlacement)
      placements[placement] = (placements[placement] || 0) + 1
    })
    const placementStats = Object.entries(placements)
      .map(([placement, count]) => ({
        name: placement,
        users: count,
        percentage: ((count / sessions.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlacementsData(placementStats)

    // Preparar datos para la dona de fuentes de tráfico con prioridad: referrer_url → site_source_name → utm_source → source_platform
    const trafficSources: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      const source = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })
      trafficSources[source] = (trafficSources[source] || 0) + 1
    })

    const trafficColorMap: { [key: string]: string } = {
      'Facebook': '#1877f2',
      'Google': '#4285f4',
      'Instagram': '#c32aa3',
      'TikTok': '#ee1d52',
      'Microsoft': '#00a4ef',
      'Twitter': '#1da1f2',
      'LinkedIn': '#0a66c2',
      'YouTube': '#ff0000',
      'Messenger': '#0084ff',
      'WhatsApp': '#25d366',
      'Snapchat': '#fffc00',
      'Pinterest': '#e60023',
      'Reddit': '#ff4500',
      'Email': '#ea4335',
      'Directo': '#6b7280',
      'Orgánico': '#10b981'
    }

    const trafficSourcesData = Object.entries(trafficSources)
      .map(([source, count]) => ({
        name: source,
        value: count,
        color: trafficColorMap[source] || '#6b7280'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
    setTrafficSources(trafficSourcesData)

    const devices: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      const device = session.device_type || 'Desconocido'
      devices[device] = (devices[device] || 0) + 1
    })
    const deviceStats = Object.entries(devices)
      .map(([device, count]) => ({
        name: device,
        users: count,
        percentage: ((count / sessions.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setDevicesData(deviceStats)

    const operatingSystems: { [key: string]: number } = {}
    sessions.forEach((session: Session) => {
      const os = session.os || 'Desconocido'
      operatingSystems[os] = (operatingSystems[os] || 0) + 1
    })
    const osStats = Object.entries(operatingSystems)
      .map(([os, count]) => ({
        name: os,
        users: count,
        percentage: ((count / sessions.length) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setOsData(osStats)

    const visitorCounts: { [key: string]: number } = {}
    sessions.forEach((s: Session) => {
      visitorCounts[s.visitor_id] = (visitorCounts[s.visitor_id] || 0) + 1
    })
    const topVisitorsList = Object.entries(visitorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([visitorId, count]) => ({
        id: visitorId.substring(0, 24) + '...',
        requests: count
      }))
    setTopVisitors(topVisitorsList)
  }, [sessions])

  // Preparar métricas para KPICards
  const getTrend = (value: number): 'up' | 'down' | undefined => {
    return value > 0 ? 'up' : value < 0 ? 'down' : undefined
  }

  const mainMetrics = [
    {
      label: 'Visualizaciones',
      value: metrics.pageViews > 1000 ? `${(metrics.pageViews / 1000).toFixed(1)}K` : String(metrics.pageViews || 0),
      change: metrics.trends?.pageViews || 0,
      trend: getTrend(metrics.trends?.pageViews || 0),
      icon: Eye
    },
    {
      label: 'Visitantes Únicos',
      value: String(metrics.uniqueVisitors || 0),
      change: metrics.trends?.uniqueVisitors || 0,
      trend: getTrend(metrics.trends?.uniqueVisitors || 0),
      icon: Users
    },
    {
      label: 'Registros',
      value: String(metrics.registros || 0),
      change: metrics.trends?.registros || 0,
      trend: getTrend(metrics.trends?.registros || 0),
      icon: UserCheck
    },
    {
      label: 'Conversión',
      value: `${(metrics.conversionRate || 0).toFixed(1)}%`,
      change: metrics.trends?.conversionRate || 0,
      trend: getTrend(metrics.trends?.conversionRate || 0),
      icon: Target
    }
  ]

  return (
    <PageContainer>
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <h1 className="text-2xl font-bold">Analíticas</h1>

          {/* Filtro en árbol y Selector de fechas juntos */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
            <TreeFilter
              availableData={availableFilterData}
              selectedFilters={selectedFilters}
              onFilterChange={setSelectedFilters}
            />
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
        <Card variant="glass" className="p-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold">Tráfico del Sitio</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Visualizaciones de página y visitantes únicos
            </p>
          </div>

          <div className="h-[280px]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                Cargando datos...
              </div>
            ) : dailyTraffic.length > 0 ? (
              <LineChart
                data={dailyTraffic}
                height={280}
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
          <Card variant="glass" className="p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">Registros</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Contactos identificados por día
              </p>
            </div>

            <div style={{ height: '240px', width: '100%' }}>
              {loading ? (
                <div className="flex h-full items-center justify-center text-sm text-gray-500">
                  Cargando datos...
                </div>
              ) : dailyConversions.length > 0 ? (
                <LineChart
                  data={dailyConversions}
                  height={240}
                  showGrid
                  color="#10b981"
                  showLegend={false}
                  formatValue={formatTrafficAxis}
                  formatTooltipValue={(value) => `${value} Registros`}
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
          <Card variant="glass">
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
          <Card variant="glass">
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
          <Card variant="glass">
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
          <Card variant="glass">
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
          <Card variant="glass">
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
          <Card variant="glass">
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

        {/* Tabla de sesiones de tracking */}
        <SessionsTable />
      </div>
    </PageContainer>
  )
}

export default Analytics
