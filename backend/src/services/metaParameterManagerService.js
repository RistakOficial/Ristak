import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { logger } from '../utils/logger.js'

const require = createRequire(import.meta.url)
const {
  ParamBuilder,
  PII_DATA_TYPE
} = require('capi-param-builder-nodejs')

const CLIENT_PARAM_BUILDER_BUNDLE_PATH = require.resolve(
  'meta-capi-param-builder-clientjs/dist/clientParamBuilder.bundle.js'
)

let clientBundlePromise = null

export const META_PII_DATA_TYPE = PII_DATA_TYPE

function cleanString(value) {
  return String(value || '').trim()
}

function firstCleanString(values = []) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return ''
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function getMetaPayload(requestMeta = {}) {
  return safeObject(requestMeta?.meta || requestMeta)
}

function getMetaTrackingPayload(meta = {}) {
  return safeObject(meta.tracking)
}

function parseCookieHeader(cookieHeader = '') {
  const cookies = {}
  cleanString(cookieHeader).split(';').forEach(part => {
    const separator = part.indexOf('=')
    if (separator < 0) return
    const key = cleanString(part.slice(0, separator))
    if (!key) return
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1))
    } catch {
      cookies[key] = part.slice(separator + 1)
    }
  })
  return cookies
}

function normalizeCookieValue(value) {
  const cleaned = cleanString(value)
  return cleaned || null
}

function buildMetaCookieBag({ req = null, requestMeta = {} } = {}) {
  const meta = getMetaPayload(requestMeta)
  const tracking = getMetaTrackingPayload(meta)
  const trackingCookies = safeObject(tracking.cookies)
  const requestCookies = parseCookieHeader(req?.headers?.cookie)
  const cookies = { ...requestCookies }

  const fbc = normalizeCookieValue(
    meta.fbc || meta._fbc || tracking.fbc || tracking._fbc || trackingCookies.fbc || trackingCookies._fbc
  )
  const fbp = normalizeCookieValue(
    meta.fbp || meta._fbp || tracking.fbp || tracking._fbp || trackingCookies.fbp || trackingCookies._fbp
  )
  const fbi = normalizeCookieValue(
    meta.fbi || meta._fbi || meta.clientIpAddress || meta.client_ip_address ||
    tracking.fbi || tracking._fbi || tracking.clientIpAddress || tracking.client_ip_address ||
    trackingCookies.fbi || trackingCookies._fbi
  )

  if (fbc) cookies._fbc = fbc
  if (fbp) cookies._fbp = fbp
  if (fbi) cookies._fbi = fbi

  return cookies
}

function getUrlInfo(rawUrl = '') {
  const cleaned = cleanString(rawUrl)
  if (!cleaned) return null
  try {
    const parsed = new URL(cleaned, 'https://ristak.local')
    return {
      host: parsed.host === 'ristak.local' && !/^https?:\/\//i.test(cleaned) ? '' : parsed.host,
      hostname: parsed.hostname,
      protocol: parsed.protocol.replace(':', ''),
      requestUri: `${parsed.pathname}${parsed.search}`,
      queryParams: Object.fromEntries(parsed.searchParams.entries())
    }
  } catch {
    return null
  }
}

function getMetaSourceUrl(requestMeta = {}) {
  const meta = getMetaPayload(requestMeta)
  const tracking = getMetaTrackingPayload(meta)
  return firstCleanString([
    meta.pageUrl,
    meta.page_url,
    meta.sourceUrl,
    meta.source_url,
    meta.url,
    tracking.url,
    requestMeta?.sourceUrl,
    requestMeta?.source_url
  ])
}

function getMetaReferrer(requestMeta = {}, req = null) {
  const meta = getMetaPayload(requestMeta)
  const tracking = getMetaTrackingPayload(meta)
  return firstCleanString([
    meta.referrer,
    meta.referer,
    tracking.referrer,
    tracking.referer,
    req?.headers?.referer,
    req?.headers?.referrer
  ])
}

function getRequestHost({ req = null, sourceUrl = '' } = {}) {
  const urlInfo = getUrlInfo(sourceUrl)
  return firstCleanString([
    urlInfo?.host,
    req?.headers?.host,
    req?.hostname,
    req?.host
  ])
}

function getRequestScheme({ req = null, sourceUrl = '' } = {}) {
  const urlInfo = getUrlInfo(sourceUrl)
  return firstCleanString([
    urlInfo?.protocol,
    req?.protocol,
    req?.secure ? 'https' : ''
  ]) || 'https'
}

function getRequestUri({ req = null, sourceUrl = '' } = {}) {
  const urlInfo = getUrlInfo(sourceUrl)
  return firstCleanString([
    urlInfo?.requestUri,
    req?.originalUrl,
    req?.url,
    req?.path
  ]) || '/'
}

function buildQueryParams({ req = null, requestMeta = {}, sourceUrl = '' } = {}) {
  const meta = getMetaPayload(requestMeta)
  const tracking = getMetaTrackingPayload(meta)
  const params = {
    ...safeObject(meta.params),
    ...safeObject(tracking.params)
  }
  const urlInfo = getUrlInfo(sourceUrl)
  Object.assign(params, urlInfo?.queryParams || {})

  const requestQuery = safeObject(req?.query)
  Object.assign(params, requestQuery)

  const fbclid = firstCleanString([
    meta.fbclid,
    meta.fbClickId,
    meta.fb_click_id,
    tracking.fbclid,
    params.fbclid
  ])
  if (fbclid) params.fbclid = fbclid

  return Object.fromEntries(
    Object.entries(params)
      .map(([key, value]) => [cleanString(key), cleanString(value)])
      .filter(([key, value]) => key && value)
  )
}

function getForwardedFor(req = null) {
  const value = req?.headers?.['x-forwarded-for']
  if (Array.isArray(value)) return value.filter(Boolean).join(', ')
  return cleanString(value || req?.headers?.['cf-connecting-ip'])
}

function getRemoteAddress(req = null, requestMeta = {}) {
  return firstCleanString([
    requestMeta?.ip,
    requestMeta?.clientIpAddress,
    requestMeta?.client_ip_address,
    req?.ip,
    req?.socket?.remoteAddress,
    req?.connection?.remoteAddress
  ])
}

function getUserAgent(req = null, requestMeta = {}) {
  const meta = getMetaPayload(requestMeta)
  const tracking = getMetaTrackingPayload(meta)
  return firstCleanString([
    requestMeta?.userAgent,
    requestMeta?.user_agent,
    meta.userAgent,
    meta.user_agent,
    tracking.userAgent,
    tracking.user_agent,
    req?.headers?.['user-agent']
  ])
}

export function collectMetaParameterSignals({ req = null, requestMeta = {}, sourceUrl = '' } = {}) {
  const resolvedSourceUrl = sourceUrl || getMetaSourceUrl(requestMeta)
  const host = getRequestHost({ req, sourceUrl: resolvedSourceUrl })
  const builder = new ParamBuilder()

  try {
    builder.processRequest(
      host,
      buildQueryParams({ req, requestMeta, sourceUrl: resolvedSourceUrl }),
      buildMetaCookieBag({ req, requestMeta }),
      getMetaReferrer(requestMeta, req),
      getForwardedFor(req),
      getRemoteAddress(req, requestMeta)
    )
  } catch (error) {
    logger.warn(`Meta parameter manager no pudo procesar request: ${error.message}`)
  }

  return {
    fbc: builder.getFbc() || null,
    fbp: builder.getFbp() || null,
    clientIpAddress: builder.getClientIpAddress() || null,
    clientUserAgent: getUserAgent(req, requestMeta) || null,
    sourceUrl: resolvedSourceUrl || null,
    requestUri: getRequestUri({ req, sourceUrl: resolvedSourceUrl }),
    scheme: getRequestScheme({ req, sourceUrl: resolvedSourceUrl }),
    cookiesToSet: builder.getCookiesToSet()
  }
}

export function setMetaParameterCookies(res, cookiesToSet = [], req = null) {
  if (!res || typeof res.cookie !== 'function' || !Array.isArray(cookiesToSet)) return
  const secure = Boolean(req?.secure || req?.protocol === 'https' || req?.headers?.['x-forwarded-proto'] === 'https')

  for (const cookie of cookiesToSet) {
    if (!cookie?.name || !cookie?.value) continue
    const domain = cleanString(cookie.domain)
    const shouldSetDomain = domain &&
      domain !== 'localhost' &&
      !domain.includes('[') &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)

    res.cookie(cookie.name, cookie.value, {
      maxAge: Number(cookie.maxAge || 0) * 1000 || undefined,
      path: '/',
      sameSite: 'lax',
      secure,
      httpOnly: false,
      ...(shouldSetDomain ? { domain } : {})
    })
  }
}

export function normalizeAndHashMetaPii(value, dataType) {
  const cleaned = cleanString(value)
  if (!cleaned || !dataType) return null

  try {
    const builder = new ParamBuilder()
    return builder.getNormalizedAndHashedPII(cleaned, dataType) || null
  } catch (error) {
    logger.warn(`Meta parameter manager no pudo normalizar ${dataType}: ${error.message}`)
    return null
  }
}

function pruneEmptyUserData(userData = {}) {
  return Object.fromEntries(
    Object.entries(userData).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0
      return value !== null && value !== undefined && value !== ''
    })
  )
}

export function buildMetaParameterUserData({
  req = null,
  requestMeta = {},
  contact = {},
  names = {},
  externalId = '',
  sourceUrl = '',
  extraUserData = {},
  includeBrowserSignals = true
} = {}) {
  const signals = includeBrowserSignals
    ? collectMetaParameterSignals({ req, requestMeta, sourceUrl })
    : {}
  const firstName = firstCleanString([names.firstName, names.first_name, contact.firstName, contact.first_name])
  const lastName = firstCleanString([names.lastName, names.last_name, contact.lastName, contact.last_name])
  const resolvedExternalId = firstCleanString([
    externalId,
    contact.id,
    contact.contactId,
    contact.contact_id
  ])

  return pruneEmptyUserData({
    external_id: normalizeAndHashMetaPii(resolvedExternalId, PII_DATA_TYPE.EXTERNAL_ID),
    em: normalizeAndHashMetaPii(contact.email, PII_DATA_TYPE.EMAIL),
    ph: normalizeAndHashMetaPii(contact.phone, PII_DATA_TYPE.PHONE),
    fn: normalizeAndHashMetaPii(firstName, PII_DATA_TYPE.FIRST_NAME),
    ln: normalizeAndHashMetaPii(lastName, PII_DATA_TYPE.LAST_NAME),
    client_ip_address: signals.clientIpAddress || undefined,
    client_user_agent: signals.clientUserAgent || undefined,
    fbc: signals.fbc || undefined,
    fbp: signals.fbp || undefined,
    ...extraUserData
  })
}

export function buildMetaBrowserUserData({ req = null, requestMeta = {}, externalId = '', sourceUrl = '' } = {}) {
  return buildMetaParameterUserData({
    req,
    requestMeta,
    sourceUrl,
    externalId,
    contact: {},
    names: {}
  })
}

export async function getMetaParameterBuilderClientBundle() {
  if (!clientBundlePromise) {
    clientBundlePromise = readFile(CLIENT_PARAM_BUILDER_BUNDLE_PATH, 'utf8')
  }
  return clientBundlePromise
}
