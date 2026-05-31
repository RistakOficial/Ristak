import express from 'express'
import {
  getApiToken,
  revokeApiToken,
  rotateApiToken
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getApiToken)
router.post('/token/rotate', rotateApiToken)
router.delete('/token', revokeApiToken)

export default router
