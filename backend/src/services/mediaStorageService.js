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

export async function getStorageRuntimeConfig() {
  const row = await getStorageSettingsRow()
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
    bunnyStreamLibraryId: cleanString(process.env.BUNNY_STREAM_LIBRARY_ID || row?.bunny_stream_library_id),
    bunnyStreamApiKey: cleanString(process.env.BUNNY_STREAM_API_KEY),
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

  config.missingEnvironment = missing
  config.bunnyConfigured = config.provider === 'bunny' && missing.length === 0
  config.storageStatus = !config.storageEnabled
    ? 'disabled'
    : config.provider === 'bunny'
      ? config.bunnyConfigured ? 'configured' : 'not_configured'
      : 'local_fallback'

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

async function uploadToBunny({ config, objectPath, buffer, mimeType }) {
  logger.info(`[MediaStorage] Subida a Bunny iniciada: ${objectPath}`)
  const response = await fetch(bunnyObjectUrl(config, objectPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buffer.length)
    },
    body: buffer
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw errorWithStatus(`Bunny rechazó la subida (${response.status}): ${detail.slice(0, 180) || response.statusText}`, 502, 'bunny_upload_failed')
  }

  logger.info(`[MediaStorage] Subida a Bunny completada: ${objectPath}`)
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

function shouldCompress({ config, mediaType }) {
  if (!config.compressionEnabled) return false
  if (mediaType === 'image') return config.imageOptimizationEnabled
  if (mediaType === 'video') return config.videoCompressionEnabled
  if (mediaType === 'audio') return config.audioCompressionEnabled
  return false
}

async function processMedia({ buffer, mimeType, mediaType, config }) {
  if (!shouldCompress({ config, mediaType })) {
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

function buildObjectPath({ businessId, mediaType, module, id, filename, extension, variant = '' }) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/')
  const folder = module && module !== 'other' ? module : `${mediaType}s`
  const suffix = variant ? `-${variant}` : ''
  return [
    'businesses',
    normalizeBusinessId(businessId),
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

async function saveLocalFile({ objectPath, buffer }) {
  const localPath = join(LOCAL_MEDIA_ROOT, objectPath)
  await fs.mkdir(dirname(localPath), { recursive: true })
  await fs.writeFile(localPath, buffer)
  return localPath
}

export async function uploadMediaAsset(input = {}) {
  const originalBuffer = Buffer.isBuffer(input.buffer)
    ? input.buffer
    : Buffer.from(input.buffer || '')
  if (!originalBuffer.length) {
    throw errorWithStatus('El archivo está vacío.', 400, 'empty_media')
  }

  const config = await getStorageRuntimeConfig()
  if (!config.storageEnabled) {
    throw errorWithStatus('El almacenamiento multimedia está deshabilitado.', 503, 'storage_disabled')
  }

  const originalFilename = sanitizeFilename(input.filename || input.originalFilename || 'archivo')
  const businessId = normalizeBusinessId(input.businessId)
  const userId = input.userId ? String(input.userId) : null
  const module = normalizeModule(input.module)
  const moduleEntityId = input.moduleEntityId ? String(input.moduleEntityId) : null
  const isPublic = input.isPublic !== undefined ? boolValue(input.isPublic) : true

  const detected = await detectMimeType(originalBuffer, input.mimeType || input.contentType || '', originalFilename)
  const mediaType = mediaTypeFromMime(detected.mimeType)
  validateMediaType({ mimeType: detected.mimeType, mediaType, sizeBytes: originalBuffer.length, settings: config })

  await assertQuotaAvailable({ businessId, quotaSize: originalBuffer.length, config })

  const processed = await processMedia({
    buffer: originalBuffer,
    mimeType: detected.mimeType,
    mediaType,
    config
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
    mediaType: finalMediaType,
    module,
    id,
    filename: originalFilename,
    extension
  })
  const thumbnailPath = thumbnail ? buildObjectPath({
    businessId,
    mediaType: finalMediaType,
    module,
    id,
    filename: originalFilename,
    extension: thumbnail.extension,
    variant: 'thumb'
  }) : ''

  let storageProvider = 'local'
  let publicUrl = buildAppPublicUrl(`/media/assets/${id}/file`)
  let metadata = {
    ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    mimeDetection: detected.source,
    compression: processed.compression,
    storageStatus: config.storageStatus,
    variants: {},
    stream: finalMediaType === 'video'
      ? {
          providerReady: Boolean(config.bunnyStreamLibraryId && config.bunnyStreamApiKey),
          mode: 'storage_first',
          note: 'Bunny Stream queda soportado por configuración, pero este pipeline inicial guarda el MP4 optimizado en Bunny Storage.'
        }
      : undefined
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
    sizeOriginal: originalBuffer.length,
    sizeProcessed: processed.buffer.length,
    quotaSize,
    width: dimensions.width,
    height: dimensions.height,
    duration: null,
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
  logger.info(`[MediaStorage] Archivo listo: ${id} (${finalMediaType}, ${quotaSize} bytes)`)

  return await getMediaAsset(id)
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

export async function getMediaAsset(assetId) {
  const row = await db.get('SELECT * FROM media_assets WHERE id = ?', [assetId])
  if (!row || row.deleted_at || row.status === 'deleted') {
    throw errorWithStatus('Archivo multimedia no encontrado.', 404, 'media_not_found')
  }
  return mapAssetRow(row)
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

  await refreshQuotaUsage(asset.businessId)
  return { id: assetId, deleted: true }
}

export async function replaceMediaAsset(assetId, input = {}) {
  const current = await getMediaAsset(assetId)
  const nextInput = {
    ...input,
    businessId: input.businessId || current.businessId,
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
    bunny_stream_library_id: config.bunnyStreamLibraryId || null,
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
