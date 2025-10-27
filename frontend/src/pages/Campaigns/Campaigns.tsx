import React, { useState, useEffect, useCallback } from 'react'
import { KpiCard, Card, DateRangePicker, Table, Icon, ContactDetailsModal, VisitorDetailsModal, PageContainer, ViewSelector, AreaChart } from '@/components/common'
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
  Loader2
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { formatCurrency, formatRoas, formatChartDate, formatDate, formatDateToISO, formatEndDateToISO, parseLocalDateString, formatChartCurrency, formatChartNumber } from '@/utils/format'
import { campaignsService, type CampaignContact } from '@/services/campaignsService'
import { reportsService, type CampaignsReport } from '@/services/reportsService'
import { useAppConfig, useMetaTimezone, useIsRenderDomain } from '@/hooks'
import styles from './Campaigns.module.css'

interface AdData {
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

  const [campaigns, setCampaigns] = useState<CampaignData[]>([])
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState<any>(null)
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set())
  const [expandedAdSets, setExpandedAdSets] = useState<Set<string>>(new Set())
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

  /**
   * Agrupa datos de gráfico por semana o mes según el rango
   * @param data Array de datos con propiedades dinámicas
   * @param groupBy 'day' | 'week' | 'month'
   * @returns Datos agrupados
   */
  const groupChartData = (data: any[], groupBy: 'day' | 'week' | 'month') => {
    if (groupBy === 'day' || !data.length) return data

    const grouped = new Map<string, any>()

    data.forEach((item, idx) => {
      // Validar que tenemos un label y que se puede convertir a fecha
      if (!item.label) return

      // Intentar parsear la fecha de manera más robusta
      let date: Date
      try {
        // Si el label ya es una fecha ISO (YYYY-MM-DD), parsearlo directamente
        if (typeof item.label === 'string' && item.label.match(/^\d{4}-\d{2}-\d{2}/)) {
          const [year, month, day] = item.label.split('-').map(Number)
          date = new Date(year, month - 1, day)
        } else {
          date = new Date(item.label)
        }

        // Verificar que la fecha es válida
        if (isNaN(date.getTime())) {
          return
        }
      } catch (error) {
        return
      }

      let key: string

      if (groupBy === 'week') {
        // Obtener el lunes de la semana
        const monday = new Date(date)
        const day = monday.getDay()
        const diff = monday.getDate() - day + (day === 0 ? -6 : 1)
        monday.setDate(diff)
        key = formatDateToISO(monday)
      } else {
        // Agrupar por mes
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
      }

      const existing = grouped.get(key)
      if (existing) {
        // Sumar todos los campos numéricos excepto 'label'
        Object.keys(item).forEach(field => {
          if (field !== 'label' && typeof item[field] === 'number' && !isNaN(item[field])) {
            const currentVal = existing[field] || 0
            const newVal = item[field] || 0
            existing[field] = Number(currentVal) + Number(newVal)
          }
        })
      } else {
        // Copiar todo el objeto pero con el label actualizado, asegurando valores numéricos
        const cleanedItem: any = { label: key }
        Object.keys(item).forEach(field => {
          if (field !== 'label') {
            const val = item[field]
            cleanedItem[field] = (typeof val === 'number' && !isNaN(val)) ? val : 0
          }
        })
        grouped.set(key, cleanedItem)
      }
    })

    // Convertir de vuelta a array y ordenar
    return Array.from(grouped.values()).sort((a, b) => a.label.localeCompare(b.label))
  }

  /**
   * Determina el tipo de agrupación basado en el rango de días
   * Ajustado para mejor visualización de datos
   */
  const getGroupingType = (rangeInDays: number): 'day' | 'week' | 'month' => {
    if (rangeInDays <= 31) return 'day'      // Hasta 31 días: vista diaria
    if (rangeInDays <= 90) return 'week'     // 32-90 días (~3 meses): vista semanal
    return 'month'                            // Más de 90 días: vista mensual
  }

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
              .catch((error) => {
                console.error('❌ Error fetching visitors:', error)
                return {}
              })
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

      // Determinar tipo de agrupación
      const groupingType = getGroupingType(rangeInDays)

      // Validar que tenemos datos antes de agrupar
      if (!spendData || spendData.length === 0) {
        setRevenueData([])
      } else {
        // Agrupar datos según el rango
        const groupedSpendData = groupChartData(spendData, groupingType)

        // Formatear fechas inteligentemente para el gráfico
        const formattedSpendData = groupedSpendData.map((item: any, index: number) => ({
          ...item,
          // Primero ajustar la fecha con timezone de Meta, luego formatear para el gráfico
          label: formatChartDate(
            timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(item.label) : item.label,
            rangeInDays,
            index > 0 ? (timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(groupedSpendData[index - 1].label) : groupedSpendData[index - 1].label) : undefined
          ),
          // Asegurar que los valores sean números válidos
          value: isNaN(item.value) || item.value === null || item.value === undefined ? 0 : Number(item.value),
          value2: isNaN(item.value2) || item.value2 === null || item.value2 === undefined ? 0 : Number(item.value2)
        })).filter(item => item.label && item.label !== '') // Filtrar items sin label válido

        // Set data for revenue chart (default)
        setRevenueData(formattedSpendData)
      }

      // Fetch funnel metrics
      const funnelMetricsRaw = await campaignsService.getFunnelMetrics(startDate, endDate)

      // Validar que tenemos datos del funnel
      if (!funnelMetricsRaw || funnelMetricsRaw.length === 0) {
        setLeadsData([])
        setAppointmentsData([])
        setVisitorsData([])
      } else {
        // Process funnel metrics into the format needed for each chart
        // Preparar datos de leads con agrupación
        const leadsChartData = funnelMetricsRaw.map((item: any) => ({
          label: item.label,
          value: item.leads || 0,
          value2: item.appointments || 0
        }))
        const groupedLeadsData = groupChartData(leadsChartData, groupingType)
        const formattedLeadsData = groupedLeadsData.map((item: any, index: number) => ({
          label: formatChartDate(
            timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(item.label) : item.label,
            rangeInDays,
            index > 0 ? (timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(groupedLeadsData[index - 1].label) : groupedLeadsData[index - 1].label) : undefined
          ),
          value: isNaN(item.value) || item.value === null || item.value === undefined ? 0 : Number(item.value),
          value2: isNaN(item.value2) || item.value2 === null || item.value2 === undefined ? 0 : Number(item.value2)
        })).filter(item => item.label && item.label !== '')

        // Preparar datos de citas con agrupación
        const appointmentsChartData = funnelMetricsRaw.map((item: any) => ({
          label: item.label,
          value: item.appointments || 0,
          value2: item.sales || 0
        }))
        const groupedAppointmentsData = groupChartData(appointmentsChartData, groupingType)
        const formattedAppointmentsData = groupedAppointmentsData.map((item: any, index: number) => ({
          label: formatChartDate(
            timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(item.label) : item.label,
            rangeInDays,
            index > 0 ? (timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(groupedAppointmentsData[index - 1].label) : groupedAppointmentsData[index - 1].label) : undefined
          ),
          value: isNaN(item.value) || item.value === null || item.value === undefined ? 0 : Number(item.value),
          value2: isNaN(item.value2) || item.value2 === null || item.value2 === undefined ? 0 : Number(item.value2)
        })).filter(item => item.label && item.label !== '')

        if (analyticsEnabled) {
          // Preparar datos de visitantes con agrupación
          const visitorsChartData = funnelMetricsRaw.map((item: any) => ({
            label: item.label,
            value: item.visitors || 0,
            value2: item.leads || 0
          }))
          const groupedVisitorsData = groupChartData(visitorsChartData, groupingType)
          const formattedVisitorsData = groupedVisitorsData.map((item: any, index: number) => ({
            label: formatChartDate(
              timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(item.label) : item.label,
              rangeInDays,
              index > 0 ? (timezoneInfo.adjustMetaDateToLocal ? timezoneInfo.adjustMetaDateToLocal(groupedVisitorsData[index - 1].label) : groupedVisitorsData[index - 1].label) : undefined
            ),
            value: isNaN(item.value) || item.value === null || item.value === undefined ? 0 : Number(item.value),
            value2: isNaN(item.value2) || item.value2 === null || item.value2 === undefined ? 0 : Number(item.value2)
          })).filter(item => item.label && item.label !== '')
          setVisitorsData(formattedVisitorsData || [])
        } else {
          setVisitorsData([])
        }

        setLeadsData(formattedLeadsData || [])
        setAppointmentsData(formattedAppointmentsData || [])
      }
    } catch (error) {
      console.error('❌ Error en fetchCampaigns:', error)
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
  }, [analyticsEnabled, dateRange.end, dateRange.start, visitorSource, timezoneInfo])

  // Fetch campaigns on mount and when date range or visitor source changes
  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

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
    } catch (error) {
      console.error('Error cargando visitantes:', error)
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
              <strong className={`${styles.nameText} ${styles[item.level]}`}>
                {value}
              </strong>
            </div>
          </div>
        )
      },
      sortable: false,
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
          </div>
        </div>

        {/* Timezone Discrepancy Warning */}
        {!timezoneInfo.isLoading && timezoneInfo.hasDiscrepancy && (
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
                data={selectedConfig.data.filter(item =>
                  item &&
                  item.label &&
                  item.label !== '' &&
                  (typeof item.value === 'number' && !isNaN(item.value)) ||
                  (typeof item.value2 === 'number' && !isNaN(item.value2))
                ).map(item => ({
                  label: item.label,
                  value: typeof item.value === 'number' && !isNaN(item.value) ? item.value : 0,
                  value2: typeof item.value2 === 'number' && !isNaN(item.value2) ? item.value2 : undefined
                }))}
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
      </div>
    </PageContainer>
  )
}
