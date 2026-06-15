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
  getMediaAssetUrlHandler,
  getStorageUsageHandler,
  listMediaAssetsHandler,
  moveMediaAssetsHandler,
  replaceMediaAssetHandler,
  retryMediaAssetHandler,
  serveMediaAssetFileHandler,
  storageDiagnosticsHandler,
  uploadMediaHandler
} from '../controllers/mediaController.js'

const router = express.Router()
const requireMediaAccess = requireModuleAccess('settings_media')
const upload = multer({
  dest: join(tmpdir(), 'ristak-media-uploads'),
  limits: {
    fileSize: Number(process.env.MEDIA_MAX_UPLOAD_BYTES || 600 * 1024 * 1024)
  }
})

// Público: Bunny/CDN redirige; fallback local sirve el archivo sin sesión.
router.get('/assets/:assetId/file', serveMediaAssetFileHandler)
router.get('/assets/:assetId/thumbnail', (req, res, next) => {
  req.params.variant = 'thumbnail'
  return serveMediaAssetFileHandler(req, res, next)
})

router.use(requireAuth)

router.post('/upload', upload.single('file'), uploadMediaHandler)
router.get('/assets', requireMediaAccess, listMediaAssetsHandler)
router.get('/storage/usage', getStorageUsageHandler)
router.get('/diagnostics', storageDiagnosticsHandler)
router.get('/assets/:assetId/url', requireMediaAccess, getMediaAssetUrlHandler)
router.get('/assets/:assetId/download', requireMediaAccess, downloadMediaAssetHandler)
router.post('/assets/download', requireMediaAccess, downloadMediaAssetsArchiveHandler)
router.post('/assets/move', requireMediaAccess, moveMediaAssetsHandler)
router.delete('/assets/:assetId', requireMediaAccess, deleteMediaAssetHandler)
router.put('/assets/:assetId/replace', requireMediaAccess, upload.single('file'), replaceMediaAssetHandler)
router.post('/assets/:assetId/retry', requireMediaAccess, retryMediaAssetHandler)

export default router
