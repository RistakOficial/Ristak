import express from 'express'
import {
  login,
  verifyTokenEndpoint,
  changePassword,
  changeUsername,
  updateProfile,
  getMe,
  checkSetup,
  setup,
  setupInfo,
  localDevSession,
  getApiToken,
  rotateApiToken,
  revokeApiToken
} from '../controllers/authController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// GET /api/auth/setup - Verificar si se necesita setup
router.get('/setup', checkSetup)

// POST /api/auth/setup - Crear el primer usuario (solo si no existen usuarios)
router.post('/setup', setup)

// GET /api/auth/setup-info - Validar setup token del instalador y precargar email del dueño
router.get('/setup-info', setupInfo)

// POST /api/auth/login - Autenticar usuario
router.post('/login', login)

// POST /api/auth/local-dev-session - Sesión automática sólo para desarrollo local
router.post('/local-dev-session', localDevSession)

// POST /api/auth/verify - Verificar token JWT
router.post('/verify', verifyTokenEndpoint)

// POST /api/auth/change-password - Cambiar contraseña
router.post('/change-password', requireAuth, changePassword)

// POST /api/auth/change-username - Cambiar nombre de usuario
router.post('/change-username', requireAuth, changeUsername)

// PATCH /api/auth/profile - Actualizar datos visibles de la cuenta
router.patch('/profile', requireAuth, updateProfile)

// GET /api/auth/me - Obtener información del usuario autenticado
router.get('/me', requireAuth, getMe)

// GET /api/auth/api-token - Obtener metadatos del API token autenticado
router.get('/api-token', requireAuth, getApiToken)

// POST /api/auth/api-token/rotate - Rotar/generar API token del usuario autenticado
router.post('/api-token/rotate', requireAuth, rotateApiToken)

// DELETE /api/auth/api-token - Revocar API token del usuario autenticado
router.delete('/api-token', requireAuth, revokeApiToken)

export default router
