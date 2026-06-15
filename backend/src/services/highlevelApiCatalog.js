import {
  HIGHLEVEL_ENDPOINT_SOURCE,
  HIGHLEVEL_SUBACCOUNT_ENDPOINTS
} from '../data/highlevelEndpointCatalog.js'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const DEFAULT_LOOKUP_LIMIT = 10
const MAX_LOOKUP_LIMIT = 30

function cleanText(value, maxLength = 1000) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned
}

function normalizeText(value) {
  return cleanText(value, 4000)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizePath(value) {
  const path = String(value || '').trim()
  if (!path) return ''

  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const withoutQuery = cleanPath.split(/[?#]/)[0]
  const withoutTrailingSlash = withoutQuery.length > 1
    ? withoutQuery.replace(/\/+$/g, '')
    : withoutQuery

  return withoutTrailingSlash || '/'
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function templateToRegExp(template) {
  const normalized = normalizePath(template)
  const source = escapeRegExp(normalized)
    .replace(/\\\{[^}]+\\\}/g, '[^/]+')

  return new RegExp(`^${source}/?$`, 'i')
}

function buildSearchText(endpoint) {
  return normalizeText([
    endpoint.method,
    endpoint.path,
    endpoint.operationId,
    endpoint.summary,
    endpoint.description,
    endpoint.app,
    endpoint.appTitle,
    ...(endpoint.tags || []),
    ...(endpoint.scopes || [])
  ].filter(Boolean).join(' '))
}

const ENDPOINT_INDEX = HIGHLEVEL_SUBACCOUNT_ENDPOINTS.map((endpoint) => ({
  ...endpoint,
  normalizedPath: normalizePath(endpoint.path),
  matcher: templateToRegExp(endpoint.path),
  searchText: buildSearchText(endpoint)
}))

function compactEndpoint(endpoint) {
  if (!endpoint) return null

  const queryParams = Array.isArray(endpoint.queryParams) ? endpoint.queryParams : []
  const pathParams = Array.isArray(endpoint.pathParams) ? endpoint.pathParams : []

  return {
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary,
    operationId: endpoint.operationId,
    app: endpoint.app,
    appTitle: endpoint.appTitle,
    tags: endpoint.tags || [],
    scopes: endpoint.scopes || [],
    version: endpoint.version || null,
    requiredPathParams: pathParams.filter((param) => param.required).map((param) => param.name),
    requiredQueryParams: queryParams.filter((param) => param.required).map((param) => param.name),
    queryParams: queryParams.map((param) => ({
      name: param.name,
      required: Boolean(param.required),
      type: param.type || null
    })),
    requestBody: endpoint.requestBody || null
  }
}

export function getHighLevelEndpointCatalogSummary() {
  const methodSummary = Object.entries(HIGHLEVEL_ENDPOINT_SOURCE.methodCounts || {})
    .map(([method, count]) => `${method}: ${count}`)
    .join(', ')
  const appCount = Object.keys(HIGHLEVEL_ENDPOINT_SOURCE.appCounts || {}).length

  return [
    `${HIGHLEVEL_ENDPOINT_SOURCE.subAccountEndpointCount} endpoints REST documentados de Sub-Account`,
    `${appCount} modulos/apps`,
    `métodos ${methodSummary}`,
    `fuente ${HIGHLEVEL_ENDPOINT_SOURCE.repository} @ ${HIGHLEVEL_ENDPOINT_SOURCE.commit || 'desconocido'}`
  ].join('; ')
}

export function getHighLevelEndpointSource() {
  return HIGHLEVEL_ENDPOINT_SOURCE
}

export function findHighLevelEndpoint({ method, path } = {}) {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  if (!HTTP_METHODS.has(normalizedMethod)) return null

  const normalizedPath = normalizePath(path)
  if (!normalizedPath) return null

  const exact = ENDPOINT_INDEX.find((endpoint) =>
    endpoint.method === normalizedMethod &&
    endpoint.normalizedPath.toLowerCase() === normalizedPath.toLowerCase()
  )
  if (exact) return exact

  return ENDPOINT_INDEX.find((endpoint) =>
    endpoint.method === normalizedMethod &&
    endpoint.matcher.test(normalizedPath)
  ) || null
}

export function searchHighLevelEndpoints(args = {}) {
  const method = String(args.method || '').toUpperCase()
  const hasMethodFilter = HTTP_METHODS.has(method)
  const query = normalizeText(args.query || '')
  const app = normalizeText(args.app || args.module || '')
  const tag = normalizeText(args.tag || '')
  const path = normalizePath(args.path || '')
  const limit = Math.min(
    Math.max(Number(args.limit) || DEFAULT_LOOKUP_LIMIT, 1),
    MAX_LOOKUP_LIMIT
  )
  const queryTokens = query
    .replace(/[^a-z0-9_/{-]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1)

  const scored = []

  for (const endpoint of ENDPOINT_INDEX) {
    if (hasMethodFilter && endpoint.method !== method) continue
    if (app && !normalizeText(`${endpoint.app} ${endpoint.appTitle}`).includes(app)) continue
    if (tag && !normalizeText((endpoint.tags || []).join(' ')).includes(tag)) continue

    let score = 0
    const normalizedEndpointPath = endpoint.normalizedPath.toLowerCase()

    if (path) {
      const normalizedRequestedPath = path.toLowerCase()
      if (normalizedEndpointPath === normalizedRequestedPath) score += 1000
      if (endpoint.matcher.test(path)) score += 850
      if (normalizedEndpointPath.includes(normalizedRequestedPath) || normalizedRequestedPath.includes(normalizedEndpointPath)) score += 300
    }

    if (query) {
      if (endpoint.searchText.includes(query)) score += 220
      for (const token of queryTokens) {
        if (endpoint.searchText.includes(token)) score += 28
        if (normalizedEndpointPath.includes(token)) score += 22
      }
    }

    if (!query && !path && !app && !tag && !hasMethodFilter) score = 1

    if (score > 0) {
      scored.push({ score, endpoint })
    }
  }

  return scored
    .sort((a, b) =>
      b.score - a.score ||
      a.endpoint.appTitle.localeCompare(b.endpoint.appTitle) ||
      a.endpoint.path.localeCompare(b.endpoint.path) ||
      a.endpoint.method.localeCompare(b.endpoint.method)
    )
    .slice(0, limit)
    .map(({ endpoint }) => compactEndpoint(endpoint))
}

export function lookupHighLevelEndpoint(args = {}) {
  const exact = args.path
    ? findHighLevelEndpoint({ method: args.method || 'GET', path: args.path })
    : null
  const matches = exact
    ? [compactEndpoint(exact)]
    : searchHighLevelEndpoints(args)

  return {
    ok: matches.length > 0,
    action: 'lookup_highlevel_endpoint',
    source: getHighLevelEndpointSource(),
    query: {
      method: args.method || null,
      path: args.path || null,
      app: args.app || args.module || null,
      tag: args.tag || null,
      query: args.query || null
    },
    matches
  }
}

export function replaceHighLevelPathDefaults(path, highLevelConnection = {}) {
  const locationId = cleanText(highLevelConnection.locationId || '', 200)
  if (!locationId) return normalizePath(path)

  return normalizePath(path)
    .replace(/\{locationId\}/gi, encodeURIComponent(locationId))
    .replace(/:locationId\b/gi, encodeURIComponent(locationId))
}

export function getUnresolvedHighLevelPathParams(path) {
  const cleanPath = normalizePath(path)
  const braceParams = Array.from(cleanPath.matchAll(/\{([^}]+)\}/g)).map((match) => match[1])
  const colonParams = Array.from(cleanPath.matchAll(/\/:([A-Za-z_][A-Za-z0-9_]*)/g)).map((match) => match[1])

  return Array.from(new Set([...braceParams, ...colonParams]))
}

export function addHighLevelEndpointQueryDefaults(query = {}, endpoint = null, highLevelConnection = {}) {
  if (!endpoint || !highLevelConnection?.locationId) return query

  const nextQuery = { ...query }
  const queryParamNames = new Set((endpoint.queryParams || []).map((param) => param.name))
  const hasAnyLocationValue =
    Object.prototype.hasOwnProperty.call(nextQuery, 'locationId') ||
    Object.prototype.hasOwnProperty.call(nextQuery, 'location_id') ||
    Object.prototype.hasOwnProperty.call(nextQuery, 'altId')

  if (queryParamNames.has('locationId') && !hasAnyLocationValue) {
    nextQuery.locationId = highLevelConnection.locationId
  }

  if (queryParamNames.has('altId') && !Object.prototype.hasOwnProperty.call(nextQuery, 'altId')) {
    nextQuery.altId = highLevelConnection.locationId
  }

  if (queryParamNames.has('altType') && !Object.prototype.hasOwnProperty.call(nextQuery, 'altType')) {
    nextQuery.altType = 'location'
  }

  return nextQuery
}

export function compactHighLevelEndpoint(endpoint) {
  return compactEndpoint(endpoint)
}
