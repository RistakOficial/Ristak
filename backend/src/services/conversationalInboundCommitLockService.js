import crypto from 'node:crypto'
import { db, databaseDialect } from '../config/database.js'

const SIGNED_BIGINT_LIMIT = 1n << 63n
const UNSIGNED_BIGINT_LIMIT = 1n << 64n
const LOCK_NAMESPACE = 'ristak:conversational-inbound-commit:v1'

// Esta lista es el contrato compartido por writers, fences terminales y merges
// de contactos. Los aliases de transporte se normalizan hacia una de estas
// identidades antes de calcular la llave.
export const CONVERSATIONAL_INBOUND_COMMIT_CHANNELS = Object.freeze([
  'whatsapp',
  'instagram',
  'messenger',
  'sms',
  'webchat',
  'facebook_comment',
  'instagram_comment',
  'email'
])

/**
 * Conserva exactamente la misma identidad de canal que usa la autoridad
 * canónica de inbounds. Los writers y el commit terminal deben competir por
 * la misma llave aunque el proveedor use un alias de transporte.
 */
export function normalizeConversationalInboundCommitChannel(value = 'whatsapp') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const aliases = {
    wa: 'whatsapp',
    whatsapp_api: 'whatsapp',
    api: 'whatsapp',
    ghl_whatsapp: 'whatsapp',
    fb: 'messenger',
    facebook: 'messenger',
    facebook_messenger: 'messenger',
    ig: 'instagram',
    instagram_dm: 'instagram',
    sms_qr: 'sms',
    ghl_sms: 'sms',
    mms: 'sms',
    ghl_webchat: 'webchat',
    web_chat: 'webchat',
    chat_web: 'webchat',
    website_chat: 'webchat',
    site_chat: 'webchat',
    correo: 'email',
    mail: 'email',
    e_mail: 'email'
  }
  const normalized = aliases[raw] || raw || 'whatsapp'
  return CONVERSATIONAL_INBOUND_COMMIT_CHANNELS.includes(normalized)
    ? normalized
    : 'whatsapp'
}

export function buildConversationalInboundCommitLockId({ contactId, channel = 'whatsapp' } = {}) {
  const cleanContactId = String(contactId || '').trim()
  if (!cleanContactId) {
    throw new TypeError('contactId es obligatorio para cercar un commit inbound conversacional')
  }

  const normalizedChannel = normalizeConversationalInboundCommitChannel(channel)
  const digest = crypto
    .createHash('sha256')
    .update(`${LOCK_NAMESPACE}:${normalizedChannel}:${cleanContactId}`)
    .digest()
  const unsignedLockId = digest.readBigUInt64BE(0)
  const signedLockId = unsignedLockId >= SIGNED_BIGINT_LIMIT
    ? unsignedLockId - UNSIGNED_BIGINT_LIMIT
    : unsignedLockId

  return signedLockId.toString()
}

function compareCommitLocks(left, right) {
  const leftId = BigInt(left.lockId)
  const rightId = BigInt(right.lockId)
  if (leftId < rightId) return -1
  if (leftId > rightId) return 1
  return `${left.contactId}:${left.channel}`.localeCompare(`${right.contactId}:${right.channel}`)
}

/**
 * Adquiere varias llaves del mismo protocolo en un orden global estable. Esto
 * permite que un merge cerque origen y destino en todos los canales sin crear
 * ciclos merge↔merge. Un writer o fence normal sólo pide una llave y por eso es
 * compatible con este mismo orden.
 */
export async function acquireConversationalInboundCommitLocks({
  contactIds,
  channels = CONVERSATIONAL_INBOUND_COMMIT_CHANNELS,
  database = db,
  dialect = databaseDialect
} = {}) {
  const normalizedContactIds = [...new Set(
    (Array.isArray(contactIds) ? contactIds : [contactIds])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]
  if (!normalizedContactIds.length) {
    throw new TypeError('contactIds es obligatorio para cercar commits inbound conversacionales')
  }

  const normalizedChannels = [...new Set(
    (Array.isArray(channels) ? channels : [channels])
      .map(channel => normalizeConversationalInboundCommitChannel(channel))
  )]
  if (!normalizedChannels.length) {
    throw new TypeError('channels es obligatorio para cercar commits inbound conversacionales')
  }

  const locksById = new Map()
  for (const contactId of normalizedContactIds) {
    for (const channel of normalizedChannels) {
      const lock = {
        contactId,
        channel,
        lockId: buildConversationalInboundCommitLockId({ contactId, channel })
      }
      if (!locksById.has(lock.lockId)) locksById.set(lock.lockId, lock)
    }
  }

  const locks = [...locksById.values()].sort(compareCommitLocks)
  if (dialect === 'postgres') {
    for (const lock of locks) {
      await database.get(
        'SELECT pg_advisory_xact_lock(CAST(? AS BIGINT)) AS conversational_inbound_commit_lock',
        [lock.lockId]
      )
    }
  }

  return locks.map(lock => ({ acquired: true, ...lock }))
}

/**
 * Adquiere un advisory lock transaccional. En PostgreSQL vive hasta COMMIT o
 * ROLLBACK; en SQLite la serialización la aporta BEGIN IMMEDIATE del wrapper.
 * El caller debe ejecutarlo dentro de una transacción si llama este helper de
 * forma directa.
 */
export async function acquireConversationalInboundCommitLock({
  contactId,
  channel = 'whatsapp',
  database = db,
  dialect = databaseDialect
} = {}) {
  const normalizedChannel = normalizeConversationalInboundCommitChannel(channel)
  const [lock] = await acquireConversationalInboundCommitLocks({
    contactIds: [contactId],
    channels: [normalizedChannel],
    database,
    dialect
  })
  return lock
}

/**
 * Abre la transacción corta de persistencia inbound o reutiliza el adapter de
 * una transacción ya activa. La notificación y el arranque del runner deben
 * ocurrir después de que este callback haya terminado y hecho COMMIT.
 */
export async function withConversationalInboundCommitLock({
  contactId,
  channel = 'whatsapp',
  database = db,
  dialect = databaseDialect
} = {}, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('callback es obligatorio para persistir un inbound bajo commit lock')
  }

  const execute = async (transactionDatabase) => {
    await acquireConversationalInboundCommitLock({
      contactId,
      channel,
      database: transactionDatabase,
      dialect
    })
    return callback(transactionDatabase)
  }

  if (typeof database?.transaction === 'function') {
    return database.transaction(execute)
  }

  return execute(database)
}
