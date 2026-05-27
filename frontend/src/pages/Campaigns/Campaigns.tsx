import React, { useState, useEffect, useCallback } from 'react'
import { KpiCard, Card, DateRangePicker, Table, Icon, ContactDetailsModal, VisitorDetailsModal, PageContainer, ViewSelector, AreaChart, Loading, TabList } from '@/components/common'
import type { Column } from '@/components/common'
import {
  RefreshCw,
  DollarSign,
  Megaphone,
  Target,
  TrendingUp,
  Users,
  ChevronRight,
  ChevronDown,
  Trophy,
  PlayCircle,
  Image as ImageIcon,
  X,
  ExternalLink
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { formatCurrency, formatRoas, formatDateToISO, formatEndDateToISO, parseLocalDateString, formatChartCurrency, formatChartNumber } from '@/utils/format'
import { campaignsService, type CampaignContact } from '@/services/campaignsService'
import { reportsService, type CampaignsReport } from '@/services/reportsService'
import { useAppConfig, useMetaTimezone, useIsRenderDomain } from '@/hooks'
import styles from './Campaigns.module.css'

interface AdData {
  id: string
  name: string
  creativeId?: string | null
  creativeType?: 'image' | 'video' | null
  creativeThumbnailUrl?: string | null
  creativeImageUrl?: string | null
  creativeVideoId?: string | null
  creativeVideoUrl?: string | null
  creativePreviewUrl?: string | null
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
}

interface CreativePreviewData {
  name: string
  type: 'image' | 'video'
  thumbnailUrl: string | null
  imageUrl: string | null
  videoUrl: string | null
  previewUrl: string | null
}

interface AdSetData {
  id: string
  name: string
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
  ads?: AdData[]
  isExpanded?: boolean
}

interface CampaignData {
  id: string
  name: string
  platform?: string
  spend: number
  reach?: number
  impressions?: number
  clicks: number
  visitors?: number
  leads?: number
  sales?: number
  revenue?: number
  roas?: number
  cpc?: number
  cpm?: number
  adsets?: AdSetData[]
  adSets?: AdSetData[]  // Keep both for compatibility
  isExpanded?: boolean
}

type ChartView = 'revenue' | 'leads' | 'appointments' | 'visitors'

interface ChartConfig {
  title: string
  subtitle: string
  data: Array<{ label: string; value: number; value2?: number }>
  color: string
  color2?: string
  showLegend: boolean
  legendLabels?: { label1: string; label2?: string }
  formatValue: (value: number) => string
  formatTooltipValue?: (value: number) => string
  emptyMessage: string
}

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

export const Campaigns: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { labels } = useLabels()

  // Detectar si estamos en dominio .onrender.com
  const isRenderDomain = useIsRenderDomain()

  // Sistema híbrido de configuración
  const [visitorSourceConfig] = useAppConfig<'platform' | 'tracking'>('visitor_source', 'platform')
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')

  // FORZAR valores si estamos en dominio .onrender.com
  const visitorSource = isRenderDomain ? 'platform' : visitorSourceConfig
  const analyticsEnabled = isRenderDomain ? false : parseAnalyticsFlag(showAnalyticsConfig)

  // Detectar discrepancia de timezone
  const timezoneInfo = useMetaTimezone()
  const [timezoneWarningDismissed, setTimezoneWarningDismissed] = useAppConfig<boolean>('timezone_warning_dismissed', false)

  const [campaigns, setCampaigns] = useState<CampaignData[]>([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'campaigns' | 'winners'>('campaigns')
  const [winnersCategory, setWinnersCategory] = useState<'campaigns' | 'adsets' | 'ads'>('campaigns')
  const [campaignSummary, setCampaignSummary] = useState<CampaignsReport['summary'] | null>(null)
  const [selectedChart, setSelectedChart] = useState<ChartView>('revenue')

  // Datos para diferentes gráficos
  const [revenueData, setRevenueData] = useState<any[]>([])
  const [leadsData, setLeadsData] = useState<any[]>([])
  const [appointmentsData, setAppointmentsData] = useState<any[]>([])
  const [visitorsData, setVisitorsData] = useState<any[]>([])

  // Estados para modal de contactos
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'interesados' | 'sales' | 'appointments'>('interesados')
  const [modalContacts, setModalContacts] = useState<CampaignContact[]>([])
  const [modalLoading, setModalLoading] = useState(false)
  const [modalTitle, setModalTitle] = useState('')
  const [selectedModalItem, setSelectedModalItem] = useState<any>(null)

  // Estados para modal de visitantes
  const [isVisitorsModalOpen, setIsVisitorsModalOpen] = useState(false)
  const [modalVisitors, setModalVisitors] = useState<any[]>([])
  const [visitorsModalLoading, setVisitorsModalLoading] = useState(false)
  const [visitorsModalTitle, setVisitorsModalTitle] = useState('')
  const [selectedVisitorItem, setSelectedVisitorItem] = useState<any>(null)
  const [selectedCreative, setSelectedCreative] = useState<CreativePreviewData | null>(null)

  /**
   * Agrupa datos de gráfico por semana o mes según el rango
   * VERSIÓN SIMPLIFICADA Y ROBUSTA
   */
  const groupAndFormatChartData = useCallback((
    rawData: any[],
    rangeInDays: number,
    adjustDateFn?: (date: string) => string
  ) => {
    // Si no hay datos, retornar vacío
    if (!rawData || rawData.length === 0) {
      return []
    }

    // Determinar tipo de agrupación
    let groupBy: 'day' | 'week' | 'month' = 'day'
    if (rangeInDays > 90) groupBy = 'month'
    else if (rangeInDays > 31) groupBy = 'week'

    // Si es vista diaria, solo formatear
    if (groupBy === 'day') {
      return rawData.map((item, index) => {
        const dateStr = adjustDateFn ? adjustDateFn(item.label) : item.label
        const cleanDate = dateStr.split(' (')[0] // Remover timezone indicator si existe
        const [year, month, day] = cleanDate.split('-').map(Number)
        const date = new Date(year, month - 1, day)

        // Detectar cambio de año
        let yearChanged = false
        if (index > 0) {
          const prevDateStr = adjustDateFn ? adjustDateFn(rawData[index - 1].label) : rawData[index - 1].label
          const prevCleanDate = prevDateStr.split(' (')[0]
          const [prevYear] = prevCleanDate.split('-').map(Number)
          yearChanged = prevYear !== year
        }

        const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic']
        const monthName = monthNames[month - 1]
        const formattedDate = yearChanged ? `${day} ${monthName} ${year}` : `${day} ${monthName}`

        // Agregar timezone indicator si existe
        const tzMatch = dateStr.match(/\s\(([^)]+)\)$/)
        const label = tzMatch ? `${formattedDate} (${tzMatch[1]})` : formattedDate

        return {
          label,
          value: Number(item.value) || 0,
          value2: Number(item.value2) || 0
        }
      })
    }

    // Agrupar datos
    const grouped = new Map<string, { value: number; value2: number }>()

    rawData.forEach(item => {
      if (!item.label) return

      const cleanDate = item.label.split(' (')[0]
      const [year, month, day] = cleanDate.split('-').map(Number)
      const date = new Date(year, month - 1, day)

      if (isNaN(date.getTime())) return

      let key: string

      if (groupBy === 'week') {
        // Lunes de la semana
        const monday = new Date(date)
        const dayOfWeek = monday.getDay()
        const diff = monday.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)
        monday.setDate(diff)
        key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`
      } else {
        // Primer día del mes
        key = `${year}-${String(month).padStart(2, '0')}-01`
      }

      const existing = grouped.get(key)
      const val1 = Number(item.value) || 0
      const val2 = Number(item.value2) || 0

      if (existing) {
        existing.value += val1
        existing.value2 += val2
      } else {
        grouped.set(key, { value: val1, value2: val2 })
      }
    })

    // Convertir a array y formatear
    const sortedKeys = Array.from(grouped.keys()).sort()
    const spansMultipleYears = groupBy === 'month'
      ? new Set(sortedKeys.map(key => key.split('-')[0])).size > 1
      : false

    return sortedKeys.map((key, index) => {
      const data = grouped.get(key)!
      const dateStr = adjustDateFn ? adjustDateFn(key) : key
      const cleanDate = dateStr.split(' (')[0]
      const [year, month, day] = cleanDate.split('-').map(Number)
      const date = new Date(year, month - 1, day)

      // Detectar cambio de año
      let yearChanged = false
      if (index > 0) {
        const prevKey = sortedKeys[index - 1]
        const prevDateStr = adjustDateFn ? adjustDateFn(prevKey) : prevKey
        const prevCleanDate = prevDateStr.split(' (')[0]
        const [prevYear] = prevCleanDate.split('-').map(Number)
        yearChanged = prevYear !== year
      }

      const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sept', 'Oct', 'Nov', 'Dic']
      const monthName = monthNames[month - 1]

      let formattedDate: string
      if (groupBy === 'month') {
        if (spansMultipleYears) {
          formattedDate = `${monthName} ${year}`
        } else {
          formattedDate = yearChanged ? `${monthName} ${year}` : monthName
        }
      } else {
        formattedDate = yearChanged ? `${day} ${monthName.toLowerCase()} ${year}` : `${day} ${monthName.toLowerCase()}`
      }

      // Agregar timezone indicator si existe
      const tzMatch = dateStr.match(/\s\(([^)]+)\)$/)
      const label = tzMatch ? `${formattedDate} (${tzMatch[1]})` : formattedDate

      return {
        label,
        value: data.value,
        value2: data.value2
      }
    })
  }, [timezoneInfo])

  const fetchCampaigns = useCallback(async () => {
    try {
      setLoading(true)
      const startDate = formatDateToISO(dateRange.start)
      const endDate = formatEndDateToISO(dateRange.end) // Incluir día completo hasta 23:59:59

      const summaryPromise = reportsService
        .getCampaignsReport({ from: startDate, to: endDate })
        .catch(() => null as CampaignsReport | null)

      const includeTrackingVisitors = analyticsEnabled && visitorSource === 'tracking'

      const promises = [
        campaignsService.getCampaigns(startDate, endDate),
        campaignsService.getSpendOverTime(startDate, endDate),
        summaryPromise,
        includeTrackingVisitors
          ? fetch(`/api/tracking/visitors-by-ad?startDate=${startDate}&endDate=${endDate}`)
              .then(res => res.json())
              .then(data => data.data || {})
              .catch(() => ({}))
          : Promise.resolve({})
      ]

      const results = await Promise.all(promises)
      const [campaignsData, spendData, summaryReport, visitorsByAdRaw] = results
      const visitorsByAd = includeTrackingVisitors ? visitorsByAdRaw : {}

      // Transform the data to match our interface
      const transformedData = campaignsData.map(campaign => {
        // Calcular visitantes para esta campaña y sus ads
        let campaignVisitors = 0

        if (includeTrackingVisitors && visitorsByAd) {
          // Sumar visitantes de todos los ads de esta campaña
          campaign.adsets?.forEach((adset: any) => {
            adset.ads?.forEach((ad: any) => {
              const adVisitorData = visitorsByAd[ad.id]
              if (adVisitorData) {
                ad.visitors = adVisitorData.uniqueVisitors
                campaignVisitors += adVisitorData.uniqueVisitors
              } else {
                ad.visitors = 0
              }
            })
            // Calcular visitantes del adset sumando sus ads
            adset.visitors = adset.ads?.reduce((sum: number, ad: any) => sum + (ad.visitors || 0), 0) || 0
          })
        }

        return {
          ...campaign,
          platform: 'Meta', // All campaigns from Meta
          adSets: campaign.adsets, // Map adsets to adSets for compatibility
          adsets: campaign.adsets, // Keep both for compatibility
          visitors: includeTrackingVisitors ? campaignVisitors : 0,
          revenue: campaign.revenue || 0,
          sales: campaign.sales || 0,
          leads: campaign.leads || 0,
          roas: campaign.roas || (campaign.revenue && campaign.spend ? campaign.revenue / campaign.spend : 0)
        }
      })

      // Ordenar campañas de más reciente a más vieja (por ID descendente)
      const sortedData = transformedData.sort((a, b) => {
        // Los IDs de Meta son números grandes como strings
        const idA = parseInt(a.id) || 0
        const idB = parseInt(b.id) || 0
        return idB - idA // Descendente: más reciente primero
      })

      setCampaigns(sortedData)
      setCampaignSummary(summaryReport?.summary ?? null)

      // Calcular rango en días
      const rangeInDays = Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24))

      // Procesar datos de revenue usando la función simplificada
      const processedRevenueData = groupAndFormatChartData(
        spendData || [],
        rangeInDays,
        timezoneInfo.adjustMetaDateToLocal
      )
      setRevenueData(processedRevenueData)

      // Fetch funnel metrics
      const funnelMetricsRaw = await campaignsService.getFunnelMetrics(startDate, endDate)

      // Procesar datos de leads
      const leadsChartData = (funnelMetricsRaw || []).map((item: any) => ({
        label: item.label,
        value: item.leads || 0,
        value2: item.appointments || 0
      }))
      const processedLeadsData = groupAndFormatChartData(
        leadsChartData,
        rangeInDays,
        timezoneInfo.adjustMetaDateToLocal
      )
      setLeadsData(processedLeadsData)

      // Procesar datos de citas
      const appointmentsChartData = (funnelMetricsRaw || []).map((item: any) => ({
        label: item.label,
        value: item.appointments || 0,
        value2: item.sales || 0
      }))
      const processedAppointmentsData = groupAndFormatChartData(
        appointmentsChartData,
        rangeInDays,
        timezoneInfo.adjustMetaDateToLocal
      )
      setAppointmentsData(processedAppointmentsData)

      // Procesar datos de visitantes (solo si está habilitado)
      if (analyticsEnabled) {
        const visitorsChartData = (funnelMetricsRaw || []).map((item: any) => ({
          label: item.label,
          value: item.visitors || 0,
          value2: item.leads || 0
        }))
        const processedVisitorsData = groupAndFormatChartData(
          visitorsChartData,
          rangeInDays,
          timezoneInfo.adjustMetaDateToLocal
        )
        setVisitorsData(processedVisitorsData)
      } else {
        setVisitorsData([])
      }
    } catch {
      // Don't fall back to mock data - show empty state
      setCampaigns([])
      setCampaignSummary(null)
      setRevenueData([])
      setLeadsData([])
      setAppointmentsData([])
      setVisitorsData([])
    } finally {
      setLoading(false)
    }
  }, [analyticsEnabled, dateRange.end, dateRange.start, visitorSource, timezoneInfo, groupAndFormatChartData])

  // Fetch campaigns on mount and when date range or visitor source changes
  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

  useEffect(() => {
    if (!selectedCreative) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedCreative(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedCreative])

  const checkSyncStatus = useCallback(async () => {
    try {
      const status = await campaignsService.getSyncStatus()

      // Si no hay status o no está corriendo
      if (!status || !status.running) {
        // Si había una sincronización corriendo y ahora terminó
        setSyncStatus((prevStatus: any) => {
          if (prevStatus?.running) {
            fetchCampaigns()
            return null
          }
          return prevStatus
        })
        return
      }

      // Si está corriendo, siempre actualizar para mostrar progreso
      setSyncStatus(status)
    } catch (error) {
      // Silenciar errores de polling
    }
  }, [fetchCampaigns])

  // Poll sync status periodically
  useEffect(() => {
    // Initial check
    checkSyncStatus()

    // Poll every 2 seconds
    const intervalId = setInterval(() => {
      checkSyncStatus()
    }, 2000)

    return () => {
      clearInterval(intervalId)
    }
  }, [checkSyncStatus])

  const handleOpenContactsModal = useCallback(async (item: any, type: 'interesados' | 'sales' | 'appointments') => {
    setModalLoading(true)
    setIsModalOpen(true)
    setModalType(type)
    setModalTitle(`${type === 'interesados' ? labels.leads : type === 'sales' ? 'Ventas' : 'Citas'} - ${item.name}`)
    setModalContacts([])
    setSelectedModalItem(item)

    try {
      const startDate = formatDateToISO(dateRange.start)
      const endDate = formatEndDateToISO(dateRange.end) // Incluir día completo

      const params: any = {
        type,
        startDate,
        endDate
      }

      if (item.level === 'campaign') {
        params.campaign_id = item.id
      } else if (item.level === 'adset') {
        params.adset_id = item.id
      } else if (item.level === 'ad') {
        params.ad_id = item.id
      }

      const contacts = await campaignsService.getContactsByType(params)
      setModalContacts(contacts)
    } catch (error) {
      setModalContacts([])
    } finally {
      setModalLoading(false)
    }
  }, [dateRange, labels])

  // Limpiar datos del modal cuando cambian las fechas
  useEffect(() => {
    if (isModalOpen) {
      setModalContacts([]) // Limpiar datos anteriores
      // Si el modal está abierto, recargar los datos con las nuevas fechas
      if (selectedModalItem) {
        const loadModalData = async () => {
          setModalLoading(true)
          try {
            const startDate = formatDateToISO(dateRange.start)
            const endDate = formatEndDateToISO(dateRange.end)

            const params: any = {
              startDate,
              endDate,
              type: modalType
            }

            if (selectedModalItem.level === 'campaign') {
              params.campaign_id = selectedModalItem.id
            } else if (selectedModalItem.level === 'adset') {
              params.adset_id = selectedModalItem.id
            } else if (selectedModalItem.level === 'ad') {
              params.ad_id = selectedModalItem.id
            }

            const contacts = await campaignsService.getContactsByType(params)
            setModalContacts(contacts)
          } catch (error) {
            setModalContacts([])
          } finally {
            setModalLoading(false)
          }
        }
        loadModalData()
      }
    }
  }, [dateRange]) // Solo reaccionar a cambios de fecha

  // Limpiar datos del modal de visitantes cuando cambian las fechas
  useEffect(() => {
    if (!analyticsEnabled) return

    if (isVisitorsModalOpen) {
      setModalVisitors([]) // Limpiar datos anteriores
      // Si el modal está abierto, recargar los datos con las nuevas fechas
      if (selectedVisitorItem) {
        const loadVisitorsData = async () => {
          setVisitorsModalLoading(true)
          try {
            const startDate = formatDateToISO(dateRange.start)
            const endDate = formatEndDateToISO(dateRange.end)

            const params: any = {
              startDate,
              endDate
            }

            if (selectedVisitorItem.level === 'campaign') {
              params.campaign_id = selectedVisitorItem.id
            } else if (selectedVisitorItem.level === 'adset') {
              params.adset_id = selectedVisitorItem.id
            } else if (selectedVisitorItem.level === 'ad') {
              params.ad_id = selectedVisitorItem.id
            }

            const visitors = await campaignsService.getVisitorsList(params)
            setModalVisitors(visitors)
          } catch (error) {
            setModalVisitors([])
          } finally {
            setVisitorsModalLoading(false)
          }
        }
        loadVisitorsData()
      }
    }
  }, [analyticsEnabled, dateRange])

  const handleOpenVisitorsModal = useCallback(async (item: any) => {
    if (!analyticsEnabled) return

    setVisitorsModalLoading(true)
    setIsVisitorsModalOpen(true)
    setVisitorsModalTitle(`Visitantes - ${item.name}`)
    setModalVisitors([])
    setSelectedVisitorItem(item) // Guardar el item seleccionado

    try {
      const startDate = formatDateToISO(dateRange.start)
      const endDate = formatEndDateToISO(dateRange.end)

      const params: any = {
        startDate,
        endDate
      }

      if (item.level === 'campaign') {
        params.campaign_id = item.id
      } else if (item.level === 'adset') {
        params.adset_id = item.id
      } else if (item.level === 'ad') {
        params.ad_id = item.id
      }

      const queryString = new URLSearchParams(params).toString()
      const response = await fetch(`/api/tracking/visitors?${queryString}`)
      const data = await response.json()

      if (data.success) {
        setModalVisitors(data.data || [])
      } else {
        setModalVisitors([])
      }
    } catch {
      setModalVisitors([])
    } finally {
      setVisitorsModalLoading(false)
    }
  }, [analyticsEnabled, dateRange])

  const toggleCampaign = useCallback((campaignId: string) => {
    // Asegurar que el ID sea string
    const id = String(campaignId)

    setExpandedCampaigns(prev => {
      const newSet = new Set(prev)

      if (newSet.has(id)) {
        // Colapsar campaña
        newSet.delete(id)

        // También colapsar todos sus AdSets
        const campaign = campaigns.find(c => String(c.id) === id)
        if (campaign?.adsets && Array.isArray(campaign.adsets)) {
          setExpandedAdSets(prevAdSets => {
            const newAdSets = new Set(prevAdSets)
            campaign.adsets?.forEach((adSet: any) => {
              newAdSets.delete(String(adSet.id))
            })
            return newAdSets
          })
        }
      } else {
        // Expandir campaña
        newSet.add(id)
      }

      return newSet
    })
  }, [campaigns])

  const toggleAdSet = useCallback((adSetId: string) => {
    // Asegurar que el ID sea string
    const id = String(adSetId)

    setExpandedAdSets(prev => {
      const newSet = new Set(prev)

      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }

      return newSet
    })
  }, [])

  // Lista plana de ads ganadores: ordenados por revenue → sales → appointments → leads
  const sortWinners = React.useCallback((items: any[]) => {
    return [...items]
      .filter(item =>
        (item.revenue || 0) > 0 ||
        (item.sales || 0) > 0 ||
        (item.appointments || 0) > 0 ||
        (item.leads || 0) > 0
      )
      .sort((a, b) => {
        const ar = a.revenue || 0, br = b.revenue || 0
        if (br !== ar) return br - ar
        const asa = a.sales || 0, bsa = b.sales || 0
        if (bsa !== asa) return bsa - asa
        const ap = a.appointments || 0, bp = b.appointments || 0
        if (bp !== ap) return bp - ap
        const al = a.leads || 0, bl = b.leads || 0
        return bl - al
      })
      .map((item, index) => ({ ...item, rank: index + 1 }))
  }, [])

  const winnersCampaigns = React.useMemo(() => {
    const items = campaigns.map(campaign => ({
      ...campaign,
      id: String(campaign.id),
      level: 'campaign' as const,
      platform: campaign.platform,
      revenue: campaign.revenue || 0,
      sales: campaign.sales || 0,
      appointments: (campaign as any).appointments || 0,
      leads: campaign.leads || 0,
      spend: campaign.spend || 0
    }))
    return sortWinners(items)
  }, [campaigns, sortWinners])

  const winnersAdSets = React.useMemo(() => {
    const items: any[] = []
    campaigns.forEach(campaign => {
      const adSetsData = campaign.adsets || campaign.adSets || []
      adSetsData.forEach((adSet: any) => {
        items.push({
          ...adSet,
          id: String(adSet.id),
          level: 'adset',
          campaignId: String(campaign.id),
          campaignName: campaign.name,
          platform: campaign.platform,
          revenue: adSet.revenue || 0,
          sales: adSet.sales || 0,
          appointments: adSet.appointments || 0,
          leads: adSet.leads || 0,
          spend: adSet.spend || 0
        })
      })
    })
    return sortWinners(items)
  }, [campaigns, sortWinners])

  const winnersAds = React.useMemo(() => {
    const items: any[] = []
    campaigns.forEach(campaign => {
      const adSetsData = campaign.adsets || campaign.adSets || []
      adSetsData.forEach((adSet: any) => {
        const adsData = adSet.ads || []
        adsData.forEach((ad: any) => {
          items.push({
            ...ad,
            id: String(ad.id),
            level: 'ad',
            campaignId: String(campaign.id),
            campaignName: campaign.name,
            adSetId: String(adSet.id),
            adSetName: adSet.name,
            platform: campaign.platform,
            revenue: ad.revenue || 0,
            sales: ad.sales || 0,
            appointments: ad.appointments || 0,
            leads: ad.leads || 0,
            spend: ad.spend || 0
          })
        })
      })
    })
    return sortWinners(items)
  }, [campaigns, sortWinners])

  const winnersActiveData = winnersCategory === 'campaigns'
    ? winnersCampaigns
    : winnersCategory === 'adsets'
      ? winnersAdSets
      : winnersAds

  const getCreativePreviewData = React.useCallback((item: any): CreativePreviewData | null => {
    if (item.level !== 'ad') return null

    const thumbnailUrl = item.creativeThumbnailUrl || item.creativeImageUrl || null
    const imageUrl = item.creativeImageUrl || item.creativeThumbnailUrl || null
    const videoUrl = item.creativeVideoUrl || null
    const previewUrl = item.creativePreviewUrl || null
    const type = item.creativeType === 'video' || videoUrl ? 'video' : (imageUrl || thumbnailUrl ? 'image' : null)

    if (!type || (!thumbnailUrl && !imageUrl && !videoUrl && !previewUrl)) {
      return null
    }

    return {
      name: item.name || 'Anuncio',
      type,
      thumbnailUrl,
      imageUrl,
      videoUrl,
      previewUrl
    }
  }, [])

  const renderCreativePreview = React.useCallback((item: any) => {
    const media = getCreativePreviewData(item)

    if (!media) {
      return null
    }

    return (
      <button
        type="button"
        className={styles.creativePreviewButton}
        onClick={(event) => {
          event.stopPropagation()
          setSelectedCreative(media)
        }}
        aria-label={`Ver preview de ${media.name}`}
        title={`Ver preview de ${media.name}`}
      >
        {media.thumbnailUrl ? (
          <img
            src={media.thumbnailUrl}
            alt=""
            className={styles.creativePreviewImage}
            loading="lazy"
          />
        ) : (
          <ImageIcon size={18} className={styles.creativePreviewIcon} />
        )}
        {media.type === 'video' && (
          <span className={styles.creativePlayBadge} aria-hidden="true">
            <PlayCircle size={18} />
          </span>
        )}
      </button>
    )
  }, [getCreativePreviewData])

  const winnersNameColumn = React.useMemo((): Column<any> => ({
    key: 'name',
    header: winnersCategory === 'campaigns' ? 'Campaña' : winnersCategory === 'adsets' ? 'Conjunto de anuncios' : 'Anuncio',
    fixed: true,
    visible: true,
    render: (value: string, item: any) => (
      <div className={styles.winnerNameCell}>
        <div className={styles.winnerNameRow}>
          {item.platform && (
            <Icon
              name={item.platform.toLowerCase()}
              size={16}
              className={styles.campaignIcon}
            />
          )}
          {item.level === 'ad' && renderCreativePreview(item)}
          <strong className={styles.winnerAdName}>{value}</strong>
        </div>
        {item.level === 'adset' && item.campaignName && (
          <div className={styles.winnerBreadcrumb}>
            <span>{item.campaignName}</span>
          </div>
        )}
        {item.level === 'ad' && (
          <div className={styles.winnerBreadcrumb}>
            <span>{item.campaignName}</span>
            <ChevronRight size={12} />
            <span>{item.adSetName}</span>
          </div>
        )}
      </div>
    ),
    sortable: true,
    width: '28%'
  }), [renderCreativePreview, winnersCategory])

  const winnersColumns: Column<any>[] = React.useMemo(() => [
    {
      key: 'rank',
      header: '#',
      visible: true,
      render: (value: number) => (
        <span className={styles.winnerRank}>{value}</span>
      ),
      sortable: true,
      width: '60px'
    },
    winnersNameColumn,
    {
      key: 'revenue',
      header: 'Ingresos',
      visible: true,
      render: (value: number) => formatCurrency(value || 0),
      sortable: true,
      width: '11%'
    },
    {
      key: 'sales',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>{labels.customers}</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Nuevos)</div>
        </div>
      ),
      visible: true,
      render: (value: number, item: any) => {
        const hasSales = (value || 0) > 0
        return (
          <span
            className={hasSales ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasSales) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'sales')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '9%'
    },
    {
      key: 'appointments',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>Citas</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
        </div>
      ),
      visible: true,
      render: (value: number, item: any) => {
        const hasAppointments = (value || 0) > 0
        return (
          <span
            className={hasAppointments ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasAppointments) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'appointments')
              }
            }}
          >
            {(value || 0).toLocaleString()}
          </span>
        )
      },
      sortable: true,
      width: '9%'
    },
    {
      key: 'leads',
      header: labels.leads,
      visible: true,
      render: (value: number, item: any) => {
        const hasLeads = (value || 0) > 0
        return (
          <span
            className={hasLeads ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasLeads) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'interesados')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '9%'
    },
    {
      key: 'spend',
      header: 'Inversión',
      visible: true,
      render: (value: number) => formatCurrency(value || 0),
      sortable: true,
      width: '11%'
    },
    {
      key: 'roas',
      header: 'ROAS',
      visible: true,
      render: (_value: number, item: any) => {
        const roasValue = item.spend > 0 ? (item.revenue || 0) / item.spend : 0
        return (
          <span className={roasValue >= 3 ? styles.goodRoas : styles.lowRoas}>
            {formatRoas(roasValue)}
          </span>
        )
      },
      sortable: true,
      width: '9%'
    }
  ], [labels, handleOpenContactsModal, winnersNameColumn])

  // Preparar datos planos para la tabla
  const getFlattenedData = () => {
    const flatData: any[] = []

    if (!campaigns || campaigns.length === 0) {
      return flatData
    }

    campaigns.forEach(campaign => {
      // Convertir IDs a strings para consistencia
      const campaignId = String(campaign.id)
      const adSetsData = campaign.adsets || []
      const isExpanded = expandedCampaigns.has(campaignId)

      // Agregar campaña (si está expandida, mostrar placeholder)
      flatData.push({
        ...campaign,
        id: campaignId, // Asegurar que el ID sea string
        level: 'campaign',
        hasChildren: adSetsData.length > 0,
        isExpanded: isExpanded,
        showPlaceholder: isExpanded && adSetsData.length > 0
      })

      // Si la campaña está expandida, agregar AdSets
      if (isExpanded && adSetsData.length > 0) {
        adSetsData.forEach((adSet: any) => {
          const adSetId = String(adSet.id)
          const adSetExpanded = expandedAdSets.has(adSetId)
          const adsData = adSet.ads || []

          // Agregar AdSet (si está expandido, mostrar placeholder)
          flatData.push({
            ...adSet,
            id: adSetId, // Asegurar que el ID sea string
            level: 'adset',
            campaignId: campaignId,
            hasChildren: adsData.length > 0,
            isExpanded: adSetExpanded,
            showPlaceholder: adSetExpanded && adsData.length > 0
          })

          // Si el AdSet está expandido, agregar Ads
          if (adSetExpanded && adsData.length > 0) {
            adsData.forEach((ad: any) => {
              flatData.push({
                ...ad,
                id: String(ad.id), // Asegurar que el ID sea string
                level: 'ad',
                campaignId: campaignId,
                adSetId: adSetId,
                hasChildren: false,
                showPlaceholder: false
              })
            })
          }
        })
      }
    })

    return flatData
  }

  const baseColumns: Column<any>[] = [
    {
      key: 'name',
      header: 'Nombre',
      fixed: true,
      visible: true,
      render: (value, item) => {
        const indentStyle = {
          paddingLeft: item.level === 'adset' ? '40px' : item.level === 'ad' ? '60px' : '20px'
        }

        const handleToggle = (e: React.MouseEvent) => {
          e.stopPropagation()

          if (!item.hasChildren) return

          if (item.level === 'campaign') {
            toggleCampaign(item.id)
          } else if (item.level === 'adset') {
            toggleAdSet(item.id)
          }
        }

        return (
          <div
            className={`${styles.nameCell} ${item.hasChildren ? styles.clickableName : ''}`}
            style={indentStyle}
            onClick={handleToggle}
          >
            {item.hasChildren && (
              <button
                className={styles.expandButton}
                onClick={handleToggle}
                aria-label={item.isExpanded ? 'Colapsar' : 'Expandir'}
              >
                {item.isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
            )}
            <div className={styles.nameContent}>
              {item.level === 'campaign' && item.platform && (
                <Icon
                  name={item.platform.toLowerCase()}
                  size={16}
                  className={styles.campaignIcon}
                />
              )}
              {item.level === 'ad' && renderCreativePreview(item)}
              <strong className={`${styles.nameText} ${styles[item.level]}`}>
                {value}
              </strong>
            </div>
          </div>
        )
      },
      sortable: true,
      width: '30%'
    },
    {
      key: 'roas',
      header: 'Retorno de Inversión',
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const roasValue = value || 0
        return (
          <span className={roasValue >= 3 ? styles.goodRoas : styles.lowRoas}>
            {formatRoas(roasValue)}
          </span>
        )
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'revenue',
      header: 'Ingresos',
      visible: true,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value || 0),
      sortable: true,
      width: '10%'
    },
    {
      key: 'spend',
      header: 'Inversión',
      visible: true,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value),
      sortable: true,
      width: '10%'
    },
    {
      key: 'leads',
      header: labels.leads,
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>

        const hasLeads = (value || 0) > 0

        return (
          <span
            className={hasLeads ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasLeads) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'interesados')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'sales',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>{labels.customers}</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Nuevos)</div>
        </div>
      ),
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>

        const hasSales = (value || 0) > 0

        return (
          <span
            className={hasSales ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasSales) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'sales')
              }
            }}
          >
            {value || 0}
          </span>
        )
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'reach',
      header: 'Alcance',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        (value || 0).toLocaleString(),
      sortable: true,
      width: '8%'
    },
    {
      key: 'clicks',
      header: 'Clicks',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        (value || 0).toLocaleString(),
      sortable: true,
      width: '8%'
    },
    {
      key: 'cpc',
      header: 'Costo por Clic',
      visible: false,
      render: (value, item) => item.showPlaceholder ?
        <span className={styles.placeholderText}>—</span> :
        formatCurrency(value || 0),
      sortable: true,
      width: '8%'
    },
    {
      key: 'visitors',
      header: 'Visitantes',
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const hasVisitors = (value || 0) > 0 && visitorSource === 'tracking' // Solo clickeable si usa tracking
        return (
          <span
            className={hasVisitors ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasVisitors) {
                e.stopPropagation()
                handleOpenVisitorsModal(item)
              }
            }}
          >
            {(value || 0).toLocaleString()}
          </span>
        )
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'cpl',
      header: `Costo por ${labels.lead}`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const cpl = (item.leads || 0) > 0 ? item.spend / item.leads : 0
        return formatCurrency(cpl)
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'cac',
      header: `Costo por ${labels.customer}`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const cac = (item.sales || 0) > 0 ? item.spend / item.sales : 0
        return formatCurrency(cac)
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'cpa',
      header: 'Costo por Cita',
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const cpa = (item.appointments || 0) > 0 ? item.spend / item.appointments : 0
        return formatCurrency(cpa)
      },
      sortable: true,
      width: '8%'
    },
    {
      key: 'appointments',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>Citas</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
        </div>
      ),
      visible: true,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>

        const hasAppointments = (value || 0) > 0

        return (
          <span
            className={hasAppointments ? styles.clickableNumber : ''}
            onClick={(e) => {
              if (hasAppointments) {
                e.stopPropagation()
                handleOpenContactsModal(item, 'appointments')
              }
            }}
          >
            {(value || 0).toLocaleString()}
          </span>
        )
      },
      sortable: true,
      width: '7%'
    },
    {
      key: 'webToLeadsRate',
      header: `Alcance → ${labels.leads} %`,
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const rate = (item.reach || 0) > 0 ? ((item.leads || 0) / item.reach) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    },
    {
      key: 'leadsToApptsRate',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>{`${labels.leads} → Citas %`}</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
        </div>
      ),
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const appointments = item.appointments || 0
        const rate = (item.leads || 0) > 0 ? (appointments / item.leads) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    },
    {
      key: 'apptsToSalesRate',
      header: (
        <div style={{ textAlign: 'center', lineHeight: '1.2' }}>
          <div>{`Citas → ${labels.customers} %`}</div>
          <div style={{ fontSize: '0.75em', opacity: 0.7 }}>(Primera)</div>
        </div>
      ),
      visible: false,
      render: (value, item) => {
        if (item.showPlaceholder) return <span className={styles.placeholderText}>—</span>
        const appointments = item.appointments || 0
        const rate = appointments > 0 ? ((item.sales || 0) / appointments) * 100 : 0
        return <span>{rate.toFixed(1)}%</span>
      },
      sortable: true,
      width: '10%'
    }
  ]

  const columns = analyticsEnabled
    ? baseColumns
    : baseColumns.filter((column) => column.key !== 'visitors')

  const totals = React.useMemo(() => {
    if (campaignSummary) {
      return {
        revenue: campaignSummary.revenue,
        spend: campaignSummary.spend,
        sales: campaignSummary.sales,
        leads: campaignSummary.leads
      }
    }

    return campaigns.reduce((acc, campaign) => ({
      revenue: acc.revenue + (campaign.revenue || 0),
      spend: acc.spend + (campaign.spend || 0),
      sales: acc.sales + (campaign.sales || 0),
      leads: acc.leads + (campaign.leads || 0)
    }), { revenue: 0, spend: 0, sales: 0, leads: 0 })
  }, [campaignSummary, campaigns])

  const avgRoas = React.useMemo(() => {
    if (campaignSummary) {
      return campaignSummary.roas || 0
    }
    return totals.spend > 0 ? totals.revenue / totals.spend : 0
  }, [campaignSummary, totals.revenue, totals.spend])

  // Chart options configuration
  const chartOptions = React.useMemo(() => {
    const options: Array<{ value: ChartView; label: string }> = [
      { value: 'revenue', label: 'Ingresos vs Gastos' },
      ...(analyticsEnabled ? [
        { value: 'visitors', label: `Visitantes vs ${labels.leads}` }
      ] : []),
      { value: 'leads', label: `${labels.leads} vs Citas` },
      { value: 'appointments', label: 'Citas vs Ventas' }
    ]
    return options
  }, [analyticsEnabled, labels.leads])

  useEffect(() => {
    if (!analyticsEnabled && selectedChart === 'visitors') {
      setSelectedChart('revenue')
    }
  }, [analyticsEnabled, selectedChart])

  // Chart configurations based on selected view
  const chartConfigs: Record<ChartView, ChartConfig> = React.useMemo(() => {
    return {
      revenue: {
        title: 'Ingresos vs Gastos de Publicidad',
        subtitle: 'Valor total acumulado de contactos por fecha de creación',
        data: revenueData,
        color: '#10b981',
        color2: '#64748b',
        showLegend: true,
        legendLabels: { label1: 'Ingresos', label2: 'Gastos Publicidad' },
        formatValue: formatChartCurrency,
        formatTooltipValue: formatCurrency,
        emptyMessage: 'No hay datos de campañas para este período'
      },
      visitors: {
        title: `Visitantes vs ${labels.leads}`,
        subtitle: 'Comparación de visitantes únicos y contactos registrados',
        data: visitorsData,
        color: '#f59e0b',
        color2: '#3b82f6',
        showLegend: true,
        legendLabels: { label1: 'Visitantes', label2: labels.leads },
        formatValue: formatChartNumber,
        formatTooltipValue: (v: number) => v.toLocaleString('es-MX'),
        emptyMessage: 'No hay datos de visitantes para este período'
      },
      leads: {
        title: `${labels.leads} vs Citas`,
        subtitle: 'Comparación de contactos registrados y primeras citas agendadas',
        data: leadsData,
        color: '#3b82f6',
        color2: '#8b5cf6',
        showLegend: true,
        legendLabels: { label1: labels.leads, label2: 'Citas' },
        formatValue: formatChartNumber,
        formatTooltipValue: (v: number) => v.toLocaleString('es-MX'),
        emptyMessage: 'No hay datos de leads para este período'
      },
      appointments: {
        title: 'Citas vs Ventas',
        subtitle: 'Comparación de primeras citas agendadas y conversiones a venta',
        data: appointmentsData,
        color: '#8b5cf6',
        color2: '#10b981',
        showLegend: true,
        legendLabels: { label1: 'Citas', label2: 'Ventas' },
        formatValue: formatChartNumber,
        formatTooltipValue: (v: number) => v.toLocaleString('es-MX'),
        emptyMessage: 'No hay datos de citas para este período'
      }
    }
  }, [revenueData, leadsData, appointmentsData, visitorsData, labels])

  const selectedConfig = chartConfigs[selectedChart]

  const handleChartChange = (value: string) => {
    if (chartOptions.some(option => option.value === value)) {
      setSelectedChart(value as ChartView)
    }
  }

  const calculateDelta = React.useCallback((current: number, previous: number) => {
    if (previous === 0) {
      return current > 0 ? 100 : 0
    }
    const delta = ((current - previous) / Math.abs(previous)) * 100
    return Number.isFinite(delta) ? delta : 0
  }, [])

  const campaignDeltas = React.useMemo(() => {
    if (!campaignSummary) {
      return {
        revenue: 0,
        spend: 0,
        roas: 0,
        sales: 0,
        leads: 0
      }
    }

    return {
      revenue: calculateDelta(campaignSummary.revenue, campaignSummary.revenuePrev),
      spend: calculateDelta(campaignSummary.spend, campaignSummary.spendPrev),
      roas: calculateDelta(campaignSummary.roas || 0, campaignSummary.roasPrev || 0),
      sales: calculateDelta(campaignSummary.sales, campaignSummary.salesPrev),
      leads: calculateDelta(campaignSummary.leads, campaignSummary.leadsPrev)
    }
  }, [campaignSummary, calculateDelta])

  if (loading && campaigns.length === 0) {
    return <Loading message="Cargando campañas..." />
  }

  return (
    <PageContainer>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <div>
            <h1 className={styles.pageTitle}>Publicidad</h1>
          </div>
          <div className={styles.datePickerWrapper}>
            <DateRangePicker
              startDate={formatDateToISO(dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start))}
              endDate={formatDateToISO(dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end))}
              onChange={(start, end) => setDateRange({
                start: parseLocalDateString(start),
                end: parseLocalDateString(end),
                preset: 'custom' as const
              })}
            />

            <button
              type="button"
              className={styles.viewToggleButton}
              onClick={() => setViewMode(viewMode === 'campaigns' ? 'winners' : 'campaigns')}
              aria-pressed={viewMode === 'winners'}
            >
              <Trophy size={16} />
              {viewMode === 'campaigns' ? 'Ver Ganadores' : 'Ver Campañas'}
            </button>

            {/* Timezone Discrepancy Warning - Minimized version */}
            {!timezoneInfo.isLoading && timezoneInfo.hasDiscrepancy && timezoneWarningDismissed && (
              <button
                className={styles.timezoneWarningMinimized}
                onClick={() => setTimezoneWarningDismissed(false)}
                title="Click para ver detalles"
              >
                ⚠️ Zona horaria diferente
              </button>
            )}
          </div>
        </div>

        {/* Timezone Discrepancy Warning - Full version */}
        {!timezoneInfo.isLoading && timezoneInfo.hasDiscrepancy && !timezoneWarningDismissed && (
          <div className={styles.timezoneWarning}>
            <div className={styles.warningIcon}>⚠️</div>
            <div className={styles.warningContent}>
              <div className={styles.warningTitle}>Zona horaria diferente detectada</div>
              <div className={styles.warningText}>
                Tu cuenta de Meta está en <strong>{timezoneInfo.metaTimezoneName}</strong> (UTC{timezoneInfo.metaTimezoneOffset! >= 0 ? '+' : ''}{timezoneInfo.metaTimezoneOffset}h),
                pero tu app usa <strong>{timezoneInfo.highLevelTimezoneName}</strong> (UTC{timezoneInfo.highLevelTimezoneOffset! >= 0 ? '+' : ''}{timezoneInfo.highLevelTimezoneOffset}h).
                Hay una diferencia de <strong>{Math.round(timezoneInfo.discrepancyHours)} horas</strong>.
                Las fechas de las campañas pueden verse diferentes a lo esperado.
              </div>
            </div>
            <button
              className={styles.dismissButton}
              onClick={() => setTimezoneWarningDismissed(true)}
              aria-label="Omitir aviso"
            >
              Omitir
            </button>
          </div>
        )}

        {/* Sync Status Banner - Rediseñado */}
        {syncStatus && syncStatus.running && (
          <div className={styles.syncBanner}>
            <div className={styles.syncHeader}>
              <div className={styles.syncIconWrapper}>
                <RefreshCw size={20} className={styles.syncIcon} />
              </div>
              <div className={styles.syncTextWrapper}>
                <div className={styles.syncTitle}>Sincronizando campañas</div>
                <div className={styles.syncSubtitle}>
                  {syncStatus.currentMonth ? `Procesando ${syncStatus.currentMonth}` : (syncStatus.message || 'Preparando sincronización...')}
                </div>
              </div>
            </div>

            {syncStatus.total > 0 ? (
              <div className={styles.syncProgressSection}>
                <div className={styles.syncProgressBar}>
                  <div
                    className={styles.syncProgressFill}
                    style={{ width: `${Math.round((syncStatus.processed / syncStatus.total) * 100)}%` }}
                  />
                </div>
                <div className={styles.syncStats}>
                  <span className={styles.syncStat}>
                    {syncStatus.processed} / {syncStatus.total} períodos
                  </span>
                  {syncStatus.totalRecords > 0 && (
                    <span className={styles.syncStat}>
                      {syncStatus.totalRecords.toLocaleString()} registros
                    </span>
                  )}
                  <span className={styles.syncPercentage}>
                    {Math.round((syncStatus.processed / syncStatus.total) * 100)}%
                  </span>
                </div>
              </div>
            ) : (
              <div className={styles.syncProgressSection}>
                <div className={styles.syncSubtitle} style={{ textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: '13px' }}>
                  {syncStatus.message || 'Iniciando...'}
                </div>
              </div>
            )}
          </div>
        )}

        <div className={styles.kpiRow}>
          <KpiCard
            title="Ingresos"
            value={formatCurrency(totals.revenue)}
            delta={campaignDeltas.revenue}
            deltaLabel="vs periodo anterior"
            icon={<DollarSign size={20} />}
          />
          <KpiCard
            title="Inversión Total"
            value={formatCurrency(totals.spend)}
            delta={campaignDeltas.spend}
            deltaLabel="vs periodo anterior"
            icon={<Megaphone size={20} />}
          />
          <KpiCard
            title="Retorno de Inversión"
            value={formatRoas(avgRoas)}
            delta={campaignDeltas.roas}
            deltaLabel="vs periodo anterior"
            icon={<TrendingUp size={20} />}
          />
          <KpiCard
            title={`Nuevos ${labels.customers}`}
            value={totals.sales.toString()}
            delta={campaignDeltas.sales}
            deltaLabel="vs periodo anterior"
            icon={<Target size={20} />}
          />
          <KpiCard
            title={labels.leads}
            value={totals.leads.toString()}
            delta={campaignDeltas.leads}
            deltaLabel="vs periodo anterior"
            icon={<Users size={20} />}
          />
        </div>

        {viewMode === 'campaigns' && (
          <Card variant="glass" className={styles.chartCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
              <div>
                <h2 className={styles.chartTitle}>{selectedConfig.title}</h2>
                <p style={{ fontSize: '14px', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                  {selectedConfig.subtitle}
                </p>
              </div>
              <ViewSelector
                options={chartOptions}
                value={selectedChart}
                onChange={handleChartChange}
              />
            </div>
            <div style={{ height: 300 }}>
              {selectedConfig.data && selectedConfig.data.length > 0 ? (
                <AreaChart
                  data={selectedConfig.data}
                  height={300}
                  showGrid={true}
                  color={selectedConfig.color}
                  color2={selectedConfig.color2}
                  formatValue={selectedConfig.formatValue}
                  formatTooltipValue={selectedConfig.formatTooltipValue || selectedConfig.formatValue}
                  showLegend={selectedConfig.showLegend}
                  legendLabels={selectedConfig.legendLabels}
                />
              ) : (
                <div className="flex h-full items-center justify-center rounded-xl border border-[rgba(148,163,184,0.18)] bg-[color-mix(in_srgb,var(--color-background-glass) 82%, transparent)] text-sm text-[var(--color-text-tertiary)]">
                  <div className="text-center">
                    <p>{selectedConfig.emptyMessage}</p>
                    <p className="text-xs mt-2 opacity-75">Sincroniza tus campañas de Meta Ads para ver el gráfico</p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

      {viewMode === 'winners' ? (
        <>
          <div className={styles.winnersTabsRow}>
            <TabList
              tabs={[
                { value: 'campaigns', label: 'Campañas' },
                { value: 'adsets', label: 'Conjuntos de anuncios' },
                { value: 'ads', label: 'Anuncios' }
              ]}
              activeTab={winnersCategory}
              onTabChange={(value) => setWinnersCategory(value as 'campaigns' | 'adsets' | 'ads')}
            />
          </div>
          <Card padding="none">
            <Table
              key={`winners_table_${winnersCategory}`}
              initialColumns={winnersColumns}
              data={winnersActiveData}
              keyExtractor={(item) => `winner_${winnersCategory}_${item.id}`}
              emptyMessage="Aún no hay ganadores para este período"
              loading={loading}
              searchable={true}
              searchPlaceholder={`Buscar ${winnersCategory === 'campaigns' ? 'campañas' : winnersCategory === 'adsets' ? 'conjuntos' : 'anuncios'}...`}
              paginated={true}
              pageSize={50}
              tableId={`campaigns_winners_${winnersCategory}`}
            />
          </Card>
        </>
      ) : (
        <Card padding="none">
          <Table
            key="campaigns_table"
            initialColumns={columns}
            data={getFlattenedData()}
            keyExtractor={(item) => `${item.level}_${item.id}_${item.campaignId || ''}_${item.adSetId || ''}`}
            emptyMessage="No hay campañas disponibles"
            loading={loading}
            searchable={true}
            searchPlaceholder="Buscar campañas..."
            paginated={true}
            pageSize={50}
            tableId="campaigns"
          />
        </Card>
      )}

      {/* Modal de contactos */}
      <ContactDetailsModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false)
          setSelectedModalItem(null)
        }}
        title={modalTitle}
        subtitle={modalContacts.length === 0
          ? 'Sin datos para este periodo'
          : `${modalContacts.length} ${modalType === 'interesados' ? labels.leads.toLowerCase() : labels.customers.toLowerCase()}`}
        data={modalContacts}
        loading={modalLoading}
        type={modalType}
      />

      {/* Modal de visitantes */}
      {analyticsEnabled && (
        <VisitorDetailsModal
          isOpen={isVisitorsModalOpen}
          onClose={() => setIsVisitorsModalOpen(false)}
          title="Visitantes"
          subtitle={visitorsModalTitle}
          data={modalVisitors}
          loading={visitorsModalLoading}
        />
      )}

      {selectedCreative && (
        <div
          className={styles.creativeModalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview de ${selectedCreative.name}`}
          onClick={() => setSelectedCreative(null)}
        >
          <div className={styles.creativeModal} onClick={(event) => event.stopPropagation()}>
            <div className={styles.creativeModalHeader}>
              <div>
                <div className={styles.creativeModalTitle}>{selectedCreative.name}</div>
                <div className={styles.creativeModalMeta}>
                  {selectedCreative.type === 'video' ? 'Video' : 'Imagen'}
                </div>
              </div>
              <button
                type="button"
                className={styles.creativeModalClose}
                onClick={() => setSelectedCreative(null)}
                aria-label="Cerrar preview"
              >
                <X size={18} />
              </button>
            </div>

            <div className={styles.creativeModalBody}>
              {selectedCreative.type === 'video' && selectedCreative.videoUrl ? (
                <video
                  className={styles.creativeModalVideo}
                  src={selectedCreative.videoUrl}
                  poster={selectedCreative.thumbnailUrl || undefined}
                  controls
                  autoPlay
                  playsInline
                />
              ) : selectedCreative.type === 'video' && selectedCreative.previewUrl ? (
                <iframe
                  className={styles.creativeModalFrame}
                  src={selectedCreative.previewUrl}
                  title={`Preview de ${selectedCreative.name}`}
                  allow="autoplay; encrypted-media; picture-in-picture"
                />
              ) : (
                <img
                  src={selectedCreative.imageUrl || selectedCreative.thumbnailUrl || ''}
                  alt={selectedCreative.name}
                  className={styles.creativeModalImage}
                />
              )}
            </div>

            {selectedCreative.previewUrl && (
              <div className={styles.creativeModalFooter}>
                <a
                  className={styles.creativeMetaLink}
                  href={selectedCreative.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} />
                  Abrir en Meta
                </a>
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </PageContainer>
  )
}
