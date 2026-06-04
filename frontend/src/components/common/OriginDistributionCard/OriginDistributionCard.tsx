import React, { useEffect, useState } from 'react'
import { TrafficSourcesChart } from '../TrafficSourcesChart/TrafficSourcesChart'
import { ViewSelector } from '../ViewSelector/ViewSelector'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useLabels } from '@/contexts/LabelsContext'
import { dashboardService, type OriginDistributionData } from '@/services/dashboardService'

type OriginCategory = 'traffic' | 'leads' | 'appointments' | 'conversions'
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

/**
 * Dona unificada de "Origen" usada igual en Dashboard y Analíticas.
 * El título es un dropdown de categoría (Tráfico / Origen de {leads|citas|clientes});
 * cuando la categoría es Tráfico aparece un segundo dropdown con la sub-dimensión
 * (Fuentes/Plataformas/Dispositivos/Ubicaciones/Navegadores/Sistemas).
 */
export const OriginDistributionCard: React.FC = () => {
  const { dateRange } = useDateRange()
  const { labels } = useLabels()
  const [category, setCategory] = useState<OriginCategory>('traffic')
  const [dimension, setDimension] = useState<TrafficDimension>('sources')
  const [data, setData] = useState<OriginDistributionData>(EMPTY)
  const [loading, setLoading] = useState(true)

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

  const leadsLower = labels.leads.toLowerCase()
  const customersLower = labels.customers.toLowerCase()

  const categoryOptions: { value: OriginCategory; label: string }[] = [
    { value: 'traffic', label: 'Tráfico' },
    { value: 'leads', label: `Origen de ${labels.leads}` },
    { value: 'appointments', label: 'Origen de citas' },
    { value: 'conversions', label: `Origen de ${labels.customers}` }
  ]

  const meta = {
    traffic: {
      data: data.traffic[dimension],
      totalLabel: 'visitantes únicos',
      itemLabel: 'Visitantes',
      emptyText: 'Sin datos de tráfico',
      emptySubtext: 'Los datos aparecerán cuando haya visitas',
      insightPrimaryLabel: DIMENSION_INSIGHTS[dimension].primary,
      insightCountSuffix: DIMENSION_INSIGHTS[dimension].suffix
    },
    leads: {
      data: data.leads,
      totalLabel: leadsLower,
      itemLabel: labels.leads,
      emptyText: `Sin origen de ${leadsLower}`,
      emptySubtext: 'Aparecerá cuando haya contactos en el rango',
      insightPrimaryLabel: 'Mayor origen',
      insightCountSuffix: 'orígenes activos'
    },
    appointments: {
      data: data.appointments,
      totalLabel: 'citas',
      itemLabel: 'Citas',
      emptyText: 'Sin origen de citas',
      emptySubtext: 'Aparecerá cuando haya citas agendadas en el rango',
      insightPrimaryLabel: 'Mayor origen',
      insightCountSuffix: 'orígenes activos'
    },
    conversions: {
      data: data.conversions,
      totalLabel: customersLower,
      itemLabel: labels.customers,
      emptyText: `Sin origen de ${customersLower}`,
      emptySubtext: 'Aparecerá cuando haya ventas en el rango',
      insightPrimaryLabel: 'Mayor origen',
      insightCountSuffix: 'orígenes activos'
    }
  }[category]

  return (
    <TrafficSourcesChart
      data={meta.data}
      loading={loading}
      totalLabel={meta.totalLabel}
      itemLabel={meta.itemLabel}
      emptyText={meta.emptyText}
      emptySubtext={meta.emptySubtext}
      insightPrimaryLabel={meta.insightPrimaryLabel}
      insightCountLabel="Variedad"
      insightCountSuffix={meta.insightCountSuffix}
      titleSlot={(
        <ViewSelector
          options={categoryOptions}
          value={category}
          onChange={(value) => setCategory(value as OriginCategory)}
        />
      )}
      headerAction={category === 'traffic' ? (
        <ViewSelector
          options={DIMENSION_OPTIONS}
          value={dimension}
          onChange={(value) => setDimension(value as TrafficDimension)}
        />
      ) : undefined}
    />
  )
}
