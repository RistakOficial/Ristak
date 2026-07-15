import crypto from 'crypto'
import { pipeline } from 'node:stream/promises'
import {
  buildPreviewSiteDraft,
  buildCalendarMetaPixelSnippet,
  createBlock,
  createImportedSiteFromHtml,
  createMetaPageEventFromRequest,
  createSite,
  createSiteWithAIHtml,
  createSitesPublicDomain,
  createSubmissionFromRequest,
  deleteBlock,
  deleteSiteContentAsset,
  deleteSite,
  getRequestHost,
  getImportedSiteBySiteId,
  getImportedSiteAssetResponse,
  getPublicSiteContentAsset,
  getPublicSitePaymentStatus,
  initSitePaymentCheckout,
  paySiteCheckout,
  prepareSiteCheckoutInstallments,
  prepareSiteVideoStoragePreviews,
  getSitesFontCss,
  getSitesFontFile,
  getSite,
  getSitesVideoAsset,
  getSitesDomainSettings,
  getSitePreview,
  getSitesTrackingSummary,
  isDashboardHost,
  createSiteFolder,
  listSiteFolders,
  listSites,
  listSiteSelectors,
  listSitesVideoAssets,
  listSiteContentAssets,
  refreshSitesAppDomain,
  refreshSitesPublicDomain,
  refreshSitesPublicDomainById,
  removeSitesAppDomain,
  removeSitesPublicDomainById,
  removeSitesPublicDomain,
  renderDomainErrorHtml,
  renderPublicSiteHtml,
  reorderBlocks,
  resolveConnectedAppDomainForHost,
  resolvePublicCalendarHostForHost,
  resolvePublicPrefillContact,
  resolvePublicSiteForHost,
  restoreBlocks,
  setSitesPublicDomainDefaultRoute,
  setSitesPublicDefaultRoute,
  shouldBlockCrmOnPublicCalendarFallbackHost,
  saveSiteContentAsset,
  updateBlock,
  updateSiteFolder,
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
import { hasCalendarPaymentsFeature } from '../services/licenseService.js'
import {
  getMediaAssetBunnyStreamAnalytics,
  getMediaAssetDownloadFile
} from '../services/mediaStorageService.js'
import {
  isMetaPrivacyPolicyPath,
  renderMetaPrivacyPolicyHtml
} from '../services/publicMetaPrivacyPolicyService.js'
import { getVideoPlaybackAggregate, getVideoPlaybackViewers } from '../services/videoTrackingService.js'
import { logger } from '../utils/logger.js'
import { requestHasNoTrack } from '../utils/noTracking.js'
import { attachmentDisposition } from '../utils/contentDisposition.js'

const SITE_PREVIEW_TTL_MS = 60 * 60 * 1000
const sitePreviewSessions = new Map()

function calendarForPublicRender(calendar, canUseCalendarPayments) {
  if (canUseCalendarPayments) return calendar

  return {
    ...calendar,
    bookingPayment: {
      ...(calendar?.bookingPayment || calendar?.booking_payment || {}),
      enabled: false
    },
    booking_payment: {
      ...(calendar?.booking_payment || calendar?.bookingPayment || {}),
      enabled: false
    }
  }
}

function bookingFormForPublicRender(bookingForm, canUseCalendarPayments) {
  if (canUseCalendarPayments || !bookingForm) return bookingForm

  return {
    ...bookingForm,
    paymentGate: {
      ...(bookingForm.paymentGate || bookingForm.payment_gate || {}),
      enabled: false
    },
    payment_gate: {
      ...(bookingForm.payment_gate || bookingForm.paymentGate || {}),
      enabled: false
    },
    fields: Array.isArray(bookingForm.fields)
      ? bookingForm.fields.filter(field => field?.blockType !== 'payment' && field?.block_type !== 'payment')
      : bookingForm.fields
  }
}

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
    const view = String(req.query?.view || '').trim() || 'library'
    const hasFolderFilter = Object.prototype.hasOwnProperty.call(req.query || {}, 'folderId') ||
      Object.prototype.hasOwnProperty.call(req.query || {}, 'folder_id')
    const wantsPage = req.query?.paginated === '1' ||
      req.query?.paginated === 'true' ||
      Boolean(req.query?.cursor) ||
      Boolean(req.query?.search) ||
      hasFolderFilter ||
      view === 'landing_library' ||
      view === 'form_library' ||
      view === 'analytics_selector'
    const data = await listSites({
      limit: req.query?.limit,
      cursor: req.query?.cursor,
      paginated: wantsPage,
      view,
      search: req.query?.search,
      siteType: req.query?.siteType ?? req.query?.site_type,
      landingMode: req.query?.landingMode ?? req.query?.landing_mode,
      folderId: hasFolderFilter ? (req.query?.folderId ?? req.query?.folder_id) : undefined,
      includeFacets: req.query?.includeFacets ?? req.query?.include_facets
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error listando sites: ${error.message}`)
    sendError(res, error, 'Error listando sites')
  }
}

export async function getSiteSelectorsHandler(req, res) {
  try {
    const rawSelectedIds = req.query?.selectedIds ?? req.query?.selected_ids ?? ''
    const selectedIds = Array.isArray(rawSelectedIds)
      ? rawSelectedIds
      : String(rawSelectedIds || '').split(',')
    const data = await listSiteSelectors({
      kind: req.query?.kind,
      limit: req.query?.limit,
      cursor: req.query?.cursor,
      search: req.query?.search,
      selectedIds
    })
    res.json({ success: true, data })
  } catch (error) {
    logger.error(`Error listando selectores de Sites: ${error.message}`)
    sendError(res, error, 'Error listando opciones de Sites')
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
    const businessId = String(req.query.businessId || 'default').trim() || 'default'
    const streamVideoId = String(req.query.streamVideoId || req.query.stream_video_id || '').trim()
    const requestedAssetId = String(req.query.assetId || req.query.asset_id || '').trim()
    if (streamVideoId || requestedAssetId) {
      const asset = await getSitesVideoAsset({
        businessId,
        streamVideoId,
        assetId: requestedAssetId,
        analyticsScope: req.query.analyticsScope ?? req.query.analytics_scope,
        siteType: req.query.siteType ?? req.query.site_type,
        landingMode: req.query.landingMode ?? req.query.landing_mode,
        siteId: req.query.siteId ?? req.query.site_id
      })
      if (!asset) {
        return res.status(404).json({ success: false, error: 'Video no encontrado' })
      }
      return res.json({ success: true, data: asset })
    }

    // Los uploads actuales comparten `sites`; `forms` conserva compatibilidad
    // legacy. Ambos viajan en una sola página keyset: jamás recorremos Media completa.
    const page = await listSitesVideoAssets({
      businessId,
      siteType: req.query.siteType || req.query.site_type || 'videos',
      landingMode: req.query.landingMode || req.query.landing_mode || 'all',
      siteId: req.query.siteId || req.query.site_id || '',
      limit: req.query.limit || 50,
      cursor: req.query.cursor || ''
    })
    res.json({ success: true, data: page })
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
    const siteTrackingInput = {
      siteIds: body.siteIds || body.site_ids || [],
      dateFrom,
      dateTo
    }
    if (Object.prototype.hasOwnProperty.call(body, 'siteScope') || Object.prototype.hasOwnProperty.call(body, 'site_scope')) {
      siteTrackingInput.siteScope = body.siteScope ?? body.site_scope
    }
    if (Object.prototype.hasOwnProperty.call(body, 'breakdownSiteIds') || Object.prototype.hasOwnProperty.call(body, 'breakdown_site_ids')) {
      siteTrackingInput.breakdownSiteIds = body.breakdownSiteIds ?? body.breakdown_site_ids
    }
    if (Object.prototype.hasOwnProperty.call(body, 'formFunnelSiteId') || Object.prototype.hasOwnProperty.call(body, 'form_funnel_site_id')) {
      siteTrackingInput.formFunnelSiteId = body.formFunnelSiteId ?? body.form_funnel_site_id
    }
    const [siteTracking, videoTracking] = await Promise.all([
      getSitesTrackingSummary(siteTrackingInput),
      getVideoPlaybackAggregate({
        assetIds: body.videoAssetIds || body.video_asset_ids || [],
        breakdownAssetIds: body.videoBreakdownAssetIds || body.video_breakdown_asset_ids || [],
        siteIds: body.videoSiteIds || body.video_site_ids || body.siteIds || body.site_ids || [],
        siteScope: body.videoScope || body.video_scope || {},
        includeSiteBreakdown: false,
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
        aggregate: siteTracking.aggregate,
        sites: siteTracking.bySiteId,
        formFunnels: siteTracking.formFunnels || {},
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
  return res.status(410).json({
    success: false,
    error: 'La edición visual por elemento fue retirada. Reemplaza el HTML completo o usa el asistente de código.'
  })
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

export async function publicSiteContentAssetHandler(req, res) {
  let cleanupDownload = null
  let removeAbortListener = null
  try {
    const binding = await getPublicSiteContentAsset(req.params.siteId, req.params.assetKey)
    if (!binding?.mediaAsset?.publicUrl) {
      return res.status(404).type('text/plain').send('Contenido no encontrado')
    }
    if (/^(1|true)$/i.test(String(req.query?.download || ''))) {
      const clientAbortController = new AbortController()
      const abortDownload = () => clientAbortController.abort()
      const abortOnResponseClose = () => {
        if (!res.writableFinished) abortDownload()
      }
      req.once?.('aborted', abortDownload)
      res.once?.('close', abortOnResponseClose)
      removeAbortListener = () => {
        req.off?.('aborted', abortDownload)
        res.off?.('close', abortOnResponseClose)
      }
      const file = await getMediaAssetDownloadFile(binding.mediaAsset.id, {
        range: req.headers?.range,
        method: req.method,
        requirePublic: true,
        signal: clientAbortController.signal
      })
      cleanupDownload = file.cleanup
      res.status(file.statusCode || 200)
      res.set('Cache-Control', 'no-store')
      res.set('Content-Type', file.contentType || binding.mediaAsset.mimeType || 'application/octet-stream')
      if (file.contentLength !== undefined) res.set('Content-Length', String(file.contentLength))
      if (file.contentRange) res.set('Content-Range', file.contentRange)
      res.set('Accept-Ranges', file.acceptRanges || 'bytes')
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Disposition', attachmentDisposition(file.filename || binding.label || binding.assetKey, 'archivo'))
      if (String(req.method || 'GET').toUpperCase() === 'HEAD') return res.end()
      await pipeline(file.stream, res)
      return undefined
    }
    res.set('Cache-Control', 'public, max-age=300')
    return res.redirect(302, binding.mediaAsset.publicUrl)
  } catch (error) {
    logger.error(`Error sirviendo contenido estable de site: ${error.message}`)
    if (req.aborted || res.headersSent) {
      if (!res.destroyed) res.destroy(error)
      return undefined
    }
    if (error.contentRange) {
      res.set('Content-Range', error.contentRange)
      res.set('Accept-Ranges', 'bytes')
    }
    return res.status(error.status || 500).type('text/plain').send(error.message || 'No se pudo abrir el contenido')
  } finally {
    removeAbortListener?.()
    cleanupDownload?.()
  }
}

export async function getSiteContentAssetsHandler(req, res) {
  try {
    res.json({ success: true, data: await listSiteContentAssets(req.params.siteId) })
  } catch (error) {
    sendError(res, error, 'No se pudo cargar el contenido del sitio')
  }
}

export async function saveSiteContentAssetHandler(req, res) {
  try {
    const result = await saveSiteContentAsset(req.params.siteId, {
      ...(req.body || {}),
      id: req.params.bindingId || req.body?.id
    })
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'No se pudo guardar el contenido del sitio')
  }
}

export async function deleteSiteContentAssetHandler(req, res) {
  try {
    const result = await deleteSiteContentAsset(req.params.siteId, req.params.bindingId)
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'No se pudo quitar el contenido del sitio')
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
      includeSubmissions: req.query?.includeSubmissions === '1' || req.query?.includeSubmissions === 'true',
      // El API directo conserva compatibilidad; los clientes de edicion nuevos
      // envian 0 y cargan Analytics por su endpoint agregado independiente.
      includeTrackingStats: req.query?.includeTrackingStats !== '0' && req.query?.includeTrackingStats !== 'false',
      submissionLimit: req.query?.submissionLimit
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
    const draftSite = req.method === 'POST'
      ? await buildPreviewSiteDraft(site, req.body?.draftSite)
      : null
    const renderSite = draftSite || site

    await prepareSiteVideoStoragePreviews(renderSite, { strict: true })

    res.set('Cache-Control', 'no-store')
    res.status(200).type('html').send(await renderPublicSiteHtml(renderSite, {
      pageId: req.query?.page,
      trackingEnabled: false,
      preview: true,
      // Todo preview de HTML importado debe ser inerte: nunca monta un checkout real.
      importedNativePreviewMock: true,
      draftImportedCodeFiles: req.method === 'POST' ? req.body?.draftImportedCodeFiles : undefined
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
    const previewSite = draftSite || site

    await prepareSiteVideoStoragePreviews(previewSite, { strict: true })

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

    await prepareSiteVideoStoragePreviews(site, { strict: true })

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
    const canUseCalendarPayments = await hasCalendarPaymentsFeature()

    return res.status(200).type('html').send(renderPublicCalendarHtml(calendarForPublicRender(calendar, canUseCalendarPayments), {
      host: getRequestHost(req) || '',
      embedded: req.query?.embed === '1' || req.query?.test === '1',
      style: req.query || {},
      bookingForm: bookingFormForPublicRender(bookingForm, canUseCalendarPayments),
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

export async function createSitesPublicDomainHandler(req, res) {
  try {
    const result = await createSitesPublicDomain(req.body || {})
    const status = result.verification?.verified ? 201 : 200
    res.status(status).json({ success: true, data: result.settings, meta: result })
  } catch (error) {
    logger.error(`Error agregando dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error agregando dominio')
  }
}

export async function verifySitesPublicDomainByIdHandler(req, res) {
  try {
    const result = await refreshSitesPublicDomainById(req.params.domainId)
    res.json({ success: true, data: result.settings, meta: result })
  } catch (error) {
    logger.error(`Error verificando dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error verificando dominio')
  }
}

export async function setSitesPublicDomainDefaultRouteHandler(req, res) {
  try {
    const result = await setSitesPublicDomainDefaultRoute(
      req.params.domainId,
      req.body?.siteId || req.body?.site_id || '',
      req.body?.pageId || req.body?.page_id || ''
    )
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error configurando ruta predeterminada del dominio de Sites: ${error.message}`)
    sendError(res, error, 'Error configurando ruta predeterminada')
  }
}

export async function removeSitesPublicDomainByIdHandler(req, res) {
  try {
    const result = await removeSitesPublicDomainById(req.params.domainId)
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error(`Error eliminando dominio público de Sites: ${error.message}`)
    sendError(res, error, 'Error eliminando dominio')
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
    const result = await setSitesPublicDefaultRoute(
      req.body?.siteId || req.body?.site_id || '',
      req.body?.pageId || req.body?.page_id || ''
    )
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

export async function sitePaymentCheckoutPayHandler(req, res) {
  try {
    const result = await paySiteCheckout(req, req.body || {})
    res.status(201).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Cobro de checkout embebido rechazado: ${error.message}`)
    sendError(res, error, 'No se pudo procesar el pago')
  }
}

// Paso 1 del MSI de Stripe en sitios: crea/reusa la fila, consulta los planes reales
// con un PaymentMethod seguro y devuelve available_plans filtrados por el bloque.
export async function sitePaymentCheckoutPrepareHandler(req, res) {
  try {
    const result = await prepareSiteCheckoutInstallments(req, req.body || {})
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    logger.warn(`Consulta de meses (checkout embebido) rechazada: ${error.message}`)
    sendError(res, error, 'No se pudieron consultar los meses sin intereses')
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

function getRequestProtocol(req) {
  const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return forwardedProtocol === 'http' ? 'http' : 'https'
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
      req.path === '/api/sites/public/checkout/init' ||
      req.path === '/api/sites/public/checkout/pay' ||
      req.path === '/api/sites/public/checkout/prepare-installments' ||
      req.path === '/api/sites/public/meta-event' ||
      req.path.startsWith('/api/sites/public/payments/') ||
      req.path === '/api/sites/public/fonts.css' ||
      req.path === '/api/sites/public/font-file' ||
      req.path.startsWith('/api/sites/public/calendar-preview/') ||
      req.path.startsWith('/api/sites/public/imported-assets/') ||
      req.path.startsWith('/api/sites/public/content-assets/') ||
      req.path.startsWith('/api/stripe/public/payments/') ||
      req.path.startsWith('/api/conekta/public/payments/') ||
      req.path.startsWith('/api/mercadopago/public/payments/') ||
      req.path.startsWith('/api/clip/public/payments/') ||
      req.path.startsWith('/api/rebill/public/payments/') ||
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

    if (isMetaPrivacyPolicyPath(req.path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendDomainError(req, res, 404, 'Ruta no disponible')
      }

      res.set('Cache-Control', 'no-store')
      return res.status(200).type('html').send(await renderMetaPrivacyPolicyHtml({
        host,
        protocol: getRequestProtocol(req)
      }))
    }

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
      const canUseCalendarPayments = await hasCalendarPaymentsFeature()
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
      return res.status(200).type('html').send(renderPublicCalendarHtml(calendarForPublicRender(calendar, canUseCalendarPayments), {
        host,
        embedded: req.query?.embed === '1' || req.query?.test === '1',
        style: req.query || {},
        bookingForm: bookingFormForPublicRender(bookingForm, canUseCalendarPayments),
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

      // Legacy URLs may include the site slug as the first segment. New page
      // routes can live directly at domain root; use the resolver's page path
      // when it already matched a concrete page route.
      const pathSegments = String(req.path || '').split('/').map(segment => decodePathSegment(segment)).filter(Boolean)
      const pagePath = Array.isArray(resolution.pagePath) ? [...resolution.pagePath] : pathSegments.slice(1)
      if (pagePath.length && pagePath[pagePath.length - 1].toLowerCase() === 'test') pagePath.pop()

      // No cachear el HTML público: cambios de pixel/tracking deben reflejarse
      // siempre tras un refresh (los assets sí se cachean por separado).
      res.set('Cache-Control', 'no-store')
      return res.status(200).type('html').send(await renderPublicSiteHtml(resolution.site, {
        pageId: req.query?.page || resolution.pageId,
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
