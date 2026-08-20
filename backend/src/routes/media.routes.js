import express from 'express'
import multer from 'multer'
import { tmpdir } from 'os'
import { join } from 'path'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { hasUserAccess } from '../utils/userAccess.js'
import {
  MEDIA_MAX_UPLOAD_BYTES,
  authorizeMcpMediaArchiveTicket,
  authorizeMcpMediaUploadTicket,
  cancelResumableVideoUploadHandler,
  createMediaFolderHandler,
  deleteMediaAssetHandler,
  deleteMediaSelectionHandler,
  downloadMediaAssetHandler,
  downloadMediaAssetsArchiveHandler,
  getMediaAssetStreamAnalyticsHandler,
  getMediaAssetUrlHandler,
  getMediaUploadPreflightHandler,
  getStorageUsageHandler,
  listMediaAssetsHandler,
  listMediaFoldersHandler,
  moveMediaAssetsHandler,
  moveMediaSelectionHandler,
  finalizeResumableVideoUploadHandler,
  prepareResumableVideoUploadHandler,
  prepareMcpMediaArchiveHandler,
  queueMediaAssetStreamHandler,
  renameMediaAssetHandler,
  renameMediaFolderHandler,
  replaceMediaAssetHandler,
  retryMediaAssetHandler,
  serveMediaAssetFileHandler,
  syncBunnyStorageFolderHandler,
  syncMediaAssetStreamHandler,
  storageDiagnosticsHandler,
  uploadMcpBunnyMediaHandler,
  uploadMediaHandler,
  directChatCompatibilityFromRequest
} from '../controllers/mediaController.js'

const router = express.Router()
const requireMediaAccess = requireModuleAccess('settings_media')
const requireMediaLicense = requireFeature('settings_media')
const requireChatAccess = requireModuleAccess('chat')
const requireAppointmentsAccess = requireModuleAccess('appointments')
const requireSitesAccess = requireModuleAccess('sites')
const requireAppointmentsLicense = requireFeature('appointments')
const requireSitesLicense = requireFeature('sites')
const requireDevelopersLicense = requireFeature('developers')
const SITES_MEDIA_UPLOAD_MODULES = new Set(['sites', 'forms', 'landing'])
const APPOINTMENTS_MEDIA_UPLOAD_MODULES = new Set(['appointments'])
const maxChatUploadBytes = 25 * 1024 * 1024
const maxAppointmentsImageUploadBytes = 2 * 1024 * 1024
const upload = multer({
  dest: join(tmpdir(), 'ristak-media-uploads'),
  limits: {
    fileSize: MEDIA_MAX_UPLOAD_BYTES
  }
})
const mcpUpload = multer({
  dest: join(tmpdir(), 'ristak-media-uploads'),
  limits: {
    fileSize: MEDIA_MAX_UPLOAD_BYTES,
    files: 1,
    fields: 0,
    parts: 2,
    headerPairs: 64
  }
})
const chatUpload = multer({
  dest: join(tmpdir(), 'ristak-media-uploads'),
  limits: {
    fileSize: maxChatUploadBytes,
    files: 1,
    fields: 8,
    parts: 9,
    fieldSize: 8 * 1024,
    headerPairs: 64
  }
})
const appointmentsImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxAppointmentsImageUploadBytes,
    files: 1,
    fields: 8,
    parts: 9,
    fieldSize: 8 * 1024,
    headerPairs: 64
  }
})

function formatUploadLimit(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '600 MB'
  const megabytes = bytes / 1024 / 1024
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`
  return `${Math.round(megabytes)} MB`
}

function uploadSingleFile(req, res, next) {
  const isDirectChatUpload = Boolean(req.directChatUpload?.enabled)
  const isAppointmentsImageUpload = req.mediaUploadModule === 'appointments'
  const parser = isDirectChatUpload
    ? chatUpload
    : isAppointmentsImageUpload
      ? appointmentsImageUpload
      : upload
  parser.single('file')(req, res, (error) => {
    if (!error) {
      next()
      return
    }

    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      const uploadLimit = isDirectChatUpload
        ? maxChatUploadBytes
        : isAppointmentsImageUpload
          ? maxAppointmentsImageUploadBytes
          : MEDIA_MAX_UPLOAD_BYTES
      res.status(413).json({
        success: false,
        error: `El archivo pesa demasiado. Límite máximo: ${formatUploadLimit(uploadLimit)}.`,
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

function uploadMcpSingleFile(req, res, next) {
  mcpUpload.single('file')(req, res, (error) => {
    if (!error) return next()
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `El archivo pesa demasiado. Límite máximo: ${formatUploadLimit(MEDIA_MAX_UPLOAD_BYTES)}.`,
        code: 'media_upload_too_large'
      })
    }
    return res.status(400).json({
      success: false,
      error: error.message || 'No se pudo recibir el archivo multimedia.',
      code: error.code || 'media_upload_failed'
    })
  })
}

function requireMcpUploadDevelopersAccess(req, res, next) {
  if (hasUserAccess(req.user, 'settings_api_access', 'read')) return next()
  return res.status(403).json({
    success: false,
    code: 'access_denied',
    error: 'El usuario ya no tiene acceso a Developers.'
  })
}

// Las subidas que alimentan directamente un mensaje pertenecen al módulo
// Chat, no a la pantalla administrativa de la biblioteca multimedia. El query
// se evalúa antes de multer; el controller conserva ese mismo valor como
// autoritativo para impedir que el body cambie de módulo después del gate.
export function resolveMediaUploadModule(req = {}) {
  return String(req.query?.module || req.body?.module || 'other').trim().toLowerCase()
}

export function resolveMediaUploadAccessModule(req = {}) {
  if (req.directChatUpload?.enabled) return 'chat'
  if (APPOINTMENTS_MEDIA_UPLOAD_MODULES.has(req.mediaUploadModule || resolveMediaUploadModule(req))) return 'appointments'
  return SITES_MEDIA_UPLOAD_MODULES.has(req.mediaUploadModule || resolveMediaUploadModule(req))
    ? 'sites'
    : 'settings_media'
}

export function requireMediaUploadAccess(req, res, next) {
  const accessModule = resolveMediaUploadAccessModule(req)
  if (accessModule === 'chat') {
    return requireChatAccess(req, res, next)
  }
  if (accessModule === 'appointments') {
    return requireAppointmentsLicense(req, res, (licenseError) => {
      if (licenseError) return next(licenseError)
      return requireAppointmentsAccess(req, res, next)
    })
  }
  if (accessModule === 'sites') {
    return requireSitesLicense(req, res, (licenseError) => {
      if (licenseError) return next(licenseError)
      return requireSitesAccess(req, res, next)
    })
  }
  return requireMediaLicense(req, res, (licenseError) => {
    if (licenseError) return next(licenseError)
    return requireMediaAccess(req, res, next)
  })
}

export function classifyMediaUpload(req, _res, next) {
  req.directChatUpload = directChatCompatibilityFromRequest(req)
  req.mediaUploadModule = resolveMediaUploadModule(req)
  next()
}

// Público: Bunny/CDN redirige; fallback local sirve el archivo sin sesión.
router.get('/assets/:assetId/file', serveMediaAssetFileHandler)
// URL y nombre terminan explícitamente en .ogg. Meta valida MIME, extensión y
// bytes al procesar una nota de voz; no debe heredar el nombre MP3 original.
router.get('/assets/:assetId/voice.ogg', (req, res, next) => {
  req.params.variant = 'voice'
  return serveMediaAssetFileHandler(req, res, next)
})
router.get('/assets/:assetId/thumbnail', (req, res, next) => {
  req.params.variant = 'thumbnail'
  return serveMediaAssetFileHandler(req, res, next)
})

// Capacidad temporal emitida por el MCP. La firma, usuario, licencia y permisos
// se validan ANTES de que Multer escriba un solo byte al disco.
router.post(
  '/mcp-upload',
  authorizeMcpMediaUploadTicket,
  requireDevelopersLicense,
  requireMcpUploadDevelopersAccess,
  requireMediaLicense,
  requireMediaAccess,
  uploadMcpSingleFile,
  uploadMcpBunnyMediaHandler
)
router.get(
  '/mcp-archive/:ticket',
  authorizeMcpMediaArchiveTicket,
  requireDevelopersLicense,
  requireMcpUploadDevelopersAccess,
  requireMediaLicense,
  requireMediaAccess,
  downloadMediaAssetsArchiveHandler
)

router.use(requireAuth)

// Todas las superficies autenticadas (Chat, Calendarios, Sites, Automatizaciones y Media)
// consultan el mismo guard antes de transmitir contenido. El límite duro se
// vuelve a validar dentro de mediaStorageService al reservar los bytes.
router.post('/upload-preflight', getMediaUploadPreflightHandler)
router.post('/video-upload/prepare', classifyMediaUpload, requireMediaUploadAccess, prepareResumableVideoUploadHandler)
router.post('/video-upload/:assetId/finalize', classifyMediaUpload, requireMediaUploadAccess, finalizeResumableVideoUploadHandler)
router.delete('/video-upload/:assetId', classifyMediaUpload, requireMediaUploadAccess, cancelResumableVideoUploadHandler)
router.post('/upload', classifyMediaUpload, requireMediaUploadAccess, uploadSingleFile, uploadMediaHandler)
router.get('/assets', requireMediaLicense, requireMediaAccess, listMediaAssetsHandler)
router.get('/folders', requireMediaLicense, requireMediaAccess, listMediaFoldersHandler)
router.post('/folders/sync', requireMediaLicense, requireMediaAccess, syncBunnyStorageFolderHandler)
router.post('/folders', requireMediaLicense, requireMediaAccess, createMediaFolderHandler)
router.patch('/folders/rename', requireMediaLicense, requireMediaAccess, renameMediaFolderHandler)
router.get('/storage/usage', requireMediaLicense, requireMediaAccess, getStorageUsageHandler)
router.get('/diagnostics', requireMediaLicense, requireMediaAccess, storageDiagnosticsHandler)
router.get('/assets/:assetId/url', requireMediaLicense, requireMediaAccess, getMediaAssetUrlHandler)
router.get('/assets/:assetId/download', requireMediaLicense, requireMediaAccess, downloadMediaAssetHandler)
router.get('/assets/:assetId/stream/analytics', requireMediaLicense, requireMediaAccess, getMediaAssetStreamAnalyticsHandler)
router.post('/assets/download', requireMediaLicense, requireMediaAccess, downloadMediaAssetsArchiveHandler)
router.post('/assets/move', requireMediaLicense, requireMediaAccess, moveMediaAssetsHandler)
router.post('/assets/move-selection', requireMediaLicense, requireMediaAccess, moveMediaSelectionHandler)
router.delete('/assets/selection', requireMediaLicense, requireMediaAccess, deleteMediaSelectionHandler)
router.patch('/assets/:assetId/rename', requireMediaLicense, requireMediaAccess, renameMediaAssetHandler)
router.delete('/assets/:assetId', requireMediaLicense, requireMediaAccess, deleteMediaAssetHandler)
router.put('/assets/:assetId/replace', requireMediaLicense, requireMediaAccess, classifyMediaUpload, uploadSingleFile, replaceMediaAssetHandler)
router.post('/assets/:assetId/retry', requireMediaLicense, requireMediaAccess, retryMediaAssetHandler)
router.post('/assets/:assetId/stream/queue', requireMediaLicense, requireMediaAccess, queueMediaAssetStreamHandler)
router.post('/assets/:assetId/stream/sync', requireMediaLicense, requireMediaAccess, syncMediaAssetStreamHandler)

export default router
