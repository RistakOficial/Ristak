import express from 'express'
import {
  getHiddenFilters,
  addHiddenFilter,
  deleteHiddenFilter
} from '../controllers/hiddenContactsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
// ACL-003: requireAdmin para restringir crear/borrar filtros de contactos ocultos a solo admin
import { requireAdmin } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getHiddenFilters)
// ACL-003: crear filtro de oculto solo admin (antes lo podía hacer cualquier empleado)
router.post('/', requireAdmin, addHiddenFilter)
// ACL-003: borrar filtro de oculto solo admin (antes lo podía hacer cualquier empleado)
router.delete('/:id', requireAdmin, deleteHiddenFilter)

export default router
