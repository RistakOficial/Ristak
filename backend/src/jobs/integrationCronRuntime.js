import { logger } from '../utils/logger.js'

const registry = new Map()

function cleanString(value) {
  return String(value || '').trim()
}

export function registerIntegrationCron({
  name,
  label,
  provider,
  isEnabled,
  start,
  stop
} = {}) {
  const cleanName = cleanString(name)
  if (!cleanName) throw new Error('registerIntegrationCron requiere name')
  if (typeof isEnabled !== 'function') throw new Error(`Cron ${cleanName} requiere isEnabled`)
  if (typeof start !== 'function') throw new Error(`Cron ${cleanName} requiere start`)
  if (typeof stop !== 'function') throw new Error(`Cron ${cleanName} requiere stop`)

  registry.set(cleanName, {
    name: cleanName,
    label: cleanString(label) || cleanName,
    provider: cleanString(provider),
    isEnabled,
    start,
    stop,
    active: false
  })
}

export function getIntegrationCronState() {
  return [...registry.values()].map((entry) => ({
    name: entry.name,
    label: entry.label,
    provider: entry.provider,
    active: entry.active
  }))
}

export async function syncIntegrationCron(name, { reason = 'sync', restartActive = false } = {}) {
  const entry = registry.get(cleanString(name))
  if (!entry) return null

  let enabled = false
  try {
    enabled = Boolean(await entry.isEnabled())
  } catch (error) {
    logger.warn(`[Crons integraciones] No se pudo evaluar ${entry.label}: ${error.message}`)
  }

  if (enabled && entry.active && restartActive) {
    try {
      await entry.stop()
      entry.active = false
      logger.info(`[Crons integraciones] ${entry.label} reprogramando (${reason})`)
    } catch (error) {
      logger.warn(`[Crons integraciones] No se pudo reprogramar ${entry.label}: ${error.message}`)
    }
  }

  if (enabled && !entry.active) {
    try {
      const started = await entry.start()
      entry.active = started !== false
      if (entry.active) {
        logger.info(`[Crons integraciones] ${entry.label} activado (${reason})`)
      } else {
        logger.info(`[Crons integraciones] ${entry.label} no se activó por configuración del entorno (${reason})`)
      }
    } catch (error) {
      entry.active = false
      logger.warn(`[Crons integraciones] No se pudo activar ${entry.label}: ${error.message}`)
    }
  } else if (!enabled && entry.active) {
    try {
      await entry.stop()
    } catch (error) {
      logger.warn(`[Crons integraciones] No se pudo apagar ${entry.label}: ${error.message}`)
    }
    entry.active = false
    logger.info(`[Crons integraciones] ${entry.label} apagado (${reason})`)
  } else if (!enabled) {
    logger.info(`[Crons integraciones] ${entry.label} no se activa: integración desconectada (${reason})`)
  }

  return {
    name: entry.name,
    label: entry.label,
    provider: entry.provider,
    active: entry.active,
    enabled
  }
}

export async function syncIntegrationCrons(names = null, options = {}) {
  const selected = Array.isArray(names) && names.length
    ? names
    : [...registry.keys()]
  const results = []
  for (const name of selected) {
    const result = await syncIntegrationCron(name, options)
    if (result) results.push(result)
  }
  return results
}

export async function syncIntegrationCronsForProvider(provider, options = {}) {
  const normalizedProvider = cleanString(provider)
  const names = [...registry.values()]
    .filter((entry) => entry.provider === normalizedProvider)
    .map((entry) => entry.name)
  return syncIntegrationCrons(names, options)
}

export function stopIntegrationCrons() {
  for (const entry of registry.values()) {
    if (!entry.active) continue
    try {
      entry.stop()
    } catch (error) {
      logger.warn(`[Crons integraciones] No se pudo apagar ${entry.label}: ${error.message}`)
    }
    entry.active = false
  }
}
