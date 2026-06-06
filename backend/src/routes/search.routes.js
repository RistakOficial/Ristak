import express from 'express'
import { globalSearch } from '../controllers/searchController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/global', globalSearch)

export default router
