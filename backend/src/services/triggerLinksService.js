import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { handleAutomationEvent } from './automationEngine.js'
import { createRistakId } from '../utils/idGenerator.js'
import { readTriggerLinkRecipientToken } from './triggerLinkRecipientTokenService.js'

const PUBLIC_ID_LENGTH = 12
const ALLOWED_DESTINATION_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const LEGACY_IDENTITY_QUERY_KEYS = new Set([
  'contact_id', 'contactid', 'cid',
  'phone', 'teléfono', 'tel',
  'email', 'correo',
  'contact_name', 'contactname', 'name', 'nombre',
  'visitor_id', 'visitorid', 'vid', 'rstk_vid'
])
const LEGACY_CONTACT_QUERY_KEYS = new Set(['contact_id', 'contactid', 'cid'])

function cleanString(value, max = 500) {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned.slice(0, max) : ''
}

function badRequest(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function notFound(message) {
  const error = new Error(message)
  error.status = 404
  return error
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function normalizePublicId(value) {
  return cleanString(value, 80).replace(/[^a-zA-Z0-9_-]/g, '')
}

export function normalizeTriggerLinkDestination(value) {
  const raw = cleanString(value, 2048)
  if (!raw) throw badRequest('Pega el destino del enlace.')

  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) {
      throw badRequest('Usa una ruta interna válida que empiece con un solo /.')
    }
    return raw
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let url
    try {
      url = new URL(raw)
    } catch {
      throw badRequest('Usa una URL válida para el destino.')
    }
    if (!ALLOWED_DESTINATION_PROTOCOLS.has(url.protocol)) {
      throw badRequest('Ese tipo de URL no está permitido para redireccionar.')
    }
    return url.toString()
  }

  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(raw)) {
    return `https://${raw}`
  }

  throw badRequest('Usa una URL válida. Puede ser https://..., www... o una ruta que empiece con /.')
}

function makePublicId() {
  return createRistakId('link', { length: PUBLIC_ID_LENGTH })
}

async function createUniquePublicId() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const publicId = makePublicId()
    const existing = await db.get('SELECT id FROM trigger_links WHERE public_id = ?', [publicId])
    if (!existing) return publicId
  }
  throw badRequest('No se pudo generar un ID público unico. Intenta otra vez.')
}

export function buildTriggerLinkPublicUrl(link, baseUrl = '') {
  const publicId = typeof link === 'string' ? link : link?.publicId || link?.public_id || ''
  if (!baseUrl || !publicId) return publicId ? `/trigger-links/${publicId}` : ''
  return `${String(baseUrl).replace(/\/+$/, '')}/trigger-links/${publicId}`
}

function mapTriggerLink(row, { baseUrl = '' } = {}) {
  if (!row) return null
  const link = {
    id: row.id,
    publicId: row.public_id,
    name: row.name || 'Enlace de disparo',
    destinationUrl: row.destination_url || '',
    description: row.description || '',
    active: Boolean(Number(row.active ?? 1)),
    archived: Boolean(Number(row.archived ?? 0)),
    clickCount: Number(row.click_count || 0),
    lastClickedAt: row.last_clicked_at || null,
    createdByUserId: row.created_by_user_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
  return {
    ...link,
    publicUrl: buildTriggerLinkPublicUrl(link, baseUrl)
  }
}

function mapTriggerLinkEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    triggerLinkId: row.trigger_link_id,
    publicId: row.public_id,
    contactId: row.contact_id || '',
    visitorId: row.visitor_id || '',
    ipAddress: row.ip_address || '',
    userAgent: row.user_agent || '',
    referrer: row.referrer || '',
    query: parseJson(row.query_json, {}),
    createdAt: row.created_at || null
  }
}

function getRequestIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return cleanString(forwarded || req?.ip || req?.socket?.remoteAddress || '', 120)
}

function sanitizePublicQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {}
  const sanitized = {}
  for (const [rawKey, rawValue] of Object.entries(query)) {
    const key = cleanString(rawKey, 120)
    if (!key || LEGACY_IDENTITY_QUERY_KEYS.has(key.toLowerCase())) continue
    sanitized[key] = rawValue
  }
  return sanitized
}

function getLegacyRecipientToken(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (!LEGACY_CONTACT_QUERY_KEYS.has(cleanString(rawKey, 120).toLowerCase())) continue
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
    const token = cleanString(value, 4096)
    if (token.startsWith('pce1_')) return token
  }
  return ''
}

function getRequestCookie(req, name) {
  const direct = cleanString(req?.cookies?.[name], 200)
  if (direct) return direct
  const rawCookie = String(req?.headers?.cookie || '')
  for (const entry of rawCookie.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue
    try {
      return cleanString(decodeURIComponent(entry.slice(separator + 1).trim()), 200)
    } catch {
      return ''
    }
  }
  return ''
}

function getRequestVisitorId(req) {
  const visitorId = getRequestCookie(req, 'ristak_vid')
  return /^[A-Za-z0-9_-]{8,120}$/.test(visitorId) && !/^\d{12,}$/.test(visitorId)
    ? visitorId
    : ''
}

export async function listTriggerLinks({ includeArchived = false, baseUrl = '' } = {}) {
  const rows = await db.all(`
    SELECT *
    FROM trigger_links
    ${includeArchived ? '' : 'WHERE archived = 0'}
    ORDER BY archived ASC, updated_at DESC, created_at DESC
  `)
  return rows.map(row => mapTriggerLink(row, { baseUrl })).filter(Boolean)
}

export async function getTriggerLink(triggerLinkId, { baseUrl = '' } = {}) {
  const id = cleanString(triggerLinkId, 180)
  if (!id) return null
  return mapTriggerLink(await db.get('SELECT * FROM trigger_links WHERE id = ?', [id]), { baseUrl })
}

export async function getTriggerLinkByPublicId(publicId, { baseUrl = '' } = {}) {
  const id = normalizePublicId(publicId)
  if (!id) return null
  return mapTriggerLink(
    await db.get('SELECT * FROM trigger_links WHERE public_id = ? AND archived = 0', [id]),
    { baseUrl }
  )
}

export async function createTriggerLink(input = {}, { userId = null, baseUrl = '' } = {}) {
  const name = cleanString(input.name, 160)
  const destinationUrl = normalizeTriggerLinkDestination(input.destinationUrl || input.destination_url || input.url)

  if (!name) throw badRequest('Ponle nombre al enlace de disparo.')

  const id = createRistakId('trigger_link')
  const publicId = await createUniquePublicId()

  await db.run(`
    INSERT INTO trigger_links (
      id, public_id, name, destination_url, description, active, archived,
      click_count, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    publicId,
    name,
    destinationUrl,
    cleanString(input.description, 800) || null,
    1,
    userId ? String(userId) : null
  ])

  return getTriggerLink(id, { baseUrl })
}

export async function updateTriggerLink(triggerLinkId, input = {}, { baseUrl = '' } = {}) {
  const existing = await getTriggerLink(triggerLinkId)
  if (!existing || existing.archived) throw notFound('Enlace de disparo no encontrado.')

  const name = input.name === undefined ? existing.name : cleanString(input.name, 160)
  if (!name) throw badRequest('Ponle nombre al enlace de disparo.')

  const destinationUrl = input.destinationUrl === undefined && input.destination_url === undefined && input.url === undefined
    ? existing.destinationUrl
    : normalizeTriggerLinkDestination(input.destinationUrl || input.destination_url || input.url)

  await db.run(`
    UPDATE trigger_links SET
      name = ?,
      destination_url = ?,
      description = ?,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    name,
    destinationUrl,
    input.description === undefined ? existing.description || null : cleanString(input.description, 800) || null,
    existing.id
  ])

  return getTriggerLink(existing.id, { baseUrl })
}

export async function archiveTriggerLink(triggerLinkId, { baseUrl = '' } = {}) {
  const existing = await getTriggerLink(triggerLinkId)
  if (!existing || existing.archived) throw notFound('Enlace de disparo no encontrado.')

  await db.run(`
    UPDATE trigger_links SET
      active = 0,
      archived = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [existing.id])

  return getTriggerLink(existing.id, { baseUrl })
}

export async function listTriggerLinkEvents(triggerLinkId, { limit = 50 } = {}) {
  const id = cleanString(triggerLinkId, 180)
  if (!id) return []
  const rows = await db.all(`
    SELECT *
    FROM trigger_link_events
    WHERE trigger_link_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `, [id, Math.max(1, Math.min(200, Number(limit) || 50))])
  return rows.map(mapTriggerLinkEvent).filter(Boolean)
}

export async function recordTriggerLinkClick(publicId, req = {}, {
  contactId: trustedContactId = '',
  triggerLinkUrl = ''
} = {}) {
  const normalizedPublicId = normalizePublicId(publicId)
  if (!normalizedPublicId) throw notFound('Enlace de disparo no encontrado.')

  let resolvedContactId = cleanString(trustedContactId, 180)
  let resolvedTriggerLinkUrl = cleanString(triggerLinkUrl, 4096)
  if (!resolvedContactId) {
    const legacyRecipientToken = getLegacyRecipientToken(req.query)
    if (legacyRecipientToken) {
      let recipient
      try {
        recipient = await readTriggerLinkRecipientToken(legacyRecipientToken)
      } catch {
        throw notFound('Enlace de disparo no encontrado.')
      }
      if (recipient.publicId !== normalizedPublicId) {
        throw notFound('Enlace de disparo no encontrado.')
      }
      resolvedContactId = recipient.contactId
      resolvedTriggerLinkUrl = `/trigger-links/${normalizedPublicId}`
    }
  }

  const row = await db.get(
    'SELECT * FROM trigger_links WHERE public_id = ? AND active = 1 AND archived = 0',
    [normalizedPublicId]
  )
  if (!row) throw notFound('Enlace de disparo no encontrado.')

  const contactId = resolvedContactId
  const contact = contactId
    ? await db.get(`
      SELECT id, phone, email, full_name, first_name, last_name
      FROM contacts
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1
    `, [contactId])
    : null
  if (contactId && !contact) {
    throw notFound('Enlace de disparo no disponible para este contacto.')
  }

  const query = sanitizePublicQuery(req.query)
  const visitorId = getRequestVisitorId(req)
  const eventId = createRistakId('trigger_link_event')
  const referrer = cleanString(req.headers?.referer || req.headers?.referrer || '', 2048)
  const userAgent = cleanString(req.headers?.['user-agent'] || '', 1000)
  const ipAddress = getRequestIp(req)
  const queryJson = JSON.stringify(query || {})

  await db.run(`
    INSERT INTO trigger_link_events (
      id, trigger_link_id, public_id, contact_id, visitor_id, ip_address,
      user_agent, referrer, query_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    eventId,
    row.id,
    row.public_id,
    contact?.id || null,
    visitorId || null,
    ipAddress || null,
    userAgent || null,
    referrer || null,
    queryJson
  ])

  await db.run(`
    UPDATE trigger_links SET
      click_count = COALESCE(click_count, 0) + 1,
      last_clicked_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [row.id])

  const event = await db.get('SELECT * FROM trigger_link_events WHERE id = ?', [eventId])
  const contactName = cleanString(contact?.full_name, 300) ||
    [contact?.first_name, contact?.last_name].map(value => cleanString(value, 160)).filter(Boolean).join(' ')
  const automationPayload = {
    contactId: contact?.id || null,
    phone: cleanString(contact?.phone, 160) || null,
    email: cleanString(contact?.email, 320) || null,
    contactName: contactName || null,
    triggerLinkId: row.id,
    triggerLinkPublicId: row.public_id,
    triggerLinkName: row.name,
    triggerLinkUrl: resolvedTriggerLinkUrl || `/trigger-links/${row.public_id}`,
    destinationUrl: row.destination_url,
    visitorId: visitorId || null,
    referrer,
    userAgent,
    ipAddress,
    query: parseJson(queryJson, {}),
    eventId,
    clickedAt: event?.created_at || new Date().toISOString()
  }

  handleAutomationEvent('trigger-link-clicked', automationPayload).catch(error => {
    logger.warn(`No se pudo disparar automatización de enlace ${row.public_id}: ${error.message}`)
  })
  return {
    link: mapTriggerLink({ ...row, click_count: Number(row.click_count || 0) + 1, last_clicked_at: event?.created_at }),
    event: mapTriggerLinkEvent(event),
    destinationUrl: row.destination_url
  }
}

export async function recordTriggerLinkRecipientClick(recipientToken, req = {}) {
  let recipient
  try {
    recipient = await readTriggerLinkRecipientToken(recipientToken)
  } catch {
    throw notFound('Enlace de disparo no encontrado.')
  }
  return recordTriggerLinkClick(recipient.publicId, req, {
    contactId: recipient.contactId,
    triggerLinkUrl: `/${cleanString(recipientToken, 4096)}`
  })
}
