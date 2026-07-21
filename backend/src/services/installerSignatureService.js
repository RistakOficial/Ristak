import crypto from 'crypto'
import { db, getAppConfig } from '../config/database.js'
import { getStoredCentralBrokerConfig } from './centralBrokerService.js'

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000
const NONCE_RETENTION_MS = 30 * 60 * 1000

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function timingSafeEqualText(left = '', right = '') {
  const leftBuffer = Buffer.from(cleanString(left))
  const rightBuffer = Buffer.from(cleanString(right))
  if (leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function readHeader(headers = {}, ...keys) {
  for (const key of keys) {
    const direct = headers[key]
    if (direct !== undefined && direct !== null && cleanString(direct)) return cleanString(direct)
    const lower = headers[String(key).toLowerCase()]
    if (lower !== undefined && lower !== null && cleanString(lower)) return cleanString(lower)
  }
  return ''
}

export function getInstallerSignatureHeaders(req) {
  return {
    signature: req?.get?.('X-Ristak-Signature') || readHeader(req?.headers, 'x-ristak-signature'),
    signatureTimestamp: req?.get?.('X-Ristak-Timestamp') || readHeader(req?.headers, 'x-ristak-timestamp'),
    signatureNonce: req?.get?.('X-Ristak-Nonce') || readHeader(req?.headers, 'x-ristak-nonce'),
    installationId: req?.get?.('X-Ristak-Installation-Id') || readHeader(req?.headers, 'x-ristak-installation-id')
  }
}

async function getInstallerRuntimeIdentity() {
  const [storedLicenseKey, storedInstallationId, broker] = await Promise.all([
    getAppConfig('license_key').catch(() => ''),
    getAppConfig('installation_id').catch(() => ''),
    getStoredCentralBrokerConfig().catch(() => null)
  ])

  return {
    secret: cleanString(storedLicenseKey || process.env.RISTAK_LICENSE_KEY || process.env.LICENSE_KEY || broker?.licenseKey),
    installationId: cleanString(
      storedInstallationId ||
      process.env.RISTAK_INSTALLATION_ID ||
      process.env.INSTALLATION_ID ||
      broker?.installationId ||
      process.env.RENDER_SERVICE_ID
    )
  }
}

async function rememberSignedRequestNonce(nonce, purpose, nowMs) {
  const cutoff = new Date(nowMs - NONCE_RETENTION_MS).toISOString().replace('T', ' ').replace('Z', '')
  await db.run('DELETE FROM whatsapp_meta_direct_nonces WHERE created_at < ?', [cutoff]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO whatsapp_meta_direct_nonces (nonce, purpose) VALUES (?, ?)',
      [nonce, cleanString(purpose) || 'installer']
    )
  } catch (error) {
    if (/unique|duplicate|primary key/i.test(error?.message || '')) {
      const replay = new Error('Nonce de seguridad repetido')
      replay.statusCode = 401
      replay.code = 'INSTALLER_SIGNATURE_REPLAY'
      throw replay
    }
    throw error
  }
}

/**
 * Verifica el contrato compartido Installer -> instalación.
 * Firma: HMAC-SHA256(license_key, `${timestamp}.${nonce}.${rawBody}`).
 * La validación es fail-closed: secreto, instalación y cuatro encabezados son
 * obligatorios; el nonce se consume atómicamente después de validar la firma.
 */
export async function verifyInstallerSignedRequest({
  rawBody = '',
  headers = {},
  purpose = 'installer',
  secret = '',
  expectedInstallationId = '',
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const runtime = secret && expectedInstallationId
    ? { secret: cleanString(secret), installationId: cleanString(expectedInstallationId) }
    : await getInstallerRuntimeIdentity()
  const normalizedHeaders = {
    signature: readHeader(headers, 'signature', 'x-ristak-signature'),
    timestamp: readHeader(headers, 'signatureTimestamp', 'timestamp', 'x-ristak-timestamp'),
    nonce: readHeader(headers, 'signatureNonce', 'nonce', 'x-ristak-nonce'),
    installationId: readHeader(headers, 'installationId', 'x-ristak-installation-id')
  }

  if (!runtime.secret || !runtime.installationId) {
    const error = new Error('La instalación no tiene identidad local para verificar al Installer')
    error.statusCode = 401
    error.code = 'INSTALLER_SIGNATURE_NOT_CONFIGURED'
    throw error
  }
  if (!normalizedHeaders.signature || !normalizedHeaders.timestamp || !normalizedHeaders.nonce || !normalizedHeaders.installationId) {
    const error = new Error('Faltan encabezados de firma de Ristak')
    error.statusCode = 401
    error.code = 'INSTALLER_SIGNATURE_HEADERS_MISSING'
    throw error
  }
  if (!timingSafeEqualText(runtime.installationId, normalizedHeaders.installationId)) {
    const error = new Error('La firma pertenece a otra instalación de Ristak')
    error.statusCode = 401
    error.code = 'INSTALLER_SIGNATURE_INSTALLATION_MISMATCH'
    throw error
  }

  const timestampMs = Number(normalizedHeaders.timestamp)
  if (!Number.isFinite(timestampMs) || Math.abs(Number(nowMs) - timestampMs) > Number(maxAgeMs)) {
    const error = new Error('Firma expirada')
    error.statusCode = 401
    error.code = 'INSTALLER_SIGNATURE_EXPIRED'
    throw error
  }

  const manifest = `${normalizedHeaders.timestamp}.${normalizedHeaders.nonce}.${String(rawBody || '')}`
  const expected = crypto.createHmac('sha256', runtime.secret).update(manifest).digest('hex')
  const provided = normalizedHeaders.signature.replace(/^sha256=/i, '')
  if (!timingSafeEqualText(expected, provided)) {
    const error = new Error('Firma inválida de Ristak')
    error.statusCode = 401
    error.code = 'INSTALLER_SIGNATURE_INVALID'
    throw error
  }

  await rememberSignedRequestNonce(normalizedHeaders.nonce, purpose, Number(nowMs))
  return {
    verified: true,
    installationId: normalizedHeaders.installationId,
    nonce: normalizedHeaders.nonce,
    timestamp: timestampMs
  }
}
