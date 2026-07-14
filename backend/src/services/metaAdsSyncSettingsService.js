import { getAppConfig, setAppConfig } from '../config/database.js'

export const META_ADS_SYNC_INTERVAL_CONFIG_KEY = 'meta_ads_sync_interval_minutes'
export const DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES = 60
export const MIN_META_ADS_SYNC_INTERVAL_MINUTES = 5
export const MAX_META_ADS_SYNC_INTERVAL_MINUTES = 24 * 60
export const META_ADS_SYNC_INTERVAL_OPTIONS = Object.freeze([
  5,
  10,
  15,
  30,
  60,
  120,
  180,
  360,
  720,
  1440
])

const allowedIntervals = new Set(META_ADS_SYNC_INTERVAL_OPTIONS)

export function normalizeMetaAdsSyncIntervalMinutes(
  value,
  fallback = DEFAULT_META_ADS_SYNC_INTERVAL_MINUTES
) {
  const numericValue = Number(value)
  return Number.isInteger(numericValue) && allowedIntervals.has(numericValue)
    ? numericValue
    : fallback
}

export function validateMetaAdsSyncIntervalMinutes(value) {
  const numericValue = Number(value)
  if (!Number.isInteger(numericValue) || !allowedIntervals.has(numericValue)) {
    const error = new Error(
      `El intervalo de Meta Ads debe ser una opción válida entre ${MIN_META_ADS_SYNC_INTERVAL_MINUTES} y ${MAX_META_ADS_SYNC_INTERVAL_MINUTES} minutos.`
    )
    error.status = 400
    throw error
  }
  return numericValue
}

export async function getMetaAdsSyncIntervalMinutes() {
  const storedValue = await getAppConfig(META_ADS_SYNC_INTERVAL_CONFIG_KEY)
  return normalizeMetaAdsSyncIntervalMinutes(storedValue)
}

export async function saveMetaAdsSyncIntervalMinutes(value) {
  const intervalMinutes = validateMetaAdsSyncIntervalMinutes(value)
  await setAppConfig(META_ADS_SYNC_INTERVAL_CONFIG_KEY, String(intervalMinutes))
  return intervalMinutes
}

export function formatMetaAdsSyncInterval(intervalMinutes) {
  if (intervalMinutes === 1440) return 'cada día'
  if (intervalMinutes >= 60) {
    const hours = intervalMinutes / 60
    return hours === 1 ? 'cada hora' : `cada ${hours} horas`
  }
  return `cada ${intervalMinutes} minutos`
}
