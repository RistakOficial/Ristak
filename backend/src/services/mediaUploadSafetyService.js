import crypto from 'crypto'
import { createReadStream } from 'fs'

import { db } from '../config/database.js'

const CLIENT_UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const DEFAULT_LEASE_MS = 10 * 60_000
const DEFAULT_WAIT_MS = 110_000
const POLL_INTERVAL_MS = 125

function cleanString(value = '') {
  return String(value || '').trim()
}

function createHttpError(message, status, code = '') {
  const error = new Error(message)
  error.status = status
  if (code) error.code = code
  return error
}

function normalizeBusinessId(value = '') {
  const clean = cleanString(value || process.env.RISTAK_BUSINESS_ID || 'default')
  return clean.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'default'
}

export function normalizeMediaClientUploadId(value = '') {
  const key = cleanString(value)
  if (!CLIENT_UPLOAD_ID_PATTERN.test(key)) {
    throw createHttpError(
      'La llave de seguridad de la subida no es válida. Vuelve a seleccionar el archivo e inténtalo otra vez.',
      400,
      'invalid_media_upload_id'
    )
  }
  return key
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key])
    return result
  }, {})
}

async function updateHashWithFile(hash, filePath) {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
}

/**
 * Huella estable del archivo original y de su destino lógico. Se calcula antes
 * de comprimir/transcodificar para que un retry concurrente no repita ffmpeg.
 */
export async function createMediaUploadRequestHash({
  descriptor = {},
  filePath = '',
  buffer = null,
  content = ''
} = {}) {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify(stableValue(descriptor || {})))
  hash.update('\0')

  if (filePath) {
    await updateHashWithFile(hash, filePath)
  } else if (Buffer.isBuffer(buffer)) {
    hash.update(buffer)
  } else {
    hash.update(String(content || ''))
  }

  return hash.digest('hex')
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function normalizeErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode || 500)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

function assertMatchingHash(row, requestHash) {
  if (row?.request_hash !== requestHash) {
    throw createHttpError(
      'La llave de esta subida ya se usó con otro archivo o destino. Vuelve a seleccionar el archivo para crear un envío nuevo.',
      409,
      'media_upload_id_conflict'
    )
  }
}

function replayCompleted(row) {
  const response = parseJson(row?.response_json, null)
  if (!response) {
    throw createHttpError(
      'La subida terminó, pero no se pudo reconstruir su respuesta. Recarga la conversación antes de intentar otra vez.',
      409,
      'media_upload_replay_unavailable'
    )
  }
  return response
}

async function readRequest(businessId, clientUploadId) {
  return db.get(
    'SELECT * FROM media_upload_requests WHERE business_id = ? AND client_upload_id = ?',
    [businessId, clientUploadId]
  )
}

async function reserveRequest({ businessId, clientUploadId, requestHash }) {
  const ownerToken = crypto.randomUUID()
  const now = new Date()
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString()
  const inserted = await db.run(
    `INSERT INTO media_upload_requests (
      business_id, client_upload_id, request_hash, status, owner_token,
      lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)
    ON CONFLICT (business_id, client_upload_id) DO NOTHING`,
    [businessId, clientUploadId, requestHash, ownerToken, leaseExpiresAt, nowIso, nowIso]
  )
  if (Number(inserted?.changes || 0) > 0) {
    return { owner: true, ownerToken }
  }

  let row = await readRequest(businessId, clientUploadId)
  if (!row) {
    throw createHttpError('No se pudo reservar la subida. Intenta otra vez.', 503, 'media_upload_reservation_failed')
  }
  assertMatchingHash(row, requestHash)
  if (row.status === 'completed') return { owner: false, response: replayCompleted(row) }

  const leaseExpired = row.lease_expires_at && new Date(row.lease_expires_at).getTime() <= now.getTime()
  if (row.status === 'failed' || leaseExpired) {
    const claimed = await db.run(
      `UPDATE media_upload_requests
       SET status = 'processing', owner_token = ?, lease_expires_at = ?,
           asset_id = NULL, response_json = NULL, error_status = NULL,
           error_message = NULL, updated_at = ?
       WHERE business_id = ? AND client_upload_id = ? AND request_hash = ?
         AND (status = 'failed' OR lease_expires_at <= ?)`,
      [
        ownerToken,
        leaseExpiresAt,
        nowIso,
        businessId,
        clientUploadId,
        requestHash,
        nowIso
      ]
    )
    if (Number(claimed?.changes || 0) > 0) return { owner: true, ownerToken }
    row = await readRequest(businessId, clientUploadId)
    assertMatchingHash(row, requestHash)
    if (row?.status === 'completed') return { owner: false, response: replayCompleted(row) }
  }

  return { owner: false, wait: true }
}

async function waitForRequest({ businessId, clientUploadId, requestHash }) {
  const deadline = Date.now() + DEFAULT_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const row = await readRequest(businessId, clientUploadId)
    if (!row) {
      throw createHttpError('La reserva de subida desapareció. Intenta otra vez.', 503, 'media_upload_reservation_lost')
    }
    assertMatchingHash(row, requestHash)
    if (row.status === 'completed') return replayCompleted(row)
    if (row.status === 'failed') {
      throw createHttpError(
        row.error_message || 'No se pudo completar la subida.',
        Number(row.error_status || 500),
        'media_upload_failed'
      )
    }
  }

  throw createHttpError(
    'La subida sigue procesándose. Espera un momento antes de volver a intentarlo.',
    409,
    'media_upload_in_progress'
  )
}

/** Ejecuta una subida una sola vez por llave y reproduce el asset desde DB. */
export async function runIdempotentMediaUpload({
  businessId = 'default',
  clientUploadId,
  requestHash,
  create
}) {
  const cleanBusinessId = normalizeBusinessId(businessId)
  const cleanUploadId = normalizeMediaClientUploadId(clientUploadId)
  const cleanHash = cleanString(requestHash)
  if (!/^[a-f0-9]{64}$/i.test(cleanHash)) {
    throw createHttpError('No se pudo verificar el contenido de la subida.', 400, 'invalid_media_upload_hash')
  }
  if (typeof create !== 'function') {
    throw createHttpError('No se configuró la operación de subida.', 500, 'invalid_media_upload_operation')
  }

  const reservation = await reserveRequest({
    businessId: cleanBusinessId,
    clientUploadId: cleanUploadId,
    requestHash: cleanHash
  })
  if (reservation.response) return reservation.response
  if (!reservation.owner) {
    return waitForRequest({
      businessId: cleanBusinessId,
      clientUploadId: cleanUploadId,
      requestHash: cleanHash
    })
  }

  try {
    const response = await create()
    const assetId = cleanString(response?.id)
    const completed = await db.run(
      `UPDATE media_upload_requests
       SET status = 'completed', asset_id = ?, response_json = ?,
           lease_expires_at = NULL, updated_at = ?
       WHERE business_id = ? AND client_upload_id = ?
         AND owner_token = ? AND status = 'processing'`,
      [
        assetId || null,
        JSON.stringify(response ?? null),
        new Date().toISOString(),
        cleanBusinessId,
        cleanUploadId,
        reservation.ownerToken
      ]
    )
    if (Number(completed?.changes || 0) === 0) {
      const raced = await readRequest(cleanBusinessId, cleanUploadId)
      assertMatchingHash(raced, cleanHash)
      if (raced?.status === 'completed') return replayCompleted(raced)
      throw createHttpError('La reserva de la subida cambió mientras se procesaba.', 409, 'media_upload_lease_lost')
    }
    return response
  } catch (error) {
    await db.run(
      `UPDATE media_upload_requests
       SET status = 'failed', error_status = ?, error_message = ?,
           lease_expires_at = NULL, updated_at = ?
       WHERE business_id = ? AND client_upload_id = ?
         AND owner_token = ? AND status = 'processing'`,
      [
        normalizeErrorStatus(error),
        cleanString(error?.message || 'No se pudo completar la subida.'),
        new Date().toISOString(),
        cleanBusinessId,
        cleanUploadId,
        reservation.ownerToken
      ]
    ).catch(() => undefined)
    throw error
  }
}
