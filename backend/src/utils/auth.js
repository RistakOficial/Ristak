import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from './logger.js'

function getJwtSecret() {
  const secret = process.env.JWT_SECRET

  if (secret) return secret

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET es requerido en producción')
  }

  return 'ristak-default-secret-change-me'
}

/**
 * Genera un hash de password usando bcrypt (simulado con PBKDF2 + salt)
 * @param {string} password - Password en texto plano
 * @returns {string} - Hash del password
 */
export function hashPassword(password) {
  if (!password || password.length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres')
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

    if (signature !== expectedSignature) {
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
