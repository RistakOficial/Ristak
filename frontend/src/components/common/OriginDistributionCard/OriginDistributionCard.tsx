import React, { useEffect, useMemo, useState } from 'react'
import { TrafficSourcesChart } from '../TrafficSourcesChart/TrafficSourcesChart'
import { ViewSelector } from '../ViewSelector/ViewSelector'
import { useDateRange } from '@/contexts/DateRangeContext'
import { dashboardService, type OriginDistributionData } from '@/services/dashboardService'
import { trackingService } from '@/services/trackingService'

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

/**
 * Dona unificada de origen usada igual en Dashboard y Analíticas.
 * Muestra origen web y conversaciones de WhatsApp.
 */
export const OriginDistributionCard: React.FC = () => {
  const { dateRange } = useDateRange()
  const [dimension, setDimension] = useState<TrafficDimension>('sources')
  const [data, setData] = useState<OriginDistributionData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [webTrackingConfigured, setWebTrackingConfigured] = useState(false)
  const [webConnectionLoading, setWebConnectionLoading] = useState(true)

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
