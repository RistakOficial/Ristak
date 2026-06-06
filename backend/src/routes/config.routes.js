import express from 'express'
import { getConfig, saveConfig, deleteConfig } from '../controllers/configController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

/**
 * @route GET /api/config
 * @desc Obtiene toda la configuración de la app o keys específicas
 * @query keys - Opcional: lista de keys separadas por coma
 */
router.get('/', getConfig)

/**
 * @route POST /api/config
 * @desc Guarda una o múltiples configuraciones
 * @body key, value - Para guardar una sola config
 * @body config - Para guardar múltiples configs
 */
router.post('/', saveConfig)

/**
 * @route DELETE /api/config
 * @desc Elimina una o múltiples configuraciones
 * @query keys - Lista de keys separadas por coma
 */
router.delete('/', deleteConfig)

export default router
