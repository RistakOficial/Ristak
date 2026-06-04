import express from 'express'
import {
  createPrice,
  createProduct,
  listPrices,
  listProducts,
  syncProducts
} from '../controllers/highlevelController.js'

const router = express.Router()

router.get('/', listProducts)
router.post('/', createProduct)
router.post('/sync', syncProducts)
router.get('/:productId/prices', listPrices)
router.post('/:productId/prices', createPrice)

export default router
