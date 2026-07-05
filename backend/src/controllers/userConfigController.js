// (MOB-006) Configuración móvil POR USUARIO.
// El usuario lee/escribe SUS preferencias (req.user.userId) sin necesitar el gate
// settings_account (para que los empleados puedan guardar lo suyo). El admin ve/ajusta
// las de todo el equipo. Todo cae con fallback al valor global de app_config cuando el
// usuario no ha personalizado nada (así nadie pierde lo que ya recibía).
import {
  getAppConfig,
  getUserAppConfig,
  setUserAppConfig,
  deleteUserAppConfig,
  getUserAppConfigMany,
  getUserAppConfigOverrideFlags,
  db
} from '../config/database.js'
import { logger } from '../utils/logger.js'

// Claves móviles que SÍ se pueden personalizar por usuario.
// Cualquier otra clave queda fuera (no se lee ni se escribe por este endpoint).
const USER_CONFIG_WHITELIST = [
  'calendar_push_notifications_enabled',
  'appointment_confirmation_push_notifications_enabled',
  'chat_push_notifications_enabled',
  'payment_push_notifications_enabled',
  'push_notification_sound_enabled',
  'push_notification_vibration_enabled',
  'calendar_push_notification_calendar_ids',
  'mobile_chat_appointment_entry_mode'
]
const USER_CONFIG_WHITELIST_SET = new Set(USER_CONFIG_WHITELIST)

// Clave que guarda una lista (JSON) en vez de un escalar; la vista admin la devuelve
// como array parseado para pintarla cómodamente.
const CALENDAR_IDS_KEY = 'calendar_push_notification_calendar_ids'

function isWhitelistedKey(key) {
  return USER_CONFIG_WHITELIST_SET.has(String(key || ''))
}

function parseCalendarIds(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * GET /api/user-config (self)
 * El usuario lee SU configuración por-usuario (con fallback al global).
 * Query opcional ?keys=k1,k2. Para no-admin solo devuelve claves whitelisteadas.
 */
export async function getUserConfig(req, res) {
  try {
    const userId = req.user.userId
    const isAdmin = req.user?.role === 'admin'
    const { keys } = req.query

    let requestedKeys
    if (keys) {
      requestedKeys = String(keys).split(',').map(k => k.trim()).filter(Boolean)
    } else {
      requestedKeys = [...USER_CONFIG_WHITELIST]
    }

    // Solo se devuelven claves whitelisteadas salvo que el llamador sea admin.
    const allowedKeys = isAdmin
      ? requestedKeys
      : requestedKeys.filter(isWhitelistedKey)

    const config = await getUserAppConfigMany(userId, allowedKeys)

    res.json({ success: true, config })
  } catch (error) {
    logger.error('Error obteniendo configuración por usuario:', error)
    res.status(500).json({ success: false, error: 'Error al obtener configuración' })
  }
}

/**
 * POST /api/user-config (self)
 * El usuario escribe SU configuración por-usuario. Solo permite claves whitelist.
 * Body modo 1: { key, value }. Modo 2: { config: { k: v, ... } }.
 * SEGURIDAD: siempre escribe con req.user.userId; NUNCA acepta user_id del body.
 */
export async function saveUserConfig(req, res) {
  try {
    const userId = req.user.userId
    const { key, value, config } = req.body

    // Modo 1: una sola clave
    if (key && value !== undefined) {
      if (!isWhitelistedKey(key)) {
        return res.status(400).json({ success: false, error: `Clave no permitida: ${key}` })
      }
      await setUserAppConfig(userId, key, value)
      return res.json({ success: true, message: 'Preferencia guardada' })
    }

    // Modo 2: varias claves
    if (config && typeof config === 'object') {
      const entries = Object.entries(config)
      for (const [k] of entries) {
        if (!isWhitelistedKey(k)) {
          return res.status(400).json({ success: false, error: `Clave no permitida: ${k}` })
        }
      }
      for (const [k, v] of entries) {
        await setUserAppConfig(userId, k, v)
      }
      return res.json({ success: true, message: 'Preferencias guardadas' })
    }

    return res.status(400).json({
      success: false,
      error: 'Se requiere "key" y "value", o "config" con un objeto'
    })
  } catch (error) {
    logger.error('Error guardando configuración por usuario:', error)
    res.status(500).json({ success: false, error: 'Error al guardar configuración' })
  }
}

function formatAdminValue(key, value) {
  return key === CALENDAR_IDS_KEY ? parseCalendarIds(value) : value
}

/**
 * Construye el objeto config por-usuario para la vista admin: por cada una de las 7
 * claves, el valor EFECTIVO (override propio o global heredado) y si es override.
 */
async function buildUserAdminConfig(userId) {
  const [effective, flags] = await Promise.all([
    getUserAppConfigMany(userId, USER_CONFIG_WHITELIST),
    getUserAppConfigOverrideFlags(userId, USER_CONFIG_WHITELIST)
  ])

  const config = {}
  for (const key of USER_CONFIG_WHITELIST) {
    config[key] = {
      value: formatAdminValue(key, effective[key]),
      isOverride: Boolean(flags[key])
    }
  }
  return config
}

/**
 * GET /api/user-config/admin (admin)
 * Devuelve los globales (default heredado) y, por cada usuario activo, el valor
 * efectivo de las 7 claves más el flag isOverride. Query opcional ?userId= para uno.
 */
export async function getUserConfigAdmin(req, res) {
  try {
    const { userId: filterUserId } = req.query

    const globals = {}
    for (const key of USER_CONFIG_WHITELIST) {
      const value = await getAppConfig(key)
      globals[key] = formatAdminValue(key, value)
    }

    let sql = `SELECT id, username, email, first_name, last_name, full_name, role
       FROM users
       WHERE is_active = 1`
    const params = []
    if (filterUserId !== undefined && filterUserId !== '') {
      sql += ' AND id = ?'
      params.push(Number(filterUserId))
    }
    sql += ' ORDER BY role ASC, full_name ASC, username ASC'

    const rows = await db.all(sql, params)

    const users = []
    for (const row of rows) {
      const config = await buildUserAdminConfig(row.id)
      users.push({
        userId: String(row.id),
        username: row.username,
        fullName: row.full_name || row.username || '',
        email: row.email || '',
        role: row.role,
        config
      })
    }

    res.json({ success: true, globals, users })
  } catch (error) {
    logger.error('Error obteniendo configuración por usuario (admin):', error)
    res.status(500).json({ success: false, error: 'Error al obtener configuración del equipo' })
  }
}

/**
 * PATCH /api/user-config/admin/:userId (admin)
 * El admin escribe/limpia overrides de otro usuario. value=null borra el override
 * (vuelve a heredar el global). Solo claves whitelisteadas.
 */
export async function patchUserConfigAdmin(req, res) {
  try {
    const targetUserId = Number(req.params.userId)
    if (!Number.isFinite(targetUserId)) {
      return res.status(400).json({ success: false, error: 'userId inválido' })
    }

    const target = await db.get('SELECT id FROM users WHERE id = ?', [targetUserId])
    if (!target) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' })
    }

    const { config } = req.body
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ success: false, error: 'Se requiere "config" con un objeto' })
    }

    const entries = Object.entries(config)
    for (const [k] of entries) {
      if (!isWhitelistedKey(k)) {
        return res.status(400).json({ success: false, error: `Clave no permitida: ${k}` })
      }
    }

    for (const [k, v] of entries) {
      if (v === null) {
        await deleteUserAppConfig(targetUserId, k)
      } else {
        await setUserAppConfig(targetUserId, k, v)
      }
    }

    const resultConfig = await buildUserAdminConfig(targetUserId)
    res.json({ success: true, config: resultConfig })
  } catch (error) {
    logger.error('Error ajustando configuración por usuario (admin):', error)
    res.status(500).json({ success: false, error: 'Error al ajustar configuración del usuario' })
  }
}
