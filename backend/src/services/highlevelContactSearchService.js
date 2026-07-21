import fetch from 'node-fetch'
import { logger } from '../utils/logger.js'

const HIGHLEVEL_CONTACT_SEARCH_URL = 'https://services.leadconnectorhq.com/contacts/search'
const HIGHLEVEL_CONTACTS_API_VERSION = 'v3'
const DEFAULT_PAGE_LIMIT = 100
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_MAX_PAGES = 1_000
const MAX_STANDARD_PAGES = 100

function cleanString(value) {
  return String(value ?? '').trim()
}

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

function parseRetryAfterMs(value) {
  const clean = cleanString(value)
  if (!clean) return null
  const seconds = Number(clean)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const retryAt = Date.parse(clean)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null
}

function parseJsonBody(bodyText) {
  try {
    return JSON.parse(bodyText)
  } catch {
    return null
  }
}

function responseMessage(bodyText, parsedBody) {
  const rawMessage = parsedBody?.message
  const message = Array.isArray(rawMessage) ? rawMessage.join(' ') : cleanString(rawMessage)
  return message || cleanString(bodyText)
}

function isTransientHighLevelSearchFailure(status, bodyText, parsedBody) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(status))) return true
  if (Number(status) !== 400) return false
  return /(?:request\s+)?time(?:d)?\s*out|timeout/i.test(responseMessage(bodyText, parsedBody))
}

function createHighLevelSearchError({ status, bodyText, parsedBody, page }) {
  const detail = responseMessage(bodyText, parsedBody) || 'HighLevel no devolvió detalle'
  const error = new Error(`Error ${status} obteniendo contactos de HighLevel en página ${page}: ${detail}`)
  error.status = Number(status) || 500
  error.code = `GHL_CONTACT_SEARCH_${error.status}`
  error.retryable = isTransientHighLevelSearchFailure(error.status, bodyText, parsedBody)
  return error
}

async function requestContactSearchPage({
  locationId,
  apiToken,
  body,
  pageLabel,
  fetchImpl,
  sleepImpl,
  requestTimeoutMs,
  maxAttempts
}) {
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs)

    try {
      const response = await fetchImpl(HIGHLEVEL_CONTACT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
          'Version': HIGHLEVEL_CONTACTS_API_VERSION
        },
        body: JSON.stringify({ locationId, ...body }),
        signal: controller.signal
      })

      const bodyText = await response.text()
      const parsedBody = parseJsonBody(bodyText)
      if (response.ok) {
        if (!parsedBody || !Array.isArray(parsedBody.contacts)) {
          const malformed = new Error(`HighLevel devolvió una respuesta inválida de contactos en página ${pageLabel}`)
          malformed.code = 'GHL_CONTACT_SEARCH_INVALID_RESPONSE'
          malformed.retryable = true
          throw malformed
        }
        return parsedBody
      }

      const error = createHighLevelSearchError({
        status: response.status,
        bodyText,
        parsedBody,
        page: pageLabel
      })
      if (!error.retryable || attempt === maxAttempts) throw error

      const retryAfterMs = response.status === 429
        ? parseRetryAfterMs(response.headers?.get?.('Retry-After'))
        : null
      const waitMs = retryAfterMs ?? Math.min(8_000, 1_000 * (2 ** (attempt - 1)))
      logger.warn(
        `[GHL Contacts] Falla temporal en página ${pageLabel} (${response.status}); ` +
        `reintento ${attempt}/${maxAttempts - 1} en ${Math.round(waitMs / 1000)}s`
      )
      await sleepImpl(waitMs)
    } catch (rawError) {
      const aborted = rawError?.name === 'AbortError'
      const retryable = aborted || rawError?.retryable === true || !Number(rawError?.status)
      const error = aborted
        ? Object.assign(new Error(`Timeout local obteniendo contactos de HighLevel en página ${pageLabel}`), {
            code: 'GHL_CONTACT_SEARCH_TIMEOUT',
            status: 504,
            retryable: true
          })
        : rawError
      lastError = error

      if (!retryable || attempt === maxAttempts) throw error
      const waitMs = Math.min(8_000, 1_000 * (2 ** (attempt - 1)))
      logger.warn(
        `[GHL Contacts] Error temporal en página ${pageLabel}: ${error.message}. ` +
        `Reintento ${attempt}/${maxAttempts - 1} en ${Math.round(waitMs / 1000)}s`
      )
      await sleepImpl(waitMs)
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw lastError || new Error(`No se pudo obtener la página ${pageLabel} de contactos de HighLevel`)
}

function contactPageKey(contacts = []) {
  return contacts
    .map(contact => cleanString(contact?.id || contact?._id))
    .filter(Boolean)
    .join('|')
}

function extractSearchAfter(contact) {
  const value = contact?.searchAfter || contact?.search_after
  return Array.isArray(value) && value.length ? value : null
}

/**
 * Pagina el endpoint vigente POST /contacts/search. Usa páginas numéricas hasta
 * 10,000 registros y cambia a searchAfter cuando HighLevel entrega ese cursor.
 * Cada página se entrega al caller inmediatamente para permitir procesamiento
 * incremental sin esperar a que termine toda la enumeración remota.
 */
export async function * iterateHighLevelContactPages({
  locationId,
  apiToken,
  pageLimit = DEFAULT_PAGE_LIMIT,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxPages = DEFAULT_MAX_PAGES
} = {}) {
  const cleanLocationId = cleanString(locationId)
  const cleanApiToken = cleanString(apiToken).replace(/[\r\n\t]/g, '')
  if (!cleanLocationId || !cleanApiToken) {
    throw new Error('Se requieren locationId y apiToken para sincronizar contactos de HighLevel')
  }

  const safePageLimit = normalizePositiveInteger(pageLimit, DEFAULT_PAGE_LIMIT, 500)
  const safeRequestTimeoutMs = normalizePositiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 120_000)
  const safeMaxAttempts = normalizePositiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, 8)
  const safeMaxPages = normalizePositiveInteger(maxPages, DEFAULT_MAX_PAGES, 10_000)
  const seenPageKeys = new Set()
  let page = 1
  let searchAfter = null
  let pagesRead = 0
  let uniqueContactsRead = 0

  while (pagesRead < safeMaxPages) {
    pagesRead += 1
    const pageLabel = searchAfter ? `cursor ${pagesRead}` : String(page)
    const data = await requestContactSearchPage({
      locationId: cleanLocationId,
      apiToken: cleanApiToken,
      body: searchAfter
        ? { pageLimit: safePageLimit, searchAfter }
        : { page, pageLimit: safePageLimit },
      pageLabel,
      fetchImpl,
      sleepImpl,
      requestTimeoutMs: safeRequestTimeoutMs,
      maxAttempts: safeMaxAttempts
    })
    const contacts = data.contacts
    const total = Number.isFinite(Number(data.total ?? data.meta?.total))
      ? Number(data.total ?? data.meta?.total)
      : null

    if (!contacts.length) return

    const pageKey = contactPageKey(contacts)
    if (pageKey && seenPageKeys.has(pageKey)) {
      const error = new Error(`HighLevel repitió la página ${pageLabel} de contactos; se detuvo para evitar un ciclo infinito`)
      error.code = 'GHL_CONTACT_SEARCH_REPEATED_PAGE'
      throw error
    }
    if (pageKey) seenPageKeys.add(pageKey)

    uniqueContactsRead += contacts.length
    yield {
      contacts,
      page,
      pagesRead,
      total,
      searchAfter: searchAfter || null
    }

    if ((total !== null && uniqueContactsRead >= total) || contacts.length < safePageLimit) return

    const nextSearchAfter = extractSearchAfter(contacts.at(-1))
    if (page >= MAX_STANDARD_PAGES && nextSearchAfter) {
      searchAfter = nextSearchAfter
    } else {
      page += 1
    }
  }

  const error = new Error(`La sincronización de contactos alcanzó el límite de ${safeMaxPages} páginas`)
  error.code = 'GHL_CONTACT_SEARCH_PAGE_LIMIT'
  throw error
}
