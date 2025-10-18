import fetch from 'node-fetch'
import { logger } from '../utils/logger.js'
import { encrypt } from '../utils/encryption.js'
import { db } from '../config/database.js'
import { API_URLS, META_OAUTH_SCOPES } from '../config/constants.js'

/**
 * Servicio de OAuth para Meta (Facebook)
 *
 * Flujo completo:
 * 1. Usuario hace clic en "Conectar con Meta"
 * 2. Se abre popup con getAuthUrl() → redirige a Meta
 * 3. Usuario autoriza la app en Meta
 * 4. Meta redirige a /callback con un code
 * 5. exchangeCodeForToken() intercambia code por access_token
 * 6. getAdAccounts() obtiene lista de cuentas de anuncios
 * 7. Usuario selecciona cuenta → guardamos en BD
 */

/**
 * Genera la URL de autorización de Meta para iniciar el flujo OAuth
 * @returns {string} URL para abrir en popup
 */
export function getAuthUrl() {
  const appId = process.env.META_APP_ID
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'}/api/meta/oauth/callback`

  if (!appId) {
    throw new Error('META_APP_ID no configurado en variables de entorno')
  }

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: META_OAUTH_SCOPES,
    response_type: 'code',
    state: generateState() // Para prevenir CSRF
  })

  const authUrl = `${API_URLS.META_OAUTH}?${params.toString()}`

  logger.info('URL de OAuth generada:', authUrl)
  return authUrl
}

/**
 * Intercambia el code de Meta por un access_token de larga duración
 * @param {string} code - Código de autorización de Meta
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function exchangeCodeForToken(code) {
  try {
    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    const redirectUri = process.env.META_REDIRECT_URI || `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'}/api/meta/oauth/callback`

    if (!appId || !appSecret) {
      throw new Error('META_APP_ID o META_APP_SECRET no configurados')
    }

    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code
    })

    const url = `${API_URLS.META_OAUTH_TOKEN}?${params.toString()}`

    logger.info('Intercambiando code por token...')
    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      logger.error('Error de Meta OAuth:', data.error)
      throw new Error(`Error de Meta: ${data.error.message}`)
    }

    if (!data.access_token) {
      throw new Error('No se recibió access_token de Meta')
    }

    logger.success('Token de Meta obtenido exitosamente')

    // Convertir token de corta duración a larga duración (60 días)
    const longLivedToken = await exchangeForLongLivedToken(data.access_token)

    return longLivedToken
  } catch (error) {
    logger.error('Error en exchangeCodeForToken:', error.message)
    throw error
  }
}

/**
 * Convierte un token de corta duración (1-2 horas) a uno de larga duración (60 días)
 * @param {string} shortToken - Token de corta duración
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function exchangeForLongLivedToken(shortToken) {
  try {
    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET

    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken
    })

    const url = `${API_URLS.META_OAUTH_TOKEN}?${params.toString()}`

    logger.info('Convirtiendo a token de larga duración...')
    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      logger.warn('No se pudo convertir a long-lived token, usando el original')
      return { access_token: shortToken, expires_in: 7200 } // 2 horas
    }

    logger.success(`Token de larga duración obtenido (expira en ${data.expires_in / 86400} días)`)
    return data
  } catch (error) {
    logger.warn('Error al obtener long-lived token, usando original:', error.message)
    return { access_token: shortToken, expires_in: 7200 }
  }
}

/**
 * Obtiene todas las cuentas de anuncios del usuario autenticado
 * @param {string} accessToken - Token de acceso de Meta
 * @returns {Promise<Array>} Lista de cuentas de anuncios
 */
export async function getAdAccounts(accessToken) {
  try {
    const url = `${API_URLS.META_AD_ACCOUNTS}?fields=id,name,account_id,account_status,currency,timezone_name,business&access_token=${accessToken}`

    logger.info('Obteniendo cuentas de anuncios de Meta...')
    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      logger.error('Error al obtener cuentas de anuncios:', data.error)
      throw new Error(`Error de Meta: ${data.error.message}`)
    }

    const accounts = data.data || []
    logger.success(`${accounts.length} cuentas de anuncios encontradas`)

    return accounts.map(account => ({
      id: account.id, // ej: "act_123456789"
      accountId: account.account_id, // ej: "123456789"
      name: account.name,
      status: account.account_status,
      currency: account.currency,
      timezone: account.timezone_name,
      businessId: account.business?.id || null,
      businessName: account.business?.name || null
    }))
  } catch (error) {
    logger.error('Error en getAdAccounts:', error.message)
    throw error
  }
}

/**
 * Guarda la configuración de OAuth en la base de datos (encriptada)
 * @param {string} adAccountId - ID de la cuenta de anuncios (ej: "123456789")
 * @param {string} accessToken - Token de acceso
 * @param {object} metadata - Info adicional (nombre, currency, etc)
 */
export async function saveOAuthConfig(adAccountId, accessToken, metadata = {}) {
  try {
    // Encriptar el token antes de guardar
    const encryptedToken = encrypt(accessToken)

    logger.info(`Guardando configuración OAuth para cuenta: ${adAccountId}`)

    const existing = await db.get('SELECT id FROM meta_config WHERE ad_account_id = ?', [adAccountId])

    if (existing) {
      // Actualizar existente
      await db.run(`
        UPDATE meta_config
        SET
          access_token = ?,
          app_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE ad_account_id = ?
      `, [encryptedToken, process.env.META_APP_ID, adAccountId])
    } else {
      // Crear nuevo
      await db.run(`
        INSERT INTO meta_config (ad_account_id, access_token, app_id)
        VALUES (?, ?, ?)
      `, [adAccountId, encryptedToken, process.env.META_APP_ID])
    }

    logger.success('Configuración OAuth guardada correctamente (encriptada)')
    return { success: true }
  } catch (error) {
    logger.error('Error guardando configuración OAuth:', error.message)
    throw error
  }
}

/**
 * Genera un state token para prevenir CSRF en OAuth
 * @returns {string}
 */
function generateState() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

/**
 * Obtiene información del usuario autenticado en Meta
 * @param {string} accessToken
 * @returns {Promise<object>}
 */
export async function getMetaUserInfo(accessToken) {
  try {
    const url = `https://graph.facebook.com/v23.0/me?fields=id,name,email&access_token=${accessToken}`

    const response = await fetch(url)
    const data = await response.json()

    if (data.error) {
      throw new Error(data.error.message)
    }

    return data
  } catch (error) {
    logger.error('Error obteniendo info de usuario:', error.message)
    throw error
  }
}
