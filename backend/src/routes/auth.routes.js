import express from 'express'
import {
  login,
  verifyTokenEndpoint,
  changePassword,
  forgotPassword,
  resetPassword,
  changeUsername,
  updateProfile,
  getMe,
  checkSetup,
  setup,
  setupInfo,
  ssoLogin,
  localDevSession,
  startGoogleLogin,
  getApiToken,
  rotateApiToken,
  revokeApiToken
} from '../controllers/authController.js'
import {
  createUser,
  deleteUser,
  listUsers,
  updateUser
} from '../controllers/userAccessController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireAdmin, requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'

const router = express.Router()

// (AUTH-001 / SEC-004) Rate limiting + lockout para superficies de autenticación.
// Sin esto el login/setup/SSO son ilimitados y se pueden romper por fuerza bruta.
// Requiere `app.set('trust proxy', ...)` (ya configurado en server.js) para que la IP
// no sea falsificable vía X-Forwarded-For.
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === '1'

const rateLimited429 = (message) => (req, res) => {
  res.status(429).json({
    success: false,
    code: 'rate_limited',
    message: message || 'Demasiados intentos. Espera unos minutos e intenta de nuevo.'
  })
}

// Login: cuenta por IP + identificador, y solo penaliza intentos fallidos
// (skipSuccessfulRequests) para no castigar al usuario que sí entra. Tras 10
// fallos en 15 min se bloquea temporalmente esa combinación IP+usuario.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => RATE_LIMIT_DISABLED,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip)
    const identifier = String(req.body?.email || req.body?.username || '').trim().toLowerCase()
    return identifier ? `${ipKey}:${identifier}` : ipKey
  },
  handler: rateLimited429('Demasiados intentos de inicio de sesión. Espera unos minutos e intenta de nuevo.')
})

// Setup/SSO/Google: límite por IP (estas no llevan un identificador estable).
const authBurstRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => RATE_LIMIT_DISABLED,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: rateLimited429()
})

// GET /api/auth/setup - Verificar si se necesita setup
router.get('/setup', checkSetup)

// POST /api/auth/setup - Crear el primer usuario (solo si no existen usuarios)
// (AUTH-001 / SEC-004) limitar por IP
router.post('/setup', authBurstRateLimiter, setup)

// GET /api/auth/setup-info - Validar setup token del instalador y precargar email del dueño
router.get('/setup-info', setupInfo)

// POST /api/auth/sso - Entrada directa desde el portal central (token de un solo uso)
// (AUTH-001 / SEC-004) limitar por IP
router.post('/sso', authBurstRateLimiter, ssoLogin)

// POST /api/auth/login - Autenticar usuario
// (AUTH-001 / SEC-004) rate limit + lockout por IP+usuario
router.post('/login', loginRateLimiter, login)

// (AUTH-010) Recuperación de contraseña por correo (público, rate-limited por IP).
router.post('/forgot-password', authBurstRateLimiter, forgotPassword)
router.post('/reset-password', authBurstRateLimiter, resetPassword)

// POST /api/auth/local-dev-session - Sesión automática sólo para desarrollo local
router.post('/local-dev-session', localDevSession)

// POST /api/auth/google/start - Iniciar Google Login desde el portal central
// (AUTH-001 / SEC-004) limitar por IP
router.post('/google/start', authBurstRateLimiter, startGoogleLogin)

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

// Usuarios y accesos internos del CRM
router.get('/users', requireAuth, requireAdmin, listUsers)
router.post('/users', requireAuth, requireAdmin, createUser)
router.patch('/users/:userId', requireAuth, requireAdmin, updateUser)
router.delete('/users/:userId', requireAuth, requireAdmin, deleteUser)

// GET /api/auth/api-token - Obtener metadatos del API token autenticado
router.get('/api-token', requireAuth, requireModuleAccess('settings_api_access'), getApiToken)

// POST /api/auth/api-token/rotate - Rotar/generar API token del usuario autenticado
router.post('/api-token/rotate', requireAuth, requireModuleAccess('settings_api_access'), rotateApiToken)

// DELETE /api/auth/api-token - Revocar API token del usuario autenticado
router.delete('/api-token', requireAuth, requireModuleAccess('settings_api_access'), revokeApiToken)

export default router
