import crypto from 'node:crypto'
import { db } from '../config/database.js'
import {
  PublicContextTokenError,
  derivePublicContextOpaqueId,
  normalizePublicContextHost,
  signPublicContextClaims,
  verifyPublicContextToken
} from './publicContextTokenService.js'

const PAGE_CONTEXT_PURPOSE = 'native_site_page_context_v1'
const PAGE_JOURNEY_PURPOSE = 'native_site_page_journey_v1'
const PAGE_CONTEXT_TTL_SECONDS = 60 * 60
const PAGE_JOURNEY_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,120}$/
const PAGE_VIEW_EVENTS = new Set(['native_site_view', 'page_view'])
const NATIVE_RATE_LIMIT_WINDOW_MS = 60 * 1000
const NATIVE_RATE_LIMIT_MAX_VIEWS = 240
const NATIVE_RATE_LIMIT_MAX_KEYS = 5000
const nativeViewRateLimit = new Map()

function cleanString(value, maxLength = 500) {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, maxLength) : ''
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function canonicalInstant(value) {
  const timestamp = new Date(value || '').getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : cleanString(value, 80)
}

function buildUniquePageId(value, index, usedIds) {
  const base = cleanString(value, 160) || (index === 0 ? 'page-1' : `page-${index + 1}`)
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  usedIds.add(candidate)
  return candidate
}

function slugifyRouteSegment(value) {
  return cleanString(value, 260)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeStoredPages(siteRow) {
  const theme = parseJson(siteRow?.theme_json, {})
  const rawPages = Array.isArray(theme.pages) ? theme.pages : []
  const usedIds = new Set()
  const pages = rawPages
    .map((page, index) => ({
      id: buildUniquePageId(page?.id, index, usedIds),
      title: cleanString(page?.title, 260) || `Página ${index + 1}`,
      sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index,
      parentPageId: cleanString(page?.parentPageId || page?.parent_page_id, 160),
      slug: slugifyRouteSegment(page?.slug || page?.title || `Página ${index + 1}`)
    }))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((page, index) => ({ ...page, sortOrder: index }))

  if (pages.length === 0) {
    pages.push({ id: 'page-1', title: 'Página 1', sortOrder: 0, parentPageId: '', slug: 'pagina-1' })
  }
  if (siteRow?.site_type === 'standard_form') {
    if (!pages.some(page => page.id === 'page-2')) {
      pages.push({ id: 'page-2', title: 'Gracias', sortOrder: pages.length, parentPageId: '', slug: 'gracias' })
    }
    if (!pages.some(page => page.id === 'page-3')) {
      pages.push({ id: 'page-3', title: 'No calificaste', sortOrder: pages.length, parentPageId: '', slug: 'no-calificaste' })
    }
  }
  return pages
}

function computePageFlowRevision(siteRow, pages) {
  if (cleanString(siteRow?.site_type, 80) !== 'landing_page') return ''
  const payload = {
    v: 1,
    siteId: cleanString(siteRow?.id, 120),
    stages: pages.map((page, order) => ({
      stageId: page.id,
      order
    }))
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('base64url')
    .slice(0, 32)
}

async function loadPublishedSiteContext(siteId) {
  const row = await db.get(`
    SELECT
      id,
      name,
      slug,
      site_type,
      status,
      domain,
      title,
      theme_json,
      render_domain_verified,
      published_at,
      updated_at
    FROM public_sites
    WHERE id = ?
      AND status = 'published'
    LIMIT 1
  `, [siteId])
  if (!row) {
    throw new NativePageTrackingAuthError('El Site ya no está publicado', {
      code: 'native_site_not_published',
      status: 409
    })
  }

  const pages = normalizeStoredPages(row)
  return {
    row,
    pages,
    pageFlowRevision: computePageFlowRevision(row, pages),
    publication: canonicalInstant(row.published_at || row.updated_at)
  }
}

function publicHostsMatch(left, right) {
  const first = normalizePublicContextHost(left)
  const second = normalizePublicContextHost(right)
  if (!first || !second) return false
  if (first === second) return true
  return first.replace(/^www\./, '') === second.replace(/^www\./, '')
}

async function assertConnectedPublicHost(host, siteRow) {
  const normalizedHost = normalizePublicContextHost(host)
  if (!normalizedHost) {
    throw new NativePageTrackingAuthError('Host público inválido', {
      code: 'invalid_native_site_host',
      status: 403
    })
  }

  const managedDomains = await db.all(`
    SELECT domain
    FROM public_site_domains
    WHERE render_domain_verified = 1
  `)
  if (managedDomains.some(row => publicHostsMatch(normalizedHost, row.domain))) return

  const configRows = await db.all(`
    SELECT config_key, config_value
    FROM app_config
    WHERE config_key IN ('sites_public_domain', 'sites_public_domain_verified')
  `)
  const config = Object.fromEntries(configRows.map(row => [row.config_key, row.config_value]))
  if (
    cleanString(config.sites_public_domain_verified) === '1' &&
    publicHostsMatch(normalizedHost, config.sites_public_domain)
  ) {
    return
  }

  if (
    Number(siteRow?.render_domain_verified || 0) === 1 &&
    publicHostsMatch(normalizedHost, siteRow?.domain)
  ) {
    return
  }

  throw new NativePageTrackingAuthError('El host no está conectado a Sites', {
    code: 'native_site_host_not_connected',
    status: 403
  })
}

function requestHeader(req, name) {
  if (typeof req?.get === 'function') {
    const value = req.get(name)
    if (value) return value
  }
  return req?.headers?.[String(name).toLowerCase()] || ''
}

export function getNativePageTrackingRequestHost(req) {
  return normalizePublicContextHost(
    requestHeader(req, 'x-forwarded-host') ||
    requestHeader(req, 'host') ||
    req?.hostname
  )
}

function assertReasonableRequestLocation(req, data, expectedHost) {
  const requestHost = getNativePageTrackingRequestHost(req)
  if (!requestHost || requestHost !== normalizePublicContextHost(expectedHost)) {
    throw new NativePageTrackingAuthError('El token no pertenece a este host', {
      code: 'native_site_host_mismatch',
      status: 403
    })
  }

  const origin = cleanString(requestHeader(req, 'origin'), 500)
  if (origin) {
    let originUrl = null
    try {
      originUrl = new URL(origin)
    } catch {
      throw new NativePageTrackingAuthError('Origin público inválido', {
        code: 'invalid_native_site_origin',
        status: 403
      })
    }
    if (
      !['http:', 'https:'].includes(originUrl.protocol) ||
      normalizePublicContextHost(originUrl.hostname) !== requestHost
    ) {
      throw new NativePageTrackingAuthError('Origin ajeno al Site', {
        code: 'native_site_origin_mismatch',
        status: 403
      })
    }
  }

  const pageUrl = cleanString(data?.url, 2000)
  if (pageUrl) {
    let parsedPageUrl = null
    try {
      parsedPageUrl = new URL(pageUrl)
    } catch {
      throw new NativePageTrackingAuthError('URL pública inválida', {
        code: 'invalid_native_site_url'
      })
    }
    if (
      !['http:', 'https:'].includes(parsedPageUrl.protocol) ||
      normalizePublicContextHost(parsedPageUrl.hostname) !== requestHost
    ) {
      throw new NativePageTrackingAuthError('La vista no pertenece a este host', {
        code: 'native_site_url_mismatch',
        status: 403
      })
    }
  }
  return requestHost
}

function getPageRouteSegments(siteContext, page) {
  const byId = new Map(siteContext.pages.map(item => [item.id, item]))
  const segments = []
  const seen = new Set()
  let current = page
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    segments.unshift(current.slug || slugifyRouteSegment(current.title))
    current = current.parentPageId ? byId.get(current.parentPageId) : null
  }
  return segments.filter(Boolean)
}

function getDefaultSitePage(siteContext) {
  const theme = parseJson(siteContext.row?.theme_json, {})
  if (
    siteContext.row?.site_type === 'landing_page' &&
    cleanString(theme.pageMode, 40) === 'website'
  ) {
    return siteContext.pages.find(page => !page.parentPageId) || siteContext.pages[0]
  }
  return siteContext.pages[0]
}

async function getConfiguredRootRouteForHost(host) {
  const managedDomains = await db.all(`
    SELECT domain, default_route_site_id, default_route_page_id
    FROM public_site_domains
    WHERE render_domain_verified = 1
  `)
  const managed = managedDomains.find(row => publicHostsMatch(host, row.domain))
  if (managed?.default_route_site_id) {
    return {
      siteId: cleanString(managed.default_route_site_id, 120),
      pageId: cleanString(managed.default_route_page_id, 160)
    }
  }

  const configRows = await db.all(`
    SELECT config_key, config_value
    FROM app_config
    WHERE config_key IN (
      'sites_public_default_route_site_id',
      'sites_public_default_route_page_id'
    )
  `)
  const config = Object.fromEntries(configRows.map(row => [row.config_key, row.config_value]))
  const siteId = cleanString(config.sites_public_default_route_site_id, 120)
  return siteId
    ? {
        siteId,
        pageId: cleanString(config.sites_public_default_route_page_id, 160)
      }
    : null
}

async function legacyRouteMatches({ data, requestHost, siteContext, page }) {
  let pageUrl = null
  try {
    pageUrl = new URL(cleanString(data?.url, 2000))
  } catch {
    return false
  }
  const segments = pageUrl.pathname
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .map(slugifyRouteSegment)
    .filter(Boolean)
  const queryPageId = cleanString(pageUrl.searchParams.get('page'), 160)
  const siteSlug = slugifyRouteSegment(siteContext.row?.slug)
  const pageSegments = getPageRouteSegments(siteContext, page)

  // La ruta legacy explícita /<slug-del-site>/... es demostrable porque el slug
  // del Site es único en DB. El query ?page= sigue siendo compatible.
  if (segments[0] === siteSlug) {
    if (queryPageId) return queryPageId === page.id
    const remainder = segments.slice(1)
    if (remainder.length > 0) {
      return remainder.join('/') === pageSegments.join('/')
    }
    return getDefaultSitePage(siteContext)?.id === page.id
  }

  // La raíz sólo es demostrable cuando el dominio declara un default exacto.
  if (segments.length === 0) {
    const rootRoute = await getConfiguredRootRouteForHost(requestHost)
    if (!rootRoute || rootRoute.siteId !== siteContext.row.id) return false
    const expectedPageId = rootRoute.pageId || getDefaultSitePage(siteContext)?.id || ''
    return expectedPageId === page.id && (!queryPageId || queryPageId === page.id)
  }

  // Las rutas limpias sin slug pueden colisionar entre Sites del mismo dominio.
  // Un runtime antiguo no trae una firma que permita demostrar cuál ganó el
  // resolver; se degrada a analítica general sin contexto de Site.
  return false
}

function cleanNativeAliases(data = {}) {
  const next = { ...(data || {}) }
  for (const key of [
    'site_id',
    'siteId',
    'public_site_id',
    'site_slug',
    'siteSlug',
    'site_name',
    'siteName',
    'site_type',
    'siteType',
    'form_site_id',
    'formSiteId',
    'form_site_name',
    'formSiteName',
    'public_page_id',
    'publicPageId',
    'page_id',
    'pageId',
    'public_page_title',
    'publicPageTitle',
    'page_title',
    'pageTitle',
    'page_flow_revision',
    'pageFlowRevision',
    'page_journey_id',
    'pageJourneyId',
    'page_context_token',
    'pageContextToken',
    'page_tab_nonce',
    'pageTabNonce',
    'conversion_type',
    'conversionType',
    'submission_id',
    'submissionId'
  ]) {
    delete next[key]
  }
  return next
}

function downgradeToExternalPageView(data = {}, mode = 'external') {
  return {
    mode,
    siteId: '',
    pageId: '',
    pageFlowRevision: '',
    pageJourneyId: '',
    data: {
      ...cleanNativeAliases(data),
      tracking_source: 'external_pixel'
    }
  }
}

function deriveNativeSiteData(data, siteContext, page, {
  pageFlowRevision = '',
  pageJourneyId = '',
  formSiteId = '',
  formSiteName = ''
} = {}) {
  return {
    ...cleanNativeAliases(data),
    tracking_source: 'native_site',
    site_id: cleanString(siteContext.row.id, 120),
    site_slug: cleanString(siteContext.row.slug, 220),
    site_name: cleanString(siteContext.row.name, 260),
    site_type: cleanString(siteContext.row.site_type, 80),
    form_site_id: cleanString(formSiteId, 160) || null,
    form_site_name: cleanString(formSiteName, 260) || null,
    public_page_id: cleanString(page.id, 160),
    public_page_title: cleanString(page.title, 260),
    page_flow_revision: cleanString(pageFlowRevision, 80) || null,
    page_journey_id: cleanString(pageJourneyId, 160) || null
  }
}

function assertNoClaimConflict(data, expected) {
  const checks = [
    ['site_id', data?.site_id || data?.siteId || data?.public_site_id, expected.siteId],
    ['public_page_id', data?.public_page_id || data?.publicPageId || data?.page_id || data?.pageId, expected.pageId],
    ['page_flow_revision', data?.page_flow_revision || data?.pageFlowRevision, expected.pageFlowRevision],
    ['form_site_id', data?.form_site_id || data?.formSiteId, expected.formSiteId]
  ]
  for (const [field, rawValue, expectedValue] of checks) {
    const submitted = cleanString(rawValue, 180)
    if (submitted && submitted !== cleanString(expectedValue, 180)) {
      throw new NativePageTrackingAuthError(`Contexto ${field} inconsistente`, {
        code: 'native_site_context_mismatch'
      })
    }
  }
}

function getPageContextToken(data = {}) {
  return cleanString(data.page_context_token || data.pageContextToken, 4096)
}

function getPageTabNonce(data = {}) {
  return cleanString(data.page_tab_nonce || data.pageTabNonce, 160)
}

function isNativePageView(eventName, data = {}) {
  const normalizedEvent = cleanString(eventName, 80).toLowerCase()
  const source = cleanString(data.tracking_source, 80).toLowerCase()
  return PAGE_VIEW_EVENTS.has(normalizedEvent) && (
    normalizedEvent === 'native_site_view' ||
    source === 'native_site' ||
    Boolean(getPageContextToken(data))
  )
}

export class NativePageTrackingAuthError extends Error {
  constructor(message, { code = 'invalid_native_site_context', status = 400 } = {}) {
    super(message)
    this.name = 'NativePageTrackingAuthError'
    this.code = code
    this.status = status
  }
}

export async function createNativePageTrackingContext({
  site,
  pageId,
  pageFlowRevision = '',
  formSiteId = '',
  formSiteName = '',
  host,
  nowMs = Date.now()
} = {}) {
  const siteId = cleanString(site?.id, 120)
  const normalizedPageId = cleanString(pageId, 160)
  const normalizedHost = normalizePublicContextHost(host || site?.domain)
  const publication = canonicalInstant(
    site?.publishedAt ||
    site?.published_at ||
    site?.updatedAt ||
    site?.updated_at
  )
  if (
    cleanString(site?.status, 40) !== 'published' ||
    !siteId ||
    !normalizedPageId ||
    !normalizedHost ||
    !publication
  ) {
    return null
  }

  const token = await signPublicContextClaims({
    purpose: PAGE_CONTEXT_PURPOSE,
    ttlSeconds: PAGE_CONTEXT_TTL_SECONDS,
    nowMs,
    claims: {
      sid: siteId,
      pid: normalizedPageId,
      rev: cleanString(pageFlowRevision, 80),
      fid: cleanString(formSiteId, 160),
      fn: cleanString(formSiteName, 260),
      host: normalizedHost,
      pub: publication
    }
  })
  return { token }
}

async function authenticateSignedPageView({ data, req, nowMs }) {
  let verified = null
  try {
    verified = await verifyPublicContextToken(getPageContextToken(data), {
      purpose: PAGE_CONTEXT_PURPOSE,
      nowMs
    })
  } catch (error) {
    if (error instanceof PublicContextTokenError) {
      throw new NativePageTrackingAuthError(error.message, {
        code: error.code,
        status: error.status
      })
    }
    throw error
  }

  const claims = verified.claims || {}
  const siteId = cleanString(claims.sid, 120)
  const pageId = cleanString(claims.pid, 160)
  const claimedRevision = cleanString(claims.rev, 80)
  const claimedFormSiteId = cleanString(claims.fid, 160)
  const claimedFormSiteName = cleanString(claims.fn, 260)
  const claimedHost = normalizePublicContextHost(claims.host)
  const claimedPublication = canonicalInstant(claims.pub)
  if (!siteId || !pageId || !claimedHost || !claimedPublication) {
    throw new NativePageTrackingAuthError('Claims de página incompletos')
  }

  const requestHost = assertReasonableRequestLocation(req, data, claimedHost)
  const siteContext = await loadPublishedSiteContext(siteId)
  await assertConnectedPublicHost(requestHost, siteContext.row)
  if (claimedPublication !== siteContext.publication) {
    throw new NativePageTrackingAuthError('El token pertenece a otra publicación', {
      code: 'stale_native_site_publication',
      status: 409
    })
  }

  const page = siteContext.pages.find(item => item.id === pageId)
  if (!page) {
    throw new NativePageTrackingAuthError('La página firmada ya no existe', {
      code: 'stale_native_site_page',
      status: 409
    })
  }
  if (claimedRevision !== siteContext.pageFlowRevision) {
    throw new NativePageTrackingAuthError('La estructura del embudo cambió', {
      code: 'stale_native_site_page_flow',
      status: 409
    })
  }
  assertNoClaimConflict(data, {
    siteId,
    pageId,
    pageFlowRevision: siteContext.pageFlowRevision,
    formSiteId: claimedFormSiteId
  })

  let pageJourneyId = ''
  if (siteContext.pageFlowRevision) {
    const tabNonce = getPageTabNonce(data)
    if (!PAGE_JOURNEY_NONCE_PATTERN.test(tabNonce)) {
      throw new NativePageTrackingAuthError('Identidad de pestaña inválida', {
        code: 'invalid_native_site_tab_nonce'
      })
    }
    pageJourneyId = await derivePublicContextOpaqueId({
      purpose: PAGE_JOURNEY_PURPOSE,
      prefix: 'pj_',
      length: 40,
      claims: {
        sid: siteId,
        rev: siteContext.pageFlowRevision,
        tab: tabNonce
      }
    })
  }

  return {
    mode: 'signed',
    siteId,
    pageId,
    pageFlowRevision: siteContext.pageFlowRevision,
    pageJourneyId,
    data: deriveNativeSiteData(data, siteContext, page, {
      pageFlowRevision: siteContext.pageFlowRevision,
      pageJourneyId,
      formSiteId: claimedFormSiteId,
      formSiteName: claimedFormSiteName
    })
  }
}

async function authenticateLegacyPageView({ data, req }) {
  const siteId = cleanString(data?.site_id || data?.siteId || data?.public_site_id, 120)
  const pageId = cleanString(
    data?.public_page_id ||
    data?.publicPageId ||
    data?.page_id ||
    data?.pageId,
    160
  )
  if (!siteId || !pageId) {
    return downgradeToExternalPageView(data, 'native_unverified')
  }

  try {
    const requestHost = assertReasonableRequestLocation(
      req,
      data,
      getNativePageTrackingRequestHost(req)
    )
    const siteContext = await loadPublishedSiteContext(siteId)
    await assertConnectedPublicHost(requestHost, siteContext.row)
    const page = siteContext.pages.find(item => item.id === pageId)
    if (!page || !await legacyRouteMatches({ data, requestHost, siteContext, page })) {
      return downgradeToExternalPageView(data, 'native_unverified')
    }

    return {
      mode: 'legacy_validated',
      siteId,
      pageId,
      pageFlowRevision: '',
      pageJourneyId: '',
      data: deriveNativeSiteData(data, siteContext, page)
    }
  } catch (error) {
    if (error instanceof NativePageTrackingAuthError) {
      return downgradeToExternalPageView(data, 'native_unverified')
    }
    throw error
  }
}

export async function authenticateTrackingPageView({
  eventName,
  data = {},
  req,
  nowMs = Date.now()
} = {}) {
  if (!isNativePageView(eventName, data)) {
    return downgradeToExternalPageView(data)
  }

  if (getPageContextToken(data)) {
    return authenticateSignedPageView({ data, req, nowMs })
  }
  return authenticateLegacyPageView({ data, req })
}

export function consumeNativePageViewRateLimit({
  ip,
  siteId,
  nowMs = Date.now()
} = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const key = `${cleanString(ip, 120) || 'unknown'}\u0000${cleanString(siteId, 120) || 'unknown'}`
  let entry = nativeViewRateLimit.get(key)
  if (!entry || now - entry.windowStartedAt >= NATIVE_RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStartedAt: now, lastSeenAt: now }
  }
  entry.count += 1
  entry.lastSeenAt = now
  nativeViewRateLimit.delete(key)
  nativeViewRateLimit.set(key, entry)

  while (nativeViewRateLimit.size > NATIVE_RATE_LIMIT_MAX_KEYS) {
    const oldestKey = nativeViewRateLimit.keys().next().value
    nativeViewRateLimit.delete(oldestKey)
  }

  const allowed = entry.count <= NATIVE_RATE_LIMIT_MAX_VIEWS
  return {
    allowed,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil(
        (entry.windowStartedAt + NATIVE_RATE_LIMIT_WINDOW_MS - now) / 1000
      ))
  }
}

export function resetNativePageViewRateLimitForTests() {
  nativeViewRateLimit.clear()
}
