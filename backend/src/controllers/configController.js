import { getAppConfig, setAppConfig, db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  ACCOUNT_COUNTRY_CONFIG_KEY,
  ACCOUNT_CURRENCY_CONFIG_KEY,
  ACCOUNT_DIAL_CODE_CONFIG_KEY,
  getAccountLocaleSettings
} from '../utils/accountLocale.js'
import { ACCOUNT_TIMEZONE_CONFIG_KEY, getAccountTimezone } from '../utils/dateUtils.js'

const SENSITIVE_CONFIG_KEY_PATTERN = /(private_key|secret|password|api_token|access_token|refresh_token|service_account|client_secret|webhook_secret)/i
const META_SOCIAL_MESSAGING_PLATFORM_BY_KEY = {
  meta_messenger_messaging_enabled: 'messenger',
  meta_instagram_messaging_enabled: 'instagram'
}
const ACCOUNT_LOCALE_CONFIG_KEYS = new Set([
  ACCOUNT_COUNTRY_CONFIG_KEY,
  ACCOUNT_CURRENCY_CONFIG_KEY,
  ACCOUNT_DIAL_CODE_CONFIG_KEY,
  ACCOUNT_TIMEZONE_CONFIG_KEY
])

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function isSensitiveConfigKey(key = '') {
  return SENSITIVE_CONFIG_KEY_PATTERN.test(String(key || ''))
}

function isEnabledConfigValue(value) {
  const normalized = cleanString(value).toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function getSafeConfigValue(key, value) {
  return isSensitiveConfigKey(key) ? null : value
}

function getSafeLogValue(key, value) {
  return isSensitiveConfigKey(key) ? '[redacted]' : value
}

export function applyResolvedAccountLocaleConfig(config = {}, locale = {}, requestedKeys = null) {
  const next = { ...config }
  const requested = requestedKeys ? new Set(requestedKeys) : null
  const resolvedValues = {
    [ACCOUNT_COUNTRY_CONFIG_KEY]: locale.countryCode,
    [ACCOUNT_CURRENCY_CONFIG_KEY]: locale.currency,
    [ACCOUNT_DIAL_CODE_CONFIG_KEY]: locale.dialCode,
    [ACCOUNT_TIMEZONE_CONFIG_KEY]: locale.timezone
  }

  for (const [key, value] of Object.entries(resolvedValues)) {
    if (requested && !requested.has(key)) continue
    if (value === undefined || value === null || value === '') continue
    next[key] = value
  }
  return next
}

/**
 * Obtiene TODA la configuración de la app (o una clave específica)
 * GET /api/config
 * GET /api/config?keys=visitor_source,show_analytics
 */
export async function getConfig(req, res) {
  try {
    const { keys } = req.query

    // Si se especifican keys, obtener solo esas
    if (keys) {
      const keyArray = keys.split(',').map(k => k.trim()).filter(Boolean)
      let config = {}

      for (const key of keyArray) {
        const value = await getAppConfig(key)
        config[key] = getSafeConfigValue(key, value)
      }

      if (keyArray.some(key => ACCOUNT_LOCALE_CONFIG_KEYS.has(key))) {
        const [locale, timezone] = await Promise.all([getAccountLocaleSettings(), getAccountTimezone()])
        config = applyResolvedAccountLocaleConfig(config, { ...locale, timezone }, keyArray)
      }

      return res.json({
        success: true,
        config
      })
    }

    // Si no se especifican keys, obtener TODA la configuración
    const rows = await db.all('SELECT config_key, config_value FROM app_config')

    let config = {}
    rows.forEach(row => {
      config[row.config_key] = getSafeConfigValue(row.config_key, row.config_value)
    })
    const [locale, timezone] = await Promise.all([getAccountLocaleSettings(), getAccountTimezone()])
    config = applyResolvedAccountLocaleConfig(config, { ...locale, timezone })

    res.json({
      success: true,
      config
    })
  } catch (error) {
    logger.error('Error obteniendo configuración:', error)
    res.status(500).json({
      success: false,
      error: 'Error al obtener configuración'
    })
  }
}

/**
 * Guarda una o múltiples configuraciones
 * POST /api/config
 * Body: { key: 'visitor_source', value: 'tracking' }
 * Body: { config: { visitor_source: 'tracking', show_analytics: '1' } }
 */
// Al guardar el código de Test Events de Meta, estampamos cuándo se puso para
// que expire solo a los 30 min (ver utils/metaTestCode.js). Si se borra, también
// limpiamos el timestamp.
async function setAppConfigStamped(k, v) {
  await setAppConfig(k, v)
  if (k === 'meta_test_event_code') {
    await setAppConfig('meta_test_event_code_set_at', String(v ?? '').trim() ? String(Date.now()) : '')
  }
}

async function maybeStartMetaSocialHistoryBackfillForConfig(config = {}, reason = 'app-config-updated') {
  const platforms = [...new Set(Object.entries(config)
    .filter(([key, value]) => META_SOCIAL_MESSAGING_PLATFORM_BY_KEY[key] && isEnabledConfigValue(value))
    .map(([key]) => META_SOCIAL_MESSAGING_PLATFORM_BY_KEY[key]))]
  if (!platforms.length) return { syncStarted: false, started: [], skipped: [] }

  try {
    const { syncMetaSocialConversationHistoryInBackground } = await import('../services/metaSocialMessagingService.js')
    const result = syncMetaSocialConversationHistoryInBackground({ platforms, reason })
    if (result.syncStarted) {
      logger.info(`Meta social: backfill de historial iniciado por configuración (${platforms.join(', ')})`)
    }
    return result
  } catch (error) {
    logger.warn(`Meta social: no se pudo iniciar backfill por configuración: ${error.message}`)
    return { syncStarted: false, started: [], skipped: platforms.map(platform => ({ platform, reason: error.message })) }
  }
}

export async function saveConfig(req, res) {
  try {
    const { key, value, config } = req.body

    // Modo 1: Guardar una sola key
    if (key && value !== undefined) {
      await setAppConfigStamped(key, value)
      const socialHistoryBackfill = await maybeStartMetaSocialHistoryBackfillForConfig({ [key]: value }, 'messaging-config-enabled')
      logger.info(`Configuración guardada: ${key} = ${getSafeLogValue(key, value)}`)

      return res.json({
        success: true,
        message: 'Configuración guardada exitosamente',
        socialHistoryBackfill
      })
    }

    // Modo 2: Guardar múltiples keys
    if (config && typeof config === 'object') {
      for (const [k, v] of Object.entries(config)) {
        await setAppConfigStamped(k, v)
      }
      const socialHistoryBackfill = await maybeStartMetaSocialHistoryBackfillForConfig(config, 'messaging-config-enabled')

      logger.info(`${Object.keys(config).length} configuraciones guardadas`)

      return res.json({
        success: true,
        message: 'Configuraciones guardadas exitosamente',
        socialHistoryBackfill
      })
    }

    return res.status(400).json({
      success: false,
      error: 'Se requiere "key" y "value", o "config" con un objeto'
    })
  } catch (error) {
    logger.error('Error guardando configuración:', error)
    res.status(500).json({
      success: false,
      error: 'Error al guardar configuración'
    })
  }
}

/**
 * Elimina una o múltiples configuraciones
 * DELETE /api/config?keys=visitor_source,show_analytics
 */
export async function deleteConfig(req, res) {
  try {
    const { keys } = req.query

    if (!keys) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere el parámetro "keys"'
      })
    }

    const keyArray = keys.split(',').map(k => k.trim())

    for (const key of keyArray) {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
    }

    logger.info(`${keyArray.length} configuraciones eliminadas: ${keyArray.join(', ')}`)

    res.json({
      success: true,
      message: 'Configuraciones eliminadas exitosamente'
    })
  } catch (error) {
    logger.error('Error eliminando configuración:', error)
    res.status(500).json({
      success: false,
      error: 'Error al eliminar configuración'
    })
  }
}
