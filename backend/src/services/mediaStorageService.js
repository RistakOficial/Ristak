import crypto from 'crypto'
import fetch from 'node-fetch'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { promises as fs } from 'fs'
import { createReadStream } from 'fs'
import { Transform } from 'node:stream'
import { dirname, extname, join } from 'path'
import { fileURLToPath } from 'url'
import { databaseDialect, db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { compressMediaBuffer } from './mediaCompressionService.js'
import { createRistakId } from '../utils/idGenerator.js'
import { DEFAULT_TIMEZONE, businessTodayDateOnly, getAccountTimezone } from '../utils/dateUtils.js'
import {
  assertSafeOutboundMediaUrl,
  createSafeOutboundMediaHttpsAgent
} from './outboundMediaReferenceService.js'
import { resolveCentralBrokerConfig } from './centralBrokerService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const GB = 1024 * 1024 * 1024
const LOCAL_MEDIA_ROOT = join(__dirname, '../../uploads/media-storage')
const BUNNY_CORE_API_BASE_URL = 'https://api.bunny.net'
const BUNNY_STREAM_API_BASE_URL = 'https://video.bunnycdn.com'
const BUNNY_STREAM_TUS_UPLOAD_URL = 'https://video.bunnycdn.com/tusupload'
const BUNNY_STREAM_TUS_AUTH_TTL_SECONDS = 24 * 60 * 60
const BUNNY_STREAM_TUS_STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000
const BUNNY_STREAM_FAILED_STATUSES = new Set([5, 6])
const DEFAULT_BUNNY_STREAM_LIBRARY_NAME = 'Ristak Sites & Forms'
const DEFAULT_BUNNY_STREAM_COLLECTION_NAME = 'Ristak Sites & Forms'
const DEFAULT_CLIENT_ACCOUNT_ID = 'default'
const CLIENT_ACCOUNT_ROOT_FOLDER = 'accounts'
const CENTRAL_STORAGE_CONFIG_TTL_MS = Math.max(
  30_000,
  Number(process.env.MEDIA_CENTRAL_CONFIG_TTL_MS || 5 * 60 * 1000) || 5 * 60 * 1000
)
const BUNNY_STREAM_COLLECTION_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.BUNNY_STREAM_COLLECTION_CACHE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000
)
const BUNNY_STREAM_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.BUNNY_STREAM_TIMEOUT_MS || 120_000) || 120_000
)
// A partir de este tamaño (y SIEMPRE para video) la subida se transmite a Bunny
// directo desde disco, sin cargar el archivo completo en RAM ni recomprimir con
// ffmpeg. Esto evita los crashes/OOM (502) en instancias con poca memoria.
const MEDIA_STREAMING_THRESHOLD_BYTES = Math.max(
  4 * 1024 * 1024,
  Number(process.env.MEDIA_STREAMING_THRESHOLD_BYTES || 48 * 1024 * 1024) || 48 * 1024 * 1024
)
const BUNNY_FILE_UPLOAD_BASE_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.BUNNY_FILE_UPLOAD_TIMEOUT_MS || 0) || 0
)
const BUNNY_FILE_UPLOAD_MAX_TIMEOUT_MS = 30 * 60_000
const BUNNY_FILE_DELETE_TIMEOUT_MS = 30_000
// Solo necesitamos los primeros bytes para detectar el tipo real del archivo.
const MEDIA_HEADER_SAMPLE_BYTES = 64 * 1024
const MEDIA_LIBRARY_DEFAULT_LIMIT = 50
const MEDIA_LIBRARY_MAX_LIMIT = 100
const MEDIA_FOLDER_DEFAULT_LIMIT = 100
const MEDIA_FOLDER_MAX_LIMIT = 100
const MEDIA_SELECTION_MAX_EXPLICIT_IDS = 500
const MEDIA_SELECTION_MAX_FOLDER_PATHS = 50
const MEDIA_SELECTION_MAX_RESOLVED_ITEMS = 2_000
const MEDIA_REMOTE_SELECTION_MAX_ITEMS = 25
const MEDIA_REMOTE_SELECTION_MAX_ITEM_BYTES = 64 * 1024 * 1024
const MEDIA_REMOTE_SELECTION_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MEDIA_REMOTE_SELECTION_TIME_BUDGET_MS = 60_000
const MEDIA_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const MEDIA_LIBRARY_CURSOR_FALLBACK_TIMESTAMP = '1970-01-01 00:00:00'
const MEDIA_LIBRARY_LIST_COLUMNS = `
  id,
  business_id,
  user_id,
  original_filename,
  stored_filename,
  bunny_path,
  folder_path,
  public_url,
  private_url,
  mime_type,
  media_type,
  extension,
  size_original,
  size_processed,
  quota_size,
  width,
  height,
  duration,
  status,
  storage_provider,
  storage_zone,
  cdn_base_url,
  module,
  module_entity_id,
  is_public,
  metadata_json,
  stream_video_id,
  created_at,
  updated_at,
  deleted_at
`

let centralStorageConfigCache = {
  expiresAt: 0,
  env: null,
  promise: null
}
let bunnyStreamLibraryProvisionCache = {
  key: '',
  expiresAt: 0,
  promise: null
}
const bunnyStreamCollectionCache = new Map()

const BUNNY_STREAM_MEDIA_MODULES = new Set(['sites', 'forms', 'landing'])
const RESUMABLE_VIDEO_MIME_BY_EXTENSION = new Map([
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
  ['3gp', 'video/3gpp']
])

const BUNNY_STREAM_STATUS_LABELS = new Map([
  [0, 'created'],
  [1, 'uploaded'],
  [2, 'processing'],
  [3, 'transcoding'],
  [4, 'finished'],
  [5, 'error'],
  [6, 'upload_failed'],
  [7, 'jit_segmenting'],
  [8, 'jit_playlists_created']
])

const MEDIA_MODULES = new Set([
  'chat',
  'products',
  'sites',
  'forms',
  'courses',
  'appointments',
  'landing',
  'business_settings',
  'documents',
  'automations',
  'whatsapp',
  'avatars',        // fotos de perfil de contactos rehospedadas (subcarpeta por canal)
  'ad_creatives',   // creativos de anuncios (Meta Ads) rehospedados
  'other'
])

const MIME_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/3gp': '3gp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip'
}

const ALLOWED_MIME_TYPES = new Set(Object.keys(MIME_EXTENSION))

// `file-type` reconoce el brand `M4A ` que escribe AVAudioRecorder como
// `audio/x-m4a`. El cliente iOS declara correctamente `audio/mp4`, pero la
// detección por magic bytes tiene prioridad y antes terminaba rechazando el
// preview con unsupported_media_type. Guardamos todos los alias M4A bajo el
// MIME IANA canónico para que chat, Bunny y los navegadores reciban un contrato
// estable sin debilitar la validación del contenido.
const MIME_TYPE_ALIASES = new Map([
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4']
])

function nowIso() {
  return new Date().toISOString()
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function optionalNumberValue(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function boolValue(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return /^(1|true|yes|si|on)$/i.test(String(value).trim())
}

function cleanString(value = '') {
  return String(value || '').trim()
}

function normalizeBusinessId(value = '') {
  const clean = cleanString(value || process.env.RISTAK_BUSINESS_ID || 'default')
  return clean.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'default'
}

function normalizeClientAccountId(value = '', fallback = DEFAULT_CLIENT_ACCOUNT_ID) {
  const clean = cleanString(value || fallback)
  return clean.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || fallback
}

function normalizeClientUploadId(value = '') {
  const clean = cleanString(value)
  return clean.replace(/[^a-zA-Z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160)
}

function buildClientAccountRootPath(accountId = DEFAULT_CLIENT_ACCOUNT_ID) {
  return [CLIENT_ACCOUNT_ROOT_FOLDER, normalizeClientAccountId(accountId)].join('/')
}

// ── Slug legible, estable y ÚNICO por cuenta (carpeta raíz en el Bunny central) ──
// Todas las instalaciones comparten el MISMO Bunny, así que la carpeta de cada
// cliente debe ser: (1) legible para navegar la bodega ("alexis-fitness-a1b2c3")
// y (2) única, para que dos instalaciones jamás se pisen ni mezclen datos entre
// clientes. Por eso el slug = nombre-del-negocio + sufijo corto determinístico
// derivado del id real de la cuenta.
const ACCOUNT_SLUG_CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.ACCOUNT_SLUG_CACHE_TTL_MS || 5 * 60 * 1000) || 5 * 60 * 1000
)
// Caché keyeado por cuenta: dos ids distintos (p.ej. una subida que resuelve el
// locationId real y otra que cae a 'default') NUNCA deben contaminarse entre sí.
const accountSlugCache = new Map()
const accountSlugInflight = new Map()

export function resetAccountSlugCache() {
  accountSlugCache.clear()
  accountSlugInflight.clear()
}

function slugifyAccountName(value = '') {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function shortAccountSuffix(accountId = '') {
  // Sufijo corto y estable derivado del id real de la cuenta: garantiza unicidad
  // en el Bunny compartido sin que las instalaciones tengan que coordinarse.
  const seed = cleanString(accountId) || DEFAULT_CLIENT_ACCOUNT_ID
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 6)
}

// El subdominio del install (RENDER_EXTERNAL_URL) ES el app_name único que el
// installer le asignó: marcomaxilofacial.onrender.com → "marcomaxilofacial".
// Legible y único por instalación, sin depender de la base del cliente.
function slugFromInstallHost() {
  const url = cleanString(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || process.env.APP_URL)
  if (!url) return ''
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname
    const sub = host.split('.')[0]
    // Subdominios genéricos no identifican al cliente.
    if (!sub || ['www', 'app', 'localhost', '127', 'staging'].includes(sub.toLowerCase())) return ''
    return slugifyAccountName(sub)
  } catch {
    return ''
  }
}

export async function resolveAccountSlug(accountId = DEFAULT_CLIENT_ACCOUNT_ID) {
  const key = normalizeClientAccountId(accountId)
  const cached = accountSlugCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const inflight = accountSlugInflight.get(key)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      // 1) Un slug ya guardado manda (estable: no cambia aunque cambie el nombre
      //    del negocio, para no romper rutas ya creadas). Editable desde el panel.
      const row = await db
        .get('SELECT account_slug, account_label FROM storage_settings WHERE id = 1')
        .catch(() => null)
      let slug = cleanString(row?.account_slug)
      let label = cleanString(row?.account_label)

      if (!slug) {
        // Fuente del slug, en cascada (de más confiable a menos):
        const userRow = await db
          .get('SELECT business_name FROM users ORDER BY id ASC LIMIT 1')
          .catch(() => null)
        const businessName = cleanString(userRow?.business_name)
        // 2) Env explícita que el installer puede inyectar (app_name). Ya única.
        const envSlug = slugifyAccountName(process.env.RISTAK_ACCOUNT_SLUG || process.env.ACCOUNT_SLUG || '')
        // 3) Subdominio del propio install. Ya único y legible.
        const hostSlug = slugFromInstallHost()
        // 4) Nombre del negocio (puede repetirse entre clientes → + sufijo).
        const nameBase = slugifyAccountName(businessName)

        let persist = true
        if (envSlug) {
          slug = envSlug
          label = businessName || envSlug
        } else if (hostSlug) {
          slug = hostSlug
          label = businessName || hostSlug
        } else if (nameBase) {
          // Homónimos en el Bunny compartido jamás se pisan gracias al sufijo.
          slug = `${nameBase}-${shortAccountSuffix(accountId)}`
          label = businessName
        } else {
          // Sin nada legible → id técnico tal cual (ya es único). No se persiste
          // para que se "cure" al slug legible en cuanto haya identidad.
          slug = normalizeClientAccountId(accountId)
          persist = false
        }

        if (persist) {
          await db
            .run(
              'UPDATE storage_settings SET account_slug = ?, account_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
              [normalizeClientAccountId(slug), label]
            )
            .catch(() => {})
        }
      }

      const value = { slug: normalizeClientAccountId(slug), label }
      accountSlugCache.set(key, { value, expiresAt: Date.now() + ACCOUNT_SLUG_CACHE_TTL_MS })
      return value
    } finally {
      accountSlugInflight.delete(key)
    }
  })()

  accountSlugInflight.set(key, promise)
  return promise
}

function normalizeClientAccountContext(input = {}) {
  const id = normalizeClientAccountId(input.id || input.clientAccountId || input.client_account_id || input.accountId || input.account_id || input.locationId || input.location_id)
  // Si ya viene un slug/rootPath resuelto (contexto legible por cliente) se
  // respeta; si no, caemos al esquema legacy accounts/<id> por compatibilidad.
  const slug = cleanString(input.slug) ? normalizeClientAccountId(input.slug, '') : ''
  const rootPath = cleanString(input.rootPath)
    || (slug ? [CLIENT_ACCOUNT_ROOT_FOLDER, slug].join('/') : buildClientAccountRootPath(id))
  const context = { id, rootPath }
  if (slug) context.slug = slug
  const label = cleanString(input.label)
  if (label) context.label = label
  return context
}

function normalizeModule(value = '') {
  const clean = cleanString(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  return MEDIA_MODULES.has(clean) ? clean : 'other'
}

// ── _LEEME.txt por cuenta: documenta la bodega (orden total + docs, como se pidió) ──
// Se escribe una vez por cuenta y por proceso, best-effort: jamás debe tumbar ni
// frenar una subida real. Es solo un archivo de texto para que al navegar el Bunny
// se entienda de quién es la carpeta y qué hay en cada categoría.
const accountReadmeWritten = new Set()

export function resetAccountReadmeCache() {
  accountReadmeWritten.clear()
}

const STORAGE_CATEGORY_LEGEND = [
  ['avatars', 'Fotos de perfil de los contactos (subcarpeta por canal: whatsapp/ instagram/ messenger/)'],
  ['sites', 'Imágenes y videos de las páginas/sitios'],
  ['forms', 'Archivos subidos en formularios'],
  ['products', 'Fotos de productos'],
  ['chat', 'Adjuntos de las conversaciones (WhatsApp, etc.)'],
  ['automations', 'Adjuntos de las automatizaciones'],
  ['ad_creatives', 'Creativos de los anuncios (Meta Ads)'],
  ['business_settings', 'Logos y branding del negocio'],
  ['documents', 'Documentos varios'],
  ['courses', 'Material de cursos'],
  ['appointments', 'Archivos de citas/agenda']
]

export function buildAccountReadmeContent(clientAccount = {}) {
  const label = cleanString(clientAccount.label) || cleanString(clientAccount.slug) || cleanString(clientAccount.id) || 'Cuenta'
  const slug = cleanString(clientAccount.slug) || normalizeClientAccountId(clientAccount.id)
  const lines = [
    'BODEGA RISTAK',
    `Cuenta: ${label}`,
    `Carpeta: accounts/${slug}/   (id interno: ${cleanString(clientAccount.id) || 'default'})`,
    '',
    'Todo lo que Ristak guarda de esta cuenta vive aquí, ordenado por categoría.',
    'Generado automáticamente por Ristak — no lo edites ni lo borres a mano.',
    '',
    'Categorías (aparecen solo cuando hay archivos):',
    ...STORAGE_CATEGORY_LEGEND.map(([folder, desc]) => `  ${`${folder}/`.padEnd(20)} ${desc}`),
    ''
  ]
  return lines.join('\n')
}

async function ensureAccountReadme(config, clientAccount) {
  try {
    if (!config?.bunnyConfigured) return
    const rootPath = cleanString(clientAccount?.rootPath) || buildClientAccountRootPath(clientAccount?.id)
    if (accountReadmeWritten.has(rootPath)) return
    const objectPath = `${rootPath}/_LEEME.txt`
    const buffer = Buffer.from(buildAccountReadmeContent(clientAccount), 'utf8')
    await uploadToBunny({ config, objectPath, buffer, mimeType: 'text/plain; charset=utf-8' })
    accountReadmeWritten.add(rootPath)
  } catch (err) {
    // Documentación best-effort: si falla, se reintenta en la siguiente subida.
    logger.warn(`[MediaStorage] No se pudo escribir _LEEME.txt: ${err?.message || err}`)
  }
}

function sanitizeFilename(filename = 'archivo') {
  const fallback = 'archivo'
  const clean = cleanString(filename)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return clean || fallback
}

function filenameBase(filename = 'archivo') {
  const safe = sanitizeFilename(filename)
  const extension = extname(safe)
  const base = extension ? safe.slice(0, -extension.length) : safe
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'archivo'
}

function normalizeBaseUrl(value = '') {
  const clean = cleanString(value).replace(/\/+$/, '')
  return clean
}

function applyRuntimeEnvFallback(key, value) {
  const clean = cleanString(value)
  if (!clean || cleanString(process.env[key])) return
  process.env[key] = clean
}

function publicBaseUrl() {
  return normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '')
}

function buildAppPublicUrl(pathname) {
  const base = publicBaseUrl()
  return base ? `${base}${pathname}` : pathname
}

function mimeBase(mimeType = '') {
  const base = cleanString(mimeType).split(';')[0].toLowerCase()
  return MIME_TYPE_ALIASES.get(base) || base
}

function storageMimeType(mimeType = '') {
  const clean = cleanString(mimeType).toLowerCase()
  const base = mimeBase(clean)
  if (base === 'audio/ogg' && /(?:^|;)\s*codecs\s*=\s*"?opus"?(?:;|$)/i.test(clean)) {
    return 'audio/ogg; codecs=opus'
  }
  return base
}

function mediaTypeFromMime(mimeType = '') {
  const base = mimeBase(mimeType)
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  if (base === 'application/pdf' || base.startsWith('text/') || base.includes('document') || base.includes('spreadsheet') || base.includes('presentation') || base.includes('msword')) {
    return 'document'
  }
  return 'other'
}

function extensionForMime(mimeType = '', filename = '') {
  const base = mimeBase(mimeType)
  if (MIME_EXTENSION[base]) return MIME_EXTENSION[base]
  const ext = extname(filename).replace(/^\./, '').toLowerCase()
  return ext || 'bin'
}

function maxBytesForMediaType(settings, mediaType) {
  const mb = mediaType === 'image'
    ? settings.maxImageSizeMb
    : mediaType === 'video'
      ? settings.maxVideoSizeMb
      : mediaType === 'audio'
        ? settings.maxAudioSizeMb
        : settings.maxDocumentSizeMb
  return Math.max(1, Number(mb) || 50) * 1024 * 1024
}

function errorWithStatus(message, status = 400, code = '') {
  const error = new Error(message)
  error.status = status
  if (code) error.code = code
  return error
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function firstCleanValue(...values) {
  for (const value of values) {
    const clean = cleanString(value)
    if (clean) return clean
  }
  return ''
}

function escapeSqlLike(value = '') {
  return cleanString(value).replace(/[\\%_]/g, '\\$&')
}

function clientAccountIdFromLocationData(locationData = {}) {
  return firstCleanValue(
    locationData.locationId,
    locationData.location_id,
    locationData.id,
    locationData._id
  )
}

async function highLevelClientAccountFallback() {
  const row = await db.get('SELECT location_id, location_data FROM highlevel_config LIMIT 1').catch(() => null)
  const locationData = parseJson(row?.location_data, {})
  return firstCleanValue(row?.location_id, clientAccountIdFromLocationData(locationData))
}

async function resolveClientAccountContext(input = {}) {
  const metadataAccount = input.metadata?.clientAccount || input.metadata?.client_account || {}
  const requestedAccountId = firstCleanValue(
    input.clientAccountId,
    input.client_account_id,
    input.accountId,
    input.account_id,
    input.locationId,
    input.location_id
  )
  const metadataAccountId = firstCleanValue(
    metadataAccount.id,
    metadataAccount.clientAccountId,
    metadataAccount.client_account_id
  )
  const configuredAccountId = firstCleanValue(
    process.env.RISTAK_CLIENT_ACCOUNT_ID,
    process.env.CLIENT_ACCOUNT_ID,
    process.env.GHL_LOCATION_ID,
    process.env.HIGHLEVEL_LOCATION_ID,
    await highLevelClientAccountFallback()
  )
  const accountId = firstCleanValue(
    requestedAccountId,
    metadataAccountId,
    configuredAccountId,
    input.businessId,
    DEFAULT_CLIENT_ACCOUNT_ID
  )

  // Assets existentes ya traen su root/slug estable en metadata. Reemplazos y
  // reintentos deben conservarlo cuando el request no seleccionó otra cuenta.
  if (!requestedAccountId && (metadataAccount.rootPath || metadataAccount.slug)) {
    return normalizeClientAccountContext({
      ...metadataAccount,
      id: metadataAccountId || accountId
    })
  }

  // `storage_settings.account_slug` identifica la instalación principal y es
  // deliberadamente global. Una ruta administrativa legacy sí puede seleccionar
  // otra location/cuenta; esa cuenta usa su id técnico como root para que nunca
  // termine mezclada bajo el slug principal. La cuenta configurada conserva el
  // slug legible existente, por compatibilidad con todos sus objetos históricos.
  const requestedNormalized = requestedAccountId
    ? normalizeClientAccountId(requestedAccountId)
    : ''
  const configuredNormalized = configuredAccountId
    ? normalizeClientAccountId(configuredAccountId)
    : ''
  const legacyDefaultNormalized = normalizeClientAccountId(
    configuredAccountId || input.businessId || DEFAULT_CLIENT_ACCOUNT_ID
  )
  const isExplicitAlternateAccount = Boolean(
    requestedNormalized && requestedNormalized !== (configuredNormalized || legacyDefaultNormalized)
  )
  if (isExplicitAlternateAccount) {
    return normalizeClientAccountContext({
      id: accountId,
      slug: requestedNormalized,
      label: requestedAccountId
    })
  }

  // El id sigue siendo el identificador técnico (para lógica/legacy/migración),
  // pero la carpeta raíz del cliente usa el slug legible: accounts/<slug>/…
  const { slug, label } = await resolveAccountSlug(accountId)
  return normalizeClientAccountContext({ id: accountId, slug, label })
}

function mapAssetRow(row) {
  if (!row) return null
  const metadata = parseJson(row.metadata_json, {})
  return {
    id: row.id,
    businessId: row.business_id || 'default',
    userId: row.user_id || null,
    originalFilename: row.original_filename || '',
    storedFilename: row.stored_filename || '',
    bunnyPath: row.bunny_path || '',
    folderPath: normalizeMediaFolderPath(
      row.folder_path === null || row.folder_path === undefined
        ? mediaFolderPathFromObjectPath(row.bunny_path, row.module || row.media_type || 'other')
        : row.folder_path
    ),
    publicUrl: row.public_url || '',
    privateUrl: row.private_url || '',
    mimeType: row.mime_type || 'application/octet-stream',
    mediaType: row.media_type || 'other',
    extension: row.extension || '',
    sizeOriginal: numberValue(row.size_original),
    sizeProcessed: numberValue(row.size_processed),
    quotaSize: numberValue(row.quota_size),
    width: row.width === null || row.width === undefined ? null : numberValue(row.width),
    height: row.height === null || row.height === undefined ? null : numberValue(row.height),
    duration: row.duration === null || row.duration === undefined ? null : numberValue(row.duration),
    status: row.status || 'ready',
    storageProvider: row.storage_provider || 'unknown',
    storageZone: row.storage_zone || '',
    cdnBaseUrl: row.cdn_base_url || '',
    module: row.module || 'other',
    moduleEntityId: row.module_entity_id || null,
    isPublic: boolValue(row.is_public),
    metadata,
    streamVideoId: cleanString(row.stream_video_id || metadata?.stream?.videoId) || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    deletedAt: row.deleted_at || null
  }
}

async function getStorageSettingsRow() {
  return await db.get('SELECT * FROM storage_settings WHERE id = 1')
}

function buildStorageRuntimeConfig(row) {
  const provider = cleanString(process.env.MEDIA_STORAGE_PROVIDER || row?.storage_provider || 'bunny').toLowerCase()
  const storageEnabled = process.env.MEDIA_STORAGE_ENABLED !== undefined
    ? boolValue(process.env.MEDIA_STORAGE_ENABLED, true)
    : boolValue(row?.storage_enabled, true)
  const defaultQuotaGb = numberValue(process.env.DEFAULT_STORAGE_QUOTA_GB || row?.default_storage_quota_gb, 5)

  const config = {
    provider,
    storageEnabled,
    defaultQuotaGb,
    compressionEnabled: process.env.MEDIA_COMPRESSION_ENABLED !== undefined
      ? boolValue(process.env.MEDIA_COMPRESSION_ENABLED, true)
      : boolValue(row?.compression_enabled, true),
    imageOptimizationEnabled: boolValue(row?.image_optimization_enabled, true),
    videoCompressionEnabled: boolValue(row?.video_compression_enabled, true),
    audioCompressionEnabled: boolValue(row?.audio_compression_enabled, true),
    bunnyStorageZone: cleanString(process.env.BUNNY_STORAGE_ZONE || row?.bunny_storage_zone),
    bunnyStorageRegion: cleanString(process.env.BUNNY_STORAGE_REGION || row?.bunny_storage_region),
    bunnyStorageApiKey: cleanString(process.env.BUNNY_STORAGE_API_KEY),
    bunnyCdnBaseUrl: normalizeBaseUrl(process.env.BUNNY_CDN_BASE_URL || row?.bunny_cdn_base_url),
    bunnyAccountApiKey: cleanString(process.env.BUNNY_API_KEY || process.env.BUNNY_ACCOUNT_API_KEY || process.env.BUNNY_API_TOKEN || process.env.BUNNY_ACCESS_KEY),
    bunnyCoreEndpoint: normalizeBaseUrl(process.env.BUNNY_CORE_ENDPOINT || process.env.BUNNY_API_ENDPOINT || BUNNY_CORE_API_BASE_URL),
    bunnyStreamEnabled: process.env.BUNNY_STREAM_ENABLED !== undefined
      ? boolValue(process.env.BUNNY_STREAM_ENABLED, true)
      : boolValue(row?.bunny_stream_enabled, true),
    bunnyStreamLibraryId: cleanString(process.env.BUNNY_STREAM_LIBRARY_ID || row?.bunny_stream_library_id),
    bunnyStreamLibraryName: cleanString(process.env.BUNNY_STREAM_LIBRARY_NAME || row?.bunny_stream_library_name || DEFAULT_BUNNY_STREAM_LIBRARY_NAME),
    bunnyStreamApiKey: cleanString(process.env.BUNNY_STREAM_API_KEY),
    bunnyStreamCollectionId: cleanString(process.env.BUNNY_STREAM_COLLECTION_ID || row?.bunny_stream_collection_id),
    bunnyStreamCollectionName: cleanString(process.env.BUNNY_STREAM_COLLECTION_NAME || row?.bunny_stream_collection_name || DEFAULT_BUNNY_STREAM_COLLECTION_NAME),
    bunnyStreamEndpoint: normalizeBaseUrl(process.env.BUNNY_STREAM_ENDPOINT || row?.bunny_stream_endpoint || BUNNY_STREAM_API_BASE_URL),
    bunnyStorageEndpoint: normalizeBaseUrl(process.env.BUNNY_STORAGE_ENDPOINT),
    requireBunny: boolValue(process.env.MEDIA_STORAGE_REQUIRE_BUNNY, false),
    maxImageSizeMb: numberValue(row?.max_image_size_mb, 25),
    maxVideoSizeMb: numberValue(row?.max_video_size_mb, 512),
    maxAudioSizeMb: numberValue(row?.max_audio_size_mb, 100),
    maxDocumentSizeMb: numberValue(row?.max_document_size_mb, 50)
  }

  const missing = []
  if (config.provider === 'bunny') {
    if (!config.bunnyStorageZone) missing.push('BUNNY_STORAGE_ZONE')
    if (!config.bunnyStorageApiKey) missing.push('BUNNY_STORAGE_API_KEY')
    if (!config.bunnyCdnBaseUrl) missing.push('BUNNY_CDN_BASE_URL')
  }

  const streamMissing = []
  if (config.bunnyStreamEnabled) {
    if (!config.bunnyStreamLibraryId) streamMissing.push('BUNNY_STREAM_LIBRARY_ID')
    if (!config.bunnyStreamApiKey) streamMissing.push('BUNNY_STREAM_API_KEY')
    if (streamMissing.length && !config.bunnyAccountApiKey) streamMissing.push('BUNNY_API_KEY')
  }

  config.missingEnvironment = missing
  config.streamMissingEnvironment = streamMissing
  config.bunnyConfigured = config.provider === 'bunny' && missing.length === 0
  config.bunnyStreamConfigured = config.bunnyStreamEnabled && streamMissing.length === 0
  config.storageStatus = !config.storageEnabled
    ? 'disabled'
    : config.provider === 'bunny'
      ? config.bunnyConfigured ? 'configured' : 'not_configured'
      : 'local_fallback'
  config.streamStatus = !config.bunnyStreamEnabled
    ? 'disabled'
    : config.bunnyStreamConfigured ? 'configured' : 'not_configured'

  return config
}

async function centralStorageRequestConfig() {
  const broker = await resolveCentralBrokerConfig({
    appUrl: process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || ''
  })
  if (!broker) return null
  return {
    licenseServerUrl: broker.brokerUrl,
    body: {
      client_id: broker.clientId,
      license_key: broker.licenseKey,
      installation_id: broker.installationId,
      app_url: broker.appUrl || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '',
      version: process.env.APP_VERSION || ''
    }
  }
}

function readCentralStorageConfigValue(config, snakeKey, envKey) {
  return cleanString(config?.[snakeKey] || config?.[envKey])
}

function normalizeCentralStorageEnv(config = {}) {
  return {
    RISTAK_CLIENT_ACCOUNT_ID: readCentralStorageConfigValue(config, 'ristak_business_id', 'RISTAK_BUSINESS_ID') ||
      readCentralStorageConfigValue(config, 'ristak_installation_id', 'RISTAK_INSTALLATION_ID') ||
      readCentralStorageConfigValue(config, 'ristak_client_id', 'RISTAK_CLIENT_ID'),
    MEDIA_STORAGE_PROVIDER: readCentralStorageConfigValue(config, 'media_storage_provider', 'MEDIA_STORAGE_PROVIDER') || 'bunny',
    MEDIA_STORAGE_REQUIRE_BUNNY: readCentralStorageConfigValue(config, 'media_storage_require_bunny', 'MEDIA_STORAGE_REQUIRE_BUNNY') || 'true',
    MEDIA_COMPRESSION_ENABLED: readCentralStorageConfigValue(config, 'media_compression_enabled', 'MEDIA_COMPRESSION_ENABLED') || 'true',
    DEFAULT_STORAGE_QUOTA_GB: readCentralStorageConfigValue(config, 'default_storage_quota_gb', 'DEFAULT_STORAGE_QUOTA_GB'),
    INTERNAL_INSTALLER_TOKEN: readCentralStorageConfigValue(config, 'internal_installer_token', 'INTERNAL_INSTALLER_TOKEN'),
    BUNNY_STORAGE_ZONE: readCentralStorageConfigValue(config, 'bunny_storage_zone', 'BUNNY_STORAGE_ZONE'),
    BUNNY_STORAGE_REGION: readCentralStorageConfigValue(config, 'bunny_storage_region', 'BUNNY_STORAGE_REGION'),
    BUNNY_STORAGE_ENDPOINT: readCentralStorageConfigValue(config, 'bunny_storage_endpoint', 'BUNNY_STORAGE_ENDPOINT'),
    BUNNY_STORAGE_API_KEY: readCentralStorageConfigValue(config, 'bunny_storage_api_key', 'BUNNY_STORAGE_API_KEY'),
    BUNNY_CDN_BASE_URL: readCentralStorageConfigValue(config, 'bunny_cdn_base_url', 'BUNNY_CDN_BASE_URL'),
    BUNNY_API_KEY: readCentralStorageConfigValue(config, 'bunny_api_key', 'BUNNY_API_KEY') || readCentralStorageConfigValue(config, 'bunny_account_api_key', 'BUNNY_ACCOUNT_API_KEY'),
    BUNNY_CORE_ENDPOINT: readCentralStorageConfigValue(config, 'bunny_core_endpoint', 'BUNNY_CORE_ENDPOINT') || readCentralStorageConfigValue(config, 'bunny_api_endpoint', 'BUNNY_API_ENDPOINT'),
    BUNNY_STREAM_ENABLED: readCentralStorageConfigValue(config, 'bunny_stream_enabled', 'BUNNY_STREAM_ENABLED'),
    BUNNY_STREAM_LIBRARY_ID: readCentralStorageConfigValue(config, 'bunny_stream_library_id', 'BUNNY_STREAM_LIBRARY_ID'),
    BUNNY_STREAM_LIBRARY_NAME: readCentralStorageConfigValue(config, 'bunny_stream_library_name', 'BUNNY_STREAM_LIBRARY_NAME'),
    BUNNY_STREAM_API_KEY: readCentralStorageConfigValue(config, 'bunny_stream_api_key', 'BUNNY_STREAM_API_KEY'),
    BUNNY_STREAM_COLLECTION_ID: readCentralStorageConfigValue(config, 'bunny_stream_collection_id', 'BUNNY_STREAM_COLLECTION_ID'),
    BUNNY_STREAM_COLLECTION_NAME: readCentralStorageConfigValue(config, 'bunny_stream_collection_name', 'BUNNY_STREAM_COLLECTION_NAME'),
    BUNNY_STREAM_ENDPOINT: readCentralStorageConfigValue(config, 'bunny_stream_endpoint', 'BUNNY_STREAM_ENDPOINT')
  }
}

async function fetchCentralStorageConfig() {
  if (centralStorageConfigCache.env && centralStorageConfigCache.expiresAt > Date.now()) {
    return centralStorageConfigCache.env
  }
  if (centralStorageConfigCache.promise) return centralStorageConfigCache.promise

  centralStorageConfigCache.promise = (async () => {
    try {
      const requestConfig = await centralStorageRequestConfig()
      if (!requestConfig) return null
      const response = await fetch(`${requestConfig.licenseServerUrl}/api/license/storage-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestConfig.body),
        signal: AbortSignal.timeout(Number(process.env.MEDIA_CENTRAL_CONFIG_TIMEOUT_MS || 10_000) || 10_000)
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.success || !payload?.config) {
        const reason = payload?.reason || payload?.message || response.statusText
        logger.warn(`[MediaStorage] El broker central no entregó configuración Bunny (${response.status}): ${reason}`)
        return null
      }

      const env = normalizeCentralStorageEnv(payload.config)
      if (!env.BUNNY_STORAGE_ZONE || !env.BUNNY_STORAGE_API_KEY || !env.BUNNY_CDN_BASE_URL) {
        logger.warn('[MediaStorage] El broker central entregó configuración Bunny incompleta.')
        return null
      }

      centralStorageConfigCache.env = env
      centralStorageConfigCache.expiresAt = Date.now() + CENTRAL_STORAGE_CONFIG_TTL_MS
      return env
    } catch (error) {
      logger.warn(`[MediaStorage] No se pudo recuperar configuración Bunny desde el broker central: ${error.message}`)
      return null
    } finally {
      centralStorageConfigCache.promise = null
    }
  })()

  return centralStorageConfigCache.promise
}

function applyCentralStorageEnv(env = null) {
  if (!env) return false
  let applied = false
  for (const [key, value] of Object.entries(env)) {
    if (cleanString(value) && !cleanString(process.env[key])) {
      applyRuntimeEnvFallback(key, value)
      applied = true
    }
  }
  return applied
}

function bunnyCoreUrl(config, pathname, query = {}) {
  const url = new URL(`${normalizeBaseUrl(config.bunnyCoreEndpoint || BUNNY_CORE_API_BASE_URL)}${pathname}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function bunnyCoreRequest(config, pathname, {
  method = 'GET',
  query = {},
  body,
  okStatuses = [200]
} = {}) {
  const response = await fetch(bunnyCoreUrl(config, pathname, query), {
    method,
    headers: {
      AccessKey: config.bunnyAccountApiKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(BUNNY_STREAM_TIMEOUT_MS)
  })
  const payload = await parseBunnyResponse(response)

  if (!okStatuses.includes(response.status)) {
    const detail = cleanString(payload?.message || payload?.error || payload?.Message || response.statusText)
    throw errorWithStatus(
      `Bunny Core rechazó la operación (${response.status}): ${detail.slice(0, 180) || response.statusText}`,
      502,
      'bunny_core_request_failed'
    )
  }

  return payload
}

function normalizeBunnyVideoLibrary(row = {}) {
  if (!row || typeof row !== 'object') return null
  const id = cleanString(row.Id ?? row.id ?? row.VideoLibraryId ?? row.videoLibraryId)
  if (!id) return null
  return {
    id,
    name: cleanString(row.Name ?? row.name),
    apiKey: cleanString(row.ApiKey ?? row.apiKey ?? row.ApiAccessKey ?? row.apiAccessKey),
    readOnlyApiKey: cleanString(row.ReadOnlyApiKey ?? row.readOnlyApiKey),
    pullZoneId: row.PullZoneId ?? row.pullZoneId ?? null,
    storageZoneId: row.StorageZoneId ?? row.storageZoneId ?? null,
    created: false
  }
}

function extractBunnyVideoLibraries(payload) {
  if (Array.isArray(payload)) return payload.map(normalizeBunnyVideoLibrary).filter(Boolean)
  const items = payload?.Items || payload?.items || payload?.Data || payload?.data || []
  return Array.isArray(items) ? items.map(normalizeBunnyVideoLibrary).filter(Boolean) : []
}

async function listBunnyVideoLibraries(config) {
  const payload = await bunnyCoreRequest(config, '/videolibrary', {
    query: { page: 1, perPage: 1000 }
  })
  return extractBunnyVideoLibraries(payload)
}

async function getBunnyVideoLibrary(config, libraryId) {
  const payload = await bunnyCoreRequest(config, `/videolibrary/${encodeURIComponent(libraryId)}`)
  return normalizeBunnyVideoLibrary(payload)
}

async function createBunnyVideoLibrary(config) {
  const payload = await bunnyCoreRequest(config, '/videolibrary', {
    method: 'POST',
    body: {
      Name: config.bunnyStreamLibraryName || DEFAULT_BUNNY_STREAM_LIBRARY_NAME
    },
    okStatuses: [200, 201]
  })
  const library = normalizeBunnyVideoLibrary(payload)
  return library ? { ...library, created: true } : null
}

async function updateStorageSettingsBunnyStreamLibrary(library, config) {
  if (!library?.id) return
  const name = library.name || config.bunnyStreamLibraryName || DEFAULT_BUNNY_STREAM_LIBRARY_NAME
  try {
    await db.run(
      `UPDATE storage_settings
       SET bunny_stream_enabled = 1,
           bunny_stream_library_id = ?,
           bunny_stream_library_name = ?,
           bunny_stream_collection_name = COALESCE(NULLIF(bunny_stream_collection_name, ''), ?),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [library.id, name, config.bunnyStreamCollectionName || DEFAULT_BUNNY_STREAM_COLLECTION_NAME]
    )
  } catch (error) {
    logger.warn(`[MediaStorage] No se pudo guardar configuración Bunny Stream autogenerada: ${error.message}`)
  }
}

async function provisionBunnyStreamLibrary(config) {
  if (!config.bunnyStreamEnabled || config.bunnyStreamConfigured || !config.bunnyAccountApiKey) return null

  const provisionKey = [
    config.bunnyCoreEndpoint || BUNNY_CORE_API_BASE_URL,
    config.bunnyStreamLibraryId || '',
    config.bunnyStreamLibraryName || DEFAULT_BUNNY_STREAM_LIBRARY_NAME
  ].join('|')
  if (bunnyStreamLibraryProvisionCache.key === provisionKey && bunnyStreamLibraryProvisionCache.expiresAt > Date.now()) {
    return null
  }
  if (bunnyStreamLibraryProvisionCache.promise) return bunnyStreamLibraryProvisionCache.promise

  bunnyStreamLibraryProvisionCache.key = provisionKey
  bunnyStreamLibraryProvisionCache.promise = (async () => {
    let library = null
    if (config.bunnyStreamLibraryId) {
      library = await getBunnyVideoLibrary(config, config.bunnyStreamLibraryId)
    } else {
      const name = (config.bunnyStreamLibraryName || DEFAULT_BUNNY_STREAM_LIBRARY_NAME).toLowerCase()
      const libraries = await listBunnyVideoLibraries(config)
      library = libraries.find(item => item.name.toLowerCase() === name) || null
      if (!library) library = await createBunnyVideoLibrary(config)
    }

    if (!library?.id || !library?.apiKey) {
      throw errorWithStatus('Bunny creó/encontró la librería Stream pero no regresó API key usable.', 502, 'bunny_stream_library_api_key_missing')
    }

    applyRuntimeEnvFallback('BUNNY_STREAM_LIBRARY_ID', library.id)
    applyRuntimeEnvFallback('BUNNY_STREAM_LIBRARY_NAME', library.name || config.bunnyStreamLibraryName)
    applyRuntimeEnvFallback('BUNNY_STREAM_API_KEY', library.apiKey)
    await updateStorageSettingsBunnyStreamLibrary(library, config)
    logger.info(`[MediaStorage] Bunny Stream ${library.created ? 'creó' : 'reutilizó'} librería: ${library.name || library.id}`)
    return library
  })()

  try {
    return await bunnyStreamLibraryProvisionCache.promise
  } catch (error) {
    bunnyStreamLibraryProvisionCache.expiresAt = Date.now() + 60_000
    logger.warn(`[MediaStorage] No se pudo autoconfigurar Bunny Stream: ${error.message}`)
    return null
  } finally {
    bunnyStreamLibraryProvisionCache.promise = null
  }
}

async function autoProvisionBunnyStreamConfig(config) {
  if (!config.bunnyStreamEnabled || config.bunnyStreamConfigured || !config.bunnyAccountApiKey) return config
  const library = await provisionBunnyStreamLibrary(config)
  if (!library) return config
  const row = await getStorageSettingsRow()
  const nextConfig = buildStorageRuntimeConfig(row)
  nextConfig.streamAutoProvisioned = Boolean(library.created)
  return nextConfig
}

export function resetCentralStorageConfigCache() {
  centralStorageConfigCache = {
    expiresAt: 0,
    env: null,
    promise: null
  }
  bunnyStreamLibraryProvisionCache = {
    key: '',
    expiresAt: 0,
    promise: null
  }
  bunnyStreamCollectionCache.clear()
}

export async function getStorageRuntimeConfig() {
  const row = await getStorageSettingsRow()
  let config = buildStorageRuntimeConfig(row)

  if (config.provider === 'bunny' && (!config.bunnyConfigured || (config.bunnyStreamEnabled && !config.bunnyStreamConfigured && !config.bunnyAccountApiKey))) {
    const centralEnv = await fetchCentralStorageConfig()
    if (applyCentralStorageEnv(centralEnv)) {
      config = buildStorageRuntimeConfig(row)
      config.centralConfigLoaded = config.bunnyConfigured
    }
  }

  config = await autoProvisionBunnyStreamConfig(config)
  return config
}

export async function ensureBunnyStreamRuntimeConfigured() {
  const config = await getStorageRuntimeConfig()
  if (!config.bunnyStreamEnabled) {
    logger.info('[MediaStorage] Bunny Stream está deshabilitado.')
  } else if (config.bunnyStreamConfigured) {
    logger.info(`[MediaStorage] Bunny Stream listo: librería ${config.bunnyStreamLibraryId}.`)
  } else {
    logger.warn(`[MediaStorage] Bunny Stream no configurado: faltan ${config.streamMissingEnvironment.join(', ') || 'credenciales'}.`)
  }
  return config
}

function bunnyStorageBaseUrl(config) {
  if (config.bunnyStorageEndpoint) return config.bunnyStorageEndpoint
  if (config.bunnyStorageRegion && !/^de$/i.test(config.bunnyStorageRegion)) {
    return `https://${config.bunnyStorageRegion}.storage.bunnycdn.com`
  }
  return 'https://storage.bunnycdn.com'
}

function bunnyObjectUrl(config, objectPath) {
  const encodedPath = objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${bunnyStorageBaseUrl(config).replace(/\/+$/, '')}/${encodeURIComponent(config.bunnyStorageZone)}/${encodedPath}`
}

function bunnyPublicUrl(config, objectPath) {
  return `${config.bunnyCdnBaseUrl.replace(/\/+$/, '')}/${objectPath.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
}

function bunnyStreamBaseUrl(config) {
  return normalizeBaseUrl(config.bunnyStreamEndpoint || BUNNY_STREAM_API_BASE_URL) || BUNNY_STREAM_API_BASE_URL
}

function bunnyStreamUrl(config, pathname = '', query = {}) {
  const cleanPath = cleanString(pathname).replace(/^\/+/, '')
  const url = new URL(`${bunnyStreamBaseUrl(config).replace(/\/+$/, '')}/${cleanPath}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function parseBunnyResponse(response) {
  const text = await response.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function isReadableStream(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.pipe === 'function'
}

// Las subidas por streaming pueden tardar según el tamaño; damos un margen amplio
// (proporcional al peso) para no abortar transferencias legítimas de archivos grandes.
function bunnyFileUploadTimeoutMs(size = 0) {
  const sizeAllowance = Math.ceil(numberValue(size) / (1024 * 1024)) * 3_000
  return Math.min(BUNNY_FILE_UPLOAD_MAX_TIMEOUT_MS, Math.max(BUNNY_FILE_UPLOAD_BASE_TIMEOUT_MS, sizeAllowance))
}

function boundedRemoteOperationTimeout(deadlineAt, fallbackMs) {
  if (!deadlineAt) return fallbackMs
  const remainingMs = Math.floor(Number(deadlineAt) - Date.now())
  if (remainingMs <= 0) {
    throw errorWithStatus(
      'La operación remota agotó su presupuesto de tiempo. Recarga Media para ver lo que sí terminó.',
      409,
      'media_remote_selection_time_budget_exceeded'
    )
  }
  return Math.max(250, Math.min(fallbackMs, remainingMs))
}

async function bunnyStreamRequest(config, pathname, {
  method = 'GET',
  query = {},
  body,
  headers = {},
  okStatuses = [200],
  timeoutMs = BUNNY_STREAM_TIMEOUT_MS
} = {}) {
  const isRawBody = Buffer.isBuffer(body) || isReadableStream(body)
  const response = await fetch(bunnyStreamUrl(config, pathname, query), {
    method,
    headers: {
      AccessKey: config.bunnyStreamApiKey,
      ...(body !== undefined && !isRawBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? undefined : isRawBody ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await parseBunnyResponse(response)

  if (!okStatuses.includes(response.status)) {
    const detail = cleanString(payload?.message || payload?.error || payload?.Message || response.statusText)
    throw errorWithStatus(
      `Bunny Stream rechazó la operación (${response.status}): ${detail.slice(0, 180) || response.statusText}`,
      502,
      'bunny_stream_request_failed'
    )
  }

  return payload
}

function bunnyStreamCollectionFromRow(row = {}) {
  const guid = cleanString(row.guid || row.id || row.collectionId)
  if (!guid) return null
  return {
    id: guid,
    name: cleanString(row.name),
    videoCount: optionalNumberValue(row.videoCount),
    totalSize: optionalNumberValue(row.totalSize)
  }
}

function buildBunnyStreamCollectionName(config, clientAccount = {}) {
  const baseName = config.bunnyStreamCollectionName || DEFAULT_BUNNY_STREAM_COLLECTION_NAME
  const account = normalizeClientAccountContext(clientAccount)
  return `${baseName} / ${account.id}`.slice(0, 180)
}

async function ensureBunnyStreamCollection(config, clientAccount = null) {
  if (!config.bunnyStreamConfigured) return null
  if (config.bunnyStreamCollectionId && !clientAccount) {
    return {
      id: config.bunnyStreamCollectionId,
      name: config.bunnyStreamCollectionName || ''
    }
  }

  const name = clientAccount
    ? buildBunnyStreamCollectionName(config, clientAccount)
    : config.bunnyStreamCollectionName || DEFAULT_BUNNY_STREAM_COLLECTION_NAME
  const cacheKey = `${config.bunnyStreamLibraryId}:${name.toLowerCase()}`
  const cached = bunnyStreamCollectionCache.get(cacheKey)
  if (cached?.collection && cached.expiresAt > Date.now()) return cached.collection
  if (cached?.promise) return cached.promise

  const promise = (async () => {
    const listPayload = await bunnyStreamRequest(
      config,
      `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/collections`,
      {
        query: { search: name, itemsPerPage: 100, includeThumbnails: false }
      }
    )
    const exact = (Array.isArray(listPayload?.items) ? listPayload.items : [])
      .map(bunnyStreamCollectionFromRow)
      .find(collection => collection && collection.name.toLowerCase() === name.toLowerCase())

    if (exact) return exact

    const created = await bunnyStreamRequest(
      config,
      `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/collections`,
      {
        method: 'POST',
        body: { name }
      }
    )
    const collection = bunnyStreamCollectionFromRow(created)
    if (!collection) {
      throw errorWithStatus('Bunny Stream creó la colección pero no regresó un ID usable.', 502, 'bunny_stream_collection_missing')
    }
    return collection
  })()

  bunnyStreamCollectionCache.set(cacheKey, {
    expiresAt: Date.now() + BUNNY_STREAM_COLLECTION_CACHE_TTL_MS,
    promise
  })

  try {
    const collection = await promise
    bunnyStreamCollectionCache.set(cacheKey, {
      expiresAt: Date.now() + BUNNY_STREAM_COLLECTION_CACHE_TTL_MS,
      collection
    })
    return collection
  } catch (error) {
    bunnyStreamCollectionCache.delete(cacheKey)
    throw error
  }
}

function streamVideoStatusLabel(status) {
  const parsed = Number(status)
  return BUNNY_STREAM_STATUS_LABELS.get(parsed) || (Number.isFinite(parsed) ? `status_${parsed}` : '')
}

function normalizeBunnyStreamVideo(video = {}) {
  if (!video || typeof video !== 'object') return null
  const videoId = cleanString(video.guid || video.videoId || video.id)
  if (!videoId) return null

  return {
    libraryId: optionalNumberValue(video.videoLibraryId ?? video.libraryId),
    videoId,
    title: cleanString(video.title),
    dateUploaded: cleanString(video.dateUploaded),
    views: optionalNumberValue(video.views),
    isPublic: video.isPublic === undefined ? null : boolValue(video.isPublic),
    length: optionalNumberValue(video.length),
    status: optionalNumberValue(video.status),
    statusLabel: streamVideoStatusLabel(video.status),
    framerate: optionalNumberValue(video.framerate),
    width: optionalNumberValue(video.width),
    height: optionalNumberValue(video.height),
    outputCodecs: cleanString(video.outputCodecs),
    thumbnailCount: optionalNumberValue(video.thumbnailCount),
    encodeProgress: optionalNumberValue(video.encodeProgress),
    storageSize: optionalNumberValue(video.storageSize),
    hasMP4Fallback: video.hasMP4Fallback === undefined ? null : boolValue(video.hasMP4Fallback),
    averageWatchTime: optionalNumberValue(video.averageWatchTime),
    totalWatchTime: optionalNumberValue(video.totalWatchTime),
    description: video.description ?? null,
    rotation: video.rotation ?? null,
    availableResolutions: video.availableResolutions ?? null,
    captions: Array.isArray(video.captions) ? video.captions : [],
    collectionId: cleanString(video.collectionId),
    thumbnailFileName: video.thumbnailFileName ?? null,
    thumbnailBlurhash: video.thumbnailBlurhash ?? null,
    category: video.category ?? null,
    chapters: Array.isArray(video.chapters) ? video.chapters : [],
    moments: Array.isArray(video.moments) ? video.moments : [],
    metaTags: Array.isArray(video.metaTags) ? video.metaTags : [],
    transcodingMessages: Array.isArray(video.transcodingMessages) ? video.transcodingMessages : [],
    smartGenerateStatus: video.smartGenerateStatus ?? null,
    smartGenerateFeaturesStatus: video.smartGenerateFeaturesStatus ?? null,
    hasOriginal: video.hasOriginal ?? null,
    originalHash: video.originalHash ?? null,
    hasHighQualityPreview: video.hasHighQualityPreview ?? null
  }
}

function buildBunnyStreamTitle({ originalFilename = '', module = '', moduleEntityId = '', id = '' } = {}) {
  const base = filenameBase(originalFilename).replace(/[-_]+/g, ' ').trim()
  const suffix = cleanString(moduleEntityId || id)
  return [base || 'Ristak video', module ? `(${module})` : '', suffix ? suffix.slice(0, 40) : '']
    .filter(Boolean)
    .join(' ')
    .slice(0, 180)
}

function isBunnyStreamEligibleVideo({ mediaType = '', module = '' } = {}) {
  return cleanString(mediaType).toLowerCase() === 'video' && BUNNY_STREAM_MEDIA_MODULES.has(normalizeModule(module))
}

function bunnyStreamUsageContext(asset, context = {}) {
  const module = normalizeModule(context.module || asset.module)
  const moduleEntityId = context.moduleEntityId === undefined || context.moduleEntityId === null
    ? asset.moduleEntityId
    : cleanString(context.moduleEntityId)
  return {
    module,
    moduleEntityId: moduleEntityId || null
  }
}

function bunnyStreamSourceForAsset(asset, context, clientAccount = {}) {
  const account = normalizeClientAccountContext(clientAccount || asset.metadata?.clientAccount || {})
  return {
    mediaAssetId: asset.id,
    businessId: asset.businessId,
    clientAccountId: account.id,
    accountRootPath: account.rootPath,
    module: context.module,
    moduleEntityId: context.moduleEntityId,
    storagePath: asset.bunnyPath,
    storagePublicUrl: asset.publicUrl,
    mimeType: asset.mimeType
  }
}

function buildSkippedBunnyStreamMetadata(config, reason, clientAccount = {}) {
  const account = normalizeClientAccountContext(clientAccount)
  return {
    provider: 'bunny_stream',
    enabled: config.bunnyStreamEnabled,
    providerReady: config.bunnyStreamConfigured,
    syncStatus: 'skipped',
    reason,
    libraryId: config.bunnyStreamLibraryId || null,
    collectionId: config.bunnyStreamCollectionId || null,
    collectionName: buildBunnyStreamCollectionName(config, account),
    clientAccount: account,
    missingEnvironment: config.streamMissingEnvironment || [],
    checkedAt: nowIso()
  }
}

function buildPendingBunnyStreamMetadata(config, {
  id,
  businessId,
  module,
  moduleEntityId,
  originalFilename,
  objectPath,
  publicUrl,
  mimeType,
  clientAccount
} = {}) {
  const account = normalizeClientAccountContext(clientAccount || { id: businessId })
  return {
    provider: 'bunny_stream',
    enabled: config.bunnyStreamEnabled,
    providerReady: config.bunnyStreamConfigured,
    syncStatus: 'pending',
    libraryId: config.bunnyStreamLibraryId || null,
    collectionId: config.bunnyStreamCollectionId || null,
    collectionName: buildBunnyStreamCollectionName(config, account),
    title: buildBunnyStreamTitle({ originalFilename, module, moduleEntityId, id }),
    clientAccount: account,
    source: {
      mediaAssetId: id,
      businessId,
      clientAccountId: account.id,
      accountRootPath: account.rootPath,
      module,
      moduleEntityId,
      storagePath: objectPath,
      storagePublicUrl: publicUrl,
      mimeType
    },
    queuedAt: nowIso()
  }
}

async function createBunnyStreamVideo(config, { title, collectionId }) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos`,
    {
      method: 'POST',
      body: {
        title,
        ...(collectionId ? { collectionId } : {})
      }
    }
  )
}

async function uploadBunnyStreamVideo(config, { videoId, buffer }) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.length)
      },
      body: buffer,
      timeoutMs: bunnyFileUploadTimeoutMs(buffer.length)
    }
  )
}

async function uploadBunnyStreamVideoFromFile(config, { videoId, filePath, size }) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size)
      },
      body: createReadStream(filePath),
      timeoutMs: bunnyFileUploadTimeoutMs(size)
    }
  )
}

async function getBunnyStreamVideo(config, videoId) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`
  )
}

async function getBunnyStreamVideoPlayData(config, videoId) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}/play`
  )
}

async function updateBunnyStreamVideo(config, { videoId, title, collectionId } = {}) {
  if (!videoId) return null
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'POST',
      body: {
        ...(title ? { title } : {}),
        collectionId: collectionId || null
      }
    }
  )
}

async function getBunnyStreamVideoStatistics(config, { videoGuid = '', dateFrom = '', dateTo = '', hourly = false } = {}) {
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/statistics`,
    {
      query: {
        videoGuid,
        dateFrom,
        dateTo,
        hourly: hourly ? 'true' : ''
      }
    }
  )
}

async function getBunnyStreamVideoHeatmap(config, videoId) {
  if (!videoId) return null
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}/heatmap`,
    {
      okStatuses: [200, 404]
    }
  )
}

async function deleteBunnyStreamVideo(config, videoId, { deadlineAt = 0 } = {}) {
  if (!config.bunnyStreamConfigured || !videoId) return null
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'DELETE',
      okStatuses: [200, 404],
      timeoutMs: boundedRemoteOperationTimeout(deadlineAt, BUNNY_STREAM_TIMEOUT_MS)
    }
  )
}

async function syncVideoToBunnyStream({
  config,
  id,
  businessId,
  module,
  moduleEntityId,
  originalFilename,
  objectPath,
  publicUrl,
  mimeType,
  buffer,
  filePath,
  size,
  clientAccount
}) {
  const account = normalizeClientAccountContext(clientAccount || { id: businessId })
  if (!config.bunnyStreamEnabled) return buildSkippedBunnyStreamMetadata(config, 'stream_disabled', account)
  if (!config.bunnyStreamConfigured) return buildSkippedBunnyStreamMetadata(config, 'stream_not_configured', account)

  const title = buildBunnyStreamTitle({ originalFilename, module, moduleEntityId, id })
  const source = {
    mediaAssetId: id,
    businessId,
    clientAccountId: account.id,
    accountRootPath: account.rootPath,
    module,
    moduleEntityId,
    storagePath: objectPath,
    storagePublicUrl: publicUrl,
    mimeType
  }

  try {
    const collection = await ensureBunnyStreamCollection(config, account)
    if (!collection?.id) {
      throw errorWithStatus('Bunny Stream no regresó una colección usable para esta cuenta.', 502, 'bunny_stream_collection_required')
    }
    logger.info(`[MediaStorage] Bunny Stream sync iniciada: ${id}`)
    const created = await createBunnyStreamVideo(config, {
      title,
      collectionId: collection.id
    })
    const videoId = cleanString(created?.guid || created?.videoId || created?.id)
    if (!videoId) {
      throw errorWithStatus('Bunny Stream creó el video pero no regresó un videoId usable.', 502, 'bunny_stream_video_missing')
    }
    const uploadResult = cleanString(filePath)
      ? await uploadBunnyStreamVideoFromFile(config, { videoId, filePath, size })
      : await uploadBunnyStreamVideo(config, { videoId, buffer })
    const video = await getBunnyStreamVideo(config, videoId).catch((error) => {
      logger.warn(`[MediaStorage] Bunny Stream subió ${videoId}, pero no se pudo leer metadata inicial: ${error.message}`)
      return created
    })
    const normalizedVideo = normalizeBunnyStreamVideo(video) || normalizeBunnyStreamVideo(created)

    logger.info(`[MediaStorage] Bunny Stream sync completada: ${id} -> ${videoId}`)
    return {
      provider: 'bunny_stream',
      enabled: true,
      providerReady: true,
      syncStatus: 'uploaded',
      syncedAt: nowIso(),
      libraryId: config.bunnyStreamLibraryId,
      collectionId: collection.id,
      collectionName: collection.name || buildBunnyStreamCollectionName(config, account),
      videoId,
      title,
      clientAccount: account,
      source,
      uploadResult: {
        success: uploadResult?.success === undefined ? null : boolValue(uploadResult.success),
        statusCode: uploadResult?.statusCode ?? null,
        message: uploadResult?.message ?? null
      },
      video: normalizedVideo
    }
  } catch (error) {
    logger.warn(`[MediaStorage] Bunny Stream sync falló para ${id}: ${error.message}`)
    return {
      provider: 'bunny_stream',
      enabled: true,
      providerReady: true,
      syncStatus: 'failed',
      failedAt: nowIso(),
      libraryId: config.bunnyStreamLibraryId,
      collectionId: config.bunnyStreamCollectionId || null,
      collectionName: buildBunnyStreamCollectionName(config, account),
      title,
      clientAccount: account,
      source,
      error: error.message,
      code: error.code || 'bunny_stream_sync_failed'
    }
  }
}

function dimensionsFromStreamMetadata(stream = {}) {
  const video = stream?.video || {}
  return {
    width: optionalNumberValue(video.width),
    height: optionalNumberValue(video.height),
    duration: optionalNumberValue(video.length)
  }
}

function scheduleDeferredBunnyStreamSync(syncInput) {
  setImmediate(() => {
    syncVideoToBunnyStream(syncInput)
      .then(async (stream) => {
        const asset = await getMediaAsset(syncInput.id).catch(() => null)
        if (!asset || asset.status === 'deleted') return
        await updateMediaAssetStream({ asset, stream })
        logger.info(`[MediaStorage] Bunny Stream sync diferida completada: ${syncInput.id}`)
      })
      .catch((error) => {
        logger.warn(`[MediaStorage] Bunny Stream sync diferida falló para ${syncInput.id}: ${error.message}`)
      })
      .finally(() => {
        const cleanupFilePath = cleanString(syncInput.cleanupFilePath)
        if (cleanupFilePath) {
          fs.rm(cleanupFilePath, { force: true }).catch(() => undefined)
        }
      })
  })
}

async function updateMediaAssetStream({ asset, stream }) {
  const metadata = {
    ...(asset.metadata || {}),
    stream
  }
  const streamDimensions = dimensionsFromStreamMetadata(stream)
  const nextWidth = streamDimensions.width || asset.width || null
  const nextHeight = streamDimensions.height || asset.height || null
  const nextDuration = streamDimensions.duration || asset.duration || null

  await db.run(
    `UPDATE media_assets
     SET width = ?,
         height = ?,
         duration = ?,
         metadata_json = ?,
         stream_video_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextWidth,
      nextHeight,
      nextDuration,
      JSON.stringify(metadata),
      cleanString(stream?.videoId) || null,
      asset.id
    ]
  )
}

async function uploadToBunny({ config, objectPath, buffer, mimeType, deadlineAt = 0 }) {
  logger.info(`[MediaStorage] Subida a Bunny iniciada: ${objectPath}`)
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buffer.length)
    },
    body: buffer,
    signal: AbortSignal.timeout(boundedRemoteOperationTimeout(
      deadlineAt,
      bunnyFileUploadTimeoutMs(buffer.length)
    ))
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw errorWithStatus(`Bunny rechazó la subida (${response.status}): ${detail.slice(0, 180) || response.statusText}`, 502, 'bunny_upload_failed')
  }

  logger.info(`[MediaStorage] Subida a Bunny completada: ${objectPath}`)
}

// Sube el archivo a Bunny transmitiéndolo desde disco (sin cargarlo en RAM).
async function uploadFileToBunny({ config, objectPath, filePath, size, mimeType }) {
  logger.info(`[MediaStorage] Subida (streaming) a Bunny iniciada: ${objectPath} (${size} bytes)`)
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(size)
    },
    body: createReadStream(filePath),
    signal: AbortSignal.timeout(bunnyFileUploadTimeoutMs(size))
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw errorWithStatus(`Bunny rechazó la subida (${response.status}): ${detail.slice(0, 180) || response.statusText}`, 502, 'bunny_upload_failed')
  }

  logger.info(`[MediaStorage] Subida (streaming) a Bunny completada: ${objectPath}`)
}

// Copia un stream remoto a Bunny Storage sin cargar el video completo en RAM ni
// escribir otro temporal en disco. El Content-Length es obligatorio para evitar
// que Bunny acepte una transferencia parcial como si fuera un objeto válido.
async function uploadReadableStreamToBunny({ config, objectPath, stream, size, mimeType, deadlineAt = 0 }) {
  if (!isReadableStream(stream) || !Number.isSafeInteger(size) || size <= 0) {
    throw errorWithStatus('La copia de video a Storage no tiene un stream o tamaño válido.', 502, 'bunny_stream_storage_mirror_invalid')
  }

  logger.info(`[MediaStorage] Copia Stream -> Storage iniciada: ${objectPath} (${size} bytes)`)
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(size)
    },
    body: stream,
    signal: AbortSignal.timeout(boundedRemoteOperationTimeout(deadlineAt, bunnyFileUploadTimeoutMs(size)))
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw errorWithStatus(`Bunny rechazó la copia a Storage (${response.status}): ${detail.slice(0, 180) || response.statusText}`, 502, 'bunny_upload_failed')
  }

  logger.info(`[MediaStorage] Copia Stream -> Storage completada: ${objectPath}`)
}

// Lee solo los primeros bytes del archivo para detectar su tipo real sin cargarlo entero.
async function readFileHeaderSample(filePath, bytes = MEDIA_HEADER_SAMPLE_BYTES) {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function deleteFromBunny({ config, objectPath, deadlineAt = 0 }) {
  if (!objectPath || !config.bunnyConfigured) return
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'DELETE',
    headers: { AccessKey: config.bunnyStorageApiKey },
    signal: AbortSignal.timeout(boundedRemoteOperationTimeout(deadlineAt, BUNNY_FILE_DELETE_TIMEOUT_MS))
  })

  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Bunny rechazó la eliminación (${response.status}): ${detail.slice(0, 180) || response.statusText}`)
  }
}

async function cleanupUnpersistedMediaArtifacts({
  config,
  bunnyPaths = [],
  localPaths = [],
  streamVideoIds = []
} = {}) {
  const results = await Promise.allSettled([
    ...[...new Set(bunnyPaths.filter(Boolean))].map(objectPath =>
      deleteFromBunny({ config, objectPath })
    ),
    ...[...new Set(localPaths.filter(Boolean))].map(localPath =>
      fs.rm(localPath, { force: true })
    ),
    ...[...new Set(streamVideoIds.filter(Boolean))].map(videoId =>
      deleteBunnyStreamVideo(config, videoId)
    )
  ])
  const failed = results.filter(result => result.status === 'rejected')
  if (failed.length) {
    logger.warn(`[MediaStorage] ${failed.length} artefacto(s) no pudieron limpiarse después de una subida fallida.`)
  }
}

async function readBunnyObjectBuffer({ config, objectPath, publicUrl = '', deadlineAt = 0 }) {
  const urls = [
    /^https?:\/\//i.test(publicUrl) ? { url: publicUrl, headers: {} } : null,
    objectPath && config.bunnyConfigured ? { url: bunnyObjectUrl(config, objectPath), headers: { AccessKey: config.bunnyStorageApiKey } } : null
  ].filter(Boolean)

  for (const request of urls) {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(boundedRemoteOperationTimeout(deadlineAt, MEDIA_DOWNLOAD_TIMEOUT_MS))
    })
    if (response.ok) return Buffer.from(await response.arrayBuffer())
  }

  throw errorWithStatus('No se pudo leer el archivo desde Bunny para moverlo.', 502, 'bunny_move_read_failed')
}

async function detectMimeType(buffer, declaredMimeType = '', filename = '') {
  const detected = await fileTypeFromBuffer(buffer).catch(() => null)
  const declared = mimeBase(declaredMimeType)
  const nameExt = extname(filename).replace(/^\./, '').toLowerCase()

  if (detected?.mime) {
    return {
      mimeType: mimeBase(detected.mime),
      extension: detected.ext || extensionForMime(detected.mime, filename),
      source: 'magic'
    }
  }

  const start = buffer.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
  if ((declared === 'image/svg+xml' || nameExt === 'svg') && start.startsWith('<svg')) {
    return { mimeType: 'image/svg+xml', extension: 'svg', source: 'content' }
  }

  if (declared && ALLOWED_MIME_TYPES.has(declared)) {
    return { mimeType: declared, extension: extensionForMime(declared, filename), source: 'declared' }
  }

  return {
    mimeType: declared || 'application/octet-stream',
    extension: extensionForMime(declared, filename),
    source: 'fallback'
  }
}

function validateMediaType({ mimeType, mediaType, sizeBytes, settings }) {
  if (!ALLOWED_MIME_TYPES.has(mimeBase(mimeType))) {
    throw errorWithStatus('Tipo de archivo no permitido para almacenamiento multimedia.', 415, 'unsupported_media_type')
  }

  const maxBytes = maxBytesForMediaType(settings, mediaType)
  if (sizeBytes > maxBytes) {
    throw errorWithStatus(`El archivo pesa demasiado. Límite para ${mediaType}: ${Math.round(maxBytes / 1024 / 1024)} MB.`, 413, 'media_too_large')
  }
}

async function getImageMetadata(buffer, mimeType) {
  if (!mimeBase(mimeType).startsWith('image/') || mimeBase(mimeType) === 'image/svg+xml') {
    return { width: null, height: null }
  }

  try {
    const metadata = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata()
    return {
      width: metadata.width || null,
      height: metadata.height || null
    }
  } catch (error) {
    logger.warn(`[MediaStorage] No se pudo leer metadata de imagen: ${error.message}`)
    return { width: null, height: null }
  }
}

async function createImageThumbnail(buffer, mimeType) {
  if (!mimeBase(mimeType).startsWith('image/') || ['image/svg+xml', 'image/gif'].includes(mimeBase(mimeType))) {
    return null
  }

  try {
    const thumbnail = await sharp(buffer, { limitInputPixels: 64_000_000 })
      .rotate()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer()

    if (!thumbnail.length) return null
    return {
      buffer: thumbnail,
      mimeType: 'image/webp',
      extension: 'webp',
      sizeBytes: thumbnail.length
    }
  } catch (error) {
    logger.warn(`[MediaStorage] No se pudo generar thumbnail: ${error.message}`)
    return null
  }
}

function shouldCompress({ config, mediaType, skipCompression = false }) {
  if (skipCompression) return false
  if (!config.compressionEnabled) return false
  if (mediaType === 'image') return config.imageOptimizationEnabled
  if (mediaType === 'video') return config.videoCompressionEnabled
  if (mediaType === 'audio') return config.audioCompressionEnabled
  return false
}

async function processMedia({ buffer, mimeType, mediaType, config, skipCompression = false }) {
  if (!shouldCompress({ config, mediaType, skipCompression })) {
    return { buffer, mimeType, compression: 'disabled' }
  }

  logger.info(`[MediaStorage] Compresión iniciada: ${mediaType} ${mimeType}`)
  const compressed = await compressMediaBuffer({ buffer, contentType: mimeType })
  logger.info(`[MediaStorage] Compresión completada: ${mediaType} ${compressed.note || 'original'}`)
  return {
    buffer: compressed.buffer,
    mimeType: storageMimeType(compressed.contentType || mimeType),
    compression: compressed.note || 'original'
  }
}

async function getMediaStorageDateKey() {
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  return businessTodayDateOnly(timezone).replace(/-/g, '/')
}

function buildObjectPath({ businessId, clientAccount, mediaType, module, id, filename, extension, variant = '', dateKey = '', subFolder = '' }) {
  const day = dateKey || businessTodayDateOnly(DEFAULT_TIMEZONE).replace(/-/g, '/')
  const folder = module && module !== 'other' ? module : `${mediaType}s`
  const suffix = variant ? `-${variant}` : ''
  const rootPath = clientAccount?.rootPath || buildClientAccountRootPath(businessId)
  // subFolder opcional (p.ej. el canal en avatars/whatsapp/) va entre la categoría
  // y el bucket de fecha: accounts/<slug>/<categoría>/<subFolder>/<fecha>/<archivo>.
  const sub = normalizeMediaFolderPath(subFolder)
  return [
    rootPath,
    folder,
    ...(sub ? sub.split('/') : []),
    day,
    `${id}-${filenameBase(filename)}${suffix}.${extension}`
  ].join('/')
}

async function ensureStorageQuota(businessId, config) {
  const normalizedBusinessId = normalizeBusinessId(businessId)
  const existing = await db.get('SELECT * FROM storage_quotas WHERE business_id = ?', [normalizedBusinessId])
  if (existing) return existing

  const quotaGb = numberValue(config?.defaultQuotaGb, 5)
  const quotaBytes = Math.round(quotaGb * GB)
  await db.run(
    `INSERT INTO storage_quotas (business_id, quota_gb, quota_bytes, used_bytes, extra_quota_gb, storage_enabled, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (business_id) DO NOTHING`,
    [normalizedBusinessId, quotaGb, quotaBytes]
  )
  return await db.get('SELECT * FROM storage_quotas WHERE business_id = ?', [normalizedBusinessId])
}

async function readActiveUsageCounters(businessId) {
  const normalizedBusinessId = normalizeBusinessId(businessId)
  try {
    const rows = await db.all(
      `SELECT media_type, module, files_count, used_bytes
       FROM media_storage_usage_counters
       WHERE business_id = ?
         AND (files_count > 0 OR used_bytes > 0)`,
      [normalizedBusinessId]
    )
    return rows.map((row) => ({
      mediaType: cleanString(row.media_type) || 'other',
      module: cleanString(row.module) || 'other',
      filesCount: numberValue(row.files_count),
      usedBytes: numberValue(row.used_bytes)
    }))
  } catch (error) {
    // Compatibilidad durante un rolling deploy: una instancia nueva puede
    // atender tráfico antes de que otra termine de aplicar la migración 067.
    if (!/media_storage_usage_counters|does not exist|no such table/i.test(cleanString(error?.message))) {
      throw error
    }
    const rows = await db.all(
      `SELECT
         COALESCE(NULLIF(media_type, ''), 'other') AS media_type,
         COALESCE(NULLIF(module, ''), 'other') AS module,
         COUNT(*) AS files_count,
         COALESCE(SUM(quota_size), 0) AS used_bytes
       FROM media_assets
       WHERE business_id = ?
         AND deleted_at IS NULL
         AND status != 'deleted'
       GROUP BY COALESCE(NULLIF(media_type, ''), 'other'), COALESCE(NULLIF(module, ''), 'other')`,
      [normalizedBusinessId]
    )
    return rows.map((row) => ({
      mediaType: cleanString(row.media_type) || 'other',
      module: cleanString(row.module) || 'other',
      filesCount: numberValue(row.files_count),
      usedBytes: numberValue(row.used_bytes)
    }))
  }
}

async function readActiveUsageBytes(businessId) {
  const counters = await readActiveUsageCounters(businessId)
  return counters.reduce((total, row) => total + row.usedBytes, 0)
}

async function refreshQuotaUsage(businessId) {
  const usedBytes = await readActiveUsageBytes(businessId)
  await db.run(
    'UPDATE storage_quotas SET used_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ?',
    [usedBytes, normalizeBusinessId(businessId)]
  )
  return usedBytes
}

async function assertQuotaAvailable({ businessId, quotaSize, config }) {
  const quota = await ensureStorageQuota(businessId, config)
  if (!boolValue(quota.storage_enabled, true)) {
    throw errorWithStatus('El almacenamiento está deshabilitado para este negocio.', 403, 'storage_disabled')
  }

  const usedBytes = await readActiveUsageBytes(businessId)
  const quotaBytes = numberValue(quota.quota_bytes, Math.round(numberValue(quota.quota_gb, 5) * GB))
  const extraBytes = Math.round(numberValue(quota.extra_quota_gb) * GB)
  const totalBytes = quotaBytes + extraBytes

  if (usedBytes + quotaSize > totalBytes) {
    throw errorWithStatus('No hay espacio suficiente para subir este archivo. Libera almacenamiento o aumenta la cuota.', 413, 'storage_quota_exceeded')
  }
}

async function insertMediaAsset(row) {
  const metadataStreamModule = cleanString(row.metadata?.stream?.source?.module)
  const effectiveModule = ['sites', 'forms'].includes(metadataStreamModule)
    ? metadataStreamModule
    : row.module
  await db.run(
    `INSERT INTO media_assets (
      id, business_id, user_id, original_filename, stored_filename, bunny_path, folder_path,
      public_url, private_url, mime_type, media_type, extension,
      size_original, size_processed, quota_size, width, height, duration,
      status, storage_provider, storage_zone, cdn_base_url, module,
      module_entity_id, is_public, metadata_json, stream_video_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      row.id,
      row.businessId,
      row.userId || null,
      row.originalFilename,
      row.storedFilename,
      row.bunnyPath,
      mediaFolderPathFromObjectPath(row.bunnyPath, effectiveModule || row.mediaType || 'other'),
      row.publicUrl || null,
      row.privateUrl || null,
      row.mimeType,
      row.mediaType,
      row.extension,
      row.sizeOriginal,
      row.sizeProcessed,
      row.quotaSize,
      row.width || null,
      row.height || null,
      row.duration || null,
      row.status,
      row.storageProvider,
      row.storageZone || null,
      row.cdnBaseUrl || null,
      effectiveModule,
      row.moduleEntityId || null,
      row.isPublic ? 1 : 0,
      JSON.stringify(row.metadata || {}),
      cleanString(row.streamVideoId || row.metadata?.stream?.videoId) || null
    ]
  )
}

async function findMediaAssetByClientUploadId({
  businessId = 'default',
  clientUploadId = '',
  clientAccount = null
} = {}) {
  const cleanClientUploadId = normalizeClientUploadId(clientUploadId)
  if (!cleanClientUploadId) return null

  const metadataNeedle = `"clientUploadId":${JSON.stringify(cleanClientUploadId)}`
  const rows = await db.all(
    `SELECT *
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'
       AND metadata_json LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC
     LIMIT 25`,
    [normalizeBusinessId(businessId), `%${escapeSqlLike(metadataNeedle)}%`]
  )
  const assets = rows.map(mapAssetRow).filter(Boolean)
  const expectedAccountId = cleanString(clientAccount?.id)
  if (!expectedAccountId) return assets[0] || null

  const exact = assets.find(asset => (
    cleanString(asset.metadata?.clientAccount?.id || asset.metadata?.client_account?.id) === expectedAccountId
  ))
  if (exact) return exact

  // Compatibilidad con assets muy antiguos que tenían clientUploadId pero aún
  // no guardaban identidad de cuenta. Solo se reutilizan si no hay otro candidato
  // con cuenta explícita; nunca se cruza un asset moderno entre dos locations.
  const legacy = assets.filter(asset => !cleanString(
    asset.metadata?.clientAccount?.id || asset.metadata?.client_account?.id
  ))
  return legacy.length === 1 && assets.length === 1 ? legacy[0] : null
}

function resumableVideoMimeType(mimeType = '', filename = '') {
  const declared = mimeBase(mimeType)
  if (declared && ALLOWED_MIME_TYPES.has(declared) && mediaTypeFromMime(declared) === 'video') {
    return declared
  }

  const extension = extname(filename).replace(/^\./, '').toLowerCase()
  const inferred = RESUMABLE_VIDEO_MIME_BY_EXTENSION.get(extension)
  if (inferred) return inferred

  throw errorWithStatus(
    'Formato de video no compatible. Sube un archivo MP4, MOV, WebM o 3GP.',
    415,
    'unsupported_media_type'
  )
}

function bunnyStreamEmbedUrl(libraryId, videoId) {
  return `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(videoId)}`
}

function bunnyStreamTusAuthorization(config, videoId) {
  const libraryId = cleanString(config.bunnyStreamLibraryId)
  const expirationTime = Math.floor(Date.now() / 1000) + BUNNY_STREAM_TUS_AUTH_TTL_SECONDS
  const signature = crypto
    .createHash('sha256')
    .update(`${libraryId}${config.bunnyStreamApiKey}${expirationTime}${videoId}`)
    .digest('hex')

  return {
    endpoint: normalizeBaseUrl(process.env.BUNNY_STREAM_TUS_ENDPOINT || BUNNY_STREAM_TUS_UPLOAD_URL),
    videoId,
    libraryId,
    expirationTime,
    signature,
    headers: {
      AuthorizationSignature: signature,
      AuthorizationExpire: String(expirationTime),
      VideoId: videoId,
      LibraryId: libraryId
    }
  }
}

function validateBunnyStreamTusUploadUrl(value = '') {
  let uploadUrl
  let endpoint
  try {
    uploadUrl = new URL(cleanString(value))
    endpoint = new URL(normalizeBaseUrl(process.env.BUNNY_STREAM_TUS_ENDPOINT || BUNNY_STREAM_TUS_UPLOAD_URL))
  } catch {
    throw errorWithStatus('Bunny no regresó una URL TUS válida para finalizar.', 400, 'bunny_stream_tus_url_invalid')
  }

  const endpointPath = endpoint.pathname.replace(/\/+$/, '')
  if (uploadUrl.origin !== endpoint.origin || !uploadUrl.pathname.startsWith(`${endpointPath}/`)) {
    throw errorWithStatus('La URL TUS no pertenece al endpoint autorizado de Bunny.', 400, 'bunny_stream_tus_url_invalid')
  }
  return uploadUrl.toString()
}

async function getBunnyStreamTusUploadStatus(config, videoId, value) {
  const uploadUrl = validateBunnyStreamTusUploadUrl(value)
  const authorization = bunnyStreamTusAuthorization(config, videoId)
  const response = await fetch(uploadUrl, {
    method: 'HEAD',
    headers: {
      ...authorization.headers,
      'Tus-Resumable': '1.0.0'
    },
    signal: AbortSignal.timeout(BUNNY_STREAM_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw errorWithStatus(`Bunny no pudo verificar la subida TUS (HTTP ${response.status}).`, 502, 'bunny_stream_tus_verify_failed')
  }

  const lengthHeader = response.headers.get('upload-length')
  const offsetHeader = response.headers.get('upload-offset')
  const length = lengthHeader === null || lengthHeader.trim() === '' ? NaN : Number(lengthHeader)
  const offset = offsetHeader === null || offsetHeader.trim() === '' ? NaN : Number(offsetHeader)
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw errorWithStatus('Bunny no regresó el tamaño/avance de la subida TUS.', 502, 'bunny_stream_tus_verify_failed')
  }
  return { length, offset }
}

function bunnyStreamOriginalDeliveryUrl(playData = {}, videoId = '', config = {}) {
  const explicitOriginalUrl = cleanString(playData.originalUrl)
  const playlistUrl = cleanString(playData.videoPlaylistUrl)
  const rawUrl = explicitOriginalUrl || playlistUrl
  if (!rawUrl) return ''

  let sourceUrl
  let streamApiUrl
  try {
    sourceUrl = new URL(rawUrl)
    streamApiUrl = new URL(bunnyStreamBaseUrl(config))
    if (!explicitOriginalUrl) {
      sourceUrl.pathname = sourceUrl.pathname.replace(/\/[^/]*$/, '/original')
    }
  } catch {
    return ''
  }

  // Producción siempre debe descargar por HTTPS. El mismo origen HTTP del API
  // configurado se permite únicamente para el servidor falso de pruebas.
  if (sourceUrl.protocol !== 'https:' && sourceUrl.origin !== streamApiUrl.origin) return ''
  const pathSegments = sourceUrl.pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment) } catch { return segment }
  })
  if (!pathSegments.includes(cleanString(videoId))) return ''
  return sourceUrl.toString()
}

async function fetchBunnyStreamOriginalForStorage(config, asset, videoId) {
  const playData = await getBunnyStreamVideoPlayData(config, videoId)
  const sourceUrl = bunnyStreamOriginalDeliveryUrl(playData, videoId, config)
  if (!sourceUrl) {
    throw errorWithStatus(
      'Bunny todavía no publica el original necesario para crear la vista previa de Storage.',
      409,
      'bunny_stream_upload_not_complete'
    )
  }

  const libraryId = cleanString(asset.metadata?.stream?.libraryId || config.bunnyStreamLibraryId)
  const referer = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(videoId)}`
  let lastStatus = 0
  let lastDetail = ''

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1',
        Referer: referer,
        'User-Agent': 'Ristak-MediaStorage/1.0'
      },
      signal: AbortSignal.timeout(bunnyFileUploadTimeoutMs(asset.sizeOriginal))
    })
    lastStatus = response.status

    if (response.ok && response.body) {
      const contentLength = Number(response.headers.get('content-length'))
      const expectedSize = numberValue(asset.sizeOriginal)
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        response.body.destroy?.()
        throw errorWithStatus('Bunny no informó el tamaño del original para copiarlo a Storage.', 502, 'bunny_stream_original_size_missing')
      }
      if (expectedSize > 0 && contentLength !== expectedSize) {
        response.body.destroy?.()
        throw errorWithStatus(
          'Bunny todavía no expone el original completo para la vista previa de Storage.',
          409,
          'bunny_stream_upload_not_complete'
        )
      }
      return {
        stream: response.body,
        size: contentLength,
        mimeType: storageMimeType(response.headers.get('content-type') || asset.mimeType) || asset.mimeType
      }
    }

    lastDetail = await response.text().catch(() => '')
    if (![404, 409, 425, 429].includes(response.status) || attempt === 4) break
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
  }

  if ([404, 409, 425, 429].includes(lastStatus)) {
    throw errorWithStatus(
      'Bunny todavía está preparando el original para la vista previa de Storage.',
      409,
      'bunny_stream_upload_not_complete'
    )
  }
  throw errorWithStatus(
    `Bunny no permitió copiar el original a Storage (HTTP ${lastStatus || 'desconocido'}): ${cleanString(lastDetail).slice(0, 140)}`,
    502,
    'bunny_stream_original_fetch_failed'
  )
}

async function ensureBunnyStreamStorageMirrorUnlocked(assetId, context = {}) {
  let asset = await getMediaAsset(assetId)
  if (asset.storageProvider === 'bunny' && asset.bunnyPath && asset.publicUrl) return asset
  if (asset.storageProvider !== 'bunny_stream') {
    throw errorWithStatus('Este video no requiere una copia de Stream a Storage.', 409, 'bunny_stream_storage_mirror_not_applicable')
  }

  const config = context.config || await getStorageRuntimeConfig()
  if (config.provider !== 'bunny' || !config.bunnyConfigured) {
    throw errorWithStatus(
      'Bunny Storage no está listo para crear la vista previa separada del video.',
      503,
      'bunny_stream_resumable_unavailable'
    )
  }

  const streamMetadata = asset.metadata?.stream || {}
  const videoId = cleanString(streamMetadata.videoId)
  const libraryId = cleanString(streamMetadata.libraryId)
  if (!videoId || libraryId !== cleanString(config.bunnyStreamLibraryId)) {
    throw errorWithStatus('El video de Stream no coincide con la librería configurada.', 409, 'bunny_stream_video_mismatch')
  }

  const clientAccount = context.clientAccount || await resolveClientAccountContext({
    ...context,
    businessId: asset.businessId,
    metadata: asset.metadata
  })
  const module = normalizeModule(context.module || asset.module)
  const moduleEntityId = context.moduleEntityId === undefined || context.moduleEntityId === null
    ? asset.moduleEntityId
    : cleanString(context.moduleEntityId)
  const extension = extensionForMime(asset.mimeType, asset.originalFilename)
  const storedFilename = `${asset.id}-${filenameBase(asset.originalFilename)}.${extension}`
  const dateKey = await getMediaStorageDateKey()
  const objectPath = buildObjectPath({
    businessId: asset.businessId,
    clientAccount,
    mediaType: 'video',
    module,
    id: asset.id,
    filename: asset.originalFilename,
    extension,
    dateKey
  })
  const publicUrl = bunnyPublicUrl(config, objectPath)
  const original = await fetchBunnyStreamOriginalForStorage(config, asset, videoId)
  const mirrorMimeType = mimeBase(original.mimeType).startsWith('video/') ? original.mimeType : asset.mimeType

  try {
    await uploadReadableStreamToBunny({
      config,
      objectPath,
      stream: original.stream,
      size: original.size,
      mimeType: mirrorMimeType
    })

    const mirroredAsset = {
      ...asset,
      bunnyPath: objectPath,
      publicUrl,
      mimeType: mirrorMimeType,
      storageProvider: 'bunny'
    }
    const nextStream = {
      ...streamMetadata,
      source: {
        ...(streamMetadata.source || {}),
        ...bunnyStreamSourceForAsset(mirroredAsset, { module, moduleEntityId }, clientAccount)
      }
    }
    const nextMetadata = {
      ...(asset.metadata || {}),
      storageStatus: config.storageStatus,
      stream: nextStream,
      directUpload: {
        ...(asset.metadata?.directUpload || {}),
        storageMirror: {
          provider: 'bunny',
          state: 'ready',
          source: 'bunny_stream_original',
          sizeBytes: original.size,
          mirroredAt: nowIso()
        }
      }
    }

    await db.run(
      `UPDATE media_assets
       SET stored_filename = ?, bunny_path = ?, folder_path = ?, public_url = ?,
           private_url = CASE WHEN is_public = 1 THEN NULL ELSE ? END,
           mime_type = ?, extension = ?, size_processed = ?,
           storage_provider = 'bunny', storage_zone = ?, cdn_base_url = ?,
           metadata_json = ?, stream_video_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND deleted_at IS NULL`,
      [
        storedFilename,
        objectPath,
        mediaFolderPathFromObjectPath(objectPath, module || asset.mediaType || 'other'),
        publicUrl,
        publicUrl,
        mirrorMimeType,
        extension,
        original.size,
        config.bunnyStorageZone,
        config.bunnyCdnBaseUrl,
        JSON.stringify(nextMetadata),
        cleanString(nextStream.videoId) || null,
        asset.id
      ]
    )
    await ensureAccountReadme(config, clientAccount)
    asset = await getMediaAsset(asset.id)
    logger.info(`[MediaStorage] Vista previa Storage creada desde Stream: ${asset.id} -> ${objectPath}`)
    return asset
  } catch (error) {
    await deleteFromBunny({ config, objectPath }).catch(() => undefined)
    throw error
  }
}

async function ensureBunnyStreamStorageMirror(assetId, context = {}) {
  const lockName = `media:stream-storage:${cleanString(assetId)}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await db.withAdvisoryLock(
        lockName,
        () => ensureBunnyStreamStorageMirrorUnlocked(assetId, context)
      )
    } catch (error) {
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY') throw error
      if (attempt === 19) {
        throw errorWithStatus('La vista previa de Storage ya se está preparando.', 409, 'media_upload_in_progress')
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw errorWithStatus('No se pudo preparar la vista previa de Storage.', 409, 'media_upload_in_progress')
}

// Punto de entrada interno para superficies autenticadas de Sites. Mantiene la
// reparación de assets Stream-only separada de la sincronización completa de
// metadata: abrir un editor o generar un preview sólo debe crear el espejo que
// alimenta al reproductor Ristak, nunca crear otro video de Stream.
export async function ensureMediaAssetStoragePreview(assetId, context = {}) {
  const asset = await getMediaAsset(assetId)
  const module = normalizeModule(context.module || asset.module)
  if (!isBunnyStreamEligibleVideo({ mediaType: asset.mediaType, module })) {
    throw errorWithStatus('Este archivo no es un video de sitios o formularios.', 400, 'bunny_stream_not_applicable')
  }

  if (asset.storageProvider !== 'bunny_stream') return asset
  return ensureBunnyStreamStorageMirror(asset.id, { ...context, module })
}

function assertResumableAssetMatches(asset, { sizeBytes, mimeType, module, clientUploadId }) {
  const assetUploadId = cleanString(asset.metadata?.clientUploadId || asset.metadata?.directUpload?.clientUploadId)
  if (
    assetUploadId !== clientUploadId ||
    numberValue(asset.sizeOriginal) !== sizeBytes ||
    mimeBase(asset.mimeType) !== mimeBase(mimeType) ||
    normalizeModule(asset.module) !== module
  ) {
    throw errorWithStatus(
      'Esta subida resumible ya pertenece a otro archivo o destino.',
      409,
      'media_upload_id_conflict'
    )
  }
}

function resumableUploadResponse(asset, config) {
  const stream = asset.metadata?.stream || {}
  const videoId = cleanString(stream.videoId)
  if (!videoId) {
    throw errorWithStatus('La sesión resumible no tiene un video de Bunny asociado.', 409, 'bunny_stream_video_missing')
  }
  const completed = asset.status === 'ready'
  return {
    completed,
    asset,
    upload: completed ? null : {
      ...bunnyStreamTusAuthorization(config, videoId),
      metadata: {
        filetype: asset.mimeType,
        title: stream.title || asset.originalFilename,
        ...(stream.collectionId ? { collection: stream.collectionId } : {})
      }
    }
  }
}

async function cleanupExpiredBunnyStreamResumableUploads(businessId) {
  const cutoff = new Date(Date.now() - BUNNY_STREAM_TUS_STALE_UPLOAD_MS).toISOString()
  const rows = await db.all(
    `SELECT id
     FROM media_assets
     WHERE business_id = ?
       AND status = 'uploading'
       AND deleted_at IS NULL
       AND created_at < ?
       AND metadata_json LIKE ?
     ORDER BY created_at ASC
     LIMIT 100`,
    [normalizeBusinessId(businessId), cutoff, '%"protocol":"tus"%']
  )

  let cleaned = 0
  for (const row of rows) {
    try {
      await softDeleteMediaAsset(row.id)
      cleaned += 1
    } catch (error) {
      if (error?.code !== 'media_not_found') {
        logger.warn(`[MediaStorage] No se pudo limpiar subida TUS vencida ${row.id}: ${error.message}`)
      }
    }
  }
  if (cleaned > 0) logger.info(`[MediaStorage] Subidas TUS vencidas limpiadas: ${cleaned}`)
}

async function prepareBunnyStreamResumableUploadUnlocked(input = {}) {
  const module = normalizeModule(input.module)
  if (!BUNNY_STREAM_MEDIA_MODULES.has(module)) {
    throw errorWithStatus('La subida resumible de video solo está disponible en Sitios y Formularios.', 400, 'bunny_stream_resumable_not_applicable')
  }

  const config = await getStorageRuntimeConfig()
  if (!config.storageEnabled) {
    throw errorWithStatus('El almacenamiento multimedia está deshabilitado.', 503, 'storage_disabled')
  }
  if (
    config.provider !== 'bunny' ||
    !config.bunnyConfigured ||
    !config.bunnyStreamEnabled ||
    !config.bunnyStreamConfigured
  ) {
    throw errorWithStatus(
      'Bunny Storage y Stream deben estar listos para la subida resumible; usa la ruta compatible.',
      503,
      'bunny_stream_resumable_unavailable'
    )
  }

  const originalFilename = sanitizeFilename(input.filename || input.originalFilename || 'video')
  const mimeType = resumableVideoMimeType(input.mimeType || input.contentType, originalFilename)
  const sizeBytes = Math.round(numberValue(input.size))
  if (sizeBytes <= 0) throw errorWithStatus('El video está vacío.', 400, 'empty_media')
  validateMediaType({ mimeType, mediaType: 'video', sizeBytes, settings: config })

  const businessId = normalizeBusinessId(input.businessId)
  const clientAccount = await resolveClientAccountContext({ ...input, businessId })
  const clientUploadId = normalizeClientUploadId(input.clientUploadId)
  if (!clientUploadId) {
    throw errorWithStatus('Falta la identidad estable de la subida resumible.', 400, 'invalid_media_upload_id')
  }

  await cleanupExpiredBunnyStreamResumableUploads(businessId)

  const existing = await findMediaAssetByClientUploadId({ businessId, clientUploadId, clientAccount })
  if (existing) {
    assertResumableAssetMatches(existing, { sizeBytes, mimeType, module, clientUploadId })
    return resumableUploadResponse(existing, config)
  }

  await assertQuotaAvailable({ businessId, quotaSize: sizeBytes, config })
  const id = createRistakId('media')
  const extension = extensionForMime(mimeType, originalFilename)
  const storedFilename = `${id}-${filenameBase(originalFilename)}.${extension}`
  const title = buildBunnyStreamTitle({
    originalFilename,
    module,
    moduleEntityId: input.moduleEntityId,
    id
  })
  const collection = await ensureBunnyStreamCollection(config, clientAccount)
  if (!collection?.id) {
    throw errorWithStatus('Bunny Stream no regresó una colección usable para esta cuenta.', 502, 'bunny_stream_collection_required')
  }

  const created = await createBunnyStreamVideo(config, { title, collectionId: collection.id })
  const videoId = cleanString(created?.guid || created?.videoId || created?.id)
  if (!videoId) {
    throw errorWithStatus('Bunny Stream creó el video pero no regresó un ID usable.', 502, 'bunny_stream_video_missing')
  }

  const publicUrl = bunnyStreamEmbedUrl(config.bunnyStreamLibraryId, videoId)
  const stream = {
    provider: 'bunny_stream',
    enabled: true,
    providerReady: true,
    syncStatus: 'uploading',
    libraryId: config.bunnyStreamLibraryId,
    collectionId: collection.id,
    collectionName: collection.name || buildBunnyStreamCollectionName(config, clientAccount),
    videoId,
    title,
    clientAccount,
    source: {
      mediaAssetId: id,
      businessId,
      clientAccountId: clientAccount.id,
      accountRootPath: clientAccount.rootPath,
      module,
      moduleEntityId: cleanString(input.moduleEntityId) || null,
      storagePath: '',
      storagePublicUrl: publicUrl,
      mimeType
    },
    video: normalizeBunnyStreamVideo(created),
    queuedAt: nowIso()
  }
  const metadata = {
    clientUploadId,
    upload: { clientUploadId },
    clientAccount,
    storageStatus: config.storageStatus,
    stream,
    directUpload: {
      protocol: 'tus',
      provider: 'bunny_stream',
      state: 'prepared',
      clientUploadId,
      sizeBytes,
      lastModified: optionalNumberValue(input.lastModified),
      preparedAt: nowIso()
    },
    variants: {}
  }

  try {
    await insertMediaAsset({
      id,
      businessId,
      userId: input.userId ? String(input.userId) : null,
      originalFilename,
      storedFilename,
      bunnyPath: null,
      publicUrl,
      privateUrl: input.isPublic === false ? publicUrl : null,
      mimeType,
      mediaType: 'video',
      extension,
      sizeOriginal: sizeBytes,
      sizeProcessed: sizeBytes,
      quotaSize: sizeBytes,
      width: null,
      height: null,
      duration: null,
      status: 'uploading',
      storageProvider: 'bunny_stream',
      module,
      moduleEntityId: input.moduleEntityId,
      isPublic: input.isPublic !== false,
      metadata
    })
  } catch (error) {
    const raced = await getMediaAsset(id).catch(() => null)
    await deleteBunnyStreamVideo(config, videoId).catch(() => undefined)
    if (raced) {
      assertResumableAssetMatches(raced, { sizeBytes, mimeType, module, clientUploadId })
      return resumableUploadResponse(raced, config)
    }
    throw error
  }

  await refreshQuotaUsage(businessId)
  return resumableUploadResponse(await getMediaAsset(id), config)
}

export async function prepareBunnyStreamResumableUpload(input = {}) {
  const businessId = normalizeBusinessId(input.businessId)
  const clientUploadId = normalizeClientUploadId(input.clientUploadId)
  if (!clientUploadId) {
    throw errorWithStatus('Falta la identidad estable de la subida resumible.', 400, 'invalid_media_upload_id')
  }

  // El candado es por negocio, no sólo por archivo: así la lectura de cuota y
  // su reserva quedan serializadas también entre videos distintos.
  const lockName = `media:tus:${businessId}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await db.withAdvisoryLock(
        lockName,
        () => prepareBunnyStreamResumableUploadUnlocked({ ...input, businessId, clientUploadId })
      )
    } catch (error) {
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY') throw error
      if (attempt === 19) {
        throw errorWithStatus(
          'Este mismo video ya se está preparando. Espera un momento e intenta otra vez.',
          409,
          'media_upload_in_progress'
        )
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw errorWithStatus('No se pudo reservar la subida resumible.', 409, 'media_upload_in_progress')
}

export async function finalizeBunnyStreamResumableUpload(assetId, context = {}) {
  let asset = await getMediaAsset(assetId)
  const module = normalizeModule(context.module || asset.module)
  if (normalizeBusinessId(context.businessId) !== normalizeBusinessId(asset.businessId) || module !== normalizeModule(asset.module)) {
    throw errorWithStatus('La subida no pertenece a esta cuenta o superficie.', 403, 'media_upload_scope_mismatch')
  }
  if (asset.status === 'ready') {
    return asset.storageProvider === 'bunny_stream'
      ? await ensureBunnyStreamStorageMirror(asset.id, { ...context, module })
      : asset
  }
  if (asset.status !== 'uploading' || asset.metadata?.directUpload?.protocol !== 'tus') {
    throw errorWithStatus('Este archivo no tiene una subida resumible pendiente.', 409, 'media_upload_not_pending')
  }

  const config = await getStorageRuntimeConfig()
  if (!config.bunnyStreamEnabled || !config.bunnyStreamConfigured) {
    throw errorWithStatus('Bunny Stream no está disponible para finalizar el video.', 503, 'bunny_stream_resumable_unavailable')
  }

  const stream = asset.metadata?.stream || {}
  const videoId = cleanString(stream.videoId)
  if (!videoId || cleanString(stream.libraryId) !== cleanString(config.bunnyStreamLibraryId)) {
    throw errorWithStatus('La sesión de video no coincide con la librería configurada.', 409, 'bunny_stream_video_mismatch')
  }

  const uploadStatus = await getBunnyStreamTusUploadStatus(config, videoId, context.uploadUrl)
  if (uploadStatus.length !== numberValue(asset.sizeOriginal)) {
    throw errorWithStatus('El tamaño recibido por Bunny no coincide con el video preparado.', 409, 'bunny_stream_upload_size_mismatch')
  }
  if (uploadStatus.offset !== uploadStatus.length) {
    throw errorWithStatus('Bunny todavía no ha recibido todos los bytes del video.', 409, 'bunny_stream_upload_not_complete')
  }

  let video = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    video = await getBunnyStreamVideo(config, videoId)
    if (BUNNY_STREAM_FAILED_STATUSES.has(numberValue(video?.status))) break
    if (numberValue(video?.status) > 0 || video?.hasOriginal === true) break
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 750))
  }
  if (BUNNY_STREAM_FAILED_STATUSES.has(numberValue(video?.status))) {
    await softDeleteMediaAsset(asset.id)
    throw errorWithStatus(
      'Bunny recibió el archivo, pero reportó que el procesamiento del video falló.',
      422,
      'bunny_stream_processing_failed'
    )
  }
  if (numberValue(video?.status) <= 0 && video?.hasOriginal !== true) {
    throw errorWithStatus('Bunny todavía no confirma que recibió el video completo.', 409, 'bunny_stream_upload_not_complete')
  }

  asset = await ensureBunnyStreamStorageMirror(asset.id, {
    ...context,
    config,
    module,
    clientAccount: stream.clientAccount
  })
  const normalizedVideo = normalizeBunnyStreamVideo(video)
  const mirroredStream = asset.metadata?.stream || stream
  const nextStream = {
    ...mirroredStream,
    syncStatus: 'uploaded',
    syncedAt: nowIso(),
    video: normalizedVideo || mirroredStream.video || null
  }
  const nextMetadata = {
    ...(asset.metadata || {}),
    stream: nextStream,
    directUpload: {
      ...(asset.metadata?.directUpload || {}),
      state: 'completed',
      completedAt: nowIso()
    }
  }
  const dimensions = dimensionsFromStreamMetadata(nextStream)

  await db.run(
    `UPDATE media_assets
     SET width = ?, height = ?, duration = ?, status = 'ready', metadata_json = ?, stream_video_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'uploading' AND deleted_at IS NULL`,
    [dimensions.width, dimensions.height, dimensions.duration, JSON.stringify(nextMetadata), cleanString(nextStream.videoId) || null, asset.id]
  )
  await refreshQuotaUsage(asset.businessId)
  logger.info(`[MediaStorage] Video TUS finalizado: ${asset.id} -> ${videoId}`)
  return await getMediaAsset(asset.id)
}

export async function cancelBunnyStreamResumableUpload(assetId, context = {}) {
  const asset = await getMediaAsset(assetId)
  const module = normalizeModule(context.module || asset.module)
  if (normalizeBusinessId(context.businessId) !== normalizeBusinessId(asset.businessId) || module !== normalizeModule(asset.module)) {
    throw errorWithStatus('La subida no pertenece a esta cuenta o superficie.', 403, 'media_upload_scope_mismatch')
  }
  if (asset.status !== 'uploading' || asset.metadata?.directUpload?.protocol !== 'tus') {
    throw errorWithStatus('Esta subida ya no se puede cancelar.', 409, 'media_upload_not_pending')
  }

  await softDeleteMediaAsset(asset.id)
  logger.info(`[MediaStorage] Video TUS cancelado: ${asset.id}`)
  return { id: asset.id, cancelled: true }
}

async function saveLocalFile({ objectPath, buffer }) {
  const localPath = join(LOCAL_MEDIA_ROOT, objectPath)
  await fs.mkdir(dirname(localPath), { recursive: true })
  await fs.writeFile(localPath, buffer)
  return localPath
}

async function saveLocalFileFromPath({ objectPath, filePath }) {
  const localPath = join(LOCAL_MEDIA_ROOT, objectPath)
  await fs.mkdir(dirname(localPath), { recursive: true })
  await fs.copyFile(filePath, localPath)
  return localPath
}

function sanitizeFolderSegment(value = '') {
  const clean = cleanString(value)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (!clean || clean === '.' || clean === '..') return ''
  return clean
}

function normalizeMediaFolderPath(value = '') {
  return cleanString(value)
    .split('/')
    .map(sanitizeFolderSegment)
    .filter(Boolean)
    .join('/')
}

export function mediaFolderPathFromObjectPath(objectPath = '', fallbackFolder = '') {
  const segments = cleanString(objectPath)
    .split('/')
    .map(sanitizeFolderSegment)
    .filter(Boolean)
  if (!segments.length) return normalizeMediaFolderPath(fallbackFolder)

  const relativeSegments = (segments[0] === 'accounts' || segments[0] === 'businesses') && segments.length > 2
    ? segments.slice(2)
    : segments
  const folderSegments = relativeSegments.slice(0, -1)
  return normalizeMediaFolderPath(folderSegments.join('/') || fallbackFolder)
}

function getStoredObjectFilename(asset) {
  const pathName = cleanString(asset.bunnyPath).split('/').filter(Boolean).pop()
  return sanitizeFilename(pathName || asset.storedFilename || `${asset.id}-${filenameBase(asset.originalFilename)}.${asset.extension || 'bin'}`)
}

function assetClientAccountRootPath(asset) {
  const currentPathSegments = cleanString(asset.bunnyPath).split('/').filter(Boolean)
  if (currentPathSegments[0] === CLIENT_ACCOUNT_ROOT_FOLDER && currentPathSegments[1]) {
    return currentPathSegments.slice(0, 2).join('/')
  }

  const account = asset.metadata?.clientAccount || asset.metadata?.client_account || {}
  if (account.id || account.clientAccountId || account.client_account_id) {
    return normalizeClientAccountContext(account).rootPath
  }

  return ['businesses', normalizeBusinessId(asset.businessId)].join('/')
}

function buildMovedObjectPath(asset, targetFolderPath = '') {
  return [
    assetClientAccountRootPath(asset),
    ...normalizeMediaFolderPath(targetFolderPath).split('/').filter(Boolean),
    getStoredObjectFilename(asset)
  ].join('/')
}

function nextVariantPath(nextObjectPath, currentVariantPath = '') {
  const currentName = cleanString(currentVariantPath).split('/').filter(Boolean).pop()
  if (!currentName) return ''
  return [dirname(nextObjectPath), currentName].join('/')
}

async function moveLocalFile(currentPath, nextObjectPath) {
  if (!currentPath) return ''
  const nextPath = join(LOCAL_MEDIA_ROOT, nextObjectPath)
  if (currentPath === nextPath) return nextPath
  await fs.mkdir(dirname(nextPath), { recursive: true })
  try {
    await fs.rename(currentPath, nextPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await fs.copyFile(currentPath, nextPath)
    await fs.rm(currentPath, { force: true })
  }
  return nextPath
}

export async function uploadMediaAsset(input = {}) {
  const tempFilePath = cleanString(input.filePath)
  const hasTempFile = Boolean(tempFilePath)
  let tempFileHandedOff = false
  let mediaAssetPersisted = false
  let pendingArtifactCleanup = null

  try {
    let originalBuffer = null
    let sizeBytes = 0
    let headerSample = null

    if (hasTempFile) {
      const stat = await fs.stat(tempFilePath).catch(() => null)
      sizeBytes = numberValue(stat?.size)
      if (!sizeBytes) {
        throw errorWithStatus('El archivo está vacío.', 400, 'empty_media')
      }
      headerSample = await readFileHeaderSample(tempFilePath)
    } else {
      originalBuffer = Buffer.isBuffer(input.buffer)
        ? input.buffer
        : Buffer.from(input.buffer || '')
      if (!originalBuffer.length) {
        throw errorWithStatus('El archivo está vacío.', 400, 'empty_media')
      }
      sizeBytes = originalBuffer.length
      headerSample = originalBuffer
    }

    const config = await getStorageRuntimeConfig()
    if (!config.storageEnabled) {
      throw errorWithStatus('El almacenamiento multimedia está deshabilitado.', 503, 'storage_disabled')
    }

    const originalFilename = sanitizeFilename(input.filename || input.originalFilename || 'archivo')
    const businessId = normalizeBusinessId(input.businessId)
    const clientAccount = await resolveClientAccountContext({ ...input, businessId })
    const userId = input.userId ? String(input.userId) : null
    const module = normalizeModule(input.module)
    const moduleEntityId = input.moduleEntityId ? String(input.moduleEntityId) : null
    const subFolder = normalizeMediaFolderPath(input.subFolder || input.subfolder || '')
    const isPublic = input.isPublic !== undefined ? boolValue(input.isPublic) : true
    const clientUploadId = normalizeClientUploadId(
      input.clientUploadId ||
      input.client_upload_id ||
      input.uploadSessionId ||
      input.upload_session_id ||
      input.metadata?.clientUploadId ||
      input.metadata?.client_upload_id
    )

    const existingAsset = await findMediaAssetByClientUploadId({
      businessId,
      clientUploadId,
      clientAccount
    })
    if (existingAsset) {
      logger.info(`[MediaStorage] Reutilizando subida existente por clientUploadId: ${existingAsset.id}`)
      return existingAsset
    }

    const declaredStorageMimeType = storageMimeType(input.mimeType || input.contentType || '')
    const detectedMedia = await detectMimeType(headerSample, input.mimeType || input.contentType || '', originalFilename)
    const detected = {
      ...detectedMedia,
      mimeType: mimeBase(declaredStorageMimeType) === detectedMedia.mimeType
        ? declaredStorageMimeType
        : detectedMedia.mimeType
    }
    const mediaType = mediaTypeFromMime(detected.mimeType)
    validateMediaType({ mimeType: detected.mimeType, mediaType, sizeBytes, settings: config })

    await assertQuotaAvailable({ businessId, quotaSize: sizeBytes, config })

    // Video (siempre) y archivos grandes se transmiten directo a Bunny desde disco,
    // sin cargarlos en RAM ni recomprimir con ffmpeg (Bunny Stream ya transcodifica
    // el video). Esto elimina el OOM/502 en instancias con poca memoria.
    const useStreaming = hasTempFile && (mediaType === 'video' || sizeBytes > MEDIA_STREAMING_THRESHOLD_BYTES)
    if (useStreaming) {
      const asset = await finalizeStreamingMediaUpload({
        config,
        input,
        tempFilePath,
        sizeBytes,
        detected,
        mediaType,
        originalFilename,
        businessId,
        clientAccount,
        userId,
        module,
        moduleEntityId,
        isPublic,
        clientUploadId,
        onTempFileHandedOff: () => {
          tempFileHandedOff = true
          input.onTempFileHandedOff?.()
        }
      })
      return asset
    }

    if (!originalBuffer) {
      originalBuffer = await fs.readFile(tempFilePath)
    }

    const processed = await processMedia({
      buffer: originalBuffer,
      mimeType: detected.mimeType,
      mediaType,
      config,
      skipCompression: boolValue(input.skipCompression)
    })
    const processedDetected = await detectMimeType(processed.buffer, processed.mimeType, originalFilename)
    const processedStorageMimeType = storageMimeType(processed.mimeType)
    const finalMimeType = mimeBase(processedStorageMimeType) === processedDetected.mimeType
      ? processedStorageMimeType
      : processedDetected.mimeType
    const finalMediaType = mediaTypeFromMime(finalMimeType)
    const extension = extensionForMime(finalMimeType, originalFilename)
    const dimensions = await getImageMetadata(processed.buffer, finalMimeType)
    const thumbnail = await createImageThumbnail(processed.buffer, finalMimeType)
    const quotaSize = processed.buffer.length

    await assertQuotaAvailable({ businessId, quotaSize, config })

    const id = createRistakId('media')
    const storedFilename = `${id}-${filenameBase(originalFilename)}.${extension}`
    const dateKey = await getMediaStorageDateKey()
    const objectPath = buildObjectPath({
      businessId,
      clientAccount,
      mediaType: finalMediaType,
      module,
      id,
      filename: originalFilename,
      extension,
      dateKey,
      subFolder
    })
    const thumbnailPath = thumbnail ? buildObjectPath({
      businessId,
      clientAccount,
      mediaType: finalMediaType,
      module,
      id,
      filename: originalFilename,
      extension: thumbnail.extension,
      variant: 'thumb',
      dateKey,
      subFolder
    }) : ''

    pendingArtifactCleanup = {
      config,
      bunnyPaths: [],
      localPaths: [],
      streamVideoIds: []
    }

    let storageProvider = 'local'
    let publicUrl = buildAppPublicUrl(`/media/assets/${id}/file`)
    let deferredStreamSync = null
    const inputMetadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
    const uploadMetadata = inputMetadata.upload && typeof inputMetadata.upload === 'object' ? inputMetadata.upload : {}
    let metadata = {
      ...inputMetadata,
      ...(clientUploadId ? {
        clientUploadId,
        upload: {
          ...uploadMetadata,
          clientUploadId
        }
      } : {}),
      mimeDetection: detected.source,
      compression: processed.compression,
      storageStatus: config.storageStatus,
      clientAccount,
      variants: {}
    }

    if (config.provider === 'bunny' && config.bunnyConfigured) {
      pendingArtifactCleanup.bunnyPaths.push(objectPath)
      await uploadToBunny({ config, objectPath, buffer: processed.buffer, mimeType: finalMimeType })
      if (thumbnail) {
        pendingArtifactCleanup.bunnyPaths.push(thumbnailPath)
        await uploadToBunny({ config, objectPath: thumbnailPath, buffer: thumbnail.buffer, mimeType: thumbnail.mimeType })
        metadata.variants.thumbnail = {
          path: thumbnailPath,
          publicUrl: bunnyPublicUrl(config, thumbnailPath),
          mimeType: thumbnail.mimeType,
          sizeBytes: thumbnail.sizeBytes
        }
      }
      storageProvider = 'bunny'
      publicUrl = bunnyPublicUrl(config, objectPath)
      await ensureAccountReadme(config, clientAccount)
    } else {
      if (config.provider === 'bunny' && config.requireBunny) {
        throw errorWithStatus(`Bunny.net está activo pero falta configuración: ${config.missingEnvironment.join(', ')}`, 503, 'bunny_not_configured')
      }
      const expectedLocalPath = join(LOCAL_MEDIA_ROOT, objectPath)
      pendingArtifactCleanup.localPaths.push(expectedLocalPath)
      const localPath = await saveLocalFile({ objectPath, buffer: processed.buffer })
      metadata.localPath = localPath
      metadata.localFallback = true
      if (thumbnail) {
        pendingArtifactCleanup.localPaths.push(join(LOCAL_MEDIA_ROOT, thumbnailPath))
        const localThumbPath = await saveLocalFile({ objectPath: thumbnailPath, buffer: thumbnail.buffer })
        metadata.variants.thumbnail = {
          path: thumbnailPath,
          localPath: localThumbPath,
          mimeType: thumbnail.mimeType,
          sizeBytes: thumbnail.sizeBytes
        }
      }
      logger.warn(`[MediaStorage] Bunny no configurado; archivo guardado por fallback local: ${objectPath}`)
    }

    if (isBunnyStreamEligibleVideo({ mediaType: finalMediaType, module })) {
      const streamSyncInput = {
        config,
        id,
        businessId,
        module,
        moduleEntityId,
        originalFilename,
        objectPath,
        publicUrl,
        mimeType: finalMimeType,
        buffer: processed.buffer,
        clientAccount
      }
      if (boolValue(input.deferStreamSync) && config.bunnyStreamEnabled && config.bunnyStreamConfigured) {
        metadata.stream = buildPendingBunnyStreamMetadata(config, streamSyncInput)
        deferredStreamSync = streamSyncInput
      } else {
        metadata.stream = await syncVideoToBunnyStream(streamSyncInput)
        const streamVideoId = cleanString(metadata.stream?.videoId)
        if (streamVideoId) pendingArtifactCleanup.streamVideoIds.push(streamVideoId)
      }
    }

    const streamDimensions = dimensionsFromStreamMetadata(metadata.stream)

    await insertMediaAsset({
      id,
      businessId,
      userId,
      originalFilename,
      storedFilename,
      bunnyPath: objectPath,
      publicUrl,
      privateUrl: isPublic ? null : publicUrl,
      mimeType: finalMimeType,
      mediaType: finalMediaType,
      extension,
      sizeOriginal: sizeBytes,
      sizeProcessed: processed.buffer.length,
      quotaSize,
      width: streamDimensions.width || dimensions.width,
      height: streamDimensions.height || dimensions.height,
      duration: streamDimensions.duration || null,
      status: 'ready',
      storageProvider,
      storageZone: storageProvider === 'bunny' ? config.bunnyStorageZone : null,
      cdnBaseUrl: storageProvider === 'bunny' ? config.bunnyCdnBaseUrl : null,
      module,
      moduleEntityId,
      isPublic,
      metadata
    })
    mediaAssetPersisted = true

    await refreshQuotaUsage(businessId)
    if (deferredStreamSync) {
      scheduleDeferredBunnyStreamSync(deferredStreamSync)
    }
    logger.info(`[MediaStorage] Archivo listo: ${id} (${finalMediaType}, ${quotaSize} bytes)`)

    return await getMediaAsset(id)
  } catch (error) {
    if (!mediaAssetPersisted && pendingArtifactCleanup) {
      await cleanupUnpersistedMediaArtifacts(pendingArtifactCleanup)
    }
    throw error
  } finally {
    if (hasTempFile && !tempFileHandedOff) {
      await fs.rm(tempFilePath, { force: true }).catch(() => undefined)
    }
  }
}

// Subida por streaming (video y archivos grandes): nunca carga el archivo completo
// en RAM. Transmite el original a Bunny Storage desde disco y, si aplica, deja que
// Bunny Stream transcodifique el video (sincronización diferida que reusa el mismo
// temporal y lo borra al terminar).
async function finalizeStreamingMediaUpload({
  config,
  input,
  tempFilePath,
  sizeBytes,
  detected,
  mediaType,
  originalFilename,
  businessId,
  clientAccount,
  userId,
  module,
  moduleEntityId,
  isPublic,
  clientUploadId,
  onTempFileHandedOff
}) {
  const finalMimeType = detected.mimeType
  const finalMediaType = mediaType
  const extension = extensionForMime(finalMimeType, originalFilename)
  const id = createRistakId('media')
  const storedFilename = `${id}-${filenameBase(originalFilename)}.${extension}`
  const dateKey = await getMediaStorageDateKey()
  const subFolder = normalizeMediaFolderPath(input.subFolder || input.subfolder || '')
  const objectPath = buildObjectPath({
    businessId,
    clientAccount,
    mediaType: finalMediaType,
    module,
    id,
    filename: originalFilename,
    extension,
    dateKey,
    subFolder
  })

  let storageProvider = 'local'
  let publicUrl = buildAppPublicUrl(`/media/assets/${id}/file`)
  let deferredStreamSync = null
  const inputMetadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  const uploadMetadata = inputMetadata.upload && typeof inputMetadata.upload === 'object' ? inputMetadata.upload : {}
  const metadata = {
    ...inputMetadata,
    ...(clientUploadId ? {
      clientUploadId,
      upload: {
        ...uploadMetadata,
        clientUploadId
      }
    } : {}),
    mimeDetection: detected.source,
    compression: 'streamed',
    storageStatus: config.storageStatus,
    clientAccount,
    variants: {}
  }

  let mediaAssetPersisted = false
  const pendingArtifactCleanup = {
    config,
    bunnyPaths: [],
    localPaths: [],
    streamVideoIds: []
  }

  try {
  if (config.provider === 'bunny' && config.bunnyConfigured) {
    pendingArtifactCleanup.bunnyPaths.push(objectPath)
    await uploadFileToBunny({ config, objectPath, filePath: tempFilePath, size: sizeBytes, mimeType: finalMimeType })
    storageProvider = 'bunny'
    publicUrl = bunnyPublicUrl(config, objectPath)
    await ensureAccountReadme(config, clientAccount)
  } else {
    if (config.provider === 'bunny' && config.requireBunny) {
      throw errorWithStatus(`Bunny.net está activo pero falta configuración: ${config.missingEnvironment.join(', ')}`, 503, 'bunny_not_configured')
    }
    pendingArtifactCleanup.localPaths.push(join(LOCAL_MEDIA_ROOT, objectPath))
    const localPath = await saveLocalFileFromPath({ objectPath, filePath: tempFilePath })
    metadata.localPath = localPath
    metadata.localFallback = true
    logger.warn(`[MediaStorage] Bunny no configurado; archivo guardado por fallback local: ${objectPath}`)
  }

  if (isBunnyStreamEligibleVideo({ mediaType: finalMediaType, module })) {
    const streamSyncInput = {
      config,
      id,
      businessId,
      module,
      moduleEntityId,
      originalFilename,
      objectPath,
      publicUrl,
      mimeType: finalMimeType,
      filePath: tempFilePath,
      size: sizeBytes,
      clientAccount
    }
    if (boolValue(input.deferStreamSync) && config.bunnyStreamEnabled && config.bunnyStreamConfigured) {
      metadata.stream = buildPendingBunnyStreamMetadata(config, streamSyncInput)
      // El temporal sobrevive a la respuesta para que la sync diferida lo transmita;
      // se borra al terminar (ver scheduleDeferredBunnyStreamSync). El "handoff" se
      // marca hasta justo antes de agendarla (tras el insert), para que si algo falla
      // antes, el finally de uploadMediaAsset limpie el temporal y no se quede huérfano.
      deferredStreamSync = { ...streamSyncInput, cleanupFilePath: tempFilePath }
    } else {
      metadata.stream = await syncVideoToBunnyStream(streamSyncInput)
      const streamVideoId = cleanString(metadata.stream?.videoId)
      if (streamVideoId) pendingArtifactCleanup.streamVideoIds.push(streamVideoId)
    }
  }

  const streamDimensions = dimensionsFromStreamMetadata(metadata.stream)

  await insertMediaAsset({
    id,
    businessId,
    userId,
    originalFilename,
    storedFilename,
    bunnyPath: objectPath,
    publicUrl,
    privateUrl: isPublic ? null : publicUrl,
    mimeType: finalMimeType,
    mediaType: finalMediaType,
    extension,
    sizeOriginal: sizeBytes,
    sizeProcessed: sizeBytes,
    quotaSize: sizeBytes,
    width: streamDimensions.width || null,
    height: streamDimensions.height || null,
    duration: streamDimensions.duration || null,
    status: 'ready',
    storageProvider,
    storageZone: storageProvider === 'bunny' ? config.bunnyStorageZone : null,
    cdnBaseUrl: storageProvider === 'bunny' ? config.bunnyCdnBaseUrl : null,
    module,
    moduleEntityId,
    isPublic,
    metadata
  })
  mediaAssetPersisted = true

  await refreshQuotaUsage(businessId)
  // Leemos el asset ANTES de agendar la sync diferida: así, una vez que el temporal
  // pasa a manos de la sync diferida, ya no queda ningún await que pueda tronar y
  // disparar el catch del controlador (que borraría el temporal que aún se necesita).
  const asset = await getMediaAsset(id)
  if (deferredStreamSync) {
    onTempFileHandedOff?.()
    scheduleDeferredBunnyStreamSync(deferredStreamSync)
  }
  logger.info(`[MediaStorage] Archivo listo (streaming): ${id} (${finalMediaType}, ${sizeBytes} bytes)`)

  return asset
  } catch (error) {
    if (!mediaAssetPersisted) {
      await cleanupUnpersistedMediaArtifacts(pendingArtifactCleanup)
    }
    throw error
  }
}

export async function uploadMediaAssetFromDataUrl(input = {}) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(cleanString(input.fileBase64 || input.dataUrl || input.content))
  if (!match) {
    throw errorWithStatus('Archivo inválido: envía un data URL en base64.', 400, 'invalid_data_url')
  }

  return uploadMediaAsset({
    ...input,
    buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    mimeType: match[1]
  })
}

// Tope de tamaño para imágenes remotas rehospedadas (avatares, creativos…). Los
// avatares pesan KB; 8 MB es margen de sobra sin arriesgar la RAM del proceso.
const REMOTE_IMAGE_MAX_BYTES = Math.max(
  256 * 1024,
  Number(process.env.REMOTE_IMAGE_MAX_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024
)
const REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS || 15000) || 15000
)

// Descarga una URL remota a un Buffer con tope de tamaño y timeout. Devuelve
// { buffer, mimeType } o null si falla, se pasa de tamaño o no responde bien.
async function downloadRemoteMedia(url, { maxBytes = REMOTE_IMAGE_MAX_BYTES, timeoutMs = REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength && declaredLength > maxBytes) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > maxBytes) return null
    const headerMime = mimeBase(response.headers.get('content-type') || '')
    const detected = await detectMimeType(buffer, headerMime, url).catch(() => null)
    const mimeType = detected?.mimeType || headerMime || 'application/octet-stream'
    return { buffer, mimeType }
  } catch {
    return null
  }
}

// Rehospeda una imagen remota (que caduca, p.ej. avatar de Meta/WhatsApp) al Bunny
// central y devuelve la URL permanente. BEST-EFFORT: devuelve null si no se pudo,
// para que el caller conserve la URL cruda y NUNCA pierda la imagen. Si la URL ya
// es de nuestro Bunny, no re-hospeda (dedup barato).
export async function rehostRemoteImageToBunny({
  url,
  module = 'avatars',
  subFolder = '',
  filename = '',
  clientAccountId = '',
  businessId = '',
  metadata = {},
  requireImage = true,
  maxBytes = REMOTE_IMAGE_MAX_BYTES
} = {}) {
  const cleanUrl = cleanString(url)
  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return null

  const config = await getStorageRuntimeConfig().catch(() => null)
  // Dedup: si ya apunta a nuestro CDN de Bunny, no hay nada que rehospedar.
  const cdnBase = cleanString(config?.bunnyCdnBaseUrl)
  if (cdnBase && cleanUrl.startsWith(cdnBase)) {
    return { publicUrl: cleanUrl, reused: true }
  }
  // Sin Bunny configurado no tiene sentido intentar (dejamos la URL cruda).
  if (!config?.bunnyConfigured) return null

  const downloaded = await downloadRemoteMedia(cleanUrl, { maxBytes })
  if (!downloaded) return null
  // Por si la URL respondió una página de error en vez de una imagen.
  if (requireImage && !mimeBase(downloaded.mimeType).startsWith('image/')) return null

  try {
    const asset = await uploadMediaAsset({
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      filename: cleanString(filename) || 'imagen',
      module,
      subFolder,
      clientAccountId,
      businessId,
      isPublic: true,
      skipCompression: true,
      metadata: {
        ...metadata,
        source: metadata.source || 'rehosted_remote_image',
        originalUrl: cleanUrl
      }
    })
    return { publicUrl: asset.publicUrl, assetId: asset.id, reused: false }
  } catch (err) {
    logger.warn(`[MediaStorage] No se pudo rehospedar imagen remota: ${err?.message || err}`)
    return null
  }
}

// Ventana de refresco de avatares: si la copia en Bunny ya tiene más de esto y
// llega una foto cruda nueva (contacto activo), se re-baja para atrapar cambios de
// foto de perfil. Por defecto 7 días; configurable por env.
const AVATAR_REFRESH_AFTER_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.AVATAR_REFRESH_AFTER_MS) > 0
    ? Number(process.env.AVATAR_REFRESH_AFTER_MS)
    : (Number(process.env.AVATAR_REFRESH_AFTER_DAYS) > 0 ? Number(process.env.AVATAR_REFRESH_AFTER_DAYS) : 7) * 24 * 60 * 60 * 1000
)

// Antigüedad del avatar a partir del bucket de fecha en su ruta de Bunny
// (…/avatars/<canal>/YYYY/MM/DD/archivo). Sin fecha reconocible → null (se conserva).
function avatarAgeMsFromBunnyUrl(url = '') {
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(cleanString(url))
  if (!m) return null
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`)
  return Number.isNaN(t) ? null : Date.now() - t
}

// objectPath a partir de una URL pública de Bunny (para borrar la copia vieja al
// refrescar). Devuelve '' si la URL no es de nuestro CDN.
function bunnyObjectPathFromPublicUrl(config, url = '') {
  const base = cleanString(config?.bunnyCdnBaseUrl)
  const clean = cleanString(url)
  if (!base || !clean.startsWith(base)) return ''
  const rest = clean.slice(base.length).replace(/^\/+/, '').split('?')[0]
  return rest.split('/').map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
}

// Decide qué URL de avatar persistir para un contacto, con memoria y refresco:
//  - Si YA está en nuestro Bunny y la copia es RECIENTE → la conservamos (no la
//    pisamos con una URL cruda que caduca, ni re-hospedamos en cada mensaje).
//  - Si está en Bunny pero ya es VIEJA (> ventana) y llega una foto cruda nueva →
//    la refrescamos (rehospeda la actual) y borra la vieja. Atrapa cambios de foto.
//  - Si aún no está en Bunny → la rehospedamos.
//  - Si algo falla → conserva la Bunny actual o cae a la cruda (nunca se pierde).
// Devuelve { url, rehosted, kept, refreshed }. El caller guarda `url`.
export async function resolveAvatarForPersist({
  incomingUrl,
  currentUrl = '',
  channel = '',
  subFolder = '',
  clientAccountId = '',
  businessId = '',
  filename = '',
  refreshAfterMs = AVATAR_REFRESH_AFTER_MS
} = {}) {
  const incoming = cleanString(incomingUrl)
  const current = cleanString(currentUrl)
  const config = await getStorageRuntimeConfig().catch(() => null)
  const cdnBase = cleanString(config?.bunnyCdnBaseUrl)
  const isBunny = (value) => Boolean(cdnBase) && value.startsWith(cdnBase)
  const currentIsBunny = current && isBunny(current)

  if (currentIsBunny) {
    const ageMs = avatarAgeMsFromBunnyUrl(current)
    const stale = ageMs !== null && ageMs >= refreshAfterMs
    // Reciente, o sin foto nueva, o la nueva ya es de Bunny → conservar.
    if (!stale || !incoming || isBunny(incoming)) return { url: current, rehosted: false, kept: true }
    // Vieja + hay cruda nueva → refrescar (cae al rehospedado de abajo).
  } else {
    if (!incoming) return { url: current, rehosted: false, kept: true }
    if (isBunny(incoming)) return { url: incoming, rehosted: false, kept: true }
  }

  const rehosted = await rehostRemoteImageToBunny({
    url: incoming,
    module: 'avatars',
    subFolder: subFolder || channel,
    clientAccountId,
    businessId,
    filename: filename || `${channel || 'avatar'}.jpg`,
    metadata: { source: 'contact_avatar', channel }
  })
  if (rehosted?.publicUrl) {
    // Si fue un refresco, borra la copia vieja para no acumular huérfanos.
    if (currentIsBunny && config) {
      const oldPath = bunnyObjectPathFromPublicUrl(config, current)
      if (oldPath) deleteFromBunny({ config, objectPath: oldPath }).catch(() => {})
    }
    return { url: rehosted.publicUrl, rehosted: true, kept: false, refreshed: currentIsBunny }
  }
  // Falló: si refrescábamos, conservar la Bunny actual (no perder la buena);
  // si era nueva, caer a la cruda.
  return { url: currentIsBunny ? current : incoming, rehosted: false, kept: currentIsBunny }
}

// ── Helpers expuestos para el script de migración de taxonomía (Fase D) ──────────
// El contexto de cuenta actual (con el slug/rootPath destino de la nueva taxonomía).
export async function getCurrentClientAccountContext() {
  return resolveClientAccountContext({})
}
// URL de la API de Storage de Bunny para un objeto (para GET/PUT/DELETE directos).
export function resolveBunnyObjectUrl(config, objectPath) {
  return bunnyObjectUrl(config, objectPath)
}
// URL pública (CDN) de un objeto, tal como se guarda en las referencias.
export function resolveBunnyPublicUrl(config, objectPath) {
  return bunnyPublicUrl(config, objectPath)
}
// Borra un objeto del Storage de Bunny (idempotente: 404 no es error).
export async function deleteBunnyObject(config, objectPath) {
  return deleteFromBunny({ config, objectPath })
}

function normalizeStreamChart(chart = {}) {
  const source = chart && typeof chart === 'object' ? chart : {}
  return Object.entries(source)
    .map(([key, value]) => ({
      label: cleanString(key),
      value: numberValue(value),
      periodKey: cleanString(key),
      periodStart: cleanString(key),
      periodEnd: cleanString(key)
    }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey))
}

function normalizeStreamHeatmap(payload = {}) {
  const raw = payload?.heatmap || payload?.items || payload
  if (Array.isArray(raw)) {
    return raw
      .map((entry, index) => ({
        segment: numberValue(entry?.segment ?? entry?.position ?? entry?.second ?? entry?.time ?? index),
        intensity: Math.max(0, Math.min(100, numberValue(entry?.intensity ?? entry?.value ?? entry?.views))),
        label: cleanString(entry?.label) || `${index + 1}`
      }))
      .sort((a, b) => a.segment - b.segment)
  }

  if (raw && typeof raw === 'object') {
    return Object.entries(raw)
      .map(([key, value]) => ({
        segment: numberValue(key),
        intensity: Math.max(0, Math.min(100, numberValue(value))),
        label: cleanString(key)
      }))
      .sort((a, b) => a.segment - b.segment)
  }

  return []
}

function normalizeStreamCountryMetrics(viewCounts = {}, watchTimes = {}) {
  const countries = new Set([
    ...Object.keys(viewCounts || {}),
    ...Object.keys(watchTimes || {})
  ])

  return Array.from(countries)
    .map((country) => ({
      country: cleanString(country).toUpperCase(),
      views: numberValue(viewCounts?.[country]),
      watchTime: numberValue(watchTimes?.[country])
    }))
    .filter((entry) => entry.country)
    .sort((a, b) => b.views - a.views || b.watchTime - a.watchTime || a.country.localeCompare(b.country))
}

function emptyStreamAnalytics(asset, config, status, extra = {}) {
  return {
    assetId: asset.id,
    configured: Boolean(config?.bunnyStreamConfigured),
    status,
    dateFrom: extra.dateFrom || '',
    dateTo: extra.dateTo || '',
    hourly: Boolean(extra.hourly),
    stream: asset.metadata?.stream || null,
    video: asset.metadata?.stream?.video || null,
    summary: {
      views: numberValue(asset.metadata?.stream?.video?.views),
      watchTime: numberValue(asset.metadata?.stream?.video?.totalWatchTime),
      averageWatchTime: numberValue(asset.metadata?.stream?.video?.averageWatchTime),
      engagementScore: null,
      topCountry: ''
    },
    viewsChart: [],
    watchTimeChart: [],
    countries: [],
    heatmap: [],
    raw: null
  }
}

export async function getMediaAsset(assetId) {
  const row = await db.get('SELECT * FROM media_assets WHERE id = ?', [assetId])
  if (!row || row.deleted_at || row.status === 'deleted') {
    throw errorWithStatus('Archivo multimedia no encontrado.', 404, 'media_not_found')
  }
  return mapAssetRow(row)
}

export async function findMediaAssetsByIds(assetIds = []) {
  const seen = new Set()
  const ids = (Array.isArray(assetIds) ? assetIds : [])
    .map(cleanString)
    .filter((assetId) => {
      if (!assetId || seen.has(assetId)) return false
      seen.add(assetId)
      return true
    })

  if (!ids.length) return []

  const placeholders = ids.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT * FROM media_assets
     WHERE id IN (${placeholders})
       AND deleted_at IS NULL
       AND status = 'ready'
       AND is_public = 1`,
    ids
  )
  return rows.map(mapAssetRow).filter(Boolean)
}

export async function findMediaAssetsByPublicUrls(publicUrls = []) {
  const seen = new Set()
  const urls = (Array.isArray(publicUrls) ? publicUrls : [])
    .map(cleanString)
    .filter((url) => {
      if (!url || seen.has(url)) return false
      seen.add(url)
      return true
    })

  if (!urls.length) return []

  const placeholders = urls.map(() => '?').join(', ')
  const rows = await db.all(
    `SELECT * FROM media_assets
     WHERE public_url IN (${placeholders})
       AND deleted_at IS NULL
       AND status != 'deleted'`,
    urls
  )
  return rows.map(mapAssetRow).filter(Boolean)
}

export async function findMediaAssetsByBunnyStreamVideoIds(videoIds = [], {
  businessId = 'default',
  modules = ['sites', 'forms']
} = {}) {
  const seen = new Set()
  const ids = (Array.isArray(videoIds) ? videoIds : [])
    .map(cleanString)
    .filter((videoId) => {
      if (!videoId || seen.has(videoId)) return false
      seen.add(videoId)
      return true
    })

  if (!ids.length) return []

  const scopedModules = Array.from(new Set(
    (Array.isArray(modules) ? modules : [])
      .map(cleanString)
      .filter(Boolean)
      .map(normalizeModule)
  ))
  if (!scopedModules.length || scopedModules.length > 8) {
    throw errorWithStatus('El lookup de Stream necesita entre 1 y 8 módulos autorizados.', 400, 'invalid_media_modules')
  }

  const rows = await db.all(
    `SELECT * FROM media_assets
     WHERE business_id = ?
       AND module IN (${scopedModules.map(() => '?').join(', ')})
       AND media_type = 'video'
       AND stream_video_id IN (${ids.map(() => '?').join(', ')})
       AND deleted_at IS NULL
       AND status != 'deleted'`,
    [normalizeBusinessId(businessId), ...scopedModules, ...ids]
  )

  return rows.map(mapAssetRow).filter(Boolean)
}

export async function getMediaAssetBunnyStreamAnalytics(assetId, options = {}) {
  const asset = await getMediaAsset(assetId)
  if (asset.mediaType !== 'video') {
    throw errorWithStatus('Las analíticas de Stream solo aplican para videos.', 400, 'bunny_stream_not_video')
  }

  const config = await getStorageRuntimeConfig()
  const dateFrom = cleanString(options.dateFrom || options.date_from)
  const dateTo = cleanString(options.dateTo || options.date_to)
  const hourly = boolValue(options.hourly)
  const stream = asset.metadata?.stream || {}
  const videoId = cleanString(stream.videoId)

  if (!config.bunnyStreamEnabled) {
    return emptyStreamAnalytics(asset, config, 'disabled', { dateFrom, dateTo, hourly })
  }
  if (!config.bunnyStreamConfigured) {
    return emptyStreamAnalytics(asset, config, 'not_configured', { dateFrom, dateTo, hourly })
  }
  if (!videoId) {
    return emptyStreamAnalytics(asset, config, 'not_synced', { dateFrom, dateTo, hourly })
  }

  const [statistics, heatmapPayload, videoPayload] = await Promise.all([
    getBunnyStreamVideoStatistics(config, { videoGuid: videoId, dateFrom, dateTo, hourly }),
    getBunnyStreamVideoHeatmap(config, videoId).catch((error) => {
      logger.warn(`[MediaStorage] Bunny Stream heatmap no disponible para ${videoId}: ${error.message}`)
      return null
    }),
    getBunnyStreamVideo(config, videoId).catch((error) => {
      logger.warn(`[MediaStorage] Bunny Stream metadata no disponible para analíticas ${videoId}: ${error.message}`)
      return null
    })
  ])

  const video = normalizeBunnyStreamVideo(videoPayload) || stream.video || null
  const viewsChart = normalizeStreamChart(statistics?.viewsChart)
  const watchTimeChart = normalizeStreamChart(statistics?.watchTimeChart)
  const countries = normalizeStreamCountryMetrics(statistics?.countryViewCounts, statistics?.countryWatchTime)
  const heatmap = normalizeStreamHeatmap(heatmapPayload)
  const viewsFromChart = viewsChart.reduce((total, point) => total + numberValue(point.value), 0)
  const watchTimeFromChart = watchTimeChart.reduce((total, point) => total + numberValue(point.value), 0)
  const watchTime = numberValue(video?.totalWatchTime) || watchTimeFromChart
  const views = numberValue(video?.views) || viewsFromChart

  return {
    assetId: asset.id,
    configured: true,
    status: 'ready',
    dateFrom,
    dateTo,
    hourly,
    stream: {
      provider: stream.provider || 'bunny_stream',
      syncStatus: stream.syncStatus || '',
      libraryId: stream.libraryId || config.bunnyStreamLibraryId,
      collectionId: stream.collectionId || config.bunnyStreamCollectionId || null,
      collectionName: stream.collectionName || config.bunnyStreamCollectionName || null,
      videoId,
      title: stream.title || video?.title || asset.originalFilename,
      source: stream.source || null,
      syncedAt: stream.syncedAt || null
    },
    video,
    summary: {
      views,
      watchTime,
      averageWatchTime: numberValue(video?.averageWatchTime) || (views > 0 ? Math.round((watchTime / views) * 100) / 100 : 0),
      engagementScore: statistics?.engagementScore === undefined || statistics?.engagementScore === null
        ? null
        : numberValue(statistics.engagementScore),
      topCountry: countries[0]?.country || ''
    },
    viewsChart,
    watchTimeChart,
    countries,
    heatmap,
    raw: {
      statistics
    }
  }
}

function normalizeMediaLibraryLimit(value, fallback, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(1, Math.floor(parsed)))
}

function mediaLibraryCursorError() {
  return errorWithStatus('Cursor de Media inválido.', 400, 'invalid_media_cursor')
}

function encodeMediaLibraryCursor(kind, payload = {}) {
  return Buffer.from(JSON.stringify({ v: payload.scope ? 2 : 1, kind, ...payload }), 'utf8').toString('base64url')
}

function decodeMediaLibraryCursor(value, expectedKind, expectedScope = '') {
  const cursor = cleanString(value)
  if (!cursor) return null
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    const supportedVersion = payload?.v === 1 || payload?.v === 2
    const legacyCursor = payload?.v === 1 && !payload?.scope
    if (
      !supportedVersion || payload?.kind !== expectedKind ||
      (expectedScope && !legacyCursor && payload?.scope !== expectedScope) ||
      (payload?.v === 2 && (!expectedScope || payload?.scope !== expectedScope))
    ) throw mediaLibraryCursorError()
    return payload
  } catch (error) {
    if (error?.code === 'invalid_media_cursor') throw error
    throw mediaLibraryCursorError()
  }
}

function mediaLibraryTimestampExpression(column = 'created_at') {
  return databaseDialect === 'postgres'
    ? `COALESCE(${column}, TIMESTAMP '${MEDIA_LIBRARY_CURSOR_FALLBACK_TIMESTAMP}')`
    : `COALESCE(${column}, '${MEDIA_LIBRARY_CURSOR_FALLBACK_TIMESTAMP}')`
}

function mediaLibraryCursorProjectionExpression(timestampExpression) {
  // node-postgres convierte TIMESTAMP a Date y pierde los microsegundos. La
  // columna privada del cursor se serializa en SQL; el DTO publico conserva su
  // tipo habitual y la llave keyset mantiene precision total.
  return databaseDialect === 'postgres'
    ? `(${timestampExpression})::text`
    : timestampExpression
}

function mediaLibraryAssetCursorScope(input = {}) {
  const exactModule = cleanString(input.module)
  const modules = exactModule
    ? []
    : Array.from(new Set(
        (Array.isArray(input.modules) ? input.modules : [])
          .map(cleanString)
          .filter(Boolean)
          .map(normalizeModule)
      )).sort()
  const folderIsScoped = input.folderPath !== null && input.folderPath !== undefined
  return crypto.createHash('sha256').update(JSON.stringify({
    businessId: normalizeBusinessId(input.businessId),
    module: exactModule ? normalizeModule(exactModule) : '',
    modules,
    mediaType: cleanString(input.mediaType).toLowerCase(),
    status: cleanString(input.status).toLowerCase(),
    searchTerms: mediaLibrarySearchTerms(input.search),
    folderPath: folderIsScoped ? normalizeMediaFolderPath(input.folderPath) : null,
    recursive: folderIsScoped && boolValue(input.recursive)
  })).digest('base64url')
}

function cursorTimestampValue(value) {
  if (value instanceof Date) return value.toISOString()
  const normalized = cleanString(value)
  return normalized || MEDIA_LIBRARY_CURSOR_FALLBACK_TIMESTAMP
}

function escapeMediaLibraryLike(value = '') {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`)
}

function mediaLibrarySearchTerms(value = '') {
  return cleanString(value)
    .toLowerCase()
    .slice(0, 160)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
}

function buildMediaLibraryFilters(input = {}, { alias = '', omitMediaType = false } = {}) {
  const column = (name) => alias ? `${alias}.${name}` : name
  const clauses = [
    `${column('business_id')} = ?`,
    `${column('deleted_at')} IS NULL`,
    `${column('status')} != 'deleted'`
  ]
  const params = [normalizeBusinessId(input.businessId)]

  if (input.module) {
    clauses.push(`${column('module')} = ?`)
    params.push(normalizeModule(input.module))
  } else if (Array.isArray(input.modules) && input.modules.length) {
    const modules = Array.from(new Set(
      input.modules.map(cleanString).filter(Boolean).map(normalizeModule)
    ))
    if (modules.length > 8) {
      throw errorWithStatus('Media acepta máximo 8 módulos por consulta.', 400, 'invalid_media_modules')
    }
    if (modules.length) {
      clauses.push(`${column('module')} IN (${modules.map(() => '?').join(', ')})`)
      params.push(...modules)
    }
  }
  if (!omitMediaType && input.mediaType) {
    clauses.push(`${column('media_type')} = ?`)
    params.push(cleanString(input.mediaType).toLowerCase())
  }
  if (input.status) {
    clauses.push(`${column('status')} = ?`)
    params.push(cleanString(input.status).toLowerCase())
  }

  if (input.folderPath !== null && input.folderPath !== undefined) {
    const folderPath = normalizeMediaFolderPath(input.folderPath)
    if (boolValue(input.recursive)) {
      if (folderPath) {
        clauses.push(`(${column('folder_path')} = ? OR ${column('folder_path')} LIKE ? ESCAPE '\\')`)
        params.push(folderPath, `${escapeMediaLibraryLike(folderPath)}/%`)
      }
    } else {
      clauses.push(`COALESCE(${column('folder_path')}, '') = ?`)
      params.push(folderPath)
    }
  }

  const searchDocument = `LOWER(COALESCE(${column('original_filename')}, '') || ' ' || COALESCE(${column('stored_filename')}, '') || ' ' || COALESCE(${column('bunny_path')}, '') || ' ' || COALESCE(${column('public_url')}, '') || ' ' || COALESCE(${column('mime_type')}, '') || ' ' || COALESCE(${column('media_type')}, '') || ' ' || COALESCE(${column('module')}, ''))`
  for (const term of mediaLibrarySearchTerms(input.search)) {
    clauses.push(`${searchDocument} LIKE ? ESCAPE '\\'`)
    params.push(`%${escapeMediaLibraryLike(term)}%`)
  }

  return { clauses, params }
}

function buildMediaFolderCounterFilters(input = {}, { alias = 'f' } = {}) {
  const column = (name) => alias ? `${alias}.${name}` : name
  const clauses = [`${column('business_id')} = ?`]
  const params = [normalizeBusinessId(input.businessId)]

  if (input.module) {
    clauses.push(`${column('module')} = ?`)
    params.push(normalizeModule(input.module))
  } else if (Array.isArray(input.modules) && input.modules.length) {
    const modules = Array.from(new Set(
      input.modules.map(cleanString).filter(Boolean).map(normalizeModule)
    ))
    if (modules.length > 8) {
      throw errorWithStatus('Media acepta máximo 8 módulos por consulta.', 400, 'invalid_media_modules')
    }
    if (modules.length) {
      clauses.push(`${column('module')} IN (${modules.map(() => '?').join(', ')})`)
      params.push(...modules)
    }
  }
  if (input.mediaType) {
    clauses.push(`${column('media_type')} = ?`)
    params.push(cleanString(input.mediaType).toLowerCase())
  }
  if (input.status) {
    clauses.push(`${column('status')} = ?`)
    params.push(cleanString(input.status).toLowerCase())
  }

  return { clauses, params }
}

export async function listMediaFolders({
  businessId = 'default',
  parentPath = '',
  module = '',
  modules = [],
  mediaType = '',
  status = '',
  limit = MEDIA_FOLDER_DEFAULT_LIMIT,
  cursor = ''
} = {}) {
  const normalizedParentPath = normalizeMediaFolderPath(parentPath)
  const safeLimit = normalizeMediaLibraryLimit(limit, MEDIA_FOLDER_DEFAULT_LIMIT, MEDIA_FOLDER_MAX_LIMIT)
  const decodedCursor = decodeMediaLibraryCursor(cursor, 'media-folder')
  const cursorName = decodedCursor ? cleanString(decodedCursor.name) : ''
  if (decodedCursor && !cursorName) throw mediaLibraryCursorError()

  // Esta consulta navega un resumen exacto por carpeta; su costo depende del
  // numero de carpetas/dimensiones, no del numero de archivos del negocio.
  const filters = buildMediaFolderCounterFilters({ businessId, module, modules, mediaType, status })
  const slashPosition = databaseDialect === 'postgres'
    ? `POSITION('/' IN relative_path)`
    : `instr(relative_path, '/')`
  const cursorClause = cursorName ? 'AND child_name > ?' : ''
  const prefix = normalizedParentPath
    ? `${escapeMediaLibraryLike(normalizedParentPath)}/%`
    : '%'
  const params = [
    normalizedParentPath,
    ...filters.params,
    prefix,
    ...(cursorName ? [cursorName] : []),
    safeLimit + 1
  ]

  const rows = await db.all(
    `WITH options AS (
       SELECT ? AS parent_path
     ), scoped AS (
       SELECT
         f.folder_path,
         f.files_count,
         f.used_bytes,
         CASE
           WHEN options.parent_path = '' THEN f.folder_path
           ELSE substr(f.folder_path, length(options.parent_path) + 2)
         END AS relative_path
       FROM media_folder_usage_counters f
       CROSS JOIN options
       WHERE ${filters.clauses.join(' AND ')}
         AND f.folder_path <> options.parent_path
         AND (options.parent_path = '' OR f.folder_path LIKE ? ESCAPE '\\')
     ), children AS (
       SELECT
         CASE
           WHEN ${slashPosition} > 0 THEN substr(relative_path, 1, ${slashPosition} - 1)
           ELSE relative_path
         END AS child_name,
         files_count,
         used_bytes
       FROM scoped
     )
     SELECT
       child_name,
       COALESCE(SUM(files_count), 0) AS files_count,
       COALESCE(SUM(used_bytes), 0) AS size_bytes
     FROM children
     WHERE child_name <> ''
       ${cursorClause}
     GROUP BY child_name
     ORDER BY child_name ASC
     LIMIT ?`,
    params
  )

  const hasMore = rows.length > safeLimit
  const pageRows = rows.slice(0, safeLimit)
  const folders = pageRows.map((row) => ({
    path: normalizeMediaFolderPath([normalizedParentPath, row.child_name].filter(Boolean).join('/')),
    name: cleanString(row.child_name),
    filesCount: numberValue(row.files_count),
    sizeBytes: numberValue(row.size_bytes)
  }))
  const lastFolder = folders[folders.length - 1]

  return {
    items: folders,
    pageInfo: {
      limit: safeLimit,
      hasMore,
      nextCursor: hasMore && lastFolder
        ? encodeMediaLibraryCursor('media-folder', { name: pageRows[pageRows.length - 1].child_name })
        : null
    }
  }
}

export async function listMediaAssets({
  businessId = 'default',
  module = '',
  modules = [],
  mediaType = '',
  status = '',
  search = '',
  folderPath = null,
  recursive = false,
  limit = MEDIA_LIBRARY_DEFAULT_LIMIT,
  cursor = '',
  includeMeta = true,
  includeFolders = true
} = {}) {
  const safeLimit = normalizeMediaLibraryLimit(limit, MEDIA_LIBRARY_DEFAULT_LIMIT, MEDIA_LIBRARY_MAX_LIMIT)
  const sortTimestamp = mediaLibraryTimestampExpression('created_at')
  const filtersInput = { businessId, module, modules, mediaType, status, search, folderPath, recursive }
  const cursorScope = mediaLibraryAssetCursorScope(filtersInput)
  const decodedCursor = decodeMediaLibraryCursor(cursor, 'media-asset', cursorScope)
  const filters = buildMediaLibraryFilters(filtersInput)

  if (decodedCursor) {
    const cursorCreatedAt = cursorTimestampValue(decodedCursor.createdAt)
    const cursorId = cleanString(decodedCursor.id)
    if (
      cursorCreatedAt.length > 100 || !Number.isFinite(Date.parse(cursorCreatedAt)) ||
      !cursorId || cursorId.length > 300
    ) throw mediaLibraryCursorError()
    filters.clauses.push(`(${sortTimestamp} < ? OR (${sortTimestamp} = ? AND id < ?))`)
    filters.params.push(cursorCreatedAt, cursorCreatedAt, cursorId)
  }

  const metaEnabled = boolValue(includeMeta, true)
  const isGlobalFolderScope = folderPath === null || folderPath === undefined || (
    boolValue(recursive) && normalizeMediaFolderPath(folderPath) === ''
  )
  const canUseGlobalDurableSummary = metaEnabled &&
    !cleanString(module) &&
    (!Array.isArray(modules) || modules.length === 0) &&
    !cleanString(status) &&
    !mediaLibrarySearchTerms(search).length &&
    isGlobalFolderScope
  const canUseExactFolderSummary = metaEnabled &&
    folderPath !== null && folderPath !== undefined &&
    !boolValue(recursive) &&
    !mediaLibrarySearchTerms(search).length
  // El árbol de carpetas tiene su propia ruta progresiva. No debe retrasar la
  // primera página de archivos con un GROUP BY de todos los descendientes.
  const shouldExposeFolderContract = metaEnabled && boolValue(includeFolders, true)
  const rowsPromise = db.all(
    `SELECT
       ${MEDIA_LIBRARY_LIST_COLUMNS},
       ${mediaLibraryCursorProjectionExpression(sortTimestamp)} AS cursor_created_at
     FROM media_assets
     WHERE ${filters.clauses.join(' AND ')}
     ORDER BY ${sortTimestamp} DESC, id DESC
     LIMIT ?`,
    [...filters.params, safeLimit + 1]
  )

  const exactFolderFilters = canUseExactFolderSummary
    ? buildMediaFolderCounterFilters({ businessId, module, modules, mediaType, status })
    : null
  const exactFolderSummaryPromise = exactFolderFilters
    ? db.get(
        `SELECT
           COALESCE(SUM(files_count), 0) AS total_items,
           COALESCE(SUM(used_bytes), 0) AS total_bytes
         FROM media_folder_usage_counters f
         WHERE ${exactFolderFilters.clauses.join(' AND ')}
           AND folder_path = ?`,
        [...exactFolderFilters.params, normalizeMediaFolderPath(folderPath)]
      )
    : null
  const [rows, usageCounters, exactFolderSummary] = await Promise.all([
    rowsPromise,
    canUseGlobalDurableSummary ? readActiveUsageCounters(businessId) : [],
    exactFolderSummaryPromise
  ])
  const normalizedSummaryMediaType = cleanString(mediaType).toLowerCase()
  const summaryCounters = normalizedSummaryMediaType
    ? usageCounters.filter((row) => row.mediaType === normalizedSummaryMediaType)
    : usageCounters

  const hasMore = rows.length > safeLimit
  const pageRows = rows.slice(0, safeLimit)
  const lastRow = pageRows[pageRows.length - 1]

  return {
    items: pageRows.map(mapAssetRow),
    pageInfo: {
      limit: safeLimit,
      hasMore,
      nextCursor: hasMore && lastRow
        ? encodeMediaLibraryCursor('media-asset', {
            scope: cursorScope,
            createdAt: cursorTimestampValue(lastRow.cursor_created_at),
            id: lastRow.id
          })
        : null
    },
    summary: canUseGlobalDurableSummary
      ? {
          totalItems: summaryCounters.reduce((total, row) => total + row.filesCount, 0),
          totalBytes: summaryCounters.reduce((total, row) => total + row.usedBytes, 0)
        }
      : exactFolderSummary
        ? {
            totalItems: numberValue(exactFolderSummary.total_items),
            totalBytes: numberValue(exactFolderSummary.total_bytes)
          }
        : null,
    // Compatibilidad de respuesta. Las facets no tienen consumidor y obligaban
    // a otro GROUP BY completo en cada primera página.
    facets: [],
    folders: [],
    folderPageInfo: {
      limit: MEDIA_FOLDER_DEFAULT_LIMIT,
      hasMore: false,
      nextCursor: null
    },
    foldersDeferred: shouldExposeFolderContract
  }
}

export async function getStorageUsage({ businessId = 'default' } = {}) {
  const config = await getStorageRuntimeConfig()
  const normalizedBusinessId = normalizeBusinessId(businessId)
  // Esta ruta es de lectura. No crea cuotas, no recalcula toda media_assets y
  // no escribe updated_at cada vez que alguien abre Configuración > Media.
  const storedQuota = await db.get(
    'SELECT * FROM storage_quotas WHERE business_id = ?',
    [normalizedBusinessId]
  )
  const defaultQuotaGb = numberValue(config?.defaultQuotaGb, 5)
  const quota = storedQuota || {
    quota_gb: defaultQuotaGb,
    quota_bytes: Math.round(defaultQuotaGb * GB),
    used_bytes: 0,
    extra_quota_gb: 0,
    storage_enabled: 1
  }
  const usageCounters = await readActiveUsageCounters(normalizedBusinessId)
  const usedBytes = usageCounters.reduce((total, row) => total + row.usedBytes, 0)
  const quotaBytes = numberValue(quota.quota_bytes, Math.round(numberValue(quota.quota_gb, 5) * GB))
  const extraQuotaGb = numberValue(quota.extra_quota_gb)
  const totalQuotaBytes = quotaBytes + Math.round(extraQuotaGb * GB)
  const availableBytes = Math.max(0, totalQuotaBytes - usedBytes)
  const userRow = await db.get('SELECT business_name, full_name, email FROM users ORDER BY id ASC LIMIT 1').catch(() => null)

  const byMediaType = { images: 0, videos: 0, audio: 0, documents: 0, other: 0 }
  const byModule = {}
  let filesCount = 0
  for (const row of usageCounters) {
    const key = row.mediaType === 'image'
      ? 'images'
      : row.mediaType === 'video'
        ? 'videos'
        : row.mediaType === 'audio'
          ? 'audio'
          : row.mediaType === 'document'
            ? 'documents'
            : 'other'
    byMediaType[key] += row.usedBytes
    byModule[row.module] = numberValue(byModule[row.module]) + row.usedBytes
    filesCount += row.filesCount
  }

  return {
    business_id: normalizedBusinessId,
    business_name: userRow?.business_name || userRow?.full_name || userRow?.email || '',
    storage_provider: config.provider,
    storage_status: config.storageStatus,
    quota_gb: numberValue(quota.quota_gb, 5),
    quota_bytes: totalQuotaBytes,
    included_quota_bytes: quotaBytes,
    extra_quota_gb: extraQuotaGb,
    used_bytes: usedBytes,
    available_bytes: availableBytes,
    usage_percent: totalQuotaBytes > 0 ? Math.round((usedBytes / totalQuotaBytes) * 10000) / 100 : 0,
    files_count: filesCount,
    by_media_type: byMediaType,
    by_module: byModule,
    storage_enabled: boolValue(quota.storage_enabled, true),
    last_calculated_at: nowIso()
  }
}

async function moveSingleMediaAsset({
  assetId,
  targetFolderPath = '',
  businessId = '',
  skipQuotaRefresh = false,
  operationDeadlineAt = 0
}) {
  const asset = await getMediaAsset(assetId)
  const normalizedBusinessId = businessId ? normalizeBusinessId(businessId) : asset.businessId
  if (asset.businessId !== normalizedBusinessId) {
    throw errorWithStatus('Archivo multimedia no encontrado.', 404, 'media_not_found')
  }

  const nextFolderPath = normalizeMediaFolderPath(targetFolderPath)
  const nextObjectPath = buildMovedObjectPath(asset, nextFolderPath)
  if (asset.bunnyPath === nextObjectPath) return asset

  const metadata = {
    ...(asset.metadata || {}),
    movedAt: nowIso(),
    previousBunnyPath: asset.bunnyPath || ''
  }
  const thumbnail = metadata.variants?.thumbnail || null
  const nextThumbnailObjectPath = thumbnail?.path ? nextVariantPath(nextObjectPath, thumbnail.path) : ''
  let nextPublicUrl = asset.publicUrl || buildAppPublicUrl(`/media/assets/${asset.id}/file`)
  let nextPrivateUrl = asset.privateUrl || null
  let bunnyCleanupPaths = []

  if (asset.storageProvider === 'bunny') {
    const config = await getStorageRuntimeConfig()
    if (!config.bunnyConfigured) {
      throw errorWithStatus('Bunny.net no está configurado para mover este archivo.', 503, 'bunny_not_configured')
    }

    const source = await getMediaAssetReadStream(asset.id, { deadlineAt: operationDeadlineAt })
    await uploadReadableStreamToBunny({
      config,
      objectPath: nextObjectPath,
      stream: source.stream,
      size: source.contentLength,
      mimeType: asset.mimeType,
      deadlineAt: operationDeadlineAt
    })

    if (thumbnail?.path && nextThumbnailObjectPath) {
      const thumbnailBuffer = await readBunnyObjectBuffer({
        config,
        objectPath: thumbnail.path,
        publicUrl: thumbnail.publicUrl,
        deadlineAt: operationDeadlineAt
      })
      await uploadToBunny({
        config,
        objectPath: nextThumbnailObjectPath,
        buffer: thumbnailBuffer,
        mimeType: thumbnail.mimeType || 'image/webp',
        deadlineAt: operationDeadlineAt
      })
      metadata.variants = {
        ...(metadata.variants || {}),
        thumbnail: {
          ...thumbnail,
          path: nextThumbnailObjectPath,
          publicUrl: bunnyPublicUrl(config, nextThumbnailObjectPath)
        }
      }
      bunnyCleanupPaths.push(thumbnail.path)
    }

    nextPublicUrl = bunnyPublicUrl(config, nextObjectPath)
    nextPrivateUrl = asset.privateUrl ? nextPublicUrl : null
    bunnyCleanupPaths.push(asset.bunnyPath)
  } else {
    if (metadata.localPath) {
      metadata.localPath = await moveLocalFile(metadata.localPath, nextObjectPath)
    }

    if (thumbnail?.localPath && nextThumbnailObjectPath) {
      const nextLocalThumbPath = await moveLocalFile(thumbnail.localPath, nextThumbnailObjectPath)
      metadata.variants = {
        ...(metadata.variants || {}),
        thumbnail: {
          ...thumbnail,
          path: nextThumbnailObjectPath,
          localPath: nextLocalThumbPath
        }
      }
    }
  }

  await db.run(
    `UPDATE media_assets
     SET bunny_path = ?,
         folder_path = ?,
         public_url = ?,
         private_url = ?,
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextObjectPath,
      nextFolderPath,
      nextPublicUrl,
      nextPrivateUrl,
      JSON.stringify(metadata),
      asset.id
    ]
  )

  if (bunnyCleanupPaths.length) {
    const config = await getStorageRuntimeConfig()
    for (const objectPath of bunnyCleanupPaths.filter(Boolean)) {
      await deleteFromBunny({ config, objectPath, deadlineAt: operationDeadlineAt }).catch((error) => {
        logger.warn(`[MediaStorage] No se pudo borrar ruta vieja al mover ${asset.id}: ${error.message}`)
      })
    }
  }

  if (!skipQuotaRefresh) await refreshQuotaUsage(asset.businessId)
  logger.info(`[MediaStorage] Archivo movido: ${asset.id} -> ${nextObjectPath}`)
  return await getMediaAsset(asset.id)
}

export async function moveMediaAssets({ entries = [], assetIds = [], targetFolderPath = '', businessId = 'default' } = {}) {
  const normalizedEntries = Array.isArray(entries) && entries.length
    ? entries
    : Array.isArray(assetIds)
      ? assetIds.map((id) => ({ id, targetFolderPath }))
      : []

  const seen = new Set()
  const cleanEntries = normalizedEntries
    .map((entry) => ({
      id: cleanString(typeof entry === 'string' ? entry : entry?.id),
      targetFolderPath: normalizeMediaFolderPath(typeof entry === 'object' && entry ? entry.targetFolderPath ?? entry.folderPath ?? targetFolderPath : targetFolderPath)
    }))
    .filter((entry) => {
      if (!entry.id || seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })

  if (!cleanEntries.length) {
    throw errorWithStatus('Selecciona al menos un archivo para mover.', 400, 'invalid_media_move')
  }
  if (cleanEntries.length > MEDIA_SELECTION_MAX_EXPLICIT_IDS) {
    throw errorWithStatus(
      `Selecciona máximo ${MEDIA_SELECTION_MAX_EXPLICIT_IDS} archivos explícitos por operación.`,
      413,
      'media_selection_too_large'
    )
  }

  const requestedIds = cleanEntries.map((entry) => entry.id)
  const scopedRows = await db.all(
    `SELECT id, storage_provider, quota_size, stream_video_id
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'
       AND id IN (${requestedIds.map(() => '?').join(', ')})`,
    [normalizeBusinessId(businessId), ...requestedIds]
  )
  if (scopedRows.length !== requestedIds.length) {
    throw errorWithStatus(
      'Uno o más archivos ya no existen o no pertenecen a esta cuenta.',
      404,
      'media_selection_assets_missing'
    )
  }
  const operationDeadlineAt = assertSynchronousRemoteSelectionBudget(scopedRows)

  const moved = []
  for (const entry of cleanEntries) {
    moved.push(await moveSingleMediaAsset({
      assetId: entry.id,
      targetFolderPath: entry.targetFolderPath,
      businessId,
      // Mover cambia la ruta, no el tamaño. El endpoint ya es un lote; hacer
      // SUM(media_assets) por cada archivo multiplicaba el costo sin aportar
      // exactitud alguna.
      skipQuotaRefresh: true,
      operationDeadlineAt
    }))
  }

  return moved
}

function normalizeMediaSelection({ assetIds = [], folderPaths = [] } = {}) {
  const uniqueIds = Array.from(new Set(
    (Array.isArray(assetIds) ? assetIds : [])
      .map(cleanString)
      .filter(Boolean)
  ))
  const candidateFolderPaths = Array.from(new Set(
    (Array.isArray(folderPaths) ? folderPaths : [])
      .map(normalizeMediaFolderPath)
      .filter(Boolean)
  )).sort((left, right) => left.length - right.length || left.localeCompare(right))
  const uniqueFolderPaths = candidateFolderPaths.filter((folderPath, index) => (
    !candidateFolderPaths.slice(0, index).some((parentPath) => folderPath.startsWith(`${parentPath}/`))
  ))

  if (uniqueIds.length > MEDIA_SELECTION_MAX_EXPLICIT_IDS) {
    throw errorWithStatus(
      `Selecciona máximo ${MEDIA_SELECTION_MAX_EXPLICIT_IDS} archivos explícitos por operación. Las carpetas completas deben enviarse como carpetas.`,
      413,
      'media_selection_too_large'
    )
  }
  if (uniqueFolderPaths.length > MEDIA_SELECTION_MAX_FOLDER_PATHS) {
    throw errorWithStatus(
      `Selecciona máximo ${MEDIA_SELECTION_MAX_FOLDER_PATHS} carpetas por operación.`,
      413,
      'media_selection_too_large'
    )
  }
  if (!uniqueIds.length && !uniqueFolderPaths.length) {
    throw errorWithStatus('Selecciona al menos un archivo o carpeta.', 400, 'invalid_media_selection')
  }

  return { assetIds: uniqueIds, folderPaths: uniqueFolderPaths }
}

function buildMediaSelectionFilters({
  businessId = 'default',
  assetIds = [],
  folderPaths = [],
  mediaType = '',
  status = ''
} = {}) {
  const selection = normalizeMediaSelection({ assetIds, folderPaths })
  const scopeClauses = []
  const scopeParams = []

  if (selection.assetIds.length) {
    scopeClauses.push(`id IN (${selection.assetIds.map(() => '?').join(', ')})`)
    scopeParams.push(...selection.assetIds)
  }
  for (const folderPath of selection.folderPaths) {
    scopeClauses.push(`(folder_path = ? OR folder_path LIKE ? ESCAPE '\\')`)
    scopeParams.push(folderPath, `${escapeMediaLibraryLike(folderPath)}/%`)
  }

  const clauses = [
    'business_id = ?',
    'deleted_at IS NULL',
    "status != 'deleted'"
  ]
  const params = [normalizeBusinessId(businessId)]
  const normalizedMediaType = cleanString(mediaType).toLowerCase()
  const normalizedStatus = cleanString(status).toLowerCase()
  if (normalizedMediaType) {
    clauses.push('media_type = ?')
    params.push(normalizedMediaType)
  }
  if (normalizedStatus) {
    clauses.push('status = ?')
    params.push(normalizedStatus)
  }
  clauses.push(`(${scopeClauses.join(' OR ')})`)
  params.push(...scopeParams)

  return {
    selection,
    clauses,
    params,
    mediaType: normalizedMediaType,
    status: normalizedStatus
  }
}

function selectedSourceFolder(folderPath, selectedFolderPaths = []) {
  const normalized = normalizeMediaFolderPath(folderPath)
  return selectedFolderPaths.find((candidate) => (
    normalized === candidate || normalized.startsWith(`${candidate}/`)
  )) || ''
}

function movedSelectionFolderPath(currentFolderPath, sourceFolderPath, targetFolderPath) {
  if (!sourceFolderPath) return normalizeMediaFolderPath(targetFolderPath)
  const sourceName = sourceFolderPath.split('/').filter(Boolean).pop() || sourceFolderPath
  const relativePath = currentFolderPath === sourceFolderPath
    ? ''
    : currentFolderPath.slice(sourceFolderPath.length + 1)
  return normalizeMediaFolderPath([targetFolderPath, sourceName, relativePath].filter(Boolean).join('/'))
}

function assertSynchronousRemoteSelectionBudget(rows = []) {
  const remoteRows = rows.filter((row) => (
    ['bunny', 'bunny_stream'].includes(cleanString(row.storage_provider).toLowerCase()) ||
    Boolean(cleanString(row.stream_video_id))
  ))
  const remoteBytes = remoteRows.reduce((total, row) => total + numberValue(row.quota_size), 0)
  const oversizedRemote = remoteRows.find((row) => numberValue(row.quota_size) > MEDIA_REMOTE_SELECTION_MAX_ITEM_BYTES)
  if (
    remoteRows.length > MEDIA_REMOTE_SELECTION_MAX_ITEMS ||
    remoteBytes > MEDIA_REMOTE_SELECTION_MAX_TOTAL_BYTES ||
    oversizedRemote
  ) {
    throw errorWithStatus(
      `La selección remota rebasa el límite síncrono seguro (${MEDIA_REMOTE_SELECTION_MAX_ITEMS} archivos, 64 MB por archivo o 256 MB totales). Divide la carpeta en lotes más pequeños.`,
      413,
      'media_remote_selection_requires_smaller_batch'
    )
  }
  return remoteRows.length ? Date.now() + MEDIA_REMOTE_SELECTION_TIME_BUDGET_MS : 0
}

async function runMediaSelectionOperation({
  businessId = 'default',
  assetIds = [],
  folderPaths = [],
  mediaType = '',
  status = '',
  operation,
  action
} = {}) {
  const filters = buildMediaSelectionFilters({ businessId, assetIds, folderPaths, mediaType, status })
  const sortTimestamp = mediaLibraryTimestampExpression('created_at')
  let attempted = 0
  let affected = 0
  let failed = 0
  const failures = []

  if (filters.selection.assetIds.length) {
    const requestedIds = filters.selection.assetIds
    const explicitClauses = [
      'business_id = ?',
      'deleted_at IS NULL',
      "status != 'deleted'"
    ]
    const explicitParams = [normalizeBusinessId(businessId)]
    if (filters.mediaType) {
      explicitClauses.push('media_type = ?')
      explicitParams.push(filters.mediaType)
    }
    if (filters.status) {
      explicitClauses.push('status = ?')
      explicitParams.push(filters.status)
    }
    explicitClauses.push(`id IN (${requestedIds.map(() => '?').join(', ')})`)
    explicitParams.push(...requestedIds)
    const presentRows = await db.all(
      `SELECT id
       FROM media_assets
       WHERE ${explicitClauses.join(' AND ')}`,
      explicitParams
    )
    const presentIds = new Set(presentRows.map((row) => cleanString(row.id)))
    const missingIds = requestedIds.filter((id) => !presentIds.has(id))
    if (missingIds.length) {
      const error = errorWithStatus(
        `${missingIds.length} archivo${missingIds.length === 1 ? '' : 's'} de la selección ya no existe${missingIds.length === 1 ? '' : 'n'}, no pertenece${missingIds.length === 1 ? '' : 'n'} a esta cuenta o quedó fuera del filtro activo. Recarga Media antes de intentar otra vez.`,
        404,
        'media_selection_assets_missing'
      )
      error.details = { missing: missingIds.length, assetIds: missingIds.slice(0, 25) }
      throw error
    }
  }

  // Tomamos un snapshot acotado antes de tocar un solo archivo. Sin una cola de
  // background no es honesto aceptar carpetas gigantes y dejar una petición
  // HTTP abierta indefinidamente.
  const rows = await db.all(
    `SELECT id, folder_path, storage_provider, quota_size, stream_video_id,
            ${sortTimestamp} AS cursor_created_at
     FROM media_assets
     WHERE ${filters.clauses.join(' AND ')}
     ORDER BY ${sortTimestamp} DESC, id DESC
     LIMIT ?`,
    [...filters.params, MEDIA_SELECTION_MAX_RESOLVED_ITEMS + 1]
  )
  if (rows.length > MEDIA_SELECTION_MAX_RESOLVED_ITEMS) {
    throw errorWithStatus(
      `La selección contiene más de ${MEDIA_SELECTION_MAX_RESOLVED_ITEMS} archivos. Divide la carpeta en lotes más pequeños; esta instalación todavía no tiene una cola de trabajos para procesarla sin dejar la ventana bloqueada.`,
      413,
      'media_selection_requires_background_job'
    )
  }

  const remoteDeadlineAt = assertSynchronousRemoteSelectionBudget(rows)
  let budgetExceeded = false

  for (const row of rows) {
    if (remoteDeadlineAt && Date.now() >= remoteDeadlineAt) {
      const pending = rows.length - attempted
      attempted = rows.length
      failed += pending
      budgetExceeded = true
      failures.push({
        id: row.id,
        error: 'Se agotó el presupuesto síncrono de 60 segundos; los archivos restantes no se tocaron.'
      })
      break
    }
    attempted += 1
    try {
      await action(row, filters.selection, { remoteDeadlineAt })
      affected += 1
    } catch (error) {
      failed += 1
      if (failures.length < 25) {
        failures.push({
          id: row.id,
          error: cleanString(error?.message || 'Error desconocido').slice(0, 240)
        })
      }
    }
  }

  if (attempted === 0) {
    throw errorWithStatus('No se encontraron archivos activos en la selección.', 404, 'media_selection_empty')
  }
  if (budgetExceeded) {
    const error = errorWithStatus(
      `${operation} se detuvo al llegar al límite seguro de 60 segundos. ${affected} de ${attempted} archivos terminaron; los restantes no se iniciaron.`,
      409,
      'media_remote_selection_time_budget_exceeded'
    )
    error.details = { operation, attempted, affected, failed, failures }
    throw error
  }
  if (failed) {
    const error = errorWithStatus(
      `${operation} quedó incompleta: ${affected} de ${attempted} archivos terminaron; ${failed} fallaron. La biblioteca se recargará para mostrar el estado real.`,
      409,
      'media_selection_partial_failure'
    )
    error.details = {
      operation,
      attempted,
      affected,
      failed,
      failures
    }
    throw error
  }

  return { operation, attempted, affected, failed: 0 }
}

export async function moveMediaSelection({
  businessId = 'default',
  assetIds = [],
  folderPaths = [],
  mediaType = '',
  status = '',
  targetFolderPath = ''
} = {}) {
  const normalizedTarget = normalizeMediaFolderPath(targetFolderPath)
  const selection = normalizeMediaSelection({ assetIds, folderPaths })
  const invalidSourcePath = selection.folderPaths.find((sourcePath) => {
    const sourceParentPath = sourcePath.split('/').slice(0, -1).join('/')
    return normalizedTarget === sourceParentPath ||
      normalizedTarget === sourcePath ||
      normalizedTarget.startsWith(`${sourcePath}/`)
  })
  if (invalidSourcePath) {
    throw errorWithStatus(
      `La carpeta "${invalidSourcePath}" no puede moverse a sí misma, dentro de sí misma ni al lugar donde ya está.`,
      400,
      'invalid_media_move_target'
    )
  }
  return runMediaSelectionOperation({
    businessId,
    assetIds: selection.assetIds,
    folderPaths: selection.folderPaths,
    mediaType,
    status,
    operation: 'La operación de mover',
    action: async (row, selection, { remoteDeadlineAt }) => {
      const currentFolderPath = normalizeMediaFolderPath(row.folder_path)
      const sourceFolderPath = selectedSourceFolder(currentFolderPath, selection.folderPaths)
      await moveSingleMediaAsset({
        assetId: row.id,
        targetFolderPath: movedSelectionFolderPath(currentFolderPath, sourceFolderPath, normalizedTarget),
        businessId,
        skipQuotaRefresh: true,
        operationDeadlineAt: remoteDeadlineAt
      })
    }
  })
}

export async function deleteMediaSelection({
  businessId = 'default',
  assetIds = [],
  folderPaths = [],
  mediaType = '',
  status = ''
} = {}) {
  return runMediaSelectionOperation({
    businessId,
    assetIds,
    folderPaths,
    mediaType,
    status,
    operation: 'La operación de eliminar',
    action: async (row, _selection, { remoteDeadlineAt }) => {
      await softDeleteMediaAsset(row.id, {
        skipQuotaRefresh: true,
        operationDeadlineAt: remoteDeadlineAt
      })
    }
  })
}

export async function resolveMediaAssetSelection({
  businessId = 'default',
  assetIds = [],
  folderPaths = [],
  mediaType = '',
  status = '',
  maxItems = 500
} = {}) {
  const filters = buildMediaSelectionFilters({ businessId, assetIds, folderPaths, mediaType, status })
  const safeMaximum = Math.max(1, Math.floor(Number(maxItems) || 500))
  const sortTimestamp = mediaLibraryTimestampExpression('created_at')
  if (filters.selection.assetIds.length) {
    const explicitClauses = [
      'business_id = ?',
      'deleted_at IS NULL',
      "status != 'deleted'"
    ]
    const explicitParams = [normalizeBusinessId(businessId)]
    if (filters.mediaType) {
      explicitClauses.push('media_type = ?')
      explicitParams.push(filters.mediaType)
    }
    if (filters.status) {
      explicitClauses.push('status = ?')
      explicitParams.push(filters.status)
    }
    explicitClauses.push(`id IN (${filters.selection.assetIds.map(() => '?').join(', ')})`)
    explicitParams.push(...filters.selection.assetIds)
    const presentRows = await db.all(
      `SELECT id FROM media_assets WHERE ${explicitClauses.join(' AND ')}`,
      explicitParams
    )
    const presentIds = new Set(presentRows.map((row) => cleanString(row.id)))
    const missingIds = filters.selection.assetIds.filter((id) => !presentIds.has(id))
    if (missingIds.length) {
      const error = errorWithStatus(
        `${missingIds.length} archivo${missingIds.length === 1 ? '' : 's'} no pertenece${missingIds.length === 1 ? '' : 'n'} al alcance solicitado o ya no existe${missingIds.length === 1 ? '' : 'n'}.`,
        404,
        'media_selection_assets_missing'
      )
      error.details = { missing: missingIds.length, assetIds: missingIds.slice(0, 25) }
      throw error
    }
  }
  const rows = await db.all(
    `SELECT id, folder_path, original_filename, stored_filename, bunny_path,
            COALESCE(NULLIF(quota_size, 0), NULLIF(size_processed, 0), NULLIF(size_original, 0), 0) AS size_bytes
     FROM media_assets
     WHERE ${filters.clauses.join(' AND ')}
     ORDER BY ${sortTimestamp} DESC, id DESC
     LIMIT ?`,
    [...filters.params, safeMaximum + 1]
  )
  if (rows.length > safeMaximum) {
    throw errorWithStatus(
      `La selección contiene más de ${safeMaximum} archivos. Descarga una carpeta o lote más pequeño.`,
      413,
      'media_archive_too_large'
    )
  }

  return rows.map((row) => {
    const filename = cleanString(
      row.original_filename || row.stored_filename || cleanString(row.bunny_path).split('/').pop() || row.id
    )
    return {
      id: row.id,
      path: [normalizeMediaFolderPath(row.folder_path), filename].filter(Boolean).join('/'),
      sizeBytes: numberValue(row.size_bytes)
    }
  })
}

export async function softDeleteMediaAsset(assetId, {
  skipQuotaRefresh = false,
  operationDeadlineAt = 0
} = {}) {
  const asset = await getMediaAsset(assetId)
  const config = await getStorageRuntimeConfig()
  const metadata = asset.metadata || {}

  await db.run(
    `UPDATE media_assets
     SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [assetId]
  )

  try {
    if (asset.storageProvider === 'bunny' && asset.bunnyPath) {
      await deleteFromBunny({ config, objectPath: asset.bunnyPath, deadlineAt: operationDeadlineAt })
      const thumbPath = metadata.variants?.thumbnail?.path
      if (thumbPath) await deleteFromBunny({ config, objectPath: thumbPath, deadlineAt: operationDeadlineAt })
    } else if (metadata.localPath) {
      await fs.rm(metadata.localPath, { force: true }).catch(() => undefined)
      if (metadata.variants?.thumbnail?.localPath) {
        await fs.rm(metadata.variants.thumbnail.localPath, { force: true }).catch(() => undefined)
      }
    }

  } catch (error) {
    logger.warn(`[MediaStorage] No se pudo borrar archivo físico ${assetId}: ${error.message}`)
  }

  const streamVideoId = cleanString(metadata.stream?.videoId)
  if (streamVideoId) {
    await deleteBunnyStreamVideo(config, streamVideoId, { deadlineAt: operationDeadlineAt }).catch((error) => {
      logger.warn(`[MediaStorage] No se pudo borrar video de Bunny Stream ${streamVideoId}: ${error.message}`)
    })
  }

  if (!skipQuotaRefresh) await refreshQuotaUsage(asset.businessId)
  return { id: assetId, deleted: true }
}

export async function replaceMediaAsset(assetId, input = {}) {
  const current = await getMediaAsset(assetId)
  const currentAccount = {
    ...(current.metadata?.clientAccount || current.metadata?.client_account || {})
  }
  const currentRootMatch = cleanString(current.bunnyPath).match(/^(accounts\/[^/]+)/)
  if (!cleanString(currentAccount.rootPath) && currentRootMatch?.[1]) {
    currentAccount.rootPath = currentRootMatch[1]
  }
  if (!cleanString(currentAccount.slug) && currentRootMatch?.[1]) {
    currentAccount.slug = currentRootMatch[1].split('/')[1] || ''
  }
  const requestedClientAccountId = firstCleanValue(
    input.clientAccountId,
    input.client_account_id,
    input.accountId,
    input.account_id,
    input.locationId,
    input.location_id
  )
  const inputMetadata = input.metadata && typeof input.metadata === 'object'
    ? input.metadata
    : {}
  const suppliedMetadataAccount = inputMetadata.clientAccount || inputMetadata.client_account || {}
  const preservedAccount = Object.keys(suppliedMetadataAccount).length
    ? suppliedMetadataAccount
    : currentAccount
  const nextMetadata = {
    ...inputMetadata,
    ...(!requestedClientAccountId && Object.keys(preservedAccount).length
      ? { clientAccount: preservedAccount }
      : {})
  }
  const nextInput = {
    ...input,
    businessId: input.businessId || current.businessId,
    clientAccountId: requestedClientAccountId || undefined,
    module: input.module || current.module,
    moduleEntityId: input.moduleEntityId || current.moduleEntityId,
    isPublic: input.isPublic !== undefined ? input.isPublic : current.isPublic,
    metadata: nextMetadata
  }
  const next = input.fileBase64 || input.dataUrl || input.content
    ? await uploadMediaAssetFromDataUrl(nextInput)
    : await uploadMediaAsset(nextInput)
  await softDeleteMediaAsset(assetId)
  return {
    previousId: assetId,
    asset: next
  }
}

export async function getMediaAssetFile(assetId, variant = '') {
  const asset = await getMediaAsset(assetId)
  const metadata = asset.metadata || {}

  if (variant === 'thumbnail' && metadata.variants?.thumbnail) {
    const thumbnail = metadata.variants.thumbnail
    if (asset.storageProvider === 'bunny' && thumbnail.publicUrl) {
      return { redirectUrl: thumbnail.publicUrl }
    }
    if (thumbnail.localPath) {
      return {
        stream: createReadStream(thumbnail.localPath),
        contentType: thumbnail.mimeType || 'image/webp',
        contentLength: thumbnail.sizeBytes || undefined,
        filename: `thumb-${asset.storedFilename || asset.originalFilename}`
      }
    }
  }

  if ((asset.storageProvider === 'bunny' || asset.storageProvider === 'bunny_stream') && asset.publicUrl) {
    return { redirectUrl: asset.publicUrl }
  }

  if (metadata.localPath) {
    return {
      stream: createReadStream(metadata.localPath),
      contentType: asset.mimeType,
      contentLength: asset.sizeProcessed || undefined,
      filename: asset.originalFilename || asset.storedFilename
    }
  }

  throw errorWithStatus('El archivo no tiene un objeto descargable disponible.', 404, 'media_file_missing')
}

export async function getMediaAssetReadStream(assetId, { deadlineAt = 0 } = {}) {
  const asset = await getMediaAsset(assetId)
  const metadata = asset.metadata || {}
  const contentLength = Math.floor(numberValue(
    asset.quotaSize || asset.sizeProcessed || asset.sizeOriginal
  ))

  if (asset.storageProvider === 'bunny_stream') {
    throw errorWithStatus(
      'Este video vive directamente en Bunny Stream y no tiene una descarga binaria en Media.',
      409,
      'bunny_stream_binary_unavailable'
    )
  }
  if (metadata.localPath) {
    const stat = await fs.stat(metadata.localPath).catch(() => null)
    if (!stat?.isFile()) {
      throw errorWithStatus('El archivo local ya no está disponible.', 404, 'media_file_missing')
    }
    return {
      stream: createReadStream(metadata.localPath),
      contentType: asset.mimeType || 'application/octet-stream',
      contentLength: stat.size,
      filename: asset.originalFilename || asset.storedFilename || asset.id
    }
  }

  const config = await getStorageRuntimeConfig()
  const requests = [
    asset.publicUrl && /^https?:\/\//i.test(asset.publicUrl)
      ? { url: asset.publicUrl, headers: {} }
      : null,
    asset.bunnyPath && config.bunnyConfigured
      ? { url: bunnyObjectUrl(config, asset.bunnyPath), headers: { AccessKey: config.bunnyStorageApiKey } }
      : null
  ].filter(Boolean)

  for (const request of requests) {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(boundedRemoteOperationTimeout(deadlineAt, MEDIA_DOWNLOAD_TIMEOUT_MS))
    })
    if (!response.ok || !response.body) continue
    const responseLength = Math.floor(numberValue(response.headers.get('content-length')))
    return {
      stream: response.body,
      contentType: asset.mimeType || response.headers.get('content-type') || 'application/octet-stream',
      contentLength: responseLength || contentLength,
      filename: asset.originalFilename || asset.storedFilename || asset.id
    }
  }

  throw errorWithStatus('El archivo no tiene contenido disponible para lectura.', 404, 'media_file_missing')
}

function mediaDownloadRangeError(totalSize = null, message = 'El rango de descarga no es válido.') {
  const error = errorWithStatus(message, 416, 'media_download_range_invalid')
  if (Number.isSafeInteger(totalSize) && totalSize >= 0) error.contentRange = `bytes */${totalSize}`
  return error
}

function parseMediaDownloadRange(value = '', totalSize = null) {
  const raw = cleanString(value)
  if (!raw) return null
  if (raw.includes(',')) throw mediaDownloadRangeError(totalSize, 'Solo se permite un rango por descarga.')

  const match = raw.match(/^bytes=(\d*)-(\d*)$/i)
  if (!match || (!match[1] && !match[2])) throw mediaDownloadRangeError(totalSize)

  const hasKnownTotal = Number.isSafeInteger(totalSize) && totalSize >= 0
  const total = hasKnownTotal ? totalSize : 0
  const parsePart = (part) => {
    if (!part) return null
    const parsed = Number(part)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw mediaDownloadRangeError(totalSize)
    return parsed
  }
  const requestedStart = parsePart(match[1])
  const requestedEnd = parsePart(match[2])

  if (!hasKnownTotal) return { header: raw }
  if (total === 0) throw mediaDownloadRangeError(total)

  let start
  let end
  if (requestedStart === null) {
    if (!requestedEnd) throw mediaDownloadRangeError(total)
    start = Math.max(0, total - requestedEnd)
    end = total - 1
  } else {
    start = requestedStart
    end = requestedEnd === null ? total - 1 : Math.min(requestedEnd, total - 1)
  }

  if (start >= total || end < start) throw mediaDownloadRangeError(total)
  return {
    start,
    end,
    length: end - start + 1,
    header: `bytes=${start}-${end}`
  }
}

function buildManagedBunnyDownloadUrl(asset = {}) {
  if (asset.storageProvider === 'bunny_stream') {
    throw errorWithStatus(
      'Este video todavía no tiene un archivo de Storage descargable.',
      409,
      'bunny_stream_binary_unavailable'
    )
  }
  if (asset.storageProvider !== 'bunny' || !asset.bunnyPath || !asset.cdnBaseUrl) {
    throw errorWithStatus(
      'Este archivo no tiene un objeto de Storage disponible para descarga pública.',
      409,
      'media_download_object_unavailable'
    )
  }

  const baseUrl = normalizeBaseUrl(asset.cdnBaseUrl)
  let parsedBase
  try {
    parsedBase = new URL(baseUrl)
  } catch {
    throw errorWithStatus('La URL de Storage del archivo no es válida.', 409, 'media_download_url_invalid')
  }
  if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password) {
    throw errorWithStatus('La URL de Storage del archivo no es segura.', 409, 'media_download_url_invalid')
  }

  const encodedPath = cleanString(asset.bunnyPath)
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `${baseUrl.replace(/\/+$/, '')}/${encodedPath}`
}

export async function getMediaAssetDownloadFile(assetId, options = {}) {
  const asset = await getMediaAsset(assetId)
  if (options.requirePublic && (!asset.isPublic || asset.status !== 'ready')) {
    throw errorWithStatus('Archivo multimedia no encontrado.', 404, 'media_not_found')
  }

  const method = cleanString(options.method).toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
  const filename = asset.originalFilename || asset.storedFilename || asset.id
  const metadata = asset.metadata || {}
  if (metadata.localPath) {
    let stats
    try {
      stats = await fs.stat(metadata.localPath)
    } catch {
      throw errorWithStatus('El archivo local ya no está disponible.', 404, 'media_file_missing')
    }
    if (!stats.isFile()) throw errorWithStatus('El archivo local ya no está disponible.', 404, 'media_file_missing')

    const range = parseMediaDownloadRange(options.range, stats.size)
    const statusCode = range ? 206 : 200
    return {
      stream: method === 'HEAD'
        ? null
        : createReadStream(metadata.localPath, range ? { start: range.start, end: range.end } : undefined),
      statusCode,
      contentType: asset.mimeType || 'application/octet-stream',
      contentLength: range ? range.length : stats.size,
      contentRange: range ? `bytes ${range.start}-${range.end}/${stats.size}` : '',
      acceptRanges: 'bytes',
      filename,
      cleanup: null
    }
  }

  const downloadUrl = await assertSafeOutboundMediaUrl(buildManagedBunnyDownloadUrl(asset))
  const range = parseMediaDownloadRange(options.range, null)
  const controller = new AbortController()
  const agent = createSafeOutboundMediaHttpsAgent()
  const abortFromRequest = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromRequest()
  else options.signal?.addEventListener?.('abort', abortFromRequest, { once: true })

  const headerTimeout = setTimeout(() => controller.abort(new Error('Storage tardó demasiado en iniciar la descarga.')), 30_000)
  let response
  try {
    response = await fetch(downloadUrl, {
      method,
      headers: {
        'Accept-Encoding': 'identity',
        ...(range?.header ? { Range: range.header } : {})
      },
      redirect: 'manual',
      signal: controller.signal,
      agent,
      compress: false
    })
  } catch (error) {
    clearTimeout(headerTimeout)
    agent.destroy()
    options.signal?.removeEventListener?.('abort', abortFromRequest)
    if (options.signal?.aborted) throw errorWithStatus('La descarga fue cancelada.', 499, 'media_download_cancelled')
    throw errorWithStatus(
      error?.name === 'AbortError' ? 'Storage tardó demasiado en iniciar la descarga.' : 'No se pudo abrir el archivo en Storage.',
      error?.name === 'AbortError' ? 504 : 502,
      'media_download_failed'
    )
  }
  clearTimeout(headerTimeout)

  const cleanup = () => {
    options.signal?.removeEventListener?.('abort', abortFromRequest)
    response.body?.destroy?.()
    if (!controller.signal.aborted) controller.abort()
    agent.destroy()
  }

  if (response.status === 416) {
    const contentRange = cleanString(response.headers.get('content-range'))
    cleanup()
    const error = mediaDownloadRangeError(null)
    if (contentRange) error.contentRange = contentRange
    throw error
  }
  if (![200, 206].includes(response.status) || (method !== 'HEAD' && !response.body)) {
    const status = response.status
    cleanup()
    throw errorWithStatus(`Storage no pudo entregar el archivo (${status}).`, 502, 'media_download_failed')
  }

  const contentEncoding = cleanString(response.headers.get('content-encoding')).toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    cleanup()
    throw errorWithStatus('Storage respondió con una codificación inesperada.', 502, 'media_download_encoding_invalid')
  }

  const rawContentLength = response.headers.get('content-length')
  const parsedContentLength = rawContentLength !== null && /^\d+$/.test(rawContentLength)
    ? Number(rawContentLength)
    : undefined
  const contentLength = Number.isSafeInteger(parsedContentLength) && parsedContentLength >= 0
    ? parsedContentLength
    : undefined
  const sourceStream = method === 'HEAD' ? null : response.body
  let stream = null
  let idleTimer = null
  let sourceErrorHandler = null
  if (sourceStream) {
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(new Error('Storage dejó de transmitir la descarga.')), 60_000)
    }
    stream = new Transform({
      transform(chunk, encoding, callback) {
        resetIdleTimer()
        callback(null, chunk)
      }
    })
    sourceErrorHandler = (error) => stream.destroy(error)
    sourceStream.once('error', sourceErrorHandler)
    resetIdleTimer()
    sourceStream.pipe(stream)
    stream.once('close', () => { if (idleTimer) clearTimeout(idleTimer) })
  }
  return {
    stream,
    statusCode: response.status,
    contentType: cleanString(response.headers.get('content-type')) || asset.mimeType || 'application/octet-stream',
    contentLength,
    contentRange: cleanString(response.headers.get('content-range')),
    acceptRanges: cleanString(response.headers.get('accept-ranges')) || 'bytes',
    filename,
    cleanup: () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (sourceStream && stream) {
        sourceStream.unpipe(stream)
        if (sourceErrorHandler) sourceStream.off('error', sourceErrorHandler)
        if (!stream.destroyed) stream.destroy()
      }
      cleanup()
    }
  }
}

export async function getMediaAssetBuffer(assetId) {
  const asset = await getMediaAsset(assetId)
  const metadata = asset.metadata || {}
  if (asset.storageProvider === 'bunny_stream') {
    throw errorWithStatus(
      'Este video vive directamente en Bunny Stream y no tiene una descarga binaria en Media.',
      409,
      'bunny_stream_binary_unavailable'
    )
  }
  if (metadata.localPath) {
    const buffer = await fs.readFile(metadata.localPath)
    return { buffer, mimeType: asset.mimeType, filename: asset.originalFilename }
  }
  if (asset.publicUrl && /^https?:\/\//i.test(asset.publicUrl)) {
    const response = await fetch(asset.publicUrl)
    if (!response.ok) throw errorWithStatus('No se pudo descargar el archivo desde su URL pública.', 502, 'media_fetch_failed')
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, mimeType: asset.mimeType, filename: asset.originalFilename }
  }
  throw errorWithStatus('El archivo no tiene contenido disponible para lectura.', 404, 'media_file_missing')
}

export async function getMediaAssetDataUrl(assetId) {
  const { buffer, mimeType, filename } = await getMediaAssetBuffer(assetId)
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    filename
  }
}

export async function syncMediaAssetBunnyStream(assetId, context = {}) {
  let asset = await getMediaAsset(assetId)
  const usageContext = bunnyStreamUsageContext(asset, context)
  const clientAccount = await resolveClientAccountContext({
    ...context,
    businessId: asset.businessId,
    metadata: asset.metadata
  })
  if (!isBunnyStreamEligibleVideo({ mediaType: asset.mediaType, module: usageContext.module })) {
    throw errorWithStatus('Este archivo no es un video de sitios o formularios.', 400, 'bunny_stream_not_applicable')
  }

  const config = await getStorageRuntimeConfig()
  if (asset.storageProvider === 'bunny_stream') {
    asset = await ensureBunnyStreamStorageMirror(asset.id, {
      ...context,
      config,
      module: usageContext.module,
      moduleEntityId: usageContext.moduleEntityId,
      clientAccount
    })
  }
  const currentStream = asset.metadata?.stream || {}
  const currentVideoId = cleanString(currentStream.videoId)
  let stream

  if (currentVideoId && config.bunnyStreamConfigured) {
    let video = await getBunnyStreamVideo(config, currentVideoId)
    const collection = await ensureBunnyStreamCollection(config, clientAccount)
    if (!collection?.id) {
      throw errorWithStatus('Bunny Stream no regresó una colección usable para esta cuenta.', 502, 'bunny_stream_collection_required')
    }
    const videoCollectionId = cleanString(video?.collectionId)
    if (videoCollectionId !== collection.id) {
      const nextTitle = currentStream.title || cleanString(video?.title) || buildBunnyStreamTitle({
        originalFilename: asset.originalFilename,
        module: usageContext.module,
        moduleEntityId: usageContext.moduleEntityId,
        id: asset.id
      })
      await updateBunnyStreamVideo(config, {
        videoId: currentVideoId,
        title: nextTitle,
        collectionId: collection.id
      })
      video = await getBunnyStreamVideo(config, currentVideoId).catch((error) => {
        logger.warn(`[MediaStorage] Bunny Stream movió ${currentVideoId}, pero no se pudo leer metadata actualizada: ${error.message}`)
        return { ...video, collectionId: collection.id, title: nextTitle }
      })
    }
    stream = {
      ...currentStream,
      provider: 'bunny_stream',
      enabled: true,
      providerReady: true,
      syncStatus: 'synced',
      syncedAt: nowIso(),
      libraryId: config.bunnyStreamLibraryId,
      collectionId: collection.id,
      collectionName: collection.name || buildBunnyStreamCollectionName(config, clientAccount),
      videoId: currentVideoId,
      title: currentStream.title || cleanString(video?.title),
      source: {
        ...(currentStream.source || {}),
        ...bunnyStreamSourceForAsset(asset, usageContext, clientAccount)
      },
      clientAccount,
      video: normalizeBunnyStreamVideo(video) || currentStream.video || null
    }
  } else {
    const file = asset.storageProvider === 'bunny' && asset.bunnyPath
      ? {
          buffer: await readBunnyObjectBuffer({ config, objectPath: asset.bunnyPath, publicUrl: asset.publicUrl }),
          mimeType: asset.mimeType
        }
      : await getMediaAssetBuffer(asset.id)
    stream = await syncVideoToBunnyStream({
      config,
      id: asset.id,
      businessId: asset.businessId,
      module: usageContext.module,
      moduleEntityId: usageContext.moduleEntityId,
      originalFilename: asset.originalFilename,
      objectPath: asset.bunnyPath,
      publicUrl: asset.publicUrl,
      mimeType: file.mimeType || asset.mimeType,
      buffer: file.buffer,
      clientAccount
    })
  }

  await updateMediaAssetStream({ asset, stream })
  return await getMediaAsset(asset.id)
}

export function extractMediaAssetIdFromUrl(value = '') {
  const match = cleanString(value).match(/(?:\/api)?\/media\/assets\/((?:media|rstk_media)_[\w-]+)(?:\/file|\/thumbnail)?/i)
  return match?.[1] || ''
}

export async function retryMediaAsset(assetId) {
  const asset = await getMediaAsset(assetId)
  if (asset.status !== 'failed') {
    return { id: asset.id, status: asset.status, retried: false, message: 'El archivo no está fallido; no requiere reintento.' }
  }
  throw errorWithStatus('Este archivo fallido no conserva un temporal para reintento automático. Vuelve a subirlo desde el módulo original.', 409, 'media_retry_not_available')
}

export async function runStorageDiagnostics() {
  const config = await getStorageRuntimeConfig()
  const settings = await getStorageSettingsRow()
  const usage = await getStorageUsage({ businessId: 'default' })
  const result = {
    storage_provider: config.provider,
    storage_status: config.storageStatus,
    storage_enabled: config.storageEnabled,
    db_settings_installed: Boolean(settings),
    missing_environment: config.missingEnvironment,
    bunny_storage_zone: config.bunnyStorageZone || null,
    bunny_storage_region: config.bunnyStorageRegion || null,
    bunny_cdn_base_url: config.bunnyCdnBaseUrl || null,
    bunny_stream_enabled: config.bunnyStreamEnabled,
    bunny_stream_status: config.streamStatus,
    bunny_stream_library_id: config.bunnyStreamLibraryId || null,
    bunny_stream_collection_id: config.bunnyStreamCollectionId || null,
    bunny_stream_collection_name: config.bunnyStreamCollectionName || null,
    bunny_stream_missing_environment: config.streamMissingEnvironment,
    compression_enabled: config.compressionEnabled,
    quota_ready: Boolean(usage),
    usage,
    bunny_write_delete_test: null
  }

  if (!config.bunnyConfigured) return result

  const diagnosticPath = `diagnostics/${crypto.randomUUID()}.txt`
  try {
    await uploadToBunny({
      config,
      objectPath: diagnosticPath,
      buffer: Buffer.from(`ristak storage diagnostic ${nowIso()}`),
      mimeType: 'text/plain'
    })
    await deleteFromBunny({ config, objectPath: diagnosticPath })
    result.bunny_write_delete_test = { ok: true, path: diagnosticPath }
  } catch (error) {
    result.storage_status = 'error'
    result.bunny_write_delete_test = { ok: false, error: error.message }
  }

  return result
}
