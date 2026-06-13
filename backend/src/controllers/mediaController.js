import { promises as fs } from 'fs'
import {
  extractMediaAssetIdFromUrl,
  getMediaAsset,
  getMediaAssetFile,
  getStorageUsage,
  listMediaAssets,
  replaceMediaAsset,
  retryMediaAsset,
  runStorageDiagnostics,
  softDeleteMediaAsset,
  uploadMediaAsset,
  uploadMediaAssetFromDataUrl
} from '../services/mediaStorageService.js'
import { logger } from '../utils/logger.js'

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

