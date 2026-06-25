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
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
// (ACL-001) Los productos/precios pertenecen al área de Pagos (AccessRoute
// moduleKey="payments" en el frontend); exigimos el mismo módulo en la API directa.
router.use(requireModuleAccess('payments'))

router.get('/', listProducts)
router.post('/', createProduct)
router.post('/sync', syncProducts)
router.put('/:productId', updateProduct)
router.delete('/:productId', deleteProduct)
router.get('/:productId/prices', listPrices)
router.post('/:productId/prices', createPrice)

export default router
