import { Router } from 'express'
import * as costsController from '../controllers/costsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = Router()

router.use(requireAuth)
router.use(requireModuleAccess('settings_costs'))

// Obtener todos los costos
router.get('/', costsController.getAllCosts)

// Obtener un costo específico
router.get('/:id', costsController.getCostById)

// Crear nuevo costo
router.post('/', costsController.createCost)

// Actualizar costo
router.put('/:id', costsController.updateCost)

// Eliminar costo (soft delete)
router.delete('/:id', costsController.deleteCost)

// Calcular costos totales
router.post('/calculate', costsController.calculateCosts)

export default router
