import express from 'express'
import multer from 'multer'
import { tmpdir } from 'os'
import { join } from 'path'
import { requireAuth } from '../middleware/authMiddleware.js'
import {
  deleteMediaAssetHandler,
  getMediaAssetUrlHandler,
  getStorageUsageHandler,
  listMediaAssetsHandler,
  replaceMediaAssetHandler,
  retryMediaAssetHandler,
  serveMediaAssetFileHandler,
  storageDiagnosticsHandler,
  uploadMediaHandler
} from '../controllers/mediaController.js'

const router = express.Router()
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
router.get('/assets', listMediaAssetsHandler)
router.get('/storage/usage', getStorageUsageHandler)
router.get('/diagnostics', storageDiagnosticsHandler)
router.get('/assets/:assetId/url', getMediaAssetUrlHandler)
router.delete('/assets/:assetId', deleteMediaAssetHandler)
router.put('/assets/:assetId/replace', upload.single('file'), replaceMediaAssetHandler)
router.post('/assets/:assetId/retry', retryMediaAssetHandler)

export default router

