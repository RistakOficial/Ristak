import {
  createBlock,
  createSite,
  createSiteWithAI,
  createSubmissionFromRequest,
  deleteBlock,
  deleteSite,
  getRequestHost,
  getSite,
  getSitePreview,
  isDashboardHost,
  listSites,
  refreshSiteRenderDomain,
  renderDomainErrorHtml,
  renderPublicSiteHtml,
  reorderBlocks,
  resolveConnectedPublicDomainForHost,
  resolvePublicSiteForHost,
  updateBlock,
  updateSite
} from '../services/sitesService.js'
import {
  getPublicCalendarBySlug,
  renderPublicCalendarHtml
} from '../services/localCalendarService.js'
import { logger } from '../utils/logger.js'

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

export async function createSiteWithAIHandler(req, res) {
  try {
    const result = await createSiteWithAI({
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.status(result.status === 'created' ? 201 : 200).json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error creando site con IA: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error creando site con IA')
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

    res.status(200).type('html').send(await renderPublicSiteHtml(site, {
      pageId: req.query?.page,
      trackingEnabled: false
    }))
  } catch (error) {
    logger.error(`Error previsualizando site: ${error.message}`)
    sendError(res, error, 'Error previsualizando site')
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
    const result = await refreshSiteRenderDomain(req.params.siteId, req.body || {})
    if (!result) {
      return res.status(404).json({ success: false, error: 'Site no encontrado' })
    }

    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error verificando dominio de site: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
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

export async function publicSiteHostMiddleware(req, res, next) {
  try {
    if (
      req.path === '/api/health' ||
      req.path === '/api/sites/public/submit' ||
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

    const resolution = await resolvePublicSiteForHost(host)
    if (resolution.ok) {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
        return sendDomainError(req, res, 404, 'La API privada no esta disponible en dominios publicos de Sites')
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible en este dominio publico')
      }

      return res.status(200).type('html').send(await renderPublicSiteHtml(resolution.site, {
        pageId: req.query?.page,
        trackingEnabled: true
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
