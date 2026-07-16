import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

import { databaseDialect, db } from '../config/database.js'
import { BACKFILL_JOB_PRIORITY } from '../jobs/backfillJobCoordinator.js'
import { scheduleProjectionBackfillJob } from '../jobs/projectionBackfillScheduler.js'
import {
  getAccountTimezone,
  normalizeDateOnlyInTimezone,
  normalizeToUtcIso,
  resolveTimezone
} from '../utils/dateUtils.js'
import { isDeployShutdownStarted } from '../utils/deployDrainTracker.js'
import { buildHiddenContactsCondition } from '../utils/hiddenContactsFilter.js'
import { logger } from '../utils/logger.js'

export const MESSAGE_ANALYTICS_PROJECTION_VERSION = 3

const STATE_ID = 1
const BACKFILL_JOB_KEY = 'message-analytics-projection'
const SOURCE_KINDS = Object.freeze(['whatsapp', 'meta', 'email'])
const SOURCE_TABLES = Object.freeze({
  whatsapp: 'whatsapp_api_messages',
  meta: 'meta_social_messages',
  email: 'email_messages'
})
const BATCH_SIZE = databaseDialect === 'postgres' ? 250 : 100
const QUEUE_BATCH_SIZE = 200
const CONTACT_BATCH_SIZE = 200
const BULK_WRITE_SIZE = databaseDialect === 'postgres' ? 250 : 50
const GC_BATCH_SIZE = 500
const GC_POLL_MS = 30_000
const MAX_QUEUE_BATCHES = 6
const MAX_BACKFILL_BATCHES = 3
const CONTINUOUS_POLL_MS = 30_000
const BACKFILL_PAUSE_MS = 100
const ERROR_RETRY_MS = 30_000
const MAX_INDEXED_BYTES = 300
const FILTER_LIMIT = 50
const RANGE_ORIGIN = '0001-01-01'
const RANGE_METRICS = Object.freeze(['conversation', 'attributed'])
const RANGE_SCOPES = Object.freeze(['all', 'channel', 'source', 'channel_source'])

// normalizeWhatsAppSource/normalizeMetaSource sólo producen este catálogo. No
// persistimos un grid para valores arbitrarios (campañas, URLs, ids, etc.); eso
// convertiría un read model pequeño en una explosión high-card.
export const MESSAGE_ANALYTICS_SOURCE_CATALOG = Object.freeze([
  'Audience Network', 'Bing', 'Email', 'Facebook', 'Instagram', 'LinkedIn',
  'Messenger', 'Meta Ads', 'Pinterest', 'Reddit', 'Snapchat', 'Telegram',
  'TikTok', 'Twitter', 'WhatsApp', 'YouTube', 'Google'
])
const MESSAGE_ANALYTICS_SOURCE_SET = new Set(MESSAGE_ANALYTICS_SOURCE_CATALOG)

const FACT_COLUMNS = Object.freeze([
  'generation',
  'source_kind',
  'source_message_id',
  'projection_version',
  'included',
  'occurred_at',
  'business_date',
  'identity_key',
  'contact_id',
  'contact_key',
  'channel',
  'channel_label',
  'source',
  'attributed'
])

const DAILY_KEY_COLUMNS = Object.freeze([
  'generation',
  'business_date',
  'channel',
  'source',
  'identity_key',
  'contact_key'
])

const PHONE_FACT_COLUMNS = Object.freeze([
  'generation',
  'source_message_id',
  'projection_version',
  'included',
  'occurred_at',
  'business_date',
  'identity_key',
  'contact_id',
  'contact_key',
  'business_phone_key',
  'business_phone_number_id',
  'business_phone_number'
])

const PHONE_DAILY_KEY_COLUMNS = Object.freeze([
  'generation',
  'business_date',
  'business_phone_key',
  'identity_key',
  'contact_key'
])

const PHONE_METADATA_KEY_COLUMNS = Object.freeze([
  'generation',
  'business_date',
  'business_phone_key',
  'business_phone_number_id',
  'business_phone_number'
])

const SOURCE_SELECT_COLUMNS = Object.freeze({
  whatsapp: [
    'id', 'contact_id', 'phone', 'whatsapp_api_contact_id', 'direction',
    'message_timestamp', 'created_at', 'business_phone',
    'business_phone_number_id', 'detected_ctwa_clid',
    'detected_source_id', 'detected_source_url', 'detected_source_type',
    'detected_source_app', 'detected_entry_point'
  ],
  meta: [
    'id', 'platform', 'meta_social_contact_id', 'contact_id', 'sender_id',
    'direction', 'message_timestamp', 'created_at', 'referral_json'
  ],
  email: ['id', 'contact_id', 'direction', 'from_email', 'message_timestamp', 'created_at']
})

let workerPromise = null
let workerScheduled = false
let workerEligibleAt = 0
let resumeTimer = null
let lastGcAttemptAt = 0

function text(value) {
  return String(value ?? '').trim()
}

function booleanValue(value) {
  return value === true || Number(value) === 1 || String(value).toLowerCase() === 'true'
}

function includedValue(value) {
  return databaseDialect === 'postgres' ? Boolean(value) : (value ? 1 : 0)
}

function boundedInteger(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

function chunks(values, size = BULK_WRITE_SIZE) {
  const result = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function indexedKey(value, namespace = 'value') {
  const normalized = text(value)
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_INDEXED_BYTES) return normalized
  return `${namespace}:sha256:${createHash('sha256').update(normalized).digest('hex')}`
}

function normalizeChannel(value, fallback = 'whatsapp') {
  const normalized = text(value).toLowerCase()
  if (normalized.includes('instagram') || normalized === 'ig') return 'instagram'
  if (normalized.includes('messenger') || normalized === 'facebook' || normalized === 'fb') return 'messenger'
  if (normalized.includes('email') || normalized.includes('correo') || normalized.includes('smtp')) return 'email'
  if (normalized.includes('whatsapp') || normalized === 'wa' || normalized.includes('ycloud')) return 'whatsapp'
  return fallback
}

function channelLabel(channel) {
  if (channel === 'instagram') return 'Instagram DM'
  if (channel === 'messenger') return 'Messenger'
  if (channel === 'email') return 'Email'
  return 'WhatsApp'
}

function classifiedSource(signalValue, { attributedId = false, fallback = 'WhatsApp' } = {}) {
  const signal = text(signalValue).toLowerCase()
  if (signal.includes('instagram') || signal.includes('ig.com')) return 'Instagram'
  if (signal.includes('facebook') || signal.includes('fb.com') || signal.includes('m.me') || signal.includes('messenger')) return 'Facebook'
  if (signal.includes('tiktok') || signal.includes('ttclid')) return 'TikTok'
  if (signal.includes('youtube') || signal.includes('youtu.be')) return 'YouTube'
  if (signal.includes('google') || signal.includes('adwords') || signal.includes('gclid')) return 'Google'
  if (signal.includes('bing') || signal.includes('microsoft') || signal.includes('msclkid')) return 'Bing'
  if (signal.includes('linkedin') || signal.includes('lnkd')) return 'LinkedIn'
  if (signal.includes('snapchat')) return 'Snapchat'
  if (signal.includes('pinterest') || signal.includes('pin.it')) return 'Pinterest'
  if (signal.includes('reddit') || signal.includes('redd.it')) return 'Reddit'
  if (signal.includes('twitter') || signal.includes('x.com') || signal.includes('twclid')) return 'Twitter'
  if (signal.includes('telegram') || signal.includes('t.me')) return 'Telegram'
  if (signal.includes('email') || signal.includes('newsletter')) return 'Email'
  if (attributedId) return 'Meta Ads'
  return fallback
}

function normalizeIdentity(sourceKind, row) {
  const contactId = text(row.contact_id)
  if (contactId) return indexedKey(`contact:${contactId}`, 'identity')

  if (sourceKind === 'whatsapp') {
    if (text(row.phone)) return indexedKey(`phone:${text(row.phone)}`, 'identity')
    if (text(row.whatsapp_api_contact_id)) {
      return indexedKey(`whatsapp-profile:${text(row.whatsapp_api_contact_id)}`, 'identity')
    }
  }
  if (sourceKind === 'meta') {
    if (text(row.sender_id)) {
      return indexedKey(`meta:${text(row.platform || 'messenger')}:${text(row.sender_id)}`, 'identity')
    }
    if (text(row.meta_social_contact_id)) {
      return indexedKey(`meta-profile:${text(row.meta_social_contact_id)}`, 'identity')
    }
  }
  if (sourceKind === 'email' && text(row.from_email)) {
    return indexedKey(`email:${text(row.from_email).toLowerCase()}`, 'identity')
  }
  return indexedKey(`message:${text(row.id)}`, 'identity')
}

function normalizeWhatsAppSource(row) {
  const attributions = Array.isArray(row.attributions) ? row.attributions : []
  const signalParts = []
  for (const attribution of attributions) {
    signalParts.push(
      attribution.detected_source_url,
      attribution.detected_source_app,
      attribution.detected_entry_point,
      attribution.detected_source_type
    )
  }
  signalParts.push(
    row.detected_source_url,
    row.detected_source_app,
    row.detected_entry_point,
    row.detected_source_type,
    row.contact_attribution_url,
    row.contact_attribution_session_source,
    row.contact_attribution_medium,
    row.contact_source
  )
  const hasAttributedId = [
    ...attributions.flatMap(attribution => [attribution.detected_source_id, attribution.detected_ctwa_clid]),
    row.detected_source_id,
    row.detected_ctwa_clid,
    row.contact_attribution_ad_id,
    row.contact_attribution_ctwa_clid
  ].some(value => text(value))
  return classifiedSource(signalParts.filter(Boolean).join(' '), {
    attributedId: hasAttributedId,
    fallback: 'WhatsApp'
  })
}

function normalizeMetaSource(row) {
  const referral = text(row.referral_json).toLowerCase()
  const platform = text(row.platform).toLowerCase()
  if (referral.includes('instagram')) return 'Instagram'
  if (referral.includes('messenger') || referral.includes('m.me')) return 'Messenger'
  if (referral.includes('facebook')) return 'Facebook'
  if (referral.includes('audience_network') || referral.includes('audience network')) return 'Audience Network'
  if (platform.includes('instagram') || platform === 'ig') return 'Instagram'
  if (platform.includes('messenger')) return 'Messenger'
  if (platform.includes('facebook') || platform === 'fb') return 'Facebook'
  if (referral.includes('tiktok') || referral.includes('ttclid')) return 'TikTok'
  if (referral.includes('google') || referral.includes('gclid')) return 'Google'
  if (referral.includes('youtube') || referral.includes('youtu.be')) return 'YouTube'
  if (referral.includes('bing') || referral.includes('microsoft') || referral.includes('msclkid')) return 'Bing'
  if (referral.includes('linkedin') || referral.includes('lnkd')) return 'LinkedIn'
  if (referral.includes('source_id') || referral.includes('ad_id') || referral.includes('"source":"ads"')) return 'Meta Ads'
  return channelLabel(normalizeChannel(row.platform, 'messenger'))
}

function normalizeSourceFact(sourceKind, row, generation, timezone) {
  const contactId = text(row.contact_id) || null
  const directionFallback = sourceKind === 'email' ? 'outbound' : 'inbound'
  const incoming = text(row.direction || directionFallback).toLowerCase() === 'inbound'
  const occurredAt = normalizeToUtcIso(row.message_timestamp || row.created_at, 'UTC')
  const identity = normalizeIdentity(sourceKind, row)
  const included = Boolean(incoming && occurredAt && identity && Number.isFinite(Date.parse(occurredAt)))
  let channel = ''
  let source = ''
  if (sourceKind === 'whatsapp') {
    channel = 'whatsapp'
    source = normalizeWhatsAppSource(row)
  } else if (sourceKind === 'meta') {
    channel = normalizeChannel(row.platform, 'messenger')
    source = normalizeMetaSource(row)
  } else {
    channel = 'email'
    source = 'Email'
  }
  const attributed = sourceKind === 'whatsapp'
    ? !['WhatsApp', 'Directo', 'Desconocido', 'Otro'].includes(source)
    : (sourceKind === 'meta' && source === 'Meta Ads')

  return {
    generation,
    source_kind: sourceKind,
    source_message_id: text(row.id),
    projection_version: MESSAGE_ANALYTICS_PROJECTION_VERSION,
    included: includedValue(included),
    occurred_at: included ? occurredAt : null,
    business_date: included ? normalizeDateOnlyInTimezone(occurredAt, timezone) : null,
    identity_key: included ? indexedKey(identity, 'identity') : '',
    contact_id: contactId,
    contact_key: contactId ? indexedKey(contactId, 'contact') : '',
    channel: included ? channel : '',
    channel_label: included ? channelLabel(channel) : '',
    source: included ? source : '',
    attributed: includedValue(included && attributed)
  }
}

function normalizePhoneFact(row, generation, timezone) {
  const baseFact = normalizeSourceFact('whatsapp', row, generation, timezone)
  const businessPhoneNumberId = text(row.business_phone_number_id)
  const businessPhoneNumber = text(row.business_phone)
  const businessPhoneKey = indexedKey(
    businessPhoneNumberId || businessPhoneNumber,
    'business-phone'
  )
  const included = booleanValue(baseFact.included) && Boolean(businessPhoneKey)

  return {
    generation,
    source_message_id: text(row.id),
    projection_version: MESSAGE_ANALYTICS_PROJECTION_VERSION,
    included: includedValue(included),
    occurred_at: included ? baseFact.occurred_at : null,
    business_date: included ? baseFact.business_date : null,
    identity_key: included ? baseFact.identity_key : '',
    contact_id: baseFact.contact_id,
    contact_key: included ? baseFact.contact_key : '',
    business_phone_key: included ? businessPhoneKey : '',
    business_phone_number_id: included ? businessPhoneNumberId : '',
    business_phone_number: included ? businessPhoneNumber : ''
  }
}

function normalizeDatabaseFact(row) {
  if (!row) return null
  return {
    generation: Number(row.generation),
    source_kind: text(row.source_kind),
    source_message_id: text(row.source_message_id),
    projection_version: Number(row.projection_version),
    included: includedValue(booleanValue(row.included)),
    occurred_at: row.occurred_at ? normalizeToUtcIso(row.occurred_at, 'UTC') : null,
    business_date: row.business_date instanceof Date
      ? normalizeDateOnlyInTimezone(normalizeToUtcIso(row.business_date, 'UTC'), 'UTC')
      : (text(row.business_date) || null),
    identity_key: text(row.identity_key),
    contact_id: text(row.contact_id) || null,
    contact_key: text(row.contact_key),
    channel: text(row.channel),
    channel_label: text(row.channel_label),
    source: text(row.source),
    attributed: includedValue(booleanValue(row.attributed))
  }
}

function factsEqual(left, right) {
  if (!left || !right) return false
  return FACT_COLUMNS.every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

function phoneFactsEqual(left, right) {
  if (!left || !right) return false
  return PHONE_FACT_COLUMNS.every(column => String(left[column] ?? '') === String(right[column] ?? ''))
}

function normalizeDatabasePhoneFact(row) {
  if (!row) return null
  return {
    generation: Number(row.generation),
    source_message_id: text(row.source_message_id),
    projection_version: Number(row.projection_version),
    included: includedValue(booleanValue(row.included)),
    occurred_at: row.occurred_at ? normalizeToUtcIso(row.occurred_at, 'UTC') : null,
    business_date: row.business_date instanceof Date
      ? normalizeDateOnlyInTimezone(normalizeToUtcIso(row.business_date, 'UTC'), 'UTC')
      : (text(row.business_date) || null),
    identity_key: text(row.identity_key),
    contact_id: text(row.contact_id) || null,
    contact_key: text(row.contact_key),
    business_phone_key: text(row.business_phone_key),
    business_phone_number_id: text(row.business_phone_number_id),
    business_phone_number: text(row.business_phone_number)
  }
}

function isMissingProjectionSchema(error) {
  const code = text(error?.code).toUpperCase()
  if (['42P01', '42703', '42883'].includes(code)) return true
  return code === 'SQLITE_ERROR' && /no such (?:table|column):\s*message_analytics_/i.test(text(error?.message))
}

async function lockState(database) {
  return database.get(`
    SELECT *
    FROM message_analytics_projection_state
    WHERE singleton_id = ?
    ${databaseDialect === 'postgres' ? 'FOR UPDATE' : ''}
  `, [STATE_ID])
}

async function readProjectionStateForQuery(database, { signal, lock = false } = {}) {
  return database.get(`
    SELECT *
    FROM message_analytics_projection_state
    WHERE singleton_id = ?
    ${lock && databaseDialect === 'postgres' ? 'FOR SHARE' : ''}
  `, [STATE_ID], { signal })
}

export async function readMessageAnalyticsProjectionState(database = db, { signal } = {}) {
  try {
    return await database.get(`
      SELECT * FROM message_analytics_projection_state WHERE singleton_id = ?
    `, [STATE_ID], { signal })
  } catch (error) {
    if (isMissingProjectionSchema(error)) return null
    throw error
  }
}

async function getProjectionStatusFromDatabase(database, desiredTimezone, {
  schedule = false,
  signal,
  lock = false
} = {}) {
  let state
  try {
    state = await readProjectionStateForQuery(database, { signal, lock })
  } catch (error) {
    if (isMissingProjectionSchema(error)) state = null
    else throw error
  }
  if (!state) {
    return {
      schemaAvailable: false,
      available: false,
      ready: false,
      status: 'unavailable',
      activeGeneration: null,
      timezone: null
    }
  }
  const activeGeneration = Number(state.active_generation || 0) || null
  const activeMatches = Boolean(activeGeneration) &&
    Number(state.active_version) === MESSAGE_ANALYTICS_PROJECTION_VERSION &&
    text(state.active_timezone) === desiredTimezone
  let rangeMarker = null
  if (activeMatches) {
    try {
      rangeMarker = await database.get(`
          SELECT status FROM message_analytics_range_generation WHERE generation = ?
        `, [activeGeneration], { signal })
    } catch (error) {
      if (isMissingProjectionSchema(error)) {
        return {
          schemaAvailable: false,
          available: false,
          ready: false,
          status: 'unavailable',
          activeGeneration,
          timezone: desiredTimezone
        }
      }
      throw error
    }
  }
  const rangeReady = text(rangeMarker?.status).toLowerCase() === 'ready'
  const available = activeMatches && rangeReady
  const queueRow = available
    ? await database.get(`
        SELECT
          EXISTS(SELECT 1 FROM message_analytics_change_queue LIMIT 1) AS change_pending,
          EXISTS(SELECT 1 FROM message_analytics_contact_queue LIMIT 1) AS contact_pending
      `, [], { signal })
    : null
  const pending = booleanValue(queueRow?.change_pending) || booleanValue(queueRow?.contact_pending)
  const sourceStatus = text(state.status).toLowerCase() || 'backfilling'
  if (schedule && (!available || pending || state.building_generation)) {
    scheduleMessageAnalyticsProjectionBackfill()
  }
  return {
    schemaAvailable: true,
    available,
    ready: available && !pending && !state.building_generation && sourceStatus === 'ready',
    status: available
      ? (sourceStatus === 'failed'
          ? 'degraded'
          : (pending ? 'catching_up' : (state.building_generation ? 'rebuilding' : 'ready')))
      : (sourceStatus === 'failed' ? 'unavailable' : 'warming'),
    sourceStatus,
    activeGeneration,
    activeTimezone: state.active_timezone || null,
    rangeReady,
    buildingGeneration: Number(state.building_generation || 0) || null,
    timezone: desiredTimezone,
    pending,
    lastError: state.last_error || null
  }
}

export async function getMessageAnalyticsProjectionStatus({ range = null, schedule = false, signal } = {}) {
  const desiredTimezone = resolveTimezone(range?.appliedTimezone || await getAccountTimezone({ signal }))
  return getProjectionStatusFromDatabase(db, desiredTimezone, { schedule, signal })
}

async function withPinnedMessageAnalyticsGeneration(range, signal, operation, { schedule = true } = {}) {
  const desiredTimezone = resolveTimezone(range?.appliedTimezone || await getAccountTimezone({ signal }))
  if (databaseDialect !== 'postgres') {
    const status = await getProjectionStatusFromDatabase(db, desiredTimezone, { schedule, signal })
    return operation(db, status)
  }
  return db.transaction(async transaction => {
    // Los cuatro SELECT deben ver el mismo snapshot; FOR SHARE por sí solo fija
    // la generación, pero READ COMMITTED aún mezclaría revisiones del agregado.
    await transaction.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    // Cutover y GC toman FOR UPDATE sobre el mismo singleton y esperan.
    const status = await getProjectionStatusFromDatabase(transaction, desiredTimezone, {
      schedule,
      signal,
      lock: true
    })
    return operation(transaction, status)
  })
}

function projectionWarmingError(status) {
  const error = new Error('El resumen de mensajes sigue preparando su read model incremental.')
  error.code = 'message_analytics_projection_warming'
  error.status = 503
  error.retryable = true
  error.projectionStatus = status?.status || 'warming'
  return error
}

async function readWhatsAppRows(database, ids) {
  if (!ids.length) return []
  const rows = await database.all(`
    SELECT
      ${SOURCE_SELECT_COLUMNS.whatsapp.map(column => `msg.${column}`).join(',\n      ')},
      c.source AS contact_source,
      c.attribution_url AS contact_attribution_url,
      c.attribution_session_source AS contact_attribution_session_source,
      c.attribution_medium AS contact_attribution_medium,
      c.attribution_ctwa_clid AS contact_attribution_ctwa_clid,
      c.attribution_ad_id AS contact_attribution_ad_id,
      attr.id AS attr_id,
      attr.detected_source_id AS attr_detected_source_id,
      attr.detected_ctwa_clid AS attr_detected_ctwa_clid,
      attr.detected_source_url AS attr_detected_source_url,
      attr.detected_source_type AS attr_detected_source_type,
      attr.detected_source_app AS attr_detected_source_app,
      attr.detected_entry_point AS attr_detected_entry_point
    FROM whatsapp_api_messages msg
    LEFT JOIN contacts c ON c.id = msg.contact_id
    LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
    WHERE msg.id IN (${placeholders(ids)})
    ORDER BY msg.id ASC, attr.id ASC
  `, ids)
  const grouped = new Map()
  for (const row of rows) {
    const id = text(row.id)
    if (!grouped.has(id)) grouped.set(id, { ...row, attributions: [] })
    if (text(row.attr_id)) {
      grouped.get(id).attributions.push({
        id: row.attr_id,
        detected_source_id: row.attr_detected_source_id,
        detected_ctwa_clid: row.attr_detected_ctwa_clid,
        detected_source_url: row.attr_detected_source_url,
        detected_source_type: row.attr_detected_source_type,
        detected_source_app: row.attr_detected_source_app,
        detected_entry_point: row.attr_detected_entry_point
      })
    }
  }
  return [...grouped.values()]
}

async function readSourceRows(database, sourceKind, ids) {
  if (!ids.length) return []
  if (sourceKind === 'whatsapp') return readWhatsAppRows(database, ids)
  return database.all(`
    SELECT ${SOURCE_SELECT_COLUMNS[sourceKind].join(', ')}
    FROM ${SOURCE_TABLES[sourceKind]}
    WHERE id IN (${placeholders(ids)})
    ORDER BY id ASC
  `, ids)
}

async function readFacts(database, generation, keys) {
  if (!keys.length) return []
  const conditions = keys.map(() => '(source_kind = ? AND source_message_id = ?)').join(' OR ')
  return database.all(`
    SELECT ${FACT_COLUMNS.join(', ')}
    FROM message_analytics_fact
    WHERE generation = ? AND (${conditions})
  `, [generation, ...keys.flatMap(key => [key.sourceKind, key.sourceMessageId])])
}

async function readPhoneFacts(database, generation, keys) {
  const whatsappIds = keys
    .filter(key => key.sourceKind === 'whatsapp')
    .map(key => key.sourceMessageId)
  if (!whatsappIds.length) return []
  return database.all(`
    SELECT ${PHONE_FACT_COLUMNS.join(', ')}
    FROM message_analytics_phone_fact
    WHERE generation = ? AND source_message_id IN (${placeholders(whatsappIds)})
  `, [generation, ...whatsappIds])
}

function dailyParams(fact) {
  return DAILY_KEY_COLUMNS.map(column => fact[column])
}

async function recomputeDailyFirst(database, fact) {
  const first = await database.get(`
    SELECT occurred_at, source_kind, source_message_id
    FROM message_analytics_fact
    WHERE generation = ?
      AND business_date = ?
      AND channel = ?
      AND source = ?
      AND identity_key = ?
      AND contact_key = ?
      AND included = ${databaseDialect === 'postgres' ? 'TRUE' : '1'}
    ORDER BY occurred_at ASC, source_kind ASC, source_message_id ASC
    LIMIT 1
  `, dailyParams(fact))
  if (!first) return
  await database.run(`
    UPDATE message_analytics_daily_identity
    SET first_occurred_at = ?,
        first_source_kind = ?,
        first_source_message_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE generation = ?
      AND business_date = ?
      AND channel = ?
      AND source = ?
      AND identity_key = ?
      AND contact_key = ?
  `, [first.occurred_at, first.source_kind, first.source_message_id, ...dailyParams(fact)])
}

function dateOnlyValue(value) {
  if (value instanceof Date) {
    return normalizeDateOnlyInTimezone(normalizeToUtcIso(value, 'UTC'), 'UTC')
  }
  return text(value).slice(0, 10)
}

function nextBusinessDate(value) {
  if (!value || value === RANGE_ORIGIN) return RANGE_ORIGIN
  return DateTime.fromISO(dateOnlyValue(value), { zone: 'UTC' }).plus({ days: 1 }).toISODate()
}

function rangeScopeKey(scope) {
  return [scope.metric_kind, scope.scope_kind, scope.channel, scope.source].join('\u0000')
}

function addRangePresence(target, metricKind, scopeKind, channel = '', source = '') {
  if ((scopeKind === 'source' || scopeKind === 'channel_source') && !MESSAGE_ANALYTICS_SOURCE_SET.has(source)) {
    return
  }
  const scope = {
    metric_kind: metricKind,
    scope_kind: scopeKind,
    channel: scopeKind === 'channel' || scopeKind === 'channel_source' ? channel : '',
    source: scopeKind === 'source' || scopeKind === 'channel_source' ? source : ''
  }
  target.set(rangeScopeKey(scope), scope)
}

function rangePresenceFromDailyRows(rows) {
  const result = new Map()
  for (const row of rows || []) {
    if (Number(row.message_count || 0) <= 0) continue
    const channel = text(row.channel)
    const source = text(row.source)
    addRangePresence(result, 'conversation', 'all')
    addRangePresence(result, 'conversation', 'channel', channel)
    addRangePresence(result, 'conversation', 'source', '', source)
    addRangePresence(result, 'conversation', 'channel_source', channel, source)
    if (Number(row.attributed_message_count || 0) <= 0) continue
    addRangePresence(result, 'attributed', 'all')
    addRangePresence(result, 'attributed', 'channel', channel)
    addRangePresence(result, 'attributed', 'source', '', source)
    addRangePresence(result, 'attributed', 'channel_source', channel, source)
  }
  return result
}

async function readIdentityDateDailyRows(database, fact) {
  return database.all(`
    SELECT business_date, channel, source, identity_key, contact_id,
           message_count, attributed_message_count,
           first_occurred_at, first_source_kind, first_source_message_id
    FROM message_analytics_daily_identity
    WHERE generation = ? AND identity_key = ? AND business_date = ?
  `, [fact.generation, fact.identity_key, fact.business_date])
}

function rangeScopeSql(scope, alias = 'daily') {
  const conditions = []
  const params = []
  if (scope.metric_kind === 'attributed') conditions.push(`${alias}.attributed_message_count > 0`)
  if (scope.scope_kind === 'channel' || scope.scope_kind === 'channel_source') {
    conditions.push(`${alias}.channel = ?`)
    params.push(scope.channel)
  }
  if (scope.scope_kind === 'source' || scope.scope_kind === 'channel_source') {
    conditions.push(`${alias}.source = ?`)
    params.push(scope.source)
  }
  return { sql: conditions.length ? `AND ${conditions.join(' AND ')}` : '', params }
}

async function readRangeOccurrenceNeighbors(database, fact, scope) {
  const scoped = rangeScopeSql(scope)
  const baseParams = [fact.generation, fact.identity_key, fact.business_date, ...scoped.params]
  const row = await database.get(`
    SELECT
      (
        SELECT MAX(daily.business_date)
        FROM message_analytics_daily_identity daily
        WHERE daily.generation = ? AND daily.identity_key = ? AND daily.business_date < ?
          ${scoped.sql}
      ) AS previous_date,
      (
        SELECT MIN(daily.business_date)
        FROM message_analytics_daily_identity daily
        WHERE daily.generation = ? AND daily.identity_key = ? AND daily.business_date > ?
          ${scoped.sql}
      ) AS next_date
  `, [...baseParams, ...baseParams])
  return {
    previousDate: row?.previous_date ? dateOnlyValue(row.previous_date) : null,
    nextDate: row?.next_date ? dateOnlyValue(row.next_date) : null
  }
}

function addRangePoint(points, scope, startBoundary, occurrenceDate, delta, generation) {
  if (!delta) return
  const row = {
    generation,
    ...scope,
    start_boundary: startBoundary,
    occurrence_date: occurrenceDate,
    range_delta: delta
  }
  const key = [
    generation, rangeScopeKey(scope), startBoundary, occurrenceDate
  ].join('\u0000')
  const current = points.get(key)
  if (current) {
    current.range_delta += delta
    if (!current.range_delta) points.delete(key)
  } else {
    points.set(key, row)
  }
}

async function applyRangePointChanges(database, points) {
  if (!points.size) return
  const columns = [
    'generation', 'metric_kind', 'scope_kind', 'channel', 'source',
    'start_boundary', 'occurrence_date', 'range_delta'
  ]
  for (const batch of chunks([...points.values()])) {
    const valuesSql = batch.map(() => `(${columns.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`).join(', ')
    await database.run(`
      INSERT INTO message_analytics_range_delta (${columns.join(', ')}, updated_at)
      VALUES ${valuesSql}
      ON CONFLICT(
        generation, metric_kind, scope_kind, channel, source,
        start_boundary, occurrence_date
      ) DO UPDATE SET
        range_delta = message_analytics_range_delta.range_delta + excluded.range_delta,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(row => columns.map(column => row[column])))
    const exactPoints = batch.map(() => `(
      generation = ? AND metric_kind = ? AND scope_kind = ? AND channel = ? AND source = ?
      AND start_boundary = ? AND occurrence_date = ?
    )`).join(' OR ')
    await database.run(`
      DELETE FROM message_analytics_range_delta
      WHERE range_delta = 0 AND (${exactPoints})
    `, batch.flatMap(row => [
      row.generation, row.metric_kind, row.scope_kind, row.channel, row.source,
      row.start_boundary, row.occurrence_date
    ]))
  }
}

async function applyRangePresenceTransition(database, fact, scope, direction, points) {
  const { previousDate, nextDate } = await readRangeOccurrenceNeighbors(database, fact, scope)
  const occurrenceDate = dateOnlyValue(fact.business_date)
  const startBoundary = previousDate ? nextBusinessDate(previousDate) : RANGE_ORIGIN
  const afterOccurrence = nextBusinessDate(occurrenceDate)

  addRangePoint(points, scope, startBoundary, occurrenceDate, direction, fact.generation)
  addRangePoint(points, scope, afterOccurrence, occurrenceDate, -direction, fact.generation)
  if (nextDate) {
    addRangePoint(points, scope, startBoundary, nextDate, -direction, fact.generation)
    addRangePoint(points, scope, afterOccurrence, nextDate, direction, fact.generation)
  }
}

function originRowOrder(left, right) {
  return String(left.first_occurred_at).localeCompare(String(right.first_occurred_at)) ||
    text(left.first_source_kind).localeCompare(text(right.first_source_kind)) ||
    text(left.first_source_message_id).localeCompare(text(right.first_source_message_id)) ||
    text(left.source).localeCompare(text(right.source))
}

function firstOriginRow(rows) {
  return (rows || [])
    .filter(row => text(row.channel) === 'whatsapp' && Number(row.message_count || 0) > 0)
    .sort(originRowOrder)[0] || null
}

function originRangeScope(source) {
  return {
    metric_kind: 'origin',
    scope_kind: 'origin_source',
    channel: '',
    source: MESSAGE_ANALYTICS_SOURCE_SET.has(text(source)) ? text(source) : 'WhatsApp'
  }
}

async function readOriginOccurrenceNeighbors(database, fact) {
  const previous = await database.get(`
    SELECT MAX(daily.business_date) AS business_date
    FROM message_analytics_daily_identity daily
    WHERE daily.generation = ? AND daily.identity_key = ?
      AND daily.channel = 'whatsapp' AND daily.business_date < ?
  `, [fact.generation, fact.identity_key, fact.business_date])
  const next = await database.get(`
    SELECT daily.business_date, daily.source,
           daily.first_occurred_at, daily.first_source_kind, daily.first_source_message_id
    FROM message_analytics_daily_identity daily
    WHERE daily.generation = ? AND daily.identity_key = ?
      AND daily.channel = 'whatsapp' AND daily.business_date > ?
    ORDER BY daily.business_date ASC, daily.first_occurred_at ASC,
             daily.first_source_kind ASC, daily.first_source_message_id ASC, daily.source ASC
    LIMIT 1
  `, [fact.generation, fact.identity_key, fact.business_date])
  return {
    previousDate: previous?.business_date ? dateOnlyValue(previous.business_date) : null,
    next: next
      ? { businessDate: dateOnlyValue(next.business_date), source: text(next.source) || 'WhatsApp' }
      : null
  }
}

async function syncOriginRangeAfterDailyMutation(database, fact, beforeRows, afterRows) {
  const before = firstOriginRow(beforeRows)
  const after = firstOriginRow(afterRows)
  const beforeSource = before ? (text(before.source) || 'WhatsApp') : null
  const afterSource = after ? (text(after.source) || 'WhatsApp') : null
  if (beforeSource === afterSource) return

  const { previousDate, next } = await readOriginOccurrenceNeighbors(database, fact)
  const occurrenceDate = dateOnlyValue(fact.business_date)
  const startBoundary = previousDate ? nextBusinessDate(previousDate) : RANGE_ORIGIN
  const afterOccurrence = nextBusinessDate(occurrenceDate)
  const points = new Map()

  if (beforeSource && afterSource) {
    addRangePoint(points, originRangeScope(beforeSource), startBoundary, occurrenceDate, -1, fact.generation)
    addRangePoint(points, originRangeScope(beforeSource), afterOccurrence, occurrenceDate, 1, fact.generation)
    addRangePoint(points, originRangeScope(afterSource), startBoundary, occurrenceDate, 1, fact.generation)
    addRangePoint(points, originRangeScope(afterSource), afterOccurrence, occurrenceDate, -1, fact.generation)
  } else {
    const direction = afterSource ? 1 : -1
    const source = afterSource || beforeSource
    addRangePoint(points, originRangeScope(source), startBoundary, occurrenceDate, direction, fact.generation)
    addRangePoint(points, originRangeScope(source), afterOccurrence, occurrenceDate, -direction, fact.generation)
    if (next) {
      addRangePoint(points, originRangeScope(next.source), startBoundary, next.businessDate, -direction, fact.generation)
      addRangePoint(points, originRangeScope(next.source), afterOccurrence, next.businessDate, direction, fact.generation)
    }
  }
  await applyRangePointChanges(database, points)
}

async function syncRangePresenceAfterDailyMutation(database, fact, beforeRows) {
  const before = rangePresenceFromDailyRows(beforeRows)
  const afterRows = await readIdentityDateDailyRows(database, fact)
  const after = rangePresenceFromDailyRows(afterRows)
  const transitions = []
  for (const [key, scope] of before.entries()) {
    if (!after.has(key)) transitions.push({ scope, direction: -1 })
  }
  for (const [key, scope] of after.entries()) {
    if (!before.has(key)) transitions.push({ scope, direction: 1 })
  }
  const points = new Map()
  for (const transition of transitions) {
    await applyRangePresenceTransition(database, fact, transition.scope, transition.direction, points)
  }
  await applyRangePointChanges(database, points)
  await syncOriginRangeAfterDailyMutation(database, fact, beforeRows, afterRows)
}

async function updateDailyMessageRollup(database, fact, delta) {
  if (!delta) return
  if (delta > 0) {
    await database.run(`
      INSERT INTO message_analytics_daily_rollup (
        generation, business_date, channel, source, message_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(generation, business_date, channel, source) DO UPDATE SET
        message_count = message_analytics_daily_rollup.message_count + excluded.message_count,
        updated_at = CURRENT_TIMESTAMP
    `, [fact.generation, fact.business_date, fact.channel, fact.source, delta])
  } else {
    const result = await database.run(`
      UPDATE message_analytics_daily_rollup
      SET message_count = message_count + ?, updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND business_date = ? AND channel = ? AND source = ?
        AND message_count + ? >= 0
    `, [delta, fact.generation, fact.business_date, fact.channel, fact.source, delta])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(new Error('El contador diario de mensajes perdió sincronía con su ledger.'), {
        code: 'MESSAGE_ANALYTICS_RANGE_ROLLUP_DRIFT'
      })
    }
  }
  await database.run(`
    DELETE FROM message_analytics_daily_rollup
    WHERE generation = ? AND business_date = ? AND channel = ? AND source = ?
      AND message_count = 0
  `, [fact.generation, fact.business_date, fact.channel, fact.source])
}

async function isRangeGenerationReady(database, generation) {
  if (!generation) return false
  const row = await database.get(`
    SELECT status FROM message_analytics_range_generation WHERE generation = ?
  `, [generation])
  return text(row?.status).toLowerCase() === 'ready'
}

async function decrementDailyAggregates(database, facts, { maintainRange = false } = {}) {
  const aggregates = aggregateDailyFacts(facts)
  for (const fact of aggregates) {
    const beforeRows = maintainRange ? await readIdentityDateDailyRows(database, fact) : null
    const result = await database.run(`
      UPDATE message_analytics_daily_identity
      SET message_count = message_count - ?,
          attributed_message_count = attributed_message_count - ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation = ?
        AND business_date = ?
        AND channel = ?
        AND source = ?
        AND identity_key = ?
        AND contact_key = ?
    `, [fact.message_count, fact.attributed_message_count, ...dailyParams(fact)])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(new Error(`Falta el agregado diario de ${fact.source_kind}:${fact.source_message_id}`), {
        code: 'MESSAGE_ANALYTICS_DAILY_MISSING'
      })
    }
    await database.run(`
      DELETE FROM message_analytics_daily_identity
      WHERE generation = ?
        AND business_date = ?
        AND channel = ?
        AND source = ?
        AND identity_key = ?
        AND contact_key = ?
        AND message_count = 0
    `, dailyParams(fact))
    const remaining = await database.get(`
      SELECT message_count
      FROM message_analytics_daily_identity
      WHERE generation = ?
        AND business_date = ?
        AND channel = ?
        AND source = ?
        AND identity_key = ?
        AND contact_key = ?
    `, dailyParams(fact))
    if (remaining) await recomputeDailyFirst(database, fact)
    if (maintainRange) {
      await updateDailyMessageRollup(database, fact, -fact.message_count)
      await syncRangePresenceAfterDailyMutation(database, fact, beforeRows)
    }
  }
}

async function writeFacts(database, facts) {
  for (const batch of chunks(facts)) {
    const valuesSql = batch.map(() =>
      `(${FACT_COLUMNS.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`
    ).join(', ')
    await database.run(`
      INSERT INTO message_analytics_fact (${FACT_COLUMNS.join(', ')}, updated_at)
      VALUES ${valuesSql}
    ON CONFLICT(generation, source_kind, source_message_id) DO UPDATE SET
      projection_version = excluded.projection_version,
      included = excluded.included,
      occurred_at = excluded.occurred_at,
      business_date = excluded.business_date,
      identity_key = excluded.identity_key,
      contact_id = excluded.contact_id,
      contact_key = excluded.contact_key,
      channel = excluded.channel,
      channel_label = excluded.channel_label,
      source = excluded.source,
      attributed = excluded.attributed,
      updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(fact => FACT_COLUMNS.map(column => fact[column])))
  }
}

function dailyAggregateKey(fact) {
  return DAILY_KEY_COLUMNS.map(column => String(fact[column] ?? '')).join('\u0000')
}

function compareFactOrder(left, right) {
  return String(left.occurred_at).localeCompare(String(right.occurred_at)) ||
    String(left.source_kind).localeCompare(String(right.source_kind)) ||
    String(left.source_message_id).localeCompare(String(right.source_message_id))
}

function aggregateDailyFacts(facts) {
  const aggregates = new Map()
  for (const fact of facts) {
    const key = dailyAggregateKey(fact)
    const current = aggregates.get(key)
    if (!current) {
      aggregates.set(key, {
        ...fact,
        message_count: 1,
        attributed_message_count: booleanValue(fact.attributed) ? 1 : 0
      })
      continue
    }
    current.message_count += 1
    current.attributed_message_count += booleanValue(fact.attributed) ? 1 : 0
    if (compareFactOrder(fact, current) < 0) {
      current.occurred_at = fact.occurred_at
      current.source_kind = fact.source_kind
      current.source_message_id = fact.source_message_id
    }
  }
  return [...aggregates.values()]
}

async function incrementDailyAggregates(database, aggregates, { maintainRange = false } = {}) {
  if (maintainRange) {
    for (const fact of aggregates) {
      const beforeRows = await readIdentityDateDailyRows(database, fact)
      await database.run(`
        INSERT INTO message_analytics_daily_identity (
          generation, business_date, channel, source, identity_key, contact_key,
          contact_id, channel_label, message_count, attributed_message_count,
          first_occurred_at, first_source_kind, first_source_message_id, updated_at
        ) VALUES (${Array.from({ length: 13 }, () => '?').join(', ')}, CURRENT_TIMESTAMP)
        ON CONFLICT(generation, business_date, channel, source, identity_key, contact_key) DO UPDATE SET
          message_count = message_analytics_daily_identity.message_count + excluded.message_count,
          attributed_message_count = message_analytics_daily_identity.attributed_message_count + excluded.attributed_message_count,
          contact_id = excluded.contact_id,
          channel_label = excluded.channel_label,
          first_occurred_at = CASE
            WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_occurred_at
            WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
              AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
                OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                  AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
              THEN excluded.first_occurred_at
            ELSE message_analytics_daily_identity.first_occurred_at
          END,
          first_source_kind = CASE
            WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_source_kind
            WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
              AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
                OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                  AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
              THEN excluded.first_source_kind
            ELSE message_analytics_daily_identity.first_source_kind
          END,
          first_source_message_id = CASE
            WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_source_message_id
            WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
              AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
                OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                  AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
              THEN excluded.first_source_message_id
            ELSE message_analytics_daily_identity.first_source_message_id
          END,
          updated_at = CURRENT_TIMESTAMP
      `, [
        ...dailyParams(fact), fact.contact_id, fact.channel_label,
        fact.message_count, fact.attributed_message_count, fact.occurred_at,
        fact.source_kind, fact.source_message_id
      ])
      await updateDailyMessageRollup(database, fact, fact.message_count)
      await syncRangePresenceAfterDailyMutation(database, fact, beforeRows)
    }
    return
  }
  for (const batch of chunks(aggregates)) {
    const valuesSql = batch.map(() =>
      `(${Array.from({ length: 13 }, () => '?').join(', ')}, CURRENT_TIMESTAMP)`
    ).join(', ')
    await database.run(`
      INSERT INTO message_analytics_daily_identity (
        generation, business_date, channel, source, identity_key, contact_key,
        contact_id, channel_label, message_count, attributed_message_count,
        first_occurred_at, first_source_kind, first_source_message_id, updated_at
      ) VALUES ${valuesSql}
      ON CONFLICT(generation, business_date, channel, source, identity_key, contact_key) DO UPDATE SET
        message_count = message_analytics_daily_identity.message_count + excluded.message_count,
        attributed_message_count = message_analytics_daily_identity.attributed_message_count + excluded.attributed_message_count,
        contact_id = excluded.contact_id,
        channel_label = excluded.channel_label,
        first_occurred_at = CASE
          WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_occurred_at
          WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
            AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
              OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
            THEN excluded.first_occurred_at
          ELSE message_analytics_daily_identity.first_occurred_at
        END,
        first_source_kind = CASE
          WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_source_kind
          WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
            AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
              OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
            THEN excluded.first_source_kind
          ELSE message_analytics_daily_identity.first_source_kind
        END,
        first_source_message_id = CASE
          WHEN excluded.first_occurred_at < message_analytics_daily_identity.first_occurred_at THEN excluded.first_source_message_id
          WHEN excluded.first_occurred_at = message_analytics_daily_identity.first_occurred_at
            AND (excluded.first_source_kind < message_analytics_daily_identity.first_source_kind
              OR (excluded.first_source_kind = message_analytics_daily_identity.first_source_kind
                AND excluded.first_source_message_id < message_analytics_daily_identity.first_source_message_id))
            THEN excluded.first_source_message_id
          ELSE message_analytics_daily_identity.first_source_message_id
        END,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(fact => [
      ...dailyParams(fact), fact.contact_id, fact.channel_label,
      fact.message_count, fact.attributed_message_count, fact.occurred_at,
      fact.source_kind, fact.source_message_id
    ]))
  }
}

function phoneDailyParams(fact) {
  return PHONE_DAILY_KEY_COLUMNS.map(column => fact[column])
}

function phoneMetadataParams(fact) {
  return PHONE_METADATA_KEY_COLUMNS.map(column => fact[column])
}

function aggregatePhoneFacts(facts) {
  const daily = new Map()
  const metadata = new Map()
  for (const fact of facts) {
    if (!fact || !booleanValue(fact.included) || !text(fact.business_phone_key)) continue
    const dailyKey = PHONE_DAILY_KEY_COLUMNS.map(column => String(fact[column] ?? '')).join('\u0000')
    const currentDaily = daily.get(dailyKey)
    if (currentDaily) currentDaily.message_count += 1
    else daily.set(dailyKey, { ...fact, message_count: 1 })

    const metadataKey = PHONE_METADATA_KEY_COLUMNS
      .map(column => String(fact[column] ?? ''))
      .join('\u0000')
    const currentMetadata = metadata.get(metadataKey)
    if (currentMetadata) currentMetadata.message_count += 1
    else metadata.set(metadataKey, { ...fact, message_count: 1 })
  }
  return { daily: [...daily.values()], metadata: [...metadata.values()] }
}

async function writePhoneFacts(database, facts) {
  for (const batch of chunks(facts)) {
    const valuesSql = batch.map(() =>
      `(${PHONE_FACT_COLUMNS.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`
    ).join(', ')
    await database.run(`
      INSERT INTO message_analytics_phone_fact (${PHONE_FACT_COLUMNS.join(', ')}, updated_at)
      VALUES ${valuesSql}
      ON CONFLICT(generation, source_message_id) DO UPDATE SET
        projection_version = excluded.projection_version,
        included = excluded.included,
        occurred_at = excluded.occurred_at,
        business_date = excluded.business_date,
        identity_key = excluded.identity_key,
        contact_id = excluded.contact_id,
        contact_key = excluded.contact_key,
        business_phone_key = excluded.business_phone_key,
        business_phone_number_id = excluded.business_phone_number_id,
        business_phone_number = excluded.business_phone_number,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(fact => PHONE_FACT_COLUMNS.map(column => fact[column])))
  }
}

async function deletePhoneFacts(database, generation, facts) {
  const ids = facts.map(fact => fact.source_message_id).filter(Boolean)
  for (const batch of chunks(ids)) {
    await database.run(`
      DELETE FROM message_analytics_phone_fact
      WHERE generation = ? AND source_message_id IN (${placeholders(batch)})
    `, [generation, ...batch])
  }
}

async function readPhoneIdentityDateRows(database, fact) {
  return database.all(`
    SELECT contact_id, message_count
    FROM message_analytics_daily_phone_identity
    WHERE generation = ? AND business_date = ? AND business_phone_key = ?
      AND identity_key = ?
  `, [fact.generation, fact.business_date, fact.business_phone_key, fact.identity_key])
}

async function readPhoneOccurrenceNeighbors(database, fact) {
  const params = [
    fact.generation,
    fact.business_phone_key,
    fact.identity_key,
    fact.business_date
  ]
  const row = await database.get(`
    SELECT
      (
        SELECT MAX(phone_daily.business_date)
        FROM message_analytics_daily_phone_identity phone_daily
        WHERE phone_daily.generation = ? AND phone_daily.business_phone_key = ?
          AND phone_daily.identity_key = ? AND phone_daily.business_date < ?
      ) AS previous_date,
      (
        SELECT MIN(phone_daily.business_date)
        FROM message_analytics_daily_phone_identity phone_daily
        WHERE phone_daily.generation = ? AND phone_daily.business_phone_key = ?
          AND phone_daily.identity_key = ? AND phone_daily.business_date > ?
      ) AS next_date
  `, [...params, ...params])
  return {
    previousDate: row?.previous_date ? dateOnlyValue(row.previous_date) : null,
    nextDate: row?.next_date ? dateOnlyValue(row.next_date) : null
  }
}

function addPhoneRangePoint(points, fact, startBoundary, occurrenceDate, delta) {
  if (!delta) return
  const key = [
    fact.generation,
    fact.business_phone_key,
    startBoundary,
    occurrenceDate
  ].join('\u0000')
  const current = points.get(key)
  if (current) {
    current.range_delta += delta
    if (!current.range_delta) points.delete(key)
    return
  }
  points.set(key, {
    generation: fact.generation,
    business_phone_key: fact.business_phone_key,
    start_boundary: startBoundary,
    occurrence_date: occurrenceDate,
    range_delta: delta
  })
}

async function applyPhoneRangePointChanges(database, points) {
  if (!points.size) return
  const columns = [
    'generation', 'business_phone_key', 'start_boundary',
    'occurrence_date', 'range_delta'
  ]
  for (const batch of chunks([...points.values()])) {
    const valuesSql = batch.map(() =>
      `(${columns.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`
    ).join(', ')
    await database.run(`
      INSERT INTO message_analytics_phone_range_delta (${columns.join(', ')}, updated_at)
      VALUES ${valuesSql}
      ON CONFLICT(
        generation, business_phone_key, start_boundary, occurrence_date
      ) DO UPDATE SET
        range_delta = message_analytics_phone_range_delta.range_delta + excluded.range_delta,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(row => columns.map(column => row[column])))
    const exactPoints = batch.map(() => `(
      generation = ? AND business_phone_key = ?
      AND start_boundary = ? AND occurrence_date = ?
    )`).join(' OR ')
    await database.run(`
      DELETE FROM message_analytics_phone_range_delta
      WHERE range_delta = 0 AND (${exactPoints})
    `, batch.flatMap(row => [
      row.generation,
      row.business_phone_key,
      row.start_boundary,
      row.occurrence_date
    ]))
  }
}

async function syncPhoneRangeAfterDailyMutation(database, fact, beforeRows) {
  const beforePresent = beforeRows.some(row => Number(row.message_count || 0) > 0)
  const afterRows = await readPhoneIdentityDateRows(database, fact)
  const afterPresent = afterRows.some(row => Number(row.message_count || 0) > 0)
  if (beforePresent === afterPresent) return

  const { previousDate, nextDate } = await readPhoneOccurrenceNeighbors(database, fact)
  const occurrenceDate = dateOnlyValue(fact.business_date)
  const startBoundary = previousDate ? nextBusinessDate(previousDate) : RANGE_ORIGIN
  const afterOccurrence = nextBusinessDate(occurrenceDate)
  const direction = afterPresent ? 1 : -1
  const points = new Map()
  addPhoneRangePoint(points, fact, startBoundary, occurrenceDate, direction)
  addPhoneRangePoint(points, fact, afterOccurrence, occurrenceDate, -direction)
  if (nextDate) {
    addPhoneRangePoint(points, fact, startBoundary, nextDate, -direction)
    addPhoneRangePoint(points, fact, afterOccurrence, nextDate, direction)
  }
  await applyPhoneRangePointChanges(database, points)
}

async function incrementPhoneMetadata(database, rows) {
  for (const batch of chunks(rows)) {
    const valuesSql = batch.map(() =>
      `(${Array.from({ length: 6 }, () => '?').join(', ')}, CURRENT_TIMESTAMP)`
    ).join(', ')
    await database.run(`
      INSERT INTO message_analytics_daily_phone_metadata (
        generation, business_date, business_phone_key,
        business_phone_number_id, business_phone_number,
        message_count, updated_at
      ) VALUES ${valuesSql}
      ON CONFLICT(
        generation, business_date, business_phone_key,
        business_phone_number_id, business_phone_number
      ) DO UPDATE SET
        message_count = message_analytics_daily_phone_metadata.message_count + excluded.message_count,
        updated_at = CURRENT_TIMESTAMP
    `, batch.flatMap(fact => [...phoneMetadataParams(fact), fact.message_count]))
  }
}

async function decrementPhoneMetadata(database, rows) {
  for (const fact of rows) {
    const result = await database.run(`
      UPDATE message_analytics_daily_phone_metadata
      SET message_count = message_count - ?, updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND business_date = ? AND business_phone_key = ?
        AND business_phone_number_id = ? AND business_phone_number = ?
        AND message_count - ? >= 0
    `, [fact.message_count, ...phoneMetadataParams(fact), fact.message_count])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(new Error('La metadata diaria por numero perdio sincronía con su ledger.'), {
        code: 'MESSAGE_ANALYTICS_PHONE_METADATA_DRIFT'
      })
    }
    await database.run(`
      DELETE FROM message_analytics_daily_phone_metadata
      WHERE generation = ? AND business_date = ? AND business_phone_key = ?
        AND business_phone_number_id = ? AND business_phone_number = ?
        AND message_count = 0
    `, phoneMetadataParams(fact))
  }
}

async function incrementPhoneAggregates(database, facts, { maintainRange = false } = {}) {
  const aggregates = aggregatePhoneFacts(facts)
  if (maintainRange) {
    for (const fact of aggregates.daily) {
      const beforeRows = await readPhoneIdentityDateRows(database, fact)
      await database.run(`
        INSERT INTO message_analytics_daily_phone_identity (
          generation, business_date, business_phone_key, identity_key,
          contact_key, contact_id, message_count, updated_at
        ) VALUES (${Array.from({ length: 7 }, () => '?').join(', ')}, CURRENT_TIMESTAMP)
        ON CONFLICT(
          generation, business_date, business_phone_key, identity_key, contact_key
        ) DO UPDATE SET
          contact_id = excluded.contact_id,
          message_count = message_analytics_daily_phone_identity.message_count + excluded.message_count,
          updated_at = CURRENT_TIMESTAMP
      `, [...phoneDailyParams(fact), fact.contact_id, fact.message_count])
      await syncPhoneRangeAfterDailyMutation(database, fact, beforeRows)
    }
  } else {
    for (const batch of chunks(aggregates.daily)) {
      const valuesSql = batch.map(() =>
        `(${Array.from({ length: 7 }, () => '?').join(', ')}, CURRENT_TIMESTAMP)`
      ).join(', ')
      await database.run(`
        INSERT INTO message_analytics_daily_phone_identity (
          generation, business_date, business_phone_key, identity_key,
          contact_key, contact_id, message_count, updated_at
        ) VALUES ${valuesSql}
        ON CONFLICT(
          generation, business_date, business_phone_key, identity_key, contact_key
        ) DO UPDATE SET
          contact_id = excluded.contact_id,
          message_count = message_analytics_daily_phone_identity.message_count + excluded.message_count,
          updated_at = CURRENT_TIMESTAMP
      `, batch.flatMap(fact => [...phoneDailyParams(fact), fact.contact_id, fact.message_count]))
    }
  }
  await incrementPhoneMetadata(database, aggregates.metadata)
}

async function decrementPhoneAggregates(database, facts, { maintainRange = false } = {}) {
  const aggregates = aggregatePhoneFacts(facts)
  for (const fact of aggregates.daily) {
    const beforeRows = maintainRange ? await readPhoneIdentityDateRows(database, fact) : null
    const result = await database.run(`
      UPDATE message_analytics_daily_phone_identity
      SET message_count = message_count - ?, updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND business_date = ? AND business_phone_key = ?
        AND identity_key = ? AND contact_key = ?
        AND message_count - ? >= 0
    `, [fact.message_count, ...phoneDailyParams(fact), fact.message_count])
    if (Number(result?.changes || 0) !== 1) {
      throw Object.assign(new Error('El agregado diario por numero perdio sincronía con su ledger.'), {
        code: 'MESSAGE_ANALYTICS_PHONE_DAILY_DRIFT'
      })
    }
    await database.run(`
      DELETE FROM message_analytics_daily_phone_identity
      WHERE generation = ? AND business_date = ? AND business_phone_key = ?
        AND identity_key = ? AND contact_key = ? AND message_count = 0
    `, phoneDailyParams(fact))
    if (maintainRange) await syncPhoneRangeAfterDailyMutation(database, fact, beforeRows)
  }
  await decrementPhoneMetadata(database, aggregates.metadata)
}

async function deleteFacts(database, generation, keys) {
  for (const batch of chunks(keys)) {
    const conditions = batch.map(() => '(source_kind = ? AND source_message_id = ?)').join(' OR ')
    await database.run(`
      DELETE FROM message_analytics_fact
      WHERE generation = ? AND (${conditions})
    `, [generation, ...batch.flatMap(key => [key.sourceKind, key.sourceMessageId])])
  }
}

async function enqueueGenerationGc(database, generation, { immediate = false } = {}) {
  if (!generation) return
  const eligibleExpression = immediate
    ? 'CURRENT_TIMESTAMP'
    : (databaseDialect === 'postgres'
        ? `CURRENT_TIMESTAMP + INTERVAL '1 hour'`
        : `DATETIME(CURRENT_TIMESTAMP, '+3600 seconds')`)
  await database.run(`
    INSERT INTO message_analytics_generation_gc(generation, eligible_at, enqueued_at)
    VALUES (?, ${eligibleExpression}, CURRENT_TIMESTAMP)
    ON CONFLICT(generation) DO UPDATE SET
      eligible_at = CASE
        WHEN excluded.eligible_at < message_analytics_generation_gc.eligible_at
          THEN excluded.eligible_at
        ELSE message_analytics_generation_gc.eligible_at
      END
  `, [generation])
}

async function projectKeysForGeneration(database, generation, timezone, keys) {
  if (!generation || !keys.length) return { projected: 0, changed: 0 }
  const maintainRange = await isRangeGenerationReady(database, generation)
  const oldFacts = (await readFacts(database, generation, keys)).map(normalizeDatabaseFact)
  const oldByKey = new Map(oldFacts.map(fact => [`${fact.source_kind}\u0000${fact.source_message_id}`, fact]))
  const oldPhoneFacts = (await readPhoneFacts(database, generation, keys)).map(normalizeDatabasePhoneFact)
  const oldPhoneById = new Map(oldPhoneFacts.map(fact => [fact.source_message_id, fact]))
  const sourceByKey = new Map()
  for (const sourceKind of SOURCE_KINDS) {
    const ids = keys.filter(key => key.sourceKind === sourceKind).map(key => key.sourceMessageId)
    for (const row of await readSourceRows(database, sourceKind, ids)) {
      sourceByKey.set(`${sourceKind}\u0000${text(row.id)}`, row)
    }
  }

  const changedEntries = []
  const changedPhoneEntries = []
  const changedKeys = new Set()
  for (const key of keys) {
    const mapKey = `${key.sourceKind}\u0000${key.sourceMessageId}`
    const oldFact = oldByKey.get(mapKey) || null
    const sourceRow = sourceByKey.get(mapKey) || null
    const nextFact = sourceRow ? normalizeSourceFact(key.sourceKind, sourceRow, generation, timezone) : null
    if (!factsEqual(oldFact, nextFact)) {
      changedEntries.push({ key, oldFact, nextFact })
      changedKeys.add(mapKey)
    }
    if (key.sourceKind !== 'whatsapp') continue
    const oldPhoneFact = oldPhoneById.get(key.sourceMessageId) || null
    const nextPhoneFact = sourceRow ? normalizePhoneFact(sourceRow, generation, timezone) : null
    if (phoneFactsEqual(oldPhoneFact, nextPhoneFact)) continue
    changedPhoneEntries.push({ key, oldFact: oldPhoneFact, nextFact: nextPhoneFact })
    changedKeys.add(mapKey)
  }
  if (!changedKeys.size) return { projected: keys.length, changed: 0 }

  await writeFacts(database, changedEntries.map(entry => entry.nextFact).filter(Boolean))
  await deleteFacts(database, generation, changedEntries
    .filter(entry => entry.oldFact && !entry.nextFact)
    .map(entry => entry.key))
  await writePhoneFacts(database, changedPhoneEntries.map(entry => entry.nextFact).filter(Boolean))
  await deletePhoneFacts(database, generation, changedPhoneEntries
    .filter(entry => entry.oldFact && !entry.nextFact)
    .map(entry => entry.oldFact))
  await decrementDailyAggregates(database, changedEntries
    .map(entry => entry.oldFact)
    .filter(fact => fact && booleanValue(fact.included)), { maintainRange })
  const dailyAdds = changedEntries
    .map(entry => entry.nextFact)
    .filter(fact => fact && booleanValue(fact.included))
  await incrementDailyAggregates(database, aggregateDailyFacts(dailyAdds), { maintainRange })
  await decrementPhoneAggregates(database, changedPhoneEntries
    .map(entry => entry.oldFact)
    .filter(fact => fact && booleanValue(fact.included)), { maintainRange })
  await incrementPhoneAggregates(database, changedPhoneEntries
    .map(entry => entry.nextFact)
    .filter(fact => fact && booleanValue(fact.included)), { maintainRange })
  return { projected: keys.length, changed: changedKeys.size }
}

async function ensureBuildingGeneration(database, timezone) {
  const current = await readMessageAnalyticsProjectionState(database)
  const activeCurrent = Number(current?.active_generation || 0) > 0 &&
    Number(current?.active_version) === MESSAGE_ANALYTICS_PROJECTION_VERSION &&
    text(current?.active_timezone) === timezone
  if (activeCurrent && !current?.building_generation) return current

  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    if (!state) return null
    const activeCurrent = Number(state.active_generation || 0) > 0 &&
      Number(state.active_version) === MESSAGE_ANALYTICS_PROJECTION_VERSION &&
      text(state.active_timezone) === timezone
    if (activeCurrent && !state.building_generation) return state
    const buildingCurrent = Number(state.building_generation || 0) > 0 &&
      Number(state.building_version) === MESSAGE_ANALYTICS_PROJECTION_VERSION &&
      text(state.building_timezone) === timezone
    if (buildingCurrent) return state

    const nextGeneration = Math.max(
      Number(state.active_generation || 0),
      Number(state.building_generation || 0)
    ) + 1
    if (Number(state.building_generation || 0)) {
      await enqueueGenerationGc(transaction, Number(state.building_generation), { immediate: true })
    }
    await transaction.run(`
      INSERT INTO message_analytics_range_generation(generation, status, built_at, updated_at)
      VALUES (?, 'building', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(generation) DO UPDATE SET
        status = 'building', built_at = NULL, updated_at = CURRENT_TIMESTAMP
    `, [nextGeneration])
    await transaction.run('UPDATE message_analytics_change_queue SET building_applied_revision = 0')
    await transaction.run(`
      UPDATE message_analytics_projection_state
      SET projection_version = ?,
          status = 'backfilling',
          building_generation = ?,
          building_version = ?,
          building_timezone = ?,
          whatsapp_cursor = '', meta_cursor = '', email_cursor = '',
          whatsapp_complete = ?, meta_complete = ?, email_complete = ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [
      MESSAGE_ANALYTICS_PROJECTION_VERSION,
      nextGeneration,
      MESSAGE_ANALYTICS_PROJECTION_VERSION,
      timezone,
      includedValue(false), includedValue(false), includedValue(false),
      STATE_ID
    ])
    return {
      ...state,
      status: 'backfilling',
      building_generation: nextGeneration,
      building_version: MESSAGE_ANALYTICS_PROJECTION_VERSION,
      building_timezone: timezone,
      whatsapp_cursor: '', meta_cursor: '', email_cursor: '',
      whatsapp_complete: includedValue(false),
      meta_complete: includedValue(false),
      email_complete: includedValue(false)
    }
  })
}

async function processContactDependencyBatch(database, batchSize = CONTACT_BATCH_SIZE) {
  return database.transaction(async transaction => {
    const dependency = await transaction.get(`
      SELECT contact_id, revision, cursor_message_id
      FROM message_analytics_contact_queue
      ORDER BY enqueued_at ASC, contact_id ASC
      LIMIT 1
    `)
    if (!dependency) return { processed: 0, empty: true }
    const rows = await transaction.all(`
      SELECT id
      FROM whatsapp_api_messages
      WHERE contact_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `, [dependency.contact_id, dependency.cursor_message_id || '', batchSize])
    for (const row of rows) {
      await transaction.run(`
        INSERT INTO message_analytics_change_queue(source_kind, source_message_id, revision, enqueued_at)
        VALUES ('whatsapp', ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(source_kind, source_message_id) DO UPDATE SET
          revision = message_analytics_change_queue.revision + 1,
          enqueued_at = CURRENT_TIMESTAMP
      `, [row.id])
    }
    if (rows.length < batchSize) {
      await transaction.run(`
        DELETE FROM message_analytics_contact_queue
        WHERE contact_id = ? AND revision = ?
      `, [dependency.contact_id, dependency.revision])
    } else {
      await transaction.run(`
        UPDATE message_analytics_contact_queue
        SET cursor_message_id = ?, enqueued_at = CURRENT_TIMESTAMP
        WHERE contact_id = ? AND revision = ?
      `, [rows.at(-1).id, dependency.contact_id, dependency.revision])
    }
    return { processed: rows.length, empty: false }
  })
}

async function markProjectionReadyIfCaughtUp(database) {
  const current = await database.get(`
    SELECT status, active_generation, building_generation,
      EXISTS(SELECT 1 FROM message_analytics_change_queue LIMIT 1) AS change_pending,
      EXISTS(SELECT 1 FROM message_analytics_contact_queue LIMIT 1) AS contact_pending
    FROM message_analytics_projection_state
    WHERE singleton_id = ?
  `, [STATE_ID])
  const pending = booleanValue(current?.change_pending) || booleanValue(current?.contact_pending)
  const ready = Number(current?.active_generation || 0) > 0 && !current?.building_generation && !pending
  if (ready && text(current?.status).toLowerCase() !== 'ready') {
    await database.run(`
      UPDATE message_analytics_projection_state
      SET status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ? AND building_generation IS NULL
        AND NOT EXISTS (SELECT 1 FROM message_analytics_change_queue LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM message_analytics_contact_queue LIMIT 1)
    `, [STATE_ID])
  }
  return { ready, pending }
}

async function processChangeQueueBatch(database, batchSize = QUEUE_BATCH_SIZE, {
  onBeforeQueueCasDelete = null
} = {}) {
  const result = await database.transaction(async transaction => {
    // Hay un solo worker protegido por advisory lock. No bloqueamos las filas de
    // cola mientras leemos fuentes/agregamos: si llega una revisión concurrente,
    // el DELETE CAS de abajo no la consume y el siguiente ciclo la reprocesa.
    const state = await readMessageAnalyticsProjectionState(transaction)
    if (!state) return { unavailable: true, processed: 0, empty: true }
    const rows = await transaction.all(`
      SELECT source_kind, source_message_id, revision,
             active_applied_revision, building_applied_revision
      FROM message_analytics_change_queue
      ORDER BY enqueued_at ASC, source_kind ASC, source_message_id ASC
      LIMIT ?
    `, [batchSize])
    if (!rows.length) return { processed: 0, empty: true }
    const keys = rows.map(row => ({
      sourceKind: text(row.source_kind),
      sourceMessageId: text(row.source_message_id)
    }))
    const activeGeneration = Number(state.active_generation || 0)
    const buildingGeneration = Number(state.building_generation || 0)
    let changed = 0
    if (activeGeneration) {
      const result = await projectKeysForGeneration(transaction, activeGeneration, state.active_timezone, keys)
      changed += result.changed
    }
    if (buildingGeneration && buildingGeneration !== activeGeneration) {
      const result = await projectKeysForGeneration(transaction, buildingGeneration, state.building_timezone, keys)
      changed += result.changed
    }
    if (typeof onBeforeQueueCasDelete === 'function') {
      await onBeforeQueueCasDelete(rows.map(row => ({ ...row })))
    }
    const exactConditions = rows.map(() => '(source_kind = ? AND source_message_id = ? AND revision = ?)').join(' OR ')
    await transaction.run(`DELETE FROM message_analytics_change_queue WHERE ${exactConditions}`,
      rows.flatMap(row => [row.source_kind, row.source_message_id, row.revision]))
    return { processed: rows.length, changed, empty: false }
  })
  // No conservar locks de cola mientras esperamos el FOR SHARE de una consulta
  // larga. El estado derivado usa EXISTS(queue); este bookkeeping ocurre después
  // del commit y puede esperar sin frenar el trigger del inbox.
  if (!result.processed) {
    await markProjectionReadyIfCaughtUp(database)
    return result
  }
  await database.run(`
    UPDATE message_analytics_projection_state
    SET status = CASE
          WHEN active_generation IS NOT NULL
            AND building_generation IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_analytics_change_queue LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM message_analytics_contact_queue LIMIT 1)
            THEN 'ready'
          ELSE status
        END,
        last_applied_at = CASE WHEN ? > 0 THEN CURRENT_TIMESTAMP ELSE last_applied_at END,
        last_error = CASE WHEN ? > 0 THEN NULL ELSE last_error END,
        updated_at = CASE WHEN ? > 0 OR status != 'ready' THEN CURRENT_TIMESTAMP ELSE updated_at END
    WHERE singleton_id = ?
  `, [result.processed, result.processed, result.processed, STATE_ID])
  return result
}

async function processBackfillBatch(database, sourceKind, batchSize = BATCH_SIZE) {
  return database.transaction(async transaction => {
    const state = await readMessageAnalyticsProjectionState(transaction)
    const generation = Number(state?.building_generation || 0)
    if (!generation) return { processed: 0, complete: true }
    const completeColumn = `${sourceKind}_complete`
    const cursorColumn = `${sourceKind}_cursor`
    if (booleanValue(state[completeColumn])) return { processed: 0, complete: true }
    const rows = await transaction.all(`
      SELECT id FROM ${SOURCE_TABLES[sourceKind]}
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `, [state[cursorColumn] || '', batchSize])
    if (!rows.length) {
      await transaction.run(`
        UPDATE message_analytics_projection_state
        SET ${completeColumn} = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton_id = ?
      `, [includedValue(true), STATE_ID])
      return { processed: 0, complete: true }
    }
    const keys = rows.map(row => ({ sourceKind, sourceMessageId: text(row.id) }))
    const result = await projectKeysForGeneration(transaction, generation, state.building_timezone, keys)
    const complete = rows.length < batchSize
    await transaction.run(`
      UPDATE message_analytics_projection_state
      SET ${cursorColumn} = ?,
          ${completeColumn} = ?,
          last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [rows.at(-1).id, includedValue(complete), STATE_ID])
    return { ...result, processed: rows.length, complete }
  })
}

function rangeCompileDimensions(scopeKind) {
  if (scopeKind === 'channel') {
    return {
      select: `daily.channel AS channel, '' AS source`,
      group: 'daily.channel',
      partition: 'identity_key, channel'
    }
  }
  if (scopeKind === 'source') {
    return {
      select: `'' AS channel, daily.source AS source`,
      group: 'daily.source',
      partition: 'identity_key, source',
      sourceGuard: true
    }
  }
  if (scopeKind === 'channel_source') {
    return {
      select: 'daily.channel AS channel, daily.source AS source',
      group: 'daily.channel, daily.source',
      partition: 'identity_key, channel, source',
      sourceGuard: true
    }
  }
  return {
    select: `'' AS channel, '' AS source`,
    group: '',
    partition: 'identity_key'
  }
}

async function compileRangeScope(database, generation, metricKind, scopeKind) {
  const dimensions = rangeCompileDimensions(scopeKind)
  const attributedSql = metricKind === 'attributed' ? 'AND daily.attributed_message_count > 0' : ''
  const sourceSql = dimensions.sourceGuard
    ? `AND daily.source IN (${placeholders(MESSAGE_ANALYTICS_SOURCE_CATALOG)})`
    : ''
  const dimensionGroup = dimensions.group ? `, ${dimensions.group}` : ''
  const nextPrevious = databaseDialect === 'postgres'
    ? `previous_date + 1`
    : `DATE(previous_date, '+1 day')`
  const nextOccurrence = databaseDialect === 'postgres'
    ? `business_date + 1`
    : `DATE(business_date, '+1 day')`
  const rangeOrigin = databaseDialect === 'postgres' ? `DATE '${RANGE_ORIGIN}'` : `'${RANGE_ORIGIN}'`
  await database.run(`
    WITH occurrences AS (
      SELECT
        daily.identity_key,
        daily.business_date,
        ${dimensions.select}
      FROM message_analytics_daily_identity daily
      WHERE daily.generation = ?
        ${attributedSql}
        ${sourceSql}
      GROUP BY daily.identity_key, daily.business_date${dimensionGroup}
    ), ordered AS (
      SELECT
        identity_key,
        business_date,
        channel,
        source,
        LAG(business_date) OVER (
          PARTITION BY ${dimensions.partition}
          ORDER BY business_date ASC
        ) AS previous_date
      FROM occurrences
    ), points AS (
      SELECT
        channel,
        source,
        COALESCE(${nextPrevious}, ${rangeOrigin}) AS start_boundary,
        business_date AS occurrence_date,
        1 AS point_delta
      FROM ordered
      UNION ALL
      SELECT
        channel,
        source,
        ${nextOccurrence} AS start_boundary,
        business_date AS occurrence_date,
        -1 AS point_delta
      FROM ordered
    )
    INSERT INTO message_analytics_range_delta (
      generation, metric_kind, scope_kind, channel, source,
      start_boundary, occurrence_date, range_delta, updated_at
    )
    SELECT
      ?, '${metricKind}', '${scopeKind}', channel, source,
      start_boundary, occurrence_date, SUM(point_delta), CURRENT_TIMESTAMP
    FROM points
    GROUP BY channel, source, start_boundary, occurrence_date
    HAVING SUM(point_delta) != 0
  `, [generation, ...(dimensions.sourceGuard ? MESSAGE_ANALYTICS_SOURCE_CATALOG : []), generation])
}

async function compileOriginRangeScope(database, generation) {
  const nextPrevious = databaseDialect === 'postgres'
    ? `previous_date + 1`
    : `DATE(previous_date, '+1 day')`
  const nextOccurrence = databaseDialect === 'postgres'
    ? `business_date + 1`
    : `DATE(business_date, '+1 day')`
  const rangeOrigin = databaseDialect === 'postgres' ? `DATE '${RANGE_ORIGIN}'` : `'${RANGE_ORIGIN}'`
  await database.run(`
    WITH candidates AS (
      SELECT
        daily.identity_key,
        daily.business_date,
        daily.source,
        ROW_NUMBER() OVER (
          PARTITION BY daily.identity_key, daily.business_date
          ORDER BY daily.first_occurred_at ASC, daily.first_source_kind ASC,
                   daily.first_source_message_id ASC, daily.source ASC
        ) AS day_rank
      FROM message_analytics_daily_identity daily
      WHERE daily.generation = ? AND daily.channel = 'whatsapp'
        AND daily.source IN (${placeholders(MESSAGE_ANALYTICS_SOURCE_CATALOG)})
    ), occurrences AS (
      SELECT identity_key, business_date, source
      FROM candidates
      WHERE day_rank = 1
    ), ordered AS (
      SELECT
        identity_key,
        business_date,
        source,
        LAG(business_date) OVER (
          PARTITION BY identity_key
          ORDER BY business_date ASC
        ) AS previous_date
      FROM occurrences
    ), points AS (
      SELECT
        source,
        COALESCE(${nextPrevious}, ${rangeOrigin}) AS start_boundary,
        business_date AS occurrence_date,
        1 AS point_delta
      FROM ordered
      UNION ALL
      SELECT
        source,
        ${nextOccurrence} AS start_boundary,
        business_date AS occurrence_date,
        -1 AS point_delta
      FROM ordered
    )
    INSERT INTO message_analytics_range_delta (
      generation, metric_kind, scope_kind, channel, source,
      start_boundary, occurrence_date, range_delta, updated_at
    )
    SELECT
      ?, 'origin', 'origin_source', '', source,
      start_boundary, occurrence_date, SUM(point_delta), CURRENT_TIMESTAMP
    FROM points
    GROUP BY source, start_boundary, occurrence_date
    HAVING SUM(point_delta) != 0
  `, [generation, ...MESSAGE_ANALYTICS_SOURCE_CATALOG, generation])
}

async function compilePhoneRangeScope(database, generation) {
  const nextPrevious = databaseDialect === 'postgres'
    ? `previous_date + 1`
    : `DATE(previous_date, '+1 day')`
  const nextOccurrence = databaseDialect === 'postgres'
    ? `business_date + 1`
    : `DATE(business_date, '+1 day')`
  const rangeOrigin = databaseDialect === 'postgres' ? `DATE '${RANGE_ORIGIN}'` : `'${RANGE_ORIGIN}'`
  await database.run(`
    WITH occurrences AS (
      SELECT
        phone_daily.business_phone_key,
        phone_daily.identity_key,
        phone_daily.business_date
      FROM message_analytics_daily_phone_identity phone_daily
      WHERE phone_daily.generation = ? AND phone_daily.message_count > 0
      GROUP BY
        phone_daily.business_phone_key,
        phone_daily.identity_key,
        phone_daily.business_date
    ), ordered AS (
      SELECT
        business_phone_key,
        identity_key,
        business_date,
        LAG(business_date) OVER (
          PARTITION BY business_phone_key, identity_key
          ORDER BY business_date ASC
        ) AS previous_date
      FROM occurrences
    ), points AS (
      SELECT
        business_phone_key,
        COALESCE(${nextPrevious}, ${rangeOrigin}) AS start_boundary,
        business_date AS occurrence_date,
        1 AS point_delta
      FROM ordered
      UNION ALL
      SELECT
        business_phone_key,
        ${nextOccurrence} AS start_boundary,
        business_date AS occurrence_date,
        -1 AS point_delta
      FROM ordered
    )
    INSERT INTO message_analytics_phone_range_delta (
      generation, business_phone_key, start_boundary,
      occurrence_date, range_delta, updated_at
    )
    SELECT
      ?, business_phone_key, start_boundary,
      occurrence_date, SUM(point_delta), CURRENT_TIMESTAMP
    FROM points
    GROUP BY business_phone_key, start_boundary, occurrence_date
    HAVING SUM(point_delta) != 0
  `, [generation, generation])
}

export async function compileMessageAnalyticsRangeRollup(database, generation) {
  if (!generation) return { ready: false, generation: null }
  return database.transaction(async transaction => {
    const marker = await transaction.get(`
      SELECT status FROM message_analytics_range_generation WHERE generation = ?
    `, [generation])
    if (text(marker?.status).toLowerCase() === 'ready') {
      return { ready: true, generation, rebuilt: false }
    }
    await transaction.run('DELETE FROM message_analytics_range_delta WHERE generation = ?', [generation])
    await transaction.run('DELETE FROM message_analytics_phone_range_delta WHERE generation = ?', [generation])
    await transaction.run('DELETE FROM message_analytics_daily_rollup WHERE generation = ?', [generation])
    await transaction.run(`
      INSERT INTO message_analytics_daily_rollup (
        generation, business_date, channel, source, message_count, updated_at
      )
      SELECT generation, business_date, channel, source, SUM(message_count), CURRENT_TIMESTAMP
      FROM message_analytics_daily_identity
      WHERE generation = ?
      GROUP BY generation, business_date, channel, source
    `, [generation])
    for (const metricKind of RANGE_METRICS) {
      for (const scopeKind of RANGE_SCOPES) {
        await compileRangeScope(transaction, generation, metricKind, scopeKind)
      }
    }
    await compileOriginRangeScope(transaction, generation)
    await compilePhoneRangeScope(transaction, generation)
    await transaction.run(`
      INSERT INTO message_analytics_range_generation(generation, status, built_at, updated_at)
      VALUES (?, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(generation) DO UPDATE SET
        status = 'ready', built_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    `, [generation])
    return { ready: true, generation, rebuilt: true }
  })
}

async function trySwapGeneration(database) {
  return database.transaction(async transaction => {
    const state = await lockState(transaction)
    const buildingGeneration = Number(state?.building_generation || 0)
    if (!buildingGeneration) return { swapped: false, ready: true }
    if (!SOURCE_KINDS.every(kind => booleanValue(state[`${kind}_complete`]))) {
      return { swapped: false, ready: false }
    }
    if (!await isRangeGenerationReady(transaction, buildingGeneration)) {
      return { swapped: false, ready: false, rangeRollupPending: true }
    }
    if (databaseDialect === 'postgres') {
      await transaction.run('LOCK TABLE message_analytics_change_queue IN SHARE ROW EXCLUSIVE MODE')
      await transaction.run('LOCK TABLE message_analytics_contact_queue IN SHARE ROW EXCLUSIVE MODE')
    }
    const pending = await transaction.get(`
      SELECT
        EXISTS(SELECT 1 FROM message_analytics_change_queue LIMIT 1) AS change_pending,
        EXISTS(SELECT 1 FROM message_analytics_contact_queue LIMIT 1) AS contact_pending
    `)
    const catchingUp = booleanValue(pending?.change_pending) || booleanValue(pending?.contact_pending)

    const oldGeneration = Number(state.active_generation || 0) || null
    if (oldGeneration && oldGeneration !== buildingGeneration) {
      await enqueueGenerationGc(transaction, oldGeneration)
    }
    await transaction.run(`
      UPDATE message_analytics_projection_state
      SET status = ?,
          active_generation = building_generation,
          active_version = building_version,
          active_timezone = building_timezone,
          building_generation = NULL,
          building_version = NULL,
          building_timezone = NULL,
          whatsapp_cursor = '', meta_cursor = '', email_cursor = '',
          whatsapp_complete = ?, meta_complete = ?, email_complete = ?,
          last_applied_at = CURRENT_TIMESTAMP,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE singleton_id = ?
    `, [catchingUp ? 'replaying' : 'ready', includedValue(false), includedValue(false), includedValue(false), STATE_ID])
    return {
      swapped: true,
      ready: !catchingUp,
      catchingUp,
      oldGeneration,
      activeGeneration: buildingGeneration
    }
  })
}

async function cleanupRetiredGenerationBatch(database, batchSize = GC_BATCH_SIZE) {
  return database.transaction(async transaction => {
    // Queries PostgreSQL sostienen FOR SHARE sobre este singleton. El FOR UPDATE
    // hace que GC espere cualquier lector que haya fijado la generación anterior.
    const state = await lockState(transaction)
    const busy = await transaction.get(`
      SELECT
        EXISTS(SELECT 1 FROM message_analytics_change_queue LIMIT 1) AS change_pending,
        EXISTS(SELECT 1 FROM message_analytics_contact_queue LIMIT 1) AS contact_pending
    `)
    if (state?.building_generation || booleanValue(busy?.change_pending) || booleanValue(busy?.contact_pending)) {
      return { cleaned: 0, complete: false, busy: true }
    }
    const due = await transaction.get(`
      SELECT generation
      FROM message_analytics_generation_gc
      WHERE eligible_at <= CURRENT_TIMESTAMP
      ORDER BY eligible_at ASC, generation ASC
      LIMIT 1
      ${databaseDialect === 'postgres' ? 'FOR UPDATE SKIP LOCKED' : ''}
    `)
    const generation = Number(due?.generation || 0)
    if (!generation) return { cleaned: 0, complete: true }
    if ([Number(state?.active_generation || 0), Number(state?.building_generation || 0)].includes(generation)) {
      await transaction.run(`
        UPDATE message_analytics_generation_gc
        SET eligible_at = ${databaseDialect === 'postgres'
          ? `CURRENT_TIMESTAMP + INTERVAL '1 hour'`
          : `DATETIME(CURRENT_TIMESTAMP, '+3600 seconds')`}
        WHERE generation = ?
      `, [generation])
      return { cleaned: 0, complete: false, protected: true }
    }
    const physicalRowId = databaseDialect === 'postgres' ? 'ctid' : 'rowid'
    const daily = await transaction.run(`
      DELETE FROM message_analytics_daily_identity
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_daily_identity
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const facts = await transaction.run(`
      DELETE FROM message_analytics_fact
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_fact
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const phoneFacts = await transaction.run(`
      DELETE FROM message_analytics_phone_fact
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_phone_fact
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const phoneDaily = await transaction.run(`
      DELETE FROM message_analytics_daily_phone_identity
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_daily_phone_identity
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const phoneMetadata = await transaction.run(`
      DELETE FROM message_analytics_daily_phone_metadata
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_daily_phone_metadata
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const phoneRangeDelta = await transaction.run(`
      DELETE FROM message_analytics_phone_range_delta
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_phone_range_delta
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const rangeDelta = await transaction.run(`
      DELETE FROM message_analytics_range_delta
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_range_delta
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const dailyRollup = await transaction.run(`
      DELETE FROM message_analytics_daily_rollup
      WHERE ${physicalRowId} IN (
        SELECT ${physicalRowId}
        FROM message_analytics_daily_rollup
        WHERE generation = ?
        LIMIT ?
      )
    `, [generation, batchSize])
    const pending = await transaction.get(`
      SELECT EXISTS(
        SELECT 1 FROM message_analytics_daily_identity WHERE generation = ? LIMIT 1
      ) AS daily_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_fact WHERE generation = ? LIMIT 1
      ) AS fact_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_range_delta WHERE generation = ? LIMIT 1
      ) AS range_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_daily_rollup WHERE generation = ? LIMIT 1
      ) AS rollup_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_phone_fact WHERE generation = ? LIMIT 1
      ) AS phone_fact_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_daily_phone_identity WHERE generation = ? LIMIT 1
      ) AS phone_daily_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_daily_phone_metadata WHERE generation = ? LIMIT 1
      ) AS phone_metadata_pending,
      EXISTS(
        SELECT 1 FROM message_analytics_phone_range_delta WHERE generation = ? LIMIT 1
      ) AS phone_range_pending
    `, [
      generation, generation, generation, generation,
      generation, generation, generation, generation
    ])
    const remains = booleanValue(pending?.daily_pending) ||
      booleanValue(pending?.fact_pending) ||
      booleanValue(pending?.range_pending) ||
      booleanValue(pending?.rollup_pending) ||
      booleanValue(pending?.phone_fact_pending) ||
      booleanValue(pending?.phone_daily_pending) ||
      booleanValue(pending?.phone_metadata_pending) ||
      booleanValue(pending?.phone_range_pending)
    if (!remains) {
      await transaction.run('DELETE FROM message_analytics_range_generation WHERE generation = ?', [generation])
      await transaction.run('DELETE FROM message_analytics_generation_gc WHERE generation = ?', [generation])
    }
    return {
      cleaned: Number(daily?.changes || 0) + Number(facts?.changes || 0) +
        Number(rangeDelta?.changes || 0) + Number(dailyRollup?.changes || 0) +
        Number(phoneFacts?.changes || 0) + Number(phoneDaily?.changes || 0) +
        Number(phoneMetadata?.changes || 0) + Number(phoneRangeDelta?.changes || 0),
      complete: !remains,
      generation
    }
  })
}

async function runProjectionCycle(database, timezone, options = {}) {
  const batchSize = boundedInteger(options.batchSize, BATCH_SIZE, BATCH_SIZE)
  const maxQueueBatches = boundedInteger(options.maxQueueBatches, MAX_QUEUE_BATCHES, 100)
  const maxBackfillBatches = boundedInteger(options.maxBackfillBatches, MAX_BACKFILL_BATCHES, 100)
  const state = await ensureBuildingGeneration(database, timezone)
  if (!state) return { unavailable: true, ready: false }

  if (Number(state.active_generation || 0) > 0 && !state.building_generation) {
    const caughtUp = await markProjectionReadyIfCaughtUp(database)
    if (caughtUp.ready) {
      let gc = { cleaned: 0 }
      if (Date.now() - lastGcAttemptAt >= GC_POLL_MS) {
        lastGcAttemptAt = Date.now()
        gc = await cleanupRetiredGenerationBatch(database)
      }
      return {
        available: true,
        ready: true,
        paused: false,
        dependencies: 0,
        replayed: 0,
        backfilled: 0,
        swapped: false,
        catchingUp: false,
        cleaned: gc.cleaned,
        generation: Number(state.active_generation),
        timezone
      }
    }
  }

  let dependencies = 0
  let replayed = 0
  let backfilled = 0
  for (let batch = 0; batch < maxQueueBatches; batch += 1) {
    const result = await processContactDependencyBatch(database)
    dependencies += result.processed
    if (result.empty) break
  }
  for (let batch = 0; batch < maxQueueBatches; batch += 1) {
    const result = await processChangeQueueBatch(database, QUEUE_BATCH_SIZE, options)
    replayed += result.processed
    if (result.empty) break
  }

  for (let batch = 0; batch < maxBackfillBatches; batch += 1) {
    const current = await readMessageAnalyticsProjectionState(database)
    if (!current?.building_generation) break
    const sourceKind = SOURCE_KINDS.find(kind => !booleanValue(current[`${kind}_complete`]))
    if (!sourceKind) break
    const result = await processBackfillBatch(database, sourceKind, batchSize)
    backfilled += result.processed
  }

  const afterBackfill = await readMessageAnalyticsProjectionState(database)
  const backfillComplete = Boolean(afterBackfill?.building_generation) &&
    SOURCE_KINDS.every(kind => booleanValue(afterBackfill[`${kind}_complete`]))
  if (backfillComplete) {
    for (let batch = 0; batch < maxQueueBatches; batch += 1) {
      const dependency = await processContactDependencyBatch(database)
      dependencies += dependency.processed
      if (!dependency.empty) continue
      const replay = await processChangeQueueBatch(database, QUEUE_BATCH_SIZE, options)
      replayed += replay.processed
      if (replay.empty) break
    }
  }
  const preparedState = await readMessageAnalyticsProjectionState(database)
  const preparedGeneration = Number(preparedState?.building_generation || 0)
  if (preparedGeneration && SOURCE_KINDS.every(kind => booleanValue(preparedState[`${kind}_complete`]))) {
    await compileMessageAnalyticsRangeRollup(database, preparedGeneration)
  }
  const swap = await trySwapGeneration(database)
  const finalState = await readMessageAnalyticsProjectionState(database)
  const pending = await database.get(`
    SELECT
      EXISTS(SELECT 1 FROM message_analytics_change_queue LIMIT 1) AS change_pending,
      EXISTS(SELECT 1 FROM message_analytics_contact_queue LIMIT 1) AS contact_pending
  `)
  const catchingUp = booleanValue(pending?.change_pending) || booleanValue(pending?.contact_pending)
  const ready = Number(finalState?.active_generation || 0) > 0 &&
    !finalState?.building_generation && !catchingUp
  let gc = { cleaned: 0 }
  if (ready && replayed === 0 && dependencies === 0 && Date.now() - lastGcAttemptAt >= GC_POLL_MS) {
    lastGcAttemptAt = Date.now()
    gc = await cleanupRetiredGenerationBatch(database)
  }
  return {
    available: true,
    ready,
    paused: !ready || replayed > 0,
    dependencies,
    replayed,
    backfilled,
    swapped: swap.swapped,
    catchingUp,
    cleaned: gc.cleaned,
    generation: Number(finalState?.active_generation || 0) || null,
    timezone
  }
}

async function persistFailure(error) {
  await db.run(`
    UPDATE message_analytics_projection_state
    SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = ?
  `, [text(error?.message || error).slice(0, 2_000), STATE_ID]).catch(() => undefined)
}

export async function runMessageAnalyticsProjectionBackfill(options = {}) {
  const timezone = resolveTimezone(await getAccountTimezone({ throwOnError: true }))
  try {
    if (databaseDialect === 'postgres' && typeof db.withAdvisoryLock === 'function') {
      return await db.withAdvisoryLock(
        BACKFILL_JOB_KEY,
        lockedDb => runProjectionCycle(lockedDb || db, timezone, options)
      )
    }
    return await runProjectionCycle(db, timezone, options)
  } catch (error) {
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') return { ready: false, busy: true, paused: true }
    if (isMissingProjectionSchema(error)) return { ready: false, unavailable: true }
    await persistFailure(error)
    throw error
  }
}

function clearResumeTimer() {
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = null
}

function scheduleResume(delayMs) {
  if (resumeTimer || isDeployShutdownStarted()) return
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    scheduleMessageAnalyticsProjectionBackfill()
  }, Math.max(1, Number(delayMs) || 1))
  resumeTimer.unref?.()
}

export function scheduleMessageAnalyticsProjectionBackfill() {
  if (isDeployShutdownStarted() || workerPromise || workerScheduled) return { scheduled: false }
  const retryAfterMs = Math.max(0, workerEligibleAt - Date.now())
  if (retryAfterMs > 0) {
    scheduleResume(retryAfterMs)
    return { scheduled: false, paused: true, retryAfterMs }
  }
  clearResumeTimer()
  const queued = scheduleProjectionBackfillJob({
    key: BACKFILL_JOB_KEY,
    priority: BACKFILL_JOB_PRIORITY.NORMAL,
    onError: error => {
      workerScheduled = false
      workerEligibleAt = Date.now() + ERROR_RETRY_MS
      scheduleResume(ERROR_RETRY_MS)
      logger.warn(`[Mensajes] No se pudo iniciar el read model: ${error?.message || error}`)
    },
    run: () => {
      workerScheduled = false
      workerPromise = runMessageAnalyticsProjectionBackfill()
        .then(result => {
          const delay = result?.unavailable ? ERROR_RETRY_MS : (result?.paused ? BACKFILL_PAUSE_MS : CONTINUOUS_POLL_MS)
          workerEligibleAt = Date.now() + delay
          scheduleResume(delay)
          return result
        })
        .catch(async error => {
          await persistFailure(error)
          workerEligibleAt = Date.now() + ERROR_RETRY_MS
          scheduleResume(ERROR_RETRY_MS)
          logger.warn(`[Mensajes] Falló el read model incremental: ${error.message}`)
          return { ready: false, error: error.message }
        })
        .finally(() => { workerPromise = null })
      return workerPromise
    }
  })
  workerScheduled = Boolean(queued.scheduled)
  return { scheduled: workerScheduled }
}

function normalizeFilters(filters = {}) {
  const list = value => (Array.isArray(value) ? value : text(value).split(','))
    .map(item => text(item))
    .filter(Boolean)
  return {
    channels: list(filters.channels).map(value => normalizeChannel(value)),
    sources: list(filters.sources)
  }
}

function periodExpression(groupBy, alias = 'daily') {
  if (groupBy === 'year') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 4)`
  if (groupBy === 'month') return `SUBSTR(CAST(${alias}.business_date AS TEXT), 1, 7)`
  return `CAST(${alias}.business_date AS TEXT)`
}

function rangeBusinessDates(range) {
  const timezone = resolveTimezone(range?.appliedTimezone)
  return {
    startDate: text(range?.startDate) || normalizeDateOnlyInTimezone(range?.startUtc, timezone),
    endDate: text(range?.endDate) || normalizeDateOnlyInTimezone(range?.endUtc, timezone)
  }
}

function exactRangeScope(filters) {
  if (filters.channels.length > 1 || filters.sources.length > 1) return null
  if (filters.sources.length && !MESSAGE_ANALYTICS_SOURCE_SET.has(filters.sources[0])) return null
  const channel = filters.channels[0] || ''
  const source = filters.sources[0] || ''
  return {
    scope_kind: channel && source ? 'channel_source' : (channel ? 'channel' : (source ? 'source' : 'all')),
    channel,
    source
  }
}

function dailyRollupFilterSql(filters, alias = 'daily') {
  const conditions = []
  const params = []
  if (filters.channels.length) {
    conditions.push(`LOWER(${alias}.channel) IN (${placeholders(filters.channels)})`)
    params.push(...filters.channels.map(value => value.toLowerCase()))
  }
  if (filters.sources.length) {
    conditions.push(`LOWER(${alias}.source) IN (${placeholders(filters.sources)})`)
    params.push(...filters.sources.map(value => value.toLowerCase()))
  }
  return { sql: conditions.length ? `AND ${conditions.join(' AND ')}` : '', params }
}

function messageRowMatchesFilters(row, filters) {
  const channel = text(row.channel).toLowerCase()
  const source = text(row.source).toLowerCase()
  return (!filters.channels.length || filters.channels.some(value => value.toLowerCase() === channel)) &&
    (!filters.sources.length || filters.sources.some(value => value.toLowerCase() === source))
}

function periodValueForBusinessDate(value, groupBy) {
  const date = dateOnlyValue(value)
  if (groupBy === 'year') return date.slice(0, 4)
  if (groupBy === 'month') return date.slice(0, 7)
  return date
}

async function resolveHiddenContactIds(database, hiddenFilters = [], signal) {
  const exactValues = [...new Set(hiddenFilters
    .filter(filter => text(filter?.type || 'contains').toLowerCase() === 'exact')
    .map(filter => text(filter?.text).toLowerCase())
  )]
  const containsFilters = hiddenFilters.filter(
    filter => text(filter?.type || 'contains').toLowerCase() !== 'exact'
  )
  const hiddenContactIds = new Set()

  // Cada rama coincide exactamente con un índice funcional. Un solo OR sobre
  // las cuatro columnas degrada a sequential scan en cuentas grandes.
  for (const exactBatch of chunks(exactValues)) {
    const params = [...exactBatch, ...exactBatch, ...exactBatch, ...exactBatch]
    const rows = await database.all(`
      SELECT id FROM contacts
      WHERE LOWER(COALESCE(full_name, '')) IN (${placeholders(exactBatch)})
      UNION
      SELECT id FROM contacts
      WHERE LOWER(COALESCE(email, '')) IN (${placeholders(exactBatch)})
      UNION
      SELECT id FROM contacts
      WHERE LOWER(COALESCE(phone, '')) IN (${placeholders(exactBatch)})
      UNION
      SELECT id FROM contacts
      WHERE LOWER(id) IN (${placeholders(exactBatch)})
    `, params, { signal }) || []
    for (const row of rows) {
      if (text(row.id)) hiddenContactIds.add(text(row.id))
    }
  }

  // `contains` conserva la semántica histórica. Es deliberadamente separado:
  // no contamina el camino exacto usado en producción. PostgreSQL obtiene
  // candidatos desde el documento GIN trigram existente y luego revalida cada
  // campo para impedir falsos positivos entre los separadores del documento.
  if (containsFilters.length) {
    if (databaseDialect === 'postgres') {
      for (const filter of containsFilters) {
        const pattern = `%${text(filter?.text).toLowerCase()}%`
        const rows = await database.all(`
          SELECT c.id
          FROM contacts c
          WHERE LOWER(
            COALESCE(c.full_name, '') || ' ' || COALESCE(c.email, '') || ' ' ||
            COALESCE(c.phone, '') || ' ' || c.id
          ) LIKE ?
            AND (
              LOWER(COALESCE(c.full_name, '')) LIKE ? OR
              LOWER(COALESCE(c.email, '')) LIKE ? OR
              LOWER(COALESCE(c.phone, '')) LIKE ? OR
              LOWER(c.id) LIKE ?
            )
        `, [pattern, pattern, pattern, pattern, pattern], { signal }) || []
        for (const row of rows) {
          if (text(row.id)) hiddenContactIds.add(text(row.id))
        }
      }
    } else {
      const visibleCondition = buildHiddenContactsCondition(containsFilters, 'c', false)
      const rows = await database.all(`
        SELECT c.id
        FROM contacts c
        WHERE NOT (${visibleCondition})
      `, [], { signal }) || []
      for (const row of rows) {
        if (text(row.id)) hiddenContactIds.add(text(row.id))
      }
    }
  }
  return hiddenContactIds
}

async function readHiddenAnalyticsCorrectionRows(database, generation, dateRange, hiddenFilters = [], signal) {
  if (!hiddenFilters.length) return { hiddenContactIds: new Set(), rows: [] }
  const hiddenContactIds = await resolveHiddenContactIds(database, hiddenFilters, signal)
  if (!hiddenContactIds.size) return { hiddenContactIds, rows: [] }

  const identityKeys = new Set()
  for (const contactBatch of chunks([...hiddenContactIds])) {
    const identities = await database.all(`
      SELECT DISTINCT daily.identity_key
      FROM message_analytics_daily_identity daily
      WHERE daily.generation = ?
        AND daily.contact_id IN (${placeholders(contactBatch)})
        AND daily.business_date >= ? AND daily.business_date <= ?
    `, [generation, ...contactBatch, dateRange.startDate, dateRange.endDate], { signal }) || []
    for (const row of identities) {
      if (text(row.identity_key)) identityKeys.add(text(row.identity_key))
    }
  }
  if (!identityKeys.size) return { hiddenContactIds, rows: [] }

  const rows = []
  for (const identityBatch of chunks([...identityKeys])) {
    rows.push(...(await database.all(`
      SELECT daily.business_date, daily.channel, daily.source, daily.identity_key,
             daily.contact_id, daily.message_count, daily.attributed_message_count,
             daily.first_occurred_at, daily.first_source_kind, daily.first_source_message_id
      FROM message_analytics_daily_identity daily
      WHERE daily.generation = ?
        AND daily.identity_key IN (${placeholders(identityBatch)})
        AND daily.business_date >= ? AND daily.business_date <= ?
      ORDER BY daily.identity_key ASC, daily.business_date ASC,
               daily.first_occurred_at ASC, daily.first_source_kind ASC,
               daily.first_source_message_id ASC, daily.source ASC
    `, [generation, ...identityBatch, dateRange.startDate, dateRange.endDate], { signal }) || []))
  }
  return { hiddenContactIds, rows }
}

function originRangeRowOrder(left, right) {
  return dateOnlyValue(left.business_date).localeCompare(dateOnlyValue(right.business_date)) ||
    originRowOrder(left, right)
}

function compileHiddenAnalyticsCorrection(rows, hiddenContactIds, filters, groupBy) {
  const grouped = new Map()
  const trendMessages = new Map()
  const channelIdentities = new Map()
  const sourceIdentities = new Map()
  const originSources = new Map()
  let filteredMessages = 0
  let allMessages = 0
  let conversations = 0
  let attributedConversations = 0

  for (const row of rows) {
    const identity = text(row.identity_key)
    if (!grouped.has(identity)) grouped.set(identity, [])
    grouped.get(identity).push(row)
    if (!hiddenContactIds.has(text(row.contact_id))) continue
    const messageCount = Number(row.message_count || 0)
    allMessages += messageCount
    if (!messageRowMatchesFilters(row, filters)) continue
    filteredMessages += messageCount
    const period = periodValueForBusinessDate(row.business_date, groupBy)
    trendMessages.set(period, Number(trendMessages.get(period) || 0) + messageCount)
  }

  for (const identityRows of grouped.values()) {
    const hiddenRows = identityRows.filter(row => hiddenContactIds.has(text(row.contact_id)))
    const visibleRows = identityRows.filter(row => !hiddenContactIds.has(text(row.contact_id)))
    const hiddenFiltered = hiddenRows.filter(row => messageRowMatchesFilters(row, filters))
    const visibleFiltered = visibleRows.filter(row => messageRowMatchesFilters(row, filters))
    if (hiddenFiltered.length && !visibleFiltered.length) conversations += 1
    if (hiddenFiltered.some(row => Number(row.attributed_message_count || 0) > 0) &&
      !visibleFiltered.some(row => Number(row.attributed_message_count || 0) > 0)) {
      attributedConversations += 1
    }

    for (const channel of new Set(hiddenRows.map(row => text(row.channel)).filter(Boolean))) {
      if (!visibleRows.some(row => text(row.channel) === channel)) {
        channelIdentities.set(channel, Number(channelIdentities.get(channel) || 0) + 1)
      }
    }
    for (const source of new Set(hiddenRows.map(row => text(row.source)).filter(Boolean))) {
      if (!visibleRows.some(row => text(row.source) === source)) {
        sourceIdentities.set(source, Number(sourceIdentities.get(source) || 0) + 1)
      }
    }

    const allWhatsapp = identityRows.filter(row => text(row.channel) === 'whatsapp').sort(originRangeRowOrder)
    const visibleWhatsapp = visibleRows.filter(row => text(row.channel) === 'whatsapp').sort(originRangeRowOrder)
    const baseSource = allWhatsapp.length ? (text(allWhatsapp[0].source) || 'WhatsApp') : null
    const visibleSource = visibleWhatsapp.length ? (text(visibleWhatsapp[0].source) || 'WhatsApp') : null
    if (baseSource !== visibleSource) {
      if (baseSource) originSources.set(baseSource, Number(originSources.get(baseSource) || 0) - 1)
      if (visibleSource) originSources.set(visibleSource, Number(originSources.get(visibleSource) || 0) + 1)
    }
  }

  return {
    filteredMessages,
    allMessages,
    conversations,
    attributedConversations,
    trendMessages,
    channelIdentities,
    sourceIdentities,
    originSources,
    affectedIdentities: grouped.size
  }
}

async function readHiddenPhoneCorrectionRows(
  database,
  generation,
  dateRange,
  hiddenFilters = [],
  signal
) {
  if (!hiddenFilters.length) return { hiddenContactIds: new Set(), rows: [] }
  const hiddenContactIds = await resolveHiddenContactIds(database, hiddenFilters, signal)
  if (!hiddenContactIds.size) return { hiddenContactIds, rows: [] }

  const pairs = new Map()
  for (const contactBatch of chunks([...hiddenContactIds])) {
    const affected = await database.all(`
      SELECT DISTINCT phone_daily.business_phone_key, phone_daily.identity_key
      FROM message_analytics_daily_phone_identity phone_daily
      WHERE phone_daily.generation = ?
        AND phone_daily.contact_id IN (${placeholders(contactBatch)})
        AND phone_daily.business_date >= ? AND phone_daily.business_date <= ?
    `, [generation, ...contactBatch, dateRange.startDate, dateRange.endDate], { signal }) || []
    for (const row of affected) {
      const businessPhoneKey = text(row.business_phone_key)
      const identityKey = text(row.identity_key)
      if (!businessPhoneKey || !identityKey) continue
      pairs.set(`${businessPhoneKey}\u0000${identityKey}`, { businessPhoneKey, identityKey })
    }
  }
  if (!pairs.size) return { hiddenContactIds, rows: [] }

  const rows = []
  for (const pairBatch of chunks([...pairs.values()])) {
    const pairSql = pairBatch.map(() => `(
      phone_daily.business_phone_key = ? AND phone_daily.identity_key = ?
    )`).join(' OR ')
    rows.push(...(await database.all(`
      SELECT phone_daily.business_phone_key, phone_daily.identity_key,
             phone_daily.contact_id, phone_daily.message_count
      FROM message_analytics_daily_phone_identity phone_daily
      WHERE phone_daily.generation = ?
        AND phone_daily.business_date >= ? AND phone_daily.business_date <= ?
        AND (${pairSql})
    `, [
      generation,
      dateRange.startDate,
      dateRange.endDate,
      ...pairBatch.flatMap(pair => [pair.businessPhoneKey, pair.identityKey])
    ], { signal }) || []))
  }
  return { hiddenContactIds, rows }
}

function compileHiddenPhoneCorrection(rows, hiddenContactIds) {
  const grouped = new Map()
  for (const row of rows) {
    if (Number(row.message_count || 0) <= 0) continue
    const businessPhoneKey = text(row.business_phone_key)
    const identityKey = text(row.identity_key)
    const pairKey = `${businessPhoneKey}\u0000${identityKey}`
    if (!grouped.has(pairKey)) {
      grouped.set(pairKey, {
        businessPhoneKey,
        hidden: false,
        visible: false
      })
    }
    const target = grouped.get(pairKey)
    if (hiddenContactIds.has(text(row.contact_id))) target.hidden = true
    else target.visible = true
  }

  const byPhone = new Map()
  for (const value of grouped.values()) {
    if (!value.hidden || value.visible) continue
    byPhone.set(value.businessPhoneKey, Number(byPhone.get(value.businessPhoneKey) || 0) + 1)
  }
  return { byPhone, affectedIdentities: grouped.size }
}

async function readPhoneMetadataRows(database, generation, dateRange, phoneKeys, signal) {
  const rows = []
  for (const phoneBatch of chunks(phoneKeys)) {
    rows.push(...(await database.all(`
      WITH projected_phone_metadata AS (
        SELECT
          metadata.business_phone_key,
          MAX(NULLIF(metadata.business_phone_number_id, '')) AS business_phone_number_id,
          MAX(NULLIF(metadata.business_phone_number, '')) AS business_phone_number
        FROM message_analytics_daily_phone_metadata metadata
        WHERE metadata.generation = ?
          AND metadata.business_date >= ? AND metadata.business_date <= ?
          AND metadata.business_phone_key IN (${placeholders(phoneBatch)})
          AND metadata.message_count > 0
        GROUP BY metadata.business_phone_key
      )
      SELECT
        projected.business_phone_key,
        projected.business_phone_number_id,
        projected.business_phone_number,
        phone.label,
        phone.verified_name,
        phone.phone_number,
        phone.display_phone_number,
        phone.status,
        phone.qr_status,
        phone.api_send_enabled,
        phone.qr_send_enabled
      FROM projected_phone_metadata projected
      LEFT JOIN whatsapp_api_phone_numbers phone
        ON phone.id = projected.business_phone_number_id
    `, [
      generation,
      dateRange.startDate,
      dateRange.endDate,
      ...phoneBatch
    ], { signal }) || []))
  }
  return rows
}

async function queryRangeRollupAggregateRows(database, status, dateRange, {
  groupBy,
  filters,
  hiddenFilters,
  signal,
  onAfterMetrics
}) {
  const scope = exactRangeScope(filters)
  const rollupFilter = dailyRollupFilterSql(filters, 'rollup')
  const hiddenData = await readHiddenAnalyticsCorrectionRows(
    database,
    status.activeGeneration,
    dateRange,
    hiddenFilters,
    signal
  )
  const correction = compileHiddenAnalyticsCorrection(
    hiddenData.rows,
    hiddenData.hiddenContactIds,
    filters,
    groupBy
  )
  let metrics
  if (scope) {
    metrics = await database.get(`
      SELECT
        COALESCE(SUM(CASE WHEN delta.metric_kind = 'conversation' THEN delta.range_delta ELSE 0 END), 0)
          AS conversations,
        COALESCE(SUM(CASE WHEN delta.metric_kind = 'attributed' THEN delta.range_delta ELSE 0 END), 0)
          AS attributed_conversations,
        (
          SELECT COALESCE(SUM(rollup.message_count), 0)
          FROM message_analytics_daily_rollup rollup
          WHERE rollup.generation = ? AND rollup.business_date >= ? AND rollup.business_date <= ?
            ${rollupFilter.sql}
        ) AS inbound_messages,
        (
          SELECT COALESCE(SUM(all_rollup.message_count), 0)
          FROM message_analytics_daily_rollup all_rollup
          WHERE all_rollup.generation = ? AND all_rollup.business_date >= ? AND all_rollup.business_date <= ?
        ) AS all_messages
      FROM message_analytics_range_delta delta
      WHERE delta.generation = ?
        AND delta.scope_kind = ? AND delta.channel = ? AND delta.source = ?
        AND delta.start_boundary <= ? AND delta.occurrence_date <= ?
    `, [
      status.activeGeneration, dateRange.startDate, dateRange.endDate, ...rollupFilter.params,
      status.activeGeneration, dateRange.startDate, dateRange.endDate,
      status.activeGeneration, scope.scope_kind, scope.channel, scope.source,
      dateRange.startDate, dateRange.endDate
    ], { signal })
  } else {
    const dailyFilter = dailyRollupFilterSql(filters, 'daily')
    metrics = await database.get(`
      SELECT
        COALESCE(SUM(daily.message_count), 0) AS inbound_messages,
        COUNT(DISTINCT daily.identity_key) AS conversations,
        COUNT(DISTINCT CASE
          WHEN daily.attributed_message_count > 0 THEN daily.identity_key
        END) AS attributed_conversations,
        (
          SELECT COALESCE(SUM(all_rollup.message_count), 0)
          FROM message_analytics_daily_rollup all_rollup
          WHERE all_rollup.generation = ? AND all_rollup.business_date >= ? AND all_rollup.business_date <= ?
        ) AS all_messages
      FROM message_analytics_daily_identity daily
      WHERE daily.generation = ? AND daily.business_date >= ? AND daily.business_date <= ?
        ${dailyFilter.sql}
    `, [
      status.activeGeneration, dateRange.startDate, dateRange.endDate,
      status.activeGeneration, dateRange.startDate, dateRange.endDate, ...dailyFilter.params
    ], { signal })
  }
  metrics = {
    ...metrics,
    inbound_messages: Math.max(0, Number(metrics?.inbound_messages || 0) - correction.filteredMessages),
    conversations: Math.max(0, Number(metrics?.conversations || 0) - correction.conversations),
    attributed_conversations: Math.max(
      0,
      Number(metrics?.attributed_conversations || 0) - correction.attributedConversations
    ),
    all_messages: Math.max(0, Number(metrics?.all_messages || 0) - correction.allMessages)
  }
  if (typeof onAfterMetrics === 'function') await onAfterMetrics(metrics)

  const trendFilter = dailyRollupFilterSql(filters, 'daily')
  const period = periodExpression(groupBy, 'daily')
  const trendRows = await database.all(`
    SELECT ${period} AS period, SUM(daily.message_count) AS message_total
    FROM message_analytics_daily_rollup daily
    WHERE daily.generation = ? AND daily.business_date >= ? AND daily.business_date <= ?
      ${trendFilter.sql}
    GROUP BY ${period}
    ORDER BY ${period} ASC
  `, [status.activeGeneration, dateRange.startDate, dateRange.endDate, ...trendFilter.params], { signal })

  const facetRows = await database.all(`
    SELECT 'channel' AS facet_kind, delta.channel AS value, SUM(delta.range_delta) AS identity_count
    FROM message_analytics_range_delta delta
    WHERE delta.generation = ? AND delta.metric_kind = 'conversation'
      AND delta.scope_kind = 'channel' AND delta.channel != ''
      AND delta.start_boundary <= ? AND delta.occurrence_date <= ?
    GROUP BY delta.channel
    HAVING SUM(delta.range_delta) > 0
    UNION ALL
    SELECT 'source' AS facet_kind, delta.source AS value, SUM(delta.range_delta) AS identity_count
    FROM message_analytics_range_delta delta
    WHERE delta.generation = ? AND delta.metric_kind = 'conversation'
      AND delta.scope_kind = 'source' AND delta.source != ''
      AND delta.start_boundary <= ? AND delta.occurrence_date <= ?
    GROUP BY delta.source
    HAVING SUM(delta.range_delta) > 0
  `, [
    status.activeGeneration, dateRange.startDate, dateRange.endDate,
    status.activeGeneration, dateRange.startDate, dateRange.endDate
  ], { signal })
  const correctedTrendRows = trendRows
    .map(row => ({
      ...row,
      message_total: Math.max(
        0,
        Number(row.message_total || 0) - Number(correction.trendMessages.get(text(row.period)) || 0)
      )
    }))
    .filter(row => Number(row.message_total) > 0)
  const channelRows = facetRows
    .filter(row => row.facet_kind === 'channel')
    .map(row => ({
      ...row,
      identity_count: Math.max(
        0,
        Number(row.identity_count || 0) - Number(correction.channelIdentities.get(text(row.value)) || 0)
      )
    }))
    .filter(row => Number(row.identity_count) > 0)
    .sort((left, right) => Number(right.identity_count) - Number(left.identity_count) ||
      channelLabel(left.value).localeCompare(channelLabel(right.value)))
  const sourceRows = facetRows
    .filter(row => row.facet_kind === 'source')
    .map(row => ({
      ...row,
      identity_count: Math.max(
        0,
        Number(row.identity_count || 0) - Number(correction.sourceIdentities.get(text(row.value)) || 0)
      )
    }))
    .filter(row => Number(row.identity_count) > 0)
    .sort((left, right) => Number(right.identity_count) - Number(left.identity_count) ||
      text(left.value).localeCompare(text(right.value)))
    .slice(0, FILTER_LIMIT)
  const rows = [
    {
      row_type: 'metrics',
      label: '',
      value: '',
      count_value: metrics?.inbound_messages || 0,
      secondary_value: metrics?.conversations || 0,
      tertiary_value: metrics?.attributed_conversations || 0,
      all_messages_value: metrics?.all_messages || 0
    },
    ...correctedTrendRows.map(row => ({
      row_type: 'trend',
      label: row.period,
      value: '',
      count_value: row.message_total,
      secondary_value: 0,
      tertiary_value: 0,
      all_messages_value: 0
    })),
    ...channelRows.map(row => ({
      row_type: 'channel_filter',
      label: channelLabel(row.value),
      value: row.value,
      count_value: row.identity_count,
      secondary_value: 0,
      tertiary_value: 0,
      all_messages_value: 0
    })),
    ...sourceRows.map(row => ({
      row_type: 'source_filter',
      label: row.value,
      value: row.value,
      count_value: row.identity_count,
      secondary_value: 0,
      tertiary_value: 0,
      all_messages_value: 0
    }))
  ]
  return {
    status: {
      ...status,
      readPath: hiddenFilters.length
        ? (scope ? 'range_rollup_hidden_correction' : 'range_rollup_exact_multiselect_hidden_correction')
        : (scope ? 'range_rollup' : 'range_rollup_exact_multiselect'),
      hiddenCorrectionIdentities: correction.affectedIdentities
    },
    rows
  }
}

export async function queryMessageAnalyticsProjectionAggregateRows(range, {
  groupBy = 'day',
  filters = {},
  hiddenFilters = [],
  signal,
  onAfterMetrics = null,
  schedule = true
} = {}) {
  return withPinnedMessageAnalyticsGeneration(range, signal, async (database, status) => {
    if (!status.schemaAvailable) throw projectionWarmingError(status)
    if (!status.available) throw projectionWarmingError(status)
    const dateRange = rangeBusinessDates(range)
    const normalizedFilters = normalizeFilters(filters)
    return queryRangeRollupAggregateRows(database, status, dateRange, {
      groupBy,
      filters: normalizedFilters,
      hiddenFilters,
      signal,
      onAfterMetrics
    })
  }, { schedule })
}

export async function queryMessageAnalyticsProjectionOriginSources(range, {
  limit = 10,
  hiddenFilters = [],
  signal,
  schedule = false
} = {}) {
  return withPinnedMessageAnalyticsGeneration(range, signal, async (database, status) => {
    if (!status.schemaAvailable) throw projectionWarmingError(status)
    if (!status.available) throw projectionWarmingError(status)
    const dateRange = rangeBusinessDates(range)
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10))
    const rows = await database.all(`
      SELECT delta.source AS name, SUM(delta.range_delta) AS value
      FROM message_analytics_range_delta delta
      WHERE delta.generation = ?
        AND delta.metric_kind = 'origin'
        AND delta.scope_kind = 'origin_source'
        AND delta.start_boundary <= ?
        AND delta.occurrence_date <= ?
      GROUP BY delta.source
      HAVING SUM(delta.range_delta) > 0
    `, [status.activeGeneration, dateRange.startDate, dateRange.endDate], { signal })
    const hiddenData = await readHiddenAnalyticsCorrectionRows(
      database,
      status.activeGeneration,
      dateRange,
      hiddenFilters,
      signal
    )
    const correction = compileHiddenAnalyticsCorrection(
      hiddenData.rows,
      hiddenData.hiddenContactIds,
      normalizeFilters(),
      'day'
    )
    const sourceValues = new Map(rows.map(row => [
      text(row.name) || 'WhatsApp',
      Number(row.value || 0)
    ]))
    for (const [source, delta] of correction.originSources.entries()) {
      sourceValues.set(source, Number(sourceValues.get(source) || 0) + Number(delta || 0))
    }
    const correctedRows = [...sourceValues.entries()]
      .filter(([, value]) => value > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, safeLimit)
      .map(([name, value]) => ({ name, value }))
    return {
      status: {
        ...status,
        readPath: hiddenFilters.length ? 'origin_range_rollup_hidden_correction' : 'origin_range_rollup',
        hiddenCorrectionIdentities: correction.affectedIdentities
      },
      rows: correctedRows
    }
  }, { schedule })
}

export async function queryMessageAnalyticsProjectionPhoneNumbers(range, {
  limit = 10,
  hiddenFilters = [],
  signal
} = {}) {
  return withPinnedMessageAnalyticsGeneration(range, signal, async (database, status) => {
    if (!status.schemaAvailable) throw projectionWarmingError(status)
    if (!status.available) throw projectionWarmingError(status)
    const dateRange = rangeBusinessDates(range)
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10))
    const deltaRows = await database.all(`
      SELECT delta.business_phone_key, SUM(delta.range_delta) AS identity_count
      FROM message_analytics_phone_range_delta delta
      WHERE delta.generation = ?
        AND delta.start_boundary <= ? AND delta.occurrence_date <= ?
      GROUP BY delta.business_phone_key
      HAVING SUM(delta.range_delta) > 0
    `, [status.activeGeneration, dateRange.startDate, dateRange.endDate], { signal })
    const hiddenData = await readHiddenPhoneCorrectionRows(
      database,
      status.activeGeneration,
      dateRange,
      hiddenFilters,
      signal
    )
    const correction = compileHiddenPhoneCorrection(
      hiddenData.rows,
      hiddenData.hiddenContactIds
    )
    const counts = new Map(deltaRows.map(row => [
      text(row.business_phone_key),
      Math.max(
        0,
        Number(row.identity_count || 0) -
          Number(correction.byPhone.get(text(row.business_phone_key)) || 0)
      )
    ]))
    const phoneKeys = [...counts.entries()]
      .filter(([phoneKey, value]) => phoneKey && value > 0)
      .map(([phoneKey]) => phoneKey)
    const metadataRows = await readPhoneMetadataRows(
      database,
      status.activeGeneration,
      dateRange,
      phoneKeys,
      signal
    )
    const metadataByKey = new Map(metadataRows.map(row => [text(row.business_phone_key), row]))
    const rows = phoneKeys
      .map(phoneKey => {
        const metadata = metadataByKey.get(phoneKey) || {}
        const businessPhoneNumber = text(metadata.business_phone_number)
        const phoneNumber = text(metadata.phone_number) || businessPhoneNumber || null
        const displayPhoneNumber = text(metadata.display_phone_number) || businessPhoneNumber ||
          text(metadata.phone_number) || null
        const name = text(metadata.label) || text(metadata.verified_name) ||
          text(metadata.display_phone_number) || businessPhoneNumber ||
          text(metadata.phone_number) || 'Número sin nombre'
        return {
          name,
          value: Number(counts.get(phoneKey) || 0),
          phoneNumberId: text(metadata.business_phone_number_id) || null,
          phoneNumber,
          displayPhoneNumber,
          status: text(metadata.status) || text(metadata.qr_status) || null,
          apiSendEnabled: booleanValue(metadata.api_send_enabled),
          qrSendEnabled: booleanValue(metadata.qr_send_enabled)
        }
      })
      .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
      .slice(0, safeLimit)
    return {
      status: {
        ...status,
        readPath: hiddenFilters.length
          ? 'phone_range_rollup_hidden_correction'
          : 'phone_range_rollup',
        hiddenCorrectionIdentities: correction.affectedIdentities
      },
      rows
    }
  })
}

export const MESSAGE_ANALYTICS_PROJECTION_LIMITS = Object.freeze({
  batchSize: BATCH_SIZE,
  queueBatchSize: QUEUE_BATCH_SIZE,
  contactBatchSize: CONTACT_BATCH_SIZE,
  maxQueueBatches: MAX_QUEUE_BATCHES,
  maxBackfillBatches: MAX_BACKFILL_BATCHES,
  maxIndexedBytes: MAX_INDEXED_BYTES,
  triggerWritesOnlyQueue: true,
  decrementsGroupedByDailyKey: true,
  exactRangeRollup: true,
  exactPhoneRangeRollup: true,
  phoneProjectionSharesMessageQueue: true,
  incrementalRangeNeighbors: true,
  rangeScopesPerMetric: RANGE_SCOPES.length,
  boundedSourceCatalogSize: MESSAGE_ANALYTICS_SOURCE_CATALOG.length,
  generationCutover: true,
  resumesWithoutRequests: true
})
