import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  getAutomationsHandler,
  getAutomationHandler,
  createAutomationHandler,
  updateAutomationHandler,
  duplicateAutomationHandler,
  deleteAutomationHandler,
  createFolderHandler,
  updateFolderHandler,
  reorderFoldersHandler,
  deleteFolderHandler,
  getEnrollmentsHandler,
  getContactAutomationActivityHandler,
  enrollContactInAutomationHandler,
  getEnrollmentStatsHandler,
  getCampaignsCatalogHandler,
  getAdsetsCatalogHandler,
  getAdsCatalogHandler,
  uploadAssetHandler,
  serveAssetHandler
} from '../controllers/automationsController.js'

const router = express.Router()

// Público: los archivos deben poder leerse desde WhatsApp/Meta sin sesión
router.get('/assets/:assetId', serveAssetHandler)

router.use(requireAuth)
router.use(requireModuleAccess('automations'))

// Subida de archivos de bloques (imagen, video, audio, documento)
router.post('/assets', express.json({ limit: '30mb' }), uploadAssetHandler)

// Carpetas (antes de /:automationId para que "folders" no se interprete como id)
router.post('/folders', createFolderHandler)
router.post('/folders/reorder', reorderFoldersHandler)
router.put('/folders/:folderId', updateFolderHandler)
router.delete('/folders/:folderId', deleteFolderHandler)

// Catálogos para filtros y disparadores del editor (atribución de Meta Ads)
router.get('/catalogs/campaigns', getCampaignsCatalogHandler)
router.get('/catalogs/adsets', getAdsetsCatalogHandler)
router.get('/catalogs/ads', getAdsCatalogHandler)

// Automatizaciones
router.get('/', getAutomationsHandler)
router.post('/', createAutomationHandler)
router.get('/contacts/:contactId/activity', getContactAutomationActivityHandler)
router.get('/:automationId/enrollments', getEnrollmentsHandler)
router.get('/:automationId/stats', getEnrollmentStatsHandler)
router.get('/:automationId', getAutomationHandler)
router.put('/:automationId', updateAutomationHandler)
router.post('/:automationId/enroll-contact', enrollContactInAutomationHandler)
router.post('/:automationId/duplicate', duplicateAutomationHandler)
router.delete('/:automationId', deleteAutomationHandler)

export default router
