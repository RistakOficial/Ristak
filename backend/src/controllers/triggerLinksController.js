import { logger } from '../utils/logger.js'
import {
  archiveTriggerLink,
  createTriggerLink,
  listTriggerLinkEvents,
  listTriggerLinks,
  recordTriggerLinkClick,
  updateTriggerLink
} from '../services/triggerLinksService.js'

function getRequestBaseUrl(req) {
  const host = req.get?.('host') || req.headers?.host || ''
  if (!host) return ''
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || (host.includes('localhost') ? 'http' : 'https')
  return `${protocol}://${host}`
}

function getRequestUserId(req) {
  return req.user?.userId || req.user?.id || null
}

function sendError(res, error, fallback = 'Error procesando enlaces de disparo') {
  res.status(error.status || 500).json({
    success: false,
    error: error.message || fallback
  })
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export async function listTriggerLinksHandler(req, res) {
  try {
    const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true'
    const links = await listTriggerLinks({
      includeArchived,
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: links })
  } catch (error) {
    logger.error(`Error listando enlaces de disparo: ${error.message}`)
    sendError(res, error, 'Error al obtener enlaces de disparo')
  }
}

export async function createTriggerLinkHandler(req, res) {
  try {
    const link = await createTriggerLink(req.body || {}, {
      userId: getRequestUserId(req),
      baseUrl: getRequestBaseUrl(req)
    })
    res.status(201).json({ success: true, data: link })
  } catch (error) {
    logger.error(`Error creando enlace de disparo: ${error.message}`)
    sendError(res, error, 'Error al crear enlace de disparo')
  }
}

export async function updateTriggerLinkHandler(req, res) {
  try {
    const link = await updateTriggerLink(req.params.triggerLinkId, req.body || {}, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: link })
  } catch (error) {
    logger.error(`Error actualizando enlace de disparo: ${error.message}`)
    sendError(res, error, 'Error al actualizar enlace de disparo')
  }
}

export async function deleteTriggerLinkHandler(req, res) {
  try {
    const link = await archiveTriggerLink(req.params.triggerLinkId, {
      baseUrl: getRequestBaseUrl(req)
    })
    res.json({ success: true, data: link })
  } catch (error) {
    logger.error(`Error eliminando enlace de disparo: ${error.message}`)
    sendError(res, error, 'Error al eliminar enlace de disparo')
  }
}

export async function listTriggerLinkEventsHandler(req, res) {
  try {
    const events = await listTriggerLinkEvents(req.params.triggerLinkId, {
      limit: req.query?.limit
    })
    res.json({ success: true, data: events })
  } catch (error) {
    logger.error(`Error listando disparos de enlace: ${error.message}`)
    sendError(res, error, 'Error al obtener disparos del enlace')
  }
}

export async function redirectTriggerLinkHandler(req, res) {
  try {
    const result = await recordTriggerLinkClick(req.params.publicId, req)
    res.setHeader('Cache-Control', 'no-store')
    return res.redirect(302, result.destinationUrl)
  } catch (error) {
    const status = error.status || 500
    const message = error.message || 'Enlace de disparo no disponible'
    if (String(req.headers?.accept || '').includes('application/json')) {
      return res.status(status).json({ success: false, error: message })
    }
    return res.status(status).type('html').send(`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Enlace no disponible</title>
  </head>
  <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #0f172a;">
    <h1 style="font-size: 22px; margin: 0 0 8px;">Enlace no disponible</h1>
    <p style="margin: 0; color: #475569;">${escapeHtml(message)}</p>
  </body>
</html>`)
  }
}
