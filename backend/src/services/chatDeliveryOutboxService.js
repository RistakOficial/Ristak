import crypto from 'crypto'
import { db, databaseDialect } from '../config/database.js'

export const CHAT_DELIVERY_JOB_KIND = Object.freeze({
  PUSH: 'push',
  META_ENRICHMENT: 'meta_enrichment'
})

const VALID_JOB_KINDS = new Set(Object.values(CHAT_DELIVERY_JOB_KIND))
const DEFAULT_LEASE_MS = 60_000
const MAX_RETRY_DELAY_MS = 5 * 60_000
export const CHAT_DELIVERY_MAX_ATTEMPTS = 20
// Media puede depender de una caída larga de Graph o Storage. Con backoff a
// cinco minutos, 2,016 intentos cubren aproximadamente siete días antes de
// pasar a auditoría fallida; un replay del webhook puede revivirla después.
export const CHAT_DELIVERY_ENRICHMENT_MAX_ATTEMPTS = 2_016
export const CHAT_DELIVERY_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60_000
export const CHAT_DELIVERY_FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000
export const CHAT_DELIVERY_CLEANUP_BATCH_SIZE = 500

function cleanString(value) {
  return String(value || '').trim()
}

function nowIso() {
  return new Date().toISOString()
}

function isoAfter(delayMs = 0) {
  return new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString()
}

function newJobId() {
  return `chat_delivery_${crypto.randomUUID()}`
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mapJob(row) {
  if (!row) return null
  return {
    ...row,
    attemptCount: Number(row.attempt_count || 0),
    payload: parsePayload(row.payload_json)
  }
}

function assertJobIdentity(jobKind, messageId) {
  if (!VALID_JOB_KINDS.has(jobKind)) {
    throw new Error(`Tipo de outbox de chat inválido: ${jobKind || '(vacío)'}`)
  }
  if (!messageId) throw new Error('El outbox de chat requiere messageId')
}

/**
 * Debe invocarse con el adapter de la transacción que creó el claim inbound.
 * Así, fila/unread/outbox se confirman o se revierten juntos.
 */
export async function enqueueChatDeliveryJob({
  jobKind,
  messageId,
  contactId = '',
  provider = '',
  payload = {},
  database = db,
  availableAt = ''
} = {}) {
  const cleanJobKind = cleanString(jobKind)
  const cleanMessageId = cleanString(messageId)
  assertJobIdentity(cleanJobKind, cleanMessageId)

  const timestamp = nowIso()
  const id = newJobId()
  await database.run(`
    INSERT INTO chat_delivery_outbox (
      id, job_kind, message_id, contact_id, provider, payload_json,
      status, attempt_count, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    ON CONFLICT(job_kind, message_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      status = 'pending',
      attempt_count = 0,
      available_at = excluded.available_at,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = NULL,
      completed_at = NULL,
      failed_at = NULL,
      updated_at = excluded.updated_at
    WHERE chat_delivery_outbox.job_kind = 'meta_enrichment'
      AND chat_delivery_outbox.status = 'failed'
  `, [
    id,
    cleanJobKind,
    cleanMessageId,
    cleanString(contactId) || null,
    cleanString(provider) || null,
    JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
    cleanString(availableAt) || timestamp,
    timestamp,
    timestamp
  ])

  return mapJob(await database.get(
    'SELECT * FROM chat_delivery_outbox WHERE job_kind = ? AND message_id = ? LIMIT 1',
    [cleanJobKind, cleanMessageId]
  ))
}

export async function claimNextChatDeliveryJob({
  ownerId = '',
  leaseMs = DEFAULT_LEASE_MS,
  jobKinds = [...VALID_JOB_KINDS],
  excludedJobIds = [],
  database = db
} = {}) {
  const owner = cleanString(ownerId) || `chat-delivery-${process.pid}-${crypto.randomUUID()}`
  const selectedKinds = [...new Set(jobKinds.map(cleanString).filter(kind => VALID_JOB_KINDS.has(kind)))]
  const excludedIds = [...new Set(excludedJobIds.map(cleanString).filter(Boolean))]
  if (!selectedKinds.length) return null

  return database.transaction(async transactionDatabase => {
    const timestamp = nowIso()
    const kindPlaceholders = selectedKinds.map(() => '?').join(', ')
    const candidate = await transactionDatabase.get(`
      SELECT *
      FROM chat_delivery_outbox
      WHERE job_kind IN (${kindPlaceholders})
        ${excludedIds.length ? `AND id NOT IN (${excludedIds.map(() => '?').join(', ')})` : ''}
        AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      ORDER BY
        CASE job_kind WHEN 'push' THEN 0 ELSE 1 END,
        available_at ASC,
        created_at ASC
      LIMIT 1
      ${databaseDialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : ''}
    `, [...selectedKinds, ...excludedIds, timestamp, timestamp])
    if (!candidate?.id) return null

    const leaseExpiresAt = isoAfter(leaseMs)
    const claimed = await transactionDatabase.run(`
      UPDATE chat_delivery_outbox
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          lease_owner = ?,
          lease_expires_at = ?,
          last_error = NULL,
          updated_at = ?
      WHERE id = ?
        AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
    `, [owner, leaseExpiresAt, timestamp, candidate.id, timestamp, timestamp])
    if (Number(claimed?.changes || 0) !== 1) return null

    return mapJob(await transactionDatabase.get(
      'SELECT * FROM chat_delivery_outbox WHERE id = ? LIMIT 1',
      [candidate.id]
    ))
  })
}

export async function renewChatDeliveryJobLease({
  jobId,
  ownerId,
  leaseMs = DEFAULT_LEASE_MS,
  database = db
} = {}) {
  const id = cleanString(jobId)
  const owner = cleanString(ownerId)
  if (!id || !owner) return false
  const result = await database.run(`
    UPDATE chat_delivery_outbox
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_owner = ?
  `, [isoAfter(leaseMs), nowIso(), id, owner])
  return Number(result?.changes || 0) === 1
}

export async function completeChatDeliveryJob({ jobId, ownerId, database = db } = {}) {
  const id = cleanString(jobId)
  const owner = cleanString(ownerId)
  if (!id || !owner) return false
  const timestamp = nowIso()
  const result = await database.run(`
    UPDATE chat_delivery_outbox
    SET status = 'completed',
        completed_at = ?,
        failed_at = NULL,
        payload_json = '{}',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = ?
    WHERE id = ? AND status = 'processing' AND lease_owner = ?
  `, [timestamp, timestamp, id, owner])
  return Number(result?.changes || 0) === 1
}

export async function retryChatDeliveryJob({
  jobId,
  ownerId,
  error,
  attemptCount = 1,
  maxAttempts = CHAT_DELIVERY_MAX_ATTEMPTS,
  payload = null,
  database = db,
  retryDelayMs = null
} = {}) {
  const id = cleanString(jobId)
  const owner = cleanString(ownerId)
  if (!id || !owner) return false
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    Math.max(1_000, 1_000 * (2 ** Math.min(8, Math.max(0, Number(attemptCount || 1) - 1))))
  )
  const timestamp = nowIso()
  const cleanError = cleanString(error?.message || error).slice(0, 2000) || 'Error desconocido'
  const serializedPayload = payload && typeof payload === 'object'
    ? JSON.stringify(payload)
    : null
  const attemptLimit = Math.max(1, Number(maxAttempts) || CHAT_DELIVERY_MAX_ATTEMPTS)
  const deadLettered = Math.max(1, Number(attemptCount) || 1) >= attemptLimit
  const result = deadLettered
    ? await database.run(`
        UPDATE chat_delivery_outbox
        SET status = 'failed',
            failed_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            payload_json = '{}',
            updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `, [timestamp, cleanError, timestamp, id, owner])
    : await database.run(`
        UPDATE chat_delivery_outbox
        SET status = 'pending',
            available_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            payload_json = COALESCE(?, payload_json),
            updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
      `, [
        isoAfter(retryDelayMs === null ? exponentialDelay : retryDelayMs),
        cleanError,
        serializedPayload,
        timestamp,
        id,
        owner
      ])
  const updated = Number(result?.changes || 0) === 1
  return {
    updated,
    status: updated ? (deadLettered ? 'failed' : 'pending') : 'unchanged',
    deadLettered: updated && deadLettered
  }
}

export async function getChatDeliveryJob({ jobKind, messageId, database = db } = {}) {
  const cleanJobKind = cleanString(jobKind)
  const cleanMessageId = cleanString(messageId)
  if (!cleanJobKind || !cleanMessageId) return null
  return mapJob(await database.get(
    'SELECT * FROM chat_delivery_outbox WHERE job_kind = ? AND message_id = ? LIMIT 1',
    [cleanJobKind, cleanMessageId]
  ))
}

export async function listChatDeliveryJobs({ status = '', jobKind = '', database = db } = {}) {
  const conditions = []
  const params = []
  if (cleanString(status)) {
    conditions.push('status = ?')
    params.push(cleanString(status))
  }
  if (cleanString(jobKind)) {
    conditions.push('job_kind = ?')
    params.push(cleanString(jobKind))
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = await database.all(`
    SELECT * FROM chat_delivery_outbox
    ${where}
    ORDER BY created_at ASC
  `, params)
  return rows.map(mapJob)
}

export async function cleanupCompletedChatDeliveryJobs({
  retentionMs = CHAT_DELIVERY_COMPLETED_RETENTION_MS,
  failedRetentionMs = CHAT_DELIVERY_FAILED_RETENTION_MS,
  batchSize = CHAT_DELIVERY_CLEANUP_BATCH_SIZE,
  database = db
} = {}) {
  const cutoff = new Date(Date.now() - Math.max(0, Number(retentionMs) || 0)).toISOString()
  const failedCutoff = new Date(Date.now() - Math.max(0, Number(failedRetentionMs) || 0)).toISOString()
  const limit = Math.max(1, Math.min(5_000, Number(batchSize) || CHAT_DELIVERY_CLEANUP_BATCH_SIZE))
  const scrubResult = await database.run(`
    UPDATE chat_delivery_outbox
    SET payload_json = '{}', updated_at = ?
    WHERE id IN (
      SELECT id
      FROM chat_delivery_outbox
      WHERE status IN ('completed', 'failed')
        AND payload_json <> '{}'
      ORDER BY updated_at ASC
      LIMIT ?
    )
  `, [nowIso(), limit])
  const completedResult = await database.run(`
    DELETE FROM chat_delivery_outbox
    WHERE id IN (
      SELECT id
      FROM chat_delivery_outbox
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at <= ?
      ORDER BY completed_at ASC
      LIMIT ?
    )
  `, [cutoff, limit])
  const failedResult = await database.run(`
    DELETE FROM chat_delivery_outbox
    WHERE id IN (
      SELECT id
      FROM chat_delivery_outbox
      WHERE status = 'failed'
        AND failed_at IS NOT NULL
        AND failed_at <= ?
      ORDER BY failed_at ASC
      LIMIT ?
    )
  `, [failedCutoff, limit])
  const completedDeleted = Number(completedResult?.changes || 0)
  const failedDeleted = Number(failedResult?.changes || 0)
  return {
    deleted: completedDeleted + failedDeleted,
    completedDeleted,
    failedDeleted,
    scrubbed: Number(scrubResult?.changes || 0),
    batchSize: limit,
    cutoff,
    failedCutoff
  }
}

export const chatDeliveryOutboxInternals = Object.freeze({
  newJobId,
  DEFAULT_LEASE_MS
})
