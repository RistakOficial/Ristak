import { db } from '../config/database.js'
import { TRACKING_ANALYTICS_FAST_FACETS } from './trackingAnalyticsRangeRollupService.js'

const FACET_LIMIT = 25

function integerValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

/**
 * Consulta únicamente los facets exactos respaldados por el ledger de rangos
 * de la proyección 113. Este corte deliberadamente no incluye los queries de
 * summary, presence filtrada ni jerarquía publicitaria.
 */
export async function queryTrackingAnalyticsProjectionFacet(
  range,
  filters,
  dimension,
  { signal } = {}
) {
  if (!TRACKING_ANALYTICS_FAST_FACETS[dimension]) {
    const error = new Error(`Facet proyectado no soportado: ${dimension}`)
    error.code = 'tracking_analytics_projection_facet_unsupported'
    throw error
  }
  const hasFilters = Object.values(filters || {}).some(value => Array.isArray(value) && value.length > 0)
  if (hasFilters) {
    const error = new Error('El facet rápido de tracking no admite filtros combinados.')
    error.code = 'tracking_analytics_projection_filters_unsupported'
    throw error
  }

  const rows = await db.all(`
    SELECT
      values_table.facet_value AS value,
      SUM(delta.range_delta) AS item_count
    FROM tracking_analytics_facet_values values_table
    INNER JOIN tracking_analytics_facet_range_delta delta
      ON delta.facet_value_id = values_table.facet_value_id
    WHERE values_table.facet_type = ?
      AND delta.start_boundary <= ?
      AND delta.occurrence_date <= ?
    GROUP BY values_table.facet_value
    HAVING SUM(delta.range_delta) > 0
    ORDER BY item_count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `, [dimension, range.startDate, range.endDate], { signal })

  return rows.map(row => ({
    value: String(row.value || ''),
    label: String(row.value || ''),
    count: integerValue(row.item_count)
  }))
}
