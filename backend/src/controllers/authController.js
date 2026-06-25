import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { hashPassword, verifyPassword, generateToken, verifyToken, validatePasswordPolicy } from '../utils/auth.js'
import {
  getExternalApiAppId,
  getApiTokenMetadataForUser,
  revokeApiTokenForUser,
  rotateApiTokenForUser
} from '../utils/apiTokens.js'
import {
  getLicenseState,
  isLicenseEnforced,
  verifyLicenseWithServer,
  verifyOwnerCredentialsWithServer,
  verifySetupToken,
  consumeSetupToken,
  createCentralGoogleLoginUrl
} from '../services/licenseService.js'
import { saveAccountLocaleSettings } from '../utils/accountLocale.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { getEffectiveAccessConfig } from '../utils/userAccess.js'

function sanitizeAuthReturnPath(value, fallbackPath = '/dashboard') {
  const fallback = typeof fallbackPath === 'string'
    && fallbackPath.startsWith('/')
    && !fallbackPath.startsWith('//')
    && !fallbackPath.startsWith('/api/')
    ? fallbackPath
    : '/dashboard'
  const path = String(value || '').trim()
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/')) {
    return fallback
  }
  return path.slice(0, 700)
}

function cleanProfileText(value, maxLength = 160) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

function buildFullName(firstName, lastName, fallback = '') {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || cleanProfileText(fallback)
}

function serializeAuthUser(user, licenseState = null) {
  const firstName = cleanProfileText(user.first_name)
  const lastName = cleanProfileText(user.last_name)
  const fullName = buildFullName(firstName, lastName, user.full_name || user.username)

  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    firstName,
    lastName,
    fullName,
    phone: cleanProfileText(user.phone, 40),
    businessName: cleanProfileText(user.business_name),
    role: user.role,
    accessConfig: getEffectiveAccessConfig(user),
    licenseEnforced: licenseState?.enforced === true,
    licensePlan: licenseState?.plan || null,
    licenseFeatures: licenseState?.features && typeof licenseState.features === 'object'
      ? licenseState.features
      : {}
  }
}

function cleanLoginIdentifier(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

function sendLicenseBlocked(res, licenseState, fallbackMessage = 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.') {
  return res.status(403).json({
    success: false,
    code: 'license_blocked',
    reason: licenseState?.reason || 'license_blocked',
    message: licenseState?.message || fallbackMessage
  })
}

function getHeaderHostname(value = '') {
  const rawValue = String(value || '').trim()
  if (!rawValue) return ''

  try {
    return new URL(rawValue.includes('://') ? rawValue : `http://${rawValue}`).hostname
  } catch {
    return rawValue.split(',')[0].trim().replace(/^\[/, '').replace(/\]$/, '').split(':')[0]
  }
}

function isLoopbackHost(value = '') {
  const hostname = String(value || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isLoopbackAddress(value = '') {
  const address = String(value || '').trim().replace(/^::ffff:/, '')
  return isLoopbackHost(address)
}

function isLocalDevAuthRequest(req) {
  if (process.env.NODE_ENV === 'production') return false
  if (process.env.ALLOW_LOCAL_DEV_LOGIN === 'false') return false

  const remoteAddress = req.ip || req.socket?.remoteAddress || ''
  if (!isLoopbackAddress(remoteAddress)) return false

  const hostCandidates = [
    req.get('host'),
    req.get('origin'),
    req.get('referer'),
    req.get('x-forwarded-host')
  ]
    .map(getHeaderHostname)
    .filter(Boolean)

  return hostCandidates.length > 0 && hostCandidates.every(isLoopbackHost)
}

/**
 * POST /api/auth/login
 * Autentica un usuario y devuelve un token JWT
 */
export async function login(req, res) {
  try {
    const { username, password } = req.body
    const loginIdentifier = cleanLoginIdentifier(username)

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Usuario y contraseña son requeridos'
      })
    }

    const normalizedLoginPhone = normalizePhoneForStorage(loginIdentifier)

    // Buscar usuario por username, email o teléfono.
    const user = await db.get(
      'SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) OR phone = ?',
      [loginIdentifier, loginIdentifier, normalizedLoginPhone]
    )

    if (!user) {
      logger.warn(`⚠️  Intento de login fallido: usuario "${loginIdentifier}" no encontrado`)
      return res.status(401).json({
        success: false,
        message: 'Usuario o contraseña incorrectos'
      })
    }

    // Verificar que el usuario esté activo
    if (!user.is_active) {
      logger.warn(`⚠️  Intento de login de usuario inactivo: ${loginIdentifier}`)
      return res.status(401).json({
        success: false,
        message: 'Usuario inactivo. Contacta al administrador'
      })
    }

    // Verificar password
    let isValidPassword = verifyPassword(password, user.password_hash)

    // En instalaciones gestionadas, el portal central es la fuente de verdad de
    // la contraseña del dueño: si el admin le asignó una nueva allá, se acepta
    // aquí y se actualiza la copia local (nunca viaja nada en claro al guardar).
    if (!isValidPassword && isLicenseEnforced()) {
      const sync = await verifyOwnerCredentialsWithServer(user.email || user.username, password)

      if (sync.valid && sync.password_hash) {
        await db.run(
          'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [sync.password_hash, user.id]
        )
        isValidPassword = true
        logger.info(`🔄 Contraseña del dueño sincronizada desde el portal central para "${loginIdentifier}"`)
      }
    }

    if (!isValidPassword) {
      logger.warn(`⚠️  Intento de login fallido: contraseña incorrecta para usuario "${loginIdentifier}"`)
      return res.status(401).json({
        success: false,
        message: 'Usuario o contraseña incorrectos'
      })
    }

    // Identidad local correcta. Antes de abrir sesión, validar el permiso
    // comercial contra el servidor central de licencias (si está configurado).
    let licenseState = null
    if (isLicenseEnforced()) {
      licenseState = await verifyLicenseWithServer(user.email || user.username)

      if (!licenseState.allowed) {
        logger.warn(`⚠️  Login bloqueado por licencia (${licenseState.reason}) para "${loginIdentifier}"`)
        return sendLicenseBlocked(res, licenseState)
      }
    }

    // Actualizar fecha de último login
    await db.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    )

    // Generar token JWT
    const token = generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenVersion: user.token_version ?? 0 // (AUTH-003) para revocar al cambiar contraseña
    })

    logger.success(`✅ Login exitoso: ${loginIdentifier}`)

    const [apiTokenMetadata, appId] = await Promise.all([
      getApiTokenMetadataForUser(user.id),
      getExternalApiAppId()
    ])

    res.json({
      success: true,
      message: 'Login exitoso',
      token,
      appId,
      apiTokenMetadata,
      user: serializeAuthUser(user, licenseState)
    })
  } catch (error) {
    logger.error('❌ Error en login:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/local-dev-session
 * Permite a la app local abrir una sesión de prueba sin pedir contraseña.
 * No está disponible en producción ni para requests fuera de localhost.
 */
export async function localDevSession(req, res) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({
        success: false,
        message: 'No disponible'
      })
    }

    if (!isLocalDevAuthRequest(req)) {
      return res.status(403).json({
        success: false,
        message: 'Sesión local no permitida desde este origen'
      })
    }

    const user = await db.get(
      'SELECT * FROM users WHERE is_active = 1 ORDER BY id LIMIT 1'
    )

    if (!user) {
      return res.status(409).json({
        success: false,
        needsSetup: true,
        message: 'No hay usuarios locales activos'
      })
    }

    const token = generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenVersion: user.token_version ?? 0 // (AUTH-003) para revocar al cambiar contraseña
    })

    const [apiTokenMetadata, appId] = await Promise.all([
      getApiTokenMetadataForUser(user.id),
      getExternalApiAppId()
    ])

    logger.info(`Sesión local de desarrollo creada para ${user.username}`)

    res.json({
      success: true,
      message: 'Sesión local iniciada',
      token,
      appId,
      apiTokenMetadata,
      user: serializeAuthUser(user)
    })
  } catch (error) {
    logger.error('Error creando sesión local de desarrollo:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/google/start
 * Abre el OAuth del portal para que Google termine regresando a esta
 * instalación vía SSO (/sso?token=...), sin guardar secretos de Google aquí.
 */
export async function startGoogleLogin(req, res) {
  try {
    if (!isLicenseEnforced()) {
      return res.status(503).json({
        success: false,
        code: 'central_login_not_configured',
        message: 'Google solo está disponible cuando esta instalación está conectada al portal central.'
      })
    }

    const returnPath = sanitizeAuthReturnPath(req.body?.return_path || req.body?.returnPath)
    const data = await createCentralGoogleLoginUrl({ returnPath })
    if (!data.url) {
      return res.status(502).json({
        success: false,
        message: 'El portal central no devolvió una URL válida para Google.'
      })
    }

    res.json({
      success: true,
      ...data
    })
  } catch (error) {
    logger.error('❌ Error iniciando Google Login central:', error)
    res.status(502).json({
      success: false,
      message: error.message || 'No se pudo iniciar sesión con Google.'
    })
  }
}

/**
 * POST /api/auth/verify
 * Verifica si un token JWT es válido
 */
export async function verifyTokenEndpoint(req, res) {
  try {
    const { token } = req.body

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token requerido'
      })
    }

    const payload = verifyToken(token)

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido o expirado'
      })
    }

    // Verificar que el usuario todavía exista y esté activo
    const user = await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, access_config, is_active
       FROM users
       WHERE id = ?`,
      [payload.userId]
    )

    if (!user || !user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no encontrado o inactivo'
      })
    }

    let licenseState = null
    if (isLicenseEnforced()) {
      licenseState = await getLicenseState({ email: user.email || user.username })

      if (!licenseState.allowed) {
        return sendLicenseBlocked(res, licenseState)
      }
    }

    res.json({
      success: true,
      user: serializeAuthUser(user, licenseState)
    })
  } catch (error) {
    logger.error('❌ Error verificando token:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/change-password
 * Cambia la contraseña del usuario autenticado
 */
export async function changePassword(req, res) {
  try {
    const { token, currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Todos los campos son requeridos'
      })
    }

    // (AUTH-005) Política de contraseñas fuerte para la nueva contraseña.
    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) {
      return res.status(400).json({
        success: false,
        message: policyError
      })
    }

    // (AUTH-005) Impedir que la nueva contraseña sea igual a la actual.
    if (newPassword === currentPassword) {
      return res.status(400).json({
        success: false,
        message: 'La nueva contraseña debe ser diferente de la actual'
      })
    }

    const payload = req.user || (token ? verifyToken(token) : null)

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido o expirado'
      })
    }

    // Obtener usuario
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.userId])

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      })
    }

    // Verificar contraseña actual
    const isValidPassword = verifyPassword(currentPassword, user.password_hash)

    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Contraseña actual incorrecta'
      })
    }

    // Hashear nueva contraseña
    const newPasswordHash = hashPassword(newPassword)

    // Actualizar contraseña + (AUTH-003) incrementar token_version para REVOCAR las
    // demás sesiones abiertas: los tokens emitidos antes dejan de ser válidos en requireAuth.
    const newTokenVersion = (user.token_version ?? 0) + 1
    await db.run(
      'UPDATE users SET password_hash = ?, token_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newPasswordHash, newTokenVersion, user.id]
    )

    logger.success(`✅ Contraseña cambiada exitosamente para usuario: ${user.username}`)

    // (AUTH-003) Token nuevo con la versión vigente para que la sesión ACTUAL (la que hizo
    // el cambio) siga válida; las demás quedan revocadas. El frontend debe reemplazar su token.
    const refreshedToken = generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenVersion: newTokenVersion
    })

    res.json({
      success: true,
      message: 'Contraseña cambiada exitosamente',
      token: refreshedToken
    })
  } catch (error) {
    logger.error('❌ Error cambiando contraseña:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * GET /api/auth/me
 * Obtiene la información del usuario autenticado
 */
export async function getMe(req, res) {
  try {
    const payload = req.user

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido o expirado'
      })
    }

    const user = await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, access_config
       FROM users
       WHERE id = ? AND is_active = 1`,
      [payload.userId]
    )

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      })
    }

    res.json({
      success: true,
      user: serializeAuthUser(user, req.license || null)
    })
  } catch (error) {
    logger.error('❌ Error obteniendo usuario:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * GET /api/auth/api-token
 * Devuelve metadatos del API token del usuario autenticado sin exponer el token plano
 */
export async function getApiToken(req, res) {
  try {
    const [metadata, appId] = await Promise.all([
      getApiTokenMetadataForUser(req.user.userId),
      getExternalApiAppId()
    ])

    res.json({
      success: true,
      appId,
      apiToken: metadata
    })
  } catch (error) {
    logger.error('❌ Error obteniendo API token:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/api-token/rotate
 * Genera un nuevo API token. El token plano se muestra una sola vez.
 */
export async function rotateApiToken(req, res) {
  try {
    const { token, metadata } = await rotateApiTokenForUser(req.user.userId)
    const appId = await getExternalApiAppId()

    logger.success(`✅ API token rotado para usuario ID: ${req.user.userId}`)

    res.json({
      success: true,
      message: 'API token generado exitosamente',
      appId,
      apiToken: token,
      apiTokenMetadata: metadata
    })
  } catch (error) {
    logger.error('❌ Error rotando API token:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * DELETE /api/auth/api-token
 * Revoca el API token del usuario autenticado
 */
export async function revokeApiToken(req, res) {
  try {
    const metadata = await revokeApiTokenForUser(req.user.userId)
    const appId = await getExternalApiAppId()

    logger.success(`✅ API token revocado para usuario ID: ${req.user.userId}`)

    res.json({
      success: true,
      message: 'API token revocado exitosamente',
      appId,
      apiToken: metadata
    })
  } catch (error) {
    logger.error('❌ Error revocando API token:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * PATCH /api/auth/profile
 * Actualiza los datos visibles de la cuenta.
 */
export async function updateProfile(req, res) {
  try {
    const payload = req.user

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: 'Token inválido o expirado'
      })
    }

    const firstName = cleanProfileText(req.body.firstName, 80)
    const lastName = cleanProfileText(req.body.lastName, 80)
    const phone = cleanProfileText(req.body.phone, 40)
    const businessName = cleanProfileText(req.body.businessName, 160)
    const fullName = buildFullName(firstName, lastName, req.body.fullName)

    await db.run(
      `UPDATE users
       SET first_name = ?,
           last_name = ?,
           full_name = ?,
           phone = ?,
           business_name = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [firstName || null, lastName || null, fullName || null, phone || null, businessName || null, payload.userId]
    )

    const user = await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, access_config
       FROM users
       WHERE id = ? AND is_active = 1`,
      [payload.userId]
    )

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      })
    }

    res.json({
      success: true,
      message: 'Perfil actualizado',
      user: serializeAuthUser(user, req.license || null)
    })
  } catch (error) {
    logger.error('❌ Error actualizando perfil:', error)
    res.status(500).json({
      success: false,
      error: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/change-username
 * Cambia el nombre de usuario del usuario autenticado
 */
export async function changeUsername(req, res) {
  try {
    const { token, newUsername } = req.body

    if (!newUsername) {
      return res.status(400).json({
        success: false,
        message: 'Nuevo nombre de usuario requerido'
      })
    }

    if (newUsername.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'El nombre de usuario debe tener al menos 3 caracteres'
      })
    }

    const payload = req.user || (token ? verifyToken(token) : null)

    if (!payload) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido o expirado'
      })
    }

    // Verificar que el nuevo username no esté en uso
    const existingUser = await db.get(
      'SELECT id FROM users WHERE username = ? AND id != ?',
      [newUsername, payload.userId]
    )

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Este nombre de usuario ya está en uso'
      })
    }

    // Actualizar username
    await db.run(
      'UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newUsername, payload.userId]
    )

    logger.success(`✅ Username actualizado a "${newUsername}" para usuario ID: ${payload.userId}`)

    res.json({
      success: true,
      message: 'Nombre de usuario actualizado exitosamente'
    })
  } catch (error) {
    logger.error('❌ Error cambiando username:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/sso
 * Entrada directa desde el portal central: el portal genera un token de un
 * solo uso y el usuario queda autenticado aquí sin volver a escribir su
 * contraseña. Si la app aún no tiene usuarios, se redirige al setup con el
 * mismo token (sin consumirlo).
 */
export async function ssoLogin(req, res) {
  try {
    const { token } = req.body

    if (!token) {
      return res.status(400).json({ success: false, message: 'Falta el enlace de acceso' })
    }

    if (!isLicenseEnforced()) {
      return res.status(404).json({ success: false, message: 'No disponible' })
    }

    // Primero verificar sin consumir: si la app no tiene usuarios todavía,
    // el mismo token sirve para el setup inicial.
    const peeked = await verifySetupToken(token)

    if (!peeked.valid || !peeked.email) {
      return res.status(403).json({
        success: false,
        message: peeked.message || 'El enlace de acceso no es válido o ya fue usado. Inicia sesión con tu correo y contraseña.'
      })
    }

    const user = await db.get(
      'SELECT * FROM users WHERE email = ? OR username = ?',
      [peeked.email, peeked.email]
    )

    if (!user) {
      return res.status(409).json({ success: false, code: 'needs_setup' })
    }

    // Usuario existente: consumir el token (un solo uso) y abrir sesión
    const consumed = await consumeSetupToken(token)
    if (!consumed.valid) {
      return res.status(403).json({ success: false, message: 'El enlace de acceso ya fue usado. Inicia sesión con tu correo y contraseña.' })
    }

    const license = await verifyLicenseWithServer(user.email || user.username)
    if (!license.allowed) {
      return sendLicenseBlocked(res, license, 'Tu licencia de Ristak no está activa.')
    }

    await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id])

    const sessionToken = generateToken({
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenVersion: user.token_version ?? 0 // (AUTH-003)
    })

    const [apiTokenMetadata, appId] = await Promise.all([
      getApiTokenMetadataForUser(user.id),
      getExternalApiAppId()
    ])

    logger.success(`✅ Acceso directo desde el portal: ${user.username}`)

    res.json({
      success: true,
      token: sessionToken,
      appId,
      apiTokenMetadata,
      user: serializeAuthUser(user, license)
    })
  } catch (error) {
    logger.error('❌ Error en acceso directo (sso):', error)
    res.status(500).json({ success: false, message: 'Error en el servidor' })
  }
}

/**
 * GET /api/auth/setup
 * Verifica si ya existen usuarios. Si no, permite crear el primer usuario.
 */
export async function checkSetup(req, res) {
  try {
    const existingUser = await db.get('SELECT id FROM users LIMIT 1')

    res.json({
      success: true,
      needsSetup: !existingUser,
      // En instalaciones gestionadas por el portal central, el setup inicial
      // requiere el enlace con token de un solo uso que genera el instalador.
      requiresToken: isLicenseEnforced()
    })
  } catch (error) {
    logger.error('❌ Error verificando setup:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * GET /api/auth/setup-info?token=...
 * Valida el setup token contra el servidor central (sin consumirlo)
 * y devuelve el email del dueño para precargarlo en la pantalla de setup.
 */
export async function setupInfo(req, res) {
  try {
    const token = String(req.query.token || '')

    if (!isLicenseEnforced()) {
      return res.json({ success: true, requiresToken: false })
    }

    if (!token) {
      return res.status(400).json({ success: false, message: 'Falta el enlace de configuración' })
    }

    const result = await verifySetupToken(token)

    if (!result.valid) {
      return res.status(403).json({
        success: false,
        message: result.message || 'El enlace de configuración no es válido o ya expiró.'
      })
    }

    res.json({
      success: true,
      requiresToken: true,
      email: result.email || process.env.OWNER_EMAIL || ''
    })
  } catch (error) {
    logger.error('❌ Error verificando setup token:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}

/**
 * POST /api/auth/setup
 * Crea el primer usuario. Solo funciona si NO existen usuarios previos.
 */
export async function setup(req, res) {
  try {
    const { password, token } = req.body
    let { username } = req.body
    let ownerEmail = ''
    let ownerPasswordHash = null

    // En instalaciones gestionadas, el setup requiere el token de un solo uso
    // generado por el portal central. El email del dueño viene del servidor central.
    // Aquí solo se verifica (peek); se consume hasta que todas las validaciones pasen,
    // para no quemar el token con una contraseña inválida.
    if (isLicenseEnforced()) {
      if (!token) {
        return res.status(403).json({
          success: false,
          message: 'Necesitas el enlace de configuración que te dio el instalador para crear tu acceso.'
        })
      }

      const tokenResult = await verifySetupToken(token)

      if (!tokenResult.valid) {
        return res.status(403).json({
          success: false,
          message: tokenResult.message || 'El enlace de configuración no es válido o ya fue usado.'
        })
      }

      ownerEmail = tokenResult.email || process.env.OWNER_EMAIL || ''
      if (!username) {
        username = ownerEmail
      }

      // Modo automático: el portal central comparte el hash de la contraseña del
      // cliente (mismo formato PBKDF2), así el dueño entra con las MISMAS
      // credenciales que usó en el instalador, sin crear otra contraseña.
      if (!password && tokenResult.password_hash) {
        ownerPasswordHash = tokenResult.password_hash
      }

      if (!password && !ownerPasswordHash) {
        return res.status(400).json({
          success: false,
          code: 'password_required',
          message: 'Crea una contraseña para tu cuenta.'
        })
      }
    }

    // Validación de entrada
    if (!username || (!password && !ownerPasswordHash)) {
      return res.status(400).json({
        success: false,
        message: 'Usuario y contraseña son requeridos'
      })
    }

    if (username.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'El usuario debe tener al menos 3 caracteres'
      })
    }

    // (AUTH-005) Política de contraseñas fuerte. En modo gestionado con hash del
    // portal central (ownerPasswordHash) no hay password en claro que validar.
    if (!ownerPasswordHash) {
      const policyError = validatePasswordPolicy(password)
      if (policyError) {
        return res.status(400).json({
          success: false,
          message: policyError
        })
      }
    }

    // CRÍTICO: Verificar que NO existan usuarios previos
    const existingUser = await db.get('SELECT id FROM users LIMIT 1')

    if (existingUser) {
      logger.warn(`⚠️  Intento no autorizado de crear usuario cuando ya existen usuarios`)
      return res.status(403).json({
        success: false,
        message: 'Ya existen usuarios registrados. No se puede crear más usuarios desde esta ruta.'
      })
    }

    // Todas las validaciones pasaron: consumir el token de un solo uso
    if (isLicenseEnforced()) {
      const consumed = await consumeSetupToken(token)

      if (!consumed.valid) {
        return res.status(403).json({
          success: false,
          message: consumed.message || 'El enlace de configuración no es válido o ya fue usado.'
        })
      }
    }

    // Verificar que el username no esté en uso
    const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', [username])

    if (usernameTaken) {
      return res.status(400).json({
        success: false,
        message: 'Este nombre de usuario ya está en uso'
      })
    }

    // Crear el primer usuario. En modo automático se reutiliza el hash del
    // portal central (mismas credenciales); si no, se hashea la contraseña nueva.
    const { hashPassword, generateToken } = await import('../utils/auth.js')
    const passwordHash = ownerPasswordHash || hashPassword(password)

    // (AUTH-006) Insert atómico anti-TOCTOU: la fila solo se crea si AÚN no hay
    // usuarios. Dos POST /setup concurrentes podían pasar ambos el peek previo
    // ("SELECT id FROM users LIMIT 1") antes de insertar; este WHERE NOT EXISTS
    // garantiza que solo el primero gane la carrera (changes > 0).
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
      [username, ownerEmail || null, passwordHash, username, 'admin', 1]
    )

    // (AUTH-006) Si no insertó ninguna fila, otra request creó el primer usuario
    // en paralelo: rechazar en vez de continuar con estado inconsistente.
    if (Number(result?.changes || 0) === 0) {
      logger.warn('⚠️  Setup concurrente detectado: el primer usuario ya fue creado por otra request')
      return res.status(409).json({
        success: false,
        code: 'setup_already_completed',
        message: 'Ya existe un usuario registrado. Inicia sesión con tu correo y contraseña.'
      })
    }

    let userId = result.lastID
    if (!userId) {
      const createdUser = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = createdUser?.id
    }

    if (!userId) {
      throw new Error('No se pudo resolver el ID del usuario creado')
    }

    try {
      const locale = await saveAccountLocaleSettings(req.body.accountLocale || {})
      logger.info(`🌎 Locale inicial guardado: país ${locale.countryCode}, moneda ${locale.currency}, lada +${locale.dialCode}`)
    } catch (localeError) {
      logger.warn(`No se pudo guardar país/moneda/lada inicial: ${localeError.message}`)
    }

    const [{ token: apiToken, metadata: apiTokenMetadata }, appId] = await Promise.all([
      rotateApiTokenForUser(userId),
      getExternalApiAppId()
    ])

    // Validar la licencia contra el servidor central antes de abrir la sesión
    let licenseState = null
    if (isLicenseEnforced()) {
      licenseState = await verifyLicenseWithServer(ownerEmail || username)

      if (!licenseState.allowed) {
        return sendLicenseBlocked(res, licenseState)
      }
    }

    // Generar token JWT
    const sessionToken = generateToken({
      userId,
      username,
      email: ownerEmail || '',
      role: 'admin',
      tokenVersion: 0 // (AUTH-003) usuario recién creado
    })

    logger.success(`✅ Primer usuario creado: ${username}`)

    res.json({
      success: true,
      message: 'Usuario creado exitosamente',
      token: sessionToken,
      appId,
      apiToken,
      apiTokenMetadata,
      user: serializeAuthUser({
        id: userId,
        username,
        email: ownerEmail || '',
        full_name: username,
        role: 'admin'
      }, licenseState)
    })
  } catch (error) {
    logger.error('❌ Error en setup:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}
