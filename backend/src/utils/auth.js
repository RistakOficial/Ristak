import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from './logger.js'

function getJwtSecret() {
  const secret = process.env.JWT_SECRET

  if (secret) return secret

  // (AUTH-004) JWT_SECRET es obligatorio SIEMPRE, no solo en producción.
  // El fallback estático ('ristak-default-secret-change-me') permitía a
  // cualquiera que conociera la cadena del repo forjar JWTs válidos en
  // staging/preview o instalaciones sin NODE_ENV=production.
  throw new Error('JWT_SECRET es requerido (configura la variable de entorno JWT_SECRET)')
}

// (AUTH-005) Política de contraseñas: mínimo 10 caracteres y al menos una
// minúscula, una mayúscula y un dígito. Bloquea además contraseñas comunes.
export const PASSWORD_MIN_LENGTH = 10

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'passw0rd', '1234567890', '12345678', '123456789',
  'qwertyuiop', 'qwerty123', 'iloveyou1', 'admin12345', 'changeme123',
  'welcome123', 'letmein123', 'ristak12345'
])

export function validatePasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'La contraseña debe incluir mayúsculas, minúsculas y números'
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'La contraseña es demasiado común. Elige una más segura'
  }
  return null
}

/**
 * Genera un hash de password usando bcrypt (simulado con PBKDF2 + salt)
 * @param {string} password - Password en texto plano
 * @returns {string} - Hash del password
 */
export function hashPassword(password) {
  // (AUTH-005) Aplicar política de contraseñas fuerte en el punto de hashing.
  const policyError = validatePasswordPolicy(password)
  if (policyError) {
    throw new Error(policyError)
  }

  // Generar salt aleatorio (16 bytes)
  const salt = crypto.randomBytes(16).toString('hex')

  // Generar hash usando PBKDF2 (100,000 iteraciones)
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')

  // Retornar salt:hash para poder verificar después
  return `${salt}:${hash}`
}

/**
 * Verifica si un password coincide con su hash
 * @param {string} password - Password en texto plano
 * @param {string} storedHash - Hash almacenado en DB (formato: salt:hash)
 * @returns {boolean} - true si coincide, false si no
 */
export function verifyPassword(password, storedHash) {
  if (!password || !storedHash) {
    return false
  }

  try {
    // Separar salt y hash
    const [salt, originalHash] = storedHash.split(':')

    if (!salt || !originalHash) {
      logger.error('❌ Formato de hash inválido')
      return false
    }

    // Generar hash del password ingresado con el mismo salt
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')

    // Comparar de forma segura (timing attack resistant)
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(originalHash))
  } catch (error) {
    logger.error('❌ Error verificando password:', error.message)
    return false
  }
}

/**
 * Verifica si existen usuarios en la base de datos
 * NO crea usuario por defecto. El usuario debe usar la pantalla de Setup para crear su primer usuario.
 * @returns {Promise<void>}
 */
export async function initializeDefaultUser() {
  try {
    // Verificar si ya existe algún usuario
    const existingUser = await db.get('SELECT id FROM users LIMIT 1')

    if (existingUser) {
      logger.info('✅ Usuario ya existe. App lista para usar.')
      return
    }

    logger.info('⚠️  No hay usuarios creados. El usuario debe usar la pantalla de Setup.')
  } catch (error) {
    logger.error('❌ Error verificando usuarios:', error.message)
  }
}

/**
 * Genera un token JWT simple (sin librería externa)
 * @param {object} payload - Datos a incluir en el token
 * @returns {string} - Token JWT
 */
export function generateToken(payload) {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  }

  const secret = getJwtSecret()

  // Crear token
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30) // 30 días
  })).toString('base64url')

  // Crear firma
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url')

  return `${encodedHeader}.${encodedPayload}.${signature}`
}

/**
 * Verifica y decodifica un token JWT
 * @param {string} token - Token JWT
 * @returns {object|null} - Payload del token o null si es inválido
 */
export function verifyToken(token) {
  if (!token) {
    return null
  }

  try {
    const secret = getJwtSecret()

    const [encodedHeader, encodedPayload, signature] = token.split('.')

    if (!encodedHeader || !encodedPayload || !signature) {
      return null
    }

    // Verificar firma
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url')

    // (SEC-011) Comparación constante de la firma para evitar canal de timing
    // (alineado con oauthTokens/apiTokens/verifyScopedToken).
    const signatureBuf = Buffer.from(signature)
    const expectedBuf = Buffer.from(expectedSignature)
    if (signatureBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
      logger.warn('⚠️  Token inválido: firma no coincide')
      return null
    }

    // Decodificar payload
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString())

    // Verificar expiración
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      logger.warn('⚠️  Token expirado')
      return null
    }

    return payload
  } catch (error) {
    logger.error('❌ Error verificando token:', error.message)
    return null
  }
}

/**
 * Firma un token corto y con propósito acotado (scope). NO es un token de sesión:
 * se firma sobre `${scope}.${body}` (esquema distinto al JWT de auth), por lo que
 * verifyToken() lo rechaza y no sirve para autenticar ninguna ruta protegida.
 * Úsalo para enlaces de un solo propósito y corta duración (ej. página de prueba).
 * @param {string} scope - Propósito del token, p.ej. 'meta_pixel_test'
 * @param {object} data - Datos a embeber (no secretos sensibles del servidor)
 * @param {number} ttlSeconds - Validez en segundos (por defecto 10 min)
 * @returns {string} token `${body}.${signature}`
 */
export function signScopedToken(scope, data = {}, ttlSeconds = 600) {
  const secret = getJwtSecret()
  const body = Buffer.from(JSON.stringify({
    ...data,
    scope,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  })).toString('base64url')
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${scope}.${body}`)
    .digest('base64url')
  return `${body}.${signature}`
}

/**
 * Verifica un token acotado emitido por signScopedToken. Devuelve el payload o
 * null si la firma no coincide, el scope no es el esperado o ya expiró.
 */
export function verifyScopedToken(scope, token) {
  if (!token || typeof token !== 'string') return null
  try {
    const [body, signature] = token.split('.')
    if (!body || !signature) return null
    const secret = getJwtSecret()
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${scope}.${body}`)
      .digest('base64url')
    const provided = Buffer.from(signature)
    const expectedBuf = Buffer.from(expected)
    if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
      return null
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (payload.scope !== scope) return null
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch (error) {
    return null
  }
}
