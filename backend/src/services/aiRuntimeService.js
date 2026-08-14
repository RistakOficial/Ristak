import crypto from 'node:crypto'
import { db } from '../config/database.js'
import { DEFAULT_OPENAI_MODEL, LEGACY_DEFAULT_OPENAI_MODEL } from '../config/openAIModels.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'

const OPENAI_API_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL || DEFAULT_OPENAI_MODEL
const DEFAULT_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe'
const OPENAI_CREDENTIAL_RECONNECT_CODE = 'OPENAI_CREDENTIAL_RECONNECT_REQUIRED'
const OPENAI_CREDENTIAL_RECONNECT_MESSAGE = 'OpenAI necesita reconectarse. Reemplaza su API key desde Chatbot.'
const OPENAI_CREDENTIAL_REQUIRED_CODE = 'OPENAI_CREDENTIAL_REQUIRED'
const OPENAI_CREDENTIAL_REQUIRED_MESSAGE = 'Primero conecta OpenAI desde Chatbot.'
const REQUEST_TIMEOUT_MS = readBoundedNumberEnv('OPENAI_AGENT_REQUEST_TIMEOUT_MS', 45_000, 10_000, 180_000)
const BUSINESS_PROFILE_EXTRACTION_TIMEOUT_MS = readBoundedNumberEnv('OPENAI_BUSINESS_PROFILE_EXTRACTION_TIMEOUT_MS', 90_000, 15_000, 180_000)
const BUSINESS_CONTEXT_LIMIT = 50_000
export const AI_RUNTIME_BUSINESS_CONTEXT_MAX_LENGTH = BUSINESS_CONTEXT_LIMIT
const BUSINESS_PROFILE_CONTEXT_MIN_LENGTH = 40
const BUSINESS_PROFILE_TEXT_LIMIT = 1200
const BUSINESS_PROFILE_SUMMARY_LIMIT = 2400
const BUSINESS_PROFILE_SOURCE_LIMIT = 50_000
const BUSINESS_PROFILE_EXTRACTION_CONTEXT_LIMIT = 16_000
const DEFAULT_AI_RESPONSE_STYLE = 'advisor'
const DEFAULT_AI_RECOMMENDATION_MODE = 'when_useful'
const AI_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/
const LEGACY_BUSINESS_CONTEXT_FIELDS = [
  { label: 'Mercado o nicho', camelField: 'marketContext', dbField: 'market_context' },
  { label: 'Cliente ideal', camelField: 'idealCustomer', dbField: 'ideal_customer' },
  { label: 'Zona geografica', camelField: 'locationContext', dbField: 'location_context' },
  { label: 'Competidores o referencias', camelField: 'competitorsContext', dbField: 'competitors_context' },
  { label: 'Tono, prioridades y reglas', camelField: 'brandVoice', dbField: 'brand_voice' }
]

function readBoundedNumberEnv(name, fallback, min, max) {
  const rawValue = Number(process.env[name])
  if (!Number.isFinite(rawValue)) return fallback
  return Math.min(max, Math.max(min, rawValue))
}

function cleanText(value, maxLength = 1000) {
  if (!value || typeof value !== 'string') return ''
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned
}

function maskApiKey(apiKey) {
  if (!apiKey || apiKey.length < 12) return 'sk-...'
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`
}

function getOpenAIErrorMessage(data, fallback) {
  if (data?.error?.message) return data.error.message
  if (typeof data?.message === 'string') return data.message
  return fallback
}

function getAudioExtension(mimeType = '') {
  const normalized = mimeType.split(';')[0].toLowerCase()
  if (normalized.includes('mp4')) return 'mp4'
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg'
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('m4a')) return 'm4a'
  return 'webm'
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('OpenAI tardó demasiado en responder.')
      timeoutError.name = 'OpenAIRequestTimeoutError'
      timeoutError.code = 'OPENAI_REQUEST_TIMEOUT'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

function toBooleanValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function normalizeAIRuntimeModel(value) {
  const model = cleanText(String(value || ''), 100).trim()
  return AI_MODEL_ID_PATTERN.test(model) ? model : DEFAULT_MODEL
}

function normalizeAIRuntimeResponseStyle(value) {
  const normalized = normalizeText(value)
  if (['direct', 'balanced', 'advisor'].includes(normalized)) return normalized
  if (/(directo|concreto|breve|corto)/.test(normalized)) return 'direct'
  if (/(asesor|estrateg|consultor|recomend)/.test(normalized)) return 'advisor'
  if (/(balance|normal|medio)/.test(normalized)) return 'balanced'
  return DEFAULT_AI_RESPONSE_STYLE
}

function normalizeAIRuntimeRecommendationMode(value) {
  const normalized = normalizeText(value)
  if (['on_request', 'when_useful', 'proactive'].includes(normalized)) return normalized
  if (/(solo|pid|request|ask|explicit)/.test(normalized)) return 'on_request'
  if (/(riesgo|util|important|critical|cuando)/.test(normalized)) return 'when_useful'
  if (/(siempre|proactiv|asesor)/.test(normalized)) return 'proactive'
  return DEFAULT_AI_RECOMMENDATION_MODE
}

async function callOpenAIResponse(apiKey, {
  model = DEFAULT_MODEL,
  instructions,
  input,
  maxOutputTokens = 1200,
  timeoutMs = REQUEST_TIMEOUT_MS
}) {
  const response = await fetchWithTimeout(`${OPENAI_API_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: normalizeAIRuntimeModel(model),
      instructions,
      input,
      max_output_tokens: maxOutputTokens
    })
  }, timeoutMs)

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok) {
    throw new Error(getOpenAIErrorMessage(data, 'OpenAI no pudo generar la respuesta'))
  }

  const text = String(data?.output_text || data?.output
    ?.flatMap((item) => item?.content || [])
    ?.map((item) => item?.text || item?.content || '')
    ?.filter(Boolean)
    ?.join('\n') || '').trim()
  if (!text) throw new Error('OpenAI respondió sin texto utilizable')
  return { text, data }
}

export class AIRuntimeCredentialError extends Error {
  constructor(message = OPENAI_CREDENTIAL_RECONNECT_MESSAGE) {
    super(message)
    this.name = 'AIRuntimeCredentialError'
    this.code = OPENAI_CREDENTIAL_RECONNECT_CODE
    this.statusCode = 409
  }
}

export function isAIRuntimeCredentialError(error) {
  return Boolean(error?.code === OPENAI_CREDENTIAL_RECONNECT_CODE || error?.name === 'AIRuntimeCredentialError')
}

export class AIRuntimeOpenAIRequiredError extends Error {
  constructor(message = OPENAI_CREDENTIAL_REQUIRED_MESSAGE) {
    super(message)
    this.name = 'AIRuntimeOpenAIRequiredError'
    this.code = OPENAI_CREDENTIAL_REQUIRED_CODE
    this.statusCode = 409
    this.needsOpenAIConfig = true
  }
}

export function isAIRuntimeOpenAIRequiredError(error) {
  return Boolean(error?.code === OPENAI_CREDENTIAL_REQUIRED_CODE || error?.name === 'AIRuntimeOpenAIRequiredError')
}


function cleanConfigText(value, maxLength = 3000) {
  return cleanText(String(value || ''), maxLength)
}

function readConfigField(source, camelField, dbField) {
  return source?.[camelField] ?? source?.[dbField] ?? ''
}

function buildUnifiedBusinessContext(source = {}) {
  const primaryContext = cleanConfigText(
    readConfigField(source, 'businessContext', 'business_context'),
    BUSINESS_CONTEXT_LIMIT
  )
  const legacyContext = LEGACY_BUSINESS_CONTEXT_FIELDS
    .map(({ label, camelField, dbField }) => {
      const value = cleanConfigText(readConfigField(source, camelField, dbField), 1800)
      return value ? `${label}: ${value}` : ''
    })
    .filter(Boolean)

  return cleanConfigText(
    [primaryContext, ...legacyContext].filter(Boolean).join('\n\n'),
    BUSINESS_CONTEXT_LIMIT
  )
}

function getBusinessContextHash(value = '') {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
}

function normalizeBusinessContextWhitespace(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildBusinessProfileFallbackDescription(businessContext = '', maxLength = BUSINESS_PROFILE_SUMMARY_LIMIT) {
  const clean = normalizeBusinessContextWhitespace(businessContext)
  if (clean.length <= maxLength) return cleanBusinessProfileText(clean, maxLength)

  const headLength = Math.max(400, Math.floor(maxLength * 0.46))
  const tailLength = Math.max(300, Math.floor(maxLength * 0.26))
  const middleLength = Math.max(300, maxLength - headLength - tailLength - 20)
  const middleStart = Math.max(headLength, Math.floor((clean.length - middleLength) / 2))

  return cleanBusinessProfileText([
    clean.slice(0, headLength).trim(),
    clean.slice(middleStart, middleStart + middleLength).trim(),
    clean.slice(Math.max(0, clean.length - tailLength)).trim()
  ].filter(Boolean).join(' … '), maxLength)
}

const BUSINESS_PROFILE_PRIORITY_PATTERN = /\b(agenda|agendar|atiende|atencion|atención|cita|citas|cliente|clientes|condicion|condición|condiciones|costo|costos|diferenciador|diferenciadores|direccion|dirección|domingo|factura|facturacion|facturación|garantiz|horario|horarios|ideal|incluye|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|mxn|negocio|paquete|paquetes|pago|pagos|precio|precios|producto|productos|promesa|restriccion|restricción|servicio|servicios|tarjeta|ticket|transferencia|ubicacion|ubicación|vende|venta|ventas|whatsapp)\b/gi

function buildBusinessProfilePrioritySnippets(businessContext = '', maxLength = 2400) {
  const clean = normalizeBusinessContextWhitespace(businessContext)
  if (!clean || maxLength <= 0) return ''

  const sentences = clean.match(/[^.!?\n]+[.!?]?/g) || [clean]
  const snippets = []
  const seen = new Set()
  let used = 0

  for (const sentence of sentences) {
    BUSINESS_PROFILE_PRIORITY_PATTERN.lastIndex = 0
    const match = BUSINESS_PROFILE_PRIORITY_PATTERN.exec(sentence)
    if (!match) continue

    const start = Math.max(0, match.index - 220)
    const snippet = cleanBusinessProfileText(sentence.slice(start, start + 760), 760)
    const fingerprint = snippet.slice(0, 160).toLowerCase()
    if (!snippet || seen.has(fingerprint)) continue

    const nextUsed = used + snippet.length + (snippets.length ? 3 : 0)
    if (nextUsed > maxLength) break

    snippets.push(snippet)
    seen.add(fingerprint)
    used = nextUsed
  }

  return snippets.join(' | ')
}

export function buildBusinessProfileExtractionContext(businessContext = '', maxLength = BUSINESS_PROFILE_EXTRACTION_CONTEXT_LIMIT) {
  const clean = normalizeBusinessContextWhitespace(businessContext)
  if (!clean || clean.length <= maxLength) return clean

  const priorityBudget = maxLength < 6000 ? 700 : 2600
  const prioritySnippets = buildBusinessProfilePrioritySnippets(clean, priorityBudget)
  const header = [
    `Contexto completo guardado: ${clean.length} caracteres.`,
    'Este es un extracto representativo repartido entre inicio, medio y final para evitar abortos por tamaño.',
    'Extrae sólo datos presentes aquí y no inventes información.'
  ].join(' ')
  const segmentCount = maxLength < 6000 ? 2 : 4
  const overhead = header.length + prioritySnippets.length + 500
  const usableBudget = Math.max(1200, maxLength - overhead)
  const minEdgeLength = maxLength < 6000 ? 420 : 1600
  const minMiddleLength = maxLength < 6000 ? 260 : 600
  const edgeLength = Math.max(minEdgeLength, Math.floor(usableBudget * 0.28))
  const middleLength = Math.max(minMiddleLength, Math.floor((usableBudget - edgeLength * 2) / segmentCount))
  const middleStart = edgeLength
  const middleEnd = Math.max(middleStart, clean.length - edgeLength)
  const middleRange = Math.max(1, middleEnd - middleStart)
  const segments = [
    ['Inicio', clean.slice(0, edgeLength).trim()]
  ]

  for (let index = 0; index < segmentCount; index += 1) {
    const ratio = (index + 1) / (segmentCount + 1)
    const start = Math.min(
      Math.max(middleStart, Math.floor(middleStart + middleRange * ratio - middleLength / 2)),
      Math.max(middleStart, middleEnd - middleLength)
    )
    const text = clean.slice(start, start + middleLength).trim()
    if (text) {
      segments.push([`Extracto medio ${index + 1}`, text])
    }
  }

  segments.push(['Final', clean.slice(Math.max(0, clean.length - edgeLength)).trim()])

  const compacted = [
    header,
    prioritySnippets ? `## Datos prioritarios detectados\n${prioritySnippets}` : '',
    ...segments
      .filter(([, text]) => Boolean(text))
      .map(([label, text]) => `## ${label}\n${text}`)
  ].filter(Boolean).join('\n\n')

  return compacted.length <= maxLength
    ? compacted
    : `${compacted.slice(0, Math.max(0, maxLength - 1)).trim()}…`
}

function parseStoredJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseJsonObjectFromAI(text, errorMessage = 'La IA no devolvió JSON válido') {
  const raw = String(text || '').trim()

  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')

    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1))
    }

    throw new Error(errorMessage)
  }
}

function cleanBusinessProfileText(value, maxLength = BUSINESS_PROFILE_TEXT_LIMIT) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'sí' : 'no'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return cleanConfigText(String(value), maxLength)
}

function normalizeBusinessProfileType(value) {
  const normalized = cleanBusinessProfileText(value, 80).toLowerCase()
  if (['product', 'producto', 'productos'].includes(normalized)) return 'product'
  if (['service', 'servicio', 'servicios'].includes(normalized)) return 'service'
  if (['mixed', 'mixto', 'ambos', 'hibrido', 'híbrido'].includes(normalized)) return 'mixed'
  return 'unknown'
}

function normalizeBusinessProfileArray(value, maxItems = 12) {
  const source = Array.isArray(value)
    ? value
    : (value === null || value === undefined || value === '' ? [] : [value])

  return source
    .map((item) => {
      if (item === null || item === undefined) return null
      if (typeof item !== 'object' || Array.isArray(item)) {
        const text = cleanBusinessProfileText(item, 400)
        return text ? { name: text } : null
      }

      const output = {}
      for (const [key, rawValue] of Object.entries(item)) {
        if (rawValue === null || rawValue === undefined || rawValue === '') continue
        if (Array.isArray(rawValue)) {
          const values = rawValue
            .map((entry) => cleanBusinessProfileText(entry, 220))
            .filter(Boolean)
            .slice(0, 10)
          if (values.length) output[key] = values
          continue
        }
        if (typeof rawValue === 'object') {
          const nested = {}
          for (const [nestedKey, nestedValue] of Object.entries(rawValue)) {
            const clean = cleanBusinessProfileText(nestedValue, 220)
            if (clean) nested[nestedKey] = clean
          }
          if (Object.keys(nested).length) output[key] = nested
          continue
        }
        const clean = cleanBusinessProfileText(rawValue, 360)
        if (clean) output[key] = clean
      }
      return Object.keys(output).length ? output : null
    })
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeBusinessProfileObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const output = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === null || rawValue === undefined || rawValue === '') continue
    if (Array.isArray(rawValue)) {
      const list = rawValue
        .map((entry) => cleanBusinessProfileText(entry, 240))
        .filter(Boolean)
        .slice(0, 12)
      if (list.length) output[key] = list
      continue
    }
    if (typeof rawValue === 'object') {
      const nested = normalizeBusinessProfileObject(rawValue)
      if (Object.keys(nested).length) output[key] = nested
      continue
    }
    const clean = cleanBusinessProfileText(rawValue, 500)
    if (clean) output[key] = clean
  }
  return output
}

function summarizeObjectValues(value, maxLength = 700) {
  if (!value || typeof value !== 'object') return ''

  const parts = []
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === null || rawValue === undefined || rawValue === '') continue
    if (Array.isArray(rawValue)) {
      const joined = rawValue.map((item) => cleanBusinessProfileText(item, 160)).filter(Boolean).join(', ')
      if (joined) parts.push(`${key}: ${joined}`)
      continue
    }
    if (typeof rawValue === 'object') {
      const nested = summarizeObjectValues(rawValue, 240)
      if (nested) parts.push(`${key}: ${nested}`)
      continue
    }
    const clean = cleanBusinessProfileText(rawValue, 220)
    if (clean) parts.push(`${key}: ${clean}`)
  }

  return cleanBusinessProfileText(parts.join(' · '), maxLength)
}

function summarizeOfferings(offerings = []) {
  return normalizeBusinessProfileArray(offerings, 12)
    .map((item) => {
      const name = cleanBusinessProfileText(item.name || item.nombre || item.product || item.service || item.title, 120)
      const description = cleanBusinessProfileText(item.description || item.descripcion || item.summary || item.resumen, 220)
      const cadence = cleanBusinessProfileText(item.cadence || item.frequency || item.frecuencia || item.cadaCuanto, 140)
      const price = cleanBusinessProfileText(item.price || item.precio || item.priceRange || item.rangoPrecio, 160)
      const type = cleanBusinessProfileText(item.type || item.tipo, 80)
      return [name || type, description, cadence ? `frecuencia: ${cadence}` : '', price ? `valor: ${price}` : '']
        .filter(Boolean)
        .join(' · ')
    })
    .filter(Boolean)
    .slice(0, 8)
    .join('; ')
}

function summarizeLocations(locations = []) {
  return normalizeBusinessProfileArray(locations, 8)
    .map((item) => {
      const parts = [
        item.name || item.nombre,
        item.address || item.direccion,
        item.city || item.ciudad,
        item.state || item.estado,
        item.country || item.pais,
        item.postalCode || item.codigoPostal,
        item.googleMapsUrl || item.mapsUrl,
        item.modality || item.modalidad
      ].map((entry) => cleanBusinessProfileText(entry, 160)).filter(Boolean)
      return parts.join(', ')
    })
    .filter(Boolean)
    .slice(0, 5)
    .join(' | ')
}

function normalizePromptParameters(parameters = {}) {
  const output = {}
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return output

  for (const [key, value] of Object.entries(parameters)) {
    const normalizedKey = String(key || '').trim()
    const clean = cleanBusinessProfileText(value, 1200)
    if (normalizedKey && clean) output[normalizedKey] = clean
  }
  return output
}

function firstBusinessProfileValue(...values) {
  return values.map((value) => cleanBusinessProfileText(value, 1200)).find(Boolean) || ''
}

function buildBusinessProfileFallback(businessContext = '') {
  return {
    businessName: '',
    industry: '',
    businessNature: '',
    businessType: 'unknown',
    description: buildBusinessProfileFallbackDescription(businessContext),
    offerings: [],
    locations: [],
    hours: {},
    contacts: {},
    payments: {},
    pricingSummary: '',
    targetCustomers: '',
    differentiators: '',
    importantConditions: '',
    languageTone: '',
    conversationAdaptation: {},
    missingData: []
  }
}

function normalizeBusinessProfile(profile = {}, { businessContext = '' } = {}) {
  const raw = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}
  const fallback = buildBusinessProfileFallback(businessContext)
  const offerings = normalizeBusinessProfileArray(raw.offerings || raw.products || raw.services || raw.ofertas || raw.servicios || raw.productos, 14)
  const locations = normalizeBusinessProfileArray(raw.locations || raw.ubicaciones || raw.location || raw.ubicacion, 8)
  const hours = normalizeBusinessProfileObject(raw.hours || raw.horarios || raw.businessHours || {})
  const contacts = normalizeBusinessProfileObject(raw.contacts || raw.contact || raw.contacto || raw.telefonos || {})
  const payments = normalizeBusinessProfileObject(raw.payments || raw.paymentMethods || raw.pagos || raw.metodosPago || {})
  const conversationAdaptation = normalizeBusinessProfileObject(
    raw.conversationAdaptation ||
    raw.conversationalAdaptation ||
    raw.adaptacionConversacional ||
    raw.adaptacionDeCierre ||
    raw.closingAdaptation ||
    {}
  )

  return {
    businessName: firstBusinessProfileValue(raw.businessName, raw.name, raw.nombreNegocio, raw.nombre),
    industry: firstBusinessProfileValue(raw.industry, raw.industria, raw.niche, raw.nicho, raw.giro),
    businessNature: firstBusinessProfileValue(raw.businessNature, raw.naturaleza, raw.giro, raw.category, raw.categoria),
    businessType: normalizeBusinessProfileType(raw.businessType || raw.type || raw.tipoNegocio || raw.tipo),
    description: firstBusinessProfileValue(raw.description, raw.descripcion, raw.summary, raw.resumen, fallback.description),
    offerings,
    locations,
    hours,
    contacts,
    payments,
    pricingSummary: firstBusinessProfileValue(raw.pricingSummary, raw.precios, raw.priceSummary, raw.prices, summarizeOfferings(offerings)),
    targetCustomers: firstBusinessProfileValue(raw.targetCustomers, raw.clienteIdeal, raw.idealCustomer, raw.publicoObjetivo),
    differentiators: firstBusinessProfileValue(raw.differentiators, raw.diferenciadores, raw.ventajas, raw.valueProposition),
    importantConditions: firstBusinessProfileValue(raw.importantConditions, raw.conditions, raw.condiciones, raw.restricciones),
    languageTone: firstBusinessProfileValue(raw.languageTone, raw.tono, raw.brandVoice),
    conversationAdaptation,
    missingData: Array.isArray(raw.missingData || raw.datosFaltantes)
      ? (raw.missingData || raw.datosFaltantes).map((item) => cleanBusinessProfileText(item, 180)).filter(Boolean).slice(0, 12)
      : []
  }
}

function buildProfileDerivedSummaries(profile = {}, businessContext = '') {
  const offeringsSummary = summarizeOfferings(profile.offerings)
  const locationSummary = summarizeLocations(profile.locations)
  const hoursSummary = summarizeObjectValues(profile.hours, 500)
  const paymentSummary = summarizeObjectValues(profile.payments, 500)
  const contactSummary = summarizeObjectValues(profile.contacts, 500)
  const pricingSummary = firstBusinessProfileValue(profile.pricingSummary, offeringsSummary)
  const conversationAdaptationSummary = summarizeObjectValues(profile.conversationAdaptation, 900)
  const profileSummary = [
    profile.businessName ? `Negocio: ${profile.businessName}` : '',
    profile.industry ? `Industria: ${profile.industry}` : '',
    profile.businessNature ? `Giro: ${profile.businessNature}` : '',
    profile.description ? `Descripción: ${profile.description}` : '',
    offeringsSummary ? `Oferta: ${offeringsSummary}` : '',
    pricingSummary ? `Precios/valor: ${pricingSummary}` : '',
    locationSummary ? `Ubicación/modalidad: ${locationSummary}` : '',
    hoursSummary ? `Horarios: ${hoursSummary}` : '',
    paymentSummary ? `Pagos/facturación: ${paymentSummary}` : '',
    contactSummary ? `Contacto: ${contactSummary}` : '',
    profile.targetCustomers ? `Cliente ideal: ${profile.targetCustomers}` : '',
    profile.differentiators ? `Diferenciadores: ${profile.differentiators}` : '',
    profile.importantConditions ? `Condiciones: ${profile.importantConditions}` : '',
    conversationAdaptationSummary ? `Adaptación conversacional: ${conversationAdaptationSummary}` : ''
  ].filter(Boolean).join('\n')

  return {
    profileSummary: cleanBusinessProfileText(profileSummary || businessContext, BUSINESS_PROFILE_SUMMARY_LIMIT),
    offeringsSummary: cleanBusinessProfileText(offeringsSummary, 1200),
    pricingSummary: cleanBusinessProfileText(pricingSummary, 1200),
    locationSummary: cleanBusinessProfileText(locationSummary, 1200),
    hoursSummary,
    paymentSummary: cleanBusinessProfileText(paymentSummary, 1200),
    contactSummary: cleanBusinessProfileText(contactSummary, 1200),
    conversationAdaptationSummary: cleanBusinessProfileText(conversationAdaptationSummary, 1200)
  }
}

function cleanBusinessProfileListText(value, maxLength = 900) {
  if (Array.isArray(value)) {
    return cleanBusinessProfileText(
      value.map((item) => cleanBusinessProfileText(item, 220)).filter(Boolean).join('; '),
      maxLength
    )
  }
  if (value && typeof value === 'object') {
    return summarizeObjectValues(value, maxLength)
  }
  return cleanBusinessProfileText(value, maxLength)
}

function readConversationAdaptationValue(adaptation = {}, keys = [], maxLength = 1000) {
  for (const key of keys) {
    const clean = cleanBusinessProfileListText(adaptation?.[key], maxLength)
    if (clean) return clean
  }
  return ''
}

function buildBusinessConversationPromptParameters(profile = {}, summaries = {}) {
  const adaptation = profile.conversationAdaptation || {}
  const businessName = firstBusinessProfileValue(profile.businessName, 'este negocio')
  const industry = firstBusinessProfileValue(profile.industry, profile.businessNature, 'este giro')
  const offering = firstBusinessProfileValue(summaries.offeringsSummary, profile.description, 'la solución del negocio')
  const targetCustomers = firstBusinessProfileValue(profile.targetCustomers, 'la persona que escribió')
  const differentiators = firstBusinessProfileValue(profile.differentiators, '')
  const conditions = firstBusinessProfileValue(profile.importantConditions, summaries.paymentSummary, '')

  const narrativeFrame = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['narrativeFrame', 'marcoNarrativo', 'enfoqueNarrativo', 'narrativa'], 1000),
    `No presentes ${offering} como algo que se empuja. Guía a ${targetCustomers} a revisar con calma si seguir igual en el contexto de ${industry} le pesa más que tomar un siguiente paso claro.`
  )
  const customerPerception = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['customerPerception', 'percepcionDelCliente', 'percepciónDelCliente', 'perception'], 900),
    `La persona debe sentirse escuchada y con criterio para decidir, no como comprador presionado de ${businessName}.`
  )
  const languageGuidance = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['languageGuidance', 'lenguaje', 'lenguajeDelNegocio', 'languageTone'], 900),
    `Usa vocabulario natural del giro ${industry}; aterriza los ejemplos en ${offering}${differentiators ? ` y en lo que diferencia al negocio: ${differentiators}` : ''}.`
  )
  const contrastFrame = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['contrastFrame', 'marcoDeContraste', 'contraste', 'consequenceFrame'], 900),
    `El contraste debe ser entre dejar igual la situación que la persona ya contó y revisar una ruta más clara hacia el resultado que busca. No uses miedo inventado ni promesas.`
  )
  const discoveryAngles = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['discoveryAngles', 'preguntasDescubrimiento', 'angulosDeDescubrimiento', 'preguntas'], 900),
    `Pregunta qué detonó la búsqueda, qué ha intentado, qué le incomoda de seguir igual y qué resultado necesita ver para que ${offering} tenga sentido.`
  )
  const safeValueLanguage = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['safeValueLanguage', 'lenguajeSeguroDeValor', 'valueLanguage', 'lenguajeDeValor'], 900),
    'Habla de "valor", "opción", "siguiente paso", "revisarlo", "ver si te conviene" y "tener claridad"; evita sonar a transacción antes de que la persona pida avanzar.'
  )
  const forbiddenSalesLanguage = firstBusinessProfileValue(
    readConversationAdaptationValue(adaptation, ['forbiddenSalesLanguage', 'lenguajeProhibido', 'salesLanguageToAvoid', 'evitar'], 900),
    'Evita "te vendo", "compra ya", "aprovecha", "oferta", "invierte", "dinero" o "paga" salvo que la persona ya esté preguntando cómo completar el pago o el flujo necesite confirmar un dato real.'
  )

  const businessAdaptation = [
    `Marco narrativo: ${narrativeFrame}`,
    `Percepción buscada: ${customerPerception}`,
    `Lenguaje del negocio: ${languageGuidance}`,
    `Contraste útil: ${contrastFrame}`,
    `Ángulos de descubrimiento: ${discoveryAngles}`,
    `Lenguaje seguro de valor: ${safeValueLanguage}`,
    `Lenguaje de venta a evitar: ${forbiddenSalesLanguage}`,
    conditions ? `Condiciones que cambian el encuadre: ${conditions}` : ''
  ].filter(Boolean).join(' ')

  return {
    ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO: cleanBusinessProfileText(businessAdaptation, 1400),
    LENGUAJE_DEL_NEGOCIO: cleanBusinessProfileText(languageGuidance, 1000),
    NARRATIVA_DE_CONTRASTE_DEL_NEGOCIO: cleanBusinessProfileText(contrastFrame, 1000),
    PERCEPCION_DEL_CLIENTE: cleanBusinessProfileText(customerPerception, 1000),
    PREGUNTAS_DE_DESCUBRIMIENTO_DEL_NEGOCIO: cleanBusinessProfileText(discoveryAngles, 1000),
    RIESGO_VERBAL_A_EVITAR: cleanBusinessProfileText(forbiddenSalesLanguage, 1000)
  }
}

export function buildBusinessProfilePromptParameters(profile = {}, extraParameters = {}) {
  const normalizedProfile = normalizeBusinessProfile(profile)
  const summaries = buildProfileDerivedSummaries(normalizedProfile)
  const businessName = normalizedProfile.businessName || 'este negocio'
  const industry = firstBusinessProfileValue(normalizedProfile.industry, normalizedProfile.businessNature, 'industria no especificada')
  const offering = firstBusinessProfileValue(summaries.offeringsSummary, normalizedProfile.description, 'los productos o servicios del negocio')
  const location = firstBusinessProfileValue(summaries.locationSummary, 'ubicación o modalidad no especificada')
  const availability = firstBusinessProfileValue(summaries.hoursSummary, 'horarios no especificados; consulta disponibilidad real antes de prometer horarios')
  const value = firstBusinessProfileValue(summaries.pricingSummary, summaries.offeringsSummary, 'valor no especificado; consulta productos/precios reales antes de hablar de precio')
  const whoWeAre = firstBusinessProfileValue(summaries.profileSummary, normalizedProfile.description, offering)
  const whoWeHelp = firstBusinessProfileValue(
    normalizedProfile.targetCustomers,
    `personas interesadas en ${offering}`
  )
  const deepProblem = firstBusinessProfileValue(
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['problem', 'problema', 'realProblem', 'problemaReal', 'pain', 'dolor'], 1000),
    normalizedProfile.description,
    offering
  )
  const proofContext = firstBusinessProfileValue(
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['proof', 'pruebas', 'results', 'resultados', 'cases', 'casos'], 1000),
    normalizedProfile.differentiators,
    'usa solo casos, pruebas o resultados reales que aparezcan en las tools o en el perfil; si no existen, no inventes'
  )
  const marketObjections = firstBusinessProfileValue(
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['objections', 'objeciones', 'marketObjections', 'objecionesTipicas', 'truthBehindObjections', 'verdadDetrasObjeciones'], 1000),
    'detecta la objecion real en conversacion y respondela con datos reales; no inventes razones ni presiones'
  )
  const regionContext = firstBusinessProfileValue(
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['regionalContext', 'contextoRegional', 'cityContext', 'contextoCiudad', 'cultureContext', 'contextoCultural'], 1000),
    location
  )
  const customerLanguage = firstBusinessProfileValue(
    normalizedProfile.languageTone,
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['customerLanguage', 'lenguajeCliente', 'clientLanguage', 'comoHablaCliente'], 1000),
    summaries.conversationAdaptationSummary,
    `usa vocabulario natural de ${industry} y calibra el lenguaje al estilo del contacto`
  )
  const businessRegister = firstBusinessProfileValue(
    readConversationAdaptationValue(normalizedProfile.conversationAdaptation, ['register', 'registro', 'businessRegister', 'registroDelNegocio'], 600),
    normalizedProfile.languageTone,
    'registro medio: cercano, claro y profesional; ajusta informalidad segun la persona, industria y valor del servicio'
  )
  const conditions = [
    normalizedProfile.importantConditions,
    summaries.paymentSummary ? `Pagos/facturación: ${summaries.paymentSummary}` : '',
    summaries.contactSummary ? `Contacto del negocio: ${summaries.contactSummary}` : ''
  ].filter(Boolean).join(' · ') || 'sin condiciones adicionales configuradas'

  const baseParameters = {
    NOMBRE_DEL_NEGOCIO: businessName,
    ESCRIBIR_NOMBRE_DEL_NEGOCIO: businessName,
    INDUSTRIA: industry,
    ESCRIBIR_INDUSTRIA: industry,
    PRODUCTO_O_SERVICIO: offering,
    ESCRIBIR_PRODUCTO_O_SERVICIO: offering,
    INFO_GENERAL_DEL_NEGOCIO: summaries.profileSummary || normalizedProfile.description || offering,
    PEGAR_INFO_DEL_NEGOCIO: summaries.profileSummary || normalizedProfile.description || offering,
    VALOR: value,
    VALOR_DEL_PRODUCTO_O_SERVICIO: value,
    UBICACION_O_MODALIDAD: location,
    PRESENCIAL_ONLINE_AMBAS_UBICACION: location,
    MODALIDAD: location,
    UBICACION: location,
    DISPONIBILIDAD: availability,
    CONDICIONES_IMPORTANTES: conditions,
    CONDICIONES_DEL_NEGOCIO: conditions,
    QUIENES_SOMOS_QUIEN_SOY: whoWeAre,
    A_QUIEN_AYUDAMOS_Y_A_QUIEN_NO: whoWeHelp,
    EL_PROBLEMA_REAL_QUE_RESOLVEMOS: deepProblem,
    CASOS_PRUEBAS_RESULTADOS_REALES: proofContext,
    OBJECIONES_TIPICAS_DE_ESTE_MERCADO_Y_LA_VERDAD_DETRAS_DE_CADA_UNA: marketObjections,
    CONTEXTO_DE_CIUDAD_REGION_CULTURA_CREENCIAS: regionContext,
    CONTEXTO_DE_CIUDAD_REGION: regionContext,
    COMO_HABLA_NUESTRO_TIPO_DE_CLIENTE: customerLanguage,
    REGISTRO_DEL_NEGOCIO: businessRegister,
    ...buildBusinessConversationPromptParameters(normalizedProfile, summaries)
  }

  return {
    ...baseParameters,
    ...normalizePromptParameters(extraParameters)
  }
}

export function normalizeBusinessProfileExtraction(payload = {}, { businessContext = '' } = {}) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const profile = normalizeBusinessProfile(raw.profile || raw.businessProfile || raw, { businessContext })
  const promptParameters = buildBusinessProfilePromptParameters(
    profile,
    raw.promptParameters || raw.prompt_parameters || profile.promptParameters || {}
  )

  return {
    sameBusinessWithPrevious: raw.sameBusinessWithPrevious === false ? false : true,
    profile,
    promptParameters
  }
}

async function getBusinessProfileRow() {
  return db.get(`
    SELECT
      source_context,
      source_hash,
      profile_json,
      prompt_parameters_json,
      profile_summary,
      business_name,
      industry,
      business_type,
      offerings_summary,
      pricing_summary,
      location_summary,
      payment_summary,
      contact_summary,
      extraction_status,
      extraction_error,
      extracted_at,
      updated_at
    FROM ai_business_profile
    ORDER BY id ASC
    LIMIT 1
  `).catch(() => null)
}

export async function getBusinessProfileSnapshot() {
  const row = await getBusinessProfileRow()
  if (!row) {
    return {
      configured: false,
      status: 'empty',
      extractionStatus: 'empty',
      extractionError: null,
      profile: buildBusinessProfileFallback(''),
      promptParameters: buildBusinessProfilePromptParameters({}),
      sourceHash: null,
      updatedAt: null
    }
  }

  const profile = normalizeBusinessProfile(parseStoredJson(row.profile_json, {}), {
    businessContext: row.source_context || ''
  })
  const promptParameters = {
    ...buildBusinessProfilePromptParameters(profile),
    ...normalizePromptParameters(parseStoredJson(row.prompt_parameters_json, {}))
  }

  return {
    configured: Boolean(row.source_context),
    status: row.extraction_status || 'empty',
    extractionStatus: row.extraction_status || 'empty',
    extractionError: row.extraction_error || null,
    profile,
    promptParameters,
    sourceContext: row.source_context || '',
    sourceHash: row.source_hash || null,
    summary: row.profile_summary || buildProfileDerivedSummaries(profile, row.source_context || '').profileSummary,
    businessName: row.business_name || profile.businessName || null,
    industry: row.industry || profile.industry || null,
    businessType: row.business_type || profile.businessType || 'unknown',
    offeringsSummary: row.offerings_summary || '',
    pricingSummary: row.pricing_summary || '',
    locationSummary: row.location_summary || '',
    paymentSummary: row.payment_summary || '',
    contactSummary: row.contact_summary || '',
    extractedAt: row.extracted_at || null,
    updatedAt: row.updated_at || null
  }
}

async function upsertBusinessProfileRecord({
  businessContext,
  sourceHash,
  profile,
  promptParameters,
  status,
  error = null
} = {}) {
  const normalizedProfile = normalizeBusinessProfile(profile, { businessContext })
  const finalPromptParameters = {
    ...buildBusinessProfilePromptParameters(normalizedProfile),
    ...normalizePromptParameters(promptParameters)
  }
  const summaries = buildProfileDerivedSummaries(normalizedProfile, businessContext)

  await db.run(`
    INSERT INTO ai_business_profile (
      id,
      source_context,
      source_hash,
      profile_json,
      prompt_parameters_json,
      profile_summary,
      business_name,
      industry,
      business_type,
      offerings_summary,
      pricing_summary,
      location_summary,
      payment_summary,
      contact_summary,
      extraction_status,
      extraction_error,
      extracted_at,
      updated_at
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      source_context = excluded.source_context,
      source_hash = excluded.source_hash,
      profile_json = excluded.profile_json,
      prompt_parameters_json = excluded.prompt_parameters_json,
      profile_summary = excluded.profile_summary,
      business_name = excluded.business_name,
      industry = excluded.industry,
      business_type = excluded.business_type,
      offerings_summary = excluded.offerings_summary,
      pricing_summary = excluded.pricing_summary,
      location_summary = excluded.location_summary,
      payment_summary = excluded.payment_summary,
      contact_summary = excluded.contact_summary,
      extraction_status = excluded.extraction_status,
      extraction_error = excluded.extraction_error,
      extracted_at = excluded.extracted_at,
      updated_at = CURRENT_TIMESTAMP
  `, [
    cleanConfigText(businessContext, BUSINESS_PROFILE_SOURCE_LIMIT),
    sourceHash || getBusinessContextHash(businessContext),
    JSON.stringify(normalizedProfile),
    JSON.stringify(finalPromptParameters),
    summaries.profileSummary,
    normalizedProfile.businessName,
    normalizedProfile.industry,
    normalizedProfile.businessType,
    summaries.offeringsSummary,
    summaries.pricingSummary,
    summaries.locationSummary,
    summaries.paymentSummary,
    summaries.contactSummary,
    status || 'ready',
    error ? cleanConfigText(error, 800) : null
  ])

  return getBusinessProfileSnapshot()
}

function buildBusinessProfileExtractionInstructions() {
  return [
    'Eres un extractor de parámetros de negocio para Ristak.',
    'Tu trabajo es leer el contexto libre del negocio y convertirlo en un perfil estructurado para que un agente conversacional pueda responder con datos reales.',
    'No inventes datos. Si un dato no aparece, déjalo vacío, como arreglo vacío o explica que falta en missingData.',
    'Si existe un perfil anterior, decide si el contexto nuevo habla del mismo negocio.',
    'Si es el mismo negocio, mezcla datos: conserva lo anterior cuando siga vigente y agrega o corrige con lo nuevo.',
    'Si claramente es otro negocio, reemplaza el perfil anterior y usa sólo el contexto nuevo.',
    'Detecta nombre del negocio, industria, giro/naturaleza, si vende productos, servicios o ambos, ubicaciones, horarios, teléfonos, extensiones, persona encargada, precios, métodos de pago, facturación, productos/servicios, frecuencia/cadencia, condiciones, cliente ideal y tono útil.',
    'Además, extrae parámetros conversacionales del giro del negocio para rellenar los campos del guión de fábrica. No reescribas, resumas, transformes ni cambies la idea general del guión: la estructura de pull, conciencia, contraste, preguntas y cierre ya está definida por Ristak.',
    'Estos parámetros sólo deben cambiar nicho, lenguaje del negocio, objeciones, contexto del cliente, riesgos verbales y ejemplos mentales. La cadencia general sigue siendo la misma: descubrir origen, motivo, urgencia, problema real, consecuencia lógica, resultado deseado y siguiente paso.',
    'Devuelve solamente JSON válido, sin markdown, sin explicación y sin texto fuera del JSON.',
    'Schema esperado:',
    JSON.stringify({
      sameBusinessWithPrevious: true,
      profile: {
        businessName: '',
        industry: '',
        businessNature: '',
        businessType: 'service|product|mixed|unknown',
        description: '',
        offerings: [{
          name: '',
          type: '',
          description: '',
          cadence: '',
          price: '',
          conditions: ''
        }],
        locations: [{
          name: '',
          address: '',
          city: '',
          state: '',
          country: '',
          postalCode: '',
          googleMapsUrl: '',
          modality: ''
        }],
        hours: { summary: '' },
        contacts: { mainPhone: '', extension: '', whatsapp: '', email: '', personInCharge: '' },
        payments: { online: '', transfer: '', card: '', cash: '', invoice: '', summary: '' },
        pricingSummary: '',
        targetCustomers: '',
        differentiators: '',
        importantConditions: '',
        languageTone: '',
        conversationAdaptation: {
          narrativeFrame: '',
          customerPerception: '',
          languageGuidance: '',
          contrastFrame: '',
          discoveryAngles: [],
          safeValueLanguage: '',
          forbiddenSalesLanguage: ''
        },
        missingData: []
      },
      promptParameters: {
        NOMBRE_DEL_NEGOCIO: '',
        INDUSTRIA: '',
        PRODUCTO_O_SERVICIO: '',
        INFO_GENERAL_DEL_NEGOCIO: '',
        VALOR: '',
        UBICACION_O_MODALIDAD: '',
        DISPONIBILIDAD: '',
        CONDICIONES_IMPORTANTES: '',
        ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO: '',
        LENGUAJE_DEL_NEGOCIO: '',
        NARRATIVA_DE_CONTRASTE_DEL_NEGOCIO: '',
        PERCEPCION_DEL_CLIENTE: '',
        PREGUNTAS_DE_DESCUBRIMIENTO_DEL_NEGOCIO: '',
        RIESGO_VERBAL_A_EVITAR: ''
      }
    }, null, 2)
  ].join('\n')
}

async function extractBusinessProfileWithAI({ apiKey, model, businessContext, sourceBusinessContext = businessContext, previousSnapshot } = {}) {
  const previousSourceContext = previousSnapshot?.sourceContext
    ? buildBusinessProfileExtractionContext(previousSnapshot.sourceContext, 6000)
    : ''
  const { text } = await callOpenAIResponse(apiKey, {
    model: normalizeAIRuntimeModel(model),
    maxOutputTokens: 3200,
    instructions: buildBusinessProfileExtractionInstructions(),
    input: JSON.stringify({
      contextoNuevoDelNegocio: businessContext,
      contextoCompletoGuardadoCaracteres: normalizeBusinessContextWhitespace(sourceBusinessContext).length,
      perfilAnterior: previousSnapshot?.configured
        ? {
            status: previousSnapshot.extractionStatus,
            sourceContext: previousSourceContext,
            profile: previousSnapshot.profile
          }
        : null
    }, null, 2),
    temperature: 0.1,
    topP: 0.9,
    timeoutMs: BUSINESS_PROFILE_EXTRACTION_TIMEOUT_MS
  })

  return normalizeBusinessProfileExtraction(parseJsonObjectFromAI(text, 'La IA no devolvió JSON válido para el perfil del negocio'), {
    businessContext: sourceBusinessContext
  })
}

export async function syncBusinessProfileFromContext({
  businessContext,
  model,
  apiKey: providedApiKey,
  extractor = extractBusinessProfileWithAI
} = {}) {
  const normalizedContext = cleanConfigText(businessContext, BUSINESS_PROFILE_SOURCE_LIMIT)
  if (!normalizedContext) {
    await db.run('DELETE FROM ai_business_profile').catch(() => undefined)
    return getBusinessProfileSnapshot()
  }

  const sourceHash = getBusinessContextHash(normalizedContext)
  const previousSnapshot = await getBusinessProfileSnapshot()
  if (previousSnapshot.sourceHash === sourceHash && previousSnapshot.extractionStatus === 'ready') {
    return previousSnapshot
  }

  const fallbackProfile = buildBusinessProfileFallback(normalizedContext)
  if (normalizedContext.length < BUSINESS_PROFILE_CONTEXT_MIN_LENGTH) {
    return upsertBusinessProfileRecord({
      businessContext: normalizedContext,
      sourceHash,
      profile: fallbackProfile,
      status: 'needs_more_context',
      error: 'El contexto del negocio aún es demasiado corto para extraer parámetros confiables.'
    })
  }

  let apiKey = null
  if (providedApiKey !== undefined) {
    apiKey = providedApiKey || null
  } else {
    try {
      apiKey = await getOpenAIApiKey()
    } catch (error) {
      logger.warn(`[Runtime IA] No se pudo leer OpenAI para extraer perfil del negocio: ${error.message}`)
    }
  }

  if (!apiKey) {
    return upsertBusinessProfileRecord({
      businessContext: normalizedContext,
      sourceHash,
      profile: fallbackProfile,
      status: 'needs_openai',
      error: 'Falta una API Key válida de OpenAI para extraer parámetros automáticamente.'
    })
  }

  try {
    const extractionContext = buildBusinessProfileExtractionContext(normalizedContext)
    const extraction = await extractor({
      apiKey,
      model,
      businessContext: extractionContext,
      sourceBusinessContext: normalizedContext,
      previousSnapshot
    })

    return upsertBusinessProfileRecord({
      businessContext: normalizedContext,
      sourceHash,
      profile: extraction.profile,
      promptParameters: extraction.promptParameters,
      status: 'ready',
      error: null
    })
  } catch (error) {
    logger.warn(`[Runtime IA] No se pudo extraer perfil estructurado del negocio: ${error.message}`)
    return upsertBusinessProfileRecord({
      businessContext: normalizedContext,
      sourceHash,
      profile: fallbackProfile,
      status: 'ready',
      error: null
    })
  }
}

export async function getAIRuntimeConfig({ userId } = {}) {
  const config = await db.get(`
    SELECT
      openai_api_key_encrypted,
      model,
      business_context,
      market_context,
      ideal_customer,
      location_context,
      competitors_context,
      brand_voice,
      research_domains,
      response_style,
      recommendation_mode,
      web_search_enabled,
      updated_at
    FROM ai_agent_config
    ORDER BY id ASC
    LIMIT 1
  `)
  return {
    ...(config || {}),
    action_customizations: ''
  }
}

export async function getAIRuntimeStatus({ userId } = {}) {
  const config = await getAIRuntimeConfig({ userId })
  const businessContext = buildUnifiedBusinessContext(config)
  const businessProfile = await getBusinessProfileSnapshot()
  const baseStatus = {
    model: normalizeAIRuntimeModel(config?.model),
    tokenPreview: null,
    businessContext,
    businessProfile,
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: '',
    actionCustomizations: '',
    researchDomains: config?.research_domains || '',
    responseStyle: normalizeAIRuntimeResponseStyle(config?.response_style),
    recommendationMode: normalizeAIRuntimeRecommendationMode(config?.recommendation_mode),
    webSearchEnabled: toBooleanValue(config?.web_search_enabled),
    needsReconnect: false,
    connectionIssue: null,
    connectionIssueCode: null,
    updatedAt: config?.updated_at || null
  }

  if (!config?.openai_api_key_encrypted) {
    return {
      ...baseStatus,
      configured: false,
      credentialStatus: 'missing'
    }
  }

  try {
    return {
      ...baseStatus,
      configured: true,
      credentialStatus: 'ready',
      tokenPreview: maskApiKey(decrypt(config.openai_api_key_encrypted))
    }
  } catch (error) {
    logger.warn(`[Runtime IA] No se pudo leer el token guardado de OpenAI: ${error.message}`)
  }

  return {
    ...baseStatus,
    configured: false,
    credentialStatus: 'reconnect_required',
    needsReconnect: true,
    connectionIssue: OPENAI_CREDENTIAL_RECONNECT_MESSAGE,
    connectionIssueCode: OPENAI_CREDENTIAL_RECONNECT_CODE,
    tokenPreview: 'Requiere reconexión'
  }
}

export async function saveAIRuntimeOpenAICredentials({
  userId,
  apiKey,
  model = DEFAULT_MODEL
} = {}) {
  const cleanApiKey = String(apiKey || '').trim()
  if (!cleanApiKey) {
    throw new Error('Pega una API key válida de OpenAI.')
  }

  const encryptedKey = encrypt(cleanApiKey)
  const existingConfig = await db.get('SELECT id FROM ai_agent_config WHERE id = 1 LIMIT 1')
  const currentConfig = existingConfig ? await getAIRuntimeConfig({ userId }) : null
  const currentModel = String(currentConfig?.model || '').trim()
  const nextModel = normalizeAIRuntimeModel(
    !currentModel || currentModel === LEGACY_DEFAULT_OPENAI_MODEL
      ? model
      : currentModel
  )

  if (existingConfig) {
    await db.run(`
      UPDATE ai_agent_config
      SET
        openai_api_key_encrypted = ?,
        model = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [encryptedKey, nextModel])
  } else {
    await db.run(`
      INSERT INTO ai_agent_config (
        id,
        openai_api_key_encrypted,
        model,
        business_context,
        market_context,
        ideal_customer,
        location_context,
        competitors_context,
        brand_voice,
        research_domains,
        response_style,
        recommendation_mode,
        web_search_enabled,
        updated_at
      )
      VALUES (1, ?, ?, '', '', '', '', '', '', '', ?, ?, 0, CURRENT_TIMESTAMP)
    `, [
      encryptedKey,
      nextModel,
      DEFAULT_AI_RESPONSE_STYLE,
      DEFAULT_AI_RECOMMENDATION_MODE
    ])
  }

  return getAIRuntimeStatus({ userId })
}

export async function saveAIRuntimeBusinessProfile({
  userId,
  businessContext
} = {}) {
  const normalizedContext = cleanConfigText(businessContext, BUSINESS_CONTEXT_LIMIT)
  const currentConfig = await getAIRuntimeConfig({ userId })

  await db.run(`
    INSERT INTO ai_agent_config (
      id,
      business_context,
      market_context,
      ideal_customer,
      location_context,
      competitors_context,
      brand_voice,
      updated_at
    )
    VALUES (1, ?, '', '', '', '', '', CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      business_context = excluded.business_context,
      market_context = excluded.market_context,
      ideal_customer = excluded.ideal_customer,
      location_context = excluded.location_context,
      competitors_context = excluded.competitors_context,
      brand_voice = excluded.brand_voice,
      updated_at = CURRENT_TIMESTAMP
  `, [normalizedContext])

  try {
    await syncBusinessProfileFromContext({
      businessContext: normalizedContext,
      model: normalizeAIRuntimeModel(currentConfig?.model)
    })
  } catch (error) {
    // El texto guardado es la fuente primaria y el runtime puede usarlo sin el
    // perfil estructurado. Una extracción auxiliar no debe convertir un guardado
    // válido en un falso error para el usuario.
    logger.warn(`[Runtime IA] La descripción se guardó, pero no se pudo actualizar el perfil estructurado: ${error.message}`)
  }

  return getAIRuntimeStatus({ userId })
}

export async function getOpenAIApiKey() {
  const config = await getAIRuntimeConfig()

  if (!config?.openai_api_key_encrypted) {
    return null
  }

  try {
    return decrypt(config.openai_api_key_encrypted)
  } catch (error) {
    logger.warn(`[Runtime IA] Token de OpenAI guardado no se pudo desencriptar: ${error.message}`)
    throw new AIRuntimeCredentialError()
  }
}

export async function requireOpenAIApiKey() {
  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    throw new AIRuntimeOpenAIRequiredError()
  }
  return apiKey
}

export async function verifyOpenAIApiKey(apiKey) {
  const response = await fetchWithTimeout(`${OPENAI_API_URL}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  })

  let data = null

  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    return {
      valid: false,
      error: getOpenAIErrorMessage(data, 'No se pudo validar la API Key de OpenAI')
    }
  }

  return { valid: true }
}

export async function transcribeVoiceAudio({ apiKey, audioBuffer, mimeType = 'audio/webm' }) {
  if (!audioBuffer?.length) {
    throw new Error('No llegó audio para transcribir.')
  }

  const normalizedMimeType = String(mimeType || 'audio/webm').split(';')[0] || 'audio/webm'
  const formData = new FormData()
  const audioBlob = new Blob([audioBuffer], { type: normalizedMimeType })

  formData.append('file', audioBlob, `voice-message.${getAudioExtension(normalizedMimeType)}`)
  formData.append('model', DEFAULT_TRANSCRIPTION_MODEL)
  formData.append('language', 'es')
  formData.append('response_format', 'json')
  formData.append('prompt', 'Mensaje de voz en español mexicano para un agente de negocio de Ristak. Puede mencionar ventas, citas, campañas, Meta Ads, HighLevel, pagos, leads, ROAS o clientes.')

  const response = await fetchWithTimeout(`${OPENAI_API_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  })

  let data = null

  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    throw new Error(getOpenAIErrorMessage(data, 'No se pudo transcribir el audio con OpenAI.'))
  }

  const text = cleanText(data?.text || data?.transcript || '', 12000)

  if (!text) {
    throw new Error('OpenAI no devolvió texto para este audio.')
  }

  return {
    text,
    model: DEFAULT_TRANSCRIPTION_MODEL
  }
}
