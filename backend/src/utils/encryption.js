import crypto from 'crypto'
import { logger } from './logger.js'
import { db } from '../config/database.js'

// Algoritmo de encriptación (AES-256-GCM es el más seguro)
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32 // 256 bits
const IV_LENGTH = 16  // 128 bits
const SALT_LENGTH = 64
const TAG_LENGTH = 16

// Cache de la master key en memoria
let cachedMasterKey = null

/**
 * Obtiene o genera la clave maestra de encriptación
 * Prioridad: 1) Variable de entorno, 2) Base de datos, 3) Generar nueva
 */
async function getMasterKey() {
  // Si ya está en cache, retornarla
  if (cachedMasterKey) {
    return cachedMasterKey
  }

  // 1. Intentar desde variable de entorno
  const envKey = process.env.ENCRYPTION_MASTER_KEY
  if (envKey) {
    cachedMasterKey = Buffer.from(envKey, 'hex')
    logger.info('✅ ENCRYPTION_MASTER_KEY cargada desde variables de entorno')
    return cachedMasterKey
  }

  // 2. Intentar desde base de datos
  try {
    const result = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['encryption_master_key']
    )

    if (result && result.config_value) {
      cachedMasterKey = Buffer.from(result.config_value, 'hex')
      logger.info('✅ ENCRYPTION_MASTER_KEY cargada desde base de datos')
      return cachedMasterKey
    }
  } catch (error) {
    logger.warn('⚠️  No se pudo leer ENCRYPTION_MASTER_KEY de la DB:', error.message)
  }

  // 3. Generar nueva clave y guardarla en DB
  logger.warn('⚠️  ENCRYPTION_MASTER_KEY no encontrada. Generando nueva clave...')
  const newKey = crypto.randomBytes(KEY_LENGTH)
  const newKeyHex = newKey.toString('hex')

  try {
    await db.run(
      `INSERT INTO app_config (config_key, config_value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (config_key) DO UPDATE SET
         config_value = excluded.config_value,
         updated_at = CURRENT_TIMESTAMP`,
      ['encryption_master_key', newKeyHex]
    )
    logger.info('✅ Nueva ENCRYPTION_MASTER_KEY generada y guardada en DB')
    logger.info('   Clave generada:', newKeyHex)
    logger.info('   💡 IMPORTANTE: Guarda esta clave en un lugar seguro como respaldo')
  } catch (error) {
    logger.error('❌ Error guardando ENCRYPTION_MASTER_KEY en DB:', error.message)
    logger.warn('⚠️  Usando clave temporal en memoria (se perderá al reiniciar)')
  }

  cachedMasterKey = newKey
  return cachedMasterKey
}

/**
 * Versión sincrónica de getMasterKey (para compatibilidad con código existente)
 * SOLO usar si ya se inicializó la clave previamente
 */
function getMasterKeySync() {
  if (!cachedMasterKey) {
    throw new Error('Master key no inicializada. Llama a initializeMasterKey() primero')
  }
  return cachedMasterKey
}

/**
 * Inicializa la master key al arrancar el servidor
 * DEBE llamarse antes de cualquier operación de encriptación
 */
export async function initializeMasterKey() {
  await getMasterKey()
}

/**
 * Deriva una clave de encriptación desde la clave maestra usando PBKDF2
 */
function deriveKey(masterKey, salt) {
  return crypto.pbkdf2Sync(masterKey, salt, 100000, KEY_LENGTH, 'sha512')
}

/**
 * Encripta un texto usando AES-256-GCM
 * @param {string} text - Texto a encriptar
 * @returns {string} - Texto encriptado en formato "salt:iv:tag:encrypted"
 */
export function encrypt(text) {
  if (!text) {
    throw new Error('No se puede encriptar un texto vacío')
  }

  try {
    const masterKey = getMasterKeySync()

    // Generar salt, IV y derivar clave
    const salt = crypto.randomBytes(SALT_LENGTH)
    const iv = crypto.randomBytes(IV_LENGTH)
    const key = deriveKey(masterKey, salt)

    // Crear cipher y encriptar
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')

    // Obtener tag de autenticación (importante para GCM)
    const tag = cipher.getAuthTag()

    // Retornar todo concatenado en formato: salt:iv:tag:encrypted
    return [
      salt.toString('hex'),
      iv.toString('hex'),
      tag.toString('hex'),
      encrypted
    ].join(':')
  } catch (error) {
    logger.error('Error encriptando:', error)
    throw new Error('Error al encriptar datos sensibles')
  }
}

/**
 * Desencripta un texto usando AES-256-GCM
 * @param {string} encryptedData - Texto encriptado en formato "salt:iv:tag:encrypted"
 * @returns {string} - Texto desencriptado
 */
export function decrypt(encryptedData) {
  if (!encryptedData) {
    throw new Error('No hay datos para desencriptar')
  }

  try {
    const masterKey = getMasterKeySync()

    // Separar componentes del texto encriptado
    const parts = encryptedData.split(':')
    if (parts.length !== 4) {
      throw new Error('Formato de datos encriptados inválido')
    }

    const [saltHex, ivHex, tagHex, encrypted] = parts

    // Convertir de hex a Buffer
    const salt = Buffer.from(saltHex, 'hex')
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')

    // Derivar la misma clave
    const key = deriveKey(masterKey, salt)

    // Crear decipher y desencriptar
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  } catch (error) {
    logger.error('Error desencriptando:', error)
    throw new Error('Error al desencriptar datos. Verifica tu ENCRYPTION_MASTER_KEY')
  }
}

/**
 * Genera una nueva clave maestra para usar como ENCRYPTION_MASTER_KEY
 * Solo para setup inicial
 */
export function generateMasterKey() {
  const key = crypto.randomBytes(KEY_LENGTH)
  return key.toString('hex')
}

/**
 * Verifica si un texto está encriptado (tiene el formato correcto)
 */
export function isEncrypted(text) {
  if (!text || typeof text !== 'string') return false
  const parts = text.split(':')
  return parts.length === 4
}
