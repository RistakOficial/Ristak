import crypto from 'crypto'
import {
  createBlock,
  createImportedSiteFromHtml,
  createMetaPageEventFromRequest,
  createSite,
  createSiteWithAIHtml,
  createSubmissionFromRequest,
  deleteBlock,
  deleteSite,
  getRequestHost,
  getImportedSiteBySiteId,
  getImportedSiteAssetResponse,
  getSite,
  getSitePreview,
  getSitesPublicDomain,
  isDashboardHost,
  listSites,
  refreshSitesPublicDomain,
  removeSitesPublicDomain,
  renderDomainErrorHtml,
  renderPublicSiteHtml,
  reorderBlocks,
  resolveConnectedPublicDomainForHost,
  resolvePublicSiteForHost,
  restoreBlocks,
  updateBlock,
  updateImportedSiteEditableContent,
  updateImportedSiteHtmlWithAI,
  updateImportedSiteFormMappings,
  updateSite
} from '../services/sitesService.js'
import {
  getPublicCalendarBySlug,
  renderPublicCalendarHtml
} from '../services/localCalendarService.js'
import { logger } from '../utils/logger.js'

const SITE_PREVIEW_TTL_MS = 60 * 60 * 1000
const sitePreviewSessions = new Map()

function getPreviewUserId(req) {
  return String(req.user?.userId || req.user?.id || req.user?.email || 'user')
}

function cleanupPreviewSessions() {
  const now = Date.now()
  for (const [token, session] of sitePreviewSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= now) {
      sitePreviewSessions.delete(token)
    }
  }
}

function getPreviewCookieName(token) {
  return `rstk_site_preview_${String(token || '').slice(0, 18).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=')
      if (separatorIndex < 0) return acc
      const key = part.slice(0, separatorIndex)
      const value = part.slice(separatorIndex + 1)
      acc[key] = decodeURIComponent(value || '')
      return acc
    }, {})
}

function getRequestOrigin(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${protocol}://${host}` : ''
}

function setPreviewCookie(req, res, token) {
  const cookieName = getPreviewCookieName(token)
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: SITE_PREVIEW_TTL_MS,
    path: '/api/sites'
  })
}

function sendError(res, error, fallback = 'Error procesando solicitud') {
  const status = error.status || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback
  })
}

export async function getSitesHandler(req, res) {
  try {
    res.json({ success: true, data: await listSites() })
  } catch (error) {
    logger.error(`Error listando sites: ${error.message}`)
    sendError(res, error, 'Error listando sites')
  }
}

export async function createSiteHandler(req, res) {
  try {
    const site = await createSite(req.body || {})
    res.status(201).json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error creando site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error creando site')
  }
}

export async function createSiteWithAIHtmlHandler(req, res) {
  try {
    const result = await createSiteWithAIHtml({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.status(result.status === 'created' ? 201 : 200).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando HTML con IA: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error creando HTML con IA')
  }
}

export async function importSiteHtmlHandler(req, res) {
  try {
    const result = await createImportedSiteFromHtml({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error importando HTML de site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error importando HTML')
  }
}

export async function updateImportedSiteHtmlWithAIHandler(req, res) {
  try {
    const result = await updateImportedSiteHtmlWithAI(req.params.siteId, {
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error editando HTML importado con IA: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error editando HTML con IA')
  }
}

export async function updateImportedSiteEditableContentHandler(req, res) {
  try {
    const result = await updateImportedSiteEditableContent(req.params.siteId, {
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error editando contenido HTML importado: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error editando contenido HTML')
  }
}

export async function importedSiteAssetHandler(req, res) {
  try {
    const assetPath = req.params[0] || ''
    const result = await getImportedSiteAssetResponse(req.params.siteId, assetPath, {
      trackingEnabled: !isTrackingBypassRequest(req)
    })

    if (!result) {
      return res.status(404).type('text/plain').send('Archivo no encontrado')
    }

    res.set('Cache-Control', result.cacheControl)
    if (result.redirectUrl) {
      return res.redirect(302, result.redirectUrl)
    }

    res.set('Content-Type', result.contentType)
    return res.status(200).send(result.body)
  } catch (error) {
    logger.error(`Error sirviendo asset importado de site: ${error.message}`)
    return res.status(error.status || 500).type('text/plain').send(error.message || 'No se pudo abrir el archivo')
  }
}

export async function getImportedSiteMappingHandler(req, res) {
  try {
    const result = await getImportedSiteBySiteId(req.params.siteId)
    if (!result) {
      return res.status(404).json({ success: false, error: 'Importacion no encontrada' })
    }
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error obteniendo mapeo de HTML importado: ${error.message}`)
    sendError(res, error, 'Error obteniendo mapeo')
  }
}

export async function updateImportedSiteMappingHandler(req, res) {
  try {
    const result = await updateImportedSiteFormMappings(req.params.siteId, req.body || {})
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error actualizando mapeo de HTML importado: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error actualizando mapeo')
  }
}

export async function getSiteHandler(req, res) {
  try {
    const site = await getSite(req.params.siteId, {
      includeBlocks: true,
      includeSubmissions: true
    })

    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error obteniendo site: ${error.message}`)
    sendError(res, error, 'Error obteniendo site')
  }
}

export async function previewSiteHandler(req, res) {
  try {
    const site = await getSitePreview(req.params.siteId)
    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.set('Cache-Control', 'no-store')
    res.status(200).type('html').send(await renderPublicSiteHtml(site, {
      pageId: req.query?.page,
      trackingEnabled: false,
      preview: true
    }))
  } catch (error) {
    logger.error(`Error previsualizando site: ${error.message}`)
    sendError(res, error, 'Error previsualizando site')
  }
}

export async function createPreviewSessionHandler(req, res) {
  try {
    const site = await getSitePreview(req.params.siteId)
    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    cleanupPreviewSessions()
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + SITE_PREVIEW_TTL_MS
    const pageId = String(req.body?.pageId || req.query?.page || '')

    sitePreviewSessions.set(token, {
      token,
      siteId: site.id,
      userId: getPreviewUserId(req),
      pageId,
      expiresAt
    })
    setPreviewCookie(req, res, token)

    const params = new URLSearchParams()
    if (pageId) params.set('page', pageId)
    const origin = getRequestOrigin(req)
    const path = `/api/sites/${encodeURIComponent(site.id)}/preview-session/${encodeURIComponent(token)}`
    const url = `${origin}${path}${params.toString() ? `?${params.toString()}` : ''}`

    res.json({
      success: true,
      data: {
        url,
        expiresAt: new Date(expiresAt).toISOString()
      }
    })
  } catch (error) {
    logger.error(`Error creando preview temporal de site: ${error.message}`)
    sendError(res, error, 'Error creando preview temporal')
  }
}

export async function previewSiteSessionHandler(req, res) {
  try {
    cleanupPreviewSessions()
    const token = String(req.params.token || '')
    const session = sitePreviewSessions.get(token)
    const cookieValue = parseCookies(req)[getPreviewCookieName(token)]

    if (!session || session.siteId !== req.params.siteId || cookieValue !== token) {
      return res.status(403).type('html').send('Preview expirado o no autorizado')
    }

    const site = await getSitePreview(req.params.siteId)
    if (!site) {
      return res.status(404).type('html').send('Site no encontrado')
    }

    res.set('Cache-Control', 'no-store')
    res.status(200).type('html').send(await renderPublicSiteHtml(site, {
      pageId: req.query?.page || session.pageId,
      trackingEnabled: false,
      preview: true
    }))
  } catch (error) {
    logger.error(`Error previsualizando sesion temporal de site: ${error.message}`)
    return res.status(500).type('html').send('Error previsualizando site')
  }
}

export async function previewCalendarHandler(req, res) {
  try {
    const calendar = await getPublicCalendarBySlug(req.params.slug)
    if (!calendar) {
      return res.status(404).type('html').send('Calendario no encontrado o inactivo')
    }

    return res.status(200).type('html').send(renderPublicCalendarHtml(calendar, {
      host: getRequestHost(req) || ''
    }))
  } catch (error) {
    logger.error(`Error previsualizando calendario de site: ${error.message}`)
    return res.status(500).type('html').send('No se pudo previsualizar el calendario')
  }
}

export async function updateSiteHandler(req, res) {
  try {
    const site = await updateSite(req.params.siteId, req.body || {})

    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error actualizando site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error actualizando site')
  }
}

export async function deleteSiteHandler(req, res) {
  try {
    const deleted = await deleteSite(req.params.siteId)
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.status(204).send()
  } catch (error) {
    logger.error(`Error eliminando site: ${error.message}`)
    sendError(res, error, 'Error eliminando site')
  }
}

export async function createBlockHandler(req, res) {
  try {
    const site = await createBlock(req.params.siteId, req.body || {})
    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.status(201).json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error creando bloque de site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error creando bloque')
  }
}

export async function updateBlockHandler(req, res) {
  try {
    const site = await updateBlock(req.params.siteId, req.params.blockId, req.body || {})
    if (!site) {
      return res.status(404).json({ success: false, error: 'Bloque no encontrado' })
    }

    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error actualizando bloque de site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error actualizando bloque')
  }
}

export async function deleteBlockHandler(req, res) {
  try {
    const site = await deleteBlock(req.params.siteId, req.params.blockId)
    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error eliminando bloque de site: ${error.message}`)
    sendError(res, error, 'Error eliminando bloque')
  }
}

export async function restoreBlocksHandler(req, res) {
  try {
    const site = await restoreBlocks(req.params.siteId, req.body?.blocks || [])
    if (!site) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error restaurando bloques de site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error restaurando bloques')
  }
}

export async function reorderBlocksHandler(req, res) {
  try {
    const site = await reorderBlocks(req.params.siteId, req.body?.blockIds || [], {
      pageId: req.body?.pageId
    })
    res.json({ success: true, data: site })
  } catch (error) {
    logger.error(`Error ordenando bloques de site: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error ordenando bloques')
  }
}

export async function verifySiteDomainHandler(req, res) {
  try {
    const result = await refreshSitesPublicDomain(req.body || {})
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error verificando dominio de site: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
  }
}

export async function getSitesDomainHandler(req, res) {
  try {
    res.json({ success: true, data: await getSitesPublicDomain() })
  } catch (error) {
    logger.error(`Error obteniendo dominio publico de Sites: ${error.message}`)
    sendError(res, error, 'Error obteniendo dominio')
  }
}

export async function verifySitesDomainHandler(req, res) {
  try {
    const result = await refreshSitesPublicDomain(req.body || {})
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error verificando dominio publico de Sites: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
  }
}

export async function removeSitesDomainHandler(req, res) {
  try {
    res.json({ success: true, data: await removeSitesPublicDomain() })
  } catch (error) {
    logger.error(`Error eliminando dominio publico de Sites: ${error.message}`)
    sendError(res, error, 'Error eliminando dominio')
  }
}

export async function submitPublicSiteHandler(req, res) {
  try {
    const result = await createSubmissionFromRequest(req, req.body || {})
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Submit publico rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo enviar el formulario')
  }
}

export async function metaPageEventPublicHandler(req, res) {
  try {
    const result = await createMetaPageEventFromRequest(req, req.body || {})
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Evento publico de pagina Site rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo enviar el evento de pagina')
  }
}

function wantsJson(req) {
  return req.path.startsWith('/api') || String(req.headers.accept || '').includes('application/json')
}

function sendDomainError(req, res, status, message) {
  const host = getRequestHost(req)
  if (wantsJson(req)) {
    return res.status(status).json({
      success: false,
      error: message,
      host
    })
  }

  return res.status(status).type('html').send(renderDomainErrorHtml({ host, message }))
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function isTrackingBypassRequest(req) {
  const queryFlag = String(req.query?.test || req.query?.tracking || '').toLowerCase()
  if (queryFlag === '1' || queryFlag === 'true' || queryFlag === 'test' || queryFlag === 'preview') {
    return true
  }

  return req.path
    .split('/')
    .filter(Boolean)
    .map(segment => decodePathSegment(segment).toLowerCase())
    .includes('test')
}

export async function publicSiteHostMiddleware(req, res, next) {
  try {
    if (
      req.path === '/api/health' ||
      req.path === '/api/sites/public/submit' ||
      req.path === '/api/sites/public/meta-event' ||
      req.path.startsWith('/api/sites/public/calendar-preview/') ||
      req.path.startsWith('/api/sites/public/imported-assets/') ||
      req.path === '/snip.js' ||
      req.path === '/collect' ||
      req.path === '/sync-visitor' ||
      req.path === '/link-visitor' ||
      req.path.startsWith('/api/calendars/public/')
    ) {
      return next()
    }

    const host = getRequestHost(req)
    if (!host) return next()

    const calendarMatch = req.path.match(/^\/calendars?\/([^/?#]+)/i)
    if (calendarMatch) {
      const domainResolution = await resolveConnectedPublicDomainForHost(host)
      if (!domainResolution.ok) {
        return sendDomainError(req, res, domainResolution.status || 404, domainResolution.message)
      }

      const calendar = await getPublicCalendarBySlug(calendarMatch[1])
      if (!calendar) {
        return sendDomainError(req, res, 404, 'Calendario no encontrado o inactivo')
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible en este calendario publico')
      }

      return res.status(200).type('html').send(renderPublicCalendarHtml(calendar, { host }))
    }

    const resolution = await resolvePublicSiteForHost(host, { path: req.path })
    if (resolution.ok) {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
        return sendDomainError(req, res, 404, 'La API privada no esta disponible en dominios publicos de Sites')
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible en este dominio publico')
      }

      // First path segment is the site slug; the rest is the page path used by
      // website-mode sites to resolve a (sub)page. Drop a trailing /test bypass marker.
      const pathSegments = String(req.path || '').split('/').map(segment => decodePathSegment(segment)).filter(Boolean)
      const pagePath = pathSegments.slice(1)
      if (pagePath.length && pagePath[pagePath.length - 1].toLowerCase() === 'test') pagePath.pop()

      return res.status(200).type('html').send(await renderPublicSiteHtml(resolution.site, {
        pageId: req.query?.page,
        pagePath,
        trackingEnabled: !isTrackingBypassRequest(req)
      }))
    }

    if (resolution.reason !== 'domain_not_configured') {
      return sendDomainError(req, res, resolution.status || 404, resolution.message)
    }

    if (isDashboardHost(host) || process.env.NODE_ENV !== 'production') {
      return next()
    }

    return sendDomainError(req, res, 404, 'Este dominio no esta configurado como dashboard ni como Site publico verificado')
  } catch (error) {
    logger.error(`Error resolviendo dominio publico: ${error.message}`)
    return sendDomainError(req, res, 500, 'Error resolviendo configuracion del dominio')
  }
}
