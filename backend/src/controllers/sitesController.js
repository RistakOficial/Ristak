import crypto from 'crypto'
import {
  buildPreviewSiteDraft,
  buildCalendarMetaPixelSnippet,
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
  getPublicSitePaymentStatus,
  initSitePaymentCheckout,
  getSitesFontCss,
  getSitesFontFile,
  getSite,
  getSitesDomainSettings,
  getSitePreview,
  getSitesTrackingSummary,
  isDashboardHost,
  createSiteFolder,
  listSiteFolders,
  listSites,
  refreshSitesAppDomain,
  refreshSitesPublicDomain,
  removeSitesAppDomain,
  removeSitesPublicDomain,
  renderDomainErrorHtml,
  renderPublicSiteHtml,
  reorderBlocks,
  resolveConnectedAppDomainForHost,
  resolvePublicCalendarHostForHost,
  resolvePublicPrefillContact,
  resolvePublicSiteForHost,
  restoreBlocks,
  setSitesPublicDefaultRoute,
  shouldBlockCrmOnPublicCalendarFallbackHost,
  updateBlock,
  updateSiteFolder,
  updateImportedSiteEditableContent,
  updateImportedSiteCodeFiles,
  updateImportedSiteHtmlWithAI,
  updateImportedSiteFormMappings,
  updateSite
} from '../services/sitesService.js'
import {
  getCalendarBookingFormDefinition,
  getPublicCalendarBySlug,
  renderPublicCalendarHtml
} from '../services/localCalendarService.js'
import {
  getMediaAssetBunnyStreamAnalytics,
  listMediaAssets
} from '../services/mediaStorageService.js'
import { getVideoPlaybackAggregate, getVideoPlaybackViewers } from '../services/videoTrackingService.js'
import { logger } from '../utils/logger.js'
import { requestHasNoTrack } from '../utils/noTracking.js'

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

function parseCalendarMetaParameters(value) {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getPreviewCookieName(token) {
  return `rstk_site_preview_${String(token || '').slice(0, 18).replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function getPreviewSiteId(body = {}) {
  return String(body.siteId || body.site_id || '').trim()
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

function getPreviewSessionFromRequest(req, siteId = '') {
  cleanupPreviewSessions()
  const requestedSiteId = String(siteId || '').trim()
  if (!requestedSiteId) return null

  const cookies = parseCookies(req)
  for (const [cookieName, cookieValue] of Object.entries(cookies)) {
    if (!cookieName.startsWith('rstk_site_preview_')) continue
    const token = String(cookieValue || '')
    const session = sitePreviewSessions.get(token)
    if (session?.token === token && session.siteId === requestedSiteId) {
      return session
    }
  }

  return null
}

async function getPreviewContextForPublicRequest(req, body = {}) {
  const siteId = getPreviewSiteId(body)
  const session = getPreviewSessionFromRequest(req, siteId)
  if (!session) return null

  const host = getRequestHost(req)
  if (!host) return null
  if (isDashboardHost(host)) {
    return { siteId: session.siteId, pageId: session.pageId, token: session.token, host }
  }

  const appDomainResolution = await resolveConnectedAppDomainForHost(host)
  if (appDomainResolution.ok) {
    return { siteId: session.siteId, pageId: session.pageId, token: session.token, host }
  }

  return null
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

export async function sitesFontCssHandler(_req, res) {
  try {
    const css = await getSitesFontCss()
    res.setHeader('Cache-Control', 'public, max-age=43200')
    res.type('text/css; charset=utf-8').send(css)
  } catch (error) {
    logger.error(`Error sirviendo fuentes de Sites: ${error.message}`)
    sendError(res, error, 'Error sirviendo fuentes de Sites')
  }
}

export async function sitesFontFileHandler(req, res) {
  try {
    const font = await getSitesFontFile(req.query?.url)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.type(font.contentType || 'font/woff2').send(font.buffer)
  } catch (error) {
    logger.error(`Error sirviendo archivo de fuente de Sites: ${error.message}`)
    sendError(res, error, 'Error sirviendo archivo de fuente')
  }
}

export async function getSitesHandler(req, res) {
  try {
    res.json({ success: true, data: await listSites() })
  } catch (error) {
    logger.error(`Error listando sites: ${error.message}`)
    sendError(res, error, 'Error listando sites')
  }
}

export async function getSiteFoldersHandler(req, res) {
  try {
    res.json({ success: true, data: await listSiteFolders() })
  } catch (error) {
    logger.error(`Error listando carpetas de sites: ${error.message}`)
    sendError(res, error, 'Error listando carpetas')
  }
}

export async function createSiteFolderHandler(req, res) {
  try {
    const folder = await createSiteFolder(req.body || {})
    res.status(201).json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error creando carpeta de sites: ${error.message}`)
    sendError(res, error, 'Error creando carpeta')
  }
}

export async function updateSiteFolderHandler(req, res) {
  try {
    const folder = await updateSiteFolder(req.params.folderId, req.body || {})
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Carpeta no encontrada' })
    }
    res.json({ success: true, data: folder })
  } catch (error) {
    logger.error(`Error actualizando carpeta de sites: ${error.message}`)
    sendError(res, error, 'Error actualizando carpeta')
  }
}

export async function getSitesVideoAssetsHandler(req, res) {
  try {
    const assets = []
    const pageSize = 250
    let offset = 0
    while (true) {
      const page = await listMediaAssets({
        businessId: req.query.businessId || 'default',
        mediaType: 'video',
        status: req.query.status || 'ready',
        limit: pageSize,
        offset
      })
      assets.push(...page)
      if (page.length < pageSize) break
      offset += pageSize
    }
    const siteVideos = assets.filter((asset) => {
      const module = String(asset.module || '').toLowerCase()
      const sourceModule = String(asset.metadata?.stream?.source?.module || '').toLowerCase()
      return module === 'sites' || module === 'forms' || sourceModule === 'sites' || sourceModule === 'forms'
    })
    res.json({ success: true, data: siteVideos })
  } catch (error) {
    logger.error(`Error listando videos de sites: ${error.message}`)
    sendError(res, error, 'Error listando videos de sites')
  }
}

export async function getSitesAnalyticsSummaryHandler(req, res) {
  try {
    const body = req.body || {}
    const dateFrom = body.dateFrom || body.date_from
    const dateTo = body.dateTo || body.date_to
    const [siteTracking, videoTracking] = await Promise.all([
      getSitesTrackingSummary({
        siteIds: body.siteIds || body.site_ids || [],
        dateFrom,
        dateTo
      }),
      getVideoPlaybackAggregate({
        assetIds: body.videoAssetIds || body.video_asset_ids || [],
        dateFrom,
        dateTo,
        hourly: body.hourly
      })
    ])

    res.json({
      success: true,
      data: {
        dateFrom: siteTracking.dateFrom || videoTracking.dateFrom || '',
        dateTo: siteTracking.dateTo || videoTracking.dateTo || '',
        sites: siteTracking.bySiteId,
        videos: videoTracking
      }
    })
  } catch (error) {
    logger.error(`Error obteniendo resumen de analíticas de sites: ${error.message}`)
    sendError(res, error, 'Error obteniendo resumen de analíticas')
  }
}

export async function getSitesVideoAnalyticsHandler(req, res) {
  try {
    const dateFrom = req.query.dateFrom || req.query.date_from
    const dateTo = req.query.dateTo || req.query.date_to
    const [analytics, firstPartyTracking] = await Promise.all([
      getMediaAssetBunnyStreamAnalytics(req.params.assetId, {
        dateFrom,
        dateTo,
        hourly: req.query.hourly
      }),
      getVideoPlaybackViewers({
        assetId: req.params.assetId,
        dateFrom,
        dateTo,
        hourly: req.query.hourly,
        limit: req.query.viewerLimit || req.query.viewer_limit || 50
      })
    ])
    res.json({
      success: true,
      data: {
        ...analytics,
        firstPartyTracking
      }
    })
  } catch (error) {
    logger.error(`Error obteniendo analíticas de video de sites: ${error.message}`)
    sendError(res, error, 'Error obteniendo analíticas de video')
  }
}

export async function getSitesVideoViewersHandler(req, res) {
  try {
    const viewers = await getVideoPlaybackViewers({
      assetId: req.params.assetId,
      streamVideoId: req.query.streamVideoId || req.query.stream_video_id,
      siteId: req.query.siteId || req.query.site_id,
      dateFrom: req.query.dateFrom || req.query.date_from,
      dateTo: req.query.dateTo || req.query.date_to,
      limit: req.query.limit,
      offset: req.query.offset
    })
    res.json({ success: true, data: viewers })
  } catch (error) {
    logger.error(`Error obteniendo espectadores de video de sites: ${error.message}`)
    sendError(res, error, 'Error obteniendo espectadores de video')
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

export async function updateImportedSiteCodeFilesHandler(req, res) {
  try {
    const result = await updateImportedSiteCodeFiles(req.params.siteId, {
      ...(req.body || {}),
      userId: req.user?.userId || req.user?.id
    })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error editando archivos HTML importados: ${error.message}`)
    error.status = error.status || 400
    sendError(res, error, 'Error editando archivos HTML')
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
    const draftSite = await buildPreviewSiteDraft(site, req.body?.draftSite)

    cleanupPreviewSessions()
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + SITE_PREVIEW_TTL_MS
    const pageId = String(req.body?.pageId || req.query?.page || '')

    sitePreviewSessions.set(token, {
      token,
      siteId: site.id,
      userId: getPreviewUserId(req),
      pageId,
      siteSnapshot: draftSite || null,
      expiresAt
    })
    setPreviewCookie(req, res, token)

    const params = new URLSearchParams()
    if (pageId) params.set('page', pageId)
    params.set('no_track', '1')
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

    const site = session.siteSnapshot || await getSitePreview(req.params.siteId)
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
    logger.error(`Error previsualizando sesión temporal de site: ${error.message}`)
    return res.status(500).type('html').send('Error previsualizando site')
  }
}

export async function previewCalendarHandler(req, res) {
  try {
    const calendar = await getPublicCalendarBySlug(req.params.slug)
    if (!calendar) {
      return res.status(404).type('html').send('Calendario no encontrado o inactivo')
    }
    const bookingForm = await getCalendarBookingFormDefinition(calendar)

    return res.status(200).type('html').send(renderPublicCalendarHtml(calendar, {
      host: getRequestHost(req) || '',
      embedded: req.query?.embed === '1' || req.query?.test === '1',
      style: req.query || {},
      bookingForm,
      preview: req.query?.editor_preview === '1' || req.query?.preview === '1',
      metaPixelSnippet: ''
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
    res.json({ success: true, data: await getSitesDomainSettings({ publicConfig: result }) })
  } catch (error) {
    logger.error(`Error verificando dominio de site: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
  }
}

export async function getSitesDomainHandler(req, res) {
  try {
    res.json({ success: true, data: await getSitesDomainSettings() })
  } catch (error) {
    logger.error(`Error obteniendo dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error obteniendo dominio')
  }
}

export async function verifySitesDomainHandler(req, res) {
  try {
    const result = await refreshSitesPublicDomain(req.body || {})
    res.json({ success: true, data: await getSitesDomainSettings({ publicConfig: result }) })
  } catch (error) {
    logger.error(`Error verificando dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
  }
}

export async function removeSitesDomainHandler(req, res) {
  try {
    const result = await removeSitesPublicDomain()
    res.json({ success: true, data: await getSitesDomainSettings({ publicConfig: result }) })
  } catch (error) {
    logger.error(`Error eliminando dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error eliminando dominio')
  }
}

export async function setSitesDefaultRouteHandler(req, res) {
  try {
    const result = await setSitesPublicDefaultRoute(req.body?.siteId || req.body?.site_id || '')
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error configurando ruta predeterminada de Sites: ${error.message}`)
    sendError(res, error, 'Error configurando ruta predeterminada')
  }
}

export async function verifySitesAppDomainHandler(req, res) {
  try {
    const result = await refreshSitesAppDomain(req.body || {})
    res.json({ success: true, data: await getSitesDomainSettings({ appConfig: result }) })
  } catch (error) {
    logger.error(`Error verificando dominio de app de Sites: ${error.message}`)
    sendError(res, error, 'Error verificando dominio de app')
  }
}

export async function removeSitesAppDomainHandler(req, res) {
  try {
    const result = await removeSitesAppDomain()
    res.json({ success: true, data: await getSitesDomainSettings({ appConfig: result }) })
  } catch (error) {
    logger.error(`Error eliminando dominio de app de Sites: ${error.message}`)
    sendError(res, error, 'Error eliminando dominio de app')
  }
}

export async function submitPublicSiteHandler(req, res) {
  try {
    const body = req.body || {}
    const previewContext = await getPreviewContextForPublicRequest(req, body)
    const result = await createSubmissionFromRequest(req, body, { previewContext })
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Submit público rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo enviar el formulario')
  }
}

export async function publicSiteContactPrefillHandler(req, res) {
  try {
    const contact = await resolvePublicPrefillContact({
      contactId: req.query?.contactId || req.query?.contact_id,
      visitorId: req.query?.visitorId || req.query?.visitor_id,
      sessionId: req.query?.sessionId || req.query?.session_id
    })

    res.status(200).json({ success: true, data: contact })
  } catch (error) {
    logger.warn(`Prefill publico de Sites rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo autollenar el contacto')
  }
}

export async function publicSitePaymentStatusHandler(req, res) {
  try {
    const result = await getPublicSitePaymentStatus(req.params.publicPaymentId)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Estado público de pago rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo consultar el pago')
  }
}

export async function sitePaymentCheckoutInitHandler(req, res) {
  try {
    const result = await initSitePaymentCheckout(req, req.body || {})
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Init de checkout embebido rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo preparar el pago')
  }
}

export async function metaPageEventPublicHandler(req, res) {
  try {
    const body = req.body || {}
    const previewContext = await getPreviewContextForPublicRequest(req, body)
    const result = await createMetaPageEventFromRequest(req, body, { previewContext })
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Evento público de página Site rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo enviar el evento de página')
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
  if (requestHasNoTrack(req)) return true

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
      req.path.startsWith('/api/sites/public/payments/') ||
      req.path === '/api/sites/public/fonts.css' ||
      req.path === '/api/sites/public/font-file' ||
      req.path.startsWith('/api/sites/public/calendar-preview/') ||
      req.path.startsWith('/api/sites/public/imported-assets/') ||
      req.path.startsWith('/api/stripe/public/payments/') ||
      req.path.startsWith('/api/conekta/public/payments/') ||
      req.path.startsWith('/api/mercadopago/public/payments/') ||
      req.path === '/snip.js' ||
      req.path === '/collect' ||
      req.path === '/video-event' ||
      req.path === '/sync-visitor' ||
      req.path === '/link-visitor' ||
      req.path.startsWith('/pay/') ||
      req.path.startsWith('/api/calendars/public/')
    ) {
      return next()
    }

    const host = getRequestHost(req)
    if (!host) return next()

    const appDomainResolution = await resolveConnectedAppDomainForHost(host)
    if (appDomainResolution.ok) {
      return next()
    }

    if (appDomainResolution.reason !== 'domain_not_configured') {
      return sendDomainError(req, res, appDomainResolution.status || 404, appDomainResolution.message)
    }

    const blockCrmOnCalendarFallbackHost = await shouldBlockCrmOnPublicCalendarFallbackHost(host)

    const calendarMatch = req.path.match(/^\/calendars?\/([^/?#]+)/i)
    if (calendarMatch) {
      const domainResolution = await resolvePublicCalendarHostForHost(host)
      if (!domainResolution.ok) {
        return sendDomainError(req, res, domainResolution.status || 404, domainResolution.message)
      }

      const calendar = await getPublicCalendarBySlug(calendarMatch[1])
      if (!calendar) {
        return sendDomainError(req, res, 404, 'Calendario no encontrado o inactivo')
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible en este calendario público')
      }
      const bookingForm = await getCalendarBookingFormDefinition(calendar)
      const isPreview = req.query?.editor_preview === '1' || req.query?.preview === '1'
      // Override del evento Meta propagado por el sitio contenedor (sitio = master del
      // calendario embebido). Solo se confia en el query param en contexto embebido.
      const calendarMetaOverride = (req.query?.embed === '1' || req.query?.test === '1') && typeof req.query?.metaCalEvent === 'string'
        ? req.query.metaCalEvent.trim()
        : ''
      const calendarMetaParameters = parseCalendarMetaParameters(req.query?.metaCalData)
      const metaPixelSnippet = await buildCalendarMetaPixelSnippet(calendar, {
        trackingEnabled: !requestHasNoTrack(req),
        preview: isPreview,
        siteOverride: calendarMetaOverride ? { eventName: calendarMetaOverride, parameters: calendarMetaParameters } : null
      })

      // No cachear el HTML público: cambios de pixel/tracking deben reflejarse
      // siempre tras un refresh (los assets sí se cachean por separado).
      res.set('Cache-Control', 'no-store')
      return res.status(200).type('html').send(renderPublicCalendarHtml(calendar, {
        host,
        embedded: req.query?.embed === '1' || req.query?.test === '1',
        style: req.query || {},
        bookingForm,
        preview: isPreview,
        metaPixelSnippet
      }))
    }

    const resolution = await resolvePublicSiteForHost(host, { path: req.path })
    if (resolution.ok) {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
        return sendDomainError(req, res, 404, 'La API privada no esta disponible en dominios públicos de Sites')
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible en este dominio público')
      }

      // First path segment is the site slug; the rest is the page path used by
      // website-mode sites to resolve a (sub)page. Drop a trailing /test bypass marker.
      const pathSegments = String(req.path || '').split('/').map(segment => decodePathSegment(segment)).filter(Boolean)
      const pagePath = pathSegments.slice(1)
      if (pagePath.length && pagePath[pagePath.length - 1].toLowerCase() === 'test') pagePath.pop()

      // No cachear el HTML público: cambios de pixel/tracking deben reflejarse
      // siempre tras un refresh (los assets sí se cachean por separado).
      res.set('Cache-Control', 'no-store')
      return res.status(200).type('html').send(await renderPublicSiteHtml(resolution.site, {
        pageId: req.query?.page,
        pagePath,
        trackingEnabled: !isTrackingBypassRequest(req)
      }))
    }

    if (resolution.reason !== 'domain_not_configured') {
      return sendDomainError(req, res, resolution.status || 404, resolution.message)
    }

    if (blockCrmOnCalendarFallbackHost) {
      return sendDomainError(req, res, 404, 'Este host solo sirve enlaces públicos de calendario.')
    }

    // (TRK-010) Hosts legítimos de dashboard (incluye localhost/127.0.0.1/::1,
    // *.localhost, *.local, *.onrender.com y DASHBOARD_DOMAINS) ya pasan por
    // isDashboardHost. En producción esto queda EXACTAMENTE igual: un host que
    // no es dashboard ni Site verificado recibe el 404 de abajo.
    if (isDashboardHost(host)) {
      return next()
    }

    // (TRK-010) Antes, en NODE_ENV !== 'production' CUALQUIER host desconocido
    // caía a next() y se servía como dashboard/CRM de forma silenciosa, lo que
    // podía atribuir/contar tráfico mal. Ahora el fallthrough en no-producción
    // requiere opt-in EXPLÍCITO (TRK_ALLOW_UNKNOWN_HOST_AS_DASHBOARD === '1') y
    // siempre deja rastro en logs. Producción no usa esta rama.
    if (process.env.NODE_ENV !== 'production') {
      if (process.env.TRK_ALLOW_UNKNOWN_HOST_AS_DASHBOARD === '1') {
        logger.warn(`(TRK-010) Host no configurado servido como dashboard por TRK_ALLOW_UNKNOWN_HOST_AS_DASHBOARD=1: host="${host}" path="${req.path}". No asumas atribución correcta para este host.`)
        return next()
      }
      logger.warn(`(TRK-010) Host no configurado como dashboard ni como Site público verificado: host="${host}" path="${req.path}". Se devuelve 404. Para servirlo como dashboard en dev, configura el host (DASHBOARD_DOMAINS) o exporta TRK_ALLOW_UNKNOWN_HOST_AS_DASHBOARD=1.`)
    }

    return sendDomainError(req, res, 404, 'Este dominio no esta configurado como dashboard ni como Site público verificado')
  } catch (error) {
    logger.error(`Error resolviendo dominio público: ${error.message}`)
    return sendDomainError(req, res, 500, 'Error resolviendo configuración del dominio')
  }
}
