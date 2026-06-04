import React, { useEffect, useMemo, useState } from 'react'
import { TrafficSourcesChart } from '../TrafficSourcesChart/TrafficSourcesChart'
import { ViewSelector } from '../ViewSelector/ViewSelector'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useAppConfig, useIsRenderDomain } from '@/hooks'
import { dashboardService, type OriginDistributionData, type SourceDatum } from '@/services/dashboardService'
import { trackingService } from '@/services/trackingService'
import { whatsappWebService } from '@/services/whatsappWebService'
import { formatDateToISO } from '@/utils/format'

type OriginCategory = 'traffic' | 'messages'
type TrafficDimension = 'sources' | 'platforms' | 'devices' | 'placements' | 'browsers' | 'os'

const EMPTY: OriginDistributionData = {
  traffic: { sources: [], platforms: [], devices: [], placements: [], browsers: [], os: [] },
  leads: [],
  appointments: [],
  conversions: []
}

const DIMENSION_OPTIONS: { value: TrafficDimension; label: string }[] = [
  { value: 'sources', label: 'Fuentes' },
  { value: 'platforms', label: 'Plataformas' },
  { value: 'devices', label: 'Dispositivos' },
  { value: 'placements', label: 'Ubicaciones' },
  { value: 'browsers', label: 'Navegadores' },
  { value: 'os', label: 'Sistemas' }
]

const DIMENSION_INSIGHTS: Record<TrafficDimension, { primary: string; suffix: string }> = {
  sources: { primary: 'Mayor fuente', suffix: 'fuentes activas' },
  platforms: { primary: 'Mayor plataforma', suffix: 'plataformas activas' },
  devices: { primary: 'Mayor dispositivo', suffix: 'dispositivos activos' },
  placements: { primary: 'Mayor ubicación', suffix: 'ubicaciones activas' },
  browsers: { primary: 'Mayor navegador', suffix: 'navegadores activos' },
  os: { primary: 'Mayor sistema', suffix: 'sistemas activos' }
}

const parseAnalyticsFlag = (value: unknown) => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  if (typeof value === 'number') return value === 1
  return Boolean(value)
}

/**
 * Dona unificada de "Origen" usada igual en Dashboard y Analíticas.
 * El título muestra sólo las vistas que tienen integración conectada:
 * Tráfico cuando el rastreo web está activo y Origen de mensajes cuando WhatsApp está conectado.
 */
export const OriginDistributionCard: React.FC = () => {
  const { dateRange } = useDateRange()
  const isRenderDomain = useIsRenderDomain()
  const [showAnalyticsConfig] = useAppConfig<string | number | boolean>('show_analytics', '1')
  const [category, setCategory] = useState<OriginCategory>('traffic')
  const [dimension, setDimension] = useState<TrafficDimension>('sources')
  const [data, setData] = useState<OriginDistributionData>(EMPTY)
  const [messageSources, setMessageSources] = useState<SourceDatum[]>([])
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(false)
  const [webConnectionLoading, setWebConnectionLoading] = useState(true)
  const [whatsAppConnected, setWhatsAppConnected] = useState(false)
  const [whatsAppConnectionLoading, setWhatsAppConnectionLoading] = useState(true)

  const analyticsPreferenceEnabled = !isRenderDomain && parseAnalyticsFlag(showAnalyticsConfig)
  const webConnected = analyticsPreferenceEnabled && webTrackingConfigured

  useEffect(() => {
    let active = true
    setLoading(true)

    const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
    const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)

    dashboardService.getOriginDistribution({ start, end })
      .then((result) => { if (active) setData(result) })
      .finally(() => { if (active) setLoading(false) })

    return () => { active = false }
  }, [dateRange.start, dateRange.end])

  useEffect(() => {
    if (!analyticsPreferenceEnabled) {
      setWebTrackingConfigured(false)
      setWebConnectionLoading(false)
      return
    }

    let active = true
    setWebConnectionLoading(true)

    trackingService.getTrackingConfig()
      .then((config) => {
        if (active) setWebTrackingConfigured(Boolean(config?.isConfigured))
      })
      .catch(() => {
        if (active) setWebTrackingConfigured(false)
      })
      .finally(() => {
        if (active) setWebConnectionLoading(false)
      })

    return () => { active = false }
  }, [analyticsPreferenceEnabled])

  useEffect(() => {
    let active = true
    setWhatsAppConnectionLoading(true)

    whatsappWebService.getStatus()
      .then((status) => {
        if (active) setWhatsAppConnected(status?.session?.status === 'connected')
      })
      .catch(() => {
        if (active) setWhatsAppConnected(false)
      })
      .finally(() => {
        if (active) setWhatsAppConnectionLoading(false)
      })

    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!whatsAppConnected) {
      setMessageSources([])
      setMessagesLoading(false)
      return
    }

    let active = true
    setMessagesLoading(true)

    const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
    const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)

    whatsappWebService.getAnalytics({
      start: formatDateToISO(start),
      end: formatDateToISO(end),
      groupBy: 'day'
    })
      .then((result) => {
        if (active) setMessageSources(result?.sources || [])
      })
      .catch(() => {
        if (active) setMessageSources([])
      })
      .finally(() => {
        if (active) setMessagesLoading(false)
      })

    return () => { active = false }
  }, [dateRange.start, dateRange.end, whatsAppConnected])

  const categoryOptions = useMemo<{ value: OriginCategory; label: string }[]>(() => {
    const options: { value: OriginCategory; label: string }[] = []

    if (webConnected) options.push({ value: 'traffic', label: 'Tráfico' })
    if (whatsAppConnected) options.push({ value: 'messages', label: 'Origen de mensajes' })

    return options
  }, [webConnected, whatsAppConnected])

  const activeCategory = useMemo<OriginCategory>(() => {
    if (categoryOptions.some(option => option.value === category)) return category
    return categoryOptions[0]?.value || 'traffic'
  }, [category, categoryOptions])

  useEffect(() => {
    if (!categoryOptions.length) return
    if (categoryOptions.some(option => option.value === category)) return

    setCategory(categoryOptions[0].value)
  }, [category, categoryOptions])

  const meta = activeCategory === 'traffic' && webConnected
    ? {
      data: data.traffic[dimension],
      totalLabel: 'visitantes únicos',
      itemLabel: 'Visitantes',
      emptyText: 'Sin datos de tráfico',
      emptySubtext: 'Los datos aparecerán cuando haya visitas',
      insightPrimaryLabel: DIMENSION_INSIGHTS[dimension].primary,
      insightCountSuffix: DIMENSION_INSIGHTS[dimension].suffix,
      title: 'Tráfico'
    }
    : activeCategory === 'messages' && whatsAppConnected
      ? {
      data: messageSources,
      totalLabel: 'conversaciones',
      itemLabel: 'Conversaciones',
      emptyText: 'Sin origen de mensajes',
      emptySubtext: 'Los datos aparecerán cuando entren mensajes',
      insightPrimaryLabel: 'Mayor origen',
      insightCountSuffix: 'orígenes activos',
      title: 'Origen de mensajes'
    }
      : {
      data: [],
      totalLabel: 'eventos',
      itemLabel: 'Eventos',
      emptyText: 'Sin datos',
      emptySubtext: '',
      insightPrimaryLabel: 'Mayor origen',
      insightCountSuffix: 'orígenes activos',
      title: 'Origen'
    }

  const connectionsLoading = webConnectionLoading || whatsAppConnectionLoading
  const activeLoading = connectionsLoading || (activeCategory === 'messages' ? messagesLoading : loading)

  return (
    <TrafficSourcesChart
      data={meta.data}
      loading={activeLoading}
      title={meta.title}
      totalLabel={meta.totalLabel}
      itemLabel={meta.itemLabel}
      emptyText={meta.emptyText}
      emptySubtext={meta.emptySubtext}
      insightPrimaryLabel={meta.insightPrimaryLabel}
      insightCountLabel="Variedad"
      insightCountSuffix={meta.insightCountSuffix}
      showZeroStateAsChart
      titleSlot={categoryOptions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <ViewSelector
            variant="title"
            options={categoryOptions}
            value={activeCategory}
            onChange={(value) => setCategory(value as OriginCategory)}
          />
          {activeCategory === 'traffic' && webConnected && (
            <ViewSelector
              options={DIMENSION_OPTIONS}
              value={dimension}
              onChange={(value) => setDimension(value as TrafficDimension)}
            />
          )}
        </div>
      ) : undefined}
    />
  )
}
