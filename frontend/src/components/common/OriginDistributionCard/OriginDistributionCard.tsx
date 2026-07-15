import React, { useEffect, useMemo, useState } from 'react'
import { TrafficSourcesChart } from '../TrafficSourcesChart/TrafficSourcesChart'
import { ViewSelector } from '../ViewSelector/ViewSelector'
import { useDateRange } from '@/contexts/DateRangeContext'
import { dashboardService, type OriginDistributionData } from '@/services/dashboardService'
import { trackingService } from '@/services/trackingService'
import { normalizeDateInputToLocalDate } from '@/utils/format'
import { useNotification } from '@/contexts/NotificationContext'
import { Button } from '../Button'

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
