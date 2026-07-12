import { logger } from '../utils/logger.js'
import { resolvePublicServiceBaseUrl } from '../utils/publicUrl.js'
import {
  completeMetaOAuthConnection,
  createMetaOAuthConnectionUrl,
  disconnectMetaOAuthConnection,
  finalizeMetaOAuthConnection,
  getMetaOAuthConnectionStatus
} from '../services/metaOAuthService.js'
import {
  completeMetaOAuthIntegration,
  createMetaOAuthIntegrationUrl,
  disconnectMetaOAuthIntegration,
  finalizeMetaOAuthIntegration,
  getMetaOAuthIntegrationStatus
} from '../services/metaOAuthIntegrationService.js'

function integrationKind(req) {
  return req.params?.integrationKind || req.body?.integrationKind || req.body?.integration_kind || ''
}

function defaultReturnPath(kind) {
  if (!kind) return '/settings/meta-ads/cuenta'
  return kind === 'social' ? '/settings/meta-ads/redes-sociales' : '/settings/meta-ads/ads'
}

function publicBaseUrl(req) {
  return resolvePublicServiceBaseUrl(req, [
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL
  ])
}

function safeReturnPath(value, fallback) {
  const requested = String(value || '').trim()
  const safeFallback = String(fallback || '/settings/meta-ads/ads').trim()
  if (
    !requested.startsWith('/') ||
    requested.startsWith('//') ||
    requested.startsWith('/api/') ||
    /[\\\u0000-\u001f\u007f]/.test(requested)
  ) {
    return safeFallback
  }
  return requested
}

export function buildMetaOAuthReturnUrl(req, value, fallback) {
  const returnPath = safeReturnPath(value, fallback)
  const baseUrl = publicBaseUrl(req)
  if (!baseUrl) return returnPath
  return new URL(returnPath, `${baseUrl}/`).toString()
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
    const kind = integrationKind(req)
    const data = kind
      ? await getMetaOAuthIntegrationStatus(kind)
      : await getMetaOAuthConnectionStatus()
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error consultando Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo consultar la conexión OAuth de Meta')
  }
}

export async function createMetaOAuthConnectUrl(req, res) {
  try {
    const kind = integrationKind(req)
    const fallbackReturnPath = defaultReturnPath(kind)
    const returnPath = buildMetaOAuthReturnUrl(
      req,
      req.body?.returnPath || req.body?.return_path || fallbackReturnPath,
      fallbackReturnPath
    )
    const data = kind
      ? await createMetaOAuthIntegrationUrl({ integrationKind: kind, returnPath })
      : await createMetaOAuthConnectionUrl({ returnPath })
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo crear URL Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo iniciar la conexión con Meta')
  }
}

export async function completeMetaOAuth(req, res) {
  try {
    const kind = integrationKind(req)
    const fallbackReturnPath = defaultReturnPath(kind)
    const options = {
      integrationKind: kind,
      code: req.body?.code,
      configId: req.body?.configId || req.body?.config_id,
      handoffToken:
        req.body?.handoffToken ||
        req.body?.handoff_token ||
        req.body?.meta_oauth_handoff_token,
      returnPath: buildMetaOAuthReturnUrl(
        req,
        req.body?.returnPath || req.body?.return_path || fallbackReturnPath,
        fallbackReturnPath
      )
    }
    const data = kind
      ? await completeMetaOAuthIntegration(options)
      : await completeMetaOAuthConnection(options)
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo completar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo completar la autorización de Meta')
  }
}

export async function finalizeMetaOAuth(req, res) {
  try {
    const kind = integrationKind(req)
    const options = {
      integrationKind: kind,
      sessionId: req.body?.sessionId || req.body?.session_id,
      businessId: req.body?.businessId || req.body?.business_id,
      adAccountId: req.body?.adAccountId || req.body?.ad_account_id,
      pixelId: req.body?.pixelId ?? req.body?.pixel_id,
      datasetId: req.body?.datasetId ?? req.body?.dataset_id,
      pageId: req.body?.pageId || req.body?.page_id,
      instagramAccountId: req.body?.instagramAccountId ?? req.body?.instagram_account_id,
      publicBaseUrl: publicBaseUrl(req)
    }
    const data = kind
      ? await finalizeMetaOAuthIntegration(options)
      : await finalizeMetaOAuthConnection(options)
    res.status(data?.repairPending ? 202 : 200).json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo finalizar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo guardar la conexión OAuth de Meta')
  }
}

export async function disconnectMetaOAuth(req, res) {
  try {
    const kind = integrationKind(req)
    const data = kind
      ? await disconnectMetaOAuthIntegration(kind)
      : await disconnectMetaOAuthConnection({ publicBaseUrl: publicBaseUrl(req) })
    res.json({ success: true, data })
  } catch (error) {
    logger.warn(`No se pudo desconectar Meta OAuth: ${error.message}`)
    errorResponse(res, error, 'No se pudo desconectar Meta OAuth')
  }
}
