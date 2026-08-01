import { db } from '../config/database.js'
import { findContactByPhoneCandidates } from './contactIdentityService.js'
import { getVariableFieldValueMap } from './variableFieldsService.js'
import { getContactCustomFieldValues } from '../utils/contactCustomFields.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { getAccountBusinessProfile } from './accountBusinessProfileService.js'

// Los field keys nuevos son simples, pero conservamos compatibilidad con aliases
// legacy (acentos/espacios) y dejamos que la politica de unknown decida que hacer.
// Los placeholders numericos {{1}} pertenecen al dialecto de plantillas oficiales
// de WhatsApp y nunca deben consumirse como variables CRM.
const TOKEN_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g
const POSITIONAL_TOKEN_PATTERN = /^\d+$/
const KNOWN_TOKEN_PREFIXES = [
  'account.',
  'business.',
  'contact.',
  'custom.',
  'trigger_link.',
  'user.',
  'variable.'
]
const MAX_TEMPLATE_TREE_DEPTH = 60

function containsTemplateToken(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return value.includes('{{')
  if (value === null || typeof value !== 'object') return false
  if (depth > MAX_TEMPLATE_TREE_DEPTH || value instanceof Date || Buffer.isBuffer(value)) return false
  if (seen.has(value)) return false
  seen.add(value)

  if (Array.isArray(value)) {
    return value.some(item => containsTemplateToken(item, depth + 1, seen))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).some(item => containsTemplateToken(item, depth + 1, seen))
}

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

function isKnownTokenNamespace(value) {
  const token = normalizeTokenKey(value)
  return KNOWN_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))
}

function addNormalizedAliases(values = {}) {
  const map = {}
  Object.entries(values || {}).forEach(([rawKey, value]) => {
    const key = cleanString(rawKey, 200)
    if (!key) return
    map[key] = value
    const normalizedKey = normalizeTokenKey(key)
    if (normalizedKey && map[normalizedKey] === undefined) map[normalizedKey] = value
  })
  return map
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
    companyName: cleanString(contact.companyName || contact.company_name || contact.company),
    address1: cleanString(contact.address1 || contact.address_1 || contact.address),
    city: cleanString(contact.city),
    state: cleanString(contact.state || contact.region),
    postalCode: cleanString(contact.postalCode || contact.postal_code || contact.zip || contact.zip_code),
    timezone: cleanString(contact.timezone || contact.time_zone),
    dateOfBirth: cleanString(contact.dateOfBirth || contact.date_of_birth || contact.dob),
    website: cleanString(contact.website || contact.web),
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
      const normalizedKey = normalizeTokenKey(key)
      if (normalizedKey && normalized.customFields[normalizedKey] === undefined) {
        normalized.customFields[normalizedKey] = valueToText(field.value)
      }
    })
  })

  if (rawCustomFields && typeof rawCustomFields === 'object' && !Array.isArray(rawCustomFields)) {
    Object.entries(rawCustomFields).forEach(([key, value]) => {
      normalized.customFields[key] = valueToText(value)
      const normalizedKey = normalizeTokenKey(key)
      if (normalizedKey && normalized.customFields[normalizedKey] === undefined) {
        normalized.customFields[normalizedKey] = valueToText(value)
      }
    })
  }

  const firstCustomValue = (...keys) => {
    for (const key of keys) {
      const value = normalized.customFields[key] ?? normalized.customFields[normalizeTokenKey(key)]
      if (value !== undefined && value !== null && value !== '') return valueToText(value)
    }
    return ''
  }
  normalized.companyName ||= firstCustomValue('company_name', 'company', 'business_name')
  normalized.address1 ||= firstCustomValue('address1', 'address_1', 'address')
  normalized.city ||= firstCustomValue('city', 'ciudad')
  normalized.state ||= firstCustomValue('state', 'region', 'estado')
  normalized.postalCode ||= firstCustomValue('postal_code', 'zip_code', 'zip', 'codigo_postal')
  normalized.timezone ||= firstCustomValue('timezone', 'time_zone', 'zona_horaria')
  normalized.dateOfBirth ||= firstCustomValue('date_of_birth', 'dob', 'fecha_nacimiento')
  normalized.website ||= firstCustomValue('website', 'web', 'sitio_web')

  return normalized
}

async function loadContact({ contactId = '', phone = '', contact = null } = {}) {
  const supplied = contact && typeof contact === 'object'
    ? normalizeContactForVariables(contact)
    : normalizeContactForVariables({})
  const id = cleanString(contactId || supplied.id, 180)
  let row = id ? await db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [id]) : null
  const candidatePhone = phone || supplied.phone
  if (!row && candidatePhone) {
    const found = await findContactByPhoneCandidates(candidatePhone)
    if (found?.id) row = await db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [found.id])
  }

  if (!row) {
    return supplied.id || supplied.phone || supplied.email
      ? supplied
      : normalizeContactForVariables({ phone: candidatePhone })
  }

  const stored = normalizeContactForVariables(row)
  const merged = { ...stored }
  for (const key of [
    'id',
    'firstName',
    'lastName',
    'fullName',
    'phone',
    'email',
    'source',
    'companyName',
    'address1',
    'city',
    'state',
    'postalCode',
    'timezone',
    'dateOfBirth',
    'website'
  ]) {
    if (supplied[key] !== '') merged[key] = supplied[key]
  }
  merged.customFields = {
    ...(stored.customFields || {}),
    ...(supplied.customFields || {})
  }
  return merged
}

async function loadAccountVariables(userId = null) {
  const cleanUserId = cleanString(userId, 80)
  const [profile, row] = await Promise.all([
    getAccountBusinessProfile(),
    cleanUserId
      ? db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [cleanUserId]
      ).catch(() => null)
      : Promise.resolve(null)
  ])
  const businessName = profile?.name || row?.business_name || ''

  return {
    ...(row
      ? {
          'user.id': row.id,
          'user.username': row.username,
          'user.email': row.email,
          'user.first_name': row.first_name,
          'user.last_name': row.last_name,
          'user.full_name': row.full_name,
          'user.phone': row.phone,
          'user.business_name': row.business_name
        }
      : {}),
    'account.business_name': businessName,
    'business.name': businessName,
    business_name: businessName
  }
}

function buildContactVariables(contact = {}) {
  const fullName = contact.fullName || [contact.firstName, contact.lastName].filter(Boolean).join(' ')
  const fullAddress = [contact.address1, contact.city, contact.state, contact.postalCode].filter(Boolean).join(', ')
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
    'contact.firstName': contact.firstName,
    'contact.last_name': contact.lastName,
    'contact.lastName': contact.lastName,
    'contact.full_name': fullName,
    'contact.fullName': fullName,
    'contact.name': fullName || contact.firstName,
    'contact.phone': contact.phone,
    'contact.phone_raw': contact.phone,
    'contact.email': contact.email,
    'contact.source': contact.source,
    'contact.company_name': contact.companyName,
    'contact.companyName': contact.companyName,
    'contact.full_address': fullAddress,
    'contact.address1': contact.address1,
    'contact.city': contact.city,
    'contact.state': contact.state,
    'contact.postal_code': contact.postalCode,
    'contact.postalCode': contact.postalCode,
    'contact.timezone': contact.timezone,
    'contact.date_of_birth': contact.dateOfBirth,
    'contact.dateOfBirth': contact.dateOfBirth,
    'contact.website': contact.website
  }

  Object.entries(contact.customFields || {}).forEach(([key, value]) => {
    const cleanKey = cleanString(key, 200)
    if (!cleanKey) return
    const text = valueToText(value)
    map[`custom.${cleanKey}`] = text
    map[`contact.custom.${cleanKey}`] = text
    if (map[cleanKey] === undefined) map[cleanKey] = text
  })

  return addNormalizedAliases(map)
}

async function buildVariableFieldVariables() {
  // Si la fuente de verdad no se puede leer, el envio/render debe fallar. Convertir
  // ese error en {} mandaria mensajes incompletos y esconderia la causa real.
  const values = await getVariableFieldValueMap()
  return addNormalizedAliases(Object.entries(values).reduce((map, [key, value]) => {
    const cleanKey = cleanString(key, 200)
    if (!cleanKey) return map
    const text = valueToText(value)
    map[`variable.${cleanKey}`] = text
    if (map[cleanKey] === undefined) map[cleanKey] = text
    return map
  }, {}))
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

  return addNormalizedAliases({
    ...accountVariables,
    ...variableFieldVariables,
    ...buildContactVariables(contact),
    ...(options.extraVariables || {})
  })
}

export async function createTemplateVariableRenderer(options = {}) {
  const contact = await loadContact(options)
  const [accountVariables, variableFieldVariables] = await Promise.all([
    loadAccountVariables(options.userId),
    buildVariableFieldVariables()
  ])
  const map = addNormalizedAliases({
    ...accountVariables,
    ...variableFieldVariables,
    ...buildContactVariables(contact),
    ...(options.extraVariables || {})
  })
  const triggerCache = new Map()

  const resolveToken = async (rawToken, fullMatch, {
    preserveUnknown = false,
    preserveMissingKnown = false,
    resolveUnknownToken,
    transformResolvedValue
  } = {}) => {
    const token = cleanString(rawToken, 200)
    if (!token) return preserveUnknown ? fullMatch : ''
    if (POSITIONAL_TOKEN_PATTERN.test(token)) return fullMatch

    const formatResolvedValue = (value) => {
      const text = valueToText(value)
      return typeof transformResolvedValue === 'function'
        ? String(transformResolvedValue(text, { token }) ?? '')
        : text
    }

    const normalizedToken = normalizeTokenKey(token)
    if (map[token] !== undefined) return formatResolvedValue(map[token])
    if (map[normalizedToken] !== undefined) return formatResolvedValue(map[normalizedToken])

    if (normalizedToken.startsWith('trigger_link.')) {
      if (!triggerCache.has(normalizedToken)) {
        const linkToken = `trigger_link.${token.slice(token.indexOf('.') + 1)}`
        triggerCache.set(normalizedToken, await resolveTriggerLinkToken(linkToken, {
          contact,
          publicBaseUrl: options.publicBaseUrl
        }))
      }
      return formatResolvedValue(triggerCache.get(normalizedToken))
    }

    if (typeof resolveUnknownToken === 'function') {
      const dynamicallyResolved = await resolveUnknownToken(token, { normalizedToken, fullMatch })
      if (dynamicallyResolved !== undefined) return formatResolvedValue(dynamicallyResolved)
    }

    // Un namespace CRM reconocido pero inexistente nunca debe llegar con
    // corcheas a un contacto ni romper JavaScript publico.
    if (isKnownTokenNamespace(normalizedToken)) return preserveMissingKnown ? fullMatch : ''
    return preserveUnknown ? fullMatch : ''
  }

  const render = async (text, renderOptions = {}) => {
    const source = String(text ?? '')
    if (!source.includes('{{')) return source

    let result = ''
    let cursor = 0
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      const index = Number(match.index || 0)
      result += source.slice(cursor, index)
      result += await resolveToken(match[1], match[0], renderOptions)
      cursor = index + match[0].length
    }
    return result + source.slice(cursor)
  }

  const renderValue = async (value, renderOptions = {}) => {
    const seen = new WeakMap()

    const visit = async (current, depth) => {
      if (typeof current === 'string') return render(current, renderOptions)
      if (current === null || typeof current !== 'object') return current
      if (depth > MAX_TEMPLATE_TREE_DEPTH) {
        throw new Error('La estructura con variables es demasiado profunda para procesarse de forma segura.')
      }
      if (current instanceof Date || Buffer.isBuffer(current)) return current
      if (seen.has(current)) return seen.get(current)

      if (Array.isArray(current)) {
        const output = []
        seen.set(current, output)
        for (const item of current) output.push(await visit(item, depth + 1))
        return output
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return current

      const output = prototype === null ? Object.create(null) : {}
      seen.set(current, output)
      for (const [key, item] of Object.entries(current)) {
        Object.defineProperty(output, key, {
          value: await visit(item, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      return output
    }

    return visit(value, 0)
  }

  return { contact, map, render, renderValue }
}

export async function renderTemplateVariables(text, options = {}, renderOptions = {}) {
  const source = String(text ?? '')
  if (!source.includes('{{')) return source
  const renderer = await createTemplateVariableRenderer(options)
  return renderer.render(source, renderOptions)
}

export async function renderTemplateVariablesInValue(value, options = {}, renderOptions = {}) {
  // La enorme mayoría de páginas, nodos y payloads no tiene tokens. Evitar las
  // lecturas de contacto/cuenta/variables en ese camino mantiene barato el render.
  if (!containsTemplateToken(value)) return value
  const renderer = await createTemplateVariableRenderer(options)
  return renderer.renderValue(value, renderOptions)
}
