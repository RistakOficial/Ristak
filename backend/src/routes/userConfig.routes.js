// (MOB-006) Rutas de configuración de notificaciones del celular POR USUARIO.
// Self (GET/POST /) solo requiere requireAuth: a propósito NO usa el gate
// settings_account de /api/config para que los EMPLEADOS puedan guardar SUS
// propias preferencias. Las rutas /admin sí exigen requireAdmin.
import express from 'express'
import {
  getUserConfig,
  saveUserConfig,
  getUserConfigAdmin,
  patchUserConfigAdmin
} from '../controllers/userConfigController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireAdmin } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)

// Self: el usuario lee/escribe SU propia configuración (usa req.user.userId).
router.get('/', getUserConfig)
router.post('/', saveUserConfig)

// Admin: ve/ajusta la configuración del equipo.
router.get('/admin', requireAdmin, getUserConfigAdmin)
router.patch('/admin/:userId', requireAdmin, patchUserConfigAdmin)

export default router
