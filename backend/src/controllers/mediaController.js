import { promises as fs } from 'fs'
import JSZip from 'jszip'
import {
  extractMediaAssetIdFromUrl,
  getMediaAsset,
  getMediaAssetBunnyStreamAnalytics,
  getMediaAssetBuffer,
  getMediaAssetFile,
  getStorageUsage,
  listMediaAssets,
  moveMediaAssets,
  replaceMediaAsset,
  retryMediaAsset,
  runStorageDiagnostics,
  softDeleteMediaAsset,
  syncMediaAssetBunnyStream,
  uploadMediaAsset,
  uploadMediaAssetFromDataUrl
} from '../services/mediaStorageService.js'
import { logger } from '../utils/logger.js'

const MAX_ARCHIVE_DOWNLOAD_ITEMS = Number(process.env.MEDIA_MAX_ARCHIVE_DOWNLOAD_ITEMS || 500)

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return /^(1|true|yes|si|on)$/i.test(String(value).trim())
}

function sendError(res, error, fallback = 'Error procesando almacenamiento multimedia') {
  const status = error.status || 500
  res.status(status).json({
    success: false,
    error: error.message || fallback,
    ...(error.code ? { code: error.code } : {})
  })
}

function safeHeaderFilename(value = '', fallback = 'media') {
  const filename = String(value || fallback)
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\r\n"]/g, '')
    .trim()
  return filename || fallback
}

function attachmentDisposition(filename) {
  const safe = safeHeaderFilename(filename)
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

function ensureZipFilename(value = '') {
  const filename = safeHeaderFilename(value, 'media.zip')
  return /\.zip$/i.test(filename) ? filename : `${filename}.zip`
}

function sanitizeZipSegment(value = '') {
  const segment = String(value || '')
    .trim()
    .replace(/[\u0000-\u001f<>:"|?*]+/g, '-')
    .replace(/\.+$/g, '')
    .slice(0, 160)
  if (!segment || segment === '.' || segment === '..') return ''
  return segment
}

function sanitizeZipPath(value = '', fallback = 'archivo') {
  const parts = String(value || fallback)
    .split(/[\\/]+/)
    .map(sanitizeZipSegment)
    .filter(Boolean)

  if (!parts.length) {
    parts.push(sanitizeZipSegment(fallback) || 'archivo')
  }

  return parts.join('/')
}

function uniqueZipPath(path, usedPaths) {
  let candidate = path
  let index = 2
  while (usedPaths.has(candidate)) {
    const slashIndex = path.lastIndexOf('/')
    const directory = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : ''
    const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path
    const dotIndex = filename.lastIndexOf('.')
    const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename
    const extension = dotIndex > 0 ? filename.slice(dotIndex) : ''
    candidate = `${directory}${base} (${index})${extension}`
    index += 1
  }
  usedPaths.add(candidate)
  return candidate
}

function archiveEntriesFromBody(body = {}) {
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : Array.isArray(body.assetIds)
      ? body.assetIds.map((id) => ({ id }))
      : []
  const seen = new Set()
  const entries = []

  for (const rawEntry of rawEntries) {
    const id = String(typeof rawEntry === 'string' ? rawEntry : rawEntry?.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      path: typeof rawEntry === 'object' && rawEntry ? String(rawEntry.path || rawEntry.filename || '') : ''
    })
  }

  return entries
}

function downloadInputError(message, status = 400, code = 'invalid_media_download') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

async function uploadInputFromRequest(req) {
  const body = req.body || {}
  const common = {
    businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
    userId: body.userId || body.user_id || req.user?.userId || req.user?.id || null,
    module: body.module || 'other',
    moduleEntityId: body.moduleEntityId || body.module_entity_id || null,
    isPublic: parseBoolean(body.isPublic ?? body.is_public, true)
  }

  if (req.file?.path) {
    const buffer = await fs.readFile(req.file.path)
    await fs.rm(req.file.path, { force: true }).catch(() => undefined)
    return {
      mode: 'buffer',
      input: {
        ...common,
        buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype
      }
    }
  }

  if (req.file?.buffer) {
    return {
      mode: 'buffer',
      input: {
        ...common,
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype
      }
    }
  }

  return {
    mode: 'dataUrl',
    input: {
      ...common,
      fileBase64: body.fileBase64 || body.file_base64 || body.dataUrl || body.content,
      filename: body.filename || body.fileName || body.originalFilename || 'archivo'
    }
  }
}

export async function uploadMediaHandler(req, res) {
  try {
    logger.info('[MediaStorage] Subida iniciada')
    const prepared = await uploadInputFromRequest(req)
    const asset = prepared.mode === 'buffer'
      ? await uploadMediaAsset(prepared.input)
      : await uploadMediaAssetFromDataUrl(prepared.input)
    res.status(201).json({ success: true, data: asset })
  } catch (error) {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true }).catch(() => undefined)
    }
    logger.error(`[MediaStorage] Error subiendo archivo: ${error.message}`)
    sendError(res, error, 'Error subiendo archivo multimedia')
  }
}

export async function listMediaAssetsHandler(req, res) {
  try {
    const assets = await listMediaAssets({
      businessId: req.query.businessId || 'default',
      module: req.query.module || '',
      mediaType: req.query.mediaType || req.query.media_type || '',
      status: req.query.status || '',
      limit: req.query.limit,
      offset: req.query.offset
    })
    res.json({ success: true, data: assets })
  } catch (error) {
    sendError(res, error, 'Error listando archivos multimedia')
  }
}

export async function getMediaAssetUrlHandler(req, res) {
  try {
    const asset = await getMediaAsset(req.params.assetId)
    res.json({
      success: true,
      data: {
        id: asset.id,
        url: asset.publicUrl,
        publicUrl: asset.publicUrl,
        privateUrl: asset.privateUrl,
        status: asset.status,
        mimeType: asset.mimeType,
        mediaType: asset.mediaType
      }
    })
  } catch (error) {
    sendError(res, error, 'Error obteniendo URL multimedia')
  }
}

export async function getStorageUsageHandler(req, res) {
  try {
    const usage = await getStorageUsage({ businessId: req.query.businessId || 'default' })
    res.json({ success: true, data: usage })
  } catch (error) {
    sendError(res, error, 'Error calculando almacenamiento')
  }
}

export async function deleteMediaAssetHandler(req, res) {
  try {
    const result = await softDeleteMediaAsset(req.params.assetId)
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error eliminando archivo multimedia')
  }
}

export async function downloadMediaAssetHandler(req, res) {
  try {
    const { buffer, mimeType, filename } = await getMediaAssetBuffer(req.params.assetId)
    const downloadName = safeHeaderFilename(filename || req.params.assetId, req.params.assetId)
    res.setHeader('Content-Type', mimeType || 'application/octet-stream')
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', attachmentDisposition(downloadName))
    res.send(buffer)
  } catch (error) {
    sendError(res, error, 'Error descargando archivo multimedia')
  }
}

export async function downloadMediaAssetsArchiveHandler(req, res) {
  try {
    const entries = archiveEntriesFromBody(req.body)
    if (!entries.length) {
      throw downloadInputError('Selecciona al menos un archivo para descargar.')
    }
    if (entries.length > MAX_ARCHIVE_DOWNLOAD_ITEMS) {
      throw downloadInputError(`Selecciona máximo ${MAX_ARCHIVE_DOWNLOAD_ITEMS} archivos por descarga.`, 413, 'media_archive_too_large')
    }

    const zip = new JSZip()
    const usedPaths = new Set()

    for (const entry of entries) {
      const { buffer, filename } = await getMediaAssetBuffer(entry.id)
      const fallbackName = safeHeaderFilename(filename || `${entry.id}.bin`, `${entry.id}.bin`)
      const archivePath = uniqueZipPath(sanitizeZipPath(entry.path, fallbackName), usedPaths)
      zip.file(archivePath, buffer, { binary: true })
    }

    const archive = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
    const archiveName = ensureZipFilename(req.body?.filename)

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Length', String(archive.length))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', attachmentDisposition(archiveName))
    res.send(archive)
  } catch (error) {
    sendError(res, error, 'Error descargando archivos multimedia')
  }
}

export async function moveMediaAssetsHandler(req, res) {
  try {
    const body = req.body || {}
    const moved = await moveMediaAssets({
      businessId: body.businessId || body.business_id || req.query?.businessId || 'default',
      entries: Array.isArray(body.entries) ? body.entries : [],
      assetIds: Array.isArray(body.assetIds) ? body.assetIds : [],
      targetFolderPath: body.targetFolderPath || body.folderPath || ''
    })
    res.json({ success: true, data: moved })
  } catch (error) {
    sendError(res, error, 'Error moviendo archivos multimedia')
  }
}

export async function replaceMediaAssetHandler(req, res) {
  try {
    const prepared = await uploadInputFromRequest(req)
    const result = prepared.mode === 'buffer'
      ? await replaceMediaAsset(req.params.assetId, prepared.input)
      : await replaceMediaAsset(req.params.assetId, {
          ...prepared.input,
          buffer: undefined,
          fileBase64: prepared.input.fileBase64
        })
    res.json({ success: true, data: result })
  } catch (error) {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true }).catch(() => undefined)
    }
    sendError(res, error, 'Error reemplazando archivo multimedia')
  }
}

export async function retryMediaAssetHandler(req, res) {
  try {
    const result = await retryMediaAsset(req.params.assetId)
    res.json({ success: true, data: result })
  } catch (error) {
    sendError(res, error, 'Error reintentando archivo multimedia')
  }
}

export async function syncMediaAssetStreamHandler(req, res) {
  try {
    const body = req.body || {}
    const asset = await syncMediaAssetBunnyStream(req.params.assetId, {
      module: body.module || req.query?.module,
      moduleEntityId: body.moduleEntityId || body.module_entity_id || req.query?.moduleEntityId || req.query?.module_entity_id
    })
    res.json({ success: true, data: asset })
  } catch (error) {
    sendError(res, error, 'Error sincronizando metadata de Bunny Stream')
  }
}

export async function getMediaAssetStreamAnalyticsHandler(req, res) {
  try {
    const analytics = await getMediaAssetBunnyStreamAnalytics(req.params.assetId, {
      dateFrom: req.query.dateFrom || req.query.date_from,
      dateTo: req.query.dateTo || req.query.date_to,
      hourly: parseBoolean(req.query.hourly)
    })
    res.json({ success: true, data: analytics })
  } catch (error) {
    sendError(res, error, 'Error obteniendo analíticas de Bunny Stream')
  }
}

export async function storageDiagnosticsHandler(_req, res) {
  try {
    const diagnostics = await runStorageDiagnostics()
    res.json({ success: true, data: diagnostics })
  } catch (error) {
    sendError(res, error, 'Error diagnosticando almacenamiento')
  }
}

export async function serveMediaAssetFileHandler(req, res) {
  try {
    const assetId = req.params.assetId || extractMediaAssetIdFromUrl(req.originalUrl)
    const file = await getMediaAssetFile(assetId, req.params.variant || '')
    if (file.redirectUrl) {
      return res.redirect(302, file.redirectUrl)
    }

    res.setHeader('Content-Type', file.contentType || 'application/octet-stream')
    if (file.contentLength) res.setHeader('Content-Length', String(file.contentLength))
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    if (file.filename) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`)
    }
    file.stream.pipe(res)
  } catch (error) {
    res.status(error.status || 404).json({ success: false, error: error.message })
  }
}

export async function internalStorageUsageHandler(_req, res) {
  try {
    const usage = await getStorageUsage({ businessId: 'default' })
    res.json(usage)
  } catch (error) {
    sendError(res, error, 'Error calculando almacenamiento interno')
  }
}

export async function internalStorageDiagnosticsHandler(_req, res) {
  try {
    const diagnostics = await runStorageDiagnostics()
    res.json(diagnostics)
  } catch (error) {
    sendError(res, error, 'Error diagnosticando almacenamiento interno')
  }
}
