import crypto from 'crypto'
import dns from 'node:dns/promises'
import path from 'node:path'
import JSZip from 'jszip'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../utils/contactCustomFields.js'
import { composePhoneWithDialCode } from '../utils/phoneUtils.js'
import {
  COUNTRY_OPTIONS,
  getAccountLocaleSettings,
  getCountryDefaults,
  getCountryFlagEmoji,
  normalizePhoneForAccount
} from '../utils/accountLocale.js'
import { getAIAgentConfig, getOpenAIApiKey } from './aiAgentService.js'
import { prepareContactCustomFieldsForStorage } from './contactCustomFieldDefinitionsService.js'
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import { getMetaConfig } from './metaAdsService.js'
import { createSession, linkVisitorToContact, unifyVisitorIds } from './trackingService.js'

export const SITE_TYPES = new Set(['standard_form', 'interactive_form', 'landing_page'])
export const SITE_STATUSES = new Set(['draft', 'published', 'archived'])
export const CONTENT_BLOCK_TYPES = new Set([
  'headline',
  'subheading',
  'title',
  'subtitle',
  'description',
  'text',
  'embed',
  'calendar_embed',
  'section',
  'header_panel',
  'footer_panel',
  'hero',
  'image',
  'video',
  'button',
  'benefits',
  'testimonials',
  'services',
  'form_embed',
  'social_profile',
  'faq',
  'cta'
])
export const FIELD_BLOCK_TYPES = new Set([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])
export const BLOCK_TYPES = new Set([...CONTENT_BLOCK_TYPES, ...FIELD_BLOCK_TYPES])
export const OPTION_ACTIONS = new Set([
  'continue',
  'cold_lead',
  'warm_lead',
  'hot_lead',
  'disqualify',
  'disqualify_after_submit',
  'show_message',
  'end_form',
  'jump',
  'redirect',
  'tag',
  'category'
])

const DEFAULT_THEME = {
  accentColor: '#111827',
  backgroundColor: '#ffffff',
  textColor: '#111827'
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const SITES_AI_MAX_MESSAGES = 18
const SITES_AI_MAX_MESSAGE_CHARS = 5000
const PUBLIC_DOMAIN_CACHE_TTL_MS = 15 * 60 * 1000
const PUBLIC_DOMAIN_FAILED_CACHE_TTL_MS = 90 * 1000
const PUBLIC_DOMAIN_VERIFY_TIMEOUT_MS = 6000
const DEFAULT_FUNNEL_PAGE_ID = 'page-1'
const FORM_THANK_YOU_PAGE_ID = 'page-2'
const FORM_DISQUALIFIED_PAGE_ID = 'page-3'
const FORM_FINAL_PAGE_IDS = new Set([FORM_THANK_YOU_PAGE_ID, FORM_DISQUALIFIED_PAGE_ID])
const SITE_META_NO_EVENT = 'none'
const SITE_META_EVENTS = new Set(['Lead', 'Schedule', 'Purchase', 'FormSubmitted', 'ViewContent', 'CompleteRegistration', 'Contact'])
const META_STANDARD_PIXEL_EVENTS = new Set(['Lead', 'Schedule', 'Purchase', 'ViewContent', 'CompleteRegistration', 'Contact'])
const SITE_META_TRIGGERS = new Set(['page_view', 'form_submit'])
const SITES_PUBLIC_DOMAIN_CONFIG_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}
const SOCIAL_TEMPLATE_IDS = new Set(['facebook', 'instagram', 'tiktok'])
const SOCIAL_PROFILE_BLOCK_READY_KEY = 'socialProfileBlockReady'
const IMPORTED_SITE_TEMPLATE = 'imported_html'
const IMPORTED_HTML_MAX_BYTES = 2 * 1024 * 1024
const IMPORTED_ZIP_MAX_BYTES = 15 * 1024 * 1024
const IMPORTED_ASSET_MAX_BYTES = 8 * 1024 * 1024
const IMPORTED_ASSET_TOTAL_MAX_BYTES = 25 * 1024 * 1024
const IMPORTED_ZIP_MAX_FILES = 250
const IMPORTED_HTML_EXTENSIONS = new Set(['html', 'htm'])
const IMPORTED_ASSET_CONTENT_TYPES = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['txt', 'text/plain; charset=utf-8'],
  ['svg', 'image/svg+xml; charset=utf-8'],
  ['xml', 'application/xml; charset=utf-8'],
  ['webmanifest', 'application/manifest+json; charset=utf-8'],
  ['map', 'application/json; charset=utf-8'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['pdf', 'application/pdf'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['eot', 'application/vnd.ms-fontobject'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg']
])
const IMPORTED_ASSET_ALLOWED_EXTENSIONS = new Set(IMPORTED_ASSET_CONTENT_TYPES.keys())
const IMPORTED_EDITABLE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])
const IMPORTED_STATIC_FALLBACK_STYLE = `<style data-rstk-import-static-fallback>
.reveal,
[data-aos] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
</style>`
const IMPORTED_EDITABLE_ATTR_ALIASES = {
  id: ['data-rstk-edit-id', 'data-ristak-edit-id', 'data-ristack-edit-id'],
  editable: ['data-rstk-editable', 'data-ristak-editable', 'data-ristack-editable'],
  type: ['data-rstk-edit-type', 'data-ristak-edit-type', 'data-ristack-edit-type'],
  label: ['data-rstk-label', 'data-ristak-label', 'data-ristack-label'],
  section: ['data-rstk-section', 'data-ristak-section', 'data-ristack-section']
}
const IMPORTED_EDITABLE_CONTENT_TYPES = new Set([
  'heading',
  'text',
  'button',
  'form_label',
  'placeholder',
  'image',
  'background_image'
])
const IMPORTED_FORM_STANDARD_FIELDS = new Set(['full_name', 'first_name', 'last_name', 'phone', 'email', 'message'])
const IMPORTED_AMBIGUOUS_PERSON_NAME_ALIASES = [
  'name',
  'nombre',
  'nombres',
  'tu_nombre',
  'your_name'
]
const IMPORTED_NAME_CONTEXT_EXCLUSION_TOKENS = new Set([
  'pet',
  'pets',
  'mascota',
  'mascotas',
  'dog',
  'dogs',
  'perro',
  'perros',
  'cat',
  'cats',
  'gato',
  'gatos',
  'animal',
  'animals',
  'empresa',
  'compania',
  'compañia',
  'company',
  'business',
  'negocio',
  'organization',
  'organizacion',
  'organización',
  'brand',
  'marca'
])
const IMPORTED_FORM_CUSTOM_FIELD_HINTS = new Map([
  ['fecha_de_nacimiento', 'birth_date'],
  ['fecha_nacimiento', 'birth_date'],
  ['nacimiento', 'birth_date'],
  ['cumpleanos', 'birth_date'],
  ['cumple', 'birth_date'],
  ['birthday', 'birth_date'],
  ['birth_date', 'birth_date'],
  ['birthdate', 'birth_date'],
  ['date_of_birth', 'birth_date'],
  ['dob', 'birth_date'],
  ['direccion_completa', 'full_address'],
  ['direccion', 'address'],
  ['domicilio', 'address'],
  ['address_line_1', 'address_line_1'],
  ['address1', 'address_line_1'],
  ['street_address', 'address_line_1'],
  ['calle', 'address_line_1'],
  ['colonia', 'neighborhood'],
  ['barrio', 'neighborhood'],
  ['neighborhood', 'neighborhood'],
  ['ciudad', 'city'],
  ['city', 'city'],
  ['estado', 'state'],
  ['state', 'state'],
  ['provincia', 'state'],
  ['province', 'state'],
  ['pais', 'country'],
  ['country', 'country'],
  ['codigo_postal', 'postal_code'],
  ['cp', 'postal_code'],
  ['zip', 'postal_code'],
  ['zip_code', 'postal_code'],
  ['postal_code', 'postal_code'],
  ['ubicacion', 'location'],
  ['location', 'location'],
  ['empresa', 'company_name'],
  ['compania', 'company_name'],
  ['company', 'company_name'],
  ['company_name', 'company_name'],
  ['organizacion', 'company_name'],
  ['organization', 'company_name'],
  ['negocio', 'company_name'],
  ['business_name', 'company_name'],
  ['puesto', 'job_title'],
  ['cargo', 'job_title'],
  ['job_title', 'job_title'],
  ['website', 'website'],
  ['sitio_web', 'website'],
  ['url', 'website'],
  ['tratamiento', 'treatment_interest'],
  ['treatment', 'treatment_interest'],
  ['servicio', 'service_interest'],
  ['service', 'service_interest'],
  ['sucursal', 'branch'],
  ['branch', 'branch'],
  ['fecha', 'preferred_date'],
  ['date', 'preferred_date'],
  ['hora', 'preferred_time'],
  ['time', 'preferred_time'],
  ['presupuesto', 'budget'],
  ['budget', 'budget'],
  ['edad', 'age'],
  ['age', 'age'],
  ['genero', 'gender'],
  ['gender', 'gender'],
  ['motivo', 'appointment_reason'],
  ['reason', 'appointment_reason'],
  ['nota', 'notes'],
  ['notes', 'notes']
])
const IMPORTED_STANDARD_FIELD_ALIASES = {
  email: [
    'email',
    'e_mail',
    'emailaddress',
    'email_address',
    'mail',
    'mail_address',
    'correo',
    'correo_electronico',
    'correo_electrónico',
    'correoelectronico',
    'correo_contacto',
    'contact_email',
    'customer_email',
    'client_email',
    'lead_email',
    'your_email',
    'tu_email'
  ],
  phone: [
    'phone',
    'phone_number',
    'phonenumber',
    'phone_no',
    'tel',
    'telephone',
    'telephone_number',
    'telefono',
    'teléfono',
    'numero_telefono',
    'número_telefono',
    'numero_de_telefono',
    'número_de_teléfono',
    'telefono_contacto',
    'numero_contacto',
    'contact_phone',
    'contact_number',
    'contacto',
    'contact',
    'mobile',
    'mobile_phone',
    'mobilenumber',
    'mobile_number',
    'movil',
    'móvil',
    'numero_movil',
    'cel',
    'cell',
    'cellphone',
    'cell_phone',
    'cell_number',
    'celular',
    'numero_celular',
    'whatsapp',
    'whats_app',
    'whatsapp_number',
    'whatsapp_phone',
    'numero_whatsapp',
    'número_whatsapp',
    'wpp',
    'wa',
    'sms',
    'customer_phone',
    'client_phone',
    'lead_phone',
    'your_phone',
    'tu_telefono'
  ],
  first_name: [
    'first_name',
    'firstname',
    'first',
    'fname',
    'given_name',
    'givenname',
    'forename',
    'nombre',
    'nombres',
    'primer_nombre',
    'nombre_1',
    'name_first',
    'contact_first_name',
    'customer_first_name',
    'client_first_name',
    'lead_first_name',
    'tu_nombre'
  ],
  last_name: [
    'last_name',
    'lastname',
    'last',
    'lname',
    'surname',
    'family_name',
    'familyname',
    'apellido',
    'apellidos',
    'primer_apellido',
    'segundo_apellido',
    'apellido_paterno',
    'apellido_materno',
    'name_last',
    'contact_last_name',
    'customer_last_name',
    'client_last_name',
    'lead_last_name'
  ],
  full_name: [
    'full_name',
    'fullname',
    'complete_name',
    'name',
    'nombre_completo',
    'nombre_y_apellido',
    'nombre_y_apellidos',
    'nombre_apellido',
    'nombre_apellidos',
    'nombre_completo_y_apellidos',
    'contact_name',
    'customer_name',
    'client_name',
    'lead_name',
    'person_name',
    'nombre_contacto',
    'nombre_cliente',
    'nombre_del_cliente',
    'your_name'
  ],
  message: [
    'message',
    'mensaje',
    'comments',
    'comment',
    'comentario',
    'comentarios',
    'observacion',
    'observaciones',
    'notes',
    'note',
    'nota',
    'notas',
    'details',
    'detalle',
    'detalles',
    'description',
    'descripcion',
    'descripción',
    'instrucciones',
    'additional_info',
    'additional_information'
  ]
}
const IMPORTED_CONTACT_CUSTOM_FIELD_KEYS = new Set([
  'birth_date',
  'full_address',
  'address',
  'address_line_1',
  'neighborhood',
  'city',
  'state',
  'country',
  'postal_code',
  'location',
  'company_name',
  'job_title',
  'website'
])

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeSiteMetaEventName(value, { allowNone = false, fallback = 'Lead' } = {}) {
  const eventName = cleanString(value)
  if (allowNone && eventName.toLowerCase() === SITE_META_NO_EVENT) return SITE_META_NO_EVENT
  return SITE_META_EVENTS.has(eventName) ? eventName : fallback
}

function normalizeSiteMetaTrigger(value) {
  const trigger = cleanString(value)
  return SITE_META_TRIGGERS.has(trigger) ? trigger : 'page_view'
}

function normalizeFormCompletionAction(value, fallback = 'form_default') {
  const action = cleanString(value)
  return ['form_default', 'next_page', 'next_page_if_qualified'].includes(action) ? action : fallback
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(null)
  }
}

function decodeBase64Text(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw
  return Buffer.from(base64, 'base64').toString('utf8')
}

function decodeBase64Buffer(value) {
  const raw = cleanString(value)
  if (!raw) return Buffer.alloc(0)
  const base64 = raw.includes(',') ? raw.split(',').pop() : raw
  return Buffer.from(base64, 'base64')
}

function decodeHtmlEntities(value = '') {
  return cleanString(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function stripHtmlTags(value = '') {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function parseHtmlAttributes(attributeText = '') {
  const attrs = {}
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match
  while ((match = pattern.exec(attributeText || ''))) {
    const key = cleanString(match[1]).toLowerCase()
    if (!key) continue
    attrs[key] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

function normalizeImportedFieldKey(value, fallback = 'custom_field') {
  return cleanString(value || fallback)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeImportedAssetPath(value = '') {
  const withoutNulls = String(value || '').replace(/\0/g, '').replace(/\\/g, '/').trim()
  if (!withoutNulls || withoutNulls.startsWith('/')) return ''

  const normalized = path.posix.normalize(withoutNulls).replace(/^\.\/+/, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return ''
  return normalized
}

function getImportedAssetExtension(assetPath = '') {
  const basename = normalizeImportedAssetPath(assetPath).split('/').pop() || ''
  const extension = basename.includes('.') ? basename.split('.').pop()?.toLowerCase() : ''
  return extension || ''
}

function getImportedAssetContentType(assetPath = '') {
  return IMPORTED_ASSET_CONTENT_TYPES.get(getImportedAssetExtension(assetPath)) || 'application/octet-stream'
}

function isSkippedImportedZipPath(assetPath = '') {
  const parts = normalizeImportedAssetPath(assetPath).split('/').map(part => part.toLowerCase())
  return parts.some(part => part === '__macosx' || part === '.ds_store' || part === 'thumbs.db')
}

function splitImportedUrlReference(value = '') {
  const raw = String(value || '').trim()
  const hashIndex = raw.indexOf('#')
  const beforeHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : ''
  const queryIndex = beforeHash.indexOf('?')
  const pathname = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex) : ''
  return { pathname, search, hash }
}

function isImportedExternalReference(value = '') {
  const reference = String(value || '').trim()
  return !reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)
}

function resolveImportedRelativeReference(referencePath = '', currentAssetPath = '') {
  const normalizedReference = String(referencePath || '').replace(/\\/g, '/').trim()
  if (!normalizedReference) return ''

  const currentPath = normalizeImportedAssetPath(currentAssetPath)
  const baseDir = currentPath.includes('/') ? currentPath.split('/').slice(0, -1).join('/') : ''
  const combined = normalizedReference.startsWith('/')
    ? normalizedReference.slice(1)
    : [baseDir, normalizedReference].filter(Boolean).join('/')
  return normalizeImportedAssetPath(combined)
}

function getImportedAssetPublicUrl(siteId, assetPath) {
  const encodedPath = normalizeImportedAssetPath(assetPath)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `/api/sites/public/imported-assets/${encodeURIComponent(siteId)}/${encodedPath}`
}

function rewriteImportedReferenceValue(value, currentAssetPath, siteId, availablePaths) {
  const raw = String(value || '')
  if (isImportedExternalReference(raw)) return raw

  const { pathname, search, hash } = splitImportedUrlReference(raw)
  const resolvedPath = resolveImportedRelativeReference(pathname, currentAssetPath)
  if (!resolvedPath) return raw

  let assetPath = resolvedPath
  if (!availablePaths.has(assetPath) && String(pathname || '').startsWith('/')) {
    const currentPath = normalizeImportedAssetPath(currentAssetPath)
    const rootFolder = currentPath.includes('/') ? currentPath.split('/')[0] : ''
    const prefixedPath = rootFolder ? normalizeImportedAssetPath(`${rootFolder}/${assetPath}`) : ''
    if (prefixedPath && availablePaths.has(prefixedPath)) {
      assetPath = prefixedPath
    }
  }

  if (!availablePaths.has(assetPath)) return raw

  return `${getImportedAssetPublicUrl(siteId, assetPath)}${search}${hash}`
}

function rewriteImportedSrcsetValue(value, currentAssetPath, siteId, availablePaths) {
  return String(value || '')
    .split(',')
    .map(candidate => {
      const trimmed = candidate.trim()
      if (!trimmed) return ''
      const [url, ...descriptor] = trimmed.split(/\s+/)
      return [rewriteImportedReferenceValue(url, currentAssetPath, siteId, availablePaths), ...descriptor].join(' ')
    })
    .filter(Boolean)
    .join(', ')
}

function rewriteImportedCssReferences(css = '', currentAssetPath = '', siteId = '', availablePaths = new Set()) {
  let rewritten = String(css || '').replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote, value) => {
    const nextValue = rewriteImportedReferenceValue(value, currentAssetPath, siteId, availablePaths)
    return `url(${quote || ''}${nextValue}${quote || ''})`
  })

  rewritten = rewritten.replace(/@import\s+(["'])([^"']+)\1/gi, (_match, quote, value) => {
    const nextValue = rewriteImportedReferenceValue(value, currentAssetPath, siteId, availablePaths)
    return `@import ${quote}${nextValue}${quote}`
  })

  return rewritten
}

function rewriteImportedHtmlReferences(html = '', currentAssetPath = '', siteId = '', availablePaths = new Set()) {
  let rewritten = String(html || '').replace(/\s(src|href|poster|action|srcset)\s*=\s*(["'])([^"']*)\2/gi, (_match, attr, quote, value) => {
    const nextValue = attr.toLowerCase() === 'srcset'
      ? rewriteImportedSrcsetValue(value, currentAssetPath, siteId, availablePaths)
      : rewriteImportedReferenceValue(value, currentAssetPath, siteId, availablePaths)
    return ` ${attr}=${quote}${nextValue}${quote}`
  })

  rewritten = rewritten.replace(/\s(src|href|poster|action|srcset)\s*=\s*([^\s"'=<>`]+)/gi, (_match, attr, value) => {
    const nextValue = attr.toLowerCase() === 'srcset'
      ? rewriteImportedSrcsetValue(value, currentAssetPath, siteId, availablePaths)
      : rewriteImportedReferenceValue(value, currentAssetPath, siteId, availablePaths)
    return ` ${attr}="${nextValue}"`
  })

  rewritten = rewritten.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open, css, close) => (
    `${open}${rewriteImportedCssReferences(css, currentAssetPath, siteId, availablePaths)}${close}`
  ))

  return rewritten
}

function hasImportedAlias(haystack = '', aliases = []) {
  return aliases.some(alias => {
    const normalized = normalizeImportedFieldKey(alias, '')
    if (!normalized) return false
    return new RegExp(`(?:^|\\s)${escapeRegExp(normalized)}(?:\\s|$)`).test(haystack)
  })
}

function getImportedFieldHaystack(field = {}) {
  return [
    normalizeImportedFieldKey(field.explicitField, ''),
    field.sourceName,
    field.name,
    field.htmlId,
    field.type,
    field.label,
    field.placeholder,
    field.nearbyText
  ].map(value => normalizeImportedFieldKey(value, '')).filter(Boolean).join(' ')
}

function getImportedFieldContextTokens(field = {}) {
  return new Set(
    getImportedFieldHaystack(field)
      .split(/[\s_]+/)
      .map(token => normalizeImportedFieldKey(token, ''))
      .filter(Boolean)
  )
}

function hasImportedNameContextExclusion(field = {}) {
  const tokens = getImportedFieldContextTokens(field)
  return [...tokens].some(token => IMPORTED_NAME_CONTEXT_EXCLUSION_TOKENS.has(token))
}

function isImportedAmbiguousPersonNameField(field = {}) {
  const haystack = getImportedFieldHaystack(field)
  if (!hasImportedAlias(haystack, IMPORTED_AMBIGUOUS_PERSON_NAME_ALIASES)) return false
  return !hasImportedNameContextExclusion(field)
}

function isImportedAmbiguousMappedPersonNameField(field = {}) {
  return isImportedAmbiguousPersonNameField({
    sourceName: field.sourceName,
    name: field.sourceName,
    type: field.type,
    label: field.label,
    placeholder: field.label
  })
}

function getImportedStandardAliasKey(haystack = '') {
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.email)) return 'email'
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.phone)) return 'phone'
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.last_name)) return 'last_name'
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.first_name)) return 'first_name'
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.full_name)) return 'full_name'
  if (hasImportedAlias(haystack, IMPORTED_STANDARD_FIELD_ALIASES.message)) return 'message'
  return ''
}

function getImportedCustomHintDestination(haystack = '', allowedKeys = null) {
  const tokens = haystack.split(/\s+/).filter(Boolean)
  for (const [hint, key] of IMPORTED_FORM_CUSTOM_FIELD_HINTS.entries()) {
    if (allowedKeys && !allowedKeys.has(key)) continue
    const matched = tokens.some(token => (
      token === hint ||
      token.startsWith(`${hint}_`) ||
      token.endsWith(`_${hint}`)
    ))
    if (matched) {
      return { destinationType: 'custom', destinationKey: key, confidence: 0.76 }
    }
  }
  return null
}

function shouldApplyImportedStaticFallback(html = '') {
  return /\bclass\s*=\s*(["'])[^"']*\breveal\b[^"']*\1/i.test(html) || /\sdata-aos(?:\s|=|>)/i.test(html)
}

function injectImportedStaticFallback(html = '', report = []) {
  if (!shouldApplyImportedStaticFallback(html) || /data-rstk-import-static-fallback/i.test(html)) return html

  report.push('Se activo respaldo visual para animaciones sin scripts')

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${IMPORTED_STATIC_FALLBACK_STYLE}</head>`)
  }

  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b[^>]*>/i, match => `${match}${IMPORTED_STATIC_FALLBACK_STYLE}`)
  }

  return `${IMPORTED_STATIC_FALLBACK_STYLE}${html}`
}

function sanitizeImportedHtml(html = '') {
  const report = []
  let sanitized = String(html || '')

  if (!sanitized.trim()) {
    throw new Error('El archivo HTML esta vacio')
  }

  if (Buffer.byteLength(sanitized, 'utf8') > IMPORTED_HTML_MAX_BYTES) {
    throw new Error('El HTML es demasiado grande. Sube un archivo de maximo 2 MB.')
  }

  const removals = [
    { pattern: /<script\b[\s\S]*?<\/script>/gi, label: 'scripts' },
    { pattern: /<iframe\b[\s\S]*?<\/iframe>/gi, label: 'iframes' },
    { pattern: /<object\b[\s\S]*?<\/object>/gi, label: 'objects' },
    { pattern: /<embed\b[\s\S]*?>/gi, label: 'embeds' },
    { pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, label: 'meta refresh' },
    { pattern: /<base\b[^>]*>/gi, label: 'base tags' }
  ]

  for (const removal of removals) {
    const count = (sanitized.match(removal.pattern) || []).length
    if (count) report.push(`Se quitaron ${count} ${removal.label}`)
    sanitized = sanitized.replace(removal.pattern, '')
  }

  sanitized = sanitized.replace(/\s(on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (_match, attr) => {
    report.push(`Se quito atributo ${attr}`)
    return ''
  })
  sanitized = sanitized.replace(/\s(href|src|action)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, (_match, attr) => {
    report.push(`Se bloqueo ${attr} con javascript`)
    return ` ${attr}="#"`;
  })
  sanitized = sanitized.replace(/<form\b([^>]*)>/gi, '<form$1 data-rstk-import-form novalidate>')

  if (!/<html[\s>]/i.test(sanitized)) {
    sanitized = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${sanitized}</body></html>`
  }

  sanitized = injectImportedStaticFallback(sanitized, report)

  return {
    html: sanitized,
    report: Array.from(new Set(report))
  }
}

function getLabelForField(html = '', attrs = {}) {
  const id = cleanString(attrs.id)
  if (id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const labelMatch = html.match(new RegExp(`<label\\b[^>]*for=["']?${escapedId}["']?[^>]*>([\\s\\S]*?)<\\/label>`, 'i'))
    if (labelMatch) return stripHtmlTags(labelMatch[1])
  }

  return ''
}

function getNearbyText(html = '', startIndex = 0) {
  const before = html.slice(Math.max(0, startIndex - 360), startIndex)
  const headingMatch = before.match(/<(h1|h2|h3|legend|strong|b|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)
  const lastHeading = headingMatch?.[headingMatch.length - 1] || ''
  return stripHtmlTags(lastHeading || before.slice(-180))
}

function extractImportedFields(formHtml = '', formIndex = 0) {
  const fields = []
  const candidates = []
  const inputPattern = /<input\b([^>]*)\/?\s*>/gi
  const textareaPattern = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi
  const selectPattern = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi
  let match

  while ((match = inputPattern.exec(formHtml))) {
    candidates.push({ tag: 'input', attrsText: match[1] || '', body: '', index: match.index })
  }

  while ((match = textareaPattern.exec(formHtml))) {
    candidates.push({ tag: 'textarea', attrsText: match[1] || '', body: match[2] || '', index: match.index })
  }

  while ((match = selectPattern.exec(formHtml))) {
    candidates.push({ tag: 'select', attrsText: match[1] || '', body: match[2] || '', index: match.index })
  }

  candidates.sort((a, b) => a.index - b.index)

  let index = 0

  for (const candidate of candidates) {
    const tag = candidate.tag
    const attrs = parseHtmlAttributes(candidate.attrsText)
    const type = tag === 'input' ? cleanString(attrs.type || 'text').toLowerCase() : tag
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue

    const explicitField = cleanString(attrs['data-rstk-field'] || attrs['data-ristack-field'] || attrs['data-ristak-field'])
    const explicitCustomField = cleanString(attrs['data-rstk-custom-field'] || attrs['data-ristack-custom-field'] || attrs['data-ristak-custom-field'])
    const sourceName = cleanString(attrs.name || attrs.id || explicitField || explicitCustomField || `field_${formIndex + 1}_${index + 1}`)
    const fieldId = normalizeImportedFieldKey(sourceName, `field_${formIndex + 1}_${index + 1}`)
    const label = getLabelForField(formHtml, attrs) || cleanString(attrs['aria-label']) || cleanString(attrs.placeholder) || sourceName
    const options = []
    if (tag === 'select') {
      const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
      const selectHtml = candidate.body || ''
      let optionMatch
      while ((optionMatch = optionPattern.exec(selectHtml))) {
        const optionAttrs = parseHtmlAttributes(optionMatch[1] || '')
        const optionLabel = stripHtmlTags(optionMatch[2] || '')
        const value = cleanString(optionAttrs.value || optionLabel)
        if (value || optionLabel) {
          options.push({ label: optionLabel || value, value })
        }
      }
    }

    fields.push({
      id: fieldId,
      sourceName,
      name: cleanString(attrs.name),
      htmlId: cleanString(attrs.id),
      type,
      tag,
      placeholder: cleanString(attrs.placeholder),
      label,
      nearbyText: getNearbyText(formHtml, candidate.index),
      explicitField,
      explicitCustomField,
      required: attrs.required !== undefined || cleanString(attrs['aria-required']).toLowerCase() === 'true',
      options
    })
    index += 1
  }

  return fields
}

function detectImportedForms(html = '') {
  const forms = []
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
  let formMatch
  let formIndex = 0

  while ((formMatch = formPattern.exec(html))) {
    const attrs = parseHtmlAttributes(formMatch[1] || '')
    const formHtml = formMatch[2] || ''
    const explicitForm = cleanString(attrs['data-rstk-form'] || attrs['data-ristack-form'] || attrs['data-ristak-form'])
    const importedFormId = cleanString(attrs['data-rstk-form-id'])
    const fields = extractImportedFields(formHtml, formIndex)
    const buttonMatch = formHtml.match(/<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*type=["']?submit["']?[^>]*)>/i)
    const submitText = buttonMatch
      ? stripHtmlTags(buttonMatch[2] || parseHtmlAttributes(buttonMatch[3] || '').value || 'Enviar')
      : 'Enviar'
    const title = getNearbyText(html, formMatch.index) || explicitForm || `Formulario ${formIndex + 1}`

    if (fields.length) {
      forms.push({
        id: normalizeImportedFieldKey(explicitForm || importedFormId || attrs.id || attrs.name || `form_${formIndex + 1}`, `form_${formIndex + 1}`),
        explicitForm,
        title,
        purpose: 'lead_capture',
        submitText,
        fields
      })
      formIndex += 1
    }
  }

  if (forms.length === 0) {
    const fields = extractImportedFields(html, 0)
    if (fields.length) {
      forms.push({
        id: 'form_1',
        explicitForm: '',
        title: getNearbyText(html, 0) || 'Formulario detectado',
        purpose: 'lead_capture',
        submitText: 'Enviar',
        fields
      })
    }
  }

  return forms
}

function ensureUniqueImportedFormId(baseId = 'form', usedIds = new Set()) {
  const normalized = normalizeImportedFieldKey(baseId, 'form')
  let candidate = normalized
  let index = 2
  while (usedIds.has(candidate)) {
    candidate = `${normalized}_${index}`
    index += 1
  }
  usedIds.add(candidate)
  return candidate
}

function namespaceImportedPageForms(forms = [], pagePath = '', usedIds = new Set()) {
  const pageKey = normalizeImportedFieldKey(pagePath.replace(/\.[^.]+$/, ''), 'page')
  return forms.map((form, index) => {
    const explicitId = cleanString(form.explicitForm)
    const baseId = explicitId
      ? form.id
      : normalizeImportedFieldKey(`${pageKey}_${form.id || `form_${index + 1}`}`, `form_${index + 1}`)
    const id = ensureUniqueImportedFormId(baseId, usedIds)

    return {
      ...form,
      id,
      pagePath,
      title: cleanString(form.title) || `Formulario ${index + 1}`
    }
  })
}

function assignImportedFormIds(html = '', forms = []) {
  let formIndex = 0
  return String(html || '').replace(/<form\b([^>]*)>/gi, (match, attrsText = '') => {
    const attrs = parseHtmlAttributes(attrsText)
    if (cleanString(attrs['data-rstk-form-id'])) {
      formIndex += 1
      return match
    }

    const formId = cleanString(forms[formIndex]?.id)
    formIndex += 1
    if (!formId) return match

    return `<form${attrsText} data-rstk-form-id="${escapeHtml(formId)}">`
  })
}

function getImportedEditableAttr(attrs = {}, key = '') {
  const aliases = IMPORTED_EDITABLE_ATTR_ALIASES[key] || []
  for (const alias of aliases) {
    const value = cleanString(attrs[alias])
    if (value) return value
  }
  return ''
}

function hasImportedEditableAttr(attrs = {}, key = '') {
  return Boolean(getImportedEditableAttr(attrs, key))
}

function collectImportedEditableIds(html = '') {
  const ids = new Set()
  const tagPattern = /<[a-z][\w:-]*\b([^>]*)>/gi
  let match
  while ((match = tagPattern.exec(String(html || '')))) {
    const id = getImportedEditableAttr(parseHtmlAttributes(match[1] || ''), 'id')
    if (id) ids.add(id)
  }
  return ids
}

function normalizeImportedEditableContentType(value = '') {
  const type = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_')
  return IMPORTED_EDITABLE_CONTENT_TYPES.has(type) ? type : ''
}

function makeImportedEditableId(type = 'text', label = '', usedIds = new Set()) {
  const base = normalizeImportedFieldKey(`${type}_${label || 'elemento'}`, `${type}_elemento`).slice(0, 72)
  let candidate = base
  let index = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}_${index}`
    index += 1
  }
  usedIds.add(candidate)
  return candidate
}

function buildImportedEditableAttributes(attrsText = '', { type = 'text', label = '', usedIds = new Set() } = {}) {
  const attrs = parseHtmlAttributes(attrsText)
  const additions = []
  const normalizedType = normalizeImportedEditableContentType(type) || 'text'
  const normalizedLabel = limitString(stripHtmlTags(label) || attrs.alt || attrs.placeholder || attrs.name || attrs.id || normalizedType, 80)

  if (!hasImportedEditableAttr(attrs, 'editable')) additions.push('data-rstk-editable="true"')
  if (!hasImportedEditableAttr(attrs, 'type')) additions.push(`data-rstk-edit-type="${escapeHtml(normalizedType)}"`)
  if (!hasImportedEditableAttr(attrs, 'label')) additions.push(`data-rstk-label="${escapeHtml(normalizedLabel)}"`)
  if (!hasImportedEditableAttr(attrs, 'id')) {
    additions.push(`data-rstk-edit-id="${escapeHtml(makeImportedEditableId(normalizedType, normalizedLabel, usedIds))}"`)
  }

  return additions.length ? ` ${additions.join(' ')}` : ''
}

function buildImportedSectionAttributes(attrsText = '', { label = '' } = {}) {
  const attrs = parseHtmlAttributes(attrsText)
  const additions = []
  const normalizedLabel = limitString(stripHtmlTags(label) || attrs.id || attrs.class || 'Seccion', 80)

  if (!hasImportedEditableAttr(attrs, 'section')) additions.push(`data-rstk-section="${escapeHtml(normalizedLabel)}"`)
  if (!hasImportedEditableAttr(attrs, 'label')) additions.push(`data-rstk-label="${escapeHtml(normalizedLabel)}"`)

  return additions.length ? ` ${additions.join(' ')}` : ''
}

function addImportedEditableAttributesToTag(tagName = 'div', attrsText = '', selfClose = '', options = {}) {
  return `<${tagName}${attrsText}${buildImportedEditableAttributes(attrsText, options)}${selfClose ? ' /' : ''}>`
}

function addImportedSectionAttributesToTag(tagName = 'section', attrsText = '', selfClose = '', options = {}) {
  return `<${tagName}${attrsText}${buildImportedSectionAttributes(attrsText, options)}${selfClose ? ' /' : ''}>`
}

function isSimpleEditableTextHtml(innerHtml = '') {
  const text = stripHtmlTags(innerHtml)
  if (!text || text.length > 700) return false
  return !/<(script|style|form|fieldset|input|textarea|select|option|button|a|img|picture|svg|video|iframe|table|ul|ol|li|section|article|header|footer|main|div)\b/i.test(innerHtml)
}

function getImportedElementLabel(tagName = '', attrs = {}, fallback = '') {
  return limitString(
    attrs['aria-label'] ||
    attrs.alt ||
    attrs.placeholder ||
    attrs.value ||
    attrs.name ||
    attrs.id ||
    attrs.class ||
    fallback ||
    tagName,
    80
  )
}

function getImportedTextEditType(tagName = '', attrs = {}) {
  const tag = cleanString(tagName).toLowerCase()
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'label') return 'form_label'
  if (tag === 'button') return 'button'
  if (tag === 'a') {
    const buttonHint = `${attrs.role || ''} ${attrs.class || ''} ${attrs.id || ''}`.toLowerCase()
    return /\b(button|btn|cta|call|action)\b/.test(buttonHint) ? 'button' : 'text'
  }
  return 'text'
}

function annotateImportedTextTags(html = '', usedIds = new Set()) {
  return String(html || '').replace(/<(h[1-6]|p|label|button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tagName, attrsText = '', innerHtml = '') => {
    if (!isSimpleEditableTextHtml(innerHtml)) return match
    const attrs = parseHtmlAttributes(attrsText)
    const openTag = addImportedEditableAttributesToTag(tagName, attrsText, '', {
      type: getImportedTextEditType(tagName, attrs),
      label: getImportedElementLabel(tagName, attrs, stripHtmlTags(innerHtml)),
      usedIds
    })
    return `${openTag}${innerHtml}</${tagName}>`
  })
}

function annotateImportedInputs(html = '', usedIds = new Set()) {
  let nextHtml = String(html || '').replace(/<input\b([^>]*?)\s*(\/?)>/gi, (match, attrsText = '', selfClose = '') => {
    const attrs = parseHtmlAttributes(attrsText)
    const type = cleanString(attrs.type || 'text').toLowerCase()
    if (['hidden', 'reset', 'file', 'checkbox', 'radio'].includes(type)) return match
    if (['submit', 'button'].includes(type)) {
      return addImportedEditableAttributesToTag('input', attrsText, selfClose, {
        type: 'button',
        label: getImportedElementLabel('input', attrs, attrs.value || 'Boton'),
        usedIds
      })
    }
    if (!cleanString(attrs.placeholder)) return match
    return addImportedEditableAttributesToTag('input', attrsText, selfClose, {
      type: 'placeholder',
      label: getImportedElementLabel('input', attrs, attrs.placeholder),
      usedIds
    })
  })

  nextHtml = nextHtml.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (match, attrsText = '', innerHtml = '') => {
    const attrs = parseHtmlAttributes(attrsText)
    if (!cleanString(attrs.placeholder)) return match
    const openTag = addImportedEditableAttributesToTag('textarea', attrsText, '', {
      type: 'placeholder',
      label: getImportedElementLabel('textarea', attrs, attrs.placeholder),
      usedIds
    })
    return `${openTag}${innerHtml}</textarea>`
  })

  return nextHtml
}

function annotateImportedImages(html = '', usedIds = new Set()) {
  return String(html || '').replace(/<img\b([^>]*?)\s*(\/?)>/gi, (match, attrsText = '', selfClose = '') => {
    const attrs = parseHtmlAttributes(attrsText)
    if (!cleanString(attrs.src)) return match
    return addImportedEditableAttributesToTag('img', attrsText, selfClose, {
      type: 'image',
      label: getImportedElementLabel('img', attrs, 'Imagen'),
      usedIds
    })
  })
}

function annotateImportedBackgroundImages(html = '', usedIds = new Set()) {
  return String(html || '').replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (match, tagName, attrsText = '') => {
    const tag = cleanString(tagName).toLowerCase()
    if (['img', 'html', 'head', 'meta', 'link', 'style', 'script'].includes(tag)) return match
    const attrs = parseHtmlAttributes(attrsText)
    if (!cleanString(attrs.style) || !/background(?:-image)?\s*:/i.test(attrs.style) || !/url\s*\(/i.test(attrs.style)) return match
    if (hasImportedEditableAttr(attrs, 'type')) return match
    return addImportedEditableAttributesToTag(tagName, attrsText, '', {
      type: 'background_image',
      label: getImportedElementLabel(tagName, attrs, 'Imagen de fondo'),
      usedIds
    })
  })
}

function annotateImportedSections(html = '') {
  return String(html || '').replace(/<(section|header|main|footer|article|div)\b([^>]*)>/gi, (match, tagName, attrsText = '') => {
    const attrs = parseHtmlAttributes(attrsText)
    const tag = cleanString(tagName).toLowerCase()
    const classHint = `${attrs.id || ''} ${attrs.class || ''}`.toLowerCase()
    const shouldMark = tag !== 'div' || /\b(hero|section|container|wrapper|banner|features|services|contact|form|cta|footer|header|main)\b/.test(classHint)
    if (!shouldMark) return match
    return addImportedSectionAttributesToTag(tagName, attrsText, '', {
      label: getImportedElementLabel(tagName, attrs, tag === 'div' ? 'Seccion' : tag)
    })
  })
}

function annotateImportedEditableHtml(html = '') {
  const usedIds = collectImportedEditableIds(html)
  let nextHtml = annotateImportedSections(html)
  nextHtml = annotateImportedTextTags(nextHtml, usedIds)
  nextHtml = annotateImportedInputs(nextHtml, usedIds)
  nextHtml = annotateImportedImages(nextHtml, usedIds)
  nextHtml = annotateImportedBackgroundImages(nextHtml, usedIds)
  return nextHtml
}

function hasImportedEditId(attrsText = '', editId = '') {
  return getImportedEditableAttr(parseHtmlAttributes(attrsText), 'id') === editId
}

function getImportedEditTypeFromAttrs(attrsText = '') {
  return normalizeImportedEditableContentType(getImportedEditableAttr(parseHtmlAttributes(attrsText), 'type'))
}

function setHtmlAttribute(openingTag = '', _attrsText = '', attrName = '', value = '') {
  const escapedValue = escapeHtml(value)
  const attrPattern = new RegExp(`(\\s${escapeRegExp(attrName)}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i')
  if (attrPattern.test(openingTag)) {
    return openingTag.replace(attrPattern, (_match, prefix) => `${prefix}"${escapedValue}"`)
  }

  const insertAt = openingTag.endsWith('/>') ? openingTag.length - 2 : openingTag.length - 1
  const spacer = openingTag[insertAt - 1] === ' ' ? '' : ' '
  return `${openingTag.slice(0, insertAt)}${spacer}${attrName}="${escapedValue}"${openingTag.slice(insertAt)}`
}

function normalizeImportedEditableImageUrl(value = '') {
  const raw = cleanString(value)
  if (!raw) {
    const error = new Error('La URL de la imagen esta vacia')
    error.status = 400
    throw error
  }
  if (raw.startsWith('/')) return raw
  const absoluteUrl = safeUrl(raw)
  if (absoluteUrl) return absoluteUrl
  const error = new Error('Usa una URL completa de imagen con http o https')
  error.status = 400
  throw error
}

function setStyleBackgroundUrl(style = '', url = '') {
  const nextUrl = normalizeImportedEditableImageUrl(url)
  const safeBackground = `url("${nextUrl.replace(/"/g, '%22')}")`
  if (/url\s*\(/i.test(style)) {
    return String(style || '').replace(/url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/i, safeBackground)
  }
  const prefix = cleanString(style).replace(/;?\s*$/, '')
  return `${prefix}${prefix ? '; ' : ''}background-image: ${safeBackground}`
}

function getImportedEditableTextValue(input = {}) {
  const value = limitString(String(input.value ?? input.text ?? input.url ?? ''), 5000).trim()
  if (!value) {
    const error = new Error('El contenido nuevo esta vacio')
    error.status = 400
    throw error
  }
  return value
}

const IMPORTED_BUTTON_ACTIONS = new Set(['none', 'url', 'next_page', 'specific_page', 'submit', 'disqualify'])

function normalizeImportedButtonAction(value = '') {
  const action = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_')
  return IMPORTED_BUTTON_ACTIONS.has(action) ? action : ''
}

function hasImportedButtonActionPatch(input = {}) {
  return [
    input.buttonAction,
    input.button_action,
    input.buttonUrl,
    input.button_url,
    input.buttonPageId,
    input.button_page_id,
    input.buttonMessage,
    input.button_message
  ].some(value => value !== undefined)
}

function getImportedButtonActionPatch(input = {}) {
  if (!hasImportedButtonActionPatch(input)) return null

  const action = normalizeImportedButtonAction(input.buttonAction || input.button_action || 'none')
  if (!action) {
    const error = new Error('Accion de boton importado invalida')
    error.status = 400
    throw error
  }

  const buttonUrl = cleanString(input.buttonUrl || input.button_url)
  const buttonPageId = cleanString(input.buttonPageId || input.button_page_id)
  const buttonMessage = limitString(cleanString(input.buttonMessage || input.button_message), 500)

  if (action === 'url' && !safeHref(buttonUrl, '')) {
    const error = new Error('Usa una URL valida para el boton')
    error.status = 400
    throw error
  }

  if (action === 'specific_page' && !buttonPageId) {
    const error = new Error('Selecciona la pagina destino del boton')
    error.status = 400
    throw error
  }

  return {
    action,
    buttonUrl,
    buttonPageId,
    buttonMessage
  }
}

function getImportedPageHref(pageId = '') {
  const cleanPageId = cleanString(pageId)
  return cleanPageId ? `?page=${encodeURIComponent(cleanPageId)}` : '#'
}

function setImportedButtonActionAttributes(openingTag = '', attrsText = '', patch = null) {
  if (!patch) return openingTag

  let nextTag = openingTag
  nextTag = setHtmlAttribute(nextTag, attrsText, 'data-rstk-button-action', patch.action)
  nextTag = setHtmlAttribute(nextTag, attrsText, 'data-rstk-button-url', patch.action === 'url' ? safeHref(patch.buttonUrl, '') : '')
  nextTag = setHtmlAttribute(nextTag, attrsText, 'data-rstk-button-page-id', ['specific_page', 'disqualify'].includes(patch.action) ? patch.buttonPageId : '')
  nextTag = setHtmlAttribute(nextTag, attrsText, 'data-rstk-button-message', patch.action === 'disqualify' ? patch.buttonMessage : '')

  const tagName = cleanString((nextTag.match(/^<\s*([a-z][\w:-]*)/i) || [])[1]).toLowerCase()
  if (tagName === 'a') {
    if (patch.action === 'url') return setHtmlAttribute(nextTag, attrsText, 'href', safeHref(patch.buttonUrl, '#'))
    if (patch.action === 'specific_page') return setHtmlAttribute(nextTag, attrsText, 'href', getImportedPageHref(patch.buttonPageId))
    return setHtmlAttribute(nextTag, attrsText, 'href', '#')
  }

  if (tagName === 'button' || tagName === 'input') {
    const buttonType = patch.action === 'submit' ? 'submit' : 'button'
    nextTag = setHtmlAttribute(nextTag, attrsText, 'type', buttonType)
  }

  return nextTag
}

function applyImportedEditableContentUpdate(html = '', input = {}) {
  const editId = cleanString(input.editId || input.edit_id)
  const editType = normalizeImportedEditableContentType(input.editType || input.edit_type)
  const value = getImportedEditableTextValue(input)
  const buttonActionPatch = editType === 'button' ? getImportedButtonActionPatch(input) : null

  if (!editId || !editType) {
    const error = new Error('Seleccion invalida para editar contenido')
    error.status = 400
    throw error
  }

  let updated = false
  let nextHtml = annotateImportedEditableHtml(html)

  if (editType === 'image') {
    const imageUrl = normalizeImportedEditableImageUrl(value)
    nextHtml = nextHtml.replace(/<img\b([^>]*?)\s*(\/?)>/gi, (match, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'image') return match
      updated = true
      return setHtmlAttribute(match, attrsText, 'src', imageUrl)
    })
  } else if (editType === 'background_image') {
    nextHtml = nextHtml.replace(/<([a-z][\w:-]*)\b([^>]*)>/gi, (match, _tagName, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'background_image') return match
      const attrs = parseHtmlAttributes(attrsText)
      updated = true
      return setHtmlAttribute(match, attrsText, 'style', setStyleBackgroundUrl(attrs.style || '', value))
    })
  } else if (editType === 'placeholder') {
    nextHtml = nextHtml.replace(/<input\b([^>]*?)\s*(\/?)>/gi, (match, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'placeholder') return match
      updated = true
      return setHtmlAttribute(match, attrsText, 'placeholder', value)
    })
    nextHtml = nextHtml.replace(/<textarea\b([^>]*)>/gi, (match, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'placeholder') return match
      updated = true
      return setHtmlAttribute(match, attrsText, 'placeholder', value)
    })
  } else if (editType === 'button') {
    nextHtml = nextHtml.replace(/<input\b([^>]*?)\s*(\/?)>/gi, (match, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'button') return match
      updated = true
      const withValue = setHtmlAttribute(match, attrsText, 'value', value)
      return setImportedButtonActionAttributes(withValue, attrsText, buttonActionPatch)
    })
    nextHtml = nextHtml.replace(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tagName, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId) || getImportedEditTypeFromAttrs(attrsText) !== 'button') return match
      updated = true
      const openingTag = setImportedButtonActionAttributes(`<${tagName}${attrsText}>`, attrsText, buttonActionPatch)
      return `${openingTag}${escapeHtml(value)}</${tagName}>`
    })
  } else {
    nextHtml = nextHtml.replace(/<(h[1-6]|p|label|a|span|strong|em|small|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (match, tagName, attrsText = '') => {
      if (updated || !hasImportedEditId(attrsText, editId)) return match
      const currentType = getImportedEditTypeFromAttrs(attrsText)
      if (currentType && currentType !== editType) return match
      updated = true
      return `<${tagName}${attrsText}>${escapeHtml(value)}</${tagName}>`
    })
  }

  if (!updated) {
    const error = new Error('No encontramos ese elemento editable en la pagina')
    error.status = 404
    throw error
  }

  return nextHtml
}

function inferImportedFieldDestination(field = {}) {
  const explicit = normalizeImportedFieldKey(field.explicitField, '')
  const explicitCustom = normalizeImportedFieldKey(field.explicitCustomField, '')
  const haystack = getImportedFieldHaystack(field)
  const suppressAmbiguousName = hasImportedNameContextExclusion(field) && hasImportedAlias(haystack, IMPORTED_AMBIGUOUS_PERSON_NAME_ALIASES)

  if (explicitCustom) {
    return { destinationType: 'custom', destinationKey: explicitCustom, confidence: 0.98 }
  }

  if (explicit && IMPORTED_FORM_STANDARD_FIELDS.has(explicit)) {
    return { destinationType: 'standard', destinationKey: explicit, confidence: 0.98 }
  }

  const explicitStandardAlias = explicit ? getImportedStandardAliasKey(explicit) : ''
  if (explicitStandardAlias) {
    return { destinationType: 'standard', destinationKey: explicitStandardAlias, confidence: 0.96 }
  }

  if (explicit) {
    return { destinationType: 'custom', destinationKey: explicit, confidence: 0.94 }
  }

  if (field.type === 'email') {
    return { destinationType: 'standard', destinationKey: 'email', confidence: 0.92 }
  }

  if (field.type === 'tel') {
    return { destinationType: 'standard', destinationKey: 'phone', confidence: 0.9 }
  }

  const standardAlias = getImportedStandardAliasKey(haystack)
  if (standardAlias) {
    if (suppressAmbiguousName && ['first_name', 'full_name'].includes(standardAlias)) {
      const customHint = getImportedCustomHintDestination(haystack)
      if (customHint) return customHint
      return {
        destinationType: 'custom',
        destinationKey: normalizeImportedFieldKey(field.label || field.placeholder || field.sourceName || field.name || field.id, 'custom_field'),
        confidence: 0.56
      }
    }

    const confidence = standardAlias === 'first_name' || standardAlias === 'last_name'
      ? 0.9
      : standardAlias === 'full_name'
        ? 0.84
        : 0.9
    return { destinationType: 'standard', destinationKey: standardAlias, confidence }
  }

  const contactCustom = getImportedCustomHintDestination(haystack, IMPORTED_CONTACT_CUSTOM_FIELD_KEYS)
  if (contactCustom) return contactCustom

  if (field.tag === 'textarea') {
    return { destinationType: 'standard', destinationKey: 'message', confidence: 0.72 }
  }

  const customHint = getImportedCustomHintDestination(haystack)
  if (customHint) return customHint

  return {
    destinationType: 'custom',
    destinationKey: normalizeImportedFieldKey(field.name || field.label || field.placeholder || field.id, 'custom_field'),
    confidence: 0.45
  }
}

function buildDefaultImportedFormMappings(forms = []) {
  return forms.map(form => {
    const fields = form.fields.map(field => {
      const inferred = inferImportedFieldDestination(field)
      return {
        fieldId: field.id,
        sourceName: field.sourceName,
        label: field.label || field.placeholder || field.sourceName,
        type: field.type,
        destinationType: inferred.destinationType,
        destinationKey: inferred.destinationKey,
        saveMode: inferred.destinationType === 'standard' ? 'standard' : 'custom',
        confidence: inferred.confidence,
        ignored: false,
        options: field.options || []
      }
    })
    const hasLastName = fields.some(field => (
      field.destinationType === 'standard' &&
      field.destinationKey === 'last_name' &&
      !field.ignored
    ))
    const ambiguousPersonNameFields = fields.filter(isImportedAmbiguousMappedPersonNameField)

    return {
      formId: form.id,
      formTitle: form.title,
      purpose: form.purpose || 'lead_capture',
      submitText: form.submitText || 'Enviar',
      fields: fields.map(mappedField => {
        const isOnlyAmbiguousPersonName = ambiguousPersonNameFields.length === 1 &&
          ambiguousPersonNameFields[0].fieldId === mappedField.fieldId

        if (
          isOnlyAmbiguousPersonName &&
          mappedField.destinationType === 'standard' &&
          ['first_name', 'full_name'].includes(mappedField.destinationKey)
        ) {
          return {
            ...mappedField,
            destinationKey: hasLastName ? 'first_name' : 'full_name',
            saveMode: 'standard',
            confidence: Math.max(Number(mappedField.confidence || 0), 0.9)
          }
        }

        return mappedField
      })
    }
  })
}

function countImportedDetectedFields(forms = []) {
  return forms.reduce((total, form) => total + (Array.isArray(form?.fields) ? form.fields.length : 0), 0)
}

function countImportedMappedFields(mappings = []) {
  return mappings.reduce((total, mapping) => total + (Array.isArray(mapping?.fields) ? mapping.fields.length : 0), 0)
}

function findExistingImportedFieldMapping(existingMappings = [], nextForm = {}, nextField = {}) {
  const normalizedFormId = normalizeImportedFieldKey(nextForm.formId, '')
  const normalizedFormTitle = normalizeImportedFieldKey(nextForm.formTitle, '')
  const normalizedFieldId = normalizeImportedFieldKey(nextField.fieldId, '')
  const normalizedSourceName = normalizeImportedFieldKey(nextField.sourceName, '')

  const formCandidates = (Array.isArray(existingMappings) ? existingMappings : []).filter(mapping => {
    const mappingFormId = normalizeImportedFieldKey(mapping?.formId, '')
    const mappingFormTitle = normalizeImportedFieldKey(mapping?.formTitle, '')
    return (
      (normalizedFormId && mappingFormId === normalizedFormId) ||
      (normalizedFormTitle && mappingFormTitle === normalizedFormTitle)
    )
  })

  const candidateForms = formCandidates.length ? formCandidates : existingMappings
  for (const mapping of candidateForms || []) {
    const fields = Array.isArray(mapping?.fields) ? mapping.fields : []
    const exact = fields.find(field => (
      (normalizedFieldId && normalizeImportedFieldKey(field?.fieldId, '') === normalizedFieldId) ||
      (normalizedSourceName && normalizeImportedFieldKey(field?.sourceName, '') === normalizedSourceName)
    ))
    if (exact) return exact
  }

  return null
}

function mergeImportedFormMappings(existingMappings = [], nextMappings = []) {
  return (Array.isArray(nextMappings) ? nextMappings : []).map(nextForm => ({
    ...nextForm,
    fields: (Array.isArray(nextForm?.fields) ? nextForm.fields : []).map(nextField => {
      const existingField = findExistingImportedFieldMapping(existingMappings, nextForm, nextField)
      if (!existingField) return nextField

      return {
        ...nextField,
        destinationType: existingField.destinationType || nextField.destinationType,
        destinationKey: existingField.destinationKey || nextField.destinationKey,
        saveMode: existingField.saveMode || nextField.saveMode,
        ignored: Boolean(existingField.ignored || existingField.destinationType === 'ignored'),
        confidence: Number(existingField.confidence || nextField.confidence || 0) || nextField.confidence,
        options: Array.isArray(nextField.options) && nextField.options.length
          ? nextField.options
          : existingField.options || []
      }
    })
  }))
}

function isSocialTemplate(value) {
  return SOCIAL_TEMPLATE_IDS.has(cleanString(value))
}

function getSocialProfileDefaults(site = {}, platform = 'facebook') {
  const theme = site.theme || {}
  const normalizedPlatform = isSocialTemplate(platform) ? platform : 'facebook'

  return {
    platform: normalizedPlatform,
    brandName: cleanString(theme.brandName) || cleanString(site.title) || cleanString(site.name) || 'Tu marca',
    brandSubtitle: cleanString(theme.brandSubtitle) || (normalizedPlatform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'),
    brandAvatar: cleanString(theme.brandAvatar),
    followers: cleanString(theme.followers),
    brandVerified: theme.brandVerified === undefined ? true : theme.brandVerified !== false
  }
}

function getSocialProfileLandingSpacing() {
  return {
    blockMarginLinked: false,
    blockMarginTop: 0,
    blockMarginRight: 0,
    blockMarginBottom: 18,
    blockMarginLeft: 0,
    blockPaddingLinked: true,
    blockPadding: 0,
    blockPaddingTop: 0,
    blockPaddingRight: 0,
    blockPaddingBottom: 0,
    blockPaddingLeft: 0
  }
}

function normalizeBoolean(value) {
  if (value === true || value === 1) return 1
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase()) ? 1 : 0
  }
  return 0
}

function slugify(value) {
  const base = cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return base || `site-${Date.now()}`
}

function getDefaultRoutePrefix(siteType) {
  return siteType === 'landing_page' ? 'embudo' : 'formulario'
}

function getDefaultSiteNamePrefix(siteType) {
  return siteType === 'landing_page' ? 'Embudo' : 'Formulario'
}

function getDefaultSiteName(siteType, slug) {
  const prefix = getDefaultSiteNamePrefix(siteType)
  const suffix = cleanString(slug).match(/(\d+)$/)?.[1]
  return suffix ? `${prefix} ${suffix.padStart(2, '0')}` : `${prefix} 01`
}

async function getNextDefaultSlug(siteType) {
  const prefix = getDefaultRoutePrefix(siteType)
  const rows = await db.all(
    'SELECT slug FROM public_sites WHERE slug LIKE ?',
    [`${prefix}-%`]
  )
  const used = new Set(rows.map(row => row.slug))
  let index = 1
  let slug = `${prefix}-${String(index).padStart(2, '0')}`

  while (used.has(slug)) {
    index += 1
    slug = `${prefix}-${String(index).padStart(2, '0')}`
  }

  return slug
}

function parseHost(value) {
  const rawValue = cleanString(value)
  if (!rawValue) return ''

  const withoutProtocol = rawValue.replace(/^https?:\/\//i, '')
  const withoutPath = withoutProtocol.split('/')[0]
  const withoutUser = withoutPath.split('@').pop() || withoutPath

  if (withoutUser.startsWith('[')) {
    return withoutUser.replace(/^\[|\].*$/g, '').toLowerCase()
  }

  return withoutUser.split(':')[0].replace(/\.$/, '').toLowerCase()
}

export function normalizeDomain(value) {
  const host = parseHost(value)
  if (!host) return ''

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return host
  }

  const isValid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  return isValid ? host : ''
}

export function getRequestHost(req) {
  const forwardedHost = cleanString(req.headers['x-forwarded-host']).split(',')[0]
  return normalizeDomain(forwardedHost || req.headers.host || req.hostname)
}

function parseDomainList(value) {
  return cleanString(value)
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean)
}

function getRenderDefaultHosts() {
  const hosts = new Set()

  for (const value of [
    process.env.RENDER_EXTERNAL_HOSTNAME,
    process.env.RENDER_EXTERNAL_URL,
    process.env.VITE_API_URL,
    process.env.PUBLIC_URL
  ]) {
    const host = normalizeDomain(value)
    if (host) hosts.add(host)
  }

  return hosts
}

export function isDashboardHost(hostValue) {
  const host = normalizeDomain(hostValue)
  if (!host) return false

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true
  }

  if (host.endsWith('.onrender.com')) {
    return true
  }

  const dashboardHosts = new Set([
    ...parseDomainList(process.env.DASHBOARD_DOMAINS),
    ...getRenderDefaultHosts()
  ])

  return dashboardHosts.has(host)
}

function mapSite(row) {
  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    siteType: row.site_type || 'standard_form',
    status: row.status || 'draft',
    domain: row.domain || '',
    title: row.title || '',
    description: row.description || '',
    theme: parseJson(row.theme_json, DEFAULT_THEME),
    metaCapiEnabled: Boolean(Number(row.meta_capi_enabled || 0)),
    metaEventName: normalizeSiteMetaEventName(row.meta_event_name, { allowNone: true }),
    renderDomainVerified: Boolean(Number(row.render_domain_verified || 0)),
    renderDomainCheckedAt: row.render_domain_checked_at || null,
    renderDomainError: row.render_domain_error || null,
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submissionsCount: Number(row.submissions_count || 0),
    trackingStats: {
      views: Number(row.tracking_views || 0),
      visitors: Number(row.tracking_visitors || 0),
      sessions: Number(row.tracking_sessions || 0),
      conversions: Number(row.tracking_conversions || 0),
      conversionRate: Number(row.tracking_visitors || 0) > 0
        ? Number(((Number(row.tracking_conversions || 0) / Number(row.tracking_visitors || 0)) * 100).toFixed(1))
        : 0
    }
  }
}

function mapBlock(row) {
  if (!row) return null

  return {
    id: row.id,
    siteId: row.site_id,
    blockType: row.block_type,
    label: row.label || '',
    content: row.content || '',
    placeholder: row.placeholder || '',
    required: Boolean(Number(row.required || 0)),
    options: parseJson(row.options_json, []),
    settings: parseJson(row.settings_json, {}),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapSubmission(row) {
  if (!row) return null

  return {
    id: row.id,
    siteId: row.site_id,
    contactId: row.contact_id || null,
    domain: row.domain || '',
    responses: parseJson(row.response_json, {}),
    rawFields: parseJson(row.raw_fields_json, {}),
    mappedFields: parseJson(row.mapped_fields_json, {}),
    derivedFields: parseJson(row.derived_fields_json, {}),
    meta: parseJson(row.meta_json, {}),
    status: row.status || 'received',
    createdAt: row.created_at,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || ''
  }
}

function validateSiteType(value) {
  const siteType = cleanString(value) || 'standard_form'
  if (!SITE_TYPES.has(siteType)) {
    throw new Error('Tipo de site invalido')
  }
  return siteType
}

function validateSiteStatus(value) {
  const status = cleanString(value) || 'draft'
  if (!SITE_STATUSES.has(status)) {
    throw new Error('Estado de site invalido')
  }
  return status
}

function validateBlockType(value) {
  const blockType = cleanString(value)
  if (!BLOCK_TYPES.has(blockType)) {
    throw new Error('Tipo de bloque invalido')
  }
  return blockType
}

function normalizeOptionAction(value) {
  const rawAction = cleanString(value || 'continue').toLowerCase()
  const action = rawAction
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  const aliases = {
    normal: 'continue',
    continuar: 'continue',
    continuar_normalmente: 'continue',
    lead_frio: 'cold_lead',
    frio: 'cold_lead',
    marcar_lead_frio: 'cold_lead',
    lead_tibio: 'warm_lead',
    tibio: 'warm_lead',
    marcar_lead_tibio: 'warm_lead',
    lead_caliente: 'hot_lead',
    caliente: 'hot_lead',
    marcar_lead_caliente: 'hot_lead',
    descalificar: 'disqualify',
    descalificar_contacto: 'disqualify',
    descalificar_inmediatamente: 'disqualify',
    descalificar_al_finalizar: 'disqualify_after_submit',
    descalificar_al_finalizar_formulario: 'disqualify_after_submit',
    no_calificado: 'disqualify',
    mostrar_mensaje: 'show_message',
    mostrar_mensaje_especifico: 'show_message',
    terminar: 'end_form',
    terminar_formulario: 'end_form',
    finalizar: 'end_form',
    saltar: 'jump',
    saltar_pregunta: 'jump',
    dirigir: 'redirect',
    dirigir_a_sitio: 'redirect',
    redirigir: 'redirect',
    redirigir_a_sitio: 'redirect',
    sitio: 'redirect',
    etiqueta: 'tag',
    asignar_etiqueta: 'tag',
    categoria: 'category'
  }

  const resolvedAction = aliases[action] || action
  return OPTION_ACTIONS.has(resolvedAction) ? resolvedAction : 'continue'
}

const TEMPLATE_IMAGE_URLS = {
  workspace: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1800&q=80',
  planning: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1800&q=80',
  premium: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1800&q=80',
  local: 'https://images.unsplash.com/photo-1556745757-8d76bdb6984b?auto=format&fit=crop&w=1800&q=80',
  team: 'https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=1800&q=80',
  quote: 'https://images.unsplash.com/photo-1553877522-43269d4ea984?auto=format&fit=crop&w=1800&q=80',
  consult: 'https://images.unsplash.com/photo-1551836022-d5d88e9218df?auto=format&fit=crop&w=1800&q=80',
  handshake: 'https://images.unsplash.com/photo-1521791136064-7986c2920216?auto=format&fit=crop&w=1800&q=80'
}

const SITES_AI_STOCK_IMAGE_LIBRARY = [
  {
    id: 'business_workspace',
    label: 'Equipo, oficina, consultoria y servicios profesionales',
    keywords: ['consultoria', 'consulting', 'office', 'workspace', 'equipo', 'business', 'marketing', 'agencia', 'servicio', 'profesional'],
    backgroundImage: TEMPLATE_IMAGE_URLS.workspace,
    images: [
      TEMPLATE_IMAGE_URLS.team,
      TEMPLATE_IMAGE_URLS.consult,
      'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=1600&q=80'
    ]
  },
  {
    id: 'local_business',
    label: 'Negocio local, tienda, mostrador y atencion al cliente',
    keywords: ['local', 'tienda', 'restaurante', 'boutique', 'negocio local', 'cliente', 'mostrador', 'retail', 'servicio local'],
    backgroundImage: TEMPLATE_IMAGE_URLS.local,
    images: [
      'https://images.unsplash.com/photo-1556745753-b2904692b3cd?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1604719312566-8912e9227c6a?auto=format&fit=crop&w=1600&q=80'
    ]
  },
  {
    id: 'health_beauty',
    label: 'Salud, belleza, clinica, spa y bienestar',
    keywords: ['salud', 'clinica', 'medico', 'dental', 'dentista', 'spa', 'belleza', 'wellness', 'estetica', 'fitness', 'terapia'],
    backgroundImage: 'https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&w=1800&q=80',
    images: [
      'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1550831107-1553da8c8464?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1512290923902-8a9f81dc236c?auto=format&fit=crop&w=1600&q=80'
    ]
  },
  {
    id: 'education_event',
    label: 'Curso, evento, clase, webinar y comunidad',
    keywords: ['curso', 'clase', 'evento', 'webinar', 'educacion', 'capacitacion', 'coaching', 'mentoria', 'comunidad', 'registro'],
    backgroundImage: TEMPLATE_IMAGE_URLS.planning,
    images: [
      'https://images.unsplash.com/photo-1523580846011-d3a5bc25702b?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1515187029135-18ee286d815b?auto=format&fit=crop&w=1600&q=80'
    ]
  },
  {
    id: 'premium_offer',
    label: 'Oferta premium, lujo, asesoria privada y alto valor',
    keywords: ['premium', 'lujo', 'privado', 'alto valor', 'vip', 'exclusivo', 'inversion', 'finanzas', 'inmobiliaria'],
    backgroundImage: TEMPLATE_IMAGE_URLS.premium,
    images: [
      'https://images.unsplash.com/photo-1507679799987-c73779587ccf?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1519671482749-fd09be7ccebf?auto=format&fit=crop&w=1600&q=80'
    ]
  },
  {
    id: 'sales_quote',
    label: 'Cotizacion, venta, reunion y acuerdo comercial',
    keywords: ['cotizacion', 'quote', 'venta', 'sales', 'presupuesto', 'deal', 'propuesta', 'agenda', 'llamada'],
    backgroundImage: TEMPLATE_IMAGE_URLS.quote,
    images: [
      TEMPLATE_IMAGE_URLS.handshake,
      'https://images.unsplash.com/photo-1551836022-4c4c79ecde51?auto=format&fit=crop&w=1600&q=80',
      'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1600&q=80'
    ]
  }
]

const makeDefaultFunnelPage = (id, title, sortOrder) => ({
  id,
  title,
  sortOrder,
  metaCapiEnabled: false,
  metaEventName: SITE_META_NO_EVENT,
  metaTrigger: 'page_view'
})

function getDefaultFunnelPages(template) {
  const tpl = cleanString(template)

  if (tpl === 'launch') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Registro', 0),
      makeDefaultFunnelPage('page-2', 'Detalles', 1),
      makeDefaultFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (tpl === 'local') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Oferta local', 0),
      makeDefaultFunnelPage('page-2', 'Contacto', 1),
      makeDefaultFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (tpl === 'facebook' || tpl === 'instagram' || tpl === 'tiktok') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Anuncio', 0),
      makeDefaultFunnelPage('page-2', 'Gracias', 1)
    ]
  }

  if (tpl === 'executive') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Diagnostico', 0),
      makeDefaultFunnelPage('page-2', 'Agenda', 1),
      makeDefaultFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (tpl === 'vsl') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Carta de ventas', 0),
      makeDefaultFunnelPage('page-2', 'Agenda', 1),
      makeDefaultFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  if (tpl === 'premium') {
    return [
      makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Presentacion', 0),
      makeDefaultFunnelPage('page-2', 'Agenda privada', 1),
      makeDefaultFunnelPage('page-3', 'Gracias', 2)
    ]
  }

  return [
    makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Opt-in', 0),
    makeDefaultFunnelPage('page-2', 'Agenda', 1),
    makeDefaultFunnelPage('page-3', 'Gracias', 2)
  ]
}

function getDefaultFormPages() {
  return [
    makeDefaultFunnelPage(DEFAULT_FUNNEL_PAGE_ID, 'Formulario', 0),
    makeDefaultFunnelPage(FORM_THANK_YOU_PAGE_ID, 'Agradecimiento', 1),
    makeDefaultFunnelPage(FORM_DISQUALIFIED_PAGE_ID, 'Descalificacion', 2)
  ]
}

async function ensureUniqueSlug(baseSlug, ignoreSiteId = null) {
  let slug = baseSlug
  let suffix = 2

  while (true) {
    const params = [slug]
    let sql = 'SELECT id FROM public_sites WHERE slug = ?'

    if (ignoreSiteId) {
      sql += ' AND id != ?'
      params.push(ignoreSiteId)
    }

    const existing = await db.get(sql, params)
    if (!existing) return slug

    slug = `${baseSlug}-${suffix}`
    suffix += 1
  }
}

function buildDefaultBlocks(siteId, siteType, template, siteContext = {}) {
  const tpl = cleanString(template)
  const templateHeaderPanelOverlap = -42
  const makeLandingSpacing = (top, bottom, right = 0, left = 0) => ({
    blockMarginLinked: false,
    blockMarginTop: top,
    blockMarginRight: right,
    blockMarginBottom: bottom,
    blockMarginLeft: left,
    blockPaddingLinked: true,
    blockPadding: 0,
    blockPaddingTop: 0,
    blockPaddingRight: 0,
    blockPaddingBottom: 0,
    blockPaddingLeft: 0
  })
  const landingSpacingByType = {
    headline: makeLandingSpacing(0, 10),
    title: makeLandingSpacing(0, 10),
    subheading: makeLandingSpacing(6, 14),
    subtitle: makeLandingSpacing(6, 14),
    description: makeLandingSpacing(6, 16),
    text: makeLandingSpacing(8, 16),
    image: makeLandingSpacing(16, 18),
    video: makeLandingSpacing(16, 18),
    embed: makeLandingSpacing(16, 18),
    calendar_embed: makeLandingSpacing(16, 18),
    button: makeLandingSpacing(18, 18),
    hero: makeLandingSpacing(0, 0),
    benefits: makeLandingSpacing(0, 0),
    testimonials: makeLandingSpacing(0, 0),
    services: makeLandingSpacing(0, 0),
    faq: makeLandingSpacing(0, 0),
    form_embed: makeLandingSpacing(18, 0),
    social_profile: getSocialProfileLandingSpacing(),
    cta: makeLandingSpacing(0, 0),
    header_panel: makeLandingSpacing(0, 0),
    footer_panel: makeLandingSpacing(0, 0)
  }
  const getLandingSpacing = (blockType) => landingSpacingByType[blockType] || makeLandingSpacing(10, 14)
  const defaultButtonSettings = {
    buttonAlign: 'center',
    buttonRadius: 28,
    buttonHeight: 54,
    buttonPaddingX: 28
  }
  const withLandingSpacing = (blockType, settings = {}) => ({
    ...getLandingSpacing(blockType),
    ...settings
  })
  const makeBlock = (blockType, label, content = '', extra = {}) => ({
    id: crypto.randomUUID(),
    site_id: siteId,
    block_type: blockType,
    label,
    content,
    placeholder: extra.placeholder || '',
    required: normalizeBoolean(extra.required),
    options_json: jsonString(extra.options || []),
    settings_json: jsonString(extra.settings || {}),
    sort_order: extra.sortOrder || 0
  })
  const makeLandingSection = (index, columns = 1, sortOrder = index * 2) => {
    const dark = index % 2 === 1
    return makeBlock('section', `Franja ${index + 1}`, '', {
      sortOrder,
      settings: {
        sectionColumns: columns,
        sectionGap: 24,
        blockBg: dark ? '#111827' : '#ffffff',
        blockText: dark ? '#ffffff' : '#111827',
        blockPaddingTop: 48,
        blockPaddingRight: 42,
        blockPaddingBottom: 48,
        blockPaddingLeft: 42,
        blockMarginTop: 0,
        blockMarginRight: 0,
        blockMarginBottom: 0,
        blockMarginLeft: 0,
        textAlign: 'center',
        blockRadius: 0,
        blockBorderWidth: 0
      }
    })
  }
  const makeLandingPanel = (kind, sortOrder) => {
    const isHeader = kind === 'header'
    return makeBlock(isHeader ? 'header_panel' : 'footer_panel', isHeader ? 'Panel superior' : 'Panel inferior', isHeader ? 'Tu marca' : 'Tu informacion esta protegida.', {
      sortOrder,
      settings: {
        ...getLandingSpacing(isHeader ? 'header_panel' : 'footer_panel'),
        panelLinks: isHeader
          ? [
              { label: 'Inicio', url: '#' },
              { label: 'Contacto', url: '#form' }
            ]
          : [
              { label: 'Privacidad', url: '#' },
              { label: 'Instagram', url: '#' },
              { label: 'Facebook', url: '#' }
            ],
        blockPaddingTop: isHeader ? 18 : 24,
        blockPaddingRight: 42,
        blockPaddingBottom: isHeader ? 18 : 28,
        blockPaddingLeft: 42,
        ...(isHeader ? {
          blockMarginLinked: false,
          blockMarginTop: 0,
          blockMarginRight: 0,
          blockMarginBottom: templateHeaderPanelOverlap,
          blockMarginLeft: 0,
          blockPaddingTop: 16,
          blockPaddingRight: 42,
          blockPaddingBottom: 16,
          blockPaddingLeft: 42
        } : {}),
        blockBg: 'transparent',
        textAlign: isHeader ? 'left' : 'center',
        blockRadius: 0,
        blockBorderWidth: 0
      }
    })
  }
  const wrapLandingBlocksInSections = (contentBlocks) => {
    const output = []
    let sortOrder = 0
    output.push(makeLandingPanel('header', sortOrder++))
    contentBlocks.forEach((block, index) => {
      const section = makeLandingSection(index, 1, sortOrder++)
      const settings = parseJson(block.settings_json, {})
      output.push(section)
      output.push({
        ...block,
        sort_order: sortOrder++,
        settings_json: jsonString({
          ...settings,
          sectionId: section.id,
          sectionColumn: 0
        })
      })
    })
    output.push(makeLandingPanel('footer', sortOrder++))
    return output
  }
  const makeLandingLayout = (sectionConfigs) => {
    const output = []
    let sortOrder = 0
    output.push(makeLandingPanel('header', sortOrder++))

    sectionConfigs.forEach((sectionConfig, index) => {
      const columnGroups = sectionConfig.columnBlocks || [sectionConfig.blocks || []]
      const columnCount = Math.max(1, Math.min(3, sectionConfig.columns || columnGroups.length || 1))
      const section = makeLandingSection(index, columnCount, sortOrder++)
      const sectionSettings = parseJson(section.settings_json, {})
      const nextSection = {
        ...section,
        label: sectionConfig.label || section.label,
        content: sectionConfig.content || section.content,
        settings_json: jsonString({
          ...sectionSettings,
          ...(sectionConfig.settings || {})
        })
      }

      output.push(nextSection)

      columnGroups.slice(0, columnCount).forEach((columnBlocks, columnIndex) => {
        const blocksForColumn = Array.isArray(columnBlocks) ? columnBlocks : []
        blocksForColumn.forEach(block => {
          const settings = parseJson(block.settings_json, {})
          output.push({
            ...block,
            sort_order: sortOrder++,
            settings_json: jsonString({
              ...settings,
              sectionId: nextSection.id,
              sectionColumn: columnIndex
            })
          })
        })
      })
    })

    output.push(makeLandingPanel('footer', sortOrder++))
    return output
  }

  const contactFields = (startOrder) => [
    makeBlock('short_text', 'Nombre completo', '', {
      placeholder: 'Tu nombre',
      required: true,
      settings: { internalName: 'full_name' },
      sortOrder: startOrder
    }),
    makeBlock('phone', 'Telefono / WhatsApp', '', {
      placeholder: '10 digitos',
      required: true,
      settings: { internalName: 'phone', validation: 'phone', phoneCountrySelectorEnabled: true },
      sortOrder: startOrder + 1
    }),
    makeBlock('email', 'Correo electronico', '', {
      placeholder: 'tu@email.com',
      required: true,
      settings: { internalName: 'email', validation: 'email' },
      sortOrder: startOrder + 2
    })
  ]
  const makeEmbeddedField = (blockType, label, placeholder, settings = {}, sortOrder = 0) => ({
    id: crypto.randomUUID(),
    siteId,
    blockType,
    label,
    content: '',
    placeholder,
    required: true,
    options: [],
    settings,
    sortOrder,
    createdAt: '',
    updatedAt: ''
  })
  const embeddedContactFields = () => [
    makeEmbeddedField('short_text', 'Nombre completo', 'Tu nombre', { internalName: 'full_name' }, 0),
    makeEmbeddedField('phone', 'Telefono / WhatsApp', '10 digitos', { internalName: 'phone', validation: 'phone', phoneCountrySelectorEnabled: true }, 1),
    makeEmbeddedField('email', 'Correo electronico', 'tu@email.com', { internalName: 'email', validation: 'email' }, 2)
  ]
  const formEmbedSettings = (description, settings = {}) => withLandingSpacing('form_embed', {
    description,
    embeddedBlocks: embeddedContactFields(),
    blockRadius: 20,
    blockBorderWidth: 1,
    blockPaddingTop: 30,
    blockPaddingRight: 30,
    blockPaddingBottom: 30,
    blockPaddingLeft: 30,
    ...settings
  })
  const landingImageBlock = (label, imageUrl, settings = {}) => makeBlock('image', label, '', {
    settings: withLandingSpacing('image', {
      mediaUrl: imageUrl,
      mediaRadius: 24,
      mediaWidth: 100,
      blockBorderWidth: 0,
      blockBg: 'transparent',
      ...settings
    })
  })
  const formImageBlock = (label, imageUrl, sortOrder, settings = {}) => makeBlock('image', label, '', {
    sortOrder,
    settings: {
      mediaUrl: imageUrl,
      mediaRadius: 18,
      mediaWidth: 100,
      blockBorderWidth: 0,
      ...settings
    }
  })
  const socialProfileBlock = (sortOrder = 0, settings = {}) => makeBlock('social_profile', 'Perfil de red social', 'Perfil de red social', {
    sortOrder,
    settings: {
      ...withLandingSpacing('social_profile'),
      ...getSocialProfileDefaults({
        name: siteContext.name,
        title: siteContext.title,
        theme: { ...(siteContext.theme || {}), template: tpl }
      }, tpl),
      ...settings
    }
  })
  const assignBlocksToPage = (blocks, pageId) => blocks.map(block => {
    const settings = parseJson(block.settings_json, {})
    return {
      ...block,
      settings_json: jsonString({
        ...settings,
        pageId
      })
    }
  })
  const makeFormThankYouBlocks = () => [
    makeBlock('title', 'Titulo', 'Gracias, recibimos tu informacion', { sortOrder: 0 }),
    makeBlock('subtitle', 'Subtitulo', 'Te contactaremos pronto con el siguiente paso.', { sortOrder: 1 })
  ]
  const makeFormDisqualifiedBlocks = () => [
    makeBlock('title', 'Titulo', 'Gracias por responder', { sortOrder: 0 }),
    makeBlock('subtitle', 'Subtitulo', 'Por ahora no parece ser el siguiente paso ideal. Si algo cambia, puedes volver a intentarlo despues.', { sortOrder: 1 })
  ]
  const withStandardFormPages = (blocks) => [
    ...assignBlocksToPage(blocks, DEFAULT_FUNNEL_PAGE_ID),
    ...assignBlocksToPage(makeFormThankYouBlocks(), FORM_THANK_YOU_PAGE_ID),
    ...assignBlocksToPage(makeFormDisqualifiedBlocks(), FORM_DISQUALIFIED_PAGE_ID)
  ]
  const prepareFunnelEntryBlocks = (blocks, pageId = DEFAULT_FUNNEL_PAGE_ID) => {
    const nextBlocks = blocks.map(block => {
      const settings = parseJson(block.settings_json, {})
      if (block.block_type !== 'form_embed') return block

      return {
        ...block,
        settings_json: jsonString({
          ...settings,
          completionAction: 'next_page'
        })
      }
    })

    return assignBlocksToPage(nextBlocks, pageId)
  }
  const makeLandingPageLayout = (pageId, sectionConfigs) => assignBlocksToPage(makeLandingLayout(sectionConfigs), pageId)
  const makeSchedulePageLayout = (pageId, options = {}) => makeLandingPageLayout(pageId, [
    {
      columns: 2,
      settings: {
        blockBg: options.blockBg || 'linear-gradient(120deg, rgba(248,250,252,.98), rgba(219,234,254,.76))',
        blockText: options.blockText || '#0f172a',
        sectionGap: 34,
        blockPaddingTop: 70,
        blockPaddingBottom: 62
      },
      columnBlocks: [
        [
          makeBlock('hero', 'Paso de agenda', options.headline || 'Agenda el siguiente paso', {
            settings: withLandingSpacing('hero', {
              textAlign: 'left',
              kicker: options.kicker || 'Agenda',
              subtitle: options.subtitle || 'El prospecto ya dejo sus datos. Ahora puede elegir un horario para continuar la conversacion.',
              buttonText: options.buttonText || 'Continuar a confirmacion',
              buttonAction: 'next_page',
              buttonAlign: 'left',
              buttonBg: options.buttonBg || '#2563eb',
              buttonTextColor: options.buttonTextColor || '#ffffff',
              ...defaultButtonSettings
            })
          })
        ],
        [
          makeBlock('calendar_embed', 'Calendario', 'Selecciona un horario', {
            settings: withLandingSpacing('calendar_embed', {
              blockBg: options.calendarBg || '#ffffff',
              blockText: options.calendarText || '#111827',
              blockRadius: 18,
              blockBorderWidth: 1,
              blockBorderColor: options.calendarBorder || '#dbeafe',
              blockPaddingTop: 22,
              blockPaddingRight: 22,
              blockPaddingBottom: 22,
              blockPaddingLeft: 22,
              embedHeight: 680
            })
          })
        ]
      ]
    },
    {
      settings: {
        blockBg: options.ctaBg || '#111827',
        blockText: '#ffffff',
        textAlign: 'center',
        blockPaddingTop: 44,
        blockPaddingBottom: 48
      },
      blocks: [
        makeBlock('cta', 'Continuar', 'Ya quedo el siguiente paso?', {
          settings: withLandingSpacing('cta', {
            textAlign: 'center',
            subtitle: options.ctaSubtitle || 'Cuando termines de agendar, avanza a la pagina de confirmacion.',
            buttonText: options.ctaButtonText || 'Ver confirmacion',
            buttonAction: 'next_page',
            ...defaultButtonSettings
          })
        })
      ]
    }
  ])
  const makeDetailsPageLayout = (pageId, options = {}) => makeLandingPageLayout(pageId, [
    {
      settings: {
        blockBg: options.blockBg || '#fff7ed',
        blockText: options.blockText || '#7c2d12',
        textAlign: 'center',
        blockPaddingTop: 62,
        blockPaddingBottom: 48
      },
      blocks: [
        makeBlock('hero', 'Detalles', options.headline || 'Estos son los detalles importantes', {
          settings: withLandingSpacing('hero', {
            textAlign: 'center',
            kicker: options.kicker || 'Antes de confirmar',
            subtitle: options.subtitle || 'Usa esta pagina para explicar fechas, cupos, bonos, condiciones o lo que el cliente debe saber antes de avanzar.',
            buttonText: options.buttonText || 'Confirmar mi interes',
            buttonAction: 'next_page',
            buttonBg: options.buttonBg || '#ea580c',
            ...defaultButtonSettings
          })
        })
      ]
    },
    {
      columns: 3,
      settings: {
        blockBg: '#ffffff',
        blockText: options.blockText || '#7c2d12',
        sectionGap: 18,
        blockPaddingTop: 44,
        blockPaddingBottom: 48
      },
      columnBlocks: [
        [makeBlock('text', 'Que incluye', 'Aclara el beneficio principal de la oferta.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })],
        [makeBlock('text', 'Para quien es', 'Explica quien aprovecha mejor esta oportunidad.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })],
        [makeBlock('text', 'Que sigue', 'Deja claro como lo contactaran despues.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })]
      ]
    },
    {
      settings: {
        blockBg: options.ctaBg || '#ea580c',
        blockText: '#ffffff',
        textAlign: 'center',
        blockPaddingTop: 42,
        blockPaddingBottom: 48
      },
      blocks: [
        makeBlock('cta', 'Confirmar', 'Confirmar interes', {
          settings: withLandingSpacing('cta', {
            textAlign: 'center',
            subtitle: 'La persona ya entiende la oferta y puede avanzar a la confirmacion.',
            buttonText: 'Continuar',
            buttonAction: 'next_page',
            ...defaultButtonSettings
          })
        })
      ]
    }
  ])
  const makeContactPageLayout = (pageId, options = {}) => makeLandingPageLayout(pageId, [
    {
      columns: 2,
      settings: {
        blockBg: options.blockBg || '#dcfce7',
        blockText: options.blockText || '#14532d',
        sectionGap: 30,
        blockPaddingTop: 58,
        blockPaddingBottom: 58
      },
      columnBlocks: [
        [
          makeBlock('hero', 'Contacto', options.headline || 'Confirma como quieres que te contacten', {
            settings: withLandingSpacing('hero', {
              textAlign: 'left',
              kicker: options.kicker || 'Contacto',
              subtitle: options.subtitle || 'Esta pagina sirve para pedir datos finales, sucursal, servicio o cualquier detalle necesario antes de responder.',
              buttonText: 'Enviar datos',
              buttonUrl: '#form',
              buttonAlign: 'left',
              buttonBg: options.buttonBg || '#15803d',
              ...defaultButtonSettings
            })
          })
        ],
        [
          makeBlock('form_embed', 'Datos de contacto', 'Datos de contacto', {
            settings: formEmbedSettings(options.formDescription || 'Deja tus datos y te contactamos con el siguiente paso.', {
              completionAction: 'next_page',
              blockBg: '#ffffff',
              blockText: options.formText || '#14532d',
              fieldBorder: options.fieldBorder || '#86efac',
              fieldRadius: 14
            })
          })
        ]
      ]
    }
  ])
  const makeThankYouPageLayout = (pageId, options = {}) => makeLandingPageLayout(pageId, [
    {
      columns: 2,
      settings: {
        blockBg: options.blockBg || 'linear-gradient(120deg, rgba(15,23,42,.98), rgba(20,184,166,.72))',
        blockText: options.blockText || '#ffffff',
        sectionGap: 34,
        blockPaddingTop: 78,
        blockPaddingBottom: 72
      },
      columnBlocks: [
        [
          makeBlock('hero', 'Gracias', options.headline || 'Gracias, recibimos tu informacion', {
            settings: withLandingSpacing('hero', {
              textAlign: 'left',
              kicker: options.kicker || 'Confirmacion',
              subtitle: options.subtitle || 'El siguiente paso queda claro para que la persona sepa que pasara despues.',
              buttonText: options.buttonText || 'Volver al inicio',
              buttonUrl: options.buttonUrl || '#',
              buttonAlign: 'left',
              buttonBg: options.buttonBg || '#ffffff',
              buttonTextColor: options.buttonTextColor || '#111827',
              ...defaultButtonSettings
            })
          })
        ],
        [
          landingImageBlock('Imagen de cierre', options.imageUrl || TEMPLATE_IMAGE_URLS.handshake, {
            mediaRadius: 22,
            blockBorderColor: options.imageBorder || 'rgba(255,255,255,.16)'
          })
        ]
      ]
    },
    {
      columns: 3,
      settings: {
        blockBg: options.stepsBg || '#ffffff',
        blockText: options.stepsText || '#0f172a',
        sectionGap: 18,
        blockPaddingTop: 46,
        blockPaddingBottom: 48
      },
      columnBlocks: [
        [makeBlock('text', 'Paso recibido', 'Tu equipo ya tiene la informacion para dar seguimiento.', { settings: withLandingSpacing('text', { blockBg: options.cardBg || '#f8fafc', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: options.cardBorder || '#e2e8f0' }) })],
        [makeBlock('text', 'Respuesta clara', 'Edita este texto para explicar en cuanto tiempo contactaran.', { settings: withLandingSpacing('text', { blockBg: options.cardBg || '#f8fafc', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: options.cardBorder || '#e2e8f0' }) })],
        [makeBlock('text', 'Siguiente paso', 'Puedes indicar si deben revisar WhatsApp, correo o una llamada.', { settings: withLandingSpacing('text', { blockBg: options.cardBg || '#f8fafc', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: options.cardBorder || '#e2e8f0' }) })]
      ]
    }
  ])
  const makeLandingFunnel = (templateId, primaryBlocks) => {
    const entryBlocks = prepareFunnelEntryBlocks(primaryBlocks)

    if (templateId === 'launch') {
      return [
        ...entryBlocks,
        ...makeDetailsPageLayout('page-2'),
        ...makeThankYouPageLayout('page-3', {
          blockBg: 'linear-gradient(120deg, rgba(124,45,18,.98), rgba(234,88,12,.72))',
          headline: 'Gracias, tu registro quedo recibido',
          subtitle: 'Ahora la persona sabe que el equipo puede contactarla con los detalles del lanzamiento.',
          imageUrl: TEMPLATE_IMAGE_URLS.planning
        })
      ]
    }

    if (templateId === 'local') {
      return [
        ...entryBlocks,
        ...makeContactPageLayout('page-2'),
        ...makeThankYouPageLayout('page-3', {
          blockBg: 'linear-gradient(120deg, rgba(20,83,45,.98), rgba(22,163,74,.72))',
          headline: 'Gracias, recibimos tu solicitud',
          subtitle: 'El visitante queda con una confirmacion clara y listo para que el negocio lo contacte.',
          imageUrl: TEMPLATE_IMAGE_URLS.local,
          stepsText: '#14532d',
          cardBg: '#f0fdf4',
          cardBorder: '#bbf7d0'
        })
      ]
    }

    if (templateId === 'facebook' || templateId === 'instagram' || templateId === 'tiktok') {
      return [
        ...entryBlocks,
        ...makeThankYouPageLayout('page-2', {
          blockBg: templateId === 'tiktok'
            ? 'linear-gradient(120deg, rgba(0,0,0,.98), rgba(31,31,31,.86))'
            : 'linear-gradient(120deg, rgba(17,24,39,.98), rgba(59,130,246,.74))',
          headline: 'Listo, recibimos tus datos',
          subtitle: 'Esta pagina corta confirma la accion despues de venir desde redes sociales.',
          imageUrl: TEMPLATE_IMAGE_URLS.consult
        })
      ]
    }

    if (templateId === 'premium') {
      return [
        ...entryBlocks,
        ...makeSchedulePageLayout('page-2', {
          blockBg: 'linear-gradient(120deg, rgba(16,16,16,.98), rgba(39,39,42,.82))',
          blockText: '#f8fafc',
          headline: 'Agenda una llamada privada',
          subtitle: 'Despues de aplicar, la persona puede elegir el horario ideal para revisar la propuesta.',
          buttonBg: '#d4af37',
          buttonTextColor: '#121212',
          calendarBg: '#18181b',
          calendarText: '#f8fafc',
          calendarBorder: '#3f3f46',
          ctaBg: '#101010'
        }),
        ...makeThankYouPageLayout('page-3', {
          blockBg: 'linear-gradient(120deg, rgba(16,16,16,.98), rgba(212,175,55,.45))',
          headline: 'Gracias, tu solicitud esta en proceso',
          subtitle: 'El cierre mantiene la sensacion premium y explica que el equipo dara seguimiento.',
          imageUrl: TEMPLATE_IMAGE_URLS.premium,
          stepsBg: '#18181b',
          stepsText: '#f8fafc',
          cardBg: '#222225',
          cardBorder: '#3f3f46'
        })
      ]
    }

    if (templateId === 'vsl') {
      return [
        ...entryBlocks,
        ...makeSchedulePageLayout('page-2', {
          blockBg: 'linear-gradient(120deg, rgba(17,24,39,.98), rgba(30,64,175,.72))',
          blockText: '#ffffff',
          headline: 'Elige una llamada para revisar la oferta',
          subtitle: 'Despues de leer la carta de ventas, el prospecto puede pasar directo a una conversacion.',
          buttonBg: '#ffffff',
          buttonTextColor: '#111827',
          ctaBg: '#111827'
        }),
        ...makeThankYouPageLayout('page-3', {
          blockBg: 'linear-gradient(120deg, rgba(17,24,39,.98), rgba(30,64,175,.72))',
          headline: 'Gracias, tu solicitud quedo enviada',
          subtitle: 'La persona termina con una confirmacion limpia y una idea clara del siguiente paso.'
        })
      ]
    }

    if (templateId === 'executive') {
      return [
        ...entryBlocks,
        ...makeSchedulePageLayout('page-2', {
          blockBg: 'linear-gradient(120deg, rgba(240,253,250,.98), rgba(204,251,241,.78))',
          blockText: '#0f172a',
          headline: 'Agenda el diagnostico',
          subtitle: 'Despues de explicar el servicio, este paso mueve al prospecto a una llamada concreta.',
          buttonBg: '#0f766e',
          ctaBg: '#0f766e'
        }),
        ...makeThankYouPageLayout('page-3', {
          blockBg: 'linear-gradient(120deg, rgba(15,118,110,.98), rgba(45,212,191,.64))',
          headline: 'Gracias, tu diagnostico quedo solicitado',
          subtitle: 'La pagina final confirma que el equipo recibio la informacion y dara seguimiento.'
        })
      ]
    }

    return [
      ...entryBlocks,
      ...makeSchedulePageLayout('page-2'),
      ...makeThankYouPageLayout('page-3')
    ]
  }

  if (siteType === 'landing_page') {
    if (tpl === 'ristak') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          columns: 2,
          settings: {
            blockBg: 'linear-gradient(90deg, rgba(248,250,252,.96), rgba(248,250,252,.72))',
            blockText: '#0f172a',
            sectionGap: 40,
            blockPaddingTop: 76,
            blockPaddingBottom: 72
          },
          columnBlocks: [
            [
              makeBlock('hero', 'Hero', 'Convierte visitas en conversaciones de negocio', {
                settings: withLandingSpacing('hero', {
                  textAlign: 'left',
                  kicker: 'Pagina completa',
                  subtitle: 'Presenta tu oferta, muestra por que vale la pena y deja listo el siguiente paso para quien ya esta interesado.',
                  buttonText: 'Quiero informacion',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  buttonBg: '#111827',
                  ...defaultButtonSettings
                })
              })
            ],
            [
              landingImageBlock('Foto principal', TEMPLATE_IMAGE_URLS.workspace, {
                mediaRadius: 28,
                blockBorderColor: 'rgba(15,23,42,.08)'
              })
            ]
          ]
        },
        {
          columns: 3,
          settings: { blockBg: '#ffffff', blockText: '#0f172a', sectionGap: 18, blockPaddingTop: 50, blockPaddingBottom: 52 },
          columnBlocks: [
            [makeBlock('services', 'Claridad', 'Mensaje simple', {
              settings: withLandingSpacing('services', {
                listColumns: 1,
                cardBg: '#f8fafc',
                cardBorderColor: '#e2e8f0',
                cardRadius: 16,
                items: [{ title: 'Que haces', text: 'Explica tu servicio sin palabras complicadas.' }]
              })
            })],
            [makeBlock('services', 'Confianza', 'Pruebas y beneficios', {
              settings: withLandingSpacing('services', {
                listColumns: 1,
                cardBg: '#f8fafc',
                cardBorderColor: '#e2e8f0',
                cardRadius: 16,
                items: [{ title: 'Por que elegirte', text: 'Muestra beneficios concretos y faciles de leer.' }]
              })
            })],
            [makeBlock('services', 'Accion', 'Siguiente paso', {
              settings: withLandingSpacing('services', {
                listColumns: 1,
                cardBg: '#f8fafc',
                cardBorderColor: '#e2e8f0',
                cardRadius: 16,
                items: [{ title: 'Como avanzar', text: 'Lleva al prospecto a pedir informacion o agendar.' }]
              })
            })]
          ]
        },
        {
          columns: 2,
          settings: { blockBg: '#111827', blockText: '#ffffff', sectionGap: 32, blockPaddingTop: 58, blockPaddingBottom: 60 },
          columnBlocks: [
            [
              makeBlock('benefits', 'Beneficios', 'Lo que esta pagina deja claro', {
                settings: withLandingSpacing('benefits', {
                  items: [
                    { title: '+ Oferta entendible', text: 'El visitante sabe si esto es para el.' },
                    { title: '+ Datos listos', text: 'La informacion llega completa para dar seguimiento.' },
                    { title: '+ Diseno editable', text: 'Puedes cambiar textos, colores, fotos y secciones.' }
                  ]
                })
              })
            ],
            [
              makeBlock('form_embed', 'Contacto', 'Pide informacion', {
                settings: formEmbedSettings('Deja tus datos y tu equipo podra dar seguimiento.', {
                  blockBg: '#ffffff',
                  blockText: '#0f172a',
                  fieldBorder: '#cbd5e1',
                  fieldRadius: 12
                })
              })
            ]
          ]
        },
        {
          settings: { blockBg: '#f8fafc', blockText: '#0f172a', textAlign: 'center', blockPaddingTop: 48, blockPaddingBottom: 54 },
          blocks: [
            makeBlock('cta', 'CTA final', 'Listo para presentar tu negocio?', {
              settings: withLandingSpacing('cta', {
                textAlign: 'center',
                subtitle: 'Edita esta plantilla con tu oferta real y publicala cuando este lista.',
                buttonText: 'Editar mi pagina',
                buttonUrl: '#form',
                ...defaultButtonSettings
              })
            })
          ]
        }
      ]))
    }

    if (tpl === 'vsl') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          columns: 2,
          settings: {
            blockBg: 'linear-gradient(120deg, rgba(10,11,13,.96), rgba(17,24,39,.78))',
            blockText: '#ffffff',
            sectionGap: 34,
            blockPaddingTop: 72,
            blockPaddingBottom: 72
          },
          columnBlocks: [
            [
              makeBlock('hero', 'Hero', 'Una oferta clara para que el cliente diga: quiero saber mas', {
                settings: withLandingSpacing('hero', {
                  textAlign: 'left',
                  kicker: 'Carta de ventas',
                  subtitle: 'Cuenta el problema, presenta tu solucion y mueve al visitante hacia una decision concreta sin sonar tecnico.',
                  buttonText: 'Ver detalles',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  buttonBg: '#ffffff',
                  buttonTextColor: '#111827',
                  ...defaultButtonSettings
                })
              })
            ],
            [
              landingImageBlock('Imagen de confianza', TEMPLATE_IMAGE_URLS.handshake, {
                mediaRadius: 24,
                blockBorderColor: 'rgba(255,255,255,.14)'
              })
            ]
          ]
        },
        {
          settings: { blockBg: '#ffffff', blockText: '#111827', textAlign: 'center', blockPaddingTop: 52, blockPaddingBottom: 48 },
          blocks: [
            makeBlock('benefits', 'Lo que obtiene el cliente', 'Por que esta oferta le conviene', {
              settings: withLandingSpacing('benefits', {
                contentMaxWidth: 28,
                items: [
                  { title: '+ Resultado facil de entender', text: 'Explica el cambio que ayudas a lograr.' },
                  { title: '+ Proceso sin confusion', text: 'Muestra que pasa despues de dejar sus datos.' },
                  { title: '- Sin promesas raras', text: 'Mantiene la pagina generica y editable para cualquier negocio.' }
                ]
              })
            })
          ]
        },
        {
          columns: 2,
          settings: { blockBg: '#f8fafc', blockText: '#111827', sectionGap: 30, blockPaddingTop: 52, blockPaddingBottom: 54 },
          columnBlocks: [
            [
              makeBlock('testimonials', 'Prueba social', 'Confianza para avanzar', {
                settings: withLandingSpacing('testimonials', {
                  listColumns: 1,
                  cardBg: '#ffffff',
                  cardBorderColor: '#e5e7eb',
                  cardRadius: 16,
                  items: [
                    { title: 'Mensaje mas claro', text: 'La oferta se entiende antes de pedir una llamada.', author: 'Cliente actual' },
                    { title: 'Seguimiento mas ordenado', text: 'Los datos llegan listos para contactar.', author: 'Equipo comercial' }
                  ]
                })
              })
            ],
            [
              makeBlock('form_embed', 'Solicitar informacion', 'Hablemos de lo que necesitas', {
                settings: formEmbedSettings('Deja tus datos y tu equipo podra dar seguimiento.', {
                  blockBg: '#f8fafc',
                  blockText: '#111827',
                  fieldRadius: 10
                })
              })
            ]
          ]
        },
        {
          settings: { blockBg: '#111827', blockText: '#ffffff', textAlign: 'center', blockPaddingTop: 46, blockPaddingBottom: 52 },
          blocks: [
            makeBlock('cta', 'CTA final', 'Listo para convertir mas visitas?', {
              settings: withLandingSpacing('cta', {
                textAlign: 'center',
                subtitle: 'Cambia el texto, la foto y los beneficios para aterrizar tu oferta real.',
                buttonText: 'Quiero mas informacion',
                buttonUrl: '#form',
                ...defaultButtonSettings
              })
            })
          ]
        }
      ]))
    }

    if (tpl === 'executive') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          columns: 2,
          settings: {
            blockBg: 'linear-gradient(110deg, rgba(248,250,252,.96), rgba(236,254,255,.72))',
            blockText: '#0f172a',
            sectionGap: 38,
            blockPaddingTop: 74,
            blockPaddingBottom: 70
          },
          columnBlocks: [
            [
              makeBlock('hero', 'Hero', 'Servicios claros para hacer crecer tu negocio', {
                settings: withLandingSpacing('hero', {
                  textAlign: 'left',
                  kicker: 'Solucion de negocio',
                  subtitle: 'Presenta tu servicio, explica el valor y convierte visitas en conversaciones reales.',
                  buttonText: 'Agendar una llamada',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  buttonBg: '#0f766e',
                  ...defaultButtonSettings
                })
              })
            ],
            [
              landingImageBlock('Equipo de trabajo', TEMPLATE_IMAGE_URLS.team, {
                mediaRadius: 18,
                blockBorderColor: '#cbd5e1'
              })
            ]
          ]
        },
        {
          columns: 3,
          settings: { blockBg: '#ffffff', blockText: '#0f172a', sectionGap: 18, blockPaddingTop: 52, blockPaddingBottom: 54 },
          columnBlocks: [
            [makeBlock('text', 'Diagnostico', 'Diagnostico claro antes de vender una solucion.', { settings: withLandingSpacing('text', { blockBg: '#ecfeff', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#a5f3fc' }) })],
            [makeBlock('text', 'Plan', 'Ruta de trabajo simple para que el prospecto entienda que sigue.', { settings: withLandingSpacing('text', { blockBg: '#f8fafc', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#e2e8f0' }) })],
            [makeBlock('text', 'Seguimiento', 'Contacto ordenado con datos completos para no perder oportunidades.', { settings: withLandingSpacing('text', { blockBg: '#ecfdf5', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#a7f3d0' }) })]
          ]
        },
        {
          columns: 2,
          settings: { blockBg: '#0f766e', blockText: '#ffffff', sectionGap: 30, blockPaddingTop: 56, blockPaddingBottom: 58 },
          columnBlocks: [
            [
              makeBlock('services', 'Servicios', 'Como podemos ayudarte', {
                settings: withLandingSpacing('services', {
                  listColumns: 1,
                  cardBg: 'rgba(255,255,255,.12)',
                  cardBorderColor: 'rgba(255,255,255,.22)',
                  cardRadius: 16,
                  items: [
                    { title: 'Consultoria', text: 'Aterriza tu oferta y explica el valor.' },
                    { title: 'Implementacion', text: 'Muestra como llevas al cliente al resultado.' },
                    { title: 'Acompanamiento', text: 'Deja claro que hay seguimiento real.' }
                  ]
                })
              })
            ],
            [
              makeBlock('form_embed', 'Agenda una llamada', 'Cuentanos que necesitas', {
                settings: formEmbedSettings('Completa tus datos y te contactamos para revisar opciones.', {
                  blockBg: '#ffffff',
                  blockText: '#0f172a',
                  fieldBorder: '#99f6e4',
                  fieldRadius: 10
                })
              })
            ]
          ]
        }
      ]))
    }

    if (tpl === 'launch') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          settings: {
            blockBg: 'linear-gradient(135deg, rgba(255,247,237,.96), rgba(251,146,60,.34))',
            blockText: '#1f2937',
            textAlign: 'center',
            blockPaddingTop: 78,
            blockPaddingBottom: 58
          },
          blocks: [
            makeBlock('hero', 'Hero', 'Lanza tu nueva oferta con una pagina lista para captar interesados', {
              settings: withLandingSpacing('hero', {
                textAlign: 'center',
                kicker: 'Nuevo lanzamiento',
                subtitle: 'Ideal para promociones, aperturas, preventas o cualquier oferta que necesita respuestas rapido.',
                buttonText: 'Quiero registrarme',
                buttonUrl: '#form',
                buttonBg: '#ea580c',
                ...defaultButtonSettings
              })
            })
          ]
        },
        {
          columns: 3,
          settings: { blockBg: '#ffffff', blockText: '#1f2937', sectionGap: 16, blockPaddingTop: 44, blockPaddingBottom: 46 },
          columnBlocks: [
            [makeBlock('text', 'Paso 1', 'Cuenta que estas ofreciendo y para quien es.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })],
            [makeBlock('text', 'Paso 2', 'Muestra el beneficio principal y por que conviene actuar ahora.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })],
            [makeBlock('text', 'Paso 3', 'Pide los datos para dar seguimiento desde tu equipo.', { settings: withLandingSpacing('text', { blockBg: '#fff7ed', blockRadius: 16, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#fed7aa' }) })]
          ]
        },
        {
          columns: 2,
          settings: { blockBg: '#ffedd5', blockText: '#7c2d12', sectionGap: 30, blockPaddingTop: 54, blockPaddingBottom: 58 },
          columnBlocks: [
            [
              landingImageBlock('Foto de lanzamiento', TEMPLATE_IMAGE_URLS.planning, {
                mediaRadius: 22,
                blockBorderColor: '#fdba74'
              })
            ],
            [
              makeBlock('cta', 'CTA', 'Aparta tu lugar o pide informacion', {
                settings: withLandingSpacing('cta', {
                  textAlign: 'left',
                  subtitle: 'Edita este bloque segun tu promocion, cupo o fecha limite.',
                  buttonText: 'Enviar mis datos',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  ...defaultButtonSettings
                })
              })
            ]
          ]
        },
        {
          settings: { blockBg: '#fff7ed', blockText: '#7c2d12', textAlign: 'center', blockPaddingTop: 46, blockPaddingBottom: 56 },
          blocks: [
            makeBlock('form_embed', 'Registro', 'Registro rapido', {
              settings: formEmbedSettings('Deja tus datos para recibir la informacion completa.', {
                blockBg: '#ffffff',
                blockText: '#1f2937',
                fieldBorder: '#fdba74'
              })
            })
          ]
        }
      ]))
    }

    if (tpl === 'premium') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          columns: 2,
          settings: {
            blockBg: 'linear-gradient(120deg, rgba(16,16,16,.96), rgba(16,16,16,.72))',
            blockText: '#f8fafc',
            sectionGap: 38,
            blockPaddingTop: 78,
            blockPaddingBottom: 72
          },
          columnBlocks: [
            [
              makeBlock('hero', 'Hero', 'Una experiencia premium para presentar una oferta de alto valor', {
                settings: withLandingSpacing('hero', {
                  textAlign: 'left',
                  kicker: 'Servicio premium',
                  subtitle: 'Usa este diseno para propuestas donde la confianza, el detalle y la claridad pesan mas que el volumen.',
                  buttonText: 'Solicitar una llamada',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  buttonBg: '#d4af37',
                  buttonTextColor: '#121212',
                  ...defaultButtonSettings
                })
              })
            ],
            [
              landingImageBlock('Imagen premium', TEMPLATE_IMAGE_URLS.premium, {
                mediaRadius: 16,
                blockBorderColor: 'rgba(255,255,255,.16)'
              })
            ]
          ]
        },
        {
          columns: 3,
          settings: { blockBg: '#18181b', blockText: '#f8fafc', sectionGap: 28, blockPaddingTop: 56, blockPaddingBottom: 58 },
          columnBlocks: [
            [makeBlock('text', 'Asesoria', 'Explica como acompanas al cliente antes de comprar.', { settings: withLandingSpacing('text', { blockBg: '#222225', blockRadius: 10, blockPaddingTop: 24, blockPaddingRight: 24, blockPaddingBottom: 24, blockPaddingLeft: 24, blockBorderWidth: 1, blockBorderColor: '#3f3f46' }) })],
            [makeBlock('text', 'Implementacion', 'Muestra que hay proceso y entregables claros.', { settings: withLandingSpacing('text', { blockBg: '#222225', blockRadius: 10, blockPaddingTop: 24, blockPaddingRight: 24, blockPaddingBottom: 24, blockPaddingLeft: 24, blockBorderWidth: 1, blockBorderColor: '#3f3f46' }) })],
            [makeBlock('text', 'Seguimiento', 'Deja claro que no termina en el primer contacto.', { settings: withLandingSpacing('text', { blockBg: '#222225', blockRadius: 10, blockPaddingTop: 24, blockPaddingRight: 24, blockPaddingBottom: 24, blockPaddingLeft: 24, blockBorderWidth: 1, blockBorderColor: '#3f3f46' }) })]
          ]
        },
        {
          columns: 2,
          settings: { blockBg: '#101010', blockText: '#f8fafc', sectionGap: 30, blockPaddingTop: 58, blockPaddingBottom: 62 },
          columnBlocks: [
            [
              makeBlock('testimonials', 'Confianza', 'Por que confiar', {
                settings: withLandingSpacing('testimonials', {
                  listColumns: 1,
                  cardBg: '#18181b',
                  cardBorderColor: '#3f3f46',
                  cardRadius: 10,
                  items: [
                    { title: 'Proceso cuidado', text: 'El cliente entiende cada paso antes de dejar sus datos.' },
                    { title: 'Presentacion sobria', text: 'El diseno ayuda a comunicar calidad sin saturar.' }
                  ]
                })
              })
            ],
            [
              makeBlock('form_embed', 'Aplicar', 'Solicita informacion', {
                settings: formEmbedSettings('Completa tus datos para recibir una respuesta personalizada.', {
                  blockBg: '#101010',
                  blockText: '#f8fafc',
                  blockBorderColor: '#3f3f46',
                  fieldBg: '#202023',
                  fieldBorder: '#3f3f46',
                  fieldRadius: 8
                })
              })
            ]
          ]
        }
      ]))
    }

    if (tpl === 'local') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          columns: 2,
          settings: {
            blockBg: 'linear-gradient(110deg, rgba(240,253,244,.96), rgba(220,252,231,.74))',
            blockText: '#14532d',
            sectionGap: 34,
            blockPaddingTop: 68,
            blockPaddingBottom: 64
          },
          columnBlocks: [
            [
              landingImageBlock('Foto del negocio', TEMPLATE_IMAGE_URLS.local, {
                mediaRadius: 26,
                blockBorderColor: '#bbf7d0'
              })
            ],
            [
              makeBlock('hero', 'Hero', 'Haz que mas personas encuentren y contacten tu negocio', {
                settings: withLandingSpacing('hero', {
                  textAlign: 'left',
                  kicker: 'Negocio local',
                  subtitle: 'Una pagina sencilla para explicar que haces, mostrar beneficios y recibir mensajes de clientes interesados.',
                  buttonText: 'Quiero que me contacten',
                  buttonUrl: '#form',
                  buttonAlign: 'left',
                  buttonBg: '#15803d',
                  ...defaultButtonSettings
                })
              })
            ]
          ]
        },
        {
          columns: 3,
          settings: { blockBg: '#ffffff', blockText: '#14532d', sectionGap: 28, blockPaddingTop: 52, blockPaddingBottom: 52 },
          columnBlocks: [
            [makeBlock('text', 'Atencion rapida', 'Responde cuando el cliente todavia trae interes caliente.', { settings: withLandingSpacing('text', { blockBg: '#f0fdf4', blockRadius: 18, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#bbf7d0' }) })],
            [makeBlock('text', 'Informacion clara', 'Muestra horarios, servicios o promociones sin hacerlo pesado.', { settings: withLandingSpacing('text', { blockBg: '#f0fdf4', blockRadius: 18, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#bbf7d0' }) })],
            [makeBlock('text', 'Seguimiento facil', 'Cada respuesta queda lista para contactar desde tu equipo.', { settings: withLandingSpacing('text', { blockBg: '#f0fdf4', blockRadius: 18, blockPaddingTop: 22, blockPaddingRight: 22, blockPaddingBottom: 22, blockPaddingLeft: 22, blockBorderWidth: 1, blockBorderColor: '#bbf7d0' }) })]
          ]
        },
        {
          settings: { blockBg: '#15803d', blockText: '#ffffff', textAlign: 'center', blockPaddingTop: 44, blockPaddingBottom: 46 },
          blocks: [
            makeBlock('faq', 'Preguntas frecuentes', 'Preguntas frecuentes', {
              settings: withLandingSpacing('faq', {
                cardBg: 'rgba(255,255,255,0.12)',
                cardBorderColor: '#86efac',
                cardRadius: 16,
                items: [
                  { title: 'Cuando me contactan?', text: 'Puedes ajustar este texto segun tus tiempos de respuesta.' },
                  { title: 'Que informacion debo dejar?', text: 'Nombre, telefono y correo para dar seguimiento sin perder datos.' }
                ]
              })
            })
          ]
        },
        {
          settings: { blockBg: '#dcfce7', blockText: '#14532d', textAlign: 'center', blockPaddingTop: 48, blockPaddingBottom: 56 },
          blocks: [
            makeBlock('form_embed', 'Contacto', 'Pide informacion', {
              settings: formEmbedSettings('Deja tus datos y te contactamos con mas detalles.', {
                blockBg: '#ffffff',
                blockText: '#14532d',
                fieldBorder: '#86efac',
                fieldRadius: 14
              })
            })
          ]
        }
      ]))
    }

    if (tpl === 'facebook' || tpl === 'instagram' || tpl === 'tiktok') {
      return makeLandingFunnel(tpl, makeLandingLayout([
        {
          settings: { blockBg: tpl === 'tiktok' ? '#000000' : '#ffffff', blockText: tpl === 'tiktok' ? '#ffffff' : '#111827', textAlign: 'center', blockPaddingTop: 46, blockPaddingBottom: 46 },
          blocks: [
            socialProfileBlock(),
            makeBlock('hero', 'Hero', 'Conoce esta oferta y deja tus datos', {
              settings: withLandingSpacing('hero', {
                textAlign: 'center',
                kicker: 'Anuncio',
                subtitle: 'Pagina corta para continuar una conversacion que viene desde redes sociales.',
                buttonText: 'Quiero informacion',
                buttonUrl: '#form',
                ...defaultButtonSettings
              })
            }),
            makeBlock('form_embed', 'Formulario', 'Deja tus datos', {
              settings: formEmbedSettings('Completa la informacion y te contactamos.', {
                blockBg: tpl === 'tiktok' ? '#161616' : '#f8fafc',
                blockText: tpl === 'tiktok' ? '#ffffff' : '#111827',
                fieldBg: tpl === 'tiktok' ? '#1f1f1f' : '#ffffff',
                fieldBorder: tpl === 'tiktok' ? 'rgba(255,255,255,.16)' : '#dbe3ef'
              })
            })
          ]
        }
      ]))
    }

    return makeLandingFunnel(tpl, makeLandingLayout([
      {
        settings: { blockBg: '#08080a', blockText: '#ffffff', textAlign: 'center', blockPaddingTop: 68, blockPaddingBottom: 56 },
        blocks: [
      makeBlock('hero', 'Hero', 'Agenda tu consulta', {
        settings: withLandingSpacing('hero', {
          textAlign: 'center',
          kicker: 'Nuevo',
          subtitle: 'Una pagina clara para convertir visitas en leads calificados.',
          buttonText: 'Quiero una consulta',
          buttonUrl: '#form',
          ...defaultButtonSettings
        })
      })
        ]
      },
      {
        columns: 2,
        settings: { blockBg: '#ffffff', blockText: '#111827', sectionGap: 28, blockPaddingTop: 52, blockPaddingBottom: 52 },
        columnBlocks: [
          [
      makeBlock('benefits', 'Beneficios', 'Por que elegirnos', {
        settings: withLandingSpacing('benefits', {
          items: [
            { title: '+ Atencion rapida', text: 'Captura datos y responde sin friccion.' },
            { title: '+ Leads ordenados', text: 'Todo llega al dashboard y a la misma base de datos.' },
            { title: '+ Dominio propio', text: 'Publica solo en dominios verificados.' }
          ]
        })
      })
          ],
          [
            makeBlock('form_embed', 'Formulario', 'Deja tus datos', {
              settings: formEmbedSettings('Completa la informacion y nuestro equipo te contactara.', {
                blockBg: '#f8fafc',
                blockText: '#111827'
              })
            })
          ]
        ]
      },
      {
        settings: { blockBg: '#111827', blockText: '#ffffff', textAlign: 'center', blockPaddingTop: 46, blockPaddingBottom: 50 },
        blocks: [
      makeBlock('cta', 'CTA final', 'Listo para empezar?', {
        settings: withLandingSpacing('cta', {
          textAlign: 'center',
          subtitle: 'Deja tus datos y te contactamos.',
          buttonText: 'Contactar',
          buttonUrl: '#form',
          ...defaultButtonSettings
        })
      })
        ]
      }
    ]))
  }

  if (siteType === 'interactive_form') {
    if (tpl === 'callback') {
      return [
        makeBlock('title', 'Titulo', 'Veamos si tiene sentido hablar', { sortOrder: 0 }),
        makeBlock('subtitle', 'Subtitulo', 'Contesta estas preguntas y te decimos el siguiente paso.', { sortOrder: 1 }),
        makeBlock('radio', 'Que tan pronto quieres avanzar?', '', {
          required: true,
          options: [
            { label: 'Esta semana', action: 'hot_lead', category: 'caliente' },
            { label: 'Este mes', action: 'warm_lead', category: 'tibio' },
            { label: 'Solo estoy comparando', action: 'cold_lead', category: 'frio' }
          ],
          settings: { internalName: 'urgency' },
          sortOrder: 2
        }),
        makeBlock('paragraph', 'Que necesitas resolver?', '', {
          placeholder: 'Escribe el contexto principal',
          required: false,
          settings: { internalName: 'need' },
          sortOrder: 3
        }),
        ...contactFields(4)
      ]
    }

    if (tpl === 'quote') {
      return [
        makeBlock('title', 'Titulo', 'Cotiza sin dar vueltas', { sortOrder: 0 }),
        makeBlock('subtitle', 'Subtitulo', 'Primero entendemos lo que necesitas y despues pedimos tus datos.', { sortOrder: 1 }),
        makeBlock('dropdown', 'Que tipo de ayuda necesitas?', '', {
          required: true,
          options: ['Servicio principal', 'Paquete completo', 'No estoy seguro'],
          settings: { internalName: 'service_type' },
          sortOrder: 2
        }),
        makeBlock('currency', 'Presupuesto aproximado', '', {
          placeholder: '$',
          required: false,
          settings: { internalName: 'budget' },
          sortOrder: 3
        }),
        makeBlock('paragraph', 'Cuentanos el contexto', '', {
          placeholder: 'Que quieres lograr?',
          required: false,
          settings: { internalName: 'context' },
          sortOrder: 4
        }),
        ...contactFields(5)
      ]
    }

    if (tpl === 'event' || tpl === 'waitlist') {
      const isWaitlist = tpl === 'waitlist'
      return [
        makeBlock('title', 'Titulo', isWaitlist ? 'Entra a la lista de espera' : 'Confirma tu registro', { sortOrder: 0 }),
        makeBlock('subtitle', 'Subtitulo', isWaitlist ? 'Te avisamos cuando haya cupo o acceso disponible.' : 'Responde rapido para reservar tu lugar o recibir detalles.', { sortOrder: 1 }),
        makeBlock('radio', isWaitlist ? 'Que acceso quieres?' : 'Que quieres recibir?', '', {
          required: true,
          options: isWaitlist
            ? ['Acceso anticipado', 'Cupo prioritario', 'Mas informacion']
            : ['Confirmar asistencia', 'Recibir detalles', 'Agendar una llamada'],
          settings: { internalName: isWaitlist ? 'access_interest' : 'registration_interest' },
          sortOrder: 2
        }),
        makeBlock('dropdown', 'Mejor horario de contacto', '', {
          required: false,
          options: ['Manana', 'Tarde', 'Noche'],
          settings: { internalName: 'contact_window' },
          sortOrder: 3
        }),
        ...contactFields(4)
      ]
    }

    if (tpl === 'facebook' || tpl === 'instagram' || tpl === 'tiktok') {
      return [
        socialProfileBlock(0),
        makeBlock('title', 'Titulo', 'Deja tus datos y te contactamos', { sortOrder: 1 }),
        makeBlock('subtitle', 'Subtitulo', 'Completa el formulario y un asesor te contacta en minutos.', { sortOrder: 2 }),
        ...contactFields(3)
      ]
    }

    return [
      makeBlock('title', 'Titulo', 'Vamos paso a paso', { sortOrder: 0 }),
      makeBlock('subtitle', 'Subtitulo', 'Estas preguntas ayudan a saber si eres buen candidato.', { sortOrder: 1 }),
      makeBlock('radio', 'Que buscas hoy?', '', {
        required: true,
        options: [
          { label: 'Quiero comprar o contratar', action: 'hot_lead', category: 'caliente' },
          { label: 'Necesito orientacion', action: 'warm_lead', category: 'tibio' },
          { label: 'Solo estoy investigando', action: 'cold_lead', category: 'frio' }
        ],
        settings: { internalName: 'intent' },
        sortOrder: 2
      }),
      makeBlock('paragraph', 'Cuentanos mas', '', {
        placeholder: 'Escribe una respuesta breve',
        required: false,
        settings: { internalName: 'details' },
        sortOrder: 3
      }),
      ...contactFields(4)
    ]
  }

  if (tpl === 'compact') {
    return withStandardFormPages([
      makeBlock('title', 'Titulo', 'Deja tus datos y te contactamos', { sortOrder: 0 }),
      makeBlock('subtitle', 'Subtitulo', 'Completa este formulario rapido para que podamos darte seguimiento.', { sortOrder: 1 }),
      makeBlock('description', 'Nota', 'Tardas menos de un minuto. Usa este formato cuando solo necesitas datos basicos.', { sortOrder: 2 }),
      ...contactFields(3)
    ])
  }

  if (tpl === 'event') {
    return withStandardFormPages([
      formImageBlock('Imagen de registro', TEMPLATE_IMAGE_URLS.planning, 0, { mediaRadius: 22 }),
      makeBlock('title', 'Titulo', 'Registro rapido', { sortOrder: 1 }),
      makeBlock('subtitle', 'Subtitulo', 'Deja tus datos para confirmar informacion y recibir los siguientes pasos.', { sortOrder: 2 }),
      makeBlock('dropdown', 'Que te interesa?', '', {
        required: true,
        options: ['Recibir informacion', 'Agendar una llamada', 'Cotizar un servicio'],
        settings: { internalName: 'interest' },
        sortOrder: 3
      }),
      makeBlock('date', 'Fecha ideal', '', {
        required: false,
        settings: { internalName: 'preferred_date' },
        sortOrder: 4
      }),
      ...contactFields(5)
    ])
  }

  if (tpl === 'quote') {
    return withStandardFormPages([
      formImageBlock('Imagen de cotizacion', TEMPLATE_IMAGE_URLS.quote, 0, { mediaRadius: 18 }),
      makeBlock('title', 'Titulo', 'Cuentanos que necesitas cotizar', { sortOrder: 1 }),
      makeBlock('subtitle', 'Subtitulo', 'Mientras mas claro sea el contexto, mas facil sera responderte bien.', { sortOrder: 2 }),
      makeBlock('dropdown', 'Servicio de interes', '', {
        required: true,
        options: ['Servicio principal', 'Paquete completo', 'Aun no se'],
        settings: { internalName: 'service_interest' },
        sortOrder: 3
      }),
      makeBlock('currency', 'Presupuesto aproximado', '', {
        placeholder: '$',
        required: false,
        settings: { internalName: 'budget' },
        sortOrder: 4
      }),
      makeBlock('paragraph', 'Detalles importantes', '', {
        placeholder: 'Cuentanos que quieres lograr',
        required: false,
        settings: { internalName: 'project_details' },
        sortOrder: 5
      }),
      ...contactFields(6)
    ])
  }

  if (tpl === 'callback') {
    return withStandardFormPages([
      makeBlock('title', 'Titulo', 'Solicita una llamada consultiva', { sortOrder: 0 }),
      makeBlock('subtitle', 'Subtitulo', 'Este formulario ayuda a preparar la conversacion antes de contactarte.', { sortOrder: 1 }),
      makeBlock('radio', 'Nivel de urgencia', '', {
        required: true,
        options: [
          { label: 'Necesito resolverlo pronto', action: 'hot_lead', category: 'caliente' },
          { label: 'Estoy evaluando opciones', action: 'warm_lead', category: 'tibio' },
          { label: 'Solo quiero informacion', action: 'cold_lead', category: 'frio' }
        ],
        settings: { internalName: 'urgency' },
        sortOrder: 2
      }),
      makeBlock('paragraph', 'Que te gustaria revisar?', '', {
        placeholder: 'Describe brevemente tu situacion',
        required: false,
        settings: { internalName: 'call_topic' },
        sortOrder: 3
      }),
      ...contactFields(4)
    ])
  }

  if (tpl === 'waitlist') {
    return withStandardFormPages([
      makeBlock('title', 'Titulo', 'Entra a la lista de espera', { sortOrder: 0 }),
      formImageBlock('Imagen de lista', TEMPLATE_IMAGE_URLS.handshake, 1, { mediaRadius: 26 }),
      makeBlock('subtitle', 'Subtitulo', 'Deja tus datos y te avisamos cuando haya cupo, fecha o acceso disponible.', { sortOrder: 2 }),
      makeBlock('dropdown', 'Que quieres recibir?', '', {
        required: true,
        options: ['Acceso anticipado', 'Aviso de cupo', 'Mas informacion'],
        settings: { internalName: 'waitlist_interest' },
        sortOrder: 3
      }),
      makeBlock('checkboxes', 'Temas de interes', '', {
        required: false,
        options: ['Promociones', 'Nuevas fechas', 'Paquetes especiales'],
        settings: { internalName: 'topics' },
        sortOrder: 4
      }),
      ...contactFields(5)
    ])
  }

  if (tpl === 'executive' || tpl === 'local' || tpl === 'premium' || tpl === 'ristak') {
    return withStandardFormPages([
      makeBlock('title', 'Titulo', 'Solicita informacion', { sortOrder: 0 }),
      makeBlock('subtitle', 'Subtitulo', 'Cuentanos que necesitas y te contactamos con el siguiente paso.', { sortOrder: 1 }),
      makeBlock('paragraph', 'Que necesitas resolver?', '', {
        placeholder: 'Escribe una descripcion breve',
        required: false,
        settings: { internalName: 'need' },
        sortOrder: 2
      }),
      ...contactFields(3)
    ])
  }

  if (tpl === 'facebook' || tpl === 'instagram' || tpl === 'tiktok') {
    return withStandardFormPages([
      socialProfileBlock(0),
      makeBlock('title', 'Titulo', 'Deja tus datos y te contactamos', { sortOrder: 1 }),
      makeBlock('subtitle', 'Subtitulo', 'Completa el formulario y un asesor te contacta en minutos.', { sortOrder: 2 }),
      ...contactFields(3)
    ])
  }

  return withStandardFormPages([
    makeBlock('title', 'Titulo', siteType === 'interactive_form' ? 'Vamos paso a paso' : 'Cuentanos que necesitas', {
      sortOrder: 0
    }),
    makeBlock('subtitle', 'Subtitulo', 'Completa la informacion y nuestro equipo te contactara.', {
      sortOrder: 1
    }),
    ...contactFields(2)
  ])
}

function limitString(value, limit = 1200) {
  const text = cleanString(value)
  return text.length > limit ? text.slice(0, limit).trim() : text
}

function normalizeHexColor(value, fallback) {
  const color = cleanString(value)
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback
}

function isCssColor(value) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return false
  if (raw === 'transparent') return true
  if (/^#[0-9a-f]{6}$/i.test(raw)) return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const channels = match.slice(1, 4).map(Number)
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1
}

function isCssGradient(value) {
  const raw = cleanString(value)
  return /^(linear|radial|conic)-gradient\(/i.test(raw) && !/[;{}<>]/.test(raw)
}

function isCssPaint(value) {
  return isCssColor(value) || isCssGradient(value)
}

function normalizeCssColor(value, fallback = '') {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(0, 0, 0, 0)'
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (!isCssColor(raw)) return fallback
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return fallback
  const [r, g, b] = match.slice(1, 4).map(valuePart => Math.round(Number(valuePart)))
  const alpha = match[4] === undefined ? 1 : Math.round(Number(match[4]) * 100) / 100
  const toHex = channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')
  return alpha >= 1 ? `#${toHex(r)}${toHex(g)}${toHex(b)}` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function normalizeCssPaint(value, fallback = '') {
  const raw = cleanString(value)
  if (isCssGradient(raw)) return raw
  return normalizeCssColor(raw, fallback)
}

function extractCssColor(value, fallback = '#111827') {
  const raw = cleanString(value)
  const match = raw.match(/(#[0-9a-f]{6}|rgba?\([^)]*\)|transparent)/i)
  return match ? normalizeCssColor(match[1], fallback) : fallback
}

function paintFallbackColor(paint, fallback = '#111827') {
  return isCssGradient(paint) ? extractCssColor(paint, fallback) : normalizeCssColor(paint, fallback)
}

function normalizeSitesAIMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-SITES_AI_MAX_MESSAGES)
    .map(message => ({
      role: cleanString(message?.role) === 'assistant' ? 'assistant' : 'user',
      content: limitString(message?.content, SITES_AI_MAX_MESSAGE_CHARS)
    }))
    .filter(message => message.content)
}

function getOpenAIErrorMessage(data, fallback = 'OpenAI no pudo generar el site') {
  if (!data) return fallback
  return cleanString(data?.error?.message || data?.message || data?.error) || fallback
}

function extractOpenAIResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  const textParts = []
  const output = Array.isArray(data?.output) ? data.output : []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      if (typeof part?.text === 'string') {
        textParts.push(part.text)
      }
    }
  }

  return textParts.join('\n').trim()
}

function parseSitesAIJson(text) {
  const rawText = cleanString(text)
  if (!rawText) throw new Error('La IA respondio vacia')

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] || rawText
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const jsonText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate

  try {
    return JSON.parse(jsonText)
  } catch {
    const error = new Error('La IA no devolvio JSON valido para Sites')
    error.status = 502
    throw error
  }
}

function getSitesAITargetType(siteKind) {
  if (siteKind === 'landing') return 'landing_page'
  if (siteKind === 'interactive_form') return 'interactive_form'
  return 'standard_form'
}

function validateSitesAICreationKind(value) {
  const siteKind = cleanString(value)
  if (!['landing', 'form', 'interactive_form'].includes(siteKind)) {
    const error = new Error('Tipo de creacion con IA invalido')
    error.status = 400
    throw error
  }
  return siteKind
}

const SITES_AI_MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/

function normalizeSitesAIModel(value, fallback = '') {
  const model = cleanString(value)
  if (model && SITES_AI_MODEL_ID_PATTERN.test(model)) return model
  const fallbackModel = cleanString(fallback)
  return SITES_AI_MODEL_ID_PATTERN.test(fallbackModel) ? fallbackModel : ''
}

function getSitesAIKindFromSiteType(siteType = 'landing_page') {
  if (siteType === 'interactive_form') return 'interactive_form'
  if (siteType === 'standard_form') return 'form'
  return 'landing'
}

function getSitesAIBusinessContext(agentConfig = {}) {
  return [
    agentConfig.business_context,
    agentConfig.market_context,
    agentConfig.ideal_customer,
    agentConfig.location_context,
    agentConfig.competitors_context,
    agentConfig.brand_voice,
    agentConfig.action_customizations
  ].map(value => limitString(value, 1200)).filter(Boolean).join('\n\n')
}

function getSitesAIImageCatalogText() {
  return SITES_AI_STOCK_IMAGE_LIBRARY
    .map(group => `- ${group.id}: ${group.label}. Fondo: ${group.backgroundImage}. Imagenes: ${group.images.join(' | ')}`)
    .join('\n')
}

function buildSitesAIHtmlInstructions({ siteKind, agentConfig = {}, editMode = false }) {
  const businessContext = getSitesAIBusinessContext(agentConfig)
  const imageCatalog = getSitesAIImageCatalogText()
  const targetSiteType = getSitesAITargetType(siteKind)

  return `
Eres el creador libre de paginas HTML de Ristak. Genera o modifica una pagina completa en HTML/CSS para que Ristak la importe como codigo propio.

Reglas duras:
- Responde SOLO JSON valido, sin markdown.
- No uses React, JSX, Tailwind, dependencias externas ni JavaScript obligatorio. El importador de Ristak puede quitar scripts por seguridad.
- Entrega un documento HTML completo con <!doctype html>, <html lang="es">, <head>, <meta charset>, <meta viewport>, <title>, meta description y CSS dentro de <style>.
- La pagina debe ser responsiva, profesional y lista para publicarse.
- Copy corto: titulares de 4 a 10 palabras cuando sea posible, parrafos breves de 1 a 2 lineas, listas cortas para explicar detalles.
- Si un texto largo es necesario, ajusta el CSS con font-size menor, max-width razonable, line-height claro y espacios suficientes. No dejes titulares enormes que rompan el layout.
- Usa imagenes HTTPS directas y visibles. Prefiere el catalogo incluido. Tambien puedes usar URLs directas publicas/licenciadas de bancos conocidos cuando el usuario las proporcione o esten permitidas; no uses previews con marca de agua.
- No uses formularios que dependan de JavaScript. El submit lo intercepta Ristak.
- No agregues action externo en formularios.
- No escondas campos importantes ni uses inputs sin name.
- No metas tarjetas dentro de tarjetas sin necesidad; usa secciones limpias, buena jerarquia y aire visual.
- Tipo solicitado: ${targetSiteType}.

Marcado para edicion rapida:
- Marca los elementos importantes que el usuario podria querer cambiar sin tocar codigo.
- Usa data-rstk-editable="true", data-rstk-edit-type, data-rstk-label y data-rstk-edit-id.
- Cuando puedas, agrega tambien aliases data-ristak-* o data-ristack-* para compatibilidad.
- Tipos permitidos: heading, text, button, form_label, placeholder, image, background_image.
- Marca titulares, subtitulares, parrafos breves, botones, labels de formularios, placeholders, imagenes, logos y elementos con fondo de imagen.
- En botones editables, cuando sepas la accion, agrega data-rstk-button-action con uno de estos valores: submit, next_page, specific_page, url, disqualify, none.
- Si el boton abre enlace, agrega data-rstk-button-url. Si va a una pagina interna, agrega data-rstk-button-page-id cuando exista un id claro.
- Marca secciones principales con data-rstk-section y un nombre claro.
- No envuelvas textos editables en demasiadas etiquetas. Deja un elemento claro para cada texto importante.

Convenciones de formularios para Ristak:
- Cada formulario debe tener data-rstk-form="lead_capture" y method="post".
- Cada campo debe tener id, name, label visible y autocomplete cuando aplique.
- Agrega data-rstk-field y data-ristak-field en campos estandar para que Ristak los entienda.
- Campos estandar permitidos: full_name, first_name, last_name, phone, email, message.
- Para campos personalizados usa data-rstk-custom-field y data-ristak-field con una llave clara.
- Campos personalizados utiles: treatment_interest, service_interest, preferred_date, preferred_time, appointment_reason, budget, branch, notes, company_name, job_title, city, state, postal_code.
- Ejemplo de nombre: <input id="full_name" name="full_name" data-rstk-field="full_name" data-ristak-field="full_name" autocomplete="name" required>
- Ejemplo de tratamiento: <select id="treatment_interest" name="treatment_interest" data-rstk-custom-field="treatment_interest" data-ristak-field="treatment_interest" required>.
- Si hay telefono, usa type="tel", name="phone", data-rstk-field="phone", autocomplete="tel".
- Si hay email, usa type="email", name="email", data-rstk-field="email", autocomplete="email".

JSON cuando falta informacion:
{
  "status": "needs_more_info",
  "reply": "Pregunta breve al usuario"
}

JSON cuando esta listo:
{
  "status": "ready",
  "reply": "Pagina HTML lista para importar.",
  "page": {
    "siteType": "${targetSiteType}",
    "filename": "pagina-generada.html",
    "name": "Nombre interno",
    "title": "Titulo publico",
    "description": "Descripcion corta",
    "html": "<!doctype html>..."
  }
}

${editMode ? `
Modo edicion:
- Recibiras el HTML actual y la peticion del usuario.
- Devuelve el HTML completo actualizado, no solo un fragmento.
- Conserva formularios, ids, name, data-rstk-form, data-rstk-form-id, data-rstk-field, data-ristak-field, data-rstk-custom-field, data-rstk-edit-id, data-rstk-editable, data-rstk-edit-type, data-rstk-label, data-rstk-section, data-rstk-button-action, data-rstk-button-url, data-rstk-button-page-id, data-rstk-button-message y sus aliases data-ristak-* / data-ristack-* cuando el usuario no pida cambiarlos.
- Si cambias campos, deja convenciones claras para que Ristak pueda redetectar y mapear.
- Puedes cambiar titulo, imagenes, orden de secciones, colores, layout, copy y campos segun lo que pida el usuario.
` : `
Modo creacion:
- Si el usuario pidio formulario, incluyelo completo y bien mapeado.
- Si no especifica campos, usa los campos minimos razonables para el objetivo.
- Para landings de captura, incluye nombre completo, telefono o email y un campo de interes si aplica.
`}

Catalogo de imagenes permitido:
${imageCatalog}

Contexto del negocio configurado en Ristak:
${businessContext || 'Sin contexto adicional configurado.'}
`.trim()
}

async function callSitesAIJson({ apiKey, model, instructions, input, maxOutputTokens = 7200, fallbackError = 'OpenAI no pudo generar el site' }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cleanString(model) || 'gpt-5.5',
      instructions,
      input: JSON.stringify(input),
      max_output_tokens: maxOutputTokens
    })
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    const error = new Error(getOpenAIErrorMessage(data, fallbackError))
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502
    throw error
  }

  const text = extractOpenAIResponseText(data)
  return parseSitesAIJson(text)
}

async function callSitesAIHtmlGenerator({ apiKey, model, siteKind, messages, agentConfig }) {
  return callSitesAIJson({
    apiKey,
    model,
    instructions: buildSitesAIHtmlInstructions({ siteKind, agentConfig }),
    input: {
      siteKind,
      targetSiteType: getSitesAITargetType(siteKind),
      conversation: messages
    },
    maxOutputTokens: 18000,
    fallbackError: 'OpenAI no pudo generar el HTML'
  })
}

async function callSitesAIHtmlEditor({ apiKey, model, siteKind, messages, agentConfig, site, importedSite }) {
  return callSitesAIJson({
    apiKey,
    model,
    instructions: buildSitesAIHtmlInstructions({ siteKind, agentConfig, editMode: true }),
    input: {
      siteKind,
      targetSiteType: getSitesAITargetType(siteKind),
      site: {
        id: site?.id,
        name: site?.name,
        title: site?.title,
        description: site?.description,
        siteType: site?.siteType
      },
      importedSite: {
        importType: importedSite?.importType,
        originalFilename: importedSite?.originalFilename,
        detectedForms: importedSite?.detectedForms || [],
        formMappings: importedSite?.formMappings || []
      },
      currentHtml: limitString(importedSite?.htmlSanitized || importedSite?.htmlOriginal || '', 90000),
      conversation: messages
    },
    maxOutputTokens: 18000,
    fallbackError: 'OpenAI no pudo editar el HTML'
  })
}

function normalizeAIHtmlPagePayload(aiPayload = {}, siteKind = 'landing') {
  const page = aiPayload.page || aiPayload.site || aiPayload
  const targetSiteType = getSitesAITargetType(siteKind)
  const html = String(page?.html || aiPayload.html || '').trim()
  if (!html) {
    const error = new Error('La IA no devolvio HTML para importar')
    error.status = 502
    throw error
  }

  let filename = cleanString(page?.filename || page?.fileName || page?.name || 'pagina-generada.html')
  filename = filename.replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (!/\.html?$/i.test(filename)) filename = `${filename || 'pagina-generada'}.html`

  return {
    siteType: targetSiteType,
    filename,
    name: limitString(page?.name || page?.title || filename.replace(/\.[^.]+$/, ''), 100),
    title: limitString(page?.title || page?.name || filename.replace(/\.[^.]+$/, ''), 120),
    description: limitString(page?.description || page?.seoDescription || page?.seo?.description, 220),
    html
  }
}

export async function listSites() {
  const rows = await db.all(`
    SELECT
      s.*,
      COUNT(sub.id) AS submissions_count,
      (
        SELECT COUNT(*)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.event_name IN ('native_site_view', 'session_start', 'page_view')
      ) AS tracking_views,
      (
        SELECT COUNT(DISTINCT ts.visitor_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.visitor_id IS NOT NULL
          AND ts.visitor_id != ''
      ) AS tracking_visitors,
      (
        SELECT COUNT(DISTINCT ts.session_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.session_id IS NOT NULL
          AND ts.session_id != ''
      ) AS tracking_sessions,
      (
        SELECT COUNT(DISTINCT ts.submission_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.event_name = 'native_site_conversion'
          AND ts.submission_id IS NOT NULL
          AND ts.submission_id != ''
      ) AS tracking_conversions
    FROM public_sites s
    LEFT JOIN public_site_submissions sub ON sub.site_id = s.id
    GROUP BY
      s.id, s.name, s.slug, s.site_type, s.status, s.domain, s.title, s.description,
      s.theme_json, s.meta_capi_enabled, s.meta_event_name, s.render_domain_verified,
      s.render_domain_checked_at, s.render_domain_error, s.published_at, s.created_at, s.updated_at
    ORDER BY s.updated_at DESC
  `)

  return rows.map(mapSite)
}

async function getSiteTrackingStats(siteId) {
  const row = await db.get(`
    SELECT
      COUNT(CASE WHEN event_name IN ('native_site_view', 'session_start', 'page_view') THEN 1 END) AS tracking_views,
      COUNT(DISTINCT visitor_id) AS tracking_visitors,
      COUNT(DISTINCT session_id) AS tracking_sessions,
      COUNT(DISTINCT CASE WHEN event_name = 'native_site_conversion' THEN submission_id END) AS tracking_conversions
    FROM sessions
    WHERE site_id = ? OR form_site_id = ?
  `, [siteId, siteId])

  const visitors = Number(row?.tracking_visitors || 0)
  const conversions = Number(row?.tracking_conversions || 0)

  return {
    views: Number(row?.tracking_views || 0),
    visitors,
    sessions: Number(row?.tracking_sessions || 0),
    conversions,
    conversionRate: visitors > 0 ? Number(((conversions / visitors) * 100).toFixed(1)) : 0
  }
}

export async function getSite(siteId, { includeBlocks = true, includeSubmissions = false } = {}) {
  const row = await db.get('SELECT * FROM public_sites WHERE id = ?', [siteId])
  const site = mapSite(row)

  if (!site) return null

  site.trackingStats = await getSiteTrackingStats(site.id)

  if (includeBlocks) {
    site.blocks = await ensureSocialProfileBlock(site, await listSiteBlocks(site.id))
  }

  if (includeSubmissions) {
    site.submissions = await listSiteSubmissions(site.id)
  }

  return site
}

export async function getSitePreview(siteId) {
  const site = await getSite(siteId, { includeBlocks: false, includeSubmissions: false })
  if (!site) return null

  site.blocks = await hydrateEmbeddedForms(await ensureSocialProfileBlock(site, await listSiteBlocks(site.id)))
  return site
}

export async function listSiteBlocks(siteId) {
  const rows = await db.all(
    'SELECT * FROM public_site_blocks WHERE site_id = ? ORDER BY sort_order ASC, created_at ASC',
    [siteId]
  )
  return rows.map(mapBlock)
}

async function markSocialProfileBlockReady(site) {
  if (site?.theme?.[SOCIAL_PROFILE_BLOCK_READY_KEY] === true) return

  site.theme = {
    ...(site.theme || {}),
    [SOCIAL_PROFILE_BLOCK_READY_KEY]: true
  }
  await db.run('UPDATE public_sites SET theme_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    jsonString(site.theme),
    site.id
  ])
}

function isGenericSocialProfileName(value) {
  const name = cleanString(value).toLowerCase()
  return !name || name === 'tu marca' || name === 'perfil de red social'
}

function isGenericSocialProfileSubtitle(value) {
  const subtitle = cleanString(value).toLowerCase()
  return !subtitle || subtitle === 'patrocinado' || subtitle === 'publicacion pagada'
}

function isSupportedSocialPlatform(value) {
  return ['facebook', 'instagram', 'tiktok', 'threads'].includes(cleanString(value))
}

async function refreshLegacySocialProfileBlock(site, block, platform) {
  if (!block) return false

  const settings = block.settings || {}
  const defaults = getSocialProfileDefaults(site, platform)
  const nextSettings = { ...settings }
  let changed = false
  const setIfChanged = (key, value) => {
    if (nextSettings[key] === value) return
    nextSettings[key] = value
    changed = true
  }

  if (!isSupportedSocialPlatform(settings.platform)) {
    const sourcePlatform = isSupportedSocialPlatform(settings.socialSourcePlatform)
      ? cleanString(settings.socialSourcePlatform)
      : defaults.platform
    setIfChanged('platform', sourcePlatform)
  }
  if (isGenericSocialProfileName(settings.brandName) && cleanString(defaults.brandName)) {
    setIfChanged('brandName', defaults.brandName)
  }
  if (isGenericSocialProfileSubtitle(settings.brandSubtitle) && cleanString(defaults.brandSubtitle)) {
    setIfChanged('brandSubtitle', defaults.brandSubtitle)
  }
  if (!cleanString(settings.brandAvatar) && cleanString(defaults.brandAvatar)) {
    setIfChanged('brandAvatar', defaults.brandAvatar)
  }
  if (!cleanString(settings.followers) && cleanString(defaults.followers)) {
    setIfChanged('followers', defaults.followers)
  }
  if (settings.brandVerified === undefined && defaults.brandVerified !== undefined) {
    setIfChanged('brandVerified', defaults.brandVerified)
  }

  if (!changed) return false

  await db.run(
    'UPDATE public_site_blocks SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?',
    [jsonString(nextSettings), block.id, site.id]
  )
  return true
}

async function ensureSocialProfileBlock(site, currentBlocks = null) {
  const template = cleanString(site?.theme?.template)
  const blocks = Array.isArray(currentBlocks) ? currentBlocks : await listSiteBlocks(site.id)

  if (!site || !isSocialTemplate(template)) return blocks

  const pages = normalizeSitePages(site)
  const entryPageId = pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
  const existingProfile = blocks.find(block => block.blockType === 'social_profile')

  if (existingProfile) {
    const refreshed = await refreshLegacySocialProfileBlock(site, existingProfile, template)
    await markSocialProfileBlockReady(site)
    return refreshed ? listSiteBlocks(site.id) : blocks
  }

  if (site.theme?.[SOCIAL_PROFILE_BLOCK_READY_KEY] === true) {
    return blocks
  }

  const pageBlocks = blocks
    .filter(block => getBlockPageId(block, pages) === entryPageId)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const id = crypto.randomUUID()
  const firstSection = site.siteType === 'landing_page' ? pageBlocks.find(isSectionBlock) : null
  const baseSettings = getSocialProfileDefaults(site, template)
  const settings = {
    ...(site.siteType === 'landing_page' ? getSocialProfileLandingSpacing() : {}),
    ...baseSettings,
    pageId: entryPageId,
    ...(firstSection ? { sectionId: firstSection.id, sectionColumn: 0 } : {})
  }

  await db.run(`
    INSERT INTO public_site_blocks (
      id, site_id, block_type, label, content, placeholder, required,
      options_json, settings_json, sort_order, created_at, updated_at
    ) VALUES (?, ?, 'social_profile', ?, ?, '', 0, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    site.id,
    'Perfil de red social',
    'Perfil de red social',
    jsonString([]),
    jsonString(settings)
  ])

  const nextBlocks = await listSiteBlocks(site.id)
  const nextPageBlocks = nextBlocks
    .filter(block => getBlockPageId(block, pages) === entryPageId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const inserted = nextPageBlocks.find(block => block.id === id)

  if (inserted) {
    const withoutInserted = nextPageBlocks.filter(block => block.id !== id)
    const sectionIndex = firstSection ? withoutInserted.findIndex(block => block.id === firstSection.id) : -1
    const headerIndex = withoutInserted.findIndex(block => block.blockType === 'header_panel')
    const insertIndex = sectionIndex >= 0
      ? sectionIndex + 1
      : headerIndex >= 0
        ? headerIndex + 1
        : 0
    const orderedBlocks = [
      ...withoutInserted.slice(0, insertIndex),
      inserted,
      ...withoutInserted.slice(insertIndex)
    ]

    for (const [index, block] of orderedBlocks.entries()) {
      await db.run(
        'UPDATE public_site_blocks SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?',
        [index, block.id, site.id]
      )
    }
  }

  await markSocialProfileBlockReady(site)
  return listSiteBlocks(site.id)
}

export async function listSiteSubmissions(siteId) {
  const rows = await db.all(`
    SELECT
      sub.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM public_site_submissions sub
    LEFT JOIN contacts c ON c.id = sub.contact_id
    WHERE sub.site_id = ?
    ORDER BY sub.created_at DESC
    LIMIT 250
  `, [siteId])

  return rows.map(mapSubmission)
}

export async function createSite(input = {}) {
  const id = crypto.randomUUID()
  const siteType = validateSiteType(input.siteType || input.site_type)
  const slug = await ensureUniqueSlug(slugify(input.slug || await getNextDefaultSlug(siteType)))
  const name = cleanString(input.name) || getDefaultSiteName(siteType, slug)
  const title = Object.prototype.hasOwnProperty.call(input, 'title')
    ? cleanString(input.title)
    : name
  const description = cleanString(input.description)
  const domain = ''
  const theme = { ...DEFAULT_THEME, ...(input.theme || {}) }
  const blankCanvas = Boolean(normalizeBoolean(input.blankCanvas || input.blank_canvas || theme.blankCanvas || theme.blank_canvas))
  delete theme.blankCanvas
  delete theme.blank_canvas
  if (blankCanvas) {
    theme.backgroundImage = ''
    if (!cleanString(theme.backgroundColor)) {
      theme.backgroundColor = '#ffffff'
    }
  }
  if (siteType === 'landing_page') {
    if (theme.pageMaxWidth === undefined) {
      theme.pageMaxWidth = 1440
    }
    if (!Array.isArray(theme.pages) || theme.pages.length === 0) {
      theme.pages = getDefaultFunnelPages(theme.template)
    }
  } else if (siteType === 'standard_form') {
    theme.pages = normalizeSitePages({ siteType, theme })
    theme.formCompletionAction = normalizeFormCompletionAction(theme.formCompletionAction || theme.form_completion_action, 'next_page_if_qualified')
  } else if (siteType === 'interactive_form' && (!Array.isArray(theme.pages) || theme.pages.length === 0)) {
    theme.pages = normalizeSitePages({ theme: {} })
  }
  if (isSocialTemplate(theme.template)) {
    theme[SOCIAL_PROFILE_BLOCK_READY_KEY] = true
  }
  const status = validateSiteStatus(input.status || 'draft')

  await db.run(`
    INSERT INTO public_sites (
      id, name, slug, site_type, status, domain, title, description, theme_json,
      meta_capi_enabled, meta_event_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    name,
    slug,
    siteType,
    status,
    domain || null,
    title,
    description || null,
    jsonString(theme),
    normalizeBoolean(input.metaCapiEnabled),
    normalizeSiteMetaEventName(input.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
  ])

  if (!blankCanvas) {
    for (const block of buildDefaultBlocks(id, siteType, theme.template, { name, title, theme })) {
      await db.run(`
        INSERT INTO public_site_blocks (
          id, site_id, block_type, label, content, placeholder, required,
          options_json, settings_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        block.id,
        block.site_id,
        block.block_type,
        block.label,
        block.content,
        block.placeholder,
        block.required,
        block.options_json,
        block.settings_json,
        block.sort_order
      ])
    }
  }

  return getSite(id, { includeBlocks: true, includeSubmissions: true })
}

function getImportedHtmlTitle(html = '', fallback = 'Pagina importada') {
  const titleMatch = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return limitString(stripHtmlTags(titleMatch?.[1] || fallback), 120)
}

function getImportedHtmlDescription(html = '', fallback = '') {
  const metaPattern = /<meta\b([^>]*)>/gi
  let match
  while ((match = metaPattern.exec(String(html || '')))) {
    const attrs = parseHtmlAttributes(match[1] || '')
    const name = cleanString(attrs.name || attrs.property).toLowerCase()
    if (['description', 'og:description', 'twitter:description'].includes(name)) {
      const content = cleanString(attrs.content)
      if (content) return limitString(content, 220)
    }
  }
  return limitString(fallback, 220)
}

function pickImportedZipMainHtmlPath(paths = [], filename = '') {
  const sorted = [...paths].sort((left, right) => {
    const leftDepth = left.split('/').length
    const rightDepth = right.split('/').length
    if (leftDepth !== rightDepth) return leftDepth - rightDepth
    if (left.length !== right.length) return left.length - right.length
    return left.localeCompare(right)
  })
  const rootIndex = sorted.find(assetPath => /^index\.html?$/i.test(assetPath))
  if (rootIndex) return rootIndex

  const nestedIndex = sorted.find(assetPath => /(^|\/)index\.html?$/i.test(assetPath))
  if (nestedIndex) return nestedIndex

  const filenameBase = normalizeImportedFieldKey(filename.replace(/\.[^.]+$/, ''), '')
  const namedHtml = filenameBase
    ? sorted.find(assetPath => normalizeImportedFieldKey((assetPath.split('/').pop() || '').replace(/\.[^.]+$/, ''), '') === filenameBase)
    : ''
  return namedHtml || sorted[0] || ''
}

function sortImportedZipHtmlPaths(paths = [], mainPath = '') {
  const sorted = [...paths].sort((left, right) => {
    const leftDepth = left.split('/').length
    const rightDepth = right.split('/').length
    if (leftDepth !== rightDepth) return leftDepth - rightDepth
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  })

  return [
    mainPath,
    ...sorted.filter(assetPath => assetPath !== mainPath)
  ].filter(Boolean)
}

function makeImportedZipPage(assetPath, index = 0, originalTitle = '') {
  return {
    id: index === 0 ? DEFAULT_FUNNEL_PAGE_ID : `page-${index + 1}`,
    title: `Pagina ${index + 1}`,
    sortOrder: index,
    importedAssetPath: normalizeImportedAssetPath(assetPath),
    ...(cleanString(originalTitle) ? { importedOriginalTitle: cleanString(originalTitle) } : {}),
    metaCapiEnabled: false,
    metaEventName: SITE_META_NO_EVENT,
    metaTrigger: 'page_view'
  }
}

async function extractImportedZipArchive(filename = '', buffer = Buffer.alloc(0)) {
  if (!buffer.length) {
    const error = new Error('El ZIP esta vacio')
    error.status = 400
    throw error
  }

  if (buffer.byteLength > IMPORTED_ZIP_MAX_BYTES) {
    const error = new Error('El ZIP es demasiado grande. Sube un archivo de maximo 15 MB.')
    error.status = 400
    throw error
  }

  let zip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    const error = new Error('No pudimos leer el ZIP. Comprimelo de nuevo e intenta otra vez.')
    error.status = 400
    throw error
  }

  const filesByPath = new Map()
  const report = []
  let totalBytes = 0
  const entries = Object.values(zip.files || {}).sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    if (!entry || entry.dir) continue

    const assetPath = normalizeImportedAssetPath(entry.name)
    if (!assetPath || isSkippedImportedZipPath(assetPath)) continue

    const extension = getImportedAssetExtension(assetPath)
    if (!IMPORTED_ASSET_ALLOWED_EXTENSIONS.has(extension)) {
      if (report.length < 20) report.push(`Se omitio ${assetPath} porque no es un archivo web permitido`)
      continue
    }

    if (filesByPath.has(assetPath)) {
      if (report.length < 20) report.push(`Se omitio duplicado ${assetPath}`)
      continue
    }

    if (filesByPath.size >= IMPORTED_ZIP_MAX_FILES) {
      const error = new Error(`El ZIP trae demasiados archivos. Sube maximo ${IMPORTED_ZIP_MAX_FILES} archivos web.`)
      error.status = 400
      throw error
    }

    const content = await entry.async('nodebuffer')
    if (content.byteLength > IMPORTED_ASSET_MAX_BYTES) {
      const error = new Error(`El archivo ${assetPath} es demasiado grande. Cada archivo interno debe pesar maximo 8 MB.`)
      error.status = 400
      throw error
    }

    totalBytes += content.byteLength
    if (totalBytes > IMPORTED_ASSET_TOTAL_MAX_BYTES) {
      const error = new Error('El ZIP trae demasiados assets. Reduce imagenes o videos e intenta otra vez.')
      error.status = 400
      throw error
    }

    filesByPath.set(assetPath, {
      assetPath,
      extension,
      contentType: getImportedAssetContentType(assetPath),
      content,
      sizeBytes: content.byteLength
    })
  }

  const htmlPaths = [...filesByPath.values()]
    .filter(file => IMPORTED_HTML_EXTENSIONS.has(file.extension))
    .map(file => file.assetPath)
  const mainPath = pickImportedZipMainHtmlPath(htmlPaths, filename)
  if (!mainPath) {
    const error = new Error('El ZIP no trae ningun archivo .html para abrir.')
    error.status = 400
    throw error
  }

  return {
    files: [...filesByPath.values()],
    mainPath,
    htmlPaths: sortImportedZipHtmlPaths(htmlPaths, mainPath),
    report: [
      `Se importo ZIP con ${filesByPath.size} archivos web`,
      `Pagina principal detectada: ${mainPath}`,
      ...report
    ]
  }
}

function buildImportedAssetRow({ importId, siteId, assetPath, contentType, content }) {
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8')
  return {
    id: `site_import_asset_${crypto.randomUUID()}`,
    importId,
    siteId,
    assetPath,
    contentType,
    contentBase64: contentBuffer.toString('base64'),
    sizeBytes: contentBuffer.byteLength
  }
}

function getImportedEditableUploadMimeType(value = '') {
  const match = cleanString(value).match(/^data:([^;,]+);base64,/i)
  return cleanString(match?.[1]).toLowerCase()
}

function getImportedEditableImageExtension(filename = '', mimeType = '') {
  const safeName = normalizeImportedAssetPath(filename).split('/').pop() || ''
  let extension = getImportedAssetExtension(safeName)

  if (!IMPORTED_EDITABLE_IMAGE_EXTENSIONS.has(extension)) {
    const normalizedMime = cleanString(mimeType).toLowerCase()
    const extensionByMime = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/avif': 'avif'
    }
    extension = extensionByMime[normalizedMime] || ''
  }

  if (!IMPORTED_EDITABLE_IMAGE_EXTENSIONS.has(extension)) {
    const error = new Error('Sube una imagen PNG, JPG, WEBP, GIF o AVIF.')
    error.status = 400
    throw error
  }

  return extension === 'jpeg' ? 'jpg' : extension
}

async function addImportedEditableImageAsset(siteId, currentImport, input = {}) {
  const fileBase64 = cleanString(input.fileBase64 || input.file_base64)
  if (!fileBase64) return ''

  const buffer = decodeBase64Buffer(fileBase64)
  if (!buffer.length) {
    const error = new Error('La imagen esta vacia.')
    error.status = 400
    throw error
  }

  if (buffer.byteLength > IMPORTED_ASSET_MAX_BYTES) {
    const error = new Error('La imagen es demasiado grande. Sube una imagen de maximo 8 MB.')
    error.status = 400
    throw error
  }

  const extension = getImportedEditableImageExtension(input.filename || input.fileName || 'imagen', getImportedEditableUploadMimeType(fileBase64))
  const assetPath = `ai-edits/${Date.now()}-${crypto.randomUUID()}.${extension}`
  const asset = buildImportedAssetRow({
    importId: currentImport.id,
    siteId,
    assetPath,
    contentType: getImportedAssetContentType(assetPath),
    content: buffer
  })

  await db.run(`
    INSERT INTO public_site_import_assets (
      id, import_id, site_id, asset_path, content_type, content_base64, size_bytes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    asset.id,
    asset.importId,
    asset.siteId,
    asset.assetPath,
    asset.contentType,
    asset.contentBase64,
    asset.sizeBytes
  ])

  return `/api/sites/public/imported-assets/${encodeURIComponent(siteId)}/${assetPath}`
}

async function prepareImportedZipContent({ filename, fileBase64, siteId, importId }) {
  const archive = await extractImportedZipArchive(filename, decodeBase64Buffer(fileBase64))
  const availablePaths = new Set(archive.files.map(file => file.assetPath))
  const usedFormIds = new Set()
  const detectedForms = []
  const assets = []
  const securityReport = [...archive.report]
  const pageIndexByPath = new Map(archive.htmlPaths.map((assetPath, index) => [assetPath, index]))
  const pagesByPath = new Map()
  let rawHtml = ''
  let sanitizedHtml = ''

  for (const file of archive.files) {
    if (IMPORTED_HTML_EXTENSIONS.has(file.extension)) {
      const pageRawHtml = file.content.toString('utf8')
      const sanitized = sanitizeImportedHtml(pageRawHtml)
      const pageForms = namespaceImportedPageForms(detectImportedForms(sanitized.html), file.assetPath, usedFormIds)
      detectedForms.push(...pageForms.map(form => ({
        ...form,
        title: file.assetPath === archive.mainPath ? form.title : `${form.title} - ${file.assetPath}`
      })))
      let pageHtml = assignImportedFormIds(sanitized.html, pageForms)
      pageHtml = rewriteImportedHtmlReferences(pageHtml, file.assetPath, siteId, availablePaths)
      pageHtml = annotateImportedEditableHtml(pageHtml)

      for (const item of sanitized.report) {
        securityReport.push(`${file.assetPath}: ${item}`)
      }

      if (file.assetPath === archive.mainPath) {
        rawHtml = pageRawHtml
        sanitizedHtml = pageHtml
      }

      const pageIndex = pageIndexByPath.get(file.assetPath) ?? pagesByPath.size
      pagesByPath.set(file.assetPath, makeImportedZipPage(
        file.assetPath,
        pageIndex,
        getImportedHtmlTitle(sanitized.html, `Pagina ${pageIndex + 1}`)
      ))

      assets.push(buildImportedAssetRow({
        importId,
        siteId,
        assetPath: file.assetPath,
        contentType: file.contentType,
        content: pageHtml
      }))
      continue
    }

    if (file.extension === 'css') {
      const css = file.content.toString('utf8')
      assets.push(buildImportedAssetRow({
        importId,
        siteId,
        assetPath: file.assetPath,
        contentType: file.contentType,
        content: rewriteImportedCssReferences(css, file.assetPath, siteId, availablePaths)
      }))
      continue
    }

    assets.push(buildImportedAssetRow({
      importId,
      siteId,
      assetPath: file.assetPath,
      contentType: file.contentType,
      content: file.content
    }))
  }

  return {
    importType: 'zip',
    rawHtml,
    sanitized: {
      html: sanitizedHtml,
      report: Array.from(new Set(securityReport))
    },
    detectedForms,
    pages: archive.htmlPaths.map(assetPath => pagesByPath.get(assetPath)).filter(Boolean),
    assets
  }
}

async function replaceImportedSiteAssets(siteId, assets = []) {
  await db.run('DELETE FROM public_site_import_assets WHERE site_id = ?', [siteId])

  for (const asset of assets) {
    await db.run(`
      INSERT INTO public_site_import_assets (
        id, import_id, site_id, asset_path, content_type, content_base64, size_bytes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      asset.id,
      asset.importId,
      asset.siteId,
      asset.assetPath,
      asset.contentType,
      asset.contentBase64,
      asset.sizeBytes
    ])
  }
}

export async function getImportedSiteBySiteId(siteId) {
  const row = await db.get('SELECT * FROM public_site_imports WHERE site_id = ? LIMIT 1', [siteId])
  if (!row) return null
  let detectedForms = parseJson(row.detected_forms_json, [])
  let formMappings = parseJson(row.form_mappings_json, [])
  let htmlOriginal = row.html_original || ''
  let htmlSanitized = row.html_sanitized || ''
  const status = row.status || 'mapping_pending'

  if (htmlSanitized) {
    const annotatedHtml = annotateImportedEditableHtml(htmlSanitized)
    if (annotatedHtml !== htmlSanitized) {
      htmlSanitized = annotatedHtml
      htmlOriginal = htmlOriginal ? annotateImportedEditableHtml(htmlOriginal) : htmlSanitized
      await db.run(`
        UPDATE public_site_imports SET
          html_original = ?,
          html_sanitized = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE site_id = ?
      `, [
        htmlOriginal,
        htmlSanitized,
        siteId
      ])
    }
  }

  if (status === 'mapping_pending' && htmlSanitized) {
    const redetectedForms = detectImportedForms(htmlSanitized)
    const storedFieldCount = Math.max(
      countImportedDetectedFields(detectedForms),
      countImportedMappedFields(formMappings)
    )
    const redetectedFieldCount = countImportedDetectedFields(redetectedForms)

    if (redetectedFieldCount > storedFieldCount) {
      detectedForms = redetectedForms
      formMappings = buildDefaultImportedFormMappings(redetectedForms)
      await db.run(`
        UPDATE public_site_imports SET
          detected_forms_json = ?,
          form_mappings_json = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE site_id = ?
      `, [
        jsonString(detectedForms),
        jsonString(formMappings),
        siteId
      ])
    }
  }

  return {
    id: row.id,
    siteId: row.site_id,
    originalFilename: row.original_filename || '',
    importType: row.import_type || 'html',
    htmlOriginal,
    htmlSanitized,
    detectedForms,
    formMappings,
    securityReport: parseJson(row.security_report_json, []),
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function getImportedSiteAssetByPath(siteId, assetPath) {
  const normalizedPath = normalizeImportedAssetPath(assetPath)
  if (!normalizedPath) return null

  const row = await db.get(`
    SELECT * FROM public_site_import_assets
    WHERE site_id = ? AND asset_path = ?
    LIMIT 1
  `, [siteId, normalizedPath])
  if (!row) return null

  return {
    id: row.id,
    importId: row.import_id,
    siteId: row.site_id,
    assetPath: row.asset_path,
    contentType: row.content_type || getImportedAssetContentType(row.asset_path),
    content: Buffer.from(row.content_base64 || '', 'base64'),
    sizeBytes: Number(row.size_bytes || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function getImportedSiteForAsset(siteId) {
  const row = await db.get('SELECT * FROM public_sites WHERE id = ? LIMIT 1', [siteId])
  return mapSite(row)
}

export async function createImportedSiteFromHtml(input = {}) {
  const filename = cleanString(input.filename || input.name || 'pagina.html')
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  if (![...IMPORTED_HTML_EXTENSIONS, 'zip'].includes(extension)) {
    const error = new Error('Sube un archivo .html o .zip')
    error.status = 400
    throw error
  }

  const siteType = validateSiteType(input.siteType || input.site_type || 'landing_page')
  const siteId = crypto.randomUUID()
  const importId = `site_import_${crypto.randomUUID()}`

  let prepared
  if (extension === 'zip') {
    prepared = await prepareImportedZipContent({
      filename,
      fileBase64: input.fileBase64 || input.contentBase64 || input.content,
      siteId,
      importId
    })
  } else {
    const rawHtml = input.html || decodeBase64Text(input.fileBase64 || input.contentBase64 || input.content)
    const sanitized = sanitizeImportedHtml(rawHtml)
    const detectedForms = namespaceImportedPageForms(detectImportedForms(sanitized.html), '', new Set())
    prepared = {
      importType: 'html',
      rawHtml,
      sanitized: {
        html: annotateImportedEditableHtml(assignImportedFormIds(sanitized.html, detectedForms)),
        report: sanitized.report
      },
      detectedForms,
      pages: [makeImportedZipPage('', 0, getImportedHtmlTitle(sanitized.html, 'Pagina 1'))],
      assets: []
    }
  }

  const detectedForms = prepared.detectedForms
  const mappings = buildDefaultImportedFormMappings(detectedForms)
  const publicTitle = getImportedHtmlTitle(prepared.sanitized.html, input.title || filename.replace(/\.[^.]+$/, '') || 'Pagina importada')
  const publicDescription = getImportedHtmlDescription(prepared.sanitized.html, input.description || 'Pagina importada desde HTML propio')
  const slug = await ensureUniqueSlug(slugify(input.slug || publicTitle || 'pagina-importada'))
  const theme = {
    ...DEFAULT_THEME,
    template: IMPORTED_SITE_TEMPLATE,
    importedHtml: true,
    importId,
    importType: prepared.importType,
    importAssetCount: prepared.assets.length,
    pages: Array.isArray(prepared.pages) && prepared.pages.length
      ? prepared.pages
      : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
  }

  await db.run(`
    INSERT INTO public_sites (
      id, name, slug, site_type, status, domain, title, description, theme_json,
      meta_capi_enabled, meta_event_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    siteId,
    limitString(input.name || publicTitle || 'Pagina importada', 100),
    slug,
    siteType,
    publicTitle,
    publicDescription || 'Pagina importada desde HTML propio',
    jsonString(theme),
    normalizeBoolean(input.metaCapiEnabled),
    normalizeSiteMetaEventName(input.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
  ])

  await db.run(`
    INSERT INTO public_site_imports (
      id, site_id, original_filename, import_type, html_original, html_sanitized,
      detected_forms_json, form_mappings_json, security_report_json, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mapping_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    importId,
    siteId,
    filename,
    prepared.importType,
    prepared.rawHtml,
    prepared.sanitized.html,
    jsonString(detectedForms),
    jsonString(mappings),
    jsonString(prepared.sanitized.report)
  ])

  if (prepared.assets.length) {
    await replaceImportedSiteAssets(siteId, prepared.assets)
  }

  return {
    site: await getSite(siteId, { includeBlocks: true, includeSubmissions: true }),
    import: await getImportedSiteBySiteId(siteId)
  }
}

export async function updateImportedSiteFormMappings(siteId, input = {}) {
  const current = await getImportedSiteBySiteId(siteId)
  if (!current) {
    const error = new Error('Importacion no encontrada')
    error.status = 404
    throw error
  }

  const mappings = Array.isArray(input.formMappings)
    ? input.formMappings
    : Array.isArray(input.form_mappings)
      ? input.form_mappings
      : current.formMappings

  await db.run(`
    UPDATE public_site_imports SET
      form_mappings_json = ?,
      status = 'mapping_confirmed',
      updated_at = CURRENT_TIMESTAMP
    WHERE site_id = ?
  `, [
    jsonString(mappings),
    siteId
  ])

  return getImportedSiteBySiteId(siteId)
}

async function replaceImportedSiteHtml(siteId, input = {}) {
  const currentImport = await getImportedSiteBySiteId(siteId)
  if (!currentImport) {
    const error = new Error('Importacion no encontrada')
    error.status = 404
    throw error
  }

  if (currentImport.importType !== 'html') {
    const error = new Error('La edicion con IA funciona con paginas HTML de un solo archivo. Para ZIP, sube una nueva version del archivo.')
    error.status = 400
    throw error
  }

  const rawHtml = String(input.html || '').trim()
  if (!rawHtml) {
    const error = new Error('El HTML actualizado esta vacio')
    error.status = 400
    throw error
  }

  const sanitized = sanitizeImportedHtml(rawHtml)
  const detectedForms = namespaceImportedPageForms(detectImportedForms(sanitized.html), '', new Set())
  const htmlSanitized = annotateImportedEditableHtml(assignImportedFormIds(sanitized.html, detectedForms))
  const nextMappings = mergeImportedFormMappings(
    currentImport.formMappings,
    buildDefaultImportedFormMappings(detectedForms)
  )
  const publicTitle = getImportedHtmlTitle(htmlSanitized, input.title || 'Pagina importada')
  const publicDescription = getImportedHtmlDescription(htmlSanitized, input.description || '')

  await db.run(`
    UPDATE public_site_imports SET
      html_original = ?,
      html_sanitized = ?,
      detected_forms_json = ?,
      form_mappings_json = ?,
      security_report_json = ?,
      status = 'mapping_pending',
      updated_at = CURRENT_TIMESTAMP
    WHERE site_id = ?
  `, [
    rawHtml,
    htmlSanitized,
    jsonString(detectedForms),
    jsonString(nextMappings),
    jsonString(sanitized.report),
    siteId
  ])

  await db.run(`
    UPDATE public_sites SET
      title = ?,
      description = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    publicTitle,
    publicDescription || null,
    siteId
  ])

  return {
    site: await getSite(siteId, { includeBlocks: true, includeSubmissions: true }),
    import: await getImportedSiteBySiteId(siteId)
  }
}

export async function updateImportedSiteEditableContent(siteId, input = {}) {
  const currentImport = await getImportedSiteBySiteId(siteId)
  if (!currentImport) {
    const error = new Error('Importacion no encontrada')
    error.status = 404
    throw error
  }

  if (currentImport.importType !== 'html') {
    const error = new Error('La edicion rapida funciona con paginas HTML de un solo archivo. Para ZIP, sube una nueva version del archivo.')
    error.status = 400
    throw error
  }

  let updateInput = { ...input }
  if (cleanString(updateInput.fileBase64 || updateInput.file_base64)) {
    const editType = normalizeImportedEditableContentType(updateInput.editType || updateInput.edit_type)
    if (!['image', 'background_image'].includes(editType)) {
      const error = new Error('La subida de archivo solo aplica para imagenes.')
      error.status = 400
      throw error
    }
    const uploadedImageUrl = await addImportedEditableImageAsset(siteId, currentImport, updateInput)
    updateInput = {
      ...updateInput,
      value: uploadedImageUrl
    }
  }

  const currentHtml = currentImport.htmlSanitized || currentImport.htmlOriginal || ''
  const editedHtml = applyImportedEditableContentUpdate(currentHtml, updateInput)
  const sanitized = sanitizeImportedHtml(editedHtml)
  const detectedForms = namespaceImportedPageForms(detectImportedForms(sanitized.html), '', new Set())
  const htmlSanitized = annotateImportedEditableHtml(assignImportedFormIds(sanitized.html, detectedForms))
  const nextMappings = mergeImportedFormMappings(
    currentImport.formMappings,
    buildDefaultImportedFormMappings(detectedForms)
  )
  const publicTitle = getImportedHtmlTitle(htmlSanitized, 'Pagina importada')
  const publicDescription = getImportedHtmlDescription(htmlSanitized, '')

  await db.run(`
    UPDATE public_site_imports SET
      html_original = ?,
      html_sanitized = ?,
      detected_forms_json = ?,
      form_mappings_json = ?,
      security_report_json = ?,
      status = 'mapping_pending',
      updated_at = CURRENT_TIMESTAMP
    WHERE site_id = ?
  `, [
    htmlSanitized,
    htmlSanitized,
    jsonString(detectedForms),
    jsonString(nextMappings),
    jsonString(sanitized.report),
    siteId
  ])

  await db.run(`
    UPDATE public_sites SET
      title = ?,
      description = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    publicTitle,
    publicDescription || null,
    siteId
  ])

  return {
    site: await getSite(siteId, { includeBlocks: true, includeSubmissions: true }),
    import: await getImportedSiteBySiteId(siteId)
  }
}

export async function createSiteWithAIHtml(input = {}) {
  const siteKind = validateSitesAICreationKind(input.siteKind || input.site_kind)
  const messages = normalizeSitesAIMessages(input.messages)
  if (messages.length === 0) {
    return {
      status: 'needs_more_info',
      reply: siteKind === 'landing'
        ? 'Cuentame el negocio, oferta, objetivo, estilo visual, CTA y que campos quieres capturar si llevara formulario.'
        : 'Cuentame que formulario quieres, que datos debe pedir, estilo visual y que mensaje debe ver la persona al terminar.'
    }
  }

  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    const error = new Error('Primero configura la API key de OpenAI en Configuracion.')
    error.status = 409
    throw error
  }

  const agentConfig = await getAIAgentConfig({ userId: input.userId })
  const model = normalizeSitesAIModel(input.model || input.chatgptModel || input.chatgpt_model, agentConfig?.model)
  const aiPayload = await callSitesAIHtmlGenerator({
    apiKey,
    model,
    siteKind,
    messages,
    agentConfig
  })

  const status = cleanString(aiPayload?.status)
  if (status === 'needs_more_info' || !(aiPayload?.page || aiPayload?.html || aiPayload?.site)) {
    return {
      status: 'needs_more_info',
      reply: limitString(aiPayload?.reply, 1000) || 'Me falta un dato clave para armar la pagina HTML. Cuentame un poco mas del negocio, objetivo y campos.'
    }
  }

  const page = normalizeAIHtmlPagePayload(aiPayload, siteKind)
  const result = await createImportedSiteFromHtml({
    siteType: page.siteType,
    filename: page.filename,
    html: page.html,
    name: page.name,
    title: page.title,
    description: page.description || 'Pagina generada con IA desde HTML.',
    userId: input.userId,
    metaCapiEnabled: input.metaCapiEnabled,
    metaEventName: input.metaEventName
  })

  return {
    status: 'created',
    reply: limitString(aiPayload?.reply, 1000) || 'Listo, genere la pagina HTML y la importe para revisar sus formularios.',
    site: result.site,
    import: result.import
  }
}

export async function updateImportedSiteHtmlWithAI(siteId, input = {}) {
  const currentSite = await getSite(siteId, { includeBlocks: true, includeSubmissions: true })
  if (!currentSite) {
    const error = new Error('Site no encontrado')
    error.status = 404
    throw error
  }

  const currentImport = await getImportedSiteBySiteId(siteId)
  if (!currentImport) {
    const error = new Error('Importacion no encontrada')
    error.status = 404
    throw error
  }

  const siteKind = validateSitesAICreationKind(input.siteKind || input.site_kind || getSitesAIKindFromSiteType(currentSite.siteType))
  const messages = normalizeSitesAIMessages(input.messages)
  if (messages.length === 0) {
    return {
      status: 'needs_more_info',
      reply: 'Dime que quieres cambiar del HTML: titulo, imagen, orden de secciones, colores, textos o campos del formulario.'
    }
  }

  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    const error = new Error('Primero configura la API key de OpenAI en Configuracion.')
    error.status = 409
    throw error
  }

  const agentConfig = await getAIAgentConfig({ userId: input.userId })
  const model = normalizeSitesAIModel(input.model || input.chatgptModel || input.chatgpt_model, agentConfig?.model)
  const aiPayload = await callSitesAIHtmlEditor({
    apiKey,
    model,
    siteKind,
    messages,
    agentConfig,
    site: currentSite,
    importedSite: currentImport
  })

  const status = cleanString(aiPayload?.status)
  if (status === 'needs_more_info' || !(aiPayload?.page || aiPayload?.html || aiPayload?.site)) {
    return {
      status: 'needs_more_info',
      reply: limitString(aiPayload?.reply, 1000) || 'Me falta saber que cambio quieres hacer en esta pagina HTML.'
    }
  }

  const page = normalizeAIHtmlPagePayload(aiPayload, siteKind)
  const result = await replaceImportedSiteHtml(siteId, {
    html: page.html,
    title: page.title || currentSite.title,
    description: page.description || currentSite.description
  })

  return {
    status: 'updated',
    reply: limitString(aiPayload?.reply, 1000) || 'Listo, actualice el HTML y volvi a revisar los formularios.',
    site: result.site,
    import: result.import
  }
}

export async function updateSite(siteId, input = {}) {
  const current = await getSite(siteId, { includeBlocks: false })
  if (!current) return null

  const nextDomain = current.domain
  const nextStatus = input.status === undefined
    ? current.status
    : validateSiteStatus(input.status)
  const nextSiteType = input.siteType === undefined && input.site_type === undefined
    ? current.siteType
    : validateSiteType(input.siteType || input.site_type)
  const nextSlug = input.slug === undefined
    ? current.slug
    : await ensureUniqueSlug(slugify(input.slug), siteId)
  const domainChanged = false
  const nextTheme = { ...DEFAULT_THEME, ...(input.theme || current.theme || {}) }
  if (nextSiteType === 'standard_form') {
    nextTheme.pages = normalizeSitePages({ siteType: nextSiteType, theme: nextTheme })
    nextTheme.formCompletionAction = normalizeFormCompletionAction(nextTheme.formCompletionAction || nextTheme.form_completion_action, 'next_page_if_qualified')
  } else if (nextSiteType === 'interactive_form' && (!Array.isArray(nextTheme.pages) || nextTheme.pages.length === 0)) {
    nextTheme.pages = normalizeSitePages({ siteType: nextSiteType, theme: nextTheme })
  }

  await db.run(`
    UPDATE public_sites SET
      name = ?,
      slug = ?,
      site_type = ?,
      status = ?,
      domain = ?,
      title = ?,
      description = ?,
      theme_json = ?,
      meta_capi_enabled = ?,
      meta_event_name = ?,
      render_domain_verified = CASE WHEN ? THEN 0 ELSE render_domain_verified END,
      render_domain_checked_at = CASE WHEN ? THEN NULL ELSE render_domain_checked_at END,
      render_domain_error = CASE WHEN ? THEN NULL ELSE render_domain_error END,
      published_at = CASE
        WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP
        WHEN ? != 'published' THEN NULL
        ELSE published_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanString(input.name) || current.name,
    nextSlug,
    nextSiteType,
    nextStatus,
    nextDomain || null,
    Object.prototype.hasOwnProperty.call(input, 'title')
      ? cleanString(input.title)
      : current.title,
    input.description === undefined ? current.description : cleanString(input.description) || null,
    jsonString(nextTheme),
    input.metaCapiEnabled === undefined ? normalizeBoolean(current.metaCapiEnabled) : normalizeBoolean(input.metaCapiEnabled),
    normalizeSiteMetaEventName(input.metaEventName || current.metaEventName, { allowNone: true }),
    domainChanged ? 1 : 0,
    domainChanged ? 1 : 0,
    domainChanged ? 1 : 0,
    nextStatus,
    nextStatus,
    siteId
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function deleteSite(siteId) {
  const existing = await db.get('SELECT id FROM public_sites WHERE id = ?', [siteId])
  if (!existing) return false

  await db.run('DELETE FROM public_sites WHERE id = ?', [siteId])
  return true
}

export async function createBlock(siteId, input = {}) {
  const site = await getSite(siteId, { includeBlocks: false })
  if (!site) return null

  const blockType = validateBlockType(input.blockType || input.block_type)
  const last = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM public_site_blocks WHERE site_id = ?',
    [siteId]
  )
  const id = crypto.randomUUID()
  const isField = FIELD_BLOCK_TYPES.has(blockType)
  const options = Array.isArray(input.options) ? input.options : []

  await db.run(`
    INSERT INTO public_site_blocks (
      id, site_id, block_type, label, content, placeholder, required,
      options_json, settings_json, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    siteId,
    blockType,
    cleanString(input.label) || (isField ? 'Nueva pregunta' : 'Nuevo bloque'),
    cleanString(input.content),
    cleanString(input.placeholder),
    normalizeBoolean(input.required),
    jsonString(options),
    jsonString(input.settings || {}),
    Number(last?.max_order || -1) + 1
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function updateBlock(siteId, blockId, input = {}) {
  const existing = await db.get(
    'SELECT * FROM public_site_blocks WHERE id = ? AND site_id = ?',
    [blockId, siteId]
  )
  if (!existing) return null

  const blockType = input.blockType || input.block_type
    ? validateBlockType(input.blockType || input.block_type)
    : existing.block_type

  await db.run(`
    UPDATE public_site_blocks SET
      block_type = ?,
      label = ?,
      content = ?,
      placeholder = ?,
      required = ?,
      options_json = ?,
      settings_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND site_id = ?
  `, [
    blockType,
    input.label === undefined ? existing.label : cleanString(input.label),
    input.content === undefined ? existing.content : cleanString(input.content),
    input.placeholder === undefined ? existing.placeholder : cleanString(input.placeholder),
    input.required === undefined ? normalizeBoolean(existing.required) : normalizeBoolean(input.required),
    input.options === undefined ? existing.options_json : jsonString(Array.isArray(input.options) ? input.options : []),
    input.settings === undefined ? existing.settings_json : jsonString(input.settings || {}),
    blockId,
    siteId
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function deleteBlock(siteId, blockId) {
  const normalizedBlockId = cleanString(blockId)
  if (!normalizedBlockId) {
    return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
  }

  const blocks = await listSiteBlocks(siteId)
  const targetBlock = blocks.find(block => block.id === normalizedBlockId)
  const deleteIds = new Set([normalizedBlockId])

  if (isSectionBlock(targetBlock)) {
    const sectionLane = buildLandingSectionLanes(blocks).find(lane => lane.section?.id === normalizedBlockId)
    for (const block of (sectionLane?.columnBlocks || []).flat()) {
      deleteIds.add(block.id)
    }
    for (const block of blocks) {
      if (getBlockSectionId(block) === normalizedBlockId) {
        deleteIds.add(block.id)
      }
    }
  }

  const ids = [...deleteIds]
  const placeholders = ids.map(() => '?').join(', ')
  await db.run(
    `DELETE FROM public_site_blocks WHERE site_id = ? AND id IN (${placeholders})`,
    [siteId, ...ids]
  )
  await compactBlockOrder(siteId)
  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function restoreBlocks(siteId, inputBlocks = []) {
  const site = await getSite(siteId, { includeBlocks: false, includeSubmissions: false })
  if (!site) return null

  const blocks = Array.isArray(inputBlocks) ? inputBlocks : []
  if (!blocks.length) {
    return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
  }

  for (const input of blocks) {
    const id = cleanString(input.id) || crypto.randomUUID()
    const blockType = validateBlockType(input.blockType || input.block_type)
    const isField = FIELD_BLOCK_TYPES.has(blockType)
    const sortOrder = Number(input.sortOrder ?? input.sort_order)
    const existing = await db.get(
      'SELECT id FROM public_site_blocks WHERE id = ? AND site_id = ?',
      [id, siteId]
    )
    const values = [
      blockType,
      cleanString(input.label) || (isField ? 'Nueva pregunta' : 'Nuevo bloque'),
      cleanString(input.content),
      cleanString(input.placeholder),
      normalizeBoolean(input.required),
      jsonString(Array.isArray(input.options) ? input.options : []),
      jsonString(input.settings || {}),
      Number.isFinite(sortOrder) ? sortOrder : 0
    ]

    if (existing) {
      await db.run(`
        UPDATE public_site_blocks SET
          block_type = ?,
          label = ?,
          content = ?,
          placeholder = ?,
          required = ?,
          options_json = ?,
          settings_json = ?,
          sort_order = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND site_id = ?
      `, [...values, id, siteId])
      continue
    }

    await db.run(`
      INSERT INTO public_site_blocks (
        id, site_id, block_type, label, content, placeholder, required,
        options_json, settings_json, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
    `, [
      id,
      siteId,
      ...values,
      cleanString(input.createdAt || input.created_at) || null
    ])
  }

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function reorderBlocks(siteId, blockIds = [], { pageId } = {}) {
  const normalizedIds = Array.isArray(blockIds) ? blockIds.map(cleanString).filter(Boolean) : []
  const existing = await listSiteBlocks(siteId)
  const normalizedPageId = cleanString(pageId)
  const pageBlocks = normalizedPageId
    ? existing.filter(block => {
        const blockPageId = cleanString(block.settings?.pageId || block.settings?.page_id)
        return blockPageId === normalizedPageId || (!blockPageId && normalizedPageId === DEFAULT_FUNNEL_PAGE_ID)
      })
    : existing
  const existingIds = new Set(pageBlocks.map(block => block.id))
  const orderedIds = [
    ...normalizedIds.filter(id => existingIds.has(id)),
    ...pageBlocks.map(block => block.id).filter(id => !normalizedIds.includes(id))
  ]

  for (const [index, blockId] of orderedIds.entries()) {
    await db.run(
      'UPDATE public_site_blocks SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?',
      [index, blockId, siteId]
    )
  }

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

async function compactBlockOrder(siteId) {
  const blocks = await listSiteBlocks(siteId)
  for (const [index, block] of blocks.entries()) {
    await db.run(
      'UPDATE public_site_blocks SET sort_order = ? WHERE id = ? AND site_id = ?',
      [index, block.id, siteId]
    )
  }
}

function shouldRefreshDomainCheck(site, force = false) {
  if (force) return true
  if (!site?.renderDomainCheckedAt) return true

  const checkedAt = Date.parse(site.renderDomainCheckedAt)
  if (!Number.isFinite(checkedAt)) return true

  const ttl = site.renderDomainVerified ? PUBLIC_DOMAIN_CACHE_TTL_MS : PUBLIC_DOMAIN_FAILED_CACHE_TTL_MS
  return Date.now() - checkedAt > ttl
}

async function getSitesPublicDomainConfig() {
  const [rawDomain, verified, checkedAt, error] = await Promise.all([
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.domain),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.verified),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.checkedAt),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.error)
  ])
  const domain = normalizeDomain(rawDomain)

  return {
    domain,
    renderDomainVerified: Boolean(domain && cleanString(verified) === '1'),
    renderDomainCheckedAt: cleanString(checkedAt) || null,
    renderDomainError: cleanString(error) || null
  }
}

async function saveSitesPublicDomainVerification(domain, result) {
  const checkedAt = new Date().toISOString()
  const config = {
    domain,
    renderDomainVerified: Boolean(result.verified),
    renderDomainCheckedAt: checkedAt,
    renderDomainError: result.verified ? null : result.error || 'Dominio no conectado a esta app'
  }

  await Promise.all([
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.domain, domain),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.verified, result.verified ? '1' : '0'),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.checkedAt, checkedAt),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.error, config.renderDomainError)
  ])

  return config
}

export async function getSitesPublicDomain() {
  return getSitesPublicDomainConfig()
}

export async function refreshSitesPublicDomain(input = {}) {
  const current = await getSitesPublicDomainConfig()
  const hasDomainCandidate = Object.prototype.hasOwnProperty.call(input, 'domain')
  const rawDomain = hasDomainCandidate ? input.domain : current.domain
  const domain = normalizeDomain(rawDomain)

  if (hasDomainCandidate && cleanString(rawDomain) && !domain) {
    const result = { verified: false, error: 'Dominio invalido' }
    return {
      ...current,
      domain: cleanString(rawDomain),
      renderDomainVerified: false,
      renderDomainCheckedAt: new Date().toISOString(),
      renderDomainError: result.error,
      verification: result
    }
  }

  if (!domain) {
    const result = { verified: false, error: 'Configura un dominio primero' }
    return {
      ...current,
      domain: '',
      renderDomainVerified: false,
      renderDomainCheckedAt: new Date().toISOString(),
      renderDomainError: result.error,
      verification: result
    }
  }

  const result = await verifyPublicDomainConnection(domain)
  const shouldPersist = result.verified || domain === current.domain || !hasDomainCandidate
  const nextConfig = shouldPersist
    ? await saveSitesPublicDomainVerification(domain, result)
    : {
        ...current,
        domain,
        renderDomainVerified: false,
        renderDomainCheckedAt: new Date().toISOString(),
        renderDomainError: result.error
      }

  return {
    ...nextConfig,
    verification: result
  }
}

async function readDomainDns(domain) {
  const [cnamesResult, ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.resolveCname(domain),
    dns.resolve4(domain),
    dns.resolve6(domain)
  ])

  const cnames = cnamesResult.status === 'fulfilled'
    ? cnamesResult.value.map(normalizeDomain).filter(Boolean)
    : []
  const addresses = [
    ...(ipv4Result.status === 'fulfilled' ? ipv4Result.value : []),
    ...(ipv6Result.status === 'fulfilled' ? ipv6Result.value : [])
  ].filter(Boolean)

  return { cnames, addresses }
}

function getExpectedPublicDomainTargets() {
  return new Set([
    ...getRenderDefaultHosts(),
    normalizeDomain(process.env.SITES_PUBLIC_TARGET_HOST),
    normalizeDomain(process.env.PUBLIC_DOMAIN_TARGET_HOST)
  ].filter(Boolean))
}

function describeDnsSignal(dnsInfo) {
  if (!dnsInfo.cnames.length && !dnsInfo.addresses.length) {
    return 'No encuentro registros DNS publicos para ese dominio'
  }

  const expectedTargets = getExpectedPublicDomainTargets()
  const matchingTarget = dnsInfo.cnames.find(cname => expectedTargets.has(cname))
  if (matchingTarget) {
    return `DNS apunta a ${matchingTarget}, pero el dominio todavia no responde a esta app`
  }

  const renderTarget = dnsInfo.cnames.find(cname => cname.endsWith('.onrender.com'))
  if (renderTarget) {
    return `DNS apunta a ${renderTarget}, pero el dominio todavia no responde a esta app`
  }

  if (dnsInfo.cnames.length) {
    return `DNS apunta a ${dnsInfo.cnames.join(', ')}, pero no responde a esta app`
  }

  return 'DNS resuelve, pero el dominio todavia no responde a esta app'
}

async function checkDomainHealth(domain, protocol) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PUBLIC_DOMAIN_VERIFY_TIMEOUT_MS)
  const url = `${protocol}://${domain}/api/health`

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'RistakDomainVerifier/1.0'
      },
      redirect: 'follow',
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)

    if (response.ok && cleanString(payload?.status).toLowerCase() === 'ok') {
      return { ok: true, url }
    }

    return {
      ok: false,
      error: `${url} respondio ${response.status}, pero no parece ser el health de Ristak`
    }
  } catch (error) {
    return {
      ok: false,
      error: error.name === 'AbortError'
        ? `${url} no respondio a tiempo`
        : `${url} fallo: ${error.message}`
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyPublicDomainConnection(domainValue) {
  const domain = normalizeDomain(domainValue)
  if (!domain) {
    return { verified: false, error: 'Dominio invalido' }
  }

  const httpsCheck = await checkDomainHealth(domain, 'https')
  if (httpsCheck.ok) {
    return { verified: true, error: null, method: 'https_health', url: httpsCheck.url }
  }

  const httpCheck = await checkDomainHealth(domain, 'http')
  if (httpCheck.ok) {
    return { verified: true, error: null, method: 'http_health', url: httpCheck.url }
  }

  const dnsInfo = await readDomainDns(domain)
  return {
    verified: false,
    error: describeDnsSignal(dnsInfo),
    details: {
      dns: dnsInfo,
      checks: [httpsCheck.error, httpCheck.error].filter(Boolean)
    }
  }
}

function normalizePublicRouteSlug(pathValue) {
  const path = cleanString(pathValue || '/')
  const firstSegment = path
    .split('?')[0]
    .split('#')[0]
    .split('/')
    .filter(Boolean)[0] || ''
  let decoded = firstSegment

  try {
    decoded = decodeURIComponent(firstSegment)
  } catch {
    decoded = firstSegment
  }

  return cleanString(decoded)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function findSiteByRoutePath(pathValue) {
  const slug = normalizePublicRouteSlug(pathValue)
  if (!slug) return null

  const row = await db.get(
    'SELECT * FROM public_sites WHERE LOWER(slug) = LOWER(?) LIMIT 1',
    [slug]
  )

  return mapSite(row)
}

export async function resolveConnectedPublicDomainForHost(hostValue, { forceRefresh = false } = {}) {
  const host = normalizeDomain(hostValue)
  if (!host) {
    return { ok: false, status: 404, reason: 'invalid_host', message: 'Dominio invalido' }
  }

  const config = await getSitesPublicDomainConfig()
  if (!config.domain || config.domain !== host) {
    return { ok: false, status: 404, reason: 'domain_not_configured', message: 'Dominio no configurado' }
  }

  if (shouldRefreshDomainCheck(config, forceRefresh)) {
    const verification = await verifyPublicDomainConnection(config.domain)
    const nextConfig = await saveSitesPublicDomainVerification(config.domain, verification)
    config.renderDomainVerified = nextConfig.renderDomainVerified
    config.renderDomainCheckedAt = nextConfig.renderDomainCheckedAt
    config.renderDomainError = nextConfig.renderDomainError
  }

  if (!config.renderDomainVerified) {
    return {
      ok: false,
      status: 404,
      reason: 'domain_unverified',
      message: config.renderDomainError || 'Dominio no conectado a esta app',
      domainConfig: config
    }
  }

  return { ok: true, domain: config.domain, domainConfig: config, host }
}

async function hydrateEmbeddedForms(blocks = []) {
  const hydrated = []

  for (const block of blocks) {
    if (block.blockType !== 'form_embed') {
      hydrated.push(block)
      continue
    }

    const settings = block.settings || {}
    const formSiteId = cleanString(settings.formSiteId || settings.form_site_id)

    if (!formSiteId || Array.isArray(settings.embeddedBlocks)) {
      hydrated.push(block)
      continue
    }

    const embeddedSite = await getSite(formSiteId, { includeBlocks: true, includeSubmissions: false })
    const embeddedBlocks = embeddedSite?.blocks || []
    hydrated.push({
      ...block,
      settings: {
        ...settings,
        embeddedSiteId: embeddedSite?.id || formSiteId,
        embeddedSiteName: embeddedSite?.name || '',
        embeddedBlocks
      }
    })
  }

  return hydrated
}

export async function resolvePublicSiteForHost(hostValue, { forceRefresh = false, path = '/' } = {}) {
  const host = normalizeDomain(hostValue)
  if (!host) {
    return { ok: false, status: 404, reason: 'invalid_host', message: 'Dominio invalido' }
  }

  const domainResolution = await resolveConnectedPublicDomainForHost(host, { forceRefresh })
  if (!domainResolution.ok) return domainResolution

  const site = await findSiteByRoutePath(path)
  if (!site) {
    return { ok: false, status: 404, reason: 'route_not_configured', message: 'Ruta publica no configurada' }
  }

  if (site.status !== 'published') {
    return { ok: false, status: 404, reason: 'site_not_published', message: 'Este site no esta publicado', site }
  }

  site.blocks = await hydrateEmbeddedForms(await ensureSocialProfileBlock(site, await listSiteBlocks(site.id)))
  site.domain = domainResolution.domain || host
  return { ok: true, site, host, domain: domainResolution.domain || host, path }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function safeUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function safeHref(value, fallback = '#') {
  const raw = cleanString(value)
  if (!raw) return fallback
  if (raw.startsWith('#') || raw.startsWith('/')) return raw
  return safeUrl(raw) || fallback
}

function isPhoneCountrySelectorEnabled(block = {}) {
  const settings = block.settings || {}
  return settings.phoneCountrySelectorEnabled !== false &&
    settings.countrySelectorEnabled !== false &&
    settings.phoneCountrySelector !== false
}

function getPhoneCountryOption(countryCode) {
  return getCountryDefaults(countryCode)
}

function getPhoneCountryOptionByDialCode(dialCode) {
  const normalizedDialCode = cleanString(dialCode).replace(/\D/g, '')
  return COUNTRY_OPTIONS.find(country => country.dialCode === normalizedDialCode) || null
}

function renderPhoneCountryOptions(defaultCountryCode) {
  const selectedCountry = getPhoneCountryOption(defaultCountryCode)
  return COUNTRY_OPTIONS.map(country => {
    const selected = country.value === selectedCountry.value ? 'selected' : ''
    const label = `${getCountryFlagEmoji(country.value)} +${country.dialCode}`
    return `<option value="${escapeHtml(country.value)}" data-dial-code="${escapeHtml(country.dialCode)}" data-timezones="${escapeHtml((country.timezones || []).join(','))}" ${selected}>${escapeHtml(label)}</option>`
  }).join('')
}

function getPhoneDialCodeFromResponse(block, responses = {}) {
  const settings = block.settings || {}
  const rawCountryCode = cleanString(
    responses?.[`${block.id}__country`] ||
    responses?.[`${block.id}_country`] ||
    responses?.[`${block.id}Country`] ||
    settings.defaultCountryCode ||
    settings.countryCode
  ).toUpperCase()
  const rawDialCode = cleanString(
    responses?.[`${block.id}__dial_code`] ||
    responses?.[`${block.id}_dial_code`] ||
    responses?.[`${block.id}DialCode`] ||
    settings.defaultDialCode ||
    settings.dialCode
  ).replace(/\D/g, '')
  const country = rawCountryCode ? getPhoneCountryOption(rawCountryCode) : null
  const dialCountry = rawDialCode ? getPhoneCountryOptionByDialCode(rawDialCode) : null

  return rawDialCode || country?.dialCode || dialCountry?.dialCode || ''
}

function normalizePhoneResponseValue(block, rawValue, responses = {}) {
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    const number = cleanString(rawValue.number || rawValue.phone || rawValue.value)
    const dialCode = cleanString(rawValue.dialCode || rawValue.dial_code || rawValue.lada).replace(/\D/g, '') ||
      getPhoneCountryOption(rawValue.countryCode || rawValue.country || rawValue.pais)?.dialCode ||
      getPhoneDialCodeFromResponse(block, responses)
    return dialCode ? composePhoneWithDialCode(number, dialCode) : number
  }

  const value = cleanString(rawValue)
  const dialCode = getPhoneDialCodeFromResponse(block, responses)
  return dialCode ? composePhoneWithDialCode(value, dialCode) || value : value
}

const DEFAULT_EMBED_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
const EMBED_SANDBOX_URL = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_SANDBOX_HTML = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_MIN_HEIGHT = 180
const EMBED_MAX_HEIGHT = 900

function decodeHtmlAttribute(value) {
  return cleanString(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
}

function safeEmbedUrl(value) {
  const raw = decodeHtmlAttribute(value)
  if (!raw) return ''
  const candidate = raw.startsWith('//')
    ? `https:${raw}`
    : /^www\./i.test(raw)
      ? `https://${raw}`
      : raw

  return safeUrl(candidate)
}

function getIframeAttribute(iframeTag, attributeName) {
  const pattern = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(iframeTag || '').match(pattern)
  return decodeHtmlAttribute(match?.[1] || match?.[2] || match?.[3] || '')
}

function normalizeEmbedHeight(value) {
  const match = cleanString(value).match(/(\d{2,4})/)
  if (!match) return 0
  const height = Number(match[1])
  if (!Number.isFinite(height)) return 0
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, height))
}

function buildEmbedSrcDoc(html) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base target="_blank">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { padding: 0; overflow-wrap: anywhere; }
      iframe, img, video { max-width: 100%; }
      iframe { border: 0; }
    </style>
  </head>
  <body>${html}</body>
</html>`
}

function resolveEmbedContent(value) {
  const raw = cleanString(value)
  if (!raw || raw.toLowerCase() === 'embed') return { kind: 'empty' }

  const directUrl = safeEmbedUrl(raw)
  if (directUrl) {
    return { kind: 'url', src: directUrl, title: 'Embed', allow: DEFAULT_EMBED_ALLOW, height: 0 }
  }

  const iframeTag = raw.match(/<iframe\b[\s\S]*?>/i)?.[0] || ''
  if (iframeTag) {
    const iframeUrl = safeEmbedUrl(getIframeAttribute(iframeTag, 'src'))
    if (iframeUrl) {
      return {
        kind: 'url',
        src: iframeUrl,
        title: getIframeAttribute(iframeTag, 'title') || 'Embed',
        allow: getIframeAttribute(iframeTag, 'allow') || DEFAULT_EMBED_ALLOW,
        height: normalizeEmbedHeight(getIframeAttribute(iframeTag, 'height') || getIframeAttribute(iframeTag, 'style'))
      }
    }
  }

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return { kind: 'html', srcDoc: buildEmbedSrcDoc(raw), title: 'Codigo embed', allow: DEFAULT_EMBED_ALLOW, height: 0 }
  }

  return { kind: 'empty' }
}

function normalizeOption(option) {
  if (option && typeof option === 'object') {
    const label = cleanString(option.label || option.value || option.text)
    return {
      id: cleanString(option.id) || slugify(label || 'opcion'),
      label,
      value: cleanString(option.value) || label,
      action: normalizeOptionAction(option.action),
      targetBlockId: cleanString(option.targetBlockId || option.target_block_id),
      message: cleanString(option.message),
      redirectUrl: safeHref(option.redirectUrl || option.redirect_url || option.siteUrl || option.site_url || option.url || option.sitio, ''),
      tag: cleanString(option.tag),
      category: cleanString(option.category)
    }
  }

  const label = cleanString(option)
  return {
    id: slugify(label || 'opcion'),
    label,
    value: label,
    action: 'continue',
    targetBlockId: '',
    message: '',
    redirectUrl: '',
    tag: '',
    category: ''
  }
}

function getBlockOptions(block) {
  return Array.isArray(block.options)
    ? block.options.map(normalizeOption).filter(option => option.label)
    : []
}

function optionRuleAttributes(option) {
  const rule = {
    action: option.action || 'continue',
    targetBlockId: option.targetBlockId || '',
    message: option.message || '',
    redirectUrl: safeHref(option.redirectUrl, ''),
    tag: option.tag || '',
    category: option.category || ''
  }

  return `data-rule="${escapeHtml(JSON.stringify(rule))}"`
}

function getItems(settings = {}, fallback = []) {
  const items = Array.isArray(settings.items) ? settings.items : fallback
  return items
    .map(item => {
      if (item && typeof item === 'object') {
        return {
          title: cleanString(item.title || item.label || item.name),
          text: cleanString(item.text || item.content || item.description),
          author: cleanString(item.author || item.role)
        }
      }

      return { title: cleanString(item), text: '', author: '' }
    })
    .filter(item => item.title || item.text)
}

function getPanelLinks(settings = {}) {
  const links = Array.isArray(settings.panelLinks) ? settings.panelLinks : []
  return links
    .map(item => {
      if (item && typeof item === 'object') {
        return {
          label: cleanString(item.label || item.title || item.name),
          url: cleanString(item.url || item.href || '#') || '#'
        }
      }

      const [label, url] = cleanString(item).split('|').map(part => cleanString(part))
      return { label, url: url || '#' }
    })
    .filter(item => item.label)
}

function collectFieldBlocks(blocks = []) {
  const fields = []

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (FIELD_BLOCK_TYPES.has(block.blockType)) {
      fields.push(block)
      continue
    }

    if (block.blockType === 'form_embed' && Array.isArray(block.settings?.embeddedBlocks)) {
      fields.push(...collectFieldBlocks(block.settings.embeddedBlocks))
    }
  }

  return fields
}

function normalizePageList(rawPages = []) {
  const sourcePages = Array.isArray(rawPages) ? rawPages : []
  const seen = new Set()
  const pages = sourcePages
    .map((page, index) => {
      const importedAssetPath = normalizeImportedAssetPath(page?.importedAssetPath || page?.imported_asset_path)
      const importedOriginalTitle = cleanString(page?.importedOriginalTitle || page?.imported_original_title)

      return {
        id: cleanString(page?.id) || `${DEFAULT_FUNNEL_PAGE_ID}-${index + 1}`,
        title: cleanString(page?.title) || `Pagina ${index + 1}`,
        sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index,
        metaCapiEnabled: Boolean(normalizeBoolean(page?.metaCapiEnabled ?? page?.meta_capi_enabled)),
        metaEventName: normalizeSiteMetaEventName(page?.metaEventName || page?.meta_event_name, { allowNone: true, fallback: SITE_META_NO_EVENT }),
        metaTrigger: normalizeSiteMetaTrigger(page?.metaTrigger || page?.meta_trigger),
        ...(importedAssetPath ? { importedAssetPath } : {}),
        ...(importedOriginalTitle ? { importedOriginalTitle } : {})
      }
    })
    .filter(page => {
      if (!page.id || seen.has(page.id)) return false
      seen.add(page.id)
      return true
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((page, index) => ({ ...page, sortOrder: index }))

  return pages
}

function normalizeFormPages(site) {
  const pages = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
  const byId = new Map(pages.map(page => [page.id, page]))
  const defaults = getDefaultFormPages()
  const contentPages = pages.filter(page => !FORM_FINAL_PAGE_IDS.has(page.id))
  const inputPages = contentPages.length ? contentPages : [byId.get(DEFAULT_FUNNEL_PAGE_ID) || defaults[0]]
  const mergeFinalPage = (page) => {
    const existing = byId.get(page.id)
    return {
      ...page,
      title: existing?.title || page.title,
      metaCapiEnabled: Boolean(existing?.metaCapiEnabled),
      metaEventName: normalizeSiteMetaEventName(existing?.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT }),
      metaTrigger: normalizeSiteMetaTrigger(existing?.metaTrigger)
    }
  }

  return [
    ...inputPages,
    mergeFinalPage(defaults[1]),
    mergeFinalPage(defaults[2])
  ].map((page, index) => ({ ...page, sortOrder: index }))
}

function normalizeSitePages(site) {
  if (isImportedHtmlSite(site)) {
    const pages = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
    return pages.length ? pages : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
  }

  if (site?.siteType === 'standard_form') return normalizeFormPages(site)

  const pages = normalizePageList(Array.isArray(site?.theme?.pages) ? site.theme.pages : [])
  return pages.length ? pages : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
}

function getBlockPageId(block, pages) {
  const pageId = cleanString(block?.settings?.pageId || block?.settings?.page_id)
  return pages.some(page => page.id === pageId) ? pageId : pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
}

function getPageBlocks(site, pageId) {
  const blocks = Array.isArray(site?.blocks) ? site.blocks : []
  if (site?.siteType !== 'landing_page' && site?.siteType !== 'standard_form') return blocks

  const pages = normalizeSitePages(site)
  const activePage = pages.find(page => page.id === pageId) || pages[0]
  return blocks.filter(block => getBlockPageId(block, pages) === activePage.id)
}

function getStandardFormContentPages(site) {
  return normalizeSitePages(site).filter(page => !FORM_FINAL_PAGE_IDS.has(page.id))
}

function getStandardFormContentBlocks(site, blocks = []) {
  const pages = normalizeSitePages(site)
  const pageIndexes = new Map(pages.map((page, index) => [page.id, index]))
  const contentPageIds = new Set(pages.filter(page => !FORM_FINAL_PAGE_IDS.has(page.id)).map(page => page.id))

  return [...(Array.isArray(blocks) ? blocks : [])]
    .filter(block => contentPageIds.has(getBlockPageId(block, pages)))
    .sort((a, b) => {
      const pageDelta = (pageIndexes.get(getBlockPageId(a, pages)) || 0) - (pageIndexes.get(getBlockPageId(b, pages)) || 0)
      if (pageDelta !== 0) return pageDelta

      const orderDelta = Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
      if (orderDelta !== 0) return orderDelta

      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    })
}

function getDefaultFormThankYouBlocks(siteId) {
  return [
    {
      id: 'default-thank-you-title',
      siteId,
      blockType: 'title',
      label: 'Titulo',
      content: 'Gracias, recibimos tu informacion',
      placeholder: '',
      required: false,
      options: [],
      settings: { pageId: FORM_THANK_YOU_PAGE_ID },
      sortOrder: 0,
      createdAt: '',
      updatedAt: ''
    },
    {
      id: 'default-thank-you-subtitle',
      siteId,
      blockType: 'subtitle',
      label: 'Subtitulo',
      content: 'Te contactaremos pronto con el siguiente paso.',
      placeholder: '',
      required: false,
      options: [],
      settings: { pageId: FORM_THANK_YOU_PAGE_ID },
      sortOrder: 1,
      createdAt: '',
      updatedAt: ''
    }
  ]
}

function getDefaultFormDisqualifiedBlocks(siteId) {
  return [
    {
      id: 'default-disqualified-title',
      siteId,
      blockType: 'title',
      label: 'Titulo',
      content: 'Gracias por responder',
      placeholder: '',
      required: false,
      options: [],
      settings: { pageId: FORM_DISQUALIFIED_PAGE_ID },
      sortOrder: 0,
      createdAt: '',
      updatedAt: ''
    },
    {
      id: 'default-disqualified-subtitle',
      siteId,
      blockType: 'subtitle',
      label: 'Subtitulo',
      content: 'Por ahora no parece ser el siguiente paso ideal. Si algo cambia, puedes volver a intentarlo despues.',
      placeholder: '',
      required: false,
      options: [],
      settings: { pageId: FORM_DISQUALIFIED_PAGE_ID },
      sortOrder: 1,
      createdAt: '',
      updatedAt: ''
    }
  ]
}

function getInteractiveFormBlocks(site) {
  const blocks = Array.isArray(site?.blocks) ? site.blocks : []
  if (site?.siteType !== 'interactive_form') return blocks

  const pages = normalizeSitePages(site)
  const pageIndexes = new Map(pages.map((page, index) => [page.id, index]))
  return [...blocks].sort((a, b) => {
    const pageDelta = (pageIndexes.get(getBlockPageId(a, pages)) || 0) - (pageIndexes.get(getBlockPageId(b, pages)) || 0)
    if (pageDelta !== 0) return pageDelta

    const orderDelta = Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
    if (orderDelta !== 0) return orderDelta

    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  })
}

function isSectionBlock(block) {
  return block && block.blockType === 'section'
}

function isPanelBlock(block) {
  return block && (block.blockType === 'header_panel' || block.blockType === 'footer_panel')
}

function getSectionColumns(block) {
  const value = Number(block?.settings?.sectionColumns ?? block?.settings?.columns)
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, Math.round(value)))
}

function getBlockSectionId(block) {
  return cleanString(block?.settings?.sectionId || block?.settings?.section_id)
}

function getBlockSectionColumn(block) {
  const value = Number(block?.settings?.sectionColumn ?? block?.settings?.section_column)
  if (!Number.isFinite(value)) return 0
  return Math.min(2, Math.max(0, Math.round(value)))
}

function makeLandingSectionLane(section, sortOrder) {
  const columns = section ? getSectionColumns(section) : 1
  return {
    id: section?.id || '__legacy-section__',
    section,
    columns,
    columnBlocks: Array.from({ length: columns }, () => []),
    sortOrder
  }
}

function buildLandingSectionLanes(pageBlocks = []) {
  const sortedBlocks = [...pageBlocks].sort((a, b) => a.sortOrder - b.sortOrder)
  const lanes = sortedBlocks
    .filter(isSectionBlock)
    .map(block => makeLandingSectionLane(block, block.sortOrder))
  const laneById = new Map(lanes.map(lane => [lane.id, lane]))
  let legacyLane = null

  const ensureLegacyLane = () => {
    if (!legacyLane) {
      legacyLane = makeLandingSectionLane(null, -1)
      lanes.unshift(legacyLane)
    }
    return legacyLane
  }

  for (const block of sortedBlocks) {
    if (isSectionBlock(block)) continue
    if (isPanelBlock(block)) continue

    const explicitSectionId = getBlockSectionId(block)
    const explicitLane = explicitSectionId ? laneById.get(explicitSectionId) : null
    const previousLane = explicitLane || [...lanes]
      .filter(lane => lane.section && lane.sortOrder <= block.sortOrder)
      .sort((a, b) => b.sortOrder - a.sortOrder)[0]
    const lane = previousLane || ensureLegacyLane()
    const columnIndex = Math.min(lane.columns - 1, getBlockSectionColumn(block))
    lane.columnBlocks[columnIndex].push(block)
  }

  return lanes
    .filter(lane => lane.section || lane.columnBlocks.some(column => column.length > 0))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(lane => ({
      ...lane,
      columnBlocks: lane.columnBlocks.map(column => [...column].sort((a, b) => a.sortOrder - b.sortOrder))
    }))
}

function getNextPage(site, pageId) {
  const pages = normalizeSitePages(site)
  const index = pages.findIndex(page => page.id === pageId)
  return index >= 0 ? pages[index + 1] || null : pages[1] || null
}

function pageHref(pageId) {
  return `?page=${encodeURIComponent(pageId)}`
}

function getSitePage(site, pageId) {
  const pages = normalizeSitePages(site)
  const requestedPageId = cleanString(pageId)
  return pages.find(page => page.id === requestedPageId) || pages[0] || null
}

function getPageMetaConfig(site, pageId) {
  if (!site || site.siteType !== 'landing_page') return null
  const page = getSitePage(site, pageId)
  if (!page || !page.metaCapiEnabled) return null
  const eventName = normalizeSiteMetaEventName(page.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
  if (eventName === SITE_META_NO_EVENT) return null

  return {
    page,
    eventName,
    trigger: normalizeSiteMetaTrigger(page.metaTrigger)
  }
}

function getFormSubmitMetaEventName(site, pageId) {
  if (site?.siteType === 'landing_page') {
    const page = getSitePage(site, pageId)
    if (page?.metaCapiEnabled && normalizeSiteMetaTrigger(page.metaTrigger) === 'form_submit') {
      return normalizeSiteMetaEventName(page.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
    }
    return SITE_META_NO_EVENT
  }

  return normalizeSiteMetaEventName(site.metaEventName, { allowNone: true })
}

function resolveButtonHref(settings = {}, context = {}) {
  const action = cleanString(settings.buttonAction || settings.button_action || 'url')
  if (action === 'next_page') {
    const nextPage = getNextPage(context.site, context.pageId)
    if (nextPage) return pageHref(nextPage.id)
  }

  if (action === 'specific_page') {
    const pages = normalizeSitePages(context.site)
    const targetPageId = cleanString(settings.buttonPageId || settings.button_page_id)
    const targetPage = pages.find(page => page.id === targetPageId)
    if (targetPage) return pageHref(targetPage.id)
  }

  return safeHref(settings.buttonUrl, '#form')
}

function getFormCompletionAction(blocks = []) {
  const formBlock = blocks.find(block => block.blockType === 'form_embed')
  const action = cleanString(formBlock?.settings?.completionAction || formBlock?.settings?.completion_action)
  return normalizeFormCompletionAction(action, 'form_default')
}

function getNativeFormContext(site, blocks = []) {
  if (!site || site.siteType !== 'landing_page') {
    return {
      formSiteId: site?.id || null,
      formSiteName: site?.name || null
    }
  }

  const formBlock = blocks.find(block => block.blockType === 'form_embed')
  if (!formBlock) {
    return {
      formSiteId: null,
      formSiteName: null
    }
  }

  const settings = formBlock.settings || {}
  return {
    formSiteId: cleanString(settings.embeddedSiteId || settings.formSiteId || settings.form_site_id) || `${site.id}:form_embed:${formBlock.id}`,
    formSiteName: cleanString(settings.embeddedSiteName || settings.formSiteName || settings.form_site_name) || cleanString(formBlock.label) || `Formulario de ${site.name}`
  }
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function buildNativeSiteTrackingScript(context) {
  return `
  <script>
    (() => {
      const RSTK_CONTEXT = ${scriptJson(context)};
      const ENDPOINT = '/collect';

      const readJson = (storage, key) => {
        try {
          const raw = storage.getItem(key);
          return raw ? JSON.parse(raw) : {};
        } catch (_) {
          return {};
        }
      };

      const writeJson = (storage, key, value) => {
        try {
          storage.setItem(key, JSON.stringify(value));
        } catch (_) {}
      };

      const generateId = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 20; i += 1) {
          id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
      };

      const generateSessionId = () => {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
          const random = Math.random() * 16 | 0;
          const value = char === 'x' ? random : (random & 0x3 | 0x8);
          return value.toString(16);
        });
      };

      const getVisitorId = () => {
        const data = readJson(localStorage, 'ristak');
        if (!data.visitor_id) {
          data.visitor_id = generateId();
          data.first_visit = new Date().toISOString();
          writeJson(localStorage, 'ristak', data);
        }
        return data.visitor_id;
      };

      const getSessionId = () => {
        const data = readJson(sessionStorage, 'ristak');
        if (!data.session_id) {
          data.session_id = generateSessionId();
          data.session_start = Date.now();
          writeJson(sessionStorage, 'ristak', data);
        }
        return data.session_id;
      };

      const rememberContact = (contact) => {
        if (!contact || !contact.contactId) return;
        const data = readJson(localStorage, 'ristak');
        data.contact_id = contact.contactId;
        data.contact_email = contact.email || data.contact_email || null;
        data.contact_name = contact.fullName || data.contact_name || null;
        data.contact_synced_at = new Date().toISOString();
        writeJson(localStorage, 'ristak', data);
      };

      const getSavedContactId = () => {
        const data = readJson(localStorage, 'ristak');
        return data.contact_id || null;
      };

      const getParams = () => {
        const params = {};
        const searchParams = new URLSearchParams(window.location.search || '');
        searchParams.forEach((value, key) => {
          if (
            key.indexOf('utm_') === 0 ||
            ['gclid', 'fbclid', 'msclkid', 'ttclid', 'wbraid', 'gbraid', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name', 'placement', 'site_source_name', 'campaignid', 'adgroupid', 'creative', 'keyword', 'matchtype', 'network', 'device', 'target'].includes(key)
          ) {
            params[key] = value;
          }
        });
        return params;
      };

      const getFacebookCookies = () => {
        const cookies = {};
        try {
          document.cookie.split(';').forEach((part) => {
            const pieces = part.trim().split('=');
            const name = pieces[0];
            const value = pieces.slice(1).join('=');
            if (name === '_fbc') cookies.fbc = value;
            if (name === '_fbp') cookies.fbp = value;
          });
        } catch (_) {}
        return cookies;
      };

      const getDeviceType = () => {
        const ua = navigator.userAgent || '';
        if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'tablet';
        if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) return 'mobile';
        return 'desktop';
      };

      const getBrowserInfo = () => {
        const ua = navigator.userAgent || '';
        let browser = 'Unknown';
        let version = '';
        let match = null;
        if (ua.indexOf('Edg/') > -1) {
          browser = 'Edge';
          match = ua.match(/Edg\\/([\\d.]+)/);
        } else if (ua.indexOf('Chrome/') > -1 && ua.indexOf('Edg/') === -1) {
          browser = 'Chrome';
          match = ua.match(/Chrome\\/([\\d.]+)/);
        } else if (ua.indexOf('Safari/') > -1 && ua.indexOf('Chrome') === -1) {
          browser = 'Safari';
          match = ua.match(/Version\\/([\\d.]+)/);
        } else if (ua.indexOf('Firefox/') > -1) {
          browser = 'Firefox';
          match = ua.match(/Firefox\\/([\\d.]+)/);
        } else if (ua.indexOf('OPR/') > -1 || ua.indexOf('Opera/') > -1) {
          browser = 'Opera';
          match = ua.match(/(?:OPR|Opera)\\/([\\d.]+)/);
        }
        version = match ? match[1] : '';
        return { browser, browser_version: version };
      };

      const getOS = () => {
        const ua = navigator.userAgent || '';
        if (ua.indexOf('Windows NT 10.0') > -1) return 'Windows 10';
        if (ua.indexOf('Windows') > -1) return 'Windows';
        if (ua.indexOf('Mac OS X') > -1) {
          const match = ua.match(/Mac OS X ([\\d_]+)/);
          return match ? 'macOS ' + match[1].replace(/_/g, '.') : 'macOS';
        }
        if (ua.indexOf('Android') > -1) {
          const match = ua.match(/Android ([\\d.]+)/);
          return match ? 'Android ' + match[1] : 'Android';
        }
        if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) return 'iOS';
        if (ua.indexOf('Linux') > -1) return 'Linux';
        return 'Unknown';
      };

      const buildTrackingData = (extra = {}) => {
        const browserInfo = getBrowserInfo();
        return Object.assign({
          tracking_source: 'native_site',
          site_id: RSTK_CONTEXT.siteId,
          site_slug: RSTK_CONTEXT.siteSlug,
          site_name: RSTK_CONTEXT.siteName,
          site_type: RSTK_CONTEXT.siteType,
          form_site_id: RSTK_CONTEXT.formSiteId,
          form_site_name: RSTK_CONTEXT.formSiteName,
          public_page_id: RSTK_CONTEXT.pageId,
          public_page_title: RSTK_CONTEXT.pageTitle,
          url: window.location.href,
          referrer: document.referrer || null,
          title: document.title || null,
          device_type: getDeviceType(),
          browser: browserInfo.browser,
          browser_version: browserInfo.browser_version,
          os: getOS(),
          language: navigator.language || navigator.userLanguage || null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          user_agent: navigator.userAgent
        }, getParams(), getFacebookCookies(), extra);
      };

      const sendEvent = (eventName, extra = {}) => {
        const payload = {
          visitor_id: getVisitorId(),
          session_id: getSessionId(),
          contact_id: extra.contact_id || getSavedContactId(),
          event_name: eventName,
          ts: Date.now(),
          data: buildTrackingData(extra)
        };
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => {});
      };

      window.ristakNativeIdentity = () => ({ visitorId: getVisitorId(), sessionId: getSessionId() });
      window.ristakNativeBuildData = buildTrackingData;
      window.ristakNativeRememberContact = rememberContact;
      window.ristakNativeTrack = sendEvent;

      const emitView = () => sendEvent('native_site_view');
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(emitView, 0);
      } else {
        document.addEventListener('DOMContentLoaded', emitView, { once: true });
      }
    })();
  </script>`
}

const RSTK_ICONS = {
  check: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  verified: '<svg class="rstk-verified" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2.2l2.3 1.7 2.85.05.95 2.7 2.25 1.8-.95 2.75.95 2.75-2.25 1.8-.95 2.7L14.3 18.6 12 20.3l-2.3-1.7-2.85-.05-.95-2.7-2.25-1.8.95-2.75-.95-2.75 2.25-1.8.95-2.7L9.7 3.9z"/><path d="M8.4 12.3l2.4 2.4 4.8-4.9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.6" cy="6.4" r="1.25" fill="currentColor"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 17.2a3.1 3.1 0 1 1-2-2.9V5l9-2v9.2a3.1 3.1 0 1 1-2-2.9V6.6L9 7.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
}

function getItemTone(item) {
  const raw = String(item.title || item.text || '').trim()
  if (/^[+✓✔]/.test(raw)) return 'pro'
  if (/^[-–—✗✘x×]/i.test(raw)) return 'con'
  return 'neutral'
}

function stripToneMarker(value) {
  return String(value || '').replace(/^\s*[+\-–—✓✔✗✘x×]\s*/i, '').trim()
}

function blockSettingColor(settings, key) {
  return normalizeCssColor(settings && settings[key], '')
}

function blockSettingPaint(settings, key) {
  return normalizeCssPaint(settings && settings[key], '')
}

function blockSettingNumber(settings, key, min, max) {
  const value = Number(settings && settings[key])
  if (!Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

const SPACING_SIDES = ['Top', 'Right', 'Bottom', 'Left']

function makeRenderLandingSpacing(top, bottom, right = 0, left = 0) {
  return {
    blockMarginLinked: false,
    blockMarginTop: top,
    blockMarginRight: right,
    blockMarginBottom: bottom,
    blockMarginLeft: left,
    blockPaddingLinked: true,
    blockPadding: 0,
    blockPaddingTop: 0,
    blockPaddingRight: 0,
    blockPaddingBottom: 0,
    blockPaddingLeft: 0
  }
}

function getRenderLandingSpacing(blockType) {
  const spacing = {
    headline: makeRenderLandingSpacing(0, 10),
    title: makeRenderLandingSpacing(0, 10),
    subheading: makeRenderLandingSpacing(6, 14),
    subtitle: makeRenderLandingSpacing(6, 14),
    description: makeRenderLandingSpacing(6, 16),
    text: makeRenderLandingSpacing(8, 16),
    image: makeRenderLandingSpacing(16, 18),
    video: makeRenderLandingSpacing(16, 18),
    embed: makeRenderLandingSpacing(16, 18),
    calendar_embed: makeRenderLandingSpacing(16, 18),
    button: makeRenderLandingSpacing(18, 18),
    hero: makeRenderLandingSpacing(0, 0),
    benefits: makeRenderLandingSpacing(0, 0),
    testimonials: makeRenderLandingSpacing(0, 0),
    services: makeRenderLandingSpacing(0, 0),
    faq: makeRenderLandingSpacing(0, 0),
    form_embed: makeRenderLandingSpacing(18, 0),
    cta: makeRenderLandingSpacing(0, 0),
    header_panel: makeRenderLandingSpacing(0, 0),
    footer_panel: makeRenderLandingSpacing(0, 0)
  }
  return spacing[blockType] || makeRenderLandingSpacing(10, 14)
}

function isZeroSpacingValue(value) {
  if (value === undefined || value === null || value === '') return true
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric === 0
}

function normalizeLegacyLandingBlockSettings(block) {
  const settings = block?.settings || {}
  if (!block || FIELD_BLOCK_TYPES.has(block.blockType) || block.blockType === 'section' || isPanelBlock(block)) return settings
  const top = Number(settings.blockMarginTop)
  const bottom = Number(settings.blockMarginBottom)
  const hasOldVerticalMargin = top === 50 || bottom === 50
  if (!hasOldVerticalMargin) return settings
  if (!isZeroSpacingValue(settings.blockMarginRight) || !isZeroSpacingValue(settings.blockMarginLeft)) return settings
  const paddingIsZero = ['blockPadding', 'blockPaddingTop', 'blockPaddingRight', 'blockPaddingBottom', 'blockPaddingLeft']
    .every(key => isZeroSpacingValue(settings[key]))
  if (!paddingIsZero) return settings
  return {
    ...settings,
    ...getRenderLandingSpacing(block.blockType)
  }
}

function hasSpacingSideValue(settings, base) {
  return SPACING_SIDES.some(side => settings && settings[`${base}${side}`] !== undefined)
}

function blockSpacingValue(settings, base, side, fallback, min, max) {
  const sideValue = blockSettingNumber(settings, `${base}${side}`, min, max)
  if (sideValue !== null) return sideValue

  const baseValue = blockSettingNumber(settings, base, min, max)
  if (baseValue !== null) return baseValue

  return fallback
}

function blockSpacingValues(settings, base, fallback, min, max) {
  if (!settings || (settings[base] === undefined && !hasSpacingSideValue(settings, base))) return null
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = blockSpacingValue(settings, base, side, fallback, min, max)
    return acc
  }, {})
}

function spacingValuesToCss(values) {
  return SPACING_SIDES.map(side => `${values[side]}px`).join(' ')
}

function positiveSpacingValues(values) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = Math.max(0, values[side])
    return acc
  }, {})
}

function negativeSpacingValues(values) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = Math.min(0, values[side])
    return acc
  }, {})
}

function hasNegativeSpacing(values) {
  return values && SPACING_SIDES.some(side => values[side] < 0)
}

function combineSpacingValues(first, second) {
  return SPACING_SIDES.reduce((acc, side) => {
    acc[side] = (first && first[side] ? first[side] : 0) + (second && second[side] ? second[side] : 0)
    return acc
  }, {})
}

function themeNumber(theme, key, fallback, min, max) {
  const value = Number(theme && theme[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function themePaint(theme, key) {
  return normalizeCssPaint(theme && theme[key], '')
}

function blockHorizontalAlign(settings, key, fallback = 'left') {
  const value = cleanString(settings && settings[key])
  return ['left', 'center', 'right'].includes(value) ? value : fallback
}

function blockButtonAlign(settings, fallback = 'center') {
  const value = cleanString(settings && settings.buttonAlign)
  return ['left', 'center', 'right', 'full'].includes(value) ? value : fallback
}

function justifyForAlign(align) {
  if (align === 'center') return 'center'
  if (align === 'right') return 'end'
  if (align === 'full') return 'stretch'
  return 'start'
}

function marginForAlign(align) {
  if (align === 'center') return { left: 'auto', right: 'auto' }
  if (align === 'right') return { left: 'auto', right: '0' }
  return { left: '0', right: align === 'full' ? '0' : 'auto' }
}

function renderBlockStyleVars(block) {
  const settings = normalizeLegacyLandingBlockSettings(block)
  const vars = []
  const blockBg = blockSettingPaint(settings, 'blockBg')
  const blockText = blockSettingPaint(settings, 'blockText')
  const blockBorder = blockSettingPaint(settings, 'blockBorderColor')
  const buttonBg = blockSettingPaint(settings, 'buttonBg')
  const buttonText = blockSettingPaint(settings, 'buttonTextColor')
  const buttonBorder = blockSettingPaint(settings, 'buttonBorderColor')
  const cardBg = blockSettingPaint(settings, 'cardBg')
  const cardBorder = blockSettingPaint(settings, 'cardBorderColor')
  const fieldBg = blockSettingPaint(settings, 'fieldBg')
  const fieldBorder = blockSettingPaint(settings, 'fieldBorder')
  const fontFamily = cleanString(settings.fontFamily)
  const textStrokeColor = blockSettingPaint(settings, 'textStrokeColor')
  const fontSize = blockSettingNumber(settings, 'fontSize', 12, 96)
  const textStrokeWidth = blockSettingNumber(settings, 'textStrokeWidth', 0, 12)
  const contentMaxWidth = blockSettingNumber(settings, 'contentMaxWidth', 10, 120)
  const blockPaddingValues = blockSpacingValues(settings, 'blockPadding', 0, -80, 160)
  const blockMarginValues = blockSpacingValues(settings, 'blockMargin', 0, -80, 200)
  const blockPadding = blockPaddingValues ? spacingValuesToCss(positiveSpacingValues(blockPaddingValues)) : ''
  const blockMargin = blockMarginValues || hasNegativeSpacing(blockPaddingValues)
    ? spacingValuesToCss(combineSpacingValues(blockMarginValues, blockPaddingValues ? negativeSpacingValues(blockPaddingValues) : null))
    : ''
  const blockRadius = blockSettingNumber(settings, 'blockRadius', 0, 48)
  const blockBorderWidth = blockSettingNumber(settings, 'blockBorderWidth', 0, 12)
  const buttonRadius = blockSettingNumber(settings, 'buttonRadius', 0, 80)
  const buttonHeight = blockSettingNumber(settings, 'buttonHeight', 34, 88)
  const buttonPaddingX = blockSettingNumber(settings, 'buttonPaddingX', 8, 72)
  const buttonFontSize = blockSettingNumber(settings, 'buttonFontSize', 11, 32)
  const buttonBorderWidth = blockSettingNumber(settings, 'buttonBorderWidth', 0, 8)
  const mediaWidth = blockSettingNumber(settings, 'mediaWidth', 30, 100)
  const mediaRadius = blockSettingNumber(settings, 'mediaRadius', 0, 48)
  const embedHeight = blockSettingNumber(settings, 'embedHeight', EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT)
  const cardRadius = blockSettingNumber(settings, 'cardRadius', 0, 48)
  const cardBorderWidth = blockSettingNumber(settings, 'cardBorderWidth', 0, 8)
  const listColumns = blockSettingNumber(settings, 'listColumns', 1, 4)
  const fieldRadius = blockSettingNumber(settings, 'fieldRadius', 0, 32)
  const sectionGap = blockSettingNumber(settings, 'sectionGap', 0, 80)
  const blockHasNativeBorder = ['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'image', 'video', 'embed', 'calendar_embed'].includes(block.blockType)
  const supportsButton = ['hero', 'button', 'cta'].includes(block.blockType)

  if (blockBg) vars.push(`--rstk-block-bg:${blockBg}`)
  if (blockText) {
    vars.push(`--rstk-block-text:${paintFallbackColor(blockText, '#111827')}`)
    if (isCssGradient(blockText)) vars.push(`--rstk-block-text-paint:${blockText}`)
  }
  if (blockBorder) vars.push(`--rstk-block-border:${paintFallbackColor(blockBorder, '#dbe3ef')}`)
  if (buttonBg) {
    vars.push(`--rstk-button-bg:${buttonBg}`)
    vars.push(`--rstk-button-hover-bg:${buttonBg}`)
  }
  if (buttonText) {
    vars.push(`--rstk-button-text:${paintFallbackColor(buttonText, '#ffffff')}`)
    if (isCssGradient(buttonText)) vars.push(`--rstk-button-text-paint:${buttonText}`)
  }
  if (buttonBorder) vars.push(`--rstk-button-border:${paintFallbackColor(buttonBorder, '#111827')}`)
  if (cardBg) vars.push(`--rstk-card-bg:${cardBg}`)
  if (cardBorder) vars.push(`--rstk-card-border:${paintFallbackColor(cardBorder, '#dbe3ef')}`)
  if (fieldBg) vars.push(`--rstk-field-bg:${fieldBg}`)
  if (fieldBorder) vars.push(`--rstk-field-border:${paintFallbackColor(fieldBorder, '#dbe3ef')}`)
  if (fontFamily) vars.push(`--rstk-block-font:${fontFamily.replace(/[;"{}<>]/g, '')}`)
  if (settings.fontStyle === 'italic') vars.push('--rstk-block-font-style:italic')
  if (settings.textDecoration === 'underline') vars.push('--rstk-block-text-decoration:underline')
  if (textStrokeWidth !== null) vars.push(`--rstk-text-stroke-width:${textStrokeWidth}px`)
  if (textStrokeColor) vars.push(`--rstk-text-stroke-color:${paintFallbackColor(textStrokeColor, '#111827')}`)
  if (settings.fontWeight === 'bold') vars.push('--rstk-block-weight:850')
  if (settings.fontWeight === 'normal') vars.push('--rstk-block-weight:400')
  if (settings.textAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'textAlign', 'left')
    const margins = marginForAlign(align)
    vars.push(`--rstk-block-align:${align}`)
    vars.push(`--rstk-block-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-content-margin-left:${margins.left}`)
    vars.push(`--rstk-content-margin-right:${margins.right}`)
  }
  if (fontSize !== null) vars.push(`--rstk-block-size:${fontSize}px`)
  if (contentMaxWidth !== null) vars.push(`--rstk-content-max:${contentMaxWidth}ch`)
  if (blockPadding) vars.push(`--rstk-block-pad:${blockPadding}`)
  if (blockMargin) vars.push(`--rstk-block-margin:${blockMargin}`)
  if (blockRadius !== null) vars.push(`--rstk-block-radius:${blockRadius}px`)
  if (blockBorderWidth !== null) {
    vars.push(`--rstk-block-border-width:${blockBorderWidth}px`)
    if (!blockHasNativeBorder) vars.push(`--rstk-block-shell-border-width:${blockBorderWidth}px`)
  }
  if (supportsButton) {
    const align = blockButtonAlign(settings, 'center')
    const margins = marginForAlign(align)
    vars.push(`--rstk-button-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-button-margin-left:${margins.left}`)
    vars.push(`--rstk-button-margin-right:${margins.right}`)
    vars.push(`--rstk-button-width:${align === 'full' ? '100%' : 'fit-content'}`)
  }
  if (buttonRadius !== null) vars.push(`--rstk-block-button-radius:${buttonRadius}px`)
  if (buttonHeight !== null) vars.push(`--rstk-button-height:${buttonHeight}px`)
  if (buttonPaddingX !== null) vars.push(`--rstk-button-pad-x:${buttonPaddingX}px`)
  if (buttonFontSize !== null) vars.push(`--rstk-button-size:${buttonFontSize}px`)
  if (buttonBorderWidth !== null) vars.push(`--rstk-button-border-width:${buttonBorderWidth}px`)
  if (mediaWidth !== null) vars.push(`--rstk-media-width:${mediaWidth}%`)
  if (settings.mediaAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'mediaAlign', 'center')
    const margins = marginForAlign(align)
    vars.push(`--rstk-media-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-media-margin-left:${margins.left}`)
    vars.push(`--rstk-media-margin-right:${margins.right}`)
  }
  if (mediaRadius !== null) vars.push(`--rstk-media-radius:${mediaRadius}px`)
  if (embedHeight !== null) vars.push(`--rstk-embed-height:${embedHeight}px`)
  if (cardRadius !== null) vars.push(`--rstk-card-radius:${cardRadius}px`)
  if (cardBorderWidth !== null) vars.push(`--rstk-card-border-width:${cardBorderWidth}px`)
  if (listColumns !== null) vars.push(`--rstk-list-columns:repeat(${listColumns},minmax(0,1fr))`)
  if (settings.cardAlign !== undefined) vars.push(`--rstk-card-align:${blockHorizontalAlign(settings, 'cardAlign', 'left')}`)
  if (fieldRadius !== null) vars.push(`--rstk-field-radius:${fieldRadius}px`)
  if (block.blockType === 'section') {
    vars.push(`--rstk-section-columns:${getSectionColumns(block)}`)
    if (sectionGap !== null) vars.push(`--rstk-section-gap:${sectionGap}px`)
  }

  return vars.length ? ` style="${escapeHtml(vars.join(';'))}"` : ''
}

function renderBlockStyleClassName(block) {
  const settings = block.settings || {}
  const classes = [
    'rstk-block-style',
    block.blockType === 'header_panel' ? 'rstkHeaderPanelBlock' : '',
    block.blockType === 'footer_panel' ? 'rstkFooterPanelBlock' : '',
    cleanString(settings.blockText) ? 'rstkBlockTextOverride' : '',
    isCssGradient(settings.blockText) ? 'rstkTextGradient' : '',
    isCssGradient(settings.buttonTextColor) ? 'rstkButtonTextGradient' : '',
    cleanString(settings.fontFamily) ? 'rstkFontOverride' : '',
    settings.fontSize !== undefined ? 'rstkSizeOverride' : '',
    settings.fontWeight === 'bold' || settings.fontWeight === 'normal' ? 'rstkWeightOverride' : '',
    settings.fontStyle === 'italic' ? 'rstkItalicOverride' : '',
    settings.textDecoration === 'underline' ? 'rstkUnderlineOverride' : '',
    settings.textStrokeWidth !== undefined ? 'rstkStrokeOverride' : ''
  ].filter(Boolean)

  return classes.join(' ')
}

function wrapRenderedBlock(block, html) {
  const style = renderBlockStyleVars(block)
  const className = renderBlockStyleClassName(block)
  return style ? `<div class="${escapeHtml(className)}"${style}>${html}</div>` : html
}

function renderPublicBlock(block, context = {}) {
  const pages = Array.isArray(context.pages) ? context.pages : normalizeSitePages(context.site)
  const blockPageId = context.isInteractive || context.isStandardForm ? getBlockPageId(block, pages) : ''
  const html = FIELD_BLOCK_TYPES.has(block.blockType)
    ? renderFieldBlock(block, false, blockPageId, context)
    : renderContentBlock(block, context)
  const rendered = wrapRenderedBlock(block, html)

  if (context.isInteractive) {
    return `<div class="rstk-interactive-page-content" data-interactive-page-content="${escapeHtml(blockPageId)}">${rendered}</div>`
  }

  return rendered
}

function renderLandingSectionLane(lane, context = {}) {
  const columnsHtml = lane.columnBlocks.map((columnBlocks, index) => `
    <div class="rstk-section-column" data-section-column="${index}">
      ${columnBlocks.map(block => renderPublicBlock(block, context)).join('\n')}
    </div>
  `).join('\n')

  if (!lane.section) {
    return `
      <section class="rstk-section-lane rstk-section-lane-legacy">
        <div class="rstk-section-inner">
          <div class="rstk-section-columns">
            ${columnsHtml}
          </div>
        </div>
      </section>
    `
  }

  const section = lane.section
  const settings = section.settings || {}
  const style = renderBlockStyleVars(section)
  const className = `${renderBlockStyleClassName(section)} rstk-section-lane`
  const hasHeading = cleanString(section.content) || cleanString(settings.subtitle)
  const heading = hasHeading
    ? `
      <div class="rstk-section-heading">
        ${cleanString(section.content) ? `<h2>${escapeHtml(section.content)}</h2>` : ''}
        ${cleanString(settings.subtitle) ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
      </div>
    `
    : ''

  return `
    <section class="${escapeHtml(className)}"${style}>
      <div class="rstk-section-inner">
        ${heading}
        <div class="rstk-section-columns">
          ${columnsHtml}
        </div>
      </div>
    </section>
  `
}

function renderLandingBlocks(blocks = [], context = {}) {
  const sortedBlocks = [...blocks].sort((a, b) => a.sortOrder - b.sortOrder)
  const lanes = buildLandingSectionLanes(sortedBlocks)
  const laneBySectionId = new Map(lanes.filter(lane => lane.section).map(lane => [lane.section.id, lane]))
  const legacyLane = lanes.find(lane => !lane.section)
  const legacyBlockIds = new Set((legacyLane?.columnBlocks || []).flat().map(block => block.id))
  let legacyRendered = false

  const html = sortedBlocks.map(block => {
    if (isPanelBlock(block)) {
      return renderPublicBlock(block, context)
    }

    if (isSectionBlock(block)) {
      const lane = laneBySectionId.get(block.id)
      return lane ? renderLandingSectionLane(lane, context) : ''
    }

    if (legacyLane && !legacyRendered && legacyBlockIds.has(block.id)) {
      legacyRendered = true
      return renderLandingSectionLane(legacyLane, context)
    }

    return ''
  }).filter(Boolean)

  if (legacyLane && !legacyRendered) {
    html.push(renderLandingSectionLane(legacyLane, context))
  }

  return html.join('\n')
}

function renderSubmitButtonContent(label, subtitle = '') {
  const safeLabel = escapeHtml(cleanString(label) || 'Enviar')
  const safeSubtitle = escapeHtml(cleanString(subtitle))
  return `<span class="rstk-button-label">${safeLabel}</span>${safeSubtitle ? `<span class="rstk-button-subtitle">${safeSubtitle}</span>` : ''}`
}

function renderContentBlock(block, context = {}) {
  const content = escapeHtml(block.content)
  const settings = block.settings || {}

  if (block.blockType === 'header_panel' || block.blockType === 'footer_panel') {
    const isHeader = block.blockType === 'header_panel'
    const links = getPanelLinks(settings)
    const copy = content || (isHeader ? escapeHtml(block.label || 'Tu marca') : 'Tu informacion esta protegida.')
    return `
      <div class="rstk-site-panel ${isHeader ? 'rstk-site-panel-header' : 'rstk-site-panel-footer'}">
        ${isHeader ? `<strong class="rstk-site-panel-copy">${copy}</strong>` : `<p class="rstk-site-panel-copy">${copy}</p>`}
        ${links.length ? `
          <nav class="rstk-site-panel-links" aria-label="${isHeader ? 'Enlaces superiores' : 'Enlaces inferiores'}">
            ${links.map(link => `<a href="${escapeHtml(safeHref(link.url, '#'))}">${escapeHtml(link.label)}</a>`).join('')}
          </nav>
        ` : ''}
      </div>
    `
  }

  if (block.blockType === 'social_profile') {
    return renderSocialProfileBlock(block, context)
  }

  if (block.blockType === 'headline' || block.blockType === 'title') {
    return `<h1 class="rstk-headline">${content || escapeHtml(block.label)}</h1>`
  }

  if (block.blockType === 'section') {
    return `
      <section class="rstk-section-break">
        <h2>${content || escapeHtml(block.label || 'Nueva seccion')}</h2>
        ${settings.subtitle ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
      </section>
    `
  }

  if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') {
    return `<p class="rstk-subheading">${content || escapeHtml(block.label)}</p>`
  }

  if (block.blockType === 'hero') {
    const buttonUrl = resolveButtonHref(settings, context)
    return `
      <section class="rstk-hero">
        ${settings.kicker ? `<p class="rstk-kicker">${escapeHtml(settings.kicker)}</p>` : ''}
        <h1 class="rstk-headline">${content || escapeHtml(block.label)}</h1>
        ${settings.subtitle ? `<p class="rstk-subheading">${escapeHtml(settings.subtitle)}</p>` : ''}
        ${settings.buttonText ? `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}"><span class="rstk-button-label">${escapeHtml(settings.buttonText)}</span></a>` : ''}
      </section>
    `
  }

  if (block.blockType === 'image') {
    const imageUrl = safeUrl(settings.mediaUrl || block.content)
    return imageUrl
      ? `<figure class="rstk-media"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(block.label || 'Imagen')}" loading="lazy"></figure>`
      : `<div class="rstk-media rstk-media-empty">Imagen sin URL</div>`
  }

  if (block.blockType === 'video') {
    const videoUrl = safeUrl(settings.mediaUrl || block.content)
    return videoUrl
      ? `<div class="rstk-video"><iframe src="${escapeHtml(videoUrl)}" loading="lazy" allowfullscreen sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>`
      : `<div class="rstk-media rstk-media-empty"><span class="rstk-play">${RSTK_ICONS.play}</span>Agrega la URL del video</div>`
  }

  if (block.blockType === 'button') {
    const buttonUrl = resolveButtonHref(settings, context)
    return `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}"><span class="rstk-button-label">${escapeHtml(settings.buttonText || block.content || block.label || 'Continuar')}</span></a>`
  }

  if (block.blockType === 'benefits') {
    const items = getItems(settings)
    const heading = content || escapeHtml(block.label)
    return `
      <section class="rstk-section-list rstk-checklist">
        ${heading ? `<h2>${heading}</h2>` : ''}
        <ul class="rstk-check-list">
          ${items.map(item => {
            const tone = getItemTone(item)
            const icon = tone === 'con' ? RSTK_ICONS.cross : RSTK_ICONS.check
            const title = escapeHtml(stripToneMarker(item.title))
            const text = escapeHtml(stripToneMarker(item.text))
            return `
              <li class="rstk-check rstk-check-${tone}">
                <span class="rstk-check-icon" aria-hidden="true">${icon}</span>
                <span class="rstk-check-body">
                  ${title ? `<strong>${title}</strong>` : ''}
                  ${text ? `<span>${text}</span>` : ''}
                </span>
              </li>
            `
          }).join('')}
        </ul>
      </section>
    `
  }

  if (['testimonials', 'services', 'faq'].includes(block.blockType)) {
    const items = getItems(settings)
    return `
      <section class="rstk-section-list">
        <h2>${content || escapeHtml(block.label)}</h2>
        <div class="rstk-list-grid">
          ${items.map(item => `
            <article>
              ${item.title ? `<strong>${escapeHtml(item.title)}</strong>` : ''}
              ${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}
              ${item.author ? `<small>${escapeHtml(item.author)}</small>` : ''}
            </article>
          `).join('')}
        </div>
      </section>
    `
  }

  if (block.blockType === 'form_embed') {
    const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks : []
    const fields = collectFieldBlocks(embeddedBlocks)
    const submitButtonContent = renderSubmitButtonContent(context.submitText, context.submitSubtitle)
    return `
      <section class="rstk-embedded-form" id="form">
        <h2>${content || escapeHtml(block.label || 'Formulario')}</h2>
        ${settings.description ? `<p class="rstk-help">${escapeHtml(settings.description)}</p>` : ''}
        ${fields.length
          ? fields.map(field => renderFieldBlock(field, false, '', context)).join('\n')
          : '<p class="rstk-help">Selecciona o crea un formulario embebido para capturar respuestas.</p>'}
        ${fields.length ? `
          <div class="rstk-actions rstk-embed-actions">
            <button type="submit" data-submit>${submitButtonContent}</button>
          </div>
          <p class="rstk-submit-message" data-message role="status"></p>
        ` : ''}
      </section>
    `
  }

  if (block.blockType === 'cta') {
    const buttonUrl = resolveButtonHref(settings, context)
    return `
      <section class="rstk-cta">
        <h2>${content || escapeHtml(block.label)}</h2>
        ${settings.subtitle ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
        ${settings.buttonText ? `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}"><span class="rstk-button-label">${escapeHtml(settings.buttonText)}</span></a>` : ''}
      </section>
    `
  }

  if (block.blockType === 'calendar_embed') {
    const calendarSlug = cleanString(settings.calendarSlug || settings.calendar_slug || block.content)
    if (!calendarSlug) {
      return `<div class="rstk-embed rstk-embed-empty">Selecciona un calendario para embeber</div>`
    }

    const calendarName = cleanString(settings.calendarName || settings.calendar_name || block.label || 'Calendario')
    return `<iframe class="rstk-embed rstk-calendar-embed" src="/calendar/${encodeURIComponent(calendarSlug)}?test=1" title="${escapeHtml(calendarName)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`
  }

  if (block.blockType === 'embed') {
    const embed = resolveEmbedContent(block.content)
    if (embed.kind === 'empty') {
      return `<div class="rstk-embed rstk-embed-empty">Pega una URL, iframe o codigo embed/html</div>`
    }

    const heightStyle = embed.height ? ` style="min-height:${embed.height}px"` : ''
    if (embed.kind === 'url') {
      return `<iframe class="rstk-embed" src="${escapeHtml(embed.src)}" title="${escapeHtml(embed.title)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="${EMBED_SANDBOX_URL}" allow="${escapeHtml(embed.allow || DEFAULT_EMBED_ALLOW)}" allowfullscreen${heightStyle}></iframe>`
    }

    return `<iframe class="rstk-embed rstk-embed-code" srcdoc="${escapeHtml(embed.srcDoc)}" title="${escapeHtml(embed.title)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="${EMBED_SANDBOX_HTML}" allow="${escapeHtml(embed.allow || DEFAULT_EMBED_ALLOW)}"${heightStyle}></iframe>`
  }

  return `<div class="rstk-text">${content.replace(/\n/g, '<br>')}</div>`
}

function renderFieldInput(block, context = {}) {
  const id = escapeHtml(block.id)
  const placeholder = escapeHtml(block.placeholder)
  const required = block.required ? 'required' : ''
  const options = getBlockOptions(block)
  const settings = block.settings || {}

  if (block.blockType === 'paragraph') {
    return `<textarea id="${id}" name="${id}" rows="5" placeholder="${placeholder}" ${required}></textarea>`
  }

  if (block.blockType === 'currency') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${placeholder || '0.00'}" ${required}>`
  }

  if (block.blockType === 'number') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'email') {
    return `<input id="${id}" name="${id}" type="email" inputmode="email" autocomplete="email" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'phone') {
    if (isPhoneCountrySelectorEnabled(block)) {
      const defaultCountryCode = cleanString(
        settings.defaultCountryCode ||
        settings.countryCode ||
        context.phoneLocale?.countryCode ||
        'MX'
      ).toUpperCase()
      return `
        <div class="rstk-phone-input" data-phone-country-field>
          <select id="${id}__country" name="${id}__country" data-phone-country-select aria-label="Pais y lada">
            ${renderPhoneCountryOptions(defaultCountryCode)}
          </select>
          <input id="${id}" name="${id}" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="${placeholder || 'Numero'}" data-phone-number-input ${required}>
        </div>
      `
    }

    return `<input id="${id}" name="${id}" type="tel" inputmode="tel" autocomplete="tel" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'date') {
    return `<input id="${id}" name="${id}" type="date" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'dropdown') {
    return `
      <select id="${id}" name="${id}" ${required}>
        <option value="">Selecciona una opcion</option>
        ${options.map(option => `<option value="${escapeHtml(option.value)}" ${optionRuleAttributes(option)}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    `
  }

  if (block.blockType === 'radio') {
    return `
      <div class="rstk-options">
        ${options.map((option, index) => `
          <label class="rstk-option">
            <input type="radio" name="${id}" value="${escapeHtml(option.value)}" ${required && index === 0 ? 'required' : ''} ${optionRuleAttributes(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }

  if (block.blockType === 'checkboxes') {
    return `
      <div class="rstk-options">
        ${options.map(option => `
          <label class="rstk-option">
            <input type="checkbox" name="${id}" value="${escapeHtml(option.value)}" data-checkbox-group="${id}" ${optionRuleAttributes(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }

  return `<input id="${id}" name="${id}" type="text" placeholder="${placeholder}" ${required}>`
}

function renderFieldBlock(block, _interactive = false, pageId = '', context = {}) {
  const label = escapeHtml(block.label || 'Pregunta')
  const required = block.required ? '<span class="rstk-required">*</span>' : ''

  return `
    <section class="rstk-field" data-block-id="${escapeHtml(block.id)}" data-page-id="${escapeHtml(pageId)}" data-required="${block.required ? 'true' : 'false'}" data-field-type="${escapeHtml(block.blockType)}">
      <label for="${escapeHtml(block.id)}">${label}${required}</label>
      ${block.content ? `<p class="rstk-help">${escapeHtml(block.content)}</p>` : ''}
      ${renderFieldInput(block, context)}
      <p class="rstk-error" hidden>Esta respuesta es requerida.</p>
    </section>
  `
}

const RSTK_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif"

const SITE_TEMPLATES = {
  ristak: {
    id: 'ristak',
    label: 'Ristak minimal',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f5f6f8',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '12px',
      radiusLg: '18px',
      shadow: '0 30px 60px -42px rgba(15,23,42,.4)',
      headingWeight: '800',
      btnRadius: '12px',
      btnWeight: '750'
    }
  },

  executive: {
    id: 'executive',
    label: 'Corporativo claro',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f8fafc',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#475569',
      surface: '#ffffff',
      surface2: '#ecfeff',
      border: '#cbd5e1',
      accent: '#0f766e',
      accentStrong: '#115e59',
      onAccent: '#ffffff',
      ring: 'rgba(15,118,110,.18)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#cbd5e1',
      radius: '10px',
      radiusLg: '18px',
      shadow: '0 28px 70px -46px rgba(15,23,42,.42)',
      headingWeight: '800',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  launch: {
    id: 'launch',
    label: 'Lanzamiento',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#1f2937',
      muted: '#7c2d12',
      surface: '#ffffff',
      surface2: '#ffedd5',
      border: '#fed7aa',
      accent: '#ea580c',
      accentStrong: '#c2410c',
      onAccent: '#ffffff',
      ring: 'rgba(234,88,12,.2)',
      inputBg: '#ffffff',
      inputInk: '#1f2937',
      inputBorder: '#fdba74',
      radius: '14px',
      radiusLg: '22px',
      shadow: '0 32px 72px -46px rgba(124,45,18,.45)',
      headingWeight: '850',
      btnRadius: '999px',
      btnWeight: '850'
    }
  },

  premium: {
    id: 'premium',
    label: 'Premium sobrio',
    mode: 'dark',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#101010',
      pageImage: 'none',
      ink: '#f8fafc',
      muted: '#a1a1aa',
      surface: '#18181b',
      surface2: '#222225',
      border: 'rgba(255,255,255,.14)',
      accent: '#d4af37',
      accentStrong: '#b88916',
      onAccent: '#121212',
      ring: 'rgba(212,175,55,.26)',
      inputBg: '#202023',
      inputInk: '#f8fafc',
      inputBorder: 'rgba(255,255,255,.16)',
      radius: '8px',
      radiusLg: '18px',
      shadow: '0 48px 90px -52px rgba(0,0,0,.9)',
      headingWeight: '850',
      btnRadius: '8px',
      btnWeight: '850'
    }
  },

  local: {
    id: 'local',
    label: 'Negocio local',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f0fdf4',
      pageImage: 'none',
      ink: '#14532d',
      muted: '#4b5563',
      surface: '#ffffff',
      surface2: '#dcfce7',
      border: '#bbf7d0',
      accent: '#15803d',
      accentStrong: '#166534',
      onAccent: '#ffffff',
      ring: 'rgba(21,128,61,.2)',
      inputBg: '#ffffff',
      inputInk: '#14532d',
      inputBorder: '#86efac',
      radius: '16px',
      radiusLg: '24px',
      shadow: '0 30px 70px -46px rgba(20,83,45,.38)',
      headingWeight: '800',
      btnRadius: '16px',
      btnWeight: '800'
    }
  },

  compact: {
    id: 'compact',
    label: 'Formulario compacto',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f8fafc',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f1f5f9',
      border: '#dbe3ef',
      accent: '#2563eb',
      accentStrong: '#1d4ed8',
      onAccent: '#ffffff',
      ring: 'rgba(37,99,235,.18)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#cbd5e1',
      radius: '8px',
      radiusLg: '18px',
      shadow: '0 24px 54px -40px rgba(15,23,42,.35)',
      headingWeight: '800',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  event: {
    id: 'event',
    label: 'Registro simple',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fdf2f8',
      pageImage: 'none',
      ink: '#500724',
      muted: '#831843',
      surface: '#ffffff',
      surface2: '#fce7f3',
      border: '#fbcfe8',
      accent: '#be123c',
      accentStrong: '#9f1239',
      onAccent: '#ffffff',
      ring: 'rgba(190,18,60,.2)',
      inputBg: '#ffffff',
      inputInk: '#500724',
      inputBorder: '#f9a8d4',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 30px 68px -44px rgba(131,24,67,.42)',
      headingWeight: '850',
      btnRadius: '999px',
      btnWeight: '850'
    }
  },

  quote: {
    id: 'quote',
    label: 'Cotizacion rapida',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f5f3ff',
      pageImage: 'none',
      ink: '#2e1065',
      muted: '#6d28d9',
      surface: '#ffffff',
      surface2: '#ede9fe',
      border: '#ddd6fe',
      accent: '#7c3aed',
      accentStrong: '#6d28d9',
      onAccent: '#ffffff',
      ring: 'rgba(124,58,237,.2)',
      inputBg: '#ffffff',
      inputInk: '#2e1065',
      inputBorder: '#c4b5fd',
      radius: '12px',
      radiusLg: '22px',
      shadow: '0 30px 68px -44px rgba(76,29,149,.4)',
      headingWeight: '850',
      btnRadius: '14px',
      btnWeight: '850'
    }
  },

  callback: {
    id: 'callback',
    label: 'Llamada consultiva',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#ecfeff',
      pageImage: 'none',
      ink: '#164e63',
      muted: '#0e7490',
      surface: '#ffffff',
      surface2: '#cffafe',
      border: '#a5f3fc',
      accent: '#0e7490',
      accentStrong: '#155e75',
      onAccent: '#ffffff',
      ring: 'rgba(14,116,144,.2)',
      inputBg: '#ffffff',
      inputInk: '#164e63',
      inputBorder: '#67e8f9',
      radius: '10px',
      radiusLg: '18px',
      shadow: '0 28px 64px -42px rgba(22,78,99,.38)',
      headingWeight: '800',
      btnRadius: '10px',
      btnWeight: '850'
    }
  },

  waitlist: {
    id: 'waitlist',
    label: 'Lista de espera',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#fff7ed',
      pageImage: 'none',
      ink: '#7c2d12',
      muted: '#9a3412',
      surface: '#ffffff',
      surface2: '#ffedd5',
      border: '#fed7aa',
      accent: '#c2410c',
      accentStrong: '#9a3412',
      onAccent: '#ffffff',
      ring: 'rgba(194,65,12,.2)',
      inputBg: '#ffffff',
      inputInk: '#7c2d12',
      inputBorder: '#fdba74',
      radius: '16px',
      radiusLg: '28px',
      shadow: '0 30px 68px -44px rgba(124,45,18,.42)',
      headingWeight: '850',
      btnRadius: '999px',
      btnWeight: '850'
    }
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook',
    mode: 'light',
    chrome: 'facebook',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f0f2f5',
      pageImage: 'none',
      ink: '#1c1e21',
      muted: '#65676b',
      surface: '#ffffff',
      surface2: '#f7f8fa',
      border: '#ced0d4',
      accent: '#1877f2',
      accentStrong: '#166fe5',
      onAccent: '#ffffff',
      ring: 'rgba(24,119,242,.22)',
      inputBg: '#ffffff',
      inputInk: '#1c1e21',
      inputBorder: '#ccd0d5',
      radius: '8px',
      radiusLg: '12px',
      shadow: '0 1px 2px rgba(0,0,0,.1), 0 22px 48px -34px rgba(0,0,0,.5)',
      headingWeight: '800',
      btnRadius: '8px',
      btnWeight: '800'
    }
  },

  instagram: {
    id: 'instagram',
    label: 'Instagram',
    mode: 'light',
    chrome: 'instagram',
    font: RSTK_SANS,
    gradient: 'linear-gradient(45deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)',
    vars: {
      pageBg: '#fafafa',
      pageImage: 'none',
      ink: '#262626',
      muted: '#8e8e8e',
      surface: '#ffffff',
      surface2: '#fafafa',
      border: '#dbdbdb',
      accent: '#0095f6',
      accentStrong: '#1877f2',
      onAccent: '#ffffff',
      ring: 'rgba(0,149,246,.2)',
      inputBg: '#ffffff',
      inputInk: '#262626',
      inputBorder: '#dbdbdb',
      radius: '12px',
      radiusLg: '16px',
      shadow: '0 24px 54px -38px rgba(0,0,0,.45)',
      headingWeight: '800',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    mode: 'dark',
    chrome: 'tiktok',
    font: RSTK_SANS,
    cyan: '#25f4ee',
    vars: {
      pageBg: '#000000',
      pageImage: 'none',
      ink: '#ffffff',
      muted: '#a1a1aa',
      surface: '#161616',
      surface2: '#1f1f1f',
      border: 'rgba(255,255,255,.12)',
      accent: '#fe2c55',
      accentStrong: '#ef1f49',
      onAccent: '#ffffff',
      ring: 'rgba(254,44,85,.32)',
      inputBg: '#1f1f1f',
      inputInk: '#ffffff',
      inputBorder: 'rgba(255,255,255,.16)',
      radius: '10px',
      radiusLg: '18px',
      shadow: '0 36px 70px -42px rgba(0,0,0,.9)',
      headingWeight: '900',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  vsl: {
    id: 'vsl',
    label: 'Carta de ventas (VSL)',
    mode: 'light',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '14px',
      radiusLg: '22px',
      shadow: '0 50px 90px -46px rgba(0,0,0,.75)',
      headingWeight: '800',
      btnRadius: '14px',
      btnWeight: '800'
    }
  },

  interactive: {
    id: 'interactive',
    label: 'Interactivo',
    mode: 'light',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f6f7f9',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.14)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 60px 100px -52px rgba(0,0,0,.8)',
      headingWeight: '800',
      btnRadius: '14px',
      btnWeight: '800'
    }
  }
}

function resolveTemplate(site) {
  const id = cleanString(site && site.theme && site.theme.template)
  if (id && SITE_TEMPLATES[id]) return SITE_TEMPLATES[id]
  if (site && site.siteType === 'interactive_form') return SITE_TEMPLATES.interactive
  return SITE_TEMPLATES.ristak
}

function getBrand(site, template) {
  const theme = (site && site.theme) || {}
  const name = cleanString(theme.brandName) || cleanString(site && site.title) || cleanString(site && site.name) || 'Tu marca'
  const subtitleDefault = template.chrome === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'
  const subtitle = cleanString(theme.brandSubtitle) || subtitleDefault
  const avatarUrl = safeUrl(theme.brandAvatar)
  const followers = cleanString(theme.followers || theme.followersCount || theme.followerCount)
  const verified = theme.brandVerified === undefined ? true : normalizeBoolean(theme.brandVerified) === 1
  const handle = (slugify(name) || 'marca').replace(/-/g, '')
  const initial = (name.trim()[0] || 'R').toUpperCase()
  return { name, subtitle, avatarUrl, followers, verified, handle, initial }
}

function renderAvatar(brand) {
  if (brand.avatarUrl) {
    return `<span class="rstk-avatar"><img src="${escapeHtml(brand.avatarUrl)}" alt="${escapeHtml(brand.name)}"></span>`
  }
  return `<span class="rstk-avatar">${escapeHtml(brand.initial)}</span>`
}

function getSocialPlatformIcon(platform) {
  if (platform === 'instagram') return RSTK_ICONS.camera
  if (platform === 'tiktok') return RSTK_ICONS.music
  if (platform === 'threads') return '@'
  return ''
}

function normalizeSocialPlatform(value, fallback = 'facebook') {
  const platform = cleanString(value)
  return isSupportedSocialPlatform(platform) ? platform : fallback
}

function renderSocialProfileBlock(block, context = {}) {
  const settings = block.settings || {}
  const siteTemplate = resolveTemplate(context.site)
  const fallbackPlatform = isSocialTemplate(siteTemplate.id) ? siteTemplate.id : 'facebook'
  const platform = normalizeSocialPlatform(settings.platform || settings.socialSourcePlatform, fallbackPlatform)
  const template = SITE_TEMPLATES[platform] || siteTemplate
  const siteBrand = getBrand(context.site || {}, template)
  const name = cleanString(settings.brandName) || siteBrand.name
  const subtitleDefault = platform === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'
  const subtitle = cleanString(settings.brandSubtitle) || siteBrand.subtitle || subtitleDefault
  const followers = cleanString(settings.followers || settings.followersCount || settings.followerCount) || siteBrand.followers
  const avatarUrl = safeUrl(settings.brandAvatar) || siteBrand.avatarUrl
  const verified = settings.brandVerified === undefined ? siteBrand.verified : normalizeBoolean(settings.brandVerified) === 1
  const initial = (name.trim()[0] || 'R').toUpperCase()
  const brand = {
    name,
    subtitle,
    followers,
    avatarUrl,
    verified,
    initial
  }
  const secondary = followers ? `${escapeHtml(followers)} seguidores` : escapeHtml(subtitle)
  const platformLabel = platform === 'facebook' ? 'Facebook' : platform === 'instagram' ? 'Instagram' : platform === 'threads' ? 'Threads' : 'TikTok'

  return `
    <section class="rstk-chrome rstk-social-profile rstk-social-profile-block rstk-social-profile-${platform}" aria-label="Perfil de ${platformLabel}">
      <div class="rstk-social-image">
        ${renderAvatar(brand)}
        <span class="rstk-social-platform rstk-social-platform-${platform}" aria-hidden="true">${getSocialPlatformIcon(platform)}</span>
      </div>
      <div class="rstk-social-details">
        <div class="rstk-social-name">${escapeHtml(name)}${verified ? RSTK_ICONS.verified : ''}</div>
        <div class="rstk-social-followers">${secondary}</div>
      </div>
    </section>
  `
}

function renderLegalFooter(brand) {
  return `
    <p class="rstk-footer">
      <span class="rstk-lock" aria-hidden="true">${RSTK_ICONS.lock}</span>
      Tu informacion esta protegida. ${escapeHtml(brand.name)} no la comparte con terceros.
    </p>
  `
}

const RSTK_GOOGLE_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=Barlow:wght@400;500;600;700;800;900&family=Bebas+Neue&family=Inter:wght@400;500;600;700;800;900&family=Inter+Tight:wght@500;600;700;800;900&family=Lato:wght@400;700;900&family=Libre+Baskerville:wght@400;700&family=Manrope:wght@400;500;600;700;800&family=Merriweather:wght@400;700;900&family=Montserrat:wght@400;500;600;700;800;900&family=Nunito:wght@400;600;700;800;900&family=Open+Sans:wght@400;600;700;800&family=Oswald:wght@400;500;600;700&family=Playfair+Display:wght@400;600;700;800;900&family=Poppins:wght@400;500;600;700;800;900&family=Raleway:wght@400;500;600;700;800;900&family=Roboto:wght@400;500;700;900&family=Work+Sans:wght@400;500;600;700;800;900&display=swap'

const RSTK_BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box}
  [hidden]{display:none !important}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;min-height:100vh;
    font-family:var(--rstk-font);
    color:var(--rstk-ink);
    background-color:var(--rstk-page-bg);
    background-image:var(--rstk-page-image);
    background-position:var(--rstk-page-image-position,center top);
    background-repeat:var(--rstk-page-image-repeat,no-repeat);
    background-size:var(--rstk-page-image-size,auto);
    background-attachment:var(--rstk-page-image-attachment,scroll);
    line-height:1.5;letter-spacing:0;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  img{max-width:100%;display:block}
  .rstk-frame{position:relative;isolation:isolate;overflow:hidden;min-height:100vh;padding:var(--rstk-frame-pad,clamp(10px,3vw,32px)) 16px;background-color:var(--rstk-page-bg);background-image:var(--rstk-page-image);background-position:var(--rstk-page-image-position,center top);background-repeat:var(--rstk-page-image-repeat,no-repeat);background-size:var(--rstk-page-image-size,auto);background-attachment:var(--rstk-page-image-attachment,scroll)}
  .rstk-frame::before{content:"";position:absolute;inset:0;z-index:1;background:var(--rstk-page-overlay,none);pointer-events:none}
  .rstk-bg-video{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:var(--rstk-page-video-fit,cover);pointer-events:none}
  .rstk-page{position:relative;z-index:2;width:100%;max-width:var(--rstk-max);margin:0 auto;border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,transparent);border-radius:var(--rstk-page-radius,0)}
  .rstk-shell{display:grid;gap:var(--rstk-gap)}
  .rstk-centered .rstk-shell{text-align:center;justify-items:center}
  .rstk-centered .rstk-subheading,.rstk-centered .rstk-text{margin-inline:auto}
  .rstk-section-lane.rstk-block-style,.rstk-section-lane{width:100%;margin:var(--rstk-block-margin,0);background:var(--rstk-block-bg,transparent);color:var(--rstk-block-text,var(--rstk-ink));border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);padding:0}
  .rstk-section-inner{width:100%;max-width:var(--rstk-max);margin:0 auto;padding:var(--rstk-block-pad,var(--rstk-frame-pad,clamp(28px,5vw,72px)));display:grid;gap:var(--rstk-section-gap,clamp(18px,3vw,30px))}
  .rstk-section-heading{display:grid;gap:10px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-section-heading h2,.rstk-section-heading p{margin:0}
  .rstk-section-columns{display:grid;grid-template-columns:repeat(var(--rstk-section-columns,1),minmax(0,1fr));gap:var(--rstk-section-gap,clamp(18px,3vw,30px));align-items:start}
  .rstk-section-column{min-width:0;display:grid;align-content:start;gap:var(--rstk-gap)}
  .rstk-block-style{
    width:auto;
    min-width:0;
    margin:var(--rstk-block-margin,0);
    background:var(--rstk-block-bg,transparent);
    color:var(--rstk-block-text,var(--rstk-ink));
    font-family:var(--rstk-block-font,var(--rstk-font));
    font-size:var(--rstk-block-size,inherit);
    font-weight:var(--rstk-block-weight,inherit);
    text-align:var(--rstk-block-align,inherit);
    border:var(--rstk-block-shell-border-width,0) solid var(--rstk-block-border,transparent);
    border-radius:var(--rstk-block-radius,0);
    padding:var(--rstk-block-pad,0);
  }
  .rstkHeaderPanelBlock{z-index:6}
  .rstkFooterPanelBlock{z-index:1}
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help{
    margin-left:var(--rstk-content-margin-left,0);
    margin-right:var(--rstk-content-margin-right,0);
  }
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style label,
  .rstk-block-style strong,
  .rstk-block-style .rstk-social-name{color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help,
  .rstk-block-style p,
  .rstk-block-style .rstk-social-followers{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 68%,var(--rstk-muted) 32%)}
  .rstk-block-style .rstk-social-name,
  .rstk-block-style .rstk-social-followers{font-family:var(--rstk-block-font,var(--rstk-font));font-style:var(--rstk-block-font-style,normal);text-decoration:var(--rstk-block-text-decoration,none)}
  .rstk-block-style .rstk-social-name{font-size:var(--rstk-block-size,18px);font-weight:var(--rstk-block-weight,800)}
  .rstk-block-style .rstk-button-link,
  .rstk-block-style button{border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius))}
  .rstk-block-style input,
  .rstk-block-style textarea,
  .rstk-block-style select,
  .rstk-block-style .rstk-option{
    background:var(--rstk-field-bg,var(--rstk-input-bg));
    border-color:var(--rstk-field-border,var(--rstk-input-border));
    border-radius:var(--rstk-field-radius,var(--rstk-radius));
  }
  .rstk-block-style .rstk-media,
  .rstk-block-style .rstk-video{
    justify-self:var(--rstk-media-justify,center);
    width:var(--rstk-media-width,100%);
    margin-left:var(--rstk-media-margin-left,auto);
    margin-right:var(--rstk-media-margin-right,auto);
  }

  .rstk-kind-form .rstk-shell{
    background:var(--rstk-surface);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));
    border-radius:var(--rstk-radius-lg);box-shadow:none;
    padding:var(--rstk-pad);overflow:hidden;
  }
  form{width:100%;display:grid;gap:18px;background:transparent;border:0;box-shadow:none;padding:0;margin:0}
  .rstk-kind-landing form{gap:0}

  .rstk-headline{margin:0;font-weight:var(--rstk-heading-weight);font-size:clamp(1.7rem,4.6vw,3rem);line-height:1.05;letter-spacing:0}
  .rstk-kind-landing .rstk-headline{font-size:clamp(2rem,5.4vw,3.6rem)}
  .rstk-subheading{margin:0;color:var(--rstk-muted);font-size:clamp(1rem,2vw,1.18rem);max-width:var(--rstk-content-max,60ch)}
  .rstk-kicker{margin:0;color:var(--rstk-accent);font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em}
  .rstk-text{margin:0;color:color-mix(in srgb,var(--rstk-ink) 80%,transparent);max-width:var(--rstk-content-max,66ch)}
  .rstk-hero,.rstk-section-break,.rstk-cta,.rstk-section-list,.rstk-embedded-form{display:grid;gap:14px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-hero{gap:16px}
  .rstk-section-break h2,.rstk-section-list h2,.rstk-cta h2,.rstk-embedded-form h2{margin:0;font-size:clamp(1.25rem,2.6vw,1.7rem);font-weight:var(--rstk-heading-weight);letter-spacing:0}

  .rstk-button-link,.rstk-actions button{
    -webkit-appearance:none;appearance:none;cursor:pointer;
    min-height:var(--rstk-button-height,50px);display:inline-flex;align-items:center;justify-content:center;gap:8px;
    border:var(--rstk-button-border-width,1px) solid var(--rstk-button-border,var(--rstk-button-bg,var(--rstk-accent)));border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius));
    background:var(--rstk-button-bg,var(--rstk-accent));color:var(--rstk-button-text,var(--rstk-on-accent));
    font:inherit;font-weight:var(--rstk-btn-weight);font-size:var(--rstk-button-size,1.02rem);line-height:1;
    padding:0 var(--rstk-button-pad-x,22px);text-decoration:none;
    transition:background .15s ease,border-color .15s ease,transform .04s ease,box-shadow .15s ease;
  }
	  .rstk-button-link{justify-self:var(--rstk-button-justify,center);width:var(--rstk-button-width,fit-content);margin-left:var(--rstk-button-margin-left,auto);margin-right:var(--rstk-button-margin-right,auto)}
	  .rstk-button-label{display:inline-block}
	  .rstk-button-subtitle{display:block;font-size:.78em;font-weight:650;line-height:1.25;opacity:.82}
	  .rstk-centered .rstk-button-link{margin-inline:auto}
  .rstk-button-link:hover,.rstk-actions button:hover{background:var(--rstk-button-hover-bg,var(--rstk-accent-strong));border-color:var(--rstk-button-hover-border,var(--rstk-button-border,var(--rstk-button-hover-bg,var(--rstk-accent-strong))))}
  .rstk-actions button:active{transform:translateY(1px)}
  .rstk-actions button[disabled]{opacity:.6;cursor:not-allowed}
  .rstk-secondary{background:transparent !important;color:var(--rstk-ink) !important;border-color:var(--rstk-border) !important}

  .rstk-list-grid{display:grid;grid-template-columns:var(--rstk-list-columns,repeat(auto-fit,minmax(190px,1fr)));gap:12px}
  .rstk-list-grid article{border:var(--rstk-card-border-width,var(--rstk-block-border-width,1px)) solid var(--rstk-card-border,var(--rstk-block-border,var(--rstk-border)));border-radius:var(--rstk-card-radius,var(--rstk-radius));background:var(--rstk-card-bg,var(--rstk-block-bg,var(--rstk-surface2)));padding:16px;text-align:var(--rstk-card-align,left)}
  .rstk-list-grid strong{display:block;font-weight:750}
  .rstk-list-grid p{margin:6px 0 0;color:var(--rstk-muted);font-size:.92rem}
  .rstk-list-grid small{display:block;margin-top:8px;color:var(--rstk-muted);font-weight:700}

  .rstk-check-list{list-style:none;margin:0;padding:0;display:grid;gap:11px;text-align:left}
  .rstk-check{display:flex;align-items:flex-start;gap:11px}
  .rstk-check-icon{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;margin-top:1px}
  .rstk-check-pro .rstk-check-icon{background:color-mix(in srgb,#16a34a 16%,var(--rstk-surface));color:#16a34a}
  .rstk-check-con .rstk-check-icon{background:color-mix(in srgb,#dc2626 14%,var(--rstk-surface));color:#dc2626}
  .rstk-check-neutral .rstk-check-icon{background:color-mix(in srgb,var(--rstk-accent) 14%,var(--rstk-surface));color:var(--rstk-accent)}
  .rstk-check-body{display:grid;gap:2px}
  .rstk-check-body strong{font-weight:650;font-size:1rem}
  .rstk-check-body span{color:var(--rstk-muted);font-size:.92rem}

  .rstk-media,.rstk-video{width:100%;margin:0;overflow:hidden;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-media-radius,var(--rstk-block-radius,var(--rstk-radius)));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-media img,.rstk-video iframe{width:100%;display:block;border:0}
  .rstk-video{aspect-ratio:16/9;position:relative}
  .rstk-video iframe{height:100%}
  .rstk-media-empty{min-height:190px;display:grid;place-items:center;gap:8px;color:var(--rstk-muted);font-size:.92rem}
  .rstk-play{display:grid;place-items:center;width:58px;height:58px;border-radius:50%;background:var(--rstk-accent);color:var(--rstk-on-accent)}

  .rstk-site-panel{width:100%;display:flex;align-items:center;justify-content:space-between;gap:18px;color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-site-panel-copy{margin:0;color:inherit;font:inherit;font-weight:800}
  .rstk-site-panel-footer .rstk-site-panel-copy{font-weight:600;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 72%,var(--rstk-muted) 28%)}
  .rstk-site-panel-links{display:flex;align-items:center;justify-content:flex-end;gap:14px;flex-wrap:wrap}
  .rstk-site-panel-links a{color:inherit;text-decoration:none;font-size:.92rem;font-weight:750}
  .rstk-site-panel-footer{justify-content:center;text-align:center;flex-wrap:wrap}
  .rstk-site-panel-footer .rstk-site-panel-links{justify-content:center}

	  .rstk-field{display:grid;gap:8px;text-align:left}
	  .rstk-kind-form form{font-family:var(--rstk-form-font,var(--rstk-font))}
	  label{font-size:.95rem;font-weight:700;color:var(--rstk-ink)}
	  .rstk-kind-form .rstk-field > label{color:var(--rstk-form-label-color,var(--rstk-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-label-size,.95rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,700);text-decoration:var(--rstk-form-text-decoration,none)}
	  .rstk-required{color:#dc2626;margin-left:3px}
	  .rstk-help{margin:0;color:var(--rstk-muted);font-size:.9rem}
	  .rstk-kind-form .rstk-help{color:var(--rstk-form-help-color,var(--rstk-muted));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-help-size,.9rem);font-style:var(--rstk-form-font-style,normal);text-decoration:var(--rstk-form-text-decoration,none)}
	  input,textarea,select{
	    width:100%;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));
	    background:var(--rstk-input-bg);color:var(--rstk-input-ink);font:inherit;font-size:1rem;
	    padding:13px 14px;outline:none;transition:border-color .15s ease,box-shadow .15s ease;
	  }
	  .rstk-kind-form .rstk-field > input,.rstk-kind-form .rstk-field > textarea,.rstk-kind-form .rstk-field > select{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,700);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  .rstk-phone-input{display:grid;grid-template-columns:minmax(92px,.24fr) minmax(0,1fr);gap:8px;align-items:stretch}
	  .rstk-phone-input > select,.rstk-phone-input > input{min-width:0}
	  .rstk-kind-form .rstk-field .rstk-phone-input > input,.rstk-kind-form .rstk-field .rstk-phone-input > select{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,700);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  textarea{resize:vertical;min-height:108px}
	  input::placeholder,textarea::placeholder{color:color-mix(in srgb,var(--rstk-muted) 80%,transparent)}
	  .rstk-kind-form input::placeholder,.rstk-kind-form textarea::placeholder{color:var(--rstk-form-placeholder,color-mix(in srgb,var(--rstk-muted) 80%,transparent))}
	  input:focus,textarea:focus,select:focus{border-color:var(--rstk-accent);box-shadow:0 0 0 4px var(--rstk-ring)}
	  select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%),linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%);background-position:calc(100% - 20px) calc(50% - 3px),calc(100% - 15px) calc(50% - 3px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:42px}
	  .rstk-kind-form.rstk-select-filled .rstk-field select{background-color:color-mix(in srgb,var(--rstk-form-field-bg,var(--rstk-input-bg)) 88%,var(--rstk-accent) 12%)}
	  .rstk-kind-form.rstk-select-underline .rstk-field select{border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background-color:transparent;padding-left:0;padding-right:36px}
	  .rstk-phone-input > select{background:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%) calc(100% - 20px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-input-bg)}
	  .rstk-kind-form .rstk-field .rstk-phone-input > select,.rstk-kind-form.rstk-select-filled .rstk-field .rstk-phone-input > select,.rstk-kind-form.rstk-select-underline .rstk-field .rstk-phone-input > select{border-width:var(--rstk-form-field-border-width,1px);border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%) calc(100% - 20px) calc(50% - 3px)/5px 5px no-repeat,linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%) calc(100% - 15px) calc(50% - 3px)/5px 5px no-repeat,var(--rstk-form-field-bg,var(--rstk-input-bg));padding-left:var(--rstk-form-field-pad-x,14px);padding-right:42px}

	  .rstk-options{display:grid;gap:10px}
	  .rstk-option{display:flex;align-items:center;gap:11px;min-height:50px;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));padding:11px 14px;background:var(--rstk-input-bg);color:var(--rstk-input-ink);font-weight:600;cursor:pointer;transition:border-color .15s ease,background .15s ease}
	  .rstk-option:hover{border-color:var(--rstk-accent)}
	  .rstk-option:has(input:checked){border-color:var(--rstk-accent);background:color-mix(in srgb,var(--rstk-accent) 8%,var(--rstk-input-bg))}
	  .rstk-option input{width:19px;height:19px;padding:0;flex:0 0 auto;accent-color:var(--rstk-accent)}
	  .rstk-kind-form .rstk-options .rstk-option{min-height:var(--rstk-form-field-height,50px);border-width:var(--rstk-form-field-border-width,1px);border-color:var(--rstk-form-field-border,var(--rstk-input-border));border-radius:var(--rstk-form-field-radius,var(--rstk-field-radius,var(--rstk-radius)));background:var(--rstk-form-field-bg,var(--rstk-input-bg));color:var(--rstk-form-field-text,var(--rstk-input-ink));font-family:var(--rstk-form-font,var(--rstk-font));font-size:var(--rstk-form-input-size,1rem);font-style:var(--rstk-form-font-style,normal);font-weight:var(--rstk-form-weight,700);text-decoration:var(--rstk-form-text-decoration,none);padding:var(--rstk-form-field-pad-y,13px) var(--rstk-form-field-pad-x,14px)}
	  .rstk-kind-form .rstk-option:has(input:checked){border-color:var(--rstk-form-choice-selected-border,var(--rstk-accent));background:var(--rstk-form-choice-selected-bg,color-mix(in srgb,var(--rstk-accent) 8%,var(--rstk-form-field-bg,var(--rstk-input-bg))))}
	  .rstk-kind-form.rstk-choice-cards .rstk-option,.rstk-kind-form.rstk-choice-pills .rstk-option{position:relative;gap:0}
	  .rstk-kind-form.rstk-choice-cards .rstk-option input,.rstk-kind-form.rstk-choice-pills .rstk-option input{position:absolute;opacity:0;pointer-events:none}
	  .rstk-kind-form.rstk-choice-cards .rstk-option{padding-left:var(--rstk-form-field-pad-x,14px);box-shadow:inset 4px 0 0 transparent}
	  .rstk-kind-form.rstk-choice-cards .rstk-option:has(input:checked){box-shadow:inset 4px 0 0 var(--rstk-form-choice-selected-border,var(--rstk-accent))}
	  .rstk-kind-form.rstk-choice-pills .rstk-options{display:flex;flex-wrap:wrap;gap:8px}
	  .rstk-kind-form.rstk-choice-pills .rstk-option{flex:0 1 auto;min-height:40px;border-radius:999px;padding:9px 16px}
	  .rstk-kind-form.rstk-choice-minimal .rstk-option{min-height:38px;border-width:0 0 var(--rstk-form-field-border-width,1px);border-radius:0;background:transparent;padding-inline:0}

  .rstk-embed{width:100%;min-height:var(--rstk-embed-height,360px);display:block;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-block-radius,var(--rstk-radius));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-calendar-embed{min-height:760px}
  iframe.rstk-embed{overflow:hidden}
  .rstk-embed-code{background:transparent}
  .rstk-embed-empty{display:grid;place-items:center;min-height:160px;color:var(--rstk-muted)}

	  .rstk-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
	  .rstk-actions [data-submit],.rstk-actions [data-next]{flex:1 1 auto}
	  .rstk-kind-form .rstk-actions [data-submit]{min-height:var(--rstk-submit-height,var(--rstk-button-height,50px));border-width:var(--rstk-submit-border-width,var(--rstk-button-border-width,1px));border-color:var(--rstk-submit-border,var(--rstk-button-border,var(--rstk-accent)));border-radius:var(--rstk-submit-radius,var(--rstk-btn-radius));background:var(--rstk-submit-bg,var(--rstk-accent));color:var(--rstk-submit-text,var(--rstk-on-accent));flex-direction:column;gap:2px;font-size:var(--rstk-submit-size,var(--rstk-button-size,1.02rem));padding-left:var(--rstk-submit-pad-x,var(--rstk-button-pad-x,22px));padding-right:var(--rstk-submit-pad-x,var(--rstk-button-pad-x,22px))}
	  .rstk-actions [data-back]{flex:0 0 auto;min-width:120px}
  .rstk-error{margin:2px 0 0;color:#dc2626;font-size:.85rem;font-weight:650}
  .rstk-submit-message{margin:0;color:var(--rstk-muted);font-weight:650;text-align:center}

  .rstk-progress{display:grid;gap:8px}
  .rstk-progress-track{height:6px;border-radius:999px;background:color-mix(in srgb,var(--rstk-ink) 12%,transparent);overflow:hidden}
  .rstk-progress-fill{display:block;height:100%;width:0;border-radius:999px;background:var(--rstk-accent);transition:width .35s cubic-bezier(.4,0,.2,1)}
  .rstk-progress b{font-size:.8rem;color:var(--rstk-muted);font-weight:700}

  @media (max-width:640px){
    .rstk-list-grid{grid-template-columns:1fr}
    .rstk-site-panel{align-items:flex-start;flex-direction:column}
    .rstk-site-panel-footer{align-items:center}
    .rstk-site-panel-links{justify-content:flex-start}
  }

  .rstk-footer{margin:6px 0 0;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--rstk-muted);font-size:.78rem;text-align:center}
  .rstk-footer .rstk-lock{display:inline-flex}

  .rstk-chrome .rstk-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;overflow:hidden;background:var(--rstk-accent);color:#fff;font-weight:800;font-size:1.15rem;flex:0 0 auto}
  .rstk-chrome .rstk-avatar img{width:100%;height:100%;object-fit:cover}
	  .rstk-social-profile{margin:calc(-1 * var(--rstk-pad)) calc(-1 * var(--rstk-pad)) 0;padding:20px var(--rstk-pad) 14px;display:flex;align-items:center;gap:8px;background:transparent;border:0}
	  .rstk-social-profile-block{width:100%;margin:0;padding:0;border:0;border-radius:0;background:transparent;gap:12px}
	  .rstk-social-image{position:relative;display:inline-block;flex:0 0 auto}
	  .rstk-social-profile .rstk-avatar{width:64px;height:64px;font-size:1.35rem}
	  .rstk-social-profile-block .rstk-avatar{width:56px;height:56px;font-size:1.2rem}
  .rstk-social-platform{position:absolute;right:-1px;bottom:-1px;z-index:2;width:28px;height:28px;border-radius:50%;border:2px solid #fff;background:#fff;display:grid;place-items:center;padding:2px;color:#fff;overflow:hidden}
  .rstk-social-platform-facebook{background:#fff url('https://storage.googleapis.com/msgsndr/cAEl3p2eZROgv2GFvMZM/media/67b7bb9d7c922f0d2f3b2adf.svg') center/contain no-repeat}
  .rstk-social-platform-instagram{background:var(--rstk-gradient)}
  .rstk-social-platform-tiktok{background:#050505;box-shadow:inset 1px 0 var(--rstk-cyan),inset -1px 0 var(--rstk-accent)}
  .rstk-social-platform-threads{background:#050505;font-size:16px;font-weight:900;line-height:1}
  .rstk-social-platform svg{width:16px;height:16px}
  .rstk-social-details{display:flex;flex-direction:column;min-width:0}
  .rstk-social-name{display:flex;align-items:center;gap:4px;min-width:0;font-size:18px;line-height:1.18;font-weight:800;color:var(--rstk-ink)}
  .rstk-social-name .rstk-verified{width:14px;height:14px;margin-left:0;color:#1877f2;flex:0 0 auto;position:relative;top:1px}
  .rstk-social-followers{margin-top:2px;color:var(--rstk-muted);font-size:14px;line-height:1.25;font-weight:600}
  @media (max-width:480px){
    .rstk-social-profile{padding:15px var(--rstk-pad) 12px}
    .rstk-social-profile .rstk-avatar{width:60px;height:60px}
    .rstk-social-name{font-size:18px}
    .rstk-social-followers{font-size:12px}
  }

  @media (max-width:540px){
    .rstk-actions{flex-direction:column-reverse}
    .rstk-actions button{width:100%}
    .rstk-actions [data-back]{width:100%}
  }

  /* ---------- Premium landing ---------- */
  .rstk-kind-landing .rstk-frame{padding:0}
  .rstk-kind-landing .rstk-page{max-width:none;margin:0;border-radius:var(--rstk-page-radius,0);overflow:hidden}
  .rstk-kind-landing .rstk-shell{gap:0;padding-top:0}
  .rstk-kind-landing .rstk-section-column{gap:0}
  .rstk-kind-landing .rstk-headline{font-family:var(--rstk-display);font-size:clamp(2.3rem,5.6vw,4rem);line-height:1.03;letter-spacing:0;background:none;color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-kind-landing .rstk-subheading{font-size:clamp(1.05rem,1.7vw,1.28rem);max-width:var(--rstk-content-max,60ch);line-height:1.6}
  .rstk-kind-landing h2{font-family:var(--rstk-display)}
  .rstk-kind-landing .rstk-text{font-size:1.06rem;line-height:1.7}

  .rstk-kind-landing .rstk-kicker{display:inline-flex;align-items:center;gap:8px;width:fit-content;padding:7px 14px 7px 12px;border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,var(--rstk-border));border-radius:999px;background:var(--rstk-block-bg,transparent);color:var(--rstk-muted);font-size:.72rem;font-weight:700;letter-spacing:0;text-transform:uppercase}
  .rstk-kind-landing .rstk-kicker::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rstk-accent)}

  .rstk-kind-landing .rstk-hero{position:relative;isolation:isolate;overflow:hidden;gap:22px;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);padding:clamp(32px,4.8vw,68px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-hero::before,.rstk-kind-landing .rstk-hero::after{content:none}
  .rstk-kind-landing .rstk-hero .rstk-headline{font-size:clamp(2.6rem,6.2vw,4.6rem);max-width:var(--rstk-content-max,16ch)}
  .rstk-kind-landing .rstk-hero .rstk-subheading{margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-section-break{min-height:clamp(160px,24vw,360px);align-content:center;padding:clamp(28px,5vw,76px) clamp(20px,4vw,56px)}
  .rstk-kind-landing .rstk-section-break h2{font-family:var(--rstk-display);font-size:clamp(2rem,4.6vw,3.4rem);line-height:1.08}
  .rstk-kind-landing .rstk-section-break p{max-width:var(--rstk-content-max,58ch);margin:0;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 74%,transparent)}

  .rstk-kind-landing .rstk-section-list{gap:clamp(20px,3vw,38px)}
  .rstk-kind-landing .rstk-section-list h2{text-align:var(--rstk-block-align,center);max-width:var(--rstk-content-max,20ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto);font-size:clamp(1.85rem,3.4vw,2.85rem);line-height:1.08;letter-spacing:0}
  .rstk-kind-landing .rstk-list-grid{gap:16px}
  .rstk-kind-landing .rstk-list-grid article{padding:24px;border:var(--rstk-card-border-width,var(--rstk-block-border-width,0)) solid var(--rstk-card-border,var(--rstk-block-border,transparent));border-radius:var(--rstk-card-radius,0);background:var(--rstk-card-bg,var(--rstk-block-bg,transparent));transition:border-color .15s ease}
  .rstk-kind-landing .rstk-list-grid article:hover{border-color:color-mix(in srgb,var(--rstk-ink) 22%,transparent)}
  .rstk-kind-landing .rstk-list-grid strong{font-size:1.06rem}

  .rstk-kind-landing .rstk-checklist{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  .rstk-kind-landing .rstk-checklist h2{text-align:var(--rstk-block-align,center);margin-bottom:4px}
  .rstk-kind-landing .rstk-check-body strong{font-size:1.04rem}

  .rstk-kind-landing .rstk-cta{position:relative;overflow:hidden;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);gap:18px;padding:clamp(30px,4.4vw,62px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-cta::after{content:none}
  .rstk-kind-landing .rstk-cta > *{position:relative;z-index:1}
  .rstk-kind-landing .rstk-cta h2{font-size:clamp(2rem,4vw,3.1rem)}
  .rstk-kind-landing .rstk-cta p{font-size:1.1rem;max-width:var(--rstk-content-max,52ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-button-link{border-radius:var(--rstk-block-button-radius,999px);min-height:var(--rstk-button-height,54px);padding:0 var(--rstk-button-pad-x,28px);font-family:var(--rstk-display);font-weight:600;transition:transform .25s var(--rstk-ease),box-shadow .25s var(--rstk-ease),background .2s ease}
  .rstk-kind-landing .rstk-button-link:hover{transform:none;box-shadow:none}

  .rstk-kind-landing .rstk-media,.rstk-kind-landing .rstk-video,.rstk-kind-landing .rstk-embed{border-radius:var(--rstk-media-radius,var(--rstk-block-radius,clamp(16px,2vw,22px)));box-shadow:none}
  .rstk-kind-landing .rstk-embedded-form{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  @media (max-width:760px){.rstk-section-columns{grid-template-columns:1fr}}
  .rstkFontOverride .rstk-headline,.rstkFontOverride .rstk-subheading,.rstkFontOverride .rstk-text,.rstkFontOverride h2,.rstkFontOverride label,.rstkFontOverride .rstk-help,.rstkFontOverride .rstk-list-grid strong,.rstkFontOverride .rstk-list-grid p,.rstkFontOverride .rstk-check-body strong,.rstkFontOverride .rstk-check-body span{font-family:var(--rstk-block-font,inherit)}
  .rstkSizeOverride .rstk-headline,.rstkSizeOverride .rstk-subheading,.rstkSizeOverride .rstk-text,.rstkSizeOverride h2,.rstkSizeOverride label,.rstkSizeOverride .rstk-help,.rstkSizeOverride .rstk-list-grid strong,.rstkSizeOverride .rstk-list-grid p,.rstkSizeOverride .rstk-list-grid small,.rstkSizeOverride .rstk-check-body strong,.rstkSizeOverride .rstk-check-body span{font-size:var(--rstk-block-size)}
  .rstkWeightOverride .rstk-headline,.rstkWeightOverride .rstk-subheading,.rstkWeightOverride .rstk-text,.rstkWeightOverride h2,.rstkWeightOverride label,.rstkWeightOverride .rstk-help,.rstkWeightOverride .rstk-list-grid strong,.rstkWeightOverride .rstk-check-body strong{font-weight:var(--rstk-block-weight,850)}
  .rstkItalicOverride .rstk-headline,.rstkItalicOverride .rstk-subheading,.rstkItalicOverride .rstk-text,.rstkItalicOverride h2,.rstkItalicOverride label,.rstkItalicOverride .rstk-help,.rstkItalicOverride .rstk-list-grid strong,.rstkItalicOverride .rstk-list-grid p,.rstkItalicOverride .rstk-check-body strong,.rstkItalicOverride .rstk-check-body span{font-style:var(--rstk-block-font-style,italic)}
  .rstkUnderlineOverride .rstk-headline,.rstkUnderlineOverride .rstk-subheading,.rstkUnderlineOverride .rstk-text,.rstkUnderlineOverride h2,.rstkUnderlineOverride label,.rstkUnderlineOverride .rstk-help,.rstkUnderlineOverride .rstk-list-grid strong,.rstkUnderlineOverride .rstk-list-grid p,.rstkUnderlineOverride .rstk-check-body strong,.rstkUnderlineOverride .rstk-check-body span{text-decoration:var(--rstk-block-text-decoration,underline)}
  .rstkStrokeOverride .rstk-headline,.rstkStrokeOverride .rstk-subheading,.rstkStrokeOverride .rstk-text,.rstkStrokeOverride h2,.rstkStrokeOverride label,.rstkStrokeOverride .rstk-help,.rstkStrokeOverride .rstk-list-grid strong,.rstkStrokeOverride .rstk-list-grid p,.rstkStrokeOverride .rstk-check-body strong,.rstkStrokeOverride .rstk-check-body span{-webkit-text-stroke:var(--rstk-text-stroke-width,0) var(--rstk-text-stroke-color,currentColor)}
  .rstkTextGradient .rstk-headline,.rstkTextGradient .rstk-subheading,.rstkTextGradient .rstk-text,.rstkTextGradient h2,.rstkTextGradient label,.rstkTextGradient .rstk-help,.rstkTextGradient .rstk-site-panel-copy,.rstkTextGradient .rstk-list-grid strong,.rstkTextGradient .rstk-list-grid p,.rstkTextGradient .rstk-check-body strong,.rstkTextGradient .rstk-check-body span,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-headline,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-subheading,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-text,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) h2,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) label,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-help,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-site-panel-copy,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-list-grid strong,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-list-grid p,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-check-body strong,.rstkPageTextGradient .rstk-block-style:not(.rstkBlockTextOverride) .rstk-check-body span{background-image:var(--rstk-block-text-paint,var(--rstk-page-text-paint));background-clip:text;-webkit-background-clip:text;color:transparent !important;-webkit-text-fill-color:transparent}
  .rstkButtonTextGradient .rstk-button-label{background-image:var(--rstk-button-text-paint);background-clip:text;-webkit-background-clip:text;color:transparent;-webkit-text-fill-color:transparent}

  @media (max-width:640px){
    .rstk-kind-landing .rstk-hero{padding:clamp(32px,8vw,56px) 20px}
    .rstk-phone-input{grid-template-columns:1fr}
  }
`

const RSTK_TEMPLATE_EXTRAS = {
  ristak: `
    .rstk-tpl-ristak .rstk-kind-form .rstk-shell{}
  `,

  facebook: `
    .rstk-fb{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad) 12px;border-bottom:1px solid var(--rstk-border)}
    .rstk-fb-line{position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-accent)}
    .rstk-fb-row{display:flex;align-items:center;gap:10px}
    .rstk-fb-meta{flex:1 1 auto;min-width:0}
    .rstk-fb-name{display:flex;align-items:center;gap:5px;font-weight:700;font-size:1rem;color:var(--rstk-ink)}
    .rstk-verified{color:#1877f2;flex:0 0 auto}
    .rstk-fb-sub{display:flex;align-items:center;gap:5px;color:var(--rstk-muted);font-size:.82rem;margin-top:1px}
    .rstk-fb-mark{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--rstk-accent);color:#fff;font-weight:900;font-family:Georgia,'Times New Roman',serif;font-size:1.2rem;flex:0 0 auto}
  `,

  instagram: `
    .rstk-ig{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:0 var(--rstk-pad) 14px}
    .rstk-ig::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-gradient)}
    .rstk-ig-bar{display:flex;align-items:center;gap:8px;padding:12px 0 14px;border-bottom:1px solid var(--rstk-border)}
    .rstk-ig-cam{display:inline-flex;color:var(--rstk-ink)}
    .rstk-ig-word{font-weight:800;font-size:1.05rem}
    .rstk-ig-dots{margin-left:auto;color:var(--rstk-ink);font-size:1.2rem;line-height:1}
    .rstk-ig-profile{display:flex;align-items:center;gap:11px;padding-top:14px}
    .rstk-ig-ring{display:inline-grid;place-items:center;padding:2px;border-radius:50%;background:var(--rstk-gradient);flex:0 0 auto}
    .rstk-ig-ring .rstk-avatar{width:42px;height:42px;border:2px solid var(--rstk-surface)}
    .rstk-ig-name{font-weight:700;font-size:.95rem}
    .rstk-ig-sub{color:var(--rstk-muted);font-size:.8rem;margin-top:1px}
    .rstk-tpl-instagram .rstk-button-link,.rstk-tpl-instagram .rstk-actions [data-submit]{background:var(--rstk-accent)}
  `,

  tiktok: `
    .rstk-tt{margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad);border-bottom:1px solid var(--rstk-border);display:grid;gap:10px;justify-items:center}
    .rstk-tt-bar{display:flex;align-items:center;gap:8px;font-weight:800;font-size:1.05rem;letter-spacing:.2px}
    .rstk-tt-note{display:inline-flex;color:#fff;filter:drop-shadow(1.5px 0 var(--rstk-cyan)) drop-shadow(-1.5px 0 var(--rstk-accent))}
    .rstk-tt-profile{display:flex;align-items:center;gap:11px}
    .rstk-tt-name{font-weight:800}
    .rstk-tt-sub{color:var(--rstk-muted);font-size:.8rem}
    .rstk-tpl-tiktok .rstk-headline{text-shadow:1.5px 0 var(--rstk-cyan),-1.5px 0 var(--rstk-accent)}
    .rstk-tpl-tiktok ::selection{background:var(--rstk-accent);color:#fff}
  `,

  vsl: `
    .rstk-tpl-vsl .rstk-shell{background:var(--rstk-surface);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));border-radius:var(--rstk-radius-lg);box-shadow:none;padding:clamp(20px,4vw,40px)}
    .rstk-tpl-vsl .rstk-kicker{display:inline-block}
  `,

  interactive: `
    .rstk-interactive .rstk-shell{min-height:min(72vh,560px);align-content:center;padding:clamp(22px,5vw,46px)}
    .rstk-interactive .rstk-field{gap:14px}
    .rstk-interactive label{font-size:clamp(1.3rem,3.4vw,1.9rem);font-weight:800;letter-spacing:0;line-height:1.15}
    .rstk-interactive .rstk-help{font-size:1rem}
    .rstk-interactive .rstk-options{counter-reset:rstk-opt;gap:12px}
    .rstk-interactive .rstk-option{position:relative;min-height:60px;padding:16px 18px 16px 60px;font-size:1.05rem;font-weight:600}
    .rstk-interactive .rstk-option input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
    .rstk-interactive .rstk-option::before{counter-increment:rstk-opt;content:counter(rstk-opt,upper-alpha);position:absolute;left:14px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:9px;display:grid;place-items:center;border:1px solid var(--rstk-border);font-weight:800;font-size:.9rem;color:var(--rstk-muted);background:var(--rstk-surface);transition:all .15s ease}
    .rstk-interactive .rstk-option:has(input:checked)::before{background:var(--rstk-accent);color:var(--rstk-on-accent);border-color:var(--rstk-accent)}
    .rstk-interactive .rstk-actions{margin-top:10px}
    .rstk-interactive input,.rstk-interactive textarea,.rstk-interactive select{font-size:1.1rem;padding:15px 16px}
  `
}

function relLuminance(hex) {
  const normalized = normalizeCssColor(hex, '#ffffff')
  let h = String(normalized || '').replace('#', '')
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    const match = normalized.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
    if (match) {
      h = [match[1], match[2], match[3]]
        .map(channel => Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, '0'))
        .join('')
    }
  }
  if (h.length < 6) return 1
  const toLin = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const r = toLin(parseInt(h.slice(0, 2), 16))
  const g = toLin(parseInt(h.slice(2, 4), 16))
  const b = toLin(parseInt(h.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function cssImageUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:image\//i.test(raw)) return ''
  return `url("${raw.replace(/["\\\n\r]/g, '')}")`
}

function cssMediaUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:video\//i.test(raw)) return ''
  return raw.replace(/["\\\n\r]/g, '')
}

function paintLayer(paint) {
  if (!paint) return 'none'
  if (isCssGradient(paint)) return paint
  return `linear-gradient(${paint}, ${paint})`
}

function backgroundFitValue(value) {
  const raw = cleanString(value)
  if (raw === 'contain') return 'contain'
  if (raw === 'full_width') return '100% auto'
  if (raw === 'auto') return 'auto'
  return 'cover'
}

function backgroundRepeatValue(value) {
  const raw = cleanString(value)
  return ['repeat', 'repeat-x', 'repeat-y'].includes(raw) ? raw : 'no-repeat'
}

function backgroundPositionValue(value) {
  const raw = cleanString(value)
  return raw && !/[;{}<>]/.test(raw) ? raw : 'center center'
}

function backgroundAttachmentValue(value) {
  return cleanString(value) === 'fixed' ? 'fixed' : 'scroll'
}

function deriveNeutralVars(template, bg, userAccent) {
  const dark = relLuminance(bg) < 0.5
  const ink = dark ? '#f4f4f6' : '#0f172a'
  const accent = userAccent || (dark ? '#ffffff' : '#0f172a')
  const onAccent = relLuminance(accent) > 0.6 ? '#08080a' : '#ffffff'
  return {
    ...template.vars,
    pageBg: bg,
    pageImage: 'none',
    ink,
    muted: `color-mix(in srgb, ${ink} 60%, ${bg})`,
    surface: dark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.022)',
    surface2: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)',
    border: dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)',
    accent,
    accentStrong: accent,
    onAccent,
    ring: `color-mix(in srgb, ${accent} 26%, transparent)`,
    inputBg: dark ? 'rgba(255,255,255,0.04)' : '#ffffff',
    inputInk: ink,
    inputBorder: dark ? 'rgba(255,255,255,0.14)' : '#dfe3e8'
  }
}

function resolveRenderOverrides(template, theme, isLandingType) {
  if (template.chrome !== 'none') return {}
  const paintColor = (value) => {
    const paint = normalizeCssPaint(value, '')
    return paint ? paintFallbackColor(paint, '') : null
  }
  // DEFAULT_THEME forces backgroundColor=#ffffff, so treat white as "not chosen":
  // landings default to the premium dark canvas; forms stay light until recolored.
  const rawBg = paintColor(theme.backgroundColor)
  const userBg = rawBg && rawBg.toLowerCase() !== String(DEFAULT_THEME.backgroundColor).toLowerCase() ? rawBg : null
  const rawAccent = paintColor(theme.accentColor)
  const userAccent = rawAccent && rawAccent.toLowerCase() !== String(DEFAULT_THEME.accentColor).toLowerCase() ? rawAccent : null
  if (isLandingType) {
    return { vars: deriveNeutralVars(template, userBg || '#08080a', userAccent) }
  }
  if (userBg) {
    return { vars: deriveNeutralVars(template, userBg, userAccent) }
  }
  return userAccent ? { accent: userAccent } : {}
}

function sanitizeCssFont(value) {
  return cleanString(value).replace(/[;"{}<>]/g, '')
}

function normalizeFormChoiceStyle(value) {
  const raw = cleanString(value)
  return ['native', 'cards', 'pills', 'minimal'].includes(raw) ? raw : 'native'
}

function normalizeFormSelectStyle(value) {
  const raw = cleanString(value)
  return ['classic', 'filled', 'underline'].includes(raw) ? raw : 'classic'
}

function buildFormThemeStyleVars(theme, { baseFont, v, accent, ink, muted }) {
  const formFont = sanitizeCssFont(theme.formFontFamily) || baseFont
  const formLabel = themePaint(theme, 'formLabelColor') || ink
  const formHelp = themePaint(theme, 'formHelpColor') || muted
  const formFieldBg = themePaint(theme, 'formFieldBg') || v.inputBg
  const formFieldText = themePaint(theme, 'formFieldText') || v.inputInk
  const formFieldBorder = themePaint(theme, 'formFieldBorder') || v.inputBorder
  const formPlaceholder = themePaint(theme, 'formPlaceholderColor') || muted
  const choiceSelectedBg = themePaint(theme, 'formChoiceSelectedBg') || `color-mix(in srgb, ${accent} 10%, ${v.inputBg})`
  const choiceSelectedBorder = themePaint(theme, 'formChoiceSelectedBorder') || accent
  const submitBg = themePaint(theme, 'submitBg') || accent
  const submitText = themePaint(theme, 'submitTextColor') || v.onAccent
  const submitBorder = themePaint(theme, 'submitBorderColor') || accent
  const defaultRadius = Number.parseInt(v.radius, 10) || 12
  const defaultButtonRadius = Number.parseInt(v.btnRadius, 10) || 12

  return `
	    --rstk-form-font:${formFont};
	    --rstk-form-label-size:${themeNumber(theme, 'formLabelSize', 15, 11, 28)}px;
	    --rstk-form-input-size:${themeNumber(theme, 'formInputSize', 16, 11, 28)}px;
	    --rstk-form-help-size:${themeNumber(theme, 'formHelpSize', 14, 10, 24)}px;
	    --rstk-form-weight:${theme.formFontWeight === 'bold' ? '850' : theme.formFontWeight === 'normal' ? '400' : '700'};
	    --rstk-form-font-style:${theme.formFontStyle === 'italic' ? 'italic' : 'normal'};
	    --rstk-form-text-decoration:${theme.formTextDecoration === 'underline' ? 'underline' : 'none'};
	    --rstk-form-label-color:${paintFallbackColor(formLabel, ink)};
	    --rstk-form-help-color:${paintFallbackColor(formHelp, muted)};
	    --rstk-form-field-bg:${formFieldBg};
	    --rstk-form-field-text:${paintFallbackColor(formFieldText, v.inputInk)};
	    --rstk-form-field-border:${paintFallbackColor(formFieldBorder, v.inputBorder)};
	    --rstk-form-placeholder:${paintFallbackColor(formPlaceholder, muted)};
	    --rstk-form-field-radius:${themeNumber(theme, 'formFieldRadius', defaultRadius, 0, 36)}px;
	    --rstk-form-field-border-width:${themeNumber(theme, 'formFieldBorderWidth', 1, 0, 8)}px;
	    --rstk-form-field-height:${themeNumber(theme, 'formFieldHeight', 50, 34, 96)}px;
	    --rstk-form-field-pad-x:${themeNumber(theme, 'formFieldPaddingX', 14, 6, 48)}px;
	    --rstk-form-field-pad-y:${themeNumber(theme, 'formFieldPaddingY', 13, 6, 36)}px;
	    --rstk-form-choice-selected-bg:${choiceSelectedBg};
	    --rstk-form-choice-selected-border:${paintFallbackColor(choiceSelectedBorder, accent)};
	    --rstk-submit-bg:${submitBg};
	    --rstk-submit-text:${paintFallbackColor(submitText, v.onAccent)};
	    --rstk-submit-border:${paintFallbackColor(submitBorder, accent)};
	    --rstk-submit-radius:${themeNumber(theme, 'submitRadius', defaultButtonRadius, 0, 80)}px;
	    --rstk-submit-height:${themeNumber(theme, 'submitHeight', 50, 34, 96)}px;
	    --rstk-submit-pad-x:${themeNumber(theme, 'submitPaddingX', 22, 8, 72)}px;
	    --rstk-submit-size:${themeNumber(theme, 'submitFontSize', 16, 11, 32)}px;
	    --rstk-submit-border-width:${themeNumber(theme, 'submitBorderWidth', 1, 0, 8)}px;
  `
}

function buildStyleSheet(template, maxWidth, overrides = {}, pageVars = {}) {
  const v = { ...template.vars, ...(overrides.vars || {}) }
  const accent = overrides.accent || v.accent
  const accentStrong = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 86%, #000)` : v.accentStrong
  const ring = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 22%, transparent)` : v.ring
  const baseFont = template.chrome === 'none' ? `'Inter', ${template.font}` : template.font
  const display = template.chrome === 'none' ? `'Inter Tight', 'Inter', ${template.font}` : template.font
  const pageImage = pageVars.pageImage || v.pageImage
  const pageOverlay = pageVars.pageOverlay || 'none'
  const pageBg = pageVars.pageBg || v.pageBg
  const textPaint = pageVars.textPaint || ''
  const ink = textPaint ? paintFallbackColor(textPaint, v.ink) : v.ink
  const muted = textPaint && isCssColor(textPaint) ? `color-mix(in srgb, ${ink} 60%, ${pageBg})` : v.muted
  const theme = pageVars.theme || {}
  const formStyleVars = buildFormThemeStyleVars(theme, { baseFont, v, accent, ink, muted })
  return `
	  :root{
    --rstk-font:${baseFont};
    --rstk-display:${display};
    --rstk-ease:cubic-bezier(.16,.84,.44,1);
    --rstk-page-bg:${pageBg};
    --rstk-page-image:${pageImage};
    --rstk-page-overlay:${pageOverlay};
    --rstk-page-image-size:${pageImage === 'none' ? 'auto' : (pageVars.pageImageSize || 'cover')};
    --rstk-page-image-position:${pageVars.pageImagePosition || 'center center'};
    --rstk-page-image-repeat:${pageVars.pageImageRepeat || 'no-repeat'};
    --rstk-page-image-attachment:${pageVars.pageImageAttachment || 'scroll'};
    --rstk-page-video-fit:${pageVars.pageVideoFit || 'cover'};
    --rstk-ink:${ink};
    --rstk-muted:${muted};
    ${textPaint && isCssGradient(textPaint) ? `--rstk-page-text-paint:${textPaint};` : ''}
    --rstk-surface:${v.surface};
    --rstk-surface2:${v.surface2};
    --rstk-border:${v.border};
    --rstk-accent:${accent};
    --rstk-accent-strong:${accentStrong};
    --rstk-on-accent:${v.onAccent};
    --rstk-ring:${ring};
    --rstk-input-bg:${v.inputBg};
    --rstk-input-ink:${v.inputInk};
    --rstk-input-border:${v.inputBorder};
    --rstk-radius:${v.radius};
    --rstk-radius-lg:${v.radiusLg};
    --rstk-shadow:${v.shadow};
    --rstk-heading-weight:${v.headingWeight};
    --rstk-btn-radius:${v.btnRadius};
    --rstk-btn-weight:${v.btnWeight};
    --rstk-max:${maxWidth};
    --rstk-frame-pad:${pageVars.framePad || 'clamp(10px,3vw,32px)'};
    --rstk-page-border:${pageVars.pageBorder || 'transparent'};
    --rstk-page-border-width:${pageVars.pageBorderWidth || '0px'};
	    --rstk-page-radius:${pageVars.pageRadius || '0px'};
	    --rstk-pad:clamp(18px,4vw,30px);
	    --rstk-gap:clamp(16px,3vw,22px);
	    ${formStyleVars}
	    ${template.gradient ? `--rstk-gradient:${template.gradient};` : ''}
    ${template.cyan ? `--rstk-cyan:${template.cyan};` : ''}
  }
  ${RSTK_BASE_CSS}
  ${RSTK_TEMPLATE_EXTRAS[template.id] || ''}
  `
}

async function buildMetaPixelSnippet(site, trackingEnabled, activePage = null) {
  if (!trackingEnabled || !site.metaCapiEnabled) return ''

  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer Pixel ID de Meta para snippet de Site: ${error.message}`)
    return null
  })
  const pixelId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  if (!pixelId) return ''

  const submitEventName = getFormSubmitMetaEventName(site, activePage?.id)
  const pageMeta = getPageMetaConfig(site, activePage?.id)
  const pageViewEventName = pageMeta?.trigger === 'page_view' ? pageMeta.eventName : ''

  return `
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
    (window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ${JSON.stringify(pixelId)});
    fbq('track', 'PageView');
    window.ristakMetaTrackSiteEvent = function(eventName, eventId, customData) {
      if (!window.fbq) return;
      const normalizedEventName = eventName || ${JSON.stringify(submitEventName)};
      if (!normalizedEventName || normalizedEventName === ${JSON.stringify(SITE_META_NO_EVENT)}) return;
      const method = ${JSON.stringify([...META_STANDARD_PIXEL_EVENTS])}.indexOf(normalizedEventName) >= 0 ? 'track' : 'trackCustom';
      const data = Object.assign({
        source: 'ristak_site',
        site_id: ${JSON.stringify(site.id)},
        site_name: ${JSON.stringify(site.name || '')},
        content_name: ${JSON.stringify(site.title || site.name || '')}
      }, customData || {});
      const options = eventId ? { eventID: eventId } : undefined;
      if (options) {
        window.fbq(method, normalizedEventName, data, options);
      } else {
        window.fbq(method, normalizedEventName, data);
      }
    };
    window.ristakMetaTrackSiteSubmit = function(eventId, customData, eventName) {
      window.ristakMetaTrackSiteEvent(eventName || ${JSON.stringify(submitEventName)}, eventId, customData);
    };
    window.ristakMetaSendServerEvent = function(payload) {
      fetch('/api/sites/public/meta-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    };
    ${pageViewEventName ? `
    try {
      const pageEventId = [
        'site_page',
        ${JSON.stringify(site.id)},
        ${JSON.stringify(activePage?.id || '')},
        Date.now(),
        Math.random().toString(16).slice(2)
      ].join('_');
      const pageData = {
        conversion_type: 'page_view',
        public_page_id: ${JSON.stringify(activePage?.id || '')},
        public_page_title: ${JSON.stringify(activePage?.title || '')}
      };
      window.ristakMetaTrackSiteEvent(${JSON.stringify(pageViewEventName)}, pageEventId, pageData);
      window.ristakMetaSendServerEvent({
        siteId: ${JSON.stringify(site.id)},
        pageId: ${JSON.stringify(activePage?.id || '')},
        eventId: pageEventId,
        eventName: ${JSON.stringify(pageViewEventName)},
        trigger: 'page_view',
        meta: {
          pageUrl: window.location.href,
          referrer: document.referrer,
          params: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
          fbp: (document.cookie.match(/(?:^|; )_fbp=([^;]+)/) || [])[1] || null,
          fbc: (document.cookie.match(/(?:^|; )_fbc=([^;]+)/) || [])[1] || null
        }
      });
    } catch (error) {}
    ` : ''}
  </script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${encodeURIComponent(pixelId)}&ev=PageView&noscript=1"/></noscript>`
}

function isImportedHtmlSite(site = {}) {
  return site?.theme?.importedHtml === true || cleanString(site?.theme?.template) === IMPORTED_SITE_TEMPLATE
}

function buildImportedFormCaptureScript(site, imported, { pageId = DEFAULT_FUNNEL_PAGE_ID } = {}) {
  const mappings = Array.isArray(imported?.formMappings) ? imported.formMappings : []

  return `
  <script>
    (() => {
      const SITE_ID = ${scriptJson(site.id)};
      const FORMS = ${scriptJson(mappings)};
      const DEFAULT_FORM_ID = ${scriptJson(mappings[0]?.formId || 'form_1')};
      const TRACKING = window.ristakNativeTracking || {};

      const cssEscape = (value) => String(value || '').replace(/["\\\\]/g, '\\\\$&');
      const readCookie = (name) => {
        const escaped = String(name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        return (document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]+)')) || [])[1] || null;
      };
      const getParams = () => {
        try {
          return Object.fromEntries(new URL(window.location.href).searchParams.entries());
        } catch (_) {
          return {};
        }
      };
      const getFieldKey = (field, fallback) => (
        field.getAttribute('data-ristack-field') ||
        field.getAttribute('data-ristak-field') ||
        field.getAttribute('name') ||
        field.getAttribute('id') ||
        fallback
      );
      const readFieldValue = (field, form) => {
        const type = String(field.type || '').toLowerCase();
        if (type === 'checkbox') {
          const name = field.getAttribute('name');
          if (!name) return field.checked ? (field.value || 'true') : '';
          return Array.from(form.querySelectorAll('[name="' + cssEscape(name) + '"]'))
            .filter(item => item.checked)
            .map(item => item.value || 'true');
        }
        if (type === 'radio') {
          const name = field.getAttribute('name');
          const checked = name ? form.querySelector('[name="' + cssEscape(name) + '"]:checked') : (field.checked ? field : null);
          return checked ? checked.value : '';
        }
        if (field.tagName === 'SELECT' && field.multiple) {
          return Array.from(field.selectedOptions || []).map(option => option.value || option.textContent || '').filter(Boolean);
        }
        return field.value || '';
      };
      const collectRawFields = (form) => {
        const raw = {};
        const fields = Array.from(form.querySelectorAll('input, select, textarea'));
        fields.forEach((field, index) => {
          const type = String(field.type || '').toLowerCase();
          if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) return;
          const key = getFieldKey(field, 'field_' + (index + 1));
          if (!key) return;
          const value = readFieldValue(field, form);
          if (Array.isArray(value) ? value.length > 0 : String(value || '').trim()) {
            raw[key] = value;
          }
        });
        return raw;
      };
      const resolveFormId = (form, index) => (
        form.getAttribute('data-ristack-form') ||
        form.getAttribute('data-ristak-form') ||
        form.getAttribute('data-rstk-form-id') ||
        form.getAttribute('id') ||
        form.getAttribute('name') ||
        (FORMS[index] && FORMS[index].formId) ||
        DEFAULT_FORM_ID
      );
      const setMessage = (form, text, state) => {
        let message = form.querySelector('[data-rstk-import-message]');
        if (!message) {
          message = document.createElement('div');
          message.setAttribute('data-rstk-import-message', 'true');
          message.style.marginTop = '12px';
          message.style.font = '500 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          form.appendChild(message);
        }
        message.textContent = text;
        message.style.color = state === 'error' ? '#b91c1c' : '#166534';
      };

      Array.from(document.querySelectorAll('form')).forEach((form, index) => {
        form.setAttribute('data-rstk-import-form', 'true');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const submitter = event.submitter || form.querySelector('[type="submit"], button');
          if (submitter) submitter.disabled = true;
          setMessage(form, 'Enviando...', 'loading');
          try {
            const rawFields = collectRawFields(form);
            const response = await fetch('/api/sites/public/submit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                siteId: SITE_ID,
                importedFormId: resolveFormId(form, index),
                rawFields,
                meta: {
                  pageId: ${scriptJson(pageId || DEFAULT_FUNNEL_PAGE_ID)},
                  pageUrl: window.location.href,
                  referrer: document.referrer,
                  params: getParams(),
                  visitorId: TRACKING.visitorId || null,
                  sessionId: TRACKING.sessionId || null,
                  tracking: TRACKING,
                  fbp: readCookie('_fbp'),
                  fbc: readCookie('_fbc')
                }
              })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.success === false) {
              throw new Error(payload.error || 'No se pudo enviar el formulario');
            }
            const submission = payload.data || {};
            const metaEventId = submission.capi && submission.capi.eventId
              ? submission.capi.eventId
              : (submission.submissionId ? 'site_' + SITE_ID + '_' + submission.submissionId : '');
            if (window.ristakMetaTrackSiteSubmit) {
              window.ristakMetaTrackSiteSubmit(metaEventId, {
                status: submission.status || 'received',
                conversion_type: 'form_submit',
                imported_html: true
              }, submission.capi && submission.capi.eventName);
            }
            if (window.ristakNativeRememberContact && submission.contactId) {
              window.ristakNativeRememberContact({
                contactId: submission.contactId,
                fullName: submission.contactName || '',
                email: submission.contactEmail || ''
              });
            }
            form.reset();
            setMessage(form, submission.message || 'Listo. Recibimos tu informacion.', 'success');
            window.dispatchEvent(new CustomEvent('ristak:submitted', { detail: submission }));
          } catch (error) {
            setMessage(form, error && error.message ? error.message : 'No se pudo enviar el formulario', 'error');
          } finally {
            if (submitter) submitter.disabled = false;
          }
        });
      });
    })();
  </script>`
}

function buildImportedButtonActionScript(site, { pageId = DEFAULT_FUNNEL_PAGE_ID } = {}) {
  const pages = normalizeSitePages(site).map(page => ({
    id: page.id,
    title: page.title || page.id
  }))

  return `
  <script>
    (() => {
      const PAGES = ${scriptJson(pages)};
      const CURRENT_PAGE_ID = ${scriptJson(pageId || DEFAULT_FUNNEL_PAGE_ID)};
      const getPageHref = (targetPageId) => {
        if (!targetPageId) return '#';
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('page', targetPageId);
        return nextUrl.toString();
      };
      const getNextPageId = () => {
        const index = PAGES.findIndex(page => page.id === CURRENT_PAGE_ID);
        const next = index >= 0 ? PAGES[index + 1] : PAGES[1];
        return next ? next.id : '';
      };
      const showActionMessage = (button, text, state = 'success') => {
        const host = button.closest('form') || button.parentElement || document.body;
        let message = host.querySelector('[data-rstk-button-action-message]');
        if (!message) {
          message = document.createElement('div');
          message.setAttribute('data-rstk-button-action-message', 'true');
          message.style.marginTop = '12px';
          message.style.font = '600 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          host.appendChild(message);
        }
        message.textContent = text;
        message.style.color = state === 'error' ? '#b91c1c' : '#166534';
      };

      document.addEventListener('click', (event) => {
        const button = event.target && event.target.closest
          ? event.target.closest('[data-rstk-button-action]')
          : null;
        if (!button) return;

        const action = String(button.getAttribute('data-rstk-button-action') || '').trim();
        if (!action) return;

        if (action === 'none') {
          event.preventDefault();
          return;
        }

        if (action === 'submit') {
          const form = button.closest('form');
          if (!form) return;
          event.preventDefault();
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(button);
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
          return;
        }

        event.preventDefault();

        if (action === 'url') {
          const targetUrl = button.getAttribute('data-rstk-button-url') || button.getAttribute('href') || '';
          if (targetUrl) window.location.href = targetUrl;
          return;
        }

        if (action === 'next_page') {
          const nextPageId = getNextPageId();
          if (nextPageId) window.location.href = getPageHref(nextPageId);
          return;
        }

        if (action === 'specific_page') {
          const targetPageId = button.getAttribute('data-rstk-button-page-id') || '';
          if (targetPageId) window.location.href = getPageHref(targetPageId);
          return;
        }

        if (action === 'disqualify') {
          const targetPageId = button.getAttribute('data-rstk-button-page-id') || '';
          const message = button.getAttribute('data-rstk-button-message') || 'Gracias. Por ahora esta solicitud no califica.';
          window.dispatchEvent(new CustomEvent('ristak:disqualified', { detail: { message, pageId: CURRENT_PAGE_ID } }));
          if (targetPageId) {
            window.location.href = getPageHref(targetPageId);
          } else {
            showActionMessage(button, message, 'error');
          }
        }
      }, true);
    })();
  </script>`
}

async function buildImportedHtmlRuntimeInjection(site, imported, { trackingEnabled = true, pageId = DEFAULT_FUNNEL_PAGE_ID, pageTitle = '' } = {}) {
  const activePageId = cleanString(pageId) || DEFAULT_FUNNEL_PAGE_ID
  const metaPixelSnippet = await buildMetaPixelSnippet(site, trackingEnabled, { id: activePageId, title: pageTitle || site.title || site.name })
  const nativeTrackingScript = trackingEnabled
    ? buildNativeSiteTrackingScript({
      siteId: site.id,
      siteSlug: site.slug,
      siteName: site.name,
      siteType: site.siteType,
      pageId: activePageId,
      pageTitle: pageTitle || site.title || site.name,
      formSiteId: site.id,
      formSiteName: site.name,
      endpoint: '/collect'
    })
    : ''
  const buttonActionScript = buildImportedButtonActionScript(site, { pageId: activePageId })
  const captureScript = buildImportedFormCaptureScript(site, imported, { pageId: activePageId })
  return `${metaPixelSnippet}${nativeTrackingScript}${buttonActionScript}${captureScript}`
}

function injectImportedHtmlRuntime(html = '', injection = '') {
  html = html || '<!doctype html><html><body></body></html>'
  html = injectImportedStaticFallback(html)

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${injection}</body>`)
  }

  return `${html}${injection}`
}

function getImportedRenderPage(site, pageId = '') {
  const pages = normalizeSitePages(site)
  const requestedPageId = cleanString(pageId)
  return pages.find(page => page.id === requestedPageId) || pages[0] || null
}

function getImportedRenderPageByAssetPath(site, assetPath = '') {
  const normalizedAssetPath = normalizeImportedAssetPath(assetPath)
  if (!normalizedAssetPath) return null

  return normalizeSitePages(site).find(page => (
    normalizeImportedAssetPath(page.importedAssetPath || page.imported_asset_path) === normalizedAssetPath
  )) || null
}

async function renderImportedPublicSiteHtml(site, { pageId = '', trackingEnabled = true } = {}) {
  const imported = await getImportedSiteBySiteId(site.id)
  if (!imported) {
    return renderDomainErrorHtml({
      host: site.domain,
      message: 'La pagina importada no se encontro. Vuelve a subir el HTML desde Sites.'
    })
  }

  const activePage = getImportedRenderPage(site, pageId)
  const importedAssetPath = normalizeImportedAssetPath(activePage?.importedAssetPath || activePage?.imported_asset_path)
  let html = imported.htmlSanitized || imported.htmlOriginal || '<!doctype html><html><body></body></html>'

  if (importedAssetPath) {
    const asset = await getImportedSiteAssetByPath(site.id, importedAssetPath)
    if (asset && /^text\/html\b/i.test(asset.contentType)) {
      html = asset.content.toString('utf8')
    }
  }

  const injection = await buildImportedHtmlRuntimeInjection(site, imported, {
    trackingEnabled,
    pageId: activePage?.id || DEFAULT_FUNNEL_PAGE_ID,
    pageTitle: activePage?.title || site.title || site.name
  })
  return injectImportedHtmlRuntime(html, injection)
}

export async function getImportedSiteAssetResponse(siteId, assetPath, { trackingEnabled = true } = {}) {
  const site = await getImportedSiteForAsset(siteId)
  if (!site || !isImportedHtmlSite(site)) return null

  const asset = await getImportedSiteAssetByPath(site.id, assetPath)
  if (!asset) return null

  if (/^text\/html\b/i.test(asset.contentType)) {
    const imported = await getImportedSiteBySiteId(site.id)
    if (!imported) return null

    const page = getImportedRenderPageByAssetPath(site, asset.assetPath)
    const injection = await buildImportedHtmlRuntimeInjection(site, imported, {
      trackingEnabled,
      pageId: page?.id || DEFAULT_FUNNEL_PAGE_ID,
      pageTitle: page?.title || asset.assetPath
    })

    return {
      site,
      assetPath: asset.assetPath,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(injectImportedHtmlRuntime(asset.content.toString('utf8'), injection), 'utf8'),
      cacheControl: trackingEnabled ? 'public, max-age=300' : 'no-store'
    }
  }

  return {
    site,
    assetPath: asset.assetPath,
    contentType: asset.contentType,
    body: asset.content,
    cacheControl: trackingEnabled ? 'public, max-age=3600' : 'no-store'
  }
}

export async function renderPublicSiteHtml(site, { pageId, trackingEnabled = true } = {}) {
  if (isImportedHtmlSite(site)) {
    return renderImportedPublicSiteHtml(site, { pageId, trackingEnabled })
  }

  const theme = { ...DEFAULT_THEME, ...(site.theme || {}) }
  const template = resolveTemplate(site)
  const brand = getBrand(site, template)
  const isInteractive = site.siteType === 'interactive_form'
  const isLandingType = site.siteType === 'landing_page'
  const isStandardFormType = site.siteType === 'standard_form'
  const pages = normalizeSitePages(site)
  const requestedPageId = cleanString(pageId)
  const activePage = pages.find(page => page.id === requestedPageId) || pages[0]
  let blocks = isInteractive ? getInteractiveFormBlocks(site) : getPageBlocks(site, activePage?.id)
  if (isStandardFormType && activePage?.id === FORM_THANK_YOU_PAGE_ID && blocks.length === 0) {
    blocks = getDefaultFormThankYouBlocks(site.id)
  }
  if (isStandardFormType && activePage?.id === FORM_DISQUALIFIED_PAGE_ID && blocks.length === 0) {
    blocks = getDefaultFormDisqualifiedBlocks(site.id)
  }
  const fieldBlocks = collectFieldBlocks(blocks)
  const interactivePageIds = isInteractive
    ? pages
      .filter(page => blocks.some(block => getBlockPageId(block, pages) === page.id))
      .map(page => page.id)
    : []
  const interactivePageCount = interactivePageIds.length
  const interactiveInitialIndex = Math.max(0, interactivePageIds.indexOf(activePage?.id || ''))
  const standardFormContentPages = isStandardFormType ? getStandardFormContentPages(site) : []
  const standardFormContentPageIds = standardFormContentPages.map(page => page.id)
  const standardFormPageIndex = isStandardFormType ? standardFormContentPageIds.indexOf(activePage?.id || '') : -1
  const isStandardFormIntermediatePage = isStandardFormType && standardFormPageIndex >= 0 && standardFormPageIndex < standardFormContentPageIds.length - 1
  const standardFormNextPage = isStandardFormIntermediatePage ? standardFormContentPages[standardFormPageIndex + 1] : null
  const nativeFormContext = getNativeFormContext(site, blocks)
  const hasForm = fieldBlocks.length > 0
  const completionAction = isLandingType
    ? getFormCompletionAction(blocks)
    : isStandardFormType
      ? normalizeFormCompletionAction(theme.formCompletionAction || theme.form_completion_action, 'next_page')
      : 'form_default'
  const nextPage = (isLandingType || isStandardFormType) ? getNextPage(site, activePage?.id) : null
  const nextPageUrl = nextPage ? pageHref(nextPage.id) : ''
  const standardFormNextPageUrl = standardFormNextPage ? pageHref(standardFormNextPage.id) : ''
	  const disqualifiedPage = isStandardFormType ? pages.find(page => page.id === FORM_DISQUALIFIED_PAGE_ID) : null
	  const disqualifiedPageUrl = disqualifiedPage ? pageHref(disqualifiedPage.id) : ''
	  const submitText = cleanString(theme.submitText) || 'Enviar'
	  const submitSubtitle = cleanString(theme.submitSubtitle || theme.submitSubtext || theme.formButtonSubtitle)
	  const storedPageMaxWidth = Number(theme && theme.pageMaxWidth)
  const pageMaxWidth = isLandingType && storedPageMaxWidth === 1160
    ? 1440
    : themeNumber(theme, 'pageMaxWidth', isLandingType ? 1440 : (template.id === 'interactive' ? 600 : 520), 360, 1440)
  const pagePadding = themeNumber(theme, 'pagePadding', isLandingType ? 36 : 22, 0, 120)
  const pageRadius = themeNumber(theme, 'pageRadius', isLandingType ? 0 : 24, 0, 40)
  const pageBorderWidth = themeNumber(theme, 'pageBorderWidth', 0, 0, 12)
  const pageBorderPaint = themePaint(theme, 'pageBorderColor')
  const pageBorder = pageBorderPaint ? paintFallbackColor(pageBorderPaint, 'transparent') : 'transparent'
  const backgroundMediaType = cleanString(theme.backgroundMediaType) === 'video' ? 'video' : 'image'
  const rawBackgroundPaint = normalizeCssPaint(theme.backgroundColor, '')
  const backgroundPaint = rawBackgroundPaint.toLowerCase() === DEFAULT_THEME.backgroundColor ? '' : rawBackgroundPaint
  const pageImage = backgroundMediaType === 'video' ? '' : cssImageUrl(theme.backgroundImage)
  const pageVideo = backgroundMediaType === 'video' ? cssMediaUrl(theme.backgroundImage) : ''
  const pageOverlay = paintLayer(backgroundPaint)
  const pageBg = backgroundPaint && isCssColor(backgroundPaint) ? normalizeCssColor(backgroundPaint, '') : ''
  const rawTextPaint = normalizeCssPaint(site.theme?.textColor, '')
  const textPaint = rawTextPaint && (site.theme?.textColorCustom || rawTextPaint.toLowerCase() !== String(DEFAULT_THEME.textColor).toLowerCase()) ? rawTextPaint : ''
  const maxWidth = `${pageMaxWidth}px`
  const styleSheet = buildStyleSheet(template, maxWidth, resolveRenderOverrides(template, theme, isLandingType), {
    framePad: `${pagePadding}px`,
    pageBorder,
    pageBorderWidth: `${pageBorderWidth}px`,
    pageBg,
    pageImage,
    pageOverlay,
    pageImageSize: backgroundFitValue(theme.backgroundFit),
    pageImagePosition: backgroundPositionValue(theme.backgroundPosition),
    pageImageRepeat: backgroundRepeatValue(theme.backgroundRepeat),
    pageImageAttachment: backgroundAttachmentValue(theme.backgroundAttachment),
	    pageVideoFit: backgroundFitValue(theme.backgroundFit),
	    pageRadius: `${pageRadius}px`,
	    textPaint,
	    theme
	  })
  const footer = (hasForm && !isLandingType) ? renderLegalFooter(brand) : ''
  const bodyClass = [
    `rstk-tpl-${template.id}`,
    `rstk-${template.mode}`,
    `rstk-kind-${isLandingType ? 'landing' : 'form'}`,
	    template.centered ? 'rstk-centered' : '',
	    textPaint && isCssGradient(textPaint) ? 'rstkPageTextGradient' : '',
	    isInteractive ? 'rstk-interactive' : '',
	    `rstk-choice-${normalizeFormChoiceStyle(theme.formChoiceStyle)}`,
	    `rstk-select-${normalizeFormSelectStyle(theme.formSelectStyle)}`
	  ].filter(Boolean).join(' ')

	  const phoneLocale = await getAccountLocaleSettings().catch(() => ({ countryCode: 'MX', currency: 'MXN', dialCode: '52' }))
	  const renderContext = { site, pageId: activePage?.id, pages, isInteractive, isLandingType, isStandardForm: isStandardFormType, submitText, submitSubtitle, phoneLocale }
  const bodyBlocks = isLandingType
    ? renderLandingBlocks(blocks, renderContext)
    : blocks.map(block => renderPublicBlock(block, renderContext)).join('\n')
  const fieldBlockPageMap = isStandardFormType
    ? Object.fromEntries(
      collectFieldBlocks(Array.isArray(site.blocks) ? site.blocks : [])
        .map(block => [block.id, getBlockPageId(block, pages)])
    )
    : {}

  const submitArea = hasForm && !isLandingType
    ? `
      <div class="rstk-actions">
        ${isInteractive && interactivePageCount > 1 ? '<button type="button" class="rstk-secondary" data-back hidden>Anterior</button>' : ''}
        ${isInteractive && interactivePageCount > 1 ? '<button type="button" data-next>Siguiente</button>' : ''}
        ${isStandardFormIntermediatePage ? '<button type="button" data-form-next>Continuar</button>' : ''}
	        <button type="submit" ${isInteractive && interactivePageCount > 1 || isStandardFormIntermediatePage ? 'hidden' : ''} data-submit>${renderSubmitButtonContent(submitText, submitSubtitle)}</button>
      </div>
      <p class="rstk-submit-message" data-message role="status"></p>
    `
    : ''
  const nativeTrackingScript = trackingEnabled
    ? buildNativeSiteTrackingScript({
      siteId: site.id,
      siteSlug: site.slug,
      siteName: site.name,
      siteType: site.siteType,
      formSiteId: nativeFormContext.formSiteId,
      formSiteName: nativeFormContext.formSiteName,
      pageId: activePage?.id || '',
      pageTitle: activePage?.title || ''
    })
    : ''
  const metaPixelSnippet = await buildMetaPixelSnippet(site, trackingEnabled, activePage)

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(site.title || site.name)}</title>
  <meta name="description" content="${escapeHtml(site.description || '')}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${RSTK_GOOGLE_FONTS_HREF}" rel="stylesheet">
  <style>${styleSheet}</style>
</head>
<body class="${bodyClass}">
  <div class="rstk-frame">
    ${pageVideo ? `<video class="rstk-bg-video" src="${escapeHtml(pageVideo)}" autoplay muted loop playsinline aria-hidden="true"></video>` : ''}
    <main class="rstk-page">
      <div class="rstk-shell">
        ${isInteractive && hasForm && interactivePageCount > 1 ? `<div class="rstk-progress" data-progress><span class="rstk-progress-track"><span class="rstk-progress-fill" data-progress-fill></span></span><b data-progress-label>Pantalla ${interactiveInitialIndex + 1} de ${interactivePageCount}</b></div>` : ''}
        <form data-site-form data-site-id="${escapeHtml(site.id)}" data-page-id="${escapeHtml(activePage?.id || '')}" novalidate>
          ${bodyBlocks}
          ${submitArea}
        </form>
        ${footer}
      </div>
    </main>
  </div>
  <script>
    (() => {
      const form = document.querySelector('[data-site-form]');
      if (!form) return;
      const siteId = form.getAttribute('data-site-id');
      const pageId = form.getAttribute('data-page-id') || '';
      const fields = Array.from(form.querySelectorAll('.rstk-field'));
      const pageContents = Array.from(form.querySelectorAll('[data-interactive-page-content]'));
      const nextButton = form.querySelector('[data-next]');
      const formNextButton = form.querySelector('[data-form-next]');
      const backButton = form.querySelector('[data-back]');
      const submitButton = form.querySelector('[data-submit]');
      const message = form.querySelector('[data-message]');
      const progressLabel = document.querySelector('[data-progress-label]');
      const progressFill = document.querySelector('[data-progress-fill]');
      const isInteractive = ${isInteractive ? 'true' : 'false'};
      const isStandardForm = ${isStandardFormType ? 'true' : 'false'};
      const isStandardFormIntermediatePage = ${isStandardFormIntermediatePage ? 'true' : 'false'};
      const stepPages = ${JSON.stringify(interactivePageIds)};
      const standardFormPageIds = ${JSON.stringify(standardFormContentPageIds)};
      const targetBlockPageMap = ${JSON.stringify(fieldBlockPageMap)};
      const completionAction = ${JSON.stringify(completionAction)};
      const nextPageUrl = ${JSON.stringify(nextPageUrl)};
      const standardFormNextPageUrl = ${JSON.stringify(standardFormNextPageUrl)};
      const disqualifiedPageUrl = ${JSON.stringify(disqualifiedPageUrl)};
      let index = Math.max(0, stepPages.indexOf(pageId));
      const storageKey = 'rstk:form:' + siteId;

      const parseRule = (value) => {
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      };

      const phoneDigits = (value) => String(value || '').replace(/\\D/g, '');
      const stripInternationalPrefix = (digits) => digits.startsWith('00') ? digits.slice(2) : digits;
      const normalizeMexicoPhoneDigits = (digits) => {
        const national = digits.slice(-10);
        if (national.length !== 10) return '';
        if (digits.startsWith('521') && digits.length >= 13) return '52' + national;
        if (digits.startsWith('52') && digits.length >= 12) return '52' + national;
        return '';
      };
      const composePhoneValue = (value, dialCode) => {
        const raw = String(value || '').trim();
        const digits = stripInternationalPrefix(phoneDigits(raw));
        const countryCode = phoneDigits(dialCode).slice(0, 4);
        if (digits.length < 7) return '';
        const mexicoPhone = countryCode === '52' ? normalizeMexicoPhoneDigits(digits) : '';
        if (mexicoPhone) return '+' + mexicoPhone;
        if (!countryCode || raw.startsWith('+') || raw.startsWith('00')) return '+' + digits;
        if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) return '+' + digits;
        return '+' + countryCode + digits;
      };
      const optionExists = (select, countryCode) => Boolean(countryCode && select && select.querySelector('option[value="' + String(countryCode).replace(/["\\\\]/g, '\\\\$&') + '"]'));
      const detectPhoneCountry = (select) => {
        const locales = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
        for (const locale of locales) {
          const match = String(locale || '').match(/[-_]([A-Za-z]{2})\\b/);
          const country = match && match[1] ? match[1].toUpperCase() : '';
          if (optionExists(select, country)) return country;
        }
        const timezone = typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
        if (!timezone) return '';
        for (const option of Array.from(select.options || [])) {
          const timezones = String(option.dataset.timezones || '').split(',').filter(Boolean);
          if (timezones.indexOf(timezone) >= 0) return option.value;
        }
        return '';
      };
      const initPhoneCountryFields = () => {
        fields.forEach((field) => {
          if (field.getAttribute('data-field-type') !== 'phone') return;
          const select = field.querySelector('[data-phone-country-select]');
          if (!select) return;
          const detectedCountry = detectPhoneCountry(select);
          if (detectedCountry) select.value = detectedCountry;
        });
      };

      const readFieldValue = (field) => {
        const type = field.getAttribute('data-field-type');
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        }
        if (type === 'phone') {
          const input = field.querySelector('[data-phone-number-input]') || field.querySelector('input[type="tel"], input');
          const select = field.querySelector('[data-phone-country-select]');
          const dialCode = select && select.selectedOptions && select.selectedOptions[0]
            ? select.selectedOptions[0].dataset.dialCode || ''
            : '';
          return composePhoneValue(input ? input.value : '', dialCode);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return checked.value;
        const input = field.querySelector('input, textarea, select');
        return input ? input.value : '';
      };

      const writeFieldValue = (field, value) => {
        if (value === undefined || value === null) return;
        const type = field.getAttribute('data-field-type');
        if (type === 'checkboxes') {
          const selected = new Set(Array.isArray(value) ? value.map(String) : []);
          field.querySelectorAll('input[type="checkbox"]').forEach((input) => {
            input.checked = selected.has(input.value);
          });
          return;
        }
        if (type === 'radio') {
          field.querySelectorAll('input[type="radio"]').forEach((input) => {
            input.checked = String(value) === input.value;
          });
          return;
        }
        if (type === 'phone') {
          const input = field.querySelector('[data-phone-number-input]') || field.querySelector('input[type="tel"], input');
          if (input) input.value = String(value || '').replace(/^\\+/, '');
          return;
        }
        const input = field.querySelector('input, textarea, select');
        if (input) input.value = String(value || '');
      };

      const getCurrentResponses = () => {
        const responses = {};
        fields.forEach((field) => {
          responses[field.getAttribute('data-block-id')] = readFieldValue(field);
        });
        return responses;
      };

      const readStoredResponses = () => {
        if (!isStandardForm) return {};
        try {
          const raw = window.sessionStorage ? window.sessionStorage.getItem(storageKey) : '';
          const parsed = raw ? JSON.parse(raw) : {};
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
          return {};
        }
      };

      const writeStoredResponses = (responses) => {
        if (!isStandardForm) return;
        try {
          if (window.sessionStorage) window.sessionStorage.setItem(storageKey, JSON.stringify(responses || {}));
        } catch {}
      };

      const clearStoredResponses = () => {
        if (!isStandardForm) return;
        try {
          if (window.sessionStorage) window.sessionStorage.removeItem(storageKey);
        } catch {}
      };

      const hydrateStoredResponses = () => {
        if (!isStandardForm) return;
        const stored = readStoredResponses();
        fields.forEach((field) => {
          const blockId = field.getAttribute('data-block-id');
          if (Object.prototype.hasOwnProperty.call(stored, blockId)) {
            writeFieldValue(field, stored[blockId]);
          }
        });
      };

      const pageUrl = (targetPageId) => {
        if (!targetPageId) return '';
        const url = new URL(window.location.href);
        url.searchParams.set('page', targetPageId);
        return url.toString();
      };

      const readSelectedRules = (field) => {
        const type = field.getAttribute('data-field-type');
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked'))
            .map(input => parseRule(input.dataset.rule))
            .filter(Boolean);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return [parseRule(checked.dataset.rule)].filter(Boolean);
        const select = field.querySelector('select');
        if (select && select.selectedOptions && select.selectedOptions[0]) {
          return [parseRule(select.selectedOptions[0].dataset.rule)].filter(Boolean);
        }
        return [];
      };

      const validateField = (field) => {
        const required = field.getAttribute('data-required') === 'true';
        const value = readFieldValue(field);
        const valid = !required || (Array.isArray(value) ? value.length > 0 : String(value || '').trim() !== '');
        const error = field.querySelector('.rstk-error');
        if (error) error.hidden = valid;
        return valid;
      };

      const getCurrentPageId = () => stepPages[index] || pageId || '';
      const getPageFields = (targetPageId) => fields.filter((field) => {
        const fieldPageId = field.getAttribute('data-page-id') || '';
        return fieldPageId === targetPageId;
      });

      const renderStep = () => {
        if (!isInteractive || stepPages.length === 0) return;
        const currentPageId = getCurrentPageId();
        pageContents.forEach((content) => {
          const contentPageId = content.getAttribute('data-interactive-page-content') || '';
          content.hidden = contentPageId !== currentPageId;
        });
        if (backButton) backButton.hidden = index === 0;
        if (nextButton) nextButton.hidden = index >= stepPages.length - 1;
        if (submitButton) submitButton.hidden = index < stepPages.length - 1;
        if (progressLabel) progressLabel.textContent = 'Pantalla ' + (index + 1) + ' de ' + stepPages.length;
        if (progressFill) progressFill.style.width = (((index + 1) / stepPages.length) * 100) + '%';
      };

      nextButton && nextButton.addEventListener('click', () => {
        const currentFields = getPageFields(getCurrentPageId());
        if (!currentFields.every(validateField)) return;
        const rules = currentFields.flatMap((field) => readSelectedRules(field)).filter(item => item.action && item.action !== 'continue');
        const blockingRule = rules.find(item => item.action === 'show_message' || item.action === 'disqualify' || item.action === 'end_form' || item.action === 'redirect');
        if (blockingRule) {
          if (message) message.textContent = blockingRule.action === 'redirect' ? 'Enviando...' : (blockingRule.message || 'Gracias. Tu informacion fue recibida.');
          form.dataset.ruleSubmit = 'true';
          form.requestSubmit();
          return;
        }
        const jumpRule = rules.find(item => item.action === 'jump' && item.targetBlockId);
        if (jumpRule && jumpRule.targetBlockId) {
          const targetField = fields.find(field => field.getAttribute('data-block-id') === jumpRule.targetBlockId);
          const targetPageId = targetField ? targetField.getAttribute('data-page-id') || '' : '';
          const targetIndex = stepPages.indexOf(targetPageId);
          index = targetIndex >= 0 ? targetIndex : Math.min(index + 1, stepPages.length - 1);
        } else {
          index = Math.min(index + 1, stepPages.length - 1);
        }
        renderStep();
      });

      formNextButton && formNextButton.addEventListener('click', () => {
        const currentFields = fields;
        if (!currentFields.every(validateField)) return;
        const currentResponses = getCurrentResponses();
        const mergedResponses = { ...readStoredResponses(), ...currentResponses };
        const rules = currentFields.flatMap((field) => readSelectedRules(field)).filter(item => item.action && item.action !== 'continue');
        const blockingRule = rules.find(item => item.action === 'show_message' || item.action === 'disqualify' || item.action === 'end_form' || item.action === 'redirect');
        if (blockingRule) {
          writeStoredResponses(mergedResponses);
          if (message) message.textContent = blockingRule.action === 'redirect' ? 'Enviando...' : (blockingRule.message || 'Gracias. Tu informacion fue recibida.');
          form.dataset.ruleSubmit = 'true';
          form.requestSubmit();
          return;
        }

        writeStoredResponses(mergedResponses);
        const jumpRule = rules.find(item => item.action === 'jump' && item.targetBlockId);
        const targetPageId = jumpRule && jumpRule.targetBlockId ? targetBlockPageMap[jumpRule.targetBlockId] : '';
        const targetIndex = standardFormPageIds.indexOf(targetPageId);
        const currentIndex = standardFormPageIds.indexOf(pageId);
        const targetUrl = targetIndex >= 0 && targetIndex !== currentIndex
          ? pageUrl(targetPageId)
          : standardFormNextPageUrl;
        if (targetUrl) {
          window.location.href = targetUrl;
        }
      });

      backButton && backButton.addEventListener('click', () => {
        index = Math.max(index - 1, 0);
        renderStep();
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const ruleSubmit = form.dataset.ruleSubmit === 'true';
        const fieldsToValidate = ruleSubmit ? getPageFields(getCurrentPageId()) : fields;
        const valid = fieldsToValidate.every(validateField);
        if (!valid) {
          delete form.dataset.ruleSubmit;
          return;
        }

        const responses = isStandardForm
          ? { ...readStoredResponses(), ...getCurrentResponses() }
          : getCurrentResponses();

        const url = new URL(window.location.href);
        const params = Object.fromEntries(url.searchParams.entries());
        const nativeIdentity = window.ristakNativeIdentity ? window.ristakNativeIdentity() : {};
        const nativeTracking = window.ristakNativeBuildData ? window.ristakNativeBuildData({ conversion_type: 'form_submit' }) : null;
        if (submitButton) submitButton.disabled = true;
        if (formNextButton) formNextButton.disabled = true;
        if (message) message.textContent = 'Enviando...';

        try {
          const response = await fetch('/api/sites/public/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteId,
              pageId,
              responses,
              meta: {
                pageId,
                pageUrl: window.location.href,
                referrer: document.referrer,
                params,
                visitorId: nativeIdentity.visitorId || null,
                sessionId: nativeIdentity.sessionId || null,
                ruleSubmit,
                formFinalSubmit: isStandardForm && !ruleSubmit && !isStandardFormIntermediatePage,
                tracking: nativeTracking,
                fbp: (document.cookie.match(/(?:^|; )_fbp=([^;]+)/) || [])[1] || null,
                fbc: (document.cookie.match(/(?:^|; )_fbc=([^;]+)/) || [])[1] || null
              }
            })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.success === false) {
            throw new Error(data.error || 'No se pudo enviar el formulario');
          }
          const submission = data && data.data ? data.data : {};
          const metaEventId = submission.capi && submission.capi.eventId
            ? submission.capi.eventId
            : (submission.submissionId ? 'site_' + siteId + '_' + submission.submissionId : '');
          const metaEventName = submission.capi && submission.capi.eventName
            ? submission.capi.eventName
            : '';
          if (window.ristakMetaTrackSiteSubmit) {
            window.ristakMetaTrackSiteSubmit(metaEventId, {
              status: submission.status || 'submitted',
              conversion_type: 'form_submit'
            }, metaEventName);
          }
          form.reset();
          clearStoredResponses();
          initPhoneCountryFields();
          if (window.ristakNativeRememberContact && submission.contactId) {
            window.ristakNativeRememberContact({
              contactId: submission.contactId,
              fullName: submission.contactName || '',
              email: submission.contactEmail || ''
            });
          }
          index = 0;
          renderStep();
          if (submission.redirectUrl) {
            window.location.href = submission.redirectUrl;
            return;
          }
          const qualifies = submission.status !== 'disqualified';
          if (!qualifies && disqualifiedPageUrl && completionAction === 'next_page_if_qualified') {
            window.location.href = disqualifiedPageUrl;
            return;
          }
          if (nextPageUrl && (completionAction === 'next_page' || (completionAction === 'next_page_if_qualified' && qualifies))) {
            window.location.href = nextPageUrl;
            return;
          }
          if (message) message.textContent = (data && data.data && data.data.message) || ${JSON.stringify('Listo. Recibimos tu informacion.')};
        } catch (error) {
          if (message) message.textContent = error.message || 'No se pudo enviar el formulario';
        } finally {
          delete form.dataset.ruleSubmit;
          if (submitButton) submitButton.disabled = false;
          if (formNextButton) formNextButton.disabled = false;
        }
      });

      initPhoneCountryFields();
      hydrateStoredResponses();
      renderStep();
    })();
  </script>
  ${metaPixelSnippet}
  ${nativeTrackingScript}
</body>
</html>`
}

export function renderDomainErrorHtml({ host, message }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dominio no configurado</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f8fafc;
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(540px, calc(100% - 32px));
      border: 1px solid #dbe3ef;
      border-radius: 8px;
      background: #fff;
      padding: 28px;
      box-shadow: 0 22px 60px -42px rgba(15, 23, 42, 0.7);
    }
    h1 { margin: 0 0 10px; font-size: 1.45rem; }
    p { margin: 0; color: #64748b; line-height: 1.6; }
    code {
      display: inline-block;
      margin-top: 18px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #f1f5f9;
      color: #334155;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>Dominio no configurado</h1>
    <p>${escapeHtml(message || 'Este dominio no esta asociado a un site publicado y verificado en Ristak.')}</p>
    ${host ? `<code>${escapeHtml(host)}</code>` : ''}
  </main>
</body>
</html>`
}

function getClientIp(req) {
  const forwarded = cleanString(req.headers['x-forwarded-for']).split(',')[0]
  return forwarded || req.ip || req.socket?.remoteAddress || ''
}

function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function splitName(fullName) {
  const parts = cleanString(fullName).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
  }
}

function inferContactFromResponses(blocks, responseEntries) {
  const contact = {
    fullName: '',
    email: '',
    phone: ''
  }

  for (const block of blocks) {
    if (!FIELD_BLOCK_TYPES.has(block.blockType)) continue

    const label = cleanString(block.label).toLowerCase()
    const value = responseEntries[block.id]
    const normalizedValue = Array.isArray(value) ? value.join(', ') : cleanString(value)

    if (!normalizedValue) continue

    if (!contact.email && (
      block.blockType === 'email' ||
      label.includes('email') ||
      label.includes('correo') ||
      label.includes('mail')
    )) {
      contact.email = normalizeEmail(normalizedValue)
      continue
    }

    if (!contact.phone && (
      block.blockType === 'phone' ||
      label.includes('telefono') ||
      label.includes('teléfono') ||
      label.includes('celular') ||
      label.includes('whatsapp')
    )) {
      contact.phone = normalizedValue
      continue
    }

    if (!contact.fullName && (label.includes('nombre') || label.includes('name'))) {
      contact.fullName = normalizedValue
    }
  }

  return contact
}

function getBlockCustomFieldTarget(block) {
  const settings = block?.settings || {}
  const definitionId = cleanString(
    settings.customFieldDefinitionId ||
    settings.custom_field_definition_id ||
    settings.customFieldId ||
    settings.custom_field_id
  )
  const fieldKey = normalizeImportedFieldKey(
    settings.customFieldKey ||
    settings.custom_field_key ||
    settings.customFieldName ||
    settings.custom_field_name ||
    settings.internalName ||
    settings.internal_name ||
    block?.label,
    ''
  )

  if (!definitionId && !fieldKey) return null

  return {
    definitionId,
    fieldKey,
    label: cleanString(settings.customFieldLabel || settings.custom_field_label || block?.label || fieldKey),
    dataType: cleanString(settings.customFieldDataType || settings.custom_field_data_type || block?.blockType || 'text')
  }
}

function getNativeCustomFieldOptions(block) {
  if (!['dropdown', 'radio', 'checkboxes'].includes(block?.blockType)) return []
  return getBlockOptions(block).map(option => ({
    label: option.label,
    value: option.value
  }))
}

function buildNativeCustomFieldsFromResponses({ site, blocks = [], responses = {} }) {
  const pages = normalizeSitePages(site)
  const customFields = []

  for (const block of collectFieldBlocks(blocks)) {
    const target = getBlockCustomFieldTarget(block)
    if (!target) continue

    const value = responses[block.id]
    const isEmpty = Array.isArray(value) ? value.length === 0 : !cleanString(value)
    if (isEmpty) continue

    const pageId = getBlockPageId(block, pages)
    const fieldKey = target.fieldKey || normalizeImportedFieldKey(block.label || block.id, 'custom_field')

    customFields.push({
      id: target.definitionId || fieldKey,
      definitionId: target.definitionId || '',
      key: fieldKey,
      fieldKey,
      label: target.label || fieldKey,
      name: target.label || fieldKey,
      dataType: target.dataType,
      options: getNativeCustomFieldOptions(block),
      value,
      syncTarget: 'local',
      sourceType: 'native_site',
      sourceId: site.id,
      sourceSiteId: site.id,
      sourcePageId: pageId,
      sourceFormId: getNativeFormContext(site, blocks).formSiteId || site.id,
      sourceFormName: getNativeFormContext(site, blocks).formSiteName || site.name,
      sourceFieldId: block.id,
      sourceFieldName: cleanString(block.settings?.internalName || block.settings?.internal_name || block.id),
      sourceLabel: block.label || '',
      sourceContext: {
        siteType: site.siteType,
        blockType: block.blockType,
        native: true
      }
    })
  }

  return customFields
}

function buildNativeMappedCustomFields(customFields = []) {
  return customFields.reduce((acc, field) => {
    const key = cleanString(field.fieldKey || field.key || field.label)
    if (!key) return acc
    acc[key] = field.value
    return acc
  }, {})
}

async function upsertNativeContactCustomFields({ site, contactId, blocks, responses }) {
  if (!contactId) return []

  const customFields = buildNativeCustomFieldsFromResponses({ site, blocks, responses })
  if (!customFields.length) return []

  const preparedFields = await prepareContactCustomFieldsForStorage(customFields, {
    sourceType: 'native_site',
    sourceId: site.id,
    sourceSiteId: site.id,
    syncTarget: 'local'
  })
  const existing = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
  const merged = mergeContactCustomFields(
    parseContactCustomFields(existing?.custom_fields),
    preparedFields
  )

  await db.run(`
    UPDATE contacts SET
      custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    serializeContactCustomFieldsForDb(merged),
    contactId
  ])

  return preparedFields
}

async function findExistingContact({ email, phone }) {
  if (email) {
    const byEmail = await db.get(
      'SELECT id, phone, email, full_name, first_name, last_name FROM contacts WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [email]
    )
    if (byEmail) return byEmail
  }

  if (phone) {
    const byPhone = await findContactByPhoneCandidates(phone)
    if (byPhone) return byPhone
  }

  return null
}

async function upsertContactFromSubmission({ site, contact, meta }) {
  const email = normalizeEmail(contact.email)
  const phone = await normalizePhoneForAccount(contact.phone) || cleanString(contact.phone)
  const fullName = cleanString(contact.fullName) || email || phone || 'Lead de site'

  if (!email && !phone && !fullName) return null

  const existing = await findExistingContact({ email, phone })
  const contactId = existing?.id || `site_contact_${crypto.randomUUID()}`
  const phoneUpsert = await prepareContactPhoneUpsert({ contactId, phone })
  const names = splitName(fullName)
  const params = meta?.params || {}
  const visitorId = cleanString(meta?.visitorId || meta?.visitor_id)

  if (existing) {
    await db.run(`
      UPDATE contacts SET
        phone = COALESCE(NULLIF(phone, ''), ?),
        email = COALESCE(NULLIF(email, ''), ?),
        full_name = COALESCE(NULLIF(full_name, ''), ?),
        first_name = COALESCE(NULLIF(first_name, ''), ?),
        last_name = COALESCE(NULLIF(last_name, ''), ?),
        source = COALESCE(NULLIF(source, ''), ?),
        attribution_url = COALESCE(NULLIF(attribution_url, ''), ?),
        attribution_session_source = COALESCE(NULLIF(attribution_session_source, ''), ?),
        attribution_medium = COALESCE(NULLIF(attribution_medium, ''), ?),
        attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, ''), ?),
        attribution_ad_id = COALESCE(NULLIF(attribution_ad_id, ''), ?),
        visitor_id = COALESCE(NULLIF(visitor_id, ''), ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      phoneUpsert.phone || phone || null,
      email || null,
      fullName || null,
      names.firstName || null,
      names.lastName || null,
      `ristak_site:${site.slug}`,
      cleanString(meta?.pageUrl) || null,
      cleanString(params.utm_source || params.source) || null,
      cleanString(params.utm_medium) || null,
      cleanString(params.utm_content || params.ad_name) || null,
      cleanString(params.ad_id || params.utm_ad_id) || null,
      visitorId || null,
      contactId
    ])
    await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
    return contactId
  }

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      attribution_url, attribution_session_source, attribution_medium,
      attribution_ad_name, attribution_ad_id, visitor_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      email = COALESCE(NULLIF(contacts.email, ''), excluded.email),
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      visitor_id = COALESCE(NULLIF(contacts.visitor_id, ''), excluded.visitor_id),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    phoneUpsert.phone || phone || null,
    email || null,
    fullName,
    names.firstName || null,
    names.lastName || null,
    `ristak_site:${site.slug}`,
    cleanString(meta?.pageUrl) || null,
    cleanString(params.utm_source || params.source) || null,
    cleanString(params.utm_medium) || null,
    cleanString(params.utm_content || params.ad_name) || null,
    cleanString(params.ad_id || params.utm_ad_id) || null,
    visitorId || null
  ])

  await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
  return contactId
}

function normalizeSubmissionResponses(blocks, responses = {}) {
  const normalized = {}
  const errors = []

  for (const block of collectFieldBlocks(blocks)) {
    if (!FIELD_BLOCK_TYPES.has(block.blockType)) continue

    const rawValue = responses?.[block.id]
    let value = rawValue

    if (block.blockType === 'checkboxes') {
      value = Array.isArray(rawValue) ? rawValue.map(cleanString).filter(Boolean) : []
    } else if (block.blockType === 'phone') {
      value = normalizePhoneResponseValue(block, rawValue, responses)
    } else {
      value = cleanString(rawValue)
    }

    const missing = Array.isArray(value) ? value.length === 0 : !value
    if (block.required && missing) {
      errors.push(`${block.label || 'Pregunta'} es requerida`)
    }

    if (!missing) {
      if (block.blockType === 'email' && !normalizeEmail(value)) {
        errors.push(`${block.label || 'Correo electronico'} debe ser un correo valido`)
      }

      if (block.blockType === 'phone' && cleanString(value).replace(/[^\d]/g, '').length < 7) {
        errors.push(`${block.label || 'Telefono'} debe tener un telefono valido`)
      }

      if ((block.blockType === 'number' || block.blockType === 'currency') && !Number.isFinite(Number(value))) {
        errors.push(`${block.label || 'Numero'} debe ser numerico`)
      }

      if (block.blockType === 'date' && Number.isNaN(Date.parse(value))) {
        errors.push(`${block.label || 'Fecha'} debe tener una fecha valida`)
      }
    }

    if (['dropdown', 'radio', 'checkboxes'].includes(block.blockType)) {
      const optionValues = new Set(getBlockOptions(block).map(option => option.value))
      const selectedValues = Array.isArray(value) ? value : [value].filter(Boolean)
      for (const selectedValue of selectedValues) {
        if (optionValues.size > 0 && !optionValues.has(selectedValue)) {
          errors.push(`${block.label || 'Pregunta'} tiene una opcion invalida`)
          break
        }
      }
    }

    normalized[block.id] = value
  }

  return { responses: normalized, errors }
}

function evaluateSubmissionRules(blocks, responses = {}) {
  const fields = collectFieldBlocks(blocks)
  const tags = new Set()
  const categories = new Set()
  const actions = []
  let disqualified = false
  let message = ''
  let redirectUrl = ''

  for (const block of fields) {
    if (!['dropdown', 'radio', 'checkboxes'].includes(block.blockType)) continue

    const selectedValues = Array.isArray(responses[block.id])
      ? responses[block.id]
      : [responses[block.id]].filter(Boolean)

    if (selectedValues.length === 0) continue

    for (const option of getBlockOptions(block)) {
      if (!selectedValues.includes(option.value)) continue

      const action = option.action || 'continue'
      if (option.tag) tags.add(option.tag)
      if (option.category) categories.add(option.category)
      if (action === 'cold_lead') categories.add(option.category || 'frio')
      if (action === 'warm_lead') categories.add(option.category || 'tibio')
      if (action === 'hot_lead') categories.add(option.category || 'caliente')

      if (action !== 'continue' || option.tag || option.category) {
        actions.push({
          blockId: block.id,
          blockLabel: block.label,
          option: option.label,
          action,
          targetBlockId: option.targetBlockId || '',
          message: option.message || '',
          redirectUrl: option.redirectUrl || '',
          tag: option.tag || '',
          category: option.category || ''
        })
      }

      if (action === 'disqualify' || action === 'show_message' || action === 'disqualify_after_submit') {
        disqualified = true
        if (!message) {
          message = option.message || ''
        }
      }

      if (action === 'end_form' && !message) {
        message = option.message || 'Gracias. Tu informacion fue recibida.'
      }

      if (action === 'redirect' && !redirectUrl) {
        redirectUrl = safeHref(option.redirectUrl, '')
      }
    }
  }

  return {
    status: disqualified ? 'disqualified' : 'received',
    disqualified,
    message,
    redirectUrl,
    tags: Array.from(tags),
    categories: Array.from(categories),
    actions
  }
}

function normalizeForHash(value) {
  const normalized = cleanString(value).toLowerCase()
  return normalized || null
}

function normalizePhoneForHash(value) {
  const digits = cleanString(value).replace(/[^\d]/g, '')
  return digits || null
}

function hashValue(value, normalizer = normalizeForHash) {
  const normalized = normalizer(value)
  if (!normalized) return null
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function getSiteFinalMessage(site, ruleEvaluation) {
  if (ruleEvaluation.message) return ruleEvaluation.message

  const finalMessages = site?.theme?.finalMessages || site?.theme?.final_messages || {}
  if (ruleEvaluation.disqualified && finalMessages.disqualified) {
    return cleanString(finalMessages.disqualified)
  }

  return cleanString(finalMessages.success) || 'Listo. Recibimos tu informacion.'
}

async function logMetaEvent({ contactId, eventType, metaEventName, eventId, status, requestPayload, responsePayload, errorMessage }) {
  await db.run(`
    INSERT INTO meta_conversion_event_logs (
      contact_id, event_type, meta_event_name, event_id, status,
      request_payload, response_payload, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    contactId || null,
    eventType,
    metaEventName,
    eventId,
    status,
    requestPayload ? jsonString(requestPayload) : null,
    responsePayload ? jsonString(responsePayload) : null,
    errorMessage || null
  ])
}

async function sendSiteLeadMetaEvent({ site, submissionId, submittedPageId, contactId, contact, requestMeta }) {
  if (!site.metaCapiEnabled) {
    return { sent: false, reason: 'disabled' }
  }

  const eventName = getFormSubmitMetaEventName(site, submittedPageId)
  const eventId = `site_${site.id}_${submissionId}`
  if (eventName === SITE_META_NO_EVENT) {
    return { sent: false, reason: 'no_event_configured', eventId, eventName }
  }

  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuracion Meta para Sites CAPI: ${error.message}`)
    return null
  })
  const datasetId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  const accessToken = cleanString(metaConfig?.pixel_api_token || process.env.META_ACCESS_TOKEN || metaConfig?.access_token)

  if (!datasetId || !accessToken) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta Pixel/Dataset ID o Pixel API Token de Meta'
    })
    return { sent: false, reason: 'missing_meta_config', eventId, eventName }
  }

  const names = splitName(contact.fullName)
  const userData = {
    em: hashValue(contact.email),
    ph: hashValue(contact.phone, normalizePhoneForHash),
    fn: hashValue(names.firstName),
    ln: hashValue(names.lastName),
    external_id: hashValue(contactId),
    client_ip_address: requestMeta.ip || undefined,
    client_user_agent: requestMeta.userAgent || undefined,
    fbp: cleanString(requestMeta.meta?.fbp) || undefined,
    fbc: cleanString(requestMeta.meta?.fbc) || undefined
  }

  Object.keys(userData).forEach(key => {
    if (!userData[key]) delete userData[key]
  })

  if (!userData.em && !userData.ph && !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data', eventId, eventName }
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: cleanString(requestMeta.meta?.pageUrl) || `https://${site.domain}`,
        event_id: eventId,
        user_data: userData,
        custom_data: {
          source: 'ristak_site',
          site_id: site.id,
          site_name: site.name,
          content_name: site.title || site.name
        }
      }
    ]
  }

  const testEventCode = cleanString(await getAppConfig('meta_test_event_code') || process.env.META_TEST_EVENT_CODE)
  if (testEventCode) {
    payload.test_event_code = testEventCode
  }

  try {
    const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const responsePayload = await response.json().catch(() => ({}))

    if (!response.ok || responsePayload?.error) {
      throw new Error(responsePayload?.error?.message || `Meta CAPI ${response.status}`)
    }

    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    return { sent: true, eventId, eventName, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      errorMessage: error.message
    })
    return { sent: false, reason: 'meta_error', error: error.message, eventId, eventName }
  }
}

async function sendSitePageMetaEvent({ site, page, eventName, eventId, contactId, requestMeta }) {
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuracion Meta para evento de pagina Site: ${error.message}`)
    return null
  })
  const datasetId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  const accessToken = cleanString(metaConfig?.pixel_api_token || process.env.META_ACCESS_TOKEN || metaConfig?.access_token)

  if (!datasetId || !accessToken) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta Pixel/Dataset ID o Pixel API Token de Meta'
    })
    return { sent: false, reason: 'missing_meta_config', eventId, eventName }
  }

  const userData = {
    external_id: contactId ? hashValue(contactId) : undefined,
    client_ip_address: requestMeta.ip || undefined,
    client_user_agent: requestMeta.userAgent || undefined,
    fbp: cleanString(requestMeta.meta?.fbp) || undefined,
    fbc: cleanString(requestMeta.meta?.fbc) || undefined
  }

  Object.keys(userData).forEach(key => {
    if (!userData[key]) delete userData[key]
  })

  if (!userData.client_ip_address && !userData.client_user_agent && !userData.fbp && !userData.fbc && !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data', eventId, eventName }
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: cleanString(requestMeta.meta?.pageUrl) || `https://${site.domain}`,
        event_id: eventId,
        user_data: userData,
        custom_data: {
          source: 'ristak_site',
          conversion_type: 'page_view',
          site_id: site.id,
          site_name: site.name,
          public_page_id: page?.id || '',
          public_page_title: page?.title || '',
          content_name: page?.title || site.title || site.name
        }
      }
    ]
  }

  const testEventCode = cleanString(await getAppConfig('meta_test_event_code') || process.env.META_TEST_EVENT_CODE)
  if (testEventCode) {
    payload.test_event_code = testEventCode
  }

  try {
    const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const responsePayload = await response.json().catch(() => ({}))

    if (!response.ok || responsePayload?.error) {
      throw new Error(responsePayload?.error?.message || `Meta CAPI ${response.status}`)
    }

    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    return { sent: true, eventId, eventName, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      errorMessage: error.message
    })
    return { sent: false, reason: 'meta_error', error: error.message, eventId, eventName }
  }
}

async function recordNativeSiteConversionEvent({ site, blocks, submittedPageId, submissionId, contactId, contact, req, meta }) {
  const visitorId = cleanString(meta?.visitorId || meta?.visitor_id) || `site_visitor_${submissionId}`
  const sessionId = cleanString(meta?.sessionId || meta?.session_id) || `site_session_${submissionId}`
  const tracking = meta?.tracking && typeof meta.tracking === 'object' ? meta.tracking : {}
  const pages = normalizeSitePages(site)
  const page = pages.find(item => item.id === submittedPageId) || pages[0] || null
  const formContext = getNativeFormContext(site, blocks)

  const data = {
    ...tracking,
    tracking_source: 'native_site',
    site_id: site.id,
    site_slug: site.slug,
    site_name: site.name,
    site_type: site.siteType,
    form_site_id: formContext.formSiteId,
    form_site_name: formContext.formSiteName,
    public_page_id: submittedPageId || page?.id || '',
    public_page_title: page?.title || '',
    conversion_type: 'form_submit',
    submission_id: submissionId,
    url: cleanString(meta?.pageUrl) || tracking.url || `https://${site.domain || cleanString(meta?.host) || ''}`,
    referrer: cleanString(meta?.referrer) || tracking.referrer || null,
    contact_name: cleanString(contact?.fullName) || undefined
  }

  await createSession({
    session_id: sessionId,
    visitor_id: visitorId,
    contact_id: contactId || null,
    full_name: cleanString(contact?.fullName) || null,
    event_name: 'native_site_conversion',
    ts: Date.now(),
    data,
    ip: getClientIp(req),
    user_agent: req.headers['user-agent'] || ''
  })

  if (contactId) {
    linkVisitorToContact(visitorId, contactId, cleanString(contact?.fullName) || 'Lead de site')
      .then(() => unifyVisitorIds(contactId))
      .catch(error => {
        logger.warn(`No se pudo vincular visitor nativo ${visitorId} con contacto ${contactId}: ${error.message}`)
      })
  }
}

function isEmptyImportedValue(value) {
  if (Array.isArray(value)) return value.length === 0
  return !cleanString(value)
}

function normalizeImportedValue(value) {
  if (Array.isArray(value)) {
    return value.map(item => cleanString(item)).filter(Boolean)
  }

  if (value && typeof value === 'object') {
    return jsonString(value)
  }

  return cleanString(value)
}

function normalizeImportedRawFields(rawFields = {}) {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) return {}

  return Object.entries(rawFields).reduce((acc, [key, value]) => {
    const rawKey = cleanString(key)
    if (!rawKey) return acc
    const normalizedValue = normalizeImportedValue(value)
    if (isEmptyImportedValue(normalizedValue)) return acc
    acc[rawKey] = normalizedValue
    return acc
  }, {})
}

function getImportedFormMapping(imported, formId) {
  const mappings = Array.isArray(imported?.formMappings) ? imported.formMappings : []
  if (!mappings.length) return null

  const requested = normalizeImportedFieldKey(formId, '')
  return mappings.find(mapping => normalizeImportedFieldKey(mapping.formId, '') === requested) || mappings[0]
}

function getImportedRawFieldValue(rawFields = {}, mapping = {}) {
  const directKeys = [
    mapping.sourceName,
    mapping.fieldId,
    mapping.destinationKey
  ].map(cleanString).filter(Boolean)

  for (const key of directKeys) {
    if (Object.prototype.hasOwnProperty.call(rawFields, key)) {
      return { key, value: rawFields[key] }
    }
  }

  const normalizedLookup = new Map(
    Object.keys(rawFields).map(key => [normalizeImportedFieldKey(key, ''), key])
  )

  for (const key of directKeys) {
    const foundKey = normalizedLookup.get(normalizeImportedFieldKey(key, ''))
    if (foundKey) return { key: foundKey, value: rawFields[foundKey] }
  }

  return { key: '', value: null }
}

function inferImportedDataType(mapping = {}, value = '') {
  const type = normalizeImportedFieldKey(mapping.type || mapping.dataType, '')
  if (type === 'textarea') return 'textarea'
  if (type === 'select') return Array.isArray(value) ? 'multiselect' : 'select'
  if (['radio', 'dropdown'].includes(type)) return 'select'
  if (['checkbox', 'checkboxes'].includes(type)) return 'multiselect'
  if (['number', 'currency', 'date', 'time', 'email', 'phone'].includes(type)) return type
  if (Array.isArray(value)) return 'multiselect'
  return 'text'
}

function addImportedCustomField(customFields, field = {}, value, context = {}) {
  const key = normalizeImportedFieldKey(field.destinationKey || field.key || field.sourceName || field.label, 'custom_field')
  if (!key || isEmptyImportedValue(value)) return

  customFields.push({
    key,
    fieldKey: key,
    label: cleanString(field.label) || key,
    name: cleanString(field.label) || key,
    dataType: inferImportedDataType(field, value),
    options: Array.isArray(field.options) ? field.options : [],
    value,
    syncTarget: 'local',
    sourceType: 'imported_html',
    sourceId: context.importId || '',
    sourceSiteId: context.siteId || '',
    sourcePageId: DEFAULT_FUNNEL_PAGE_ID,
    sourceFormId: context.formId || '',
    sourceFormName: context.formTitle || '',
    sourceFieldId: cleanString(field.fieldId || field.id),
    sourceFieldName: cleanString(field.sourceName || field.name),
    sourceLabel: cleanString(field.label),
    sourceContext: {
      originalFilename: context.originalFilename || '',
      confidence: field.confidence ?? null,
      imported: true
    }
  })
}

function buildImportedSubmissionLayers({ site, imported, formId, rawFields }) {
  const formMapping = getImportedFormMapping(imported, formId)
  const mappedFields = {
    standard: {},
    custom: {},
    ignored: {}
  }
  const derivedFields = {}
  const customFields = []
  const consumedRawKeys = new Set()
  const context = {
    importId: imported?.id || '',
    siteId: site.id,
    formId: formMapping?.formId || formId || 'form_1',
    formTitle: formMapping?.formTitle || 'Formulario importado',
    originalFilename: imported?.originalFilename || ''
  }

  for (const field of Array.isArray(formMapping?.fields) ? formMapping.fields : []) {
    const { key: rawKey, value } = getImportedRawFieldValue(rawFields, field)
    if (!rawKey || isEmptyImportedValue(value)) continue

    consumedRawKeys.add(rawKey)
    const destinationType = field.ignored ? 'ignored' : cleanString(field.destinationType || field.saveMode || 'custom')
    const destinationKey = normalizeImportedFieldKey(field.destinationKey || field.sourceName || rawKey, 'custom_field')

    if (destinationType === 'ignored') {
      mappedFields.ignored[rawKey] = value
      continue
    }

    if (destinationType === 'standard' && IMPORTED_FORM_STANDARD_FIELDS.has(destinationKey)) {
      mappedFields.standard[destinationKey] = value
      continue
    }

    mappedFields.custom[destinationKey] = value
    addImportedCustomField(customFields, { ...field, destinationKey }, value, context)
  }

  for (const [rawKey, value] of Object.entries(rawFields)) {
    if (consumedRawKeys.has(rawKey) || isEmptyImportedValue(value)) continue
    const key = normalizeImportedFieldKey(rawKey, 'custom_field')
    const fallbackField = {
      destinationKey: key,
      sourceName: rawKey,
      name: rawKey,
      label: rawKey,
      type: Array.isArray(value) ? 'checkboxes' : 'text'
    }
    const inferred = inferImportedFieldDestination(fallbackField)

    if (inferred.destinationType === 'standard' && IMPORTED_FORM_STANDARD_FIELDS.has(inferred.destinationKey)) {
      mappedFields.standard[inferred.destinationKey] = value
      continue
    }

    const destinationKey = inferred.destinationType === 'custom' ? inferred.destinationKey : key
    mappedFields.custom[destinationKey] = value
    addImportedCustomField(customFields, {
      ...fallbackField,
      destinationKey,
      confidence: inferred.confidence
    }, value, context)
  }

  if (mappedFields.standard.full_name) {
    const names = splitName(mappedFields.standard.full_name)
    if (names.firstName && !mappedFields.standard.first_name) derivedFields.first_name = names.firstName
    if (names.lastName && !mappedFields.standard.last_name) derivedFields.last_name = names.lastName
  }

  if (!mappedFields.standard.full_name && (mappedFields.standard.first_name || mappedFields.standard.last_name)) {
    derivedFields.full_name = [mappedFields.standard.first_name, mappedFields.standard.last_name].map(cleanString).filter(Boolean).join(' ')
  }

  if (mappedFields.standard.email) {
    derivedFields.email = normalizeEmail(mappedFields.standard.email)
  }

  if (mappedFields.standard.phone) {
    derivedFields.phone = cleanString(mappedFields.standard.phone)
  }

  return {
    formMapping,
    rawFields,
    mappedFields,
    derivedFields,
    customFields
  }
}

async function upsertImportedContactFromSubmission({ site, contact, customFields, meta, imported, formMapping }) {
  const contactId = await upsertContactFromSubmission({ site, contact, meta })
  if (!contactId || !Array.isArray(customFields) || customFields.length === 0) return contactId

  const preparedFields = await prepareContactCustomFieldsForStorage(customFields, {
    sourceType: 'imported_html',
    sourceId: imported?.id || '',
    sourceSiteId: site.id,
    sourcePageId: DEFAULT_FUNNEL_PAGE_ID,
    sourceFormId: formMapping?.formId || meta?.importedFormId || '',
    sourceFormName: formMapping?.formTitle || '',
    syncTarget: 'local'
  })
  const existing = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
  const merged = mergeContactCustomFields(
    parseContactCustomFields(existing?.custom_fields),
    preparedFields
  )

  await db.run(`
    UPDATE contacts SET
      custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    serializeContactCustomFieldsForDb(merged),
    contactId
  ])

  return contactId
}

async function createImportedSubmissionFromRequest({ req, body, site, host }) {
  const imported = await getImportedSiteBySiteId(site.id)
  if (!imported) {
    const error = new Error('Importacion de HTML no encontrada')
    error.status = 404
    throw error
  }

  const importedFormId = cleanString(body.importedFormId || body.imported_form_id || body.formId || body.form_id || 'form_1')
  const rawFields = normalizeImportedRawFields(body.rawFields || body.raw_fields || body.responses || {})
  const layers = buildImportedSubmissionLayers({
    site,
    imported,
    formId: importedFormId,
    rawFields
  })
  const standard = layers.mappedFields.standard || {}
  const derived = layers.derivedFields || {}
  const fullName = cleanString(standard.full_name || derived.full_name || [
    standard.first_name || derived.first_name,
    standard.last_name || derived.last_name
  ].map(cleanString).filter(Boolean).join(' '))
  const rawPhone = standard.phone || derived.phone
  const contact = {
    fullName,
    email: normalizeEmail(standard.email || derived.email),
    phone: await normalizePhoneForAccount(rawPhone) || cleanString(rawPhone)
  }
  const meta = {
    ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
    host,
    importedHtml: true,
    importedFormId: layers.formMapping?.formId || importedFormId,
    importedFormTitle: layers.formMapping?.formTitle || '',
    userAgent: req.headers['user-agent'] || '',
    submittedAt: new Date().toISOString()
  }
  const contactId = await upsertImportedContactFromSubmission({
    site,
    contact,
    customFields: layers.customFields,
    meta,
    imported,
    formMapping: layers.formMapping
  })
  const submissionId = crypto.randomUUID()

  await db.run(`
    INSERT INTO public_site_submissions (
      id, site_id, contact_id, domain, response_json, raw_fields_json,
      mapped_fields_json, derived_fields_json, meta_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', CURRENT_TIMESTAMP)
  `, [
    submissionId,
    site.id,
    contactId,
    host,
    jsonString(layers.mappedFields),
    jsonString(layers.rawFields),
    jsonString(layers.mappedFields),
    jsonString(layers.derivedFields),
    jsonString(meta)
  ])

  const capi = await sendSiteLeadMetaEvent({
    site,
    submissionId,
    submittedPageId: DEFAULT_FUNNEL_PAGE_ID,
    contactId,
    contact,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })

  await recordNativeSiteConversionEvent({
    site,
    blocks: [],
    submittedPageId: DEFAULT_FUNNEL_PAGE_ID,
    submissionId,
    contactId,
    contact,
    req,
    meta
  }).catch(error => {
    logger.warn(`No se pudo registrar conversion nativa de HTML importado ${site.id}: ${error.message}`)
  })

  return {
    submissionId,
    siteId: site.id,
    contactId,
    contactName: contact.fullName,
    contactEmail: contact.email,
    status: 'received',
    message: 'Listo. Recibimos tu informacion.',
    rawFields: layers.rawFields,
    mappedFields: layers.mappedFields,
    derivedFields: layers.derivedFields,
    capi
  }
}

export async function createSubmissionFromRequest(req, body = {}) {
  const host = getRequestHost(req)
  const domainResolution = await resolveConnectedPublicDomainForHost(host)

  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message)
    error.status = domainResolution.status
    throw error
  }

  const submittedSiteId = cleanString(body.siteId)
  const site = submittedSiteId
    ? await getSite(submittedSiteId, { includeBlocks: false, includeSubmissions: false })
    : await findSiteByRoutePath(req.path)

  if (!site) {
    const error = new Error('Site publico no encontrado')
    error.status = 404
    throw error
  }

  if (site.status !== 'published') {
    const error = new Error('Este site no esta publicado')
    error.status = 404
    throw error
  }

  site.domain = domainResolution.domain || host
  if (isImportedHtmlSite(site)) {
    return createImportedSubmissionFromRequest({ req, body, site, host })
  }

  site.blocks = await hydrateEmbeddedForms(await listSiteBlocks(site.id))

  const blocks = Array.isArray(site.blocks) && site.blocks.length
    ? site.blocks
    : await hydrateEmbeddedForms(await listSiteBlocks(site.id))
  const submittedPageId = cleanString(body.pageId || body.page_id || body.meta?.pageId || body.meta?.page_id)
  const isFinalStandardFormSubmit = site.siteType === 'standard_form' && normalizeBoolean(
    body.finalSubmit ||
    body.final_submit ||
    body.meta?.formFinalSubmit ||
    body.meta?.form_final_submit
  )
  const siteWithBlocks = { ...site, blocks }
  const orderedSubmissionBlocks = site.siteType === 'interactive_form'
    ? getInteractiveFormBlocks(siteWithBlocks)
    : blocks
  const submissionBlocks = site.siteType === 'standard_form'
    ? isFinalStandardFormSubmit
      ? getStandardFormContentBlocks(siteWithBlocks, blocks)
      : submittedPageId
        ? getPageBlocks(siteWithBlocks, submittedPageId)
        : orderedSubmissionBlocks
    : site.siteType === 'landing_page' && submittedPageId
      ? getPageBlocks(siteWithBlocks, submittedPageId)
      : orderedSubmissionBlocks
  const { responses, errors } = normalizeSubmissionResponses(submissionBlocks, body.responses || {})
  if (errors.length) {
    const error = new Error(errors.join(', '))
    error.status = 400
    throw error
  }

  const ruleEvaluation = evaluateSubmissionRules(submissionBlocks, responses)

  const meta = {
    ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
    host,
    rules: ruleEvaluation,
    userAgent: req.headers['user-agent'] || '',
    submittedAt: new Date().toISOString()
  }
  const inferredContact = inferContactFromResponses(collectFieldBlocks(submissionBlocks), responses)
  const contactId = await upsertContactFromSubmission({ site, contact: inferredContact, meta })
  const preparedCustomFields = await upsertNativeContactCustomFields({
    site,
    contactId,
    blocks: submissionBlocks,
    responses
  })
  const mappedFields = preparedCustomFields.length
    ? { custom: buildNativeMappedCustomFields(preparedCustomFields) }
    : {}
  const submissionId = crypto.randomUUID()

  await db.run(`
    INSERT INTO public_site_submissions (
      id, site_id, contact_id, domain, response_json, mapped_fields_json, meta_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    submissionId,
    site.id,
    contactId,
    host,
    jsonString(responses),
    jsonString(mappedFields),
    jsonString(meta),
    ruleEvaluation.status
  ])

  const capi = await sendSiteLeadMetaEvent({
    site,
    submissionId,
    submittedPageId,
    contactId,
    contact: inferredContact,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })

  await recordNativeSiteConversionEvent({
    site,
    blocks: submissionBlocks,
    submittedPageId,
    submissionId,
    contactId,
    contact: inferredContact,
    req,
    meta
  }).catch(error => {
    logger.warn(`No se pudo registrar conversion nativa de site ${site.id}: ${error.message}`)
  })

  return {
    submissionId,
    siteId: site.id,
    contactId,
    contactName: inferredContact.fullName || '',
    contactEmail: inferredContact.email || '',
    contactPhone: inferredContact.phone || '',
    status: ruleEvaluation.status,
    message: getSiteFinalMessage(site, ruleEvaluation),
    redirectUrl: ruleEvaluation.redirectUrl || '',
    rules: ruleEvaluation,
    capi
  }
}

export async function createMetaPageEventFromRequest(req, body = {}) {
  const host = getRequestHost(req)
  const domainResolution = await resolveConnectedPublicDomainForHost(host)

  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message)
    error.status = domainResolution.status
    throw error
  }

  const siteId = cleanString(body.siteId || body.site_id)
  if (!siteId) {
    const error = new Error('Site requerido')
    error.status = 400
    throw error
  }

  const site = await getSite(siteId, { includeBlocks: false, includeSubmissions: false })
  if (!site) {
    const error = new Error('Site publico no encontrado')
    error.status = 404
    throw error
  }

  if (site.status !== 'published') {
    const error = new Error('Este site no esta publicado')
    error.status = 404
    throw error
  }

  site.domain = domainResolution.domain || host

  if (!site.metaCapiEnabled) {
    return { sent: false, reason: 'site_disabled' }
  }

  const pageId = cleanString(body.pageId || body.page_id)
  const pageMeta = getPageMetaConfig(site, pageId)
  if (!pageMeta || pageMeta.trigger !== 'page_view') {
    return { sent: false, reason: 'page_event_disabled' }
  }

  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {}
  const eventId = cleanString(body.eventId || body.event_id) || `site_page_${site.id}_${pageMeta.page.id}_${crypto.randomUUID()}`
  const contactId = cleanString(body.contactId || body.contact_id)

  return sendSitePageMetaEvent({
    site,
    page: pageMeta.page,
    eventName: pageMeta.eventName,
    eventId,
    contactId,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })
}
