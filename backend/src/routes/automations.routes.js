import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
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
  deleteFolderHandler
} from '../controllers/automationsController.js'

const router = express.Router()

router.use(requireAuth)

// Carpetas (antes de /:automationId para que "folders" no se interprete como id)
router.post('/folders', createFolderHandler)
router.post('/folders/reorder', reorderFoldersHandler)
router.put('/folders/:folderId', updateFolderHandler)
router.delete('/folders/:folderId', deleteFolderHandler)

// Automatizaciones
router.get('/', getAutomationsHandler)
router.post('/', createAutomationHandler)
router.get('/:automationId', getAutomationHandler)
router.put('/:automationId', updateAutomationHandler)
router.post('/:automationId/duplicate', duplicateAutomationHandler)
router.delete('/:automationId', deleteAutomationHandler)

export default router
