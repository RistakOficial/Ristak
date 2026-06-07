import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { hashPassword, verifyPassword, generateToken, verifyToken } from '../utils/auth.js'
import {
  getExternalApiAppId,
  getApiTokenMetadataForUser,
  revokeApiTokenForUser,
  rotateApiTokenForUser
} from '../utils/apiTokens.js'

function cleanProfileText(value, maxLength = 160) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

function buildFullName(firstName, lastName, fallback = '') {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || cleanProfileText(fallback)
}

function serializeAuthUser(user) {
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
    role: user.role
  }
}

/**
 * POST /api/auth/login
 * Autentica un usuario y devuelve un token JWT
 */
export async function login(req, res) {
  try {
    const { username, password } = req.body

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Usuario y contraseña son requeridos'
      })
    }

    // Buscar usuario por username o email
    const user = await db.get(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    )

    if (!user) {
      logger.warn(`⚠️  Intento de login fallido: usuario "${username}" no encontrado`)
      return res.status(401).json({
        success: false,
        message: 'Usuario o contraseña incorrectos'
      })
    }

    // Verificar que el usuario esté activo
    if (!user.is_active) {
      logger.warn(`⚠️  Intento de login de usuario inactivo: ${username}`)
      return res.status(401).json({
        success: false,
        message: 'Usuario inactivo. Contacta al administrador'
      })
    }

    // Verificar password
    const isValidPassword = verifyPassword(password, user.password_hash)

    if (!isValidPassword) {
      logger.warn(`⚠️  Intento de login fallido: contraseña incorrecta para usuario "${username}"`)
      return res.status(401).json({
        success: false,
        message: 'Usuario o contraseña incorrectos'
      })
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
      role: user.role
    })

    logger.success(`✅ Login exitoso: ${username}`)

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
      user: serializeAuthUser(user)
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
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role, is_active
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

    res.json({
      success: true,
      user: serializeAuthUser(user)
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

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La nueva contraseña debe tener al menos 6 caracteres'
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

    // Actualizar contraseña
    await db.run(
      'UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newPasswordHash, user.id]
    )

    logger.success(`✅ Contraseña cambiada exitosamente para usuario: ${user.username}`)

    res.json({
      success: true,
      message: 'Contraseña cambiada exitosamente'
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
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role
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
      user: serializeAuthUser(user)
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
      `SELECT id, username, email, first_name, last_name, full_name, phone, business_name, role
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
      user: serializeAuthUser(user)
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
 * GET /api/auth/setup
 * Verifica si ya existen usuarios. Si no, permite crear el primer usuario.
 */
export async function checkSetup(req, res) {
  try {
    const existingUser = await db.get('SELECT id FROM users LIMIT 1')

    res.json({
      success: true,
      needsSetup: !existingUser
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
 * POST /api/auth/setup
 * Crea el primer usuario. Solo funciona si NO existen usuarios previos.
 */
export async function setup(req, res) {
  try {
    const { username, password } = req.body

    // Validación de entrada
    if (!username || !password) {
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

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'La contraseña debe tener al menos 6 caracteres'
      })
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

    // Verificar que el username no esté en uso
    const usernameTaken = await db.get('SELECT id FROM users WHERE username = ?', [username])

    if (usernameTaken) {
      return res.status(400).json({
        success: false,
        message: 'Este nombre de usuario ya está en uso'
      })
    }

    // Crear el primer usuario
    const { hashPassword, generateToken } = await import('../utils/auth.js')
    const passwordHash = hashPassword(password)

    const result = await db.run(
      'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
      [username, passwordHash, username, 'admin', 1]
    )

    let userId = result.lastID
    if (!userId) {
      const createdUser = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = createdUser?.id
    }

    if (!userId) {
      throw new Error('No se pudo resolver el ID del usuario creado')
    }

    const [{ token: apiToken, metadata: apiTokenMetadata }, appId] = await Promise.all([
      rotateApiTokenForUser(userId),
      getExternalApiAppId()
    ])

    // Generar token JWT
    const token = generateToken({
      userId,
      username,
      email: '',
      role: 'admin'
    })

    logger.success(`✅ Primer usuario creado: ${username}`)

    res.json({
      success: true,
      message: 'Usuario creado exitosamente',
      token,
      appId,
      apiToken,
      apiTokenMetadata,
      user: serializeAuthUser({
        id: userId,
        username,
        email: '',
        full_name: username,
        role: 'admin'
      })
    })
  } catch (error) {
    logger.error('❌ Error en setup:', error)
    res.status(500).json({
      success: false,
      message: 'Error en el servidor'
    })
  }
}
