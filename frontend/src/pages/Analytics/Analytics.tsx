import React, { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useDateRange } from '../../contexts/DateRangeContext'
import { useTimezone } from '../../contexts/TimezoneContext'
import { useIsRenderDomain } from '../../hooks'
import {
  PageContainer,
  Card,
  KpiCard,
  DateRangePicker,
  LineChart,
  TreeFilter,
  TrafficSourcesChart,
  SessionsTable,
  BarChart
} from '../../components/common'
import type { BarChartData } from '../../components/common'
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

// Helper para decodificar nombres URL-encoded (+ → espacio, %XX → carácter)
const decodeAdName = (name: string | null | undefined): string => {
  if (!name || name === 'null' || name === 'undefined') {
    return '(Tráfico orgánico)'
  }
  try {
    // Reemplazar + por espacios, luego decodificar
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
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

const parseTimestamp = (timestamp?: string | null): Date | null => {
  if (!timestamp) return null

  const trimmed = timestamp.trim()
  if (!trimmed) return null

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')

  const direct = new Date(normalized)
  if (!Number.isNaN(direct.getTime())) {
    return direct
  }

  const utcFallback = new Date(`${normalized}Z`)
  if (!Number.isNaN(utcFallback.getTime())) {
    return utcFallback
  }

  return null
}

const getDateKeyFromTimestamp = (timestamp?: string | null): string | null => {
  const parsed = parseTimestamp(timestamp)
  if (!parsed) return null
  return parsed.toISOString().split('T')[0]
}

const Analytics: React.FC = () => {
  const isRenderDomain = useIsRenderDomain()
  const { dateRange, setDateRange } = useDateRange()
  const { formatLocalDateShort } = useTimezone()
  const [loading, setLoading] = useState(false)

  // Si estamos en dominio .onrender.com, redirigir al Dashboard
  if (isRenderDomain) {
    return <Navigate to="/dashboard" replace />
  }

  // Estado para filtros
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string[]>>({})
  const [availableFilterData, setAvailableFilterData] = useState<any>({})
  const [allSessions, setAllSessions] = useState<Session[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  // Estado para visualizaciones
  const [dailyTraffic, setDailyTraffic] = useState<TrafficPoint[]>([])
  const [dailyConversions, setDailyConversions] = useState<any[]>([])
  const [registrosChartData, setRegistrosChartData] = useState<BarChartData[]>([])
  const [trafficSources, setTrafficSources] = useState<{ name: string; value: number; color: string }[]>([])
  const [platformsData, setPlatformsData] = useState<any[]>([])
  const [placementsData, setPlacementsData] = useState<any[]>([])
  const [devicesData, setDevicesData] = useState<any[]>([])
  const [osData, setOsData] = useState<any[]>([])
  const [browserData, setBrowserData] = useState<any[]>([])
  const [topVisitors, setTopVisitors] = useState<any[]>([])

  // Guardar el valor ORIGINAL de registros para restaurar al quitar filtros
  const [originalRegistros, setOriginalRegistros] = useState<number>(0)

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

          // Guardar valor ORIGINAL para restaurar al quitar filtros
          setOriginalRegistros(registros)

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
            const dateKey = getDateKeyFromTimestamp(session.started_at)
            if (!dateKey) return
            if (!dailyStats[dateKey]) {
              dailyStats[dateKey] = {
                totalVisits: 0,
                uniqueVisitors: new Set()
              }
            }
            dailyStats[dateKey].totalVisits++
            dailyStats[dateKey].uniqueVisitors.add(session.visitor_id)
          })

          // Incluir sesiones del período actual
          currentSessions.forEach((session: Session) => {
            const dateKey = getDateKeyFromTimestamp(session.started_at)
            if (!dateKey) return
            if (!dailyStats[dateKey]) {
              dailyStats[dateKey] = {
                totalVisits: 0,
                uniqueVisitors: new Set()
              }
            }
            dailyStats[dateKey].totalVisits++
            dailyStats[dateKey].uniqueVisitors.add(session.visitor_id)
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

          // Preparar datos para el gráfico de barras de registros (solo período actual)
          const registrosBarChartData = (contactsData || [])
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(item => ({
              name: formatLocalDateShort(item.date),
              value: item.count
            }))

          setRegistrosChartData(registrosBarChartData)

          // Guardar todas las sesiones y sesiones filtradas (ordenadas de más reciente a más vieja)
          const sortedSessions = [...currentSessions].sort((a, b) => {
            const dateA = parseTimestamp(a.started_at)?.getTime() ?? 0
            const dateB = parseTimestamp(b.started_at)?.getTime() ?? 0
            return dateB - dateA // DESC: más reciente primero
          })
          setAllSessions(sortedSessions)
          setSessions(sortedSessions)

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

          // JERARQUÍA DE ANUNCIOS: Platform → Campaign → Adset → Ad
          interface AdHierarchy {
            platform: string
            platform_id: string
            visitors: Set<string>
            campaigns: Map<string, {
              id: string
              name: string
              visitors: Set<string>
              adsets: Map<string, {
                id: string
                name: string
                visitors: Set<string>
                ads: Map<string, {
                  id: string
                  name: string
                  visitors: Set<string>
                }>
              }>
            }>
          }

          const adsHierarchyMap = new Map<string, AdHierarchy>()

          // Sources, etc. - Contar VISITANTES ÚNICOS por fuente
          const campaignsMap: { [key: string]: Set<string> } = {}
          const adsMap: { [key: string]: Set<string> } = {}
          const sourcesMap: { [key: string]: Set<string> } = {}
          const devicesMap: { [key: string]: Set<string> } = {}
          const browsersMap: { [key: string]: Set<string> } = {}
          const osMap: { [key: string]: Set<string> } = {}
          const placementsMap: { [key: string]: Set<string> } = {}

          currentSessions.forEach((session: Session) => {
            const visitorId = session.visitor_id

            // Construir jerarquía de anuncios usando UTMs (más confiable que campos específicos)
            // Requerimos al menos utm_source y utm_campaign para construir la jerarquía
            if (session.utm_source && session.utm_campaign) {
              // Normalizar plataforma desde utm_source (esto agrupa fb, facebook, Facebook)
              const platform = normalizeTrafficSource({
                referrer_url: session.referrer_url,
                site_source_name: session.site_source_name,
                utm_source: session.utm_source,
                source_platform: session.source_platform
              })
              // Usar plataforma normalizada como ID para evitar duplicados
              const platformId = platform.toLowerCase()

              // Obtener o crear entrada de plataforma
              if (!adsHierarchyMap.has(platformId)) {
                adsHierarchyMap.set(platformId, {
                  platform,
                  platform_id: platformId,
                  visitors: new Set(),
                  campaigns: new Map()
                })
              }
              const platformNode = adsHierarchyMap.get(platformId)!
              platformNode.visitors.add(visitorId)

              // Obtener o crear campaña (decodificar para evitar formato +++)
              const campaignId = decodeAdName(session.utm_campaign)
              if (!platformNode.campaigns.has(campaignId)) {
                platformNode.campaigns.set(campaignId, {
                  id: campaignId,
                  name: campaignId, // Ya está decodificado
                  visitors: new Set(),
                  adsets: new Map()
                })
              }
              const campaignNode = platformNode.campaigns.get(campaignId)!
              campaignNode.visitors.add(visitorId)

              // Obtener o crear adset desde utm_medium (decodificar ID también)
              const adsetId = session.utm_medium && session.utm_medium !== 'null' && session.utm_medium !== 'undefined'
                ? decodeAdName(session.utm_medium)
                : 'sin_conjunto'

              if (!campaignNode.adsets.has(adsetId)) {
                const displayName = session.utm_medium && session.utm_medium !== 'null' && session.utm_medium !== 'undefined'
                  ? adsetId // Ya está decodificado
                  : '(Sin conjunto de anuncios)'

                campaignNode.adsets.set(adsetId, {
                  id: adsetId,
                  name: displayName,
                  visitors: new Set(),
                  ads: new Map()
                })
              }
              const adsetNode = campaignNode.adsets.get(adsetId)!
              adsetNode.visitors.add(visitorId)

              // Obtener o crear anuncio desde utm_content (decodificar ID también)
              const adId = session.utm_content && session.utm_content !== 'null' && session.utm_content !== 'undefined'
                ? decodeAdName(session.utm_content)
                : 'sin_anuncio'

              if (!adsetNode.ads.has(adId)) {
                const displayName = session.utm_content && session.utm_content !== 'null' && session.utm_content !== 'undefined'
                  ? adId // Ya está decodificado
                  : '(Sin nombre de anuncio)'

                adsetNode.ads.set(adId, {
                  id: adId,
                  name: displayName,
                  visitors: new Set()
                })
              }
              const adNode = adsetNode.ads.get(adId)!
              adNode.visitors.add(visitorId)
            }

            // Mantener mapeo plano para compatibilidad con TreeFilter antiguo
            if (session.utm_campaign) {
              if (!campaignsMap[session.utm_campaign]) campaignsMap[session.utm_campaign] = new Set()
              campaignsMap[session.utm_campaign].add(visitorId)
            }
            if (session.utm_content) {
              if (!adsMap[session.utm_content]) adsMap[session.utm_content] = new Set()
              adsMap[session.utm_content].add(visitorId)
            }
            // Normalizar fuente con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const normalized = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (normalized && normalized !== 'Desconocido' && normalized !== 'Otro') {
              if (!sourcesMap[normalized]) sourcesMap[normalized] = new Set()
              sourcesMap[normalized].add(visitorId)
            }
            if (session.device_type) {
              if (!devicesMap[session.device_type]) devicesMap[session.device_type] = new Set()
              devicesMap[session.device_type].add(visitorId)
            }
            if (session.browser) {
              if (!browsersMap[session.browser]) browsersMap[session.browser] = new Set()
              browsersMap[session.browser].add(visitorId)
            }
            if (session.os) {
              if (!osMap[session.os]) osMap[session.os] = new Set()
              osMap[session.os].add(visitorId)
            }
            if (session.placement) {
              const formatted = formatPlacementName(session.placement)
              if (!placementsMap[formatted]) placementsMap[formatted] = new Set()
              placementsMap[formatted].add(visitorId)
            }
          })

          filterData.campaigns = Object.entries(campaignsMap)
            .map(([name, visitorSet]) => ({ name: formatUrlParameter(name), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.ads = Object.entries(adsMap)
            .map(([name, visitorSet]) => ({ name: formatUrlParameter(name), count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.sources = Object.entries(sourcesMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.devices = Object.entries(devicesMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.browsers = Object.entries(browsersMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.os = Object.entries(osMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          filterData.placements = Object.entries(placementsMap)
            .map(([name, visitorSet]) => ({ name, count: visitorSet.size }))
            .sort((a, b) => b.count - a.count)

          // Convertir jerarquía de anuncios a formato compatible con TreeFilter
          filterData.adsHierarchy = Array.from(adsHierarchyMap.values()).map(platformNode => ({
            platform: platformNode.platform,
            platform_id: platformNode.platform_id,
            count: platformNode.visitors.size,
            campaigns: Array.from(platformNode.campaigns.values()).map(campaignNode => ({
              id: campaignNode.id,
              name: campaignNode.name,
              count: campaignNode.visitors.size,
              adsets: Array.from(campaignNode.adsets.values()).map(adsetNode => ({
                id: adsetNode.id,
                name: adsetNode.name,
                count: adsetNode.visitors.size,
                ads: Array.from(adsetNode.ads.values()).map(adNode => ({
                  id: adNode.id,
                  name: adNode.name,
                  count: adNode.visitors.size
                })).sort((a, b) => b.count - a.count)
              })).sort((a, b) => b.count - a.count)
            })).sort((a, b) => b.count - a.count)
          })).sort((a, b) => b.count - a.count)

          setAvailableFilterData(filterData)

          // Calcular stats para las cards - VISITANTES ÚNICOS
          const browsersForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            const browser = session.browser || 'Desconocido'
            if (!browsersForChart[browser]) browsersForChart[browser] = new Set()
            browsersForChart[browser].add(session.visitor_id)
          })
          const browserStats = Object.entries(browsersForChart)
            .map(([browser, visitorSet]) => ({
              name: browser,
              users: visitorSet.size,
              percentage: ((visitorSet.size / uniqueVids) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setBrowserData(browserStats)

          const platformsForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
            const platform = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (!platformsForChart[platform]) platformsForChart[platform] = new Set()
            platformsForChart[platform].add(session.visitor_id)
          })
          const platformStats = Object.entries(platformsForChart)
            .map(([platform, visitorSet]) => ({
              name: platform,
              users: visitorSet.size,
              percentage: ((visitorSet.size / uniqueVids) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlatformsData(platformStats)

          // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.) - VISITANTES ÚNICOS
          const placementsForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            const rawPlacement = session.placement || 'Sin ubicación'
            const placement = formatPlacementName(rawPlacement)
            if (!placementsForChart[placement]) placementsForChart[placement] = new Set()
            placementsForChart[placement].add(session.visitor_id)
          })
          const placementStats = Object.entries(placementsForChart)
            .map(([placement, visitorSet]) => ({
              name: placement,
              users: visitorSet.size,
              percentage: ((visitorSet.size / uniqueVids) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setPlacementsData(placementStats)

          // Preparar datos para la dona de fuentes de tráfico - VISITANTES ÚNICOS
          const trafficSourcesForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            const source = normalizeTrafficSource({
              referrer_url: session.referrer_url,
              site_source_name: session.site_source_name,
              utm_source: session.utm_source,
              source_platform: session.source_platform
            })
            if (!trafficSourcesForChart[source]) trafficSourcesForChart[source] = new Set()
            trafficSourcesForChart[source].add(session.visitor_id)
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

          const trafficSourcesData = Object.entries(trafficSourcesForChart)
            .map(([source, visitorSet]) => ({
              name: source,
              value: visitorSet.size,
              color: trafficColorMap[source] || '#6b7280'
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 10)
          setTrafficSources(trafficSourcesData)

          const devicesForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            const device = session.device_type || 'Desconocido'
            if (!devicesForChart[device]) devicesForChart[device] = new Set()
            devicesForChart[device].add(session.visitor_id)
          })
          const deviceStats = Object.entries(devicesForChart)
            .map(([device, visitorSet]) => ({
              name: device,
              users: visitorSet.size,
              percentage: ((visitorSet.size / uniqueVids) * 100).toFixed(1)
            }))
            .sort((a, b) => b.users - a.users)
            .slice(0, 5)
          setDevicesData(deviceStats)

          const operatingSystemsForChart: { [key: string]: Set<string> } = {}
          currentSessions.forEach((session: Session) => {
            const os = session.os || 'Desconocido'
            if (!operatingSystemsForChart[os]) operatingSystemsForChart[os] = new Set()
            operatingSystemsForChart[os].add(session.visitor_id)
          })
          const osStats = Object.entries(operatingSystemsForChart)
            .map(([os, visitorSet]) => ({
              name: os,
              users: visitorSet.size,
              percentage: ((visitorSet.size / uniqueVids) * 100).toFixed(1)
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
      } catch {
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
              case 'landing_url':  // TreeFilter usa 'landing_url' para páginas
              case 'page_url':     // Mantener compatibilidad
                if (session.page_url) {
                  const urlPath = session.page_url.split('?')[0]
                  const pageName = urlPath.split('/').pop() || 'home'
                  if (pageName === value) fieldMatch = true
                }
                break
              case 'utm_campaign':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedCampaign = decodeAdName(session.utm_campaign)
                if (decodedCampaign === value) fieldMatch = true
                break
              case 'utm_medium':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedMedium = session.utm_medium ? decodeAdName(session.utm_medium) : ''
                if (decodedMedium === value) fieldMatch = true
                break
              case 'utm_content':
                // Decodificar para comparar correctamente (evitar formato +++)
                const decodedContent = session.utm_content ? decodeAdName(session.utm_content) : ''
                if (decodedContent === value) fieldMatch = true
                break
              case 'utm_source':
                // Normalizar fuente con todas las prioridades para match correcto
                const normalizedSource = normalizeTrafficSource({
                  referrer_url: session.referrer_url,
                  site_source_name: session.site_source_name,
                  utm_source: session.utm_source,
                  source_platform: session.source_platform
                })
                // Comparar en lowercase (platformId ahora es normalizado + lowercase)
                if (normalizedSource.toLowerCase() === value) fieldMatch = true
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
                const placementFormatted = formatPlacementName(session.placement || '')
                if (placementFormatted === value) fieldMatch = true
                break
              case 'ad_platform':
                const sessionPlatform = (session.source_platform || '').toLowerCase()
                if (sessionPlatform === value) fieldMatch = true
                break
              case 'campaign_id':
                if (session.campaign_id === value) fieldMatch = true
                break
              case 'adset_id':
                const sessionAdsetId = session.adset_id || session.ad_group_id
                if (sessionAdsetId === value) fieldMatch = true
                break
              case 'ad_id':
                if (session.ad_id === value) fieldMatch = true
                break
            }
          }

          if (!fieldMatch) return false
        }

        return true
      })

      // Ordenar sesiones filtradas de más reciente a más vieja
      const sortedFiltered = [...filtered].sort((a, b) => {
        const dateA = parseTimestamp(a.started_at)?.getTime() ?? 0
        const dateB = parseTimestamp(b.started_at)?.getTime() ?? 0
        return dateB - dateA // DESC: más reciente primero
      })
      setSessions(sortedFiltered)
    }
  }, [selectedFilters, allSessions])

  // Efecto para recalcular visualizaciones cuando cambien las sesiones filtradas
  useEffect(() => {
    // No hacer nada si allSessions está vacío (aún no se han cargado los datos iniciales)
    if (allSessions.length === 0) {
      return
    }

    // Detectar si hay filtros activos
    const hasActiveFilters = Object.keys(selectedFilters).length > 0 &&
      Object.values(selectedFilters).some(arr => arr.length > 0)

    // BUG FIX: Si no hay filtros activos, usar allSessions en vez de sessions
    const sessionsToProcess = hasActiveFilters ? sessions : allSessions

    if (sessionsToProcess.length === 0) {
      // Si no hay sesiones filtradas, resetear solo métricas de sesiones
      // NO resetear registros ni registrosChartData si no hay filtros (mantener originales)
      setMetrics(prev => ({
        pageViews: 0,
        uniqueVisitors: 0,
        registros: hasActiveFilters ? 0 : prev.registros, // Si hay filtro y no hay datos = 0
        conversionRate: 0,
        returningUsers: 0,
        avgPagePerSession: 0,
        trends: prev.trends // Mantener trends originales
      }))
      setDailyTraffic([])
      setDailyConversions([])
      if (hasActiveFilters) {
        setRegistrosChartData([]) // Vaciar gráfico si hay filtro activo
      }
      return
    }

    // Recalcular KPIs principales con las sesiones filtradas
    const uniqueVids = new Set(sessionsToProcess.map((s: Session) => s.visitor_id)).size
    const totalPageViews = sessionsToProcess.length

    // Contar sesiones únicas (por session_id)
    const uniqueSessionIds = new Set(sessionsToProcess.map((s: Session) => s.session_id)).size

    // Registros = contactos únicos que aparecen en las sesiones filtradas
    const sesionesConContacto = sessionsToProcess.filter((s: Session) => {
      if (!s.contact_id || !s.contact_created_at) return false

      const startedDate = parseTimestamp(s.started_at)
      const contactCreatedDate = parseTimestamp(s.contact_created_at)

      if (!startedDate || !contactCreatedDate) return false

      return startedDate >= contactCreatedDate
    })

    const registrosEnSesiones = new Set(
      sesionesConContacto.map((s: Session) => s.contact_id)
    ).size

    // Si hay filtros activos, usar registrosEnSesiones; si no, usar valor original guardado
    const registrosValue = hasActiveFilters ? registrosEnSesiones : originalRegistros

    const conversionRate = uniqueVids > 0 ? ((registrosValue / uniqueVids) * 100) : 0

    // Usuarios recurrentes: contar visitor_ids que tienen múltiples session_ids diferentes
    const visitorSessionMap: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((s: Session) => {
      if (!visitorSessionMap[s.visitor_id]) {
        visitorSessionMap[s.visitor_id] = new Set()
      }
      visitorSessionMap[s.visitor_id].add(s.session_id)
    })
    const returningUsers = Object.values(visitorSessionMap).filter(sessionSet => sessionSet.size > 1).length

    // Páginas por sesión = total de page_views / número de sesiones únicas
    const avgPagePerSession = uniqueSessionIds > 0 ?
      (totalPageViews / uniqueSessionIds) : 0

    // Actualizar métricas (sin trends, ya que los filtros no tienen período anterior)
    setMetrics(prev => ({
      pageViews: totalPageViews,
      uniqueVisitors: uniqueVids,
      registros: registrosValue, // Usar valor filtrado si hay filtros activos
      conversionRate,
      returningUsers,
      avgPagePerSession,
      trends: prev.trends // Mantener trends del período original
    }))

    // Recalcular gráfico de tráfico diario con sesiones filtradas
    const dailyStats: { [key: string]: { totalVisits: number, uniqueVisitors: Set<string> } } = {}

    sessionsToProcess.forEach((session: Session) => {
      const dateKey = getDateKeyFromTimestamp(session.started_at)
      if (!dateKey) return
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          totalVisits: 0,
          uniqueVisitors: new Set()
        }
      }
      dailyStats[dateKey].totalVisits++
      dailyStats[dateKey].uniqueVisitors.add(session.visitor_id)
    })

    const chartData = Object.entries(dailyStats)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, stats]) => ({
        label: formatLocalDateShort(date),
        value: stats.totalVisits,
        value2: stats.uniqueVisitors.size
      }))

    setDailyTraffic(chartData)

    // Recalcular gráficos de registros SI hay filtros activos
    if (hasActiveFilters) {
      // Agrupar contactos únicos por fecha de creación
      const registrosPorFecha: { [key: string]: Set<string> } = {}

      sessionsToProcess.forEach((session: Session) => {
        if (session.contact_id && session.contact_created_at) {
          const createdDate = parseTimestamp(session.contact_created_at)
          const startedDate = parseTimestamp(session.started_at)

          if (!createdDate || !startedDate || startedDate < createdDate) {
            return
          }

          const dateKey = getDateKeyFromTimestamp(session.contact_created_at)
          if (!dateKey) return
          if (!registrosPorFecha[dateKey]) {
            registrosPorFecha[dateKey] = new Set()
          }
          registrosPorFecha[dateKey].add(session.contact_id)
        }
      })

      // Generar datos para el gráfico de barras (solo período actual filtrado)
      const filteredRegistrosChartData = Object.entries(registrosPorFecha)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, contactSet]) => ({
          name: formatLocalDateShort(date),
          value: contactSet.size
        }))

      setRegistrosChartData(filteredRegistrosChartData)

      // Generar datos para el gráfico de conversiones (con período anterior incluido)
      const filteredConversionsData = Object.entries(registrosPorFecha)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, contactSet]) => ({
          label: formatLocalDateShort(date),
          value: contactSet.size
        }))

      setDailyConversions(filteredConversionsData)
    } else {
    }
    // Si NO hay filtros, mantener los datos originales (ya están seteados en el primer useEffect)

    // Recalcular stats para las cards
    const browsersForFilter: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      const browser = session.browser || 'Desconocido'
      if (!browsersForFilter[browser]) browsersForFilter[browser] = new Set()
      browsersForFilter[browser].add(session.visitor_id)
    })
    const uniqueVisitorsInFilter = new Set(sessionsToProcess.map(s => s.visitor_id)).size
    const browserStats = Object.entries(browsersForFilter)
      .map(([browser, visitorSet]) => ({
        name: browser,
        users: visitorSet.size,
        percentage: ((visitorSet.size / uniqueVisitorsInFilter) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setBrowserData(browserStats)

    const platformsForFilter: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
      const platform = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })
      if (!platformsForFilter[platform]) platformsForFilter[platform] = new Set()
      platformsForFilter[platform].add(session.visitor_id)
    })
    const platformStats = Object.entries(platformsForFilter)
      .map(([platform, visitorSet]) => ({
        name: platform,
        users: visitorSet.size,
        percentage: ((visitorSet.size / uniqueVisitorsInFilter) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlatformsData(platformStats)

    // Calcular placements para "Top de ubicaciones" (Facebook Feed, Instagram Reels, etc.) - VISITANTES ÚNICOS
    const placementsForFilter: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      const rawPlacement = session.placement || 'Sin ubicación'
      const placement = formatPlacementName(rawPlacement)
      if (!placementsForFilter[placement]) placementsForFilter[placement] = new Set()
      placementsForFilter[placement].add(session.visitor_id)
    })
    const placementStats = Object.entries(placementsForFilter)
      .map(([placement, visitorSet]) => ({
        name: placement,
        users: visitorSet.size,
        percentage: ((visitorSet.size / uniqueVisitorsInFilter) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setPlacementsData(placementStats)

    // Preparar datos para la dona de fuentes de tráfico - VISITANTES ÚNICOS
    const trafficSourcesFiltered: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      const source = normalizeTrafficSource({
        referrer_url: session.referrer_url,
        site_source_name: session.site_source_name,
        utm_source: session.utm_source,
        source_platform: session.source_platform
      })
      if (!trafficSourcesFiltered[source]) trafficSourcesFiltered[source] = new Set()
      trafficSourcesFiltered[source].add(session.visitor_id)
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

    const trafficSourcesData = Object.entries(trafficSourcesFiltered)
      .map(([source, visitorSet]) => ({
        name: source,
        value: visitorSet.size,
        color: trafficColorMap[source] || '#6b7280'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
    setTrafficSources(trafficSourcesData)

    const devicesFiltered: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      const device = session.device_type || 'Desconocido'
      if (!devicesFiltered[device]) devicesFiltered[device] = new Set()
      devicesFiltered[device].add(session.visitor_id)
    })
    const uniqueVisitorsFiltered = new Set(sessionsToProcess.map(s => s.visitor_id)).size
    const deviceStats = Object.entries(devicesFiltered)
      .map(([device, visitorSet]) => ({
        name: device,
        users: visitorSet.size,
        percentage: ((visitorSet.size / uniqueVisitorsFiltered) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setDevicesData(deviceStats)

    const operatingSystemsForFilter: { [key: string]: Set<string> } = {}
    sessionsToProcess.forEach((session: Session) => {
      const os = session.os || 'Desconocido'
      if (!operatingSystemsForFilter[os]) operatingSystemsForFilter[os] = new Set()
      operatingSystemsForFilter[os].add(session.visitor_id)
    })
    const osStats = Object.entries(operatingSystemsForFilter)
      .map(([os, visitorSet]) => ({
        name: os,
        users: visitorSet.size,
        percentage: ((visitorSet.size / uniqueVisitorsInFilter) * 100).toFixed(1)
      }))
      .sort((a, b) => b.users - a.users)
      .slice(0, 5)
    setOsData(osStats)

    const visitorCounts: { [key: string]: number } = {}
    sessionsToProcess.forEach((s: Session) => {
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

  }, [sessions, allSessions, selectedFilters, formatLocalDateShort])

  // Preparar métricas para KPICards
  const mainMetrics = [
    {
      title: 'Visualizaciones',
      value: metrics.pageViews > 1000 ? `${(metrics.pageViews / 1000).toFixed(1)}K` : String(metrics.pageViews || 0),
      delta: metrics.trends?.pageViews || 0,
      icon: Eye
    },
    {
      title: 'Visitantes Únicos',
      value: String(metrics.uniqueVisitors || 0),
      delta: metrics.trends?.uniqueVisitors || 0,
      icon: Users
    },
    {
      title: 'Registros',
      value: String(metrics.registros || 0),
      delta: metrics.trends?.registros || 0,
      icon: UserCheck
    },
    {
      title: 'Conversión',
      value: `${(metrics.conversionRate || 0).toFixed(1)}%`,
      delta: metrics.trends?.conversionRate || 0,
      icon: Target
    }
  ]

  return (
    <PageContainer>
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-4">
          <p className="text-sm text-orange-600 dark:text-orange-400 font-medium">
            Arreglar filtros
          </p>
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
              key={metric.title}
              title={metric.title}
              value={metric.value}
              delta={metric.delta}
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

          <div className="mt-4 h-[clamp(320px,45vh,560px)] min-h-[320px]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                Cargando datos...
              </div>
            ) : dailyTraffic.length > 0 ? (
              <LineChart
                data={dailyTraffic}
                minHeight={320}
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

        {/* Grid de Gráficas: Registros y Fuentes de Tráfico */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Gráfico de Barras de Registros */}
          <Card variant="glass" className="p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold">Registros por Fecha</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Contactos registrados en el período
              </p>
            </div>
            <div className="h-[320px]">
              <BarChart
                data={registrosChartData}
                loading={loading}
                formatTooltip={(value) => `${value} ${value === 1 ? 'registro' : 'registros'}`}
              />
            </div>
          </Card>

          {/* Gráfica de Fuentes de Tráfico */}
          <TrafficSourcesChart
            data={trafficSources}
            loading={loading}
          />
        </div>

        {/* Grid de stats cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
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
        <SessionsTable
          filteredSessions={sessions}
          useExternalData={true}
        />
      </div>
    </PageContainer>
  )
}

export default Analytics
