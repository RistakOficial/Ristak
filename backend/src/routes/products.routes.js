import express from 'express'
import {
  createPrice,
  createProduct,
  deleteProduct,
  listPrices,
  listProducts,
  syncProducts,
  updateProduct
} from '../controllers/highlevelController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', listProducts)
router.post('/', createProduct)
router.post('/sync', syncProducts)
router.put('/:productId', updateProduct)
router.delete('/:productId', deleteProduct)
router.get('/:productId/prices', listPrices)
router.post('/:productId/prices', createPrice)

export default router
