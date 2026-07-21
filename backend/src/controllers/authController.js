import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generatePersistentSupportToken,
  verifyToken,
  validatePasswordPolicy
} from '../utils/auth.js'
import { sendEmail } from '../services/emailService.js'
import {
  getExternalApiAppId,
  getApiTokenMetadataForUser,
  revokeApiTokenForUser,
  rotateApiTokenForUser
} from '../utils/apiTokens.js'
import {
  getLicenseState,
  isLicenseEnforced,
  isManagedOwnerEmail,
  verifyLicenseWithServer,
  verifyOwnerCredentialsWithServer,
  verifySetupToken,
  consumeSetupToken,
  claimCentralOAuthHandoff,
  createCentralGoogleLoginUrl,
  requestPortalUserRefresh
} from '../services/licenseService.js'
import { saveAccountLocaleSettings } from '../utils/accountLocale.js'
import { getEffectiveAccessConfig } from '../utils/userAccess.js'
import { getRequestBaseUrl } from '../utils/publicUrl.js'

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
    licenseFeaturesSourceValid: licenseState?.featuresSourceValid !== false,
    licenseFeatures: licenseState?.features && typeof licenseState.features === 'object'
      ? licenseState.features
      : {},
    licenseLimits: licenseState?.limits && typeof licenseState.limits === 'object'
      ? licenseState.limits
      : {},
    licenseExternalModules: licenseState?.externalModules && typeof licenseState.externalModules === 'object'
      ? licenseState.externalModules
      : {}
  }
}

function cleanLoginIdentifier(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
}

function cleanLoginEmail(value) {
  return cleanLoginIdentifier(value).toLowerCase()
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())
}

async function findUserByLoginEmail(loginEmail) {
  const user = await db.get(
    'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(?)',
    [loginEmail]
  )

  if (user) return user

  const legacyUser = await db.get(
    `SELECT *
     FROM users
     WHERE (email IS NULL OR TRIM(email) = '')
       AND LOWER(TRIM(username)) = LOWER(?)
     LIMIT 1`,
    [loginEmail]
  )

  if (!legacyUser) return null

  const conflict = await db.get(
    'SELECT id FROM users WHERE id != ? AND LOWER(TRIM(email)) = LOWER(?) LIMIT 1',
    [legacyUser.id, loginEmail]
  )

  if (conflict) return null

  await db.run(
    `UPDATE users
     SET email = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND (email IS NULL OR TRIM(email) = '')`,
    [loginEmail, legacyUser.id]
  )

  logger.info(`🔄 Email de acceso recuperado desde username legacy para usuario ${legacyUser.id}`)
  return { ...legacyUser, email: loginEmail }
}

function buildDefaultInternalUsername(email) {
  const localPart = String(email || '').split('@')[0] || ''
  const normalized = localPart
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 60)

  return normalized.length >= 3 ? normalized : 'admin'
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
    const { password } = req.body
    const loginEmail = cleanLoginEmail(req.body?.email || req.body?.username)

    if (!loginEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Correo y contraseña son requeridos'
      })
    }

    if (!isValidEmailAddress(loginEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Ingresa un correo válido'
      })
    }

    // El correo es la única credencial de login. El username solo se usa como
    // puente de migración cuando una instalación vieja guardó el correo ahí.
    let user = await findUserByLoginEmail(loginEmail)
    let credentialsValidatedByPortal = false
    let bootstrapLicenseState = null
    let bootstrapApiToken = null

    if (!user) {
      // Una instalación gestionada recién creada todavía no tiene usuarios
      // locales. En ese único estado, las credenciales vigentes del dueño en el
      // Installer crean la primera cuenta sin depender del enlace de setup.
      // `support_access` nunca sirve para este bootstrap: la contraseña global
      // del administrador no debe crear ni persistir una identidad de cliente.
      if (isLicenseEnforced()) {
        const existingUser = await db.get('SELECT id FROM users LIMIT 1')

        if (!existingUser) {
          const sync = await verifyOwnerCredentialsWithServer(loginEmail, password)

          if (sync.valid && sync.support_access !== true && sync.password_hash) {
            if (!verifyPassword(password, sync.password_hash)) {
              throw new Error('El Installer devolvió un hash de dueño que no coincide con las credenciales validadas')
            }

            bootstrapLicenseState = await verifyLicenseWithServer(loginEmail)

            if (!bootstrapLicenseState.allowed) {
              logger.warn(`⚠️  Primer acceso bloqueado por licencia (${bootstrapLicenseState.reason}) para "${loginEmail}"`)
              return sendLicenseBlocked(res, bootstrapLicenseState)
            }

            const username = buildDefaultInternalUsername(loginEmail)
            const result = await db.run(
              `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
               SELECT ?, ?, ?, ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM users)`,
              [username, loginEmail, sync.password_hash, username, 'admin', 1]
            )

            if (Number(result?.changes || 0) > 0) {
              user = result.lastID
                ? await db.get('SELECT * FROM users WHERE id = ?', [result.lastID])
                : await findUserByLoginEmail(loginEmail)

              if (!user?.id) {
                throw new Error('No se pudo resolver el usuario creado durante el primer acceso')
              }

              const rotatedApiToken = await rotateApiTokenForUser(user.id)
              bootstrapApiToken = rotatedApiToken.token
              credentialsValidatedByPortal = true
              void requestPortalUserRefresh()
              logger.success(`✅ Primer acceso creado desde las credenciales del Installer: ${loginEmail}`)
            } else {
              // Otra petición ganó la carrera. Solo continuamos si creó al mismo
              // dueño que el portal acaba de validar.
              user = await findUserByLoginEmail(loginEmail)
              credentialsValidatedByPortal = Boolean(user)
            }
          }
        }
      }

      if (user && credentialsValidatedByPortal && !verifyPassword(password, user.password_hash)) {
        throw new Error('El hash entregado por el Installer no coincide con las credenciales validadas')
      }
    }

    if (!user) {
      logger.warn(`⚠️  Intento de login fallido: correo "${loginEmail}" no encontrado`)
      return res.status(401).json({
        success: false,
        message: 'Correo o contraseña incorrectos'
      })
    }

    // Verificar que el usuario esté activo
    if (!user.is_active) {
      logger.warn(`⚠️  Intento de login de usuario inactivo: ${loginEmail}`)
      return res.status(401).json({
        success: false,
        message: 'Usuario inactivo. Contacta al administrador'
      })
    }

    // Verificar password
    let isValidPassword = credentialsValidatedByPortal || verifyPassword(password, user.password_hash)
    let supportAccess = false

    // En instalaciones gestionadas, el portal central resuelve dos casos sin
    // compartir secretos: sincroniza la contraseña vigente del dueño o confirma
    // la contraseña del admin principal como acceso global de soporte.
    const shouldCheckCentralCredentials = isLicenseEnforced()
      && !credentialsValidatedByPortal
      && (!isValidPassword || isManagedOwnerEmail(user.email))

    if (shouldCheckCentralCredentials) {
      const sync = await verifyOwnerCredentialsWithServer(user.email, password)

      if (sync.valid && sync.support_access === true) {
        isValidPassword = true
        supportAccess = true
        logger.info(`Acceso global de soporte validado por el Installer para "${loginEmail}"`)
      } else if (!isValidPassword && sync.valid && sync.password_hash) {
        await db.run(
          'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [sync.password_hash, user.id]
        )
        isValidPassword = true
        logger.info(`🔄 Contraseña del dueño sincronizada desde el portal central para "${loginEmail}"`)
      }
    }

    if (!isValidPassword) {
      logger.warn(`⚠️  Intento de login fallido: contraseña incorrecta para correo "${loginEmail}"`)
      return res.status(401).json({
        success: false,
        message: 'Correo o contraseña incorrectos'
      })
    }

    // Identidad local correcta. Antes de abrir sesión, validar el permiso
    // comercial contra el servidor central de licencias (si está configurado).
    let licenseState = null
    if (isLicenseEnforced()) {
      licenseState = bootstrapLicenseState || await verifyLicenseWithServer(user.email)

      if (!licenseState.allowed) {
        logger.warn(`⚠️  Login bloqueado por licencia (${licenseState.reason}) para "${loginEmail}"`)
        return sendLicenseBlocked(res, licenseState)
      }
    }

    // Actualizar fecha de último login
    await db.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    )

    // Generar token JWT
    const tokenPayload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      tokenVersion: user.token_version ?? 0 // (AUTH-003) para revocar al cambiar contraseña
    }
    const token = supportAccess
      ? generatePersistentSupportToken(tokenPayload)
      : generateToken(tokenPayload)

    logger.success(supportAccess
      ? `✅ Login global de soporte exitoso: ${loginEmail}`
      : `✅ Login exitoso: ${loginEmail}`)

    const [apiTokenMetadata, appId] = await Promise.all([
      getApiTokenMetadataForUser(user.id),
      getExternalApiAppId()
    ])

    res.json({
      success: true,
      message: 'Login exitoso',
      token,
      supportAccess,
      appId,
      apiToken: bootstrapApiToken || undefined,
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
    const returnPath = sanitizeAuthReturnPath(req.body?.return_path || req.body?.returnPath)
    const appUrl = getRequestBaseUrl(req) || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || ''
    const callback = new URL('/sso', `${appUrl}/`)
    callback.searchParams.set('return_path', returnPath)
    const data = await createCentralGoogleLoginUrl({
      returnPath: callback.toString(),
      appUrl
    })
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
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, access_config, is_active, token_version
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

    // Las sesiones normales se revocan con token_version. La sesión global de
    // soporte es deliberadamente persistente y no depende de la contraseña del
    // cliente, así que un cambio de esa contraseña no debe expulsar al soporte.
    if (payload.supportAccess !== true && (payload.tokenVersion ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({
        success: false,
        message: 'Token revocado. Inicia sesión de nuevo.'
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

// (AUTH-010) Base pública de la app para armar el enlace de reset.
function resolveAppBaseUrl(req) {
  const fromEnv = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '')
  if (fromEnv) return fromEnv
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  const host = req.get('x-forwarded-host') || req.get('host')
  return host ? `${proto}://${host}` : ''
}

/**
 * POST /api/auth/forgot-password
 * (AUTH-010) Inicia la recuperación por correo. Anti-enumeración: SIEMPRE responde igual
 * (no revela si el correo existe). Si existe, genera un token de un solo uso (se guarda
 * solo su hash) y envía un enlace con expiración de 1 hora.
 */
export async function forgotPassword(req, res) {
  const genericOk = () => res.json({
    success: true,
    message: 'Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.'
  })
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return genericOk()

    const user = await db.get('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?) AND is_active = 1', [email])
    if (!user?.id || !user.email) return genericOk()

    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const id = crypto.randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hora

    // (cross-DB) user_id es TEXT y users.id es INTEGER: guardamos String(user.id) para
    // que Postgres no rechace un integer en columna TEXT.
    const userIdText = String(user.id)
    // Invalida tokens previos sin usar del mismo usuario (solo uno activo a la vez).
    await db.run('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL', [userIdText])
    await db.run(
      'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
      [id, userIdText, tokenHash, expiresAt]
    )

    const baseUrl = resolveAppBaseUrl(req)
    const resetUrl = `${baseUrl}/reset-password?token=${rawToken}`
    const subject = 'Restablece tu contraseña de Ristak'
    const text = `Recibimos una solicitud para restablecer tu contraseña.\n\nAbre este enlace para crear una nueva (vence en 1 hora):\n${resetUrl}\n\nSi no fuiste tú, ignora este correo: tu contraseña no cambiará.`
    const html = `<p>Recibimos una solicitud para restablecer tu contraseña.</p>
<p><a href="${resetUrl}">Crear una nueva contraseña</a> (el enlace vence en 1 hora).</p>
<p>Si no fuiste tú, ignora este correo: tu contraseña no cambiará.</p>`
    try {
      await sendEmail({ to: user.email, subject, text, html, includeSignature: false })
    } catch (error) {
      logger.warn(`[AUTH-010] No se pudo enviar el correo de recuperación a ${user.email}: ${error.message}`)
    }
    return genericOk()
  } catch (error) {
    logger.error(`[AUTH-010] Error en forgotPassword: ${error.message}`)
    return genericOk()
  }
}

/**
 * POST /api/auth/reset-password
 * (AUTH-010) Completa la recuperación: valida el token (hash, vigente, sin usar), aplica
 * la política de contraseña, actualiza el hash, INCREMENTA token_version (revoca todas
 * las sesiones, AUTH-003) y marca el token como usado.
 */
export async function resetPassword(req, res) {
  try {
    const rawToken = String(req.body?.token || '').trim()
    const newPassword = String(req.body?.newPassword ?? req.body?.password ?? '')
    if (!rawToken) {
      return res.status(400).json({ success: false, error: 'Falta el token de recuperación.' })
    }
    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) {
      return res.status(400).json({ success: false, error: policyError })
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const row = await db.get(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
      [tokenHash]
    )
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: 'El enlace es inválido o ya expiró. Solicita uno nuevo.' })
    }

    // (cross-DB) row.user_id viene como TEXT; users.id es INTEGER. Convertimos a número
    // para que la comparación funcione en Postgres (y en SQLite).
    const userIdNum = Number(row.user_id)
    const user = Number.isFinite(userIdNum)
      ? await db.get('SELECT id, token_version FROM users WHERE id = ? AND is_active = 1', [userIdNum])
      : null
    if (!user?.id) {
      return res.status(400).json({ success: false, error: 'El enlace es inválido.' })
    }

    const newHash = hashPassword(newPassword)
    const newTokenVersion = (user.token_version ?? 0) + 1
    await db.run(
      'UPDATE users SET password_hash = ?, token_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newHash, newTokenVersion, user.id]
    )
    await db.run('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id])
    logger.success(`[AUTH-010] Contraseña restablecida por enlace para el usuario ${user.id}`)

    return res.json({ success: true, message: 'Tu contraseña se actualizó. Ya puedes iniciar sesión.' })
  } catch (error) {
    logger.error(`[AUTH-010] Error en resetPassword: ${error.message}`)
    return res.status(500).json({ success: false, error: 'No se pudo restablecer la contraseña. Intenta de nuevo.' })
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

    const currentUser = await db.get(
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, access_config
       FROM users
       WHERE id = ? AND is_active = 1`,
      [payload.userId]
    )

    if (!currentUser) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      })
    }

    const body = req.body || {}
    const hasField = (key) => Object.prototype.hasOwnProperty.call(body, key)
    const firstName = hasField('firstName') ? cleanProfileText(body.firstName, 80) : cleanProfileText(currentUser.first_name, 80)
    const lastName = hasField('lastName') ? cleanProfileText(body.lastName, 80) : cleanProfileText(currentUser.last_name, 80)
    const phone = hasField('phone') ? cleanProfileText(body.phone, 40) : cleanProfileText(currentUser.phone, 40)
    const businessName = hasField('businessName') ? cleanProfileText(body.businessName, 160) : cleanProfileText(currentUser.business_name, 160)
    const fullName = buildFullName(firstName, lastName, body.fullName)

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
 * contraseña. Si la app aún no tiene usuarios, crea al dueño desde la
 * identidad que el Installer ya verificó y abre la sesión en el mismo paso.
 */
export async function ssoLogin(req, res) {
  try {
    const { token, google_handoff_token: googleHandoffToken } = req.body

    if (googleHandoffToken) {
      const handoff = await claimCentralOAuthHandoff({
        provider: 'google_login',
        handoffToken: googleHandoffToken
      })
      const profile = handoff?.payload?.profile || {}
      const googleEmail = cleanLoginEmail(profile.email)
      if (!googleEmail || profile.email_verified !== true) {
        return res.status(403).json({
          success: false,
          message: 'Google no confirmó un correo válido para esta cuenta.'
        })
      }

      let user = await findUserByLoginEmail(googleEmail)
      let apiToken = null
      if (!user) {
        const existingUser = await db.get('SELECT id FROM users LIMIT 1')
        if (existingUser) {
          return res.status(403).json({
            success: false,
            message: 'Esta cuenta de Google no pertenece a un usuario de esta app.'
          })
        }

        const username = buildDefaultInternalUsername(googleEmail)
        const passwordHash = hashPassword(crypto.randomBytes(32).toString('base64url'))
        const result = await db.run(
          `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM users)`,
          [username, googleEmail, passwordHash, profile.name || username, 'admin', 1]
        )
        user = Number(result?.changes || 0) > 0 && result.lastID
          ? await db.get('SELECT * FROM users WHERE id = ?', [result.lastID])
          : await findUserByLoginEmail(googleEmail)
        if (!user?.id) {
          return res.status(409).json({
            success: false,
            message: 'La cuenta terminó de configurarse en otra sesión. Vuelve a entrar con Google.'
          })
        }

        const rotatedApiToken = await rotateApiTokenForUser(user.id)
        apiToken = rotatedApiToken.token
        await saveAccountLocaleSettings({}).catch(error => {
          logger.warn(`No se pudo guardar el locale inicial durante Google: ${error.message}`)
        })
        void requestPortalUserRefresh()
      }

      if (!user.is_active) {
        return res.status(403).json({ success: false, message: 'Usuario inactivo. Contacta al administrador.' })
      }

      await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id])
      const sessionToken = generateToken({
        userId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        tokenVersion: user.token_version ?? 0
      })
      const [apiTokenMetadata, appId] = await Promise.all([
        getApiTokenMetadataForUser(user.id),
        getExternalApiAppId()
      ])
      return res.json({
        success: true,
        token: sessionToken,
        appId,
        ...(apiToken ? { apiToken } : {}),
        apiTokenMetadata,
        user: serializeAuthUser(user)
      })
    }

    if (!token) {
      return res.status(400).json({ success: false, message: 'Falta el enlace de acceso' })
    }

    if (!isLicenseEnforced()) {
      return res.status(404).json({ success: false, message: 'No disponible' })
    }

    // Primero verificar sin consumir para no quemar un enlace inválido.
    const peeked = await verifySetupToken(token)

    if (!peeked.valid || !peeked.email) {
      return res.status(403).json({
        success: false,
        message: peeked.message || 'El enlace de acceso no es válido o ya fue usado. Inicia sesión con tu correo y contraseña.'
      })
    }

    const ownerEmail = cleanLoginEmail(peeked.email)
    let user = await findUserByLoginEmail(ownerEmail)
    let apiToken = null
    let license = null

    if (!user) {
      const existingUser = await db.get('SELECT id FROM users LIMIT 1')
      if (existingUser) {
        return res.status(403).json({
          success: false,
          message: 'Este acceso no corresponde a un usuario de esta app.'
        })
      }

      // El SSO del Installer ya confirmó la identidad del dueño. En la primera
      // entrada creamos su usuario local sin pedir otra contraseña. Si el portal
      // tiene contraseña reutilizamos su hash; si la cuenta es solo Google
      // guardamos una credencial aleatoria imposible de conocer.
      license = await verifyLicenseWithServer(ownerEmail)
      if (!license.allowed) {
        return sendLicenseBlocked(res, license, 'Tu licencia de Ristak no está activa.')
      }

      const consumed = await consumeSetupToken(token)
      if (!consumed.valid) {
        return res.status(403).json({ success: false, message: 'El enlace de acceso ya fue usado. Vuelve a entrar con Google.' })
      }

      const username = buildDefaultInternalUsername(ownerEmail)
      const passwordHash = peeked.password_hash || hashPassword(crypto.randomBytes(32).toString('base64url'))
      const result = await db.run(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
        [username, ownerEmail, passwordHash, username, 'admin', 1]
      )
      const ownerCreated = Number(result?.changes || 0) > 0

      user = ownerCreated && result.lastID
        ? await db.get('SELECT * FROM users WHERE id = ?', [result.lastID])
        : await findUserByLoginEmail(ownerEmail)

      if (!user?.id) {
        return res.status(409).json({
          success: false,
          message: 'La cuenta terminó de configurarse en otra sesión. Vuelve a entrar con Google.'
        })
      }

      if (ownerCreated) {
        const rotatedApiToken = await rotateApiTokenForUser(user.id)
        apiToken = rotatedApiToken.token
        try {
          await saveAccountLocaleSettings({})
        } catch (localeError) {
          logger.warn(`No se pudo guardar el locale inicial durante SSO: ${localeError.message}`)
        }
        void requestPortalUserRefresh()
        logger.success(`✅ Primer usuario creado desde acceso seguro del Installer: ${ownerEmail}`)
      }
    } else {
      // Usuario existente: consumir el token (un solo uso) y abrir sesión.
      const consumed = await consumeSetupToken(token)
      if (!consumed.valid) {
        return res.status(403).json({ success: false, message: 'El enlace de acceso ya fue usado. Inicia sesión con tu correo y contraseña.' })
      }
      license = await verifyLicenseWithServer(user.email || user.username)
    }

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
      ...(apiToken ? { apiToken } : {}),
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
      return res.status(400).json({
        success: false,
        code: 'setup_token_missing',
        message: 'Falta el enlace de configuración'
      })
    }

    const result = await verifySetupToken(token)

    if (!result.valid) {
      return res.status(result.retryable ? 503 : 403).json({
        success: false,
        code: result.retryable ? 'setup_temporarily_unavailable' : 'setup_token_invalid',
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
    let loginEmail = cleanLoginEmail(req.body?.email || req.body?.username)
    let username = cleanLoginIdentifier(req.body?.internalUsername)
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
          code: 'setup_token_missing',
          message: 'Necesitas el enlace de configuración que te dio el instalador para crear tu acceso.'
        })
      }

      const tokenResult = await verifySetupToken(token)

      if (!tokenResult.valid) {
        return res.status(tokenResult.retryable ? 503 : 403).json({
          success: false,
          code: tokenResult.retryable ? 'setup_temporarily_unavailable' : 'setup_token_invalid',
          message: tokenResult.message || 'El enlace de configuración no es válido o ya fue usado.'
        })
      }

      ownerEmail = cleanLoginEmail(tokenResult.email || process.env.OWNER_EMAIL || '')
      loginEmail = ownerEmail || loginEmail

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
          message: 'Tu acceso del Installer todavía no tiene una contraseña lista. Recupera tu acceso central y abre un enlace nuevo.'
        })
      }
    }

    // Validación de entrada
    if (!loginEmail || (!password && !ownerPasswordHash)) {
      return res.status(400).json({
        success: false,
        message: 'Correo y contraseña son requeridos'
      })
    }

    if (!isValidEmailAddress(loginEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Ingresa un correo válido'
      })
    }

    ownerEmail = ownerEmail || loginEmail
    username = username || buildDefaultInternalUsername(ownerEmail)

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
        return res.status(consumed.retryable ? 503 : 403).json({
          success: false,
          code: consumed.retryable ? 'setup_temporarily_unavailable' : 'setup_token_invalid',
          message: consumed.message || 'El enlace de configuración no es válido o ya fue usado.'
        })
      }
    }

    // Verificar que el identificador interno no esté en uso
    const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', [username])

    if (usernameTaken) {
      return res.status(400).json({
        success: false,
        message: 'Este identificador interno ya está en uso'
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
      [username, ownerEmail, passwordHash, username, 'admin', 1]
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

    let createdUser = null
    let userId = result.lastID
    if (userId) {
      createdUser = await db.get('SELECT * FROM users WHERE id = ?', [userId])
    }
    if (!createdUser) {
      createdUser = await db.get('SELECT * FROM users WHERE username = ?', [username])
      userId = createdUser?.id
    }

    if (!createdUser?.id) {
      throw new Error('No se pudo resolver el usuario creado')
    }

    if (!createdUser.password_hash) {
      throw new Error('La contraseña no quedó guardada en la base de datos')
    }

    if (ownerPasswordHash) {
      if (createdUser.password_hash !== ownerPasswordHash) {
        throw new Error('La contraseña compartida por el portal no quedó guardada correctamente')
      }
    } else if (!verifyPassword(password, createdUser.password_hash)) {
      throw new Error('La contraseña creada no coincide con el hash guardado')
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
      licenseState = await verifyLicenseWithServer(ownerEmail)

      if (!licenseState.allowed) {
        return sendLicenseBlocked(res, licenseState)
      }
    }

    await db.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [userId]
    )

    // Generar token JWT
    const sessionToken = generateToken({
      userId,
      username: createdUser.username,
      email: ownerEmail,
      role: createdUser.role || 'admin',
      tokenVersion: createdUser.token_version ?? 0 // (AUTH-003)
    })

    logger.success(`✅ Primer usuario creado: ${createdUser.username}`)

    res.json({
      success: true,
      message: 'Usuario creado exitosamente',
      token: sessionToken,
      appId,
      apiToken,
      apiTokenMetadata,
      user: serializeAuthUser(createdUser, licenseState)
    })
  } catch (error) {
    logger.error('❌ Error en setup:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}
