import express from 'express'
import {
  getContactTags,
  createContactTagHandler,
  updateContactTagHandler,
  deleteContactTagHandler
} from '../controllers/contactTagsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getContactTags)
router.post('/', createContactTagHandler)
router.put('/:id', updateContactTagHandler)
router.delete('/:id', deleteContactTagHandler)

export default router
