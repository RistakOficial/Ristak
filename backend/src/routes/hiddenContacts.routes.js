import express from 'express'
import {
  getHiddenFilters,
  addHiddenFilter,
  deleteHiddenFilter
} from '../controllers/hiddenContactsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getHiddenFilters)
router.post('/', addHiddenFilter)
router.delete('/:id', deleteHiddenFilter)

export default router
