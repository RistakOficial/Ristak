import crypto from 'crypto'
import fetch from 'node-fetch'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { promises as fs } from 'fs'
import { createReadStream } from 'fs'
import { dirname, extname, join } from 'path'
import { fileURLToPath } from 'url'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { compressMediaBuffer } from './mediaCompressionService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const GB = 1024 * 1024 * 1024
const LOCAL_MEDIA_ROOT = join(__dirname, '../../uploads/media-storage')
const BUNNY_CORE_API_BASE_URL = 'https://api.bunny.net'
const BUNNY_STREAM_API_BASE_URL = 'https://video.bunnycdn.com'
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
// Solo necesitamos los primeros bytes para detectar el tipo real del archivo.
const MEDIA_HEADER_SAMPLE_BYTES = 64 * 1024

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
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
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

function normalizeClientAccountContext(input = {}) {
  const id = normalizeClientAccountId(input.id || input.clientAccountId || input.client_account_id || input.accountId || input.account_id || input.locationId || input.location_id)
  return {
    id,
    rootPath: buildClientAccountRootPath(id)
  }
}

function normalizeModule(value = '') {
  const clean = cleanString(value).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  return MEDIA_MODULES.has(clean) ? clean : 'other'
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
  return cleanString(mimeType).split(';')[0].toLowerCase()
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
  const accountId = firstCleanValue(
    input.clientAccountId,
    input.client_account_id,
    input.accountId,
    input.account_id,
    input.locationId,
    input.location_id,
    metadataAccount.id,
    metadataAccount.clientAccountId,
    metadataAccount.client_account_id,
    process.env.RISTAK_CLIENT_ACCOUNT_ID,
    process.env.CLIENT_ACCOUNT_ID,
    process.env.GHL_LOCATION_ID,
    process.env.HIGHLEVEL_LOCATION_ID,
    await highLevelClientAccountFallback(),
    input.businessId,
    DEFAULT_CLIENT_ACCOUNT_ID
  )

  return normalizeClientAccountContext({ id: accountId })
}

function mapAssetRow(row) {
  if (!row) return null
  return {
    id: row.id,
    businessId: row.business_id || 'default',
    userId: row.user_id || null,
    originalFilename: row.original_filename || '',
    storedFilename: row.stored_filename || '',
    bunnyPath: row.bunny_path || '',
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
    metadata: parseJson(row.metadata_json, {}),
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

function centralStorageRequestConfig() {
  const licenseServerUrl = normalizeBaseUrl(process.env.LICENSE_SERVER_URL || '')
  const clientId = cleanString(process.env.CLIENT_ID)
  const licenseKey = cleanString(process.env.LICENSE_KEY)
  const installationId = cleanString(process.env.INSTALLATION_ID)
  if (!licenseServerUrl || !clientId || !licenseKey || !installationId) return null
  return {
    licenseServerUrl,
    body: {
      client_id: clientId,
      license_key: licenseKey,
      installation_id: installationId,
      app_url: process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '',
      version: process.env.APP_VERSION || ''
    }
  }
}

function readCentralStorageConfigValue(config, snakeKey, envKey) {
  return cleanString(config?.[snakeKey] || config?.[envKey])
}

function normalizeCentralStorageEnv(config = {}) {
  return {
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
  const requestConfig = centralStorageRequestConfig()
  if (!requestConfig) return null

  if (centralStorageConfigCache.env && centralStorageConfigCache.expiresAt > Date.now()) {
    return centralStorageConfigCache.env
  }
  if (centralStorageConfigCache.promise) return centralStorageConfigCache.promise

  centralStorageConfigCache.promise = (async () => {
    try {
      const response = await fetch(`${requestConfig.licenseServerUrl}/api/license/storage-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestConfig.body),
        signal: AbortSignal.timeout(Number(process.env.MEDIA_CENTRAL_CONFIG_TIMEOUT_MS || 10_000) || 10_000)
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.success || !payload?.config) {
        const reason = payload?.reason || payload?.message || response.statusText
        logger.warn(`[MediaStorage] Installer no entregó configuración Bunny (${response.status}): ${reason}`)
        return null
      }

      const env = normalizeCentralStorageEnv(payload.config)
      if (!env.BUNNY_STORAGE_ZONE || !env.BUNNY_STORAGE_API_KEY || !env.BUNNY_CDN_BASE_URL) {
        logger.warn('[MediaStorage] Installer entregó configuración Bunny incompleta.')
        return null
      }

      centralStorageConfigCache.env = env
      centralStorageConfigCache.expiresAt = Date.now() + CENTRAL_STORAGE_CONFIG_TTL_MS
      return env
    } catch (error) {
      logger.warn(`[MediaStorage] No se pudo recuperar configuración Bunny desde Installer: ${error.message}`)
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

async function deleteBunnyStreamVideo(config, videoId) {
  if (!config.bunnyStreamConfigured || !videoId) return null
  return await bunnyStreamRequest(
    config,
    `/library/${encodeURIComponent(config.bunnyStreamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'DELETE',
      okStatuses: [200, 404]
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
    logger.info(`[MediaStorage] Bunny Stream sync iniciada: ${id}`)
    const created = await createBunnyStreamVideo(config, {
      title,
      collectionId: collection?.id || ''
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
      collectionId: collection?.id || cleanString(normalizedVideo?.collectionId),
      collectionName: collection?.name || config.bunnyStreamCollectionName || '',
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
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextWidth,
      nextHeight,
      nextDuration,
      JSON.stringify(metadata),
      asset.id
    ]
  )
}

async function uploadToBunny({ config, objectPath, buffer, mimeType }) {
  logger.info(`[MediaStorage] Subida a Bunny iniciada: ${objectPath}`)
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buffer.length)
    },
    body: buffer,
    signal: AbortSignal.timeout(bunnyFileUploadTimeoutMs(buffer.length))
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

async function deleteFromBunny({ config, objectPath }) {
  if (!objectPath || !config.bunnyConfigured) return
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'DELETE',
    headers: { AccessKey: config.bunnyStorageApiKey }
  })

  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Bunny rechazó la eliminación (${response.status}): ${detail.slice(0, 180) || response.statusText}`)
  }
}

async function readBunnyObjectBuffer({ config, objectPath, publicUrl = '' }) {
  const urls = [
    /^https?:\/\//i.test(publicUrl) ? { url: publicUrl, headers: {} } : null,
    objectPath && config.bunnyConfigured ? { url: bunnyObjectUrl(config, objectPath), headers: { AccessKey: config.bunnyStorageApiKey } } : null
  ].filter(Boolean)

  for (const request of urls) {
    const response = await fetch(request.url, { headers: request.headers })
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
    mimeType: mimeBase(compressed.contentType || mimeType),
    compression: compressed.note || 'original'
  }
}

function buildObjectPath({ businessId, clientAccount, mediaType, module, id, filename, extension, variant = '' }) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/')
  const folder = module && module !== 'other' ? module : `${mediaType}s`
  const suffix = variant ? `-${variant}` : ''
  const rootPath = clientAccount?.rootPath || buildClientAccountRootPath(businessId)
  return [
    rootPath,
    folder,
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

async function calculateActiveUsageBytes(businessId) {
  const row = await db.get(
    `SELECT COALESCE(SUM(quota_size), 0) AS used_bytes
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'`,
    [normalizeBusinessId(businessId)]
  )
  return numberValue(row?.used_bytes)
}

async function refreshQuotaUsage(businessId) {
  const usedBytes = await calculateActiveUsageBytes(businessId)
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

  const usedBytes = await calculateActiveUsageBytes(businessId)
  const quotaBytes = numberValue(quota.quota_bytes, Math.round(numberValue(quota.quota_gb, 5) * GB))
  const extraBytes = Math.round(numberValue(quota.extra_quota_gb) * GB)
  const totalBytes = quotaBytes + extraBytes

  if (usedBytes + quotaSize > totalBytes) {
    throw errorWithStatus('No hay espacio suficiente para subir este archivo. Libera almacenamiento o aumenta la cuota.', 413, 'storage_quota_exceeded')
  }
}

async function insertMediaAsset(row) {
  await db.run(
    `INSERT INTO media_assets (
      id, business_id, user_id, original_filename, stored_filename, bunny_path,
      public_url, private_url, mime_type, media_type, extension,
      size_original, size_processed, quota_size, width, height, duration,
      status, storage_provider, storage_zone, cdn_base_url, module,
      module_entity_id, is_public, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      row.id,
      row.businessId,
      row.userId || null,
      row.originalFilename,
      row.storedFilename,
      row.bunnyPath,
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
      row.module,
      row.moduleEntityId || null,
      row.isPublic ? 1 : 0,
      JSON.stringify(row.metadata || {})
    ]
  )
}

async function findMediaAssetByClientUploadId({ businessId = 'default', clientUploadId = '' } = {}) {
  const cleanClientUploadId = normalizeClientUploadId(clientUploadId)
  if (!cleanClientUploadId) return null

  const metadataNeedle = `"clientUploadId":${JSON.stringify(cleanClientUploadId)}`
  const row = await db.get(
    `SELECT *
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'
       AND metadata_json LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalizeBusinessId(businessId), `%${escapeSqlLike(metadataNeedle)}%`]
  )
  return mapAssetRow(row)
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
    const isPublic = input.isPublic !== undefined ? boolValue(input.isPublic) : true
    const clientUploadId = normalizeClientUploadId(
      input.clientUploadId ||
      input.client_upload_id ||
      input.uploadSessionId ||
      input.upload_session_id ||
      input.metadata?.clientUploadId ||
      input.metadata?.client_upload_id
    )

    const existingAsset = await findMediaAssetByClientUploadId({ businessId, clientUploadId })
    if (existingAsset) {
      logger.info(`[MediaStorage] Reutilizando subida existente por clientUploadId: ${existingAsset.id}`)
      return existingAsset
    }

    const detected = await detectMimeType(headerSample, input.mimeType || input.contentType || '', originalFilename)
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
        onTempFileHandedOff: () => { tempFileHandedOff = true }
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
    const finalMimeType = processedDetected.mimeType
    const finalMediaType = mediaTypeFromMime(finalMimeType)
    const extension = extensionForMime(finalMimeType, originalFilename)
    const dimensions = await getImageMetadata(processed.buffer, finalMimeType)
    const thumbnail = await createImageThumbnail(processed.buffer, finalMimeType)
    const quotaSize = processed.buffer.length

    await assertQuotaAvailable({ businessId, quotaSize, config })

    const id = `media_${crypto.randomUUID()}`
    const storedFilename = `${id}-${filenameBase(originalFilename)}.${extension}`
    const objectPath = buildObjectPath({
      businessId,
      clientAccount,
      mediaType: finalMediaType,
      module,
      id,
      filename: originalFilename,
      extension
    })
    const thumbnailPath = thumbnail ? buildObjectPath({
      businessId,
      clientAccount,
      mediaType: finalMediaType,
      module,
      id,
      filename: originalFilename,
      extension: thumbnail.extension,
      variant: 'thumb'
    }) : ''

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
      await uploadToBunny({ config, objectPath, buffer: processed.buffer, mimeType: finalMimeType })
      if (thumbnail) {
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
    } else {
      if (config.provider === 'bunny' && config.requireBunny) {
        throw errorWithStatus(`Bunny.net está activo pero falta configuración: ${config.missingEnvironment.join(', ')}`, 503, 'bunny_not_configured')
      }
      const localPath = await saveLocalFile({ objectPath, buffer: processed.buffer })
      metadata.localPath = localPath
      metadata.localFallback = true
      if (thumbnail) {
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

    await refreshQuotaUsage(businessId)
    if (deferredStreamSync) {
      scheduleDeferredBunnyStreamSync(deferredStreamSync)
    }
    logger.info(`[MediaStorage] Archivo listo: ${id} (${finalMediaType}, ${quotaSize} bytes)`)

    return await getMediaAsset(id)
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
  const id = `media_${crypto.randomUUID()}`
  const storedFilename = `${id}-${filenameBase(originalFilename)}.${extension}`
  const objectPath = buildObjectPath({
    businessId,
    clientAccount,
    mediaType: finalMediaType,
    module,
    id,
    filename: originalFilename,
    extension
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

  if (config.provider === 'bunny' && config.bunnyConfigured) {
    await uploadFileToBunny({ config, objectPath, filePath: tempFilePath, size: sizeBytes, mimeType: finalMimeType })
    storageProvider = 'bunny'
    publicUrl = bunnyPublicUrl(config, objectPath)
  } else {
    if (config.provider === 'bunny' && config.requireBunny) {
      throw errorWithStatus(`Bunny.net está activo pero falta configuración: ${config.missingEnvironment.join(', ')}`, 503, 'bunny_not_configured')
    }
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

export async function findMediaAssetsByBunnyStreamVideoIds(videoIds = []) {
  const seen = new Set()
  const ids = (Array.isArray(videoIds) ? videoIds : [])
    .map(cleanString)
    .filter((videoId) => {
      if (!videoId || seen.has(videoId)) return false
      seen.add(videoId)
      return true
    })

  if (!ids.length) return []

  const rows = await db.all(
    `SELECT * FROM media_assets
     WHERE media_type = 'video'
       AND metadata_json IS NOT NULL
       AND deleted_at IS NULL
       AND status != 'deleted'
       AND (${ids.map(() => 'metadata_json LIKE ?').join(' OR ')})`,
    ids.map((videoId) => `%${videoId}%`)
  )

  const wanted = new Set(ids)
  return rows
    .map(mapAssetRow)
    .filter((asset) => asset && wanted.has(cleanString(asset.metadata?.stream?.videoId)))
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

export async function listMediaAssets({ businessId = 'default', module = '', mediaType = '', status = '', limit = 100, offset = 0 } = {}) {
  const clauses = ['business_id = ?', 'deleted_at IS NULL']
  const params = [normalizeBusinessId(businessId)]
  if (module) {
    clauses.push('module = ?')
    params.push(normalizeModule(module))
  }
  if (mediaType) {
    clauses.push('media_type = ?')
    params.push(cleanString(mediaType).toLowerCase())
  }
  if (status) {
    clauses.push('status = ?')
    params.push(cleanString(status).toLowerCase())
  }

  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const rows = await db.all(
    `SELECT * FROM media_assets
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  )
  return rows.map(mapAssetRow)
}

export async function getStorageUsage({ businessId = 'default' } = {}) {
  const config = await getStorageRuntimeConfig()
  const normalizedBusinessId = normalizeBusinessId(businessId)
  const quota = await ensureStorageQuota(normalizedBusinessId, config)
  const usedBytes = await refreshQuotaUsage(normalizedBusinessId)
  const quotaBytes = numberValue(quota.quota_bytes, Math.round(numberValue(quota.quota_gb, 5) * GB))
  const extraQuotaGb = numberValue(quota.extra_quota_gb)
  const totalQuotaBytes = quotaBytes + Math.round(extraQuotaGb * GB)
  const availableBytes = Math.max(0, totalQuotaBytes - usedBytes)
  const filesRow = await db.get(
    `SELECT COUNT(*) AS total
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'`,
    [normalizedBusinessId]
  )
  const typeRows = await db.all(
    `SELECT media_type, COALESCE(SUM(quota_size), 0) AS used_bytes
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'
     GROUP BY media_type`,
    [normalizedBusinessId]
  )
  const moduleRows = await db.all(
    `SELECT module, COALESCE(SUM(quota_size), 0) AS used_bytes
     FROM media_assets
     WHERE business_id = ?
       AND deleted_at IS NULL
       AND status != 'deleted'
     GROUP BY module`,
    [normalizedBusinessId]
  )
  const userRow = await db.get('SELECT business_name, full_name, email FROM users ORDER BY id ASC LIMIT 1').catch(() => null)

  const byMediaType = { images: 0, videos: 0, audio: 0, documents: 0, other: 0 }
  for (const row of typeRows) {
    const key = row.media_type === 'image'
      ? 'images'
      : row.media_type === 'video'
        ? 'videos'
        : row.media_type === 'audio'
          ? 'audio'
          : row.media_type === 'document'
            ? 'documents'
            : 'other'
    byMediaType[key] += numberValue(row.used_bytes)
  }

  const byModule = {}
  for (const row of moduleRows) {
    byModule[row.module || 'other'] = numberValue(row.used_bytes)
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
    files_count: numberValue(filesRow?.total),
    by_media_type: byMediaType,
    by_module: byModule,
    storage_enabled: boolValue(quota.storage_enabled, true),
    last_calculated_at: nowIso()
  }
}

async function moveSingleMediaAsset({ assetId, targetFolderPath = '', businessId = '' }) {
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

    const { buffer } = await getMediaAssetBuffer(asset.id)
    await uploadToBunny({ config, objectPath: nextObjectPath, buffer, mimeType: asset.mimeType })

    if (thumbnail?.path && nextThumbnailObjectPath) {
      const thumbnailBuffer = await readBunnyObjectBuffer({
        config,
        objectPath: thumbnail.path,
        publicUrl: thumbnail.publicUrl
      })
      await uploadToBunny({
        config,
        objectPath: nextThumbnailObjectPath,
        buffer: thumbnailBuffer,
        mimeType: thumbnail.mimeType || 'image/webp'
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
         public_url = ?,
         private_url = ?,
         metadata_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextObjectPath,
      nextPublicUrl,
      nextPrivateUrl,
      JSON.stringify(metadata),
      asset.id
    ]
  )

  if (bunnyCleanupPaths.length) {
    const config = await getStorageRuntimeConfig()
    for (const objectPath of bunnyCleanupPaths.filter(Boolean)) {
      await deleteFromBunny({ config, objectPath }).catch((error) => {
        logger.warn(`[MediaStorage] No se pudo borrar ruta vieja al mover ${asset.id}: ${error.message}`)
      })
    }
  }

  await refreshQuotaUsage(asset.businessId)
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

  const moved = []
  for (const entry of cleanEntries) {
    moved.push(await moveSingleMediaAsset({
      assetId: entry.id,
      targetFolderPath: entry.targetFolderPath,
      businessId
    }))
  }

  return moved
}

export async function softDeleteMediaAsset(assetId) {
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
      await deleteFromBunny({ config, objectPath: asset.bunnyPath })
      const thumbPath = metadata.variants?.thumbnail?.path
      if (thumbPath) await deleteFromBunny({ config, objectPath: thumbPath })
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
    await deleteBunnyStreamVideo(config, streamVideoId).catch((error) => {
      logger.warn(`[MediaStorage] No se pudo borrar video de Bunny Stream ${streamVideoId}: ${error.message}`)
    })
  }

  await refreshQuotaUsage(asset.businessId)
  return { id: assetId, deleted: true }
}

export async function replaceMediaAsset(assetId, input = {}) {
  const current = await getMediaAsset(assetId)
  const currentAccount = current.metadata?.clientAccount || current.metadata?.client_account || {}
  const nextInput = {
    ...input,
    businessId: input.businessId || current.businessId,
    clientAccountId: input.clientAccountId || input.client_account_id || input.accountId || input.account_id || input.locationId || input.location_id || currentAccount.id,
    module: input.module || current.module,
    moduleEntityId: input.moduleEntityId || current.moduleEntityId,
    isPublic: input.isPublic !== undefined ? input.isPublic : current.isPublic
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

  if (asset.storageProvider === 'bunny' && asset.publicUrl) {
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

export async function getMediaAssetBuffer(assetId) {
  const asset = await getMediaAsset(assetId)
  const metadata = asset.metadata || {}
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
  const asset = await getMediaAsset(assetId)
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
  const currentStream = asset.metadata?.stream || {}
  const currentVideoId = cleanString(currentStream.videoId)
  let stream

  if (currentVideoId && config.bunnyStreamConfigured) {
    const video = await getBunnyStreamVideo(config, currentVideoId)
    stream = {
      ...currentStream,
      provider: 'bunny_stream',
      enabled: true,
      providerReady: true,
      syncStatus: 'synced',
      syncedAt: nowIso(),
      libraryId: config.bunnyStreamLibraryId,
      collectionId: currentStream.collectionId || cleanString(video?.collectionId) || config.bunnyStreamCollectionId || null,
      collectionName: currentStream.collectionName || config.bunnyStreamCollectionName || null,
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
  const match = cleanString(value).match(/(?:\/api)?\/media\/assets\/(media_[\w-]+)(?:\/file|\/thumbnail)?/i)
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
