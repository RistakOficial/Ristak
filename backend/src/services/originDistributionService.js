import { db } from '../config/database.js'
import { normalizeTrafficSource } from '../utils/trafficSourceNormalizer.js'
import { formatPlacementName } from '../utils/placementName.js'
import { getHiddenContactFilters, buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'

const toRanked = (bucketMap, limit = 10) =>
  Array.from(bucketMap.entries())
    .map(([name, visitorSet]) => ({ name, value: visitorSet.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)

/**
 * Distribución de tráfico (sesiones web) por las 6 dimensiones del dropdown derecho.
 * Cuenta visitantes únicos por bucket, igual que la página de Analíticas
 * (Analytics.tsx ~1153-1282). Un visitante puede caer en varios buckets si tuvo
 * sesiones con distinta fuente/dispositivo/etc.
 * @param {{ startUtc: string, endUtc: string }} range
 * @returns {Promise<{ sources, platforms, devices, placements, browsers, os }>}
 */
export async function getTrafficDistributions(range) {
  const sessions = await db.all(`
    SELECT visitor_id, referrer_url, site_source_name, utm_source, source_platform,
           device_type, browser, os, placement
    FROM sessions
    WHERE started_at >= ? AND started_at <= ?
      AND visitor_id IS NOT NULL AND visitor_id != ''
  `, [range.startUtc, range.endUtc])

  const sources = new Map()
  const platforms = new Map()
  const devices = new Map()
  const placements = new Map()
  const browsers = new Map()
  const operatingSystems = new Map()

  const add = (map, key, visitorId) => {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(visitorId)
  }

  sessions.forEach(session => {
    const visitorId = session.visitor_id
    // Fuentes y Plataformas usan exactamente la misma normalización en Analíticas.
    const sourceName = normalizeTrafficSource({
      referrer_url: session.referrer_url,
      site_source_name: session.site_source_name,
      utm_source: session.utm_source,
      source_platform: session.source_platform
    })

    add(sources, sourceName, visitorId)
    add(platforms, sourceName, visitorId)
    add(devices, session.device_type || 'Desconocido', visitorId)
    add(browsers, session.browser || 'Desconocido', visitorId)
    add(operatingSystems, session.os || 'Desconocido', visitorId)
    add(placements, formatPlacementName(session.placement || 'Sin ubicación'), visitorId)
  })

  return {
    sources: toRanked(sources),
    platforms: toRanked(platforms),
    devices: toRanked(devices),
    placements: toRanked(placements),
    browsers: toRanked(browsers),
    os: toRanked(operatingSystems)
  }
}

/**
 * IDs de contactos creados dentro del rango (leads/prospectos), excluyendo ocultos.
 * @param {{ startUtc: string, endUtc: string }} range
 * @returns {Promise<string[]>}
 */
export async function getLeadsContactIds(range) {
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'contacts', false)

  const conditions = ['created_at >= ?', 'created_at <= ?']
  if (hiddenCondition) conditions.push(hiddenCondition)

  const rows = await db.all(`
    SELECT id FROM contacts WHERE ${conditions.join(' AND ')}
  `, [range.startUtc, range.endUtc])

  return rows.map(row => row.id)
}
