import { db } from '../config/database.js'
import { findContactByPhoneCandidates } from './contactIdentityService.js'
import { getVariableFieldValueMap } from './variableFieldsService.js'
import { getContactCustomFieldValues } from '../utils/contactCustomFields.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'

const TOKEN_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g

function cleanString(value, max = 5000) {
  const cleaned = String(value ?? '').trim()
  return cleaned ? cleaned.slice(0, max) : ''
}

function valueToText(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(', ')
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return valueToText(value.value)
    if (Object.prototype.hasOwnProperty.call(value, 'fieldValue')) return valueToText(value.fieldValue)
    if (Object.prototype.hasOwnProperty.call(value, 'field_value')) return valueToText(value.field_value)
    return JSON.stringify(value)
  }
  return String(value)
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeTokenKey(value) {
  return cleanString(value, 200).toLowerCase()
}

function normalizeBaseUrl(value = '') {
  return cleanString(value, 2048).replace(/\/+$/, '')
}

function buildTriggerLinkPublicUrl(publicId, baseUrl = '') {
  const cleanPublicId = cleanString(publicId, 180)
  if (!cleanPublicId) return ''
  const path = `/trigger-links/${encodeURIComponent(cleanPublicId)}`
  const base = normalizeBaseUrl(baseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL)
  return base ? `${base}${path}` : path
}

function appendQueryParams(rawUrl, params = {}) {
  const url = cleanString(rawUrl, 2048)
  if (!url) return ''

  const entries = Object.entries(params).filter(([, value]) => cleanString(value))
  if (entries.length === 0) return url

  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
  const base = 'https://ristak.local'
  const parsed = new URL(url, isAbsolute ? undefined : base)
  entries.forEach(([key, value]) => parsed.searchParams.set(key, cleanString(value)))
  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function splitFullName(value = '') {
  const parts = cleanString(value, 300).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

function normalizeContactForVariables(contact = {}) {
  const fullName = cleanString(contact.fullName || contact.full_name || contact.name)
  const fallbackNames = splitFullName(fullName)
  const rawCustomFields = parseJson(contact.customFields ?? contact.custom_fields ?? contact.customField, contact.customFields ?? contact.custom_fields ?? contact.customField)
  const normalized = {
    id: cleanString(contact.id || contact.contactId || contact.contact_id),
    firstName: cleanString(contact.firstName || contact.first_name) || fallbackNames.firstName,
    lastName: cleanString(contact.lastName || contact.last_name) || fallbackNames.lastName,
    fullName,
    phone: normalizePhoneForStorage(contact.phone) || cleanString(contact.phone),
    email: cleanString(contact.email),
    source: cleanString(contact.source),
    customFields: {}
  }

  const customEntries = getContactCustomFieldValues({
    customFields: rawCustomFields
  })

  customEntries.forEach((field) => {
    const keys = [
      field.fieldKey,
      field.key,
      field.definitionId,
      field.id,
      field.label,
      field.name
    ].map((key) => cleanString(key)).filter(Boolean)
    keys.forEach((key) => {
      normalized.customFields[key] = valueToText(field.value)
    })
  })

  if (rawCustomFields && typeof rawCustomFields === 'object' && !Array.isArray(rawCustomFields)) {
    Object.entries(rawCustomFields).forEach(([key, value]) => {
      normalized.customFields[key] = valueToText(value)
    })
  }

  return normalized
}

async function loadContact({ contactId = '', phone = '', contact = null } = {}) {
  if (contact && typeof contact === 'object') {
    const normalized = normalizeContactForVariables(contact)
    if (normalized.id || normalized.phone || normalized.email) return normalized
  }

  const id = cleanString(contactId, 180)
  let row = id ? await db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [id]) : null
  if (!row && phone) {
    const found = await findContactByPhoneCandidates(phone)
    if (found?.id) row = await db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [found.id])
  }

  return normalizeContactForVariables(row || { phone })
}

async function loadAccountVariables(userId = null) {
  const cleanUserId = cleanString(userId, 80)
  const row = cleanUserId
    ? await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [cleanUserId]
    ).catch(() => null)
    : await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name
       FROM users
       WHERE is_active = 1
       ORDER BY id ASC
       LIMIT 1`
    ).catch(() => null)

  if (!row) return {}

  return {
    'user.id': row.id,
    'user.username': row.username,
    'user.email': row.email,
    'user.first_name': row.first_name,
    'user.last_name': row.last_name,
    'user.full_name': row.full_name,
    'user.phone': row.phone,
    'user.business_name': row.business_name,
    'account.business_name': row.business_name,
    'business.name': row.business_name,
    business_name: row.business_name
  }
}

function buildContactVariables(contact = {}) {
  const fullName = contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  const map = {
    contact_id: contact.id,
    id_contacto: contact.id,
    first_name: contact.firstName,
    nombre: contact.firstName,
    last_name: contact.lastName,
    apellido: contact.lastName,
    full_name: fullName,
    name: fullName || contact.firstName,
    nombre_completo: fullName,
    phone: contact.phone,
    telefono: contact.phone,
    teléfono: contact.phone,
    email: contact.email,
    correo: contact.email,
    source: contact.source,
    fuente: contact.source,
    'contact.id': contact.id,
    'contact.first_name': contact.firstName,
    'contact.last_name': contact.lastName,
    'contact.full_name': fullName,
    'contact.name': fullName || contact.firstName,
    'contact.phone': contact.phone,
    'contact.email': contact.email,
    'contact.source': contact.source
  }

  Object.entries(contact.customFields || {}).forEach(([key, value]) => {
    const cleanKey = cleanString(key, 200)
    if (!cleanKey) return
    const text = valueToText(value)
    map[`custom.${cleanKey}`] = text
    map[`contact.custom.${cleanKey}`] = text
    if (map[cleanKey] === undefined) map[cleanKey] = text
  })

  return map
}

async function buildVariableFieldVariables() {
  const values = await getVariableFieldValueMap().catch(() => ({}))
  return Object.entries(values).reduce((map, [key, value]) => {
    const cleanKey = cleanString(key, 200)
    if (!cleanKey) return map
    const text = valueToText(value)
    map[`variable.${cleanKey}`] = text
    if (map[cleanKey] === undefined) map[cleanKey] = text
    return map
  }, {})
}

async function resolveTriggerLinkToken(rawToken, { contact, publicBaseUrl } = {}) {
  const token = cleanString(rawToken, 200)
  if (!token.startsWith('trigger_link.')) return null
  const linkId = token.slice('trigger_link.'.length)
  if (!linkId) return ''

  const row = await db.get(`
    SELECT id, public_id
    FROM trigger_links
    WHERE archived = 0
      AND (public_id = ? OR id = ?)
    LIMIT 1
  `, [linkId, linkId]).catch(() => null)

  if (!row) return ''

  const publicUrl = buildTriggerLinkPublicUrl(row.public_id, publicBaseUrl)
  return appendQueryParams(publicUrl, {
    contact_id: contact?.id,
    phone: contact?.phone,
    email: contact?.email,
    contact_name: contact?.fullName || contact?.firstName
  })
}

export async function buildTemplateVariableMap(options = {}) {
  const contact = await loadContact(options)
  const [accountVariables, variableFieldVariables] = await Promise.all([
    loadAccountVariables(options.userId),
    buildVariableFieldVariables()
  ])

  return {
    ...accountVariables,
    ...variableFieldVariables,
    ...buildContactVariables(contact),
    ...(options.extraVariables || {})
  }
}

export async function renderTemplateVariables(text, options = {}) {
  const source = String(text ?? '')
  if (!source.includes('{{')) return source

  const contact = await loadContact(options)
  const map = await buildTemplateVariableMap({ ...options, contact })
  const triggerCache = new Map()
  const replacements = []

  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const rawToken = match[1]
    const token = cleanString(rawToken, 200)
    const normalizedToken = normalizeTokenKey(token)
    if (map[token] !== undefined) {
      replacements.push([match[0], valueToText(map[token])])
      continue
    }
    if (map[normalizedToken] !== undefined) {
      replacements.push([match[0], valueToText(map[normalizedToken])])
      continue
    }
    if (token.startsWith('trigger_link.')) {
      if (!triggerCache.has(token)) {
        triggerCache.set(token, await resolveTriggerLinkToken(token, {
          contact,
          publicBaseUrl: options.publicBaseUrl
        }))
      }
      replacements.push([match[0], valueToText(triggerCache.get(token))])
      continue
    }
    replacements.push([match[0], ''])
  }

  return replacements.reduce((next, [needle, replacement]) => next.replace(needle, replacement), source)
}
