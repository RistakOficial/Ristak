import express from 'express'
import {
  getContactTags,
  getSystemContactTags,
  getContactTagsCatalog,
  createContactTagHandler,
  updateContactTagHandler,
  deleteContactTagHandler,
  createContactTagFolderHandler,
  deleteContactTagFolderHandler
} from '../controllers/contactTagsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

// Las rutas fijas van antes de '/:id'
router.get('/catalog', getContactTagsCatalog)
router.get('/system', getSystemContactTags)
router.post('/folders', createContactTagFolderHandler)
router.delete('/folders/:id', deleteContactTagFolderHandler)

router.get('/', getContactTags)
router.post('/', createContactTagHandler)
router.put('/:id', updateContactTagHandler)
router.delete('/:id', deleteContactTagHandler)

export default router
