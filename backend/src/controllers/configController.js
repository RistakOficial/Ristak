import { getAppConfig, setAppConfig, db } from '../config/database.js'
import { logger } from '../utils/logger.js'

const SENSITIVE_CONFIG_KEY_PATTERN = /(private_key|secret|password|api_token|access_token|refresh_token|service_account|client_secret|webhook_secret)/i

function isSensitiveConfigKey(key = '') {
  return SENSITIVE_CONFIG_KEY_PATTERN.test(String(key || ''))
}

function getSafeConfigValue(key, value) {
  return isSensitiveConfigKey(key) ? null : value
}

function getSafeLogValue(key, value) {
  return isSensitiveConfigKey(key) ? '[redacted]' : value
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
      const keyArray = keys.split(',').map(k => k.trim())
      const config = {}

      for (const key of keyArray) {
        const value = await getAppConfig(key)
        config[key] = getSafeConfigValue(key, value)
      }

      return res.json({
        success: true,
        config
      })
    }

    // Si no se especifican keys, obtener TODA la configuración
    const rows = await db.all('SELECT config_key, config_value FROM app_config')

    const config = {}
    rows.forEach(row => {
      config[row.config_key] = getSafeConfigValue(row.config_key, row.config_value)
    })

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
export async function saveConfig(req, res) {
  try {
    const { key, value, config } = req.body

    // Modo 1: Guardar una sola key
    if (key && value !== undefined) {
      await setAppConfig(key, value)
      logger.info(`Configuración guardada: ${key} = ${getSafeLogValue(key, value)}`)

      return res.json({
        success: true,
        message: 'Configuración guardada exitosamente'
      })
    }

    // Modo 2: Guardar múltiples keys
    if (config && typeof config === 'object') {
      for (const [k, v] of Object.entries(config)) {
        await setAppConfig(k, v)
      }

      logger.info(`${Object.keys(config).length} configuraciones guardadas`)

      return res.json({
        success: true,
        message: 'Configuraciones guardadas exitosamente'
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
