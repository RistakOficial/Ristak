import express from 'express'
import { getConfig, saveConfig, deleteConfig } from '../controllers/configController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
// (ACL-006) Gate de módulo para mutaciones de configuración
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

// (ACL-006) POST/DELETE /api/config carecían de gate de módulo: cualquier
// usuario autenticado podía escribir/borrar configuración. Gateamos las
// mutaciones con settings_account (nivel write). El GET se mantiene abierto a
// usuarios autenticados porque sirve lectura general de la app (tema, etc.).
const requireConfigWriteAccess = requireModuleAccess('settings_account')

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
router.post('/', requireConfigWriteAccess, saveConfig) // (ACL-006) gate de módulo

/**
 * @route DELETE /api/config
 * @desc Elimina una o múltiples configuraciones
 * @query keys - Lista de keys separadas por coma
 */
router.delete('/', requireConfigWriteAccess, deleteConfig) // (ACL-006) gate de módulo

export default router
