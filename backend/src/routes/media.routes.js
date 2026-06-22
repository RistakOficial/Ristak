import express from 'express'
import multer from 'multer'
import { tmpdir } from 'os'
import { join } from 'path'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  deleteMediaAssetHandler,
  downloadMediaAssetHandler,
  downloadMediaAssetsArchiveHandler,
  getMediaAssetStreamAnalyticsHandler,
  getMediaAssetUrlHandler,
  getStorageUsageHandler,
  listMediaAssetsHandler,
  moveMediaAssetsHandler,
  replaceMediaAssetHandler,
  retryMediaAssetHandler,
  serveMediaAssetFileHandler,
  syncMediaAssetStreamHandler,
  storageDiagnosticsHandler,
  uploadMediaHandler
} from '../controllers/mediaController.js'

const router = express.Router()
const requireMediaAccess = requireModuleAccess('settings_media')
const maxUploadBytes = Number(process.env.MEDIA_MAX_UPLOAD_BYTES || 600 * 1024 * 1024)
const upload = multer({
  dest: join(tmpdir(), 'ristak-media-uploads'),
  limits: {
    fileSize: maxUploadBytes
  }
})

function formatUploadLimit(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '600 MB'
  const megabytes = bytes / 1024 / 1024
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
  return `${Math.round(megabytes)} MB`
}

function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        success: false,
        error: `El archivo pesa demasiado. Límite máximo: ${formatUploadLimit(maxUploadBytes)}.`,
        code: 'media_upload_too_large'
      })
      return
    }

    res.status(400).json({
      success: false,
      error: error.message || 'No se pudo recibir el archivo multimedia.',
      code: error.code || 'media_upload_failed'
    })
  })
}

// Público: Bunny/CDN redirige; fallback local sirve el archivo sin sesión.
router.get('/assets/:assetId/file', serveMediaAssetFileHandler)
router.get('/assets/:assetId/thumbnail', (req, res, next) => {
  req.params.variant = 'thumbnail'
  return serveMediaAssetFileHandler(req, res, next)
})

router.use(requireAuth)

router.post('/upload', uploadSingleFile, uploadMediaHandler)
router.get('/assets', requireMediaAccess, listMediaAssetsHandler)
router.get('/storage/usage', getStorageUsageHandler)
router.get('/diagnostics', storageDiagnosticsHandler)
router.get('/assets/:assetId/url', requireMediaAccess, getMediaAssetUrlHandler)
router.get('/assets/:assetId/download', requireMediaAccess, downloadMediaAssetHandler)
router.get('/assets/:assetId/stream/analytics', requireMediaAccess, getMediaAssetStreamAnalyticsHandler)
router.post('/assets/download', requireMediaAccess, downloadMediaAssetsArchiveHandler)
router.post('/assets/move', requireMediaAccess, moveMediaAssetsHandler)
router.delete('/assets/:assetId', requireMediaAccess, deleteMediaAssetHandler)
router.put('/assets/:assetId/replace', requireMediaAccess, uploadSingleFile, replaceMediaAssetHandler)
router.post('/assets/:assetId/retry', requireMediaAccess, retryMediaAssetHandler)
router.post('/assets/:assetId/stream/sync', requireMediaAccess, syncMediaAssetStreamHandler)

export default router
