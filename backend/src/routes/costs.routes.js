import { Router } from 'express'
import * as costsController from '../controllers/costsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = Router()

router.use(requireAuth)

// Obtener todos los costos
router.get('/costs', costsController.getAllCosts)

// Obtener un costo específico
router.get('/costs/:id', costsController.getCostById)

// Crear nuevo costo
router.post('/costs', costsController.createCost)

// Actualizar costo
router.put('/costs/:id', costsController.updateCost)

// Eliminar costo (soft delete)
router.delete('/costs/:id', costsController.deleteCost)

// Calcular costos totales
router.post('/costs/calculate', costsController.calculateCosts)

export default router
