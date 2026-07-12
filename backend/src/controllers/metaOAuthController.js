import { logger } from '../utils/logger.js'
import { resolvePublicServiceBaseUrl } from '../utils/publicUrl.js'
import {
  completeMetaOAuthConnection,
  createMetaOAuthConnectionUrl,
  disconnectMetaOAuthConnection,
  finalizeMetaOAuthConnection,
  getMetaOAuthConnectionStatus
} from '../services/metaOAuthService.js'

function publicBaseUrl(req) {
  return resolvePublicServiceBaseUrl(req, [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL
  ])
}

function errorResponse(res, error, fallback) {
  const statusCode = Number(error?.statusCode) || 500
  return res.status(statusCode).json({
    success: false,
    code: error?.code || 'META_OAUTH_ERROR',
    error: error?.message || fallback
  })
}

export async function getMetaOAuthStatus(req, res) {
  try {
    const data = await getMetaOAuthConnectionStatus()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error consultando Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo consultar la conexión OAuth de Meta')
  }
}

export async function createMetaOAuthConnectUrl(req, res) {
  try {
    const data = await createMetaOAuthConnectionUrl({
      returnPath: req.body?.returnPath || req.body?.return_path || '/settings/meta-ads/token'
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo crear URL Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo iniciar la conexión con Meta')
  }
}

export async function completeMetaOAuth(req, res) {
  try {
    const data = await completeMetaOAuthConnection({
      code: req.body?.code,
      configId: req.body?.configId || req.body?.config_id,
      handoffToken:
        req.body?.handoffToken ||
        req.body?.handoff_token ||
        req.body?.meta_oauth_handoff_token,
      returnPath: req.body?.returnPath || req.body?.return_path || '/settings/meta-ads/token'
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo completar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo completar la autorización de Meta')
  }
}

export async function finalizeMetaOAuth(req, res) {
  try {
    const data = await finalizeMetaOAuthConnection({
      sessionId: req.body?.sessionId || req.body?.session_id,
      businessId: req.body?.businessId || req.body?.business_id,
      adAccountId: req.body?.adAccountId || req.body?.ad_account_id,
      pixelId: req.body?.pixelId || req.body?.pixel_id,
      pageId: req.body?.pageId || req.body?.page_id,
      instagramAccountId: req.body?.instagramAccountId || req.body?.instagram_account_id,
      publicBaseUrl: publicBaseUrl(req)
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo finalizar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo guardar la conexión OAuth de Meta')
  }
}

export async function disconnectMetaOAuth(req, res) {
  try {
    const data = await disconnectMetaOAuthConnection()
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo desconectar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo desconectar Meta OAuth')
  }
}
