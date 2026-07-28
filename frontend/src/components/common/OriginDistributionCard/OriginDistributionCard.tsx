import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { TrafficSourcesChart } from '../TrafficSourcesChart/TrafficSourcesChart'
import { ViewSelector } from '../ViewSelector/ViewSelector'
import { useDateRange } from '@/contexts/DateRangeContext'
import { dashboardService, type OriginDistributionData } from '@/services/dashboardService'
import {
  getAcquisitionAnalyticsSummary,
  type AcquisitionAnalyticsChannel,
  type AcquisitionAnalyticsDimension,
  type AcquisitionAnalyticsPopulation,
  type AcquisitionAnalyticsSummary,
  type TrackingAnalyticsGroupBy
} from '@/services/analyticsService'
import { trackingService } from '@/services/trackingService'
import { normalizeDateInputToLocalDate } from '@/utils/format'
import { useNotification } from '@/contexts/NotificationContext'
import { Button } from '../Button'
import { Card } from '../Card'

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

const PEOPLE_DIMENSIONS = new Set<TrafficDimension>(['sources', 'platforms'])

interface OriginDistributionCardProps {
  startDate?: string
  endDate?: string
  groupBy?: TrackingAnalyticsGroupBy
  webFilters?: Record<string, string[]>
  hasWebAnalyticsAccess?: boolean
  websiteAvailable?: boolean
  availableMessageChannels?: Record<string, boolean>
}

/**
 * Dona unificada de origen usada igual en Dashboard y Analíticas.
 * Muestra origen web y conversaciones de WhatsApp.
 */
const LegacyOriginDistributionCard: React.FC = () => {
  const { dateRange } = useDateRange()
  const { showToast } = useNotification()
  const [dimension, setDimension] = useState<TrafficDimension>('sources')
  const [data, setData] = useState<OriginDistributionData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(false)
  const [webConnectionLoading, setWebConnectionLoading] = useState(true)

  useEffect(() => {
    // Las dimensiones sólo se comparten dentro del mismo rango. Si cambia la
    // ventana no mostramos como vigente un snapshot que pertenece a otras fechas.
    setData(EMPTY)
    setLoadError(null)
  }, [dateRange.start, dateRange.end])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)

    const start = normalizeDateInputToLocalDate(dateRange.start)
    const end = normalizeDateInputToLocalDate(dateRange.end)

    dashboardService.getOriginDistribution({
      start,
      end,
      dimension,
      includeWhatsapp: PEOPLE_DIMENSIONS.has(dimension),
      includeBreakdowns: false,
      signal: controller.signal
    })
      .then((result) => {
        if (!active) return
        setLoadError(null)
        setData(current => ({
          ...current,
          traffic: {
            ...current.traffic,
            [dimension]: result.traffic[dimension] || []
          }
        }))
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Intenta nuevamente.'
        // Una dimensión fallida no invalida las que ya respondieron. Conservar
        // el último snapshot válido evita que un timeout aislado vacíe la dona.
        setLoadError(message)
        showToast(
          'error',
          'No se pudo cargar la distribución de origen',
          message
        )
      })
      .finally(() => { if (active) setLoading(false) })

    return () => {
      active = false
      controller.abort()
    }
  }, [dateRange.start, dateRange.end, dimension, retryKey, showToast])

  useEffect(() => {
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
  }, [])

  const meta = useMemo(() => {
    const isPeopleDimension = PEOPLE_DIMENSIONS.has(dimension)

    return {
      data: data.traffic[dimension],
      totalLabel: isPeopleDimension ? 'personas únicas' : 'visitantes únicos',
      itemLabel: isPeopleDimension ? 'Personas' : 'Visitantes',
      emptyText: 'Sin datos de origen',
      emptySubtext: 'Los datos aparecerán cuando haya visitas o mensajes de WhatsApp',
      insightPrimaryLabel: DIMENSION_INSIGHTS[dimension].primary,
      insightCountSuffix: DIMENSION_INSIGHTS[dimension].suffix,
      title: 'Origen'
    }
  }, [data.traffic, dimension])

  return (
    <TrafficSourcesChart
      data={meta.data}
      loading={webConnectionLoading || loading}
      title={meta.title}
      totalLabel={meta.totalLabel}
      itemLabel={meta.itemLabel}
      emptyText={meta.emptyText}
      emptySubtext={meta.emptySubtext}
      insightPrimaryLabel={meta.insightPrimaryLabel}
      insightCountLabel="Variedad"
      insightCountSuffix={meta.insightCountSuffix}
      showZeroStateAsChart
      headerAction={loadError ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading}
          title={loadError}
          onClick={() => setRetryKey(current => current + 1)}
        >
          {loading ? 'Reintentando…' : 'Reintentar'}
        </Button>
      ) : undefined}
      titleSlot={webTrackingConfigured ? (
        <ViewSelector
          options={DIMENSION_OPTIONS}
          value={dimension}
          onChange={(value) => setDimension(value as TrafficDimension)}
        />
      ) : undefined}
    />
  )
}

const ACQUISITION_POPULATIONS: Array<{ value: AcquisitionAnalyticsPopulation; label: string }> = [
  { value: 'contacts', label: 'Origen de contactos' },
  { value: 'buyers', label: 'Origen de compradores' },
  { value: 'conversations', label: 'Origen de conversaciones' },
  { value: 'newConversations', label: 'Origen de nuevas conversaciones' },
  { value: 'visitors', label: 'Origen de visitantes web' }
]

const ACQUISITION_DIMENSIONS: Array<{ value: AcquisitionAnalyticsDimension; label: string }> = [
  { value: 'entry', label: 'Tipo de entrada' },
  { value: 'channel', label: 'Canal' },
  { value: 'source', label: 'Fuente' }
]

const CHANNEL_LABELS: Record<AcquisitionAnalyticsChannel, string> = {
  website: 'Sitio web',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
  email: 'Correo'
}

type AcquisitionChannelSelection = 'all' | AcquisitionAnalyticsChannel
const EMPTY_WEB_FILTERS: Record<string, string[]> = {}

const isPopulation = (value: string | null): value is AcquisitionAnalyticsPopulation => (
  ACQUISITION_POPULATIONS.some(option => option.value === value)
)
const isDimension = (value: string | null): value is AcquisitionAnalyticsDimension => (
  ACQUISITION_DIMENSIONS.some(option => option.value === value)
)
const isChannel = (value: string | null): value is AcquisitionChannelSelection => (
  value === 'all' || Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, value || '')
)

const allowedChannelsForPopulation = (population: AcquisitionAnalyticsPopulation) => (
  population === 'visitors'
    ? new Set<AcquisitionAnalyticsChannel>(['website'])
    : population === 'conversations' || population === 'newConversations'
      ? new Set<AcquisitionAnalyticsChannel>(['whatsapp', 'messenger', 'instagram', 'email'])
      : new Set<AcquisitionAnalyticsChannel>(
          Object.keys(CHANNEL_LABELS) as AcquisitionAnalyticsChannel[]
        )
)

const normalizeChannelForPopulation = (
  channel: AcquisitionChannelSelection,
  population: AcquisitionAnalyticsPopulation
): AcquisitionChannelSelection => (
  channel === 'all' || allowedChannelsForPopulation(population).has(channel)
    ? channel
    : 'all'
)

const populationMeta = (population: AcquisitionAnalyticsPopulation) => {
  if (population === 'visitors') {
    return {
      totalLabel: 'visitantes web únicos',
      itemLabel: 'Visitantes',
      emptyText: 'Sin visitantes web',
      emptySubtext: 'No hubo vistas comprobadas en este rango'
    }
  }
  if (population === 'conversations') {
    return {
      totalLabel: 'conversaciones',
      itemLabel: 'Conversaciones',
      emptyText: 'Sin conversaciones',
      emptySubtext: 'No hubo mensajes entrantes en este rango'
    }
  }
  if (population === 'newConversations') {
    return {
      totalLabel: 'nuevas conversaciones',
      itemLabel: 'Conversaciones',
      emptyText: 'Sin conversaciones nuevas',
      emptySubtext: 'Ninguna identidad escribió por primera vez en este rango'
    }
  }
  if (population === 'buyers') {
    return {
      totalLabel: 'compradores únicos',
      itemLabel: 'Compradores',
      emptyText: 'Sin compradores',
      emptySubtext: 'No hubo pagos exitosos de contactos atribuidos en este rango'
    }
  }
  return {
    totalLabel: 'contactos creados',
    itemLabel: 'Contactos',
    emptyText: 'Sin contactos nuevos',
    emptySubtext: 'No se crearon contactos atribuibles en este rango'
  }
}

const AcquisitionOriginDistributionCard: React.FC<Required<Pick<
  OriginDistributionCardProps,
  'startDate' | 'endDate'
>> & Omit<OriginDistributionCardProps, 'startDate' | 'endDate'>> = ({
  startDate,
  endDate,
  groupBy = 'day',
  webFilters = EMPTY_WEB_FILTERS,
  hasWebAnalyticsAccess = true,
  websiteAvailable = true,
  availableMessageChannels = {}
}) => {
  const { showToast } = useNotification()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedPopulation = searchParams.get('originPopulation')
  const population = isPopulation(requestedPopulation) &&
    (requestedPopulation !== 'visitors' || hasWebAnalyticsAccess)
    ? requestedPopulation
    : 'contacts'
  const requestedDimension = searchParams.get('originBreakdown')
  const dimension = isDimension(requestedDimension) ? requestedDimension : 'entry'
  const requestedChannel = searchParams.get('originChannel')
  const requestedValidChannel = isChannel(requestedChannel) ? requestedChannel : 'all'
  const channel = normalizeChannelForPopulation(requestedValidChannel, population)
  const [data, setData] = useState<AcquisitionAnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const scopeRef = useRef('')

  useEffect(() => {
    const populationNeedsNormalization = Boolean(
      requestedPopulation && requestedPopulation !== population
    )
    const channelNeedsNormalization = Boolean(
      requestedChannel && requestedChannel !== channel
    )
    if (!populationNeedsNormalization && !channelNeedsNormalization) return

    const next = new URLSearchParams(searchParams)
    if (populationNeedsNormalization) next.delete('originPopulation')
    if (channelNeedsNormalization) next.delete('originChannel')
    setSearchParams(next, { replace: true })
  }, [
    channel,
    population,
    requestedChannel,
    requestedPopulation,
    searchParams,
    setSearchParams
  ])

  const requestScope = useMemo(() => JSON.stringify({
    startDate,
    endDate,
    groupBy,
    population,
    dimension,
    channel,
    webFilters
  }), [channel, dimension, endDate, groupBy, population, startDate, webFilters])
  const hasCurrentScope = scopeRef.current === requestScope
  const scopedData = hasCurrentScope ? data : null
  const scopedLoadError = hasCurrentScope ? loadError : null

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (scopeRef.current !== requestScope) {
      scopeRef.current = requestScope
      setData(null)
    }
    setLoading(true)
    setLoadError(null)

    getAcquisitionAnalyticsSummary({
      start: startDate,
      end: endDate,
      population,
      dimension,
      channels: channel === 'all' ? [] : [channel],
      groupBy,
      filters: population === 'visitors' ? webFilters : {}
    }, controller.signal)
      .then(result => {
        if (!active) return
        setData(result)
      })
      .catch(error => {
        if (!active || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Intenta nuevamente.'
        setLoadError(message)
        showToast('error', 'No se pudo cargar la atribución', message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [
    channel,
    dimension,
    endDate,
    groupBy,
    population,
    requestScope,
    retryKey,
    showToast,
    startDate,
    webFilters
  ])

  const updateParam = (key: string, value: string, defaultValue: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === defaultValue) next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  const populationOptions = ACQUISITION_POPULATIONS.filter(option => (
    option.value !== 'visitors' || hasWebAnalyticsAccess
  ))
  const configuredMessageChannels = Object.entries(availableMessageChannels)
    .filter(([key, connected]) => (
      connected && Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, key)
    ))
    .map(([key]) => key as AcquisitionAnalyticsChannel)
  const availableRangeChannels = new Set<AcquisitionAnalyticsChannel>(
    (scopedData?.availableChannels || []).filter(candidate => (
      Object.prototype.hasOwnProperty.call(CHANNEL_LABELS, candidate)
    ))
  )
  const allowedForPopulation = allowedChannelsForPopulation(population)
  const visibleChannels = (Object.keys(CHANNEL_LABELS) as AcquisitionAnalyticsChannel[])
    .filter(candidate => allowedForPopulation.has(candidate))
    .filter(candidate => (
      candidate === 'website'
        ? websiteAvailable || availableRangeChannels.has(candidate) || channel === candidate
        : configuredMessageChannels.includes(candidate) ||
          availableRangeChannels.has(candidate) ||
          channel === candidate
    ))
  const channelOptions = [
    { value: 'all', label: 'Todos los canales' },
    ...visibleChannels.map(candidate => ({
      value: candidate,
      label: availableRangeChannels.has(candidate) &&
        !availableMessageChannels[candidate] &&
        candidate !== 'website'
        ? `${CHANNEL_LABELS[candidate]} (histórico)`
        : CHANNEL_LABELS[candidate]
    }))
  ]
  const meta = populationMeta(population)
  const distribution = scopedData?.distribution || []
  const handlePopulationChange = (value: string) => {
    if (!isPopulation(value)) return
    const next = new URLSearchParams(searchParams)
    if (value === 'contacts') next.delete('originPopulation')
    else next.set('originPopulation', value)

    const nextChannel = normalizeChannelForPopulation(channel, value)
    if (nextChannel === 'all') next.delete('originChannel')
    else next.set('originChannel', nextChannel)
    setSearchParams(next, { replace: true })
  }
  const populationSelector = (
    <ViewSelector
      variant="title"
      options={populationOptions}
      value={population}
      onChange={handlePopulationChange}
    />
  )
  const breakdownSelector = (
    <ViewSelector
      options={ACQUISITION_DIMENSIONS}
      value={dimension}
      onChange={value => {
        if (isDimension(value)) updateParam('originBreakdown', value, 'entry')
      }}
    />
  )
  const channelSelector = channelOptions.length > 1 ? (
    <ViewSelector
      options={channelOptions}
      value={channel}
      onChange={value => {
        if (isChannel(value)) updateParam('originChannel', value, 'all')
      }}
    />
  ) : null

  if (scopedLoadError && !scopedData && !loading) {
    return (
      <Card variant="glass" className="p-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">{populationSelector}</div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              {breakdownSelector}
              {channelSelector}
            </div>
          </div>
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <p className="font-display text-sm font-semibold text-[var(--text)]">
              No pudimos cargar el origen
            </p>
            <p className="mt-1 text-sm text-[var(--text-mute)]">{scopedLoadError}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setRetryKey(current => current + 1)}
            >
              Reintentar
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
      <TrafficSourcesChart
      data={distribution}
      total={scopedData?.total || 0}
      loading={(loading || !hasCurrentScope) && !scopedData}
      title="Origen"
      totalLabel={meta.totalLabel}
      itemLabel={meta.itemLabel}
      emptyText={meta.emptyText}
      emptySubtext={meta.emptySubtext}
      insightPrimaryLabel="Mayor origen"
      insightCountLabel="Desglose"
      insightCountSuffix="orígenes comprobables"
      showZeroStateAsChart
      titleSlot={populationSelector}
      headerAction={(
        <>
          {breakdownSelector}
          {channelSelector}
          {scopedLoadError && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={loading}
              title={scopedLoadError}
              onClick={() => setRetryKey(current => current + 1)}
            >
              {loading ? 'Reintentando…' : 'Reintentar'}
            </Button>
          )}
        </>
      )}
    />
  )
}

/**
 * Dashboard conserva temporalmente su contrato de tráfico. Analíticas pasa un
 * rango explícito y usa el contrato exacto de adquisición por población.
 */
export const OriginDistributionCard: React.FC<OriginDistributionCardProps> = props => {
  if (props.startDate && props.endDate) {
    return (
      <AcquisitionOriginDistributionCard
        {...props}
        startDate={props.startDate}
        endDate={props.endDate}
      />
    )
  }
  return <LegacyOriginDistributionCard />
}
