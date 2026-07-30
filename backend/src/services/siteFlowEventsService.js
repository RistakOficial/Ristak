import crypto from 'crypto'
import { db } from '../config/database.js'

export const SITE_FLOW_EVENT_NAMES = Object.freeze([
  'attempt_start',
  'step_view',
  'field_answered',
  'step_complete',
  'attempt_completed',
  'attempt_terminal'
])

export const SITE_FLOW_CLIENT_EVENT_NAMES = Object.freeze([
  'attempt_start',
  'step_view',
  'field_answered',
  'step_complete'
])

export const SITE_FLOW_TERMINAL_EVENT_NAMES = Object.freeze([
  'attempt_completed',
  'attempt_terminal'
])

export const SITE_FLOW_MAX_BATCH_EVENTS = 50
export const SITE_FLOW_MAX_BATCH_BYTES = 64 * 1024
export const SITE_FLOW_SERVER_TERMINAL_SEQUENCE = 2_147_483_647
export const SITE_FLOW_MAX_EVENTS_PER_ATTEMPT = 1_000

const MAX_CLIENT_EVENT_SEQUENCE = 1_000_000
const MAX_CLIENT_EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_SITE_FLOW_ATTEMPT_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CLIENT_EVENTS_PER_ATTEMPT = SITE_FLOW_MAX_EVENTS_PER_ATTEMPT - 1
const MAX_FLOW_STEPS = 500
const MAX_FLOW_FIELDS = 2_000
const IDENTIFIER_MAX_LENGTH = 200
const EVENT_ID_MAX_LENGTH = 240
const EVENT_LABEL_MAX_LENGTH = 100
const SERVER_TERMINAL_EVENT_ID_PREFIX = 'site-flow-terminal:'

const SITE_FLOW_CLIENT_EVENT_SET = new Set(SITE_FLOW_CLIENT_EVENT_NAMES)
const SITE_FLOW_TERMINAL_EVENT_SET = new Set(SITE_FLOW_TERMINAL_EVENT_NAMES)
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const EMAIL_LIKE_IDENTIFIER_PATTERN = /@/
const PHONE_LIKE_IDENTIFIER_PATTERN = /^\+?[\d(). -]{7,25}$/
const CLIENT_STEP_KINDS = new Set([
  'intro',
  'page',
  'form_page',
  'slide',
  'form',
  'question',
  'questions',
  'content',
  'contact',
  'payment',
  'calendar',
  'summary',
  'result',
  'thank_you',
  'disqualified',
  'custom'
])
const CLIENT_STEP_OUTCOMES = new Set([
  'advanced',
  'jumped',
  'submit_requested'
])

const BATCH_BODY_KEYS = new Set([
  'attempt_id',
  'attemptId',
  'events'
])

const CLIENT_EVENT_KEYS = new Set([
  'event_id',
  'eventId',
  'event_sequence',
  'eventSequence',
  'event_name',
  'eventName',
  'step_id',
  'stepId',
  'target_step_id',
  'targetStepId',
  'field_id',
  'fieldId',
  'step_index',
  'stepIndex',
  'step_total',
  'stepTotal',
  'step_kind',
  'stepKind',
  'outcome',
  'client_event_at',
  'clientEventAt',
  'ts',
  'timestamp'
])

function siteFlowError(message, {
  status = 400,
  code = 'SITE_FLOW_EVENT_INVALID'
} = {}) {
  return Object.assign(new Error(message), { status, code })
}

function siteFlowConflict(message) {
  return siteFlowError(message, {
    status: 409,
    code: 'SITE_FLOW_EVENT_CONFLICT'
  })
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw siteFlowError(`${field} must be an object`)
  }
  return value
}

function assertAllowedKeys(value, allowedKeys, field) {
  const unsupported = Object.keys(value).filter(key => !allowedKeys.has(key))
  if (unsupported.length > 0) {
    throw siteFlowError(`${field} contains unsupported field: ${unsupported[0]}`)
  }
}

function readAlias(source, aliases) {
  const present = aliases.filter(alias => Object.hasOwn(source, alias))
  if (present.length === 0) return undefined
  const firstValue = source[present[0]]
  const firstSerialized = JSON.stringify(firstValue)
  for (const alias of present.slice(1)) {
    if (JSON.stringify(source[alias]) !== firstSerialized) {
      throw siteFlowError(`Conflicting aliases: ${present[0]} and ${alias}`)
    }
  }
  return firstValue
}

function cleanString(value, field, {
  maxLength = IDENTIFIER_MAX_LENGTH,
  required = false
} = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw siteFlowError(`${field} is required`)
    return null
  }
  if (typeof value !== 'string') {
    throw siteFlowError(`${field} must be a string`)
  }
  const cleaned = value.trim()
  if (!cleaned) {
    if (required) throw siteFlowError(`${field} is required`)
    return null
  }
  if (cleaned.length > maxLength) {
    throw siteFlowError(`${field} exceeds ${maxLength} characters`)
  }
  if (CONTROL_CHARACTER_PATTERN.test(cleaned)) {
    throw siteFlowError(`${field} contains invalid control characters`)
  }
  return cleaned
}

function cleanOpaqueIdentifier(value, field, {
  maxLength = IDENTIFIER_MAX_LENGTH,
  required = false
} = {}) {
  const cleaned = cleanString(value, field, { maxLength, required })
  if (!cleaned) return null
  if (
    EMAIL_LIKE_IDENTIFIER_PATTERN.test(cleaned) ||
    PHONE_LIKE_IDENTIFIER_PATTERN.test(cleaned)
  ) {
    throw siteFlowError(`${field} must be an opaque identifier`)
  }
  return cleaned
}

function positiveInteger(value, field, {
  required = false,
  max = Number.MAX_SAFE_INTEGER
} = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw siteFlowError(`${field} is required`)
    return null
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw siteFlowError(`${field} must be an integer between 1 and ${max}`)
  }
  return parsed
}

function normalizeIdentifierCatalog(value, field, {
  required = false,
  maxItems
} = {}) {
  if (value === undefined || value === null) {
    if (required) throw siteFlowError(`${field} is required`)
    return []
  }
  const items = value instanceof Set ? Array.from(value) : value
  if (!Array.isArray(items)) {
    throw siteFlowError(`${field} must be an array or Set`)
  }
  if (items.length > maxItems) {
    throw siteFlowError(`${field} exceeds ${maxItems} entries`)
  }

  const normalized = items.map((item, index) => cleanOpaqueIdentifier(
    item,
    `${field}[${index}]`,
    { required: true }
  ))
  if (new Set(normalized).size !== normalized.length) {
    throw siteFlowError(`${field} contains duplicate identifiers`)
  }
  return normalized
}

function normalizeContext(context = {}, {
  requireCatalogs = false,
  requireStableIdentity = false
} = {}) {
  assertPlainObject(context, 'context')

  const siteId = cleanOpaqueIdentifier(
    readAlias(context, ['siteId', 'site_id']),
    'context.siteId',
    { required: requireStableIdentity }
  )
  const formSiteId = cleanOpaqueIdentifier(
    readAlias(context, ['formSiteId', 'form_site_id']),
    'context.formSiteId',
    { required: requireStableIdentity }
  )
  const flowRevision = cleanOpaqueIdentifier(
    readAlias(context, ['flowRevision', 'flow_revision']),
    'context.flowRevision',
    { required: requireStableIdentity }
  )
  const visitorId = cleanOpaqueIdentifier(
    readAlias(context, ['visitorId', 'visitor_id']),
    'context.visitorId',
    { required: requireStableIdentity }
  )
  const sessionId = cleanOpaqueIdentifier(
    readAlias(context, ['sessionId', 'session_id']),
    'context.sessionId',
    { required: requireStableIdentity }
  )
  const stepIds = normalizeIdentifierCatalog(
    readAlias(context, ['validStepIds', 'valid_step_ids']),
    'context.validStepIds',
    { required: requireCatalogs, maxItems: MAX_FLOW_STEPS }
  )
  const fieldIds = normalizeIdentifierCatalog(
    readAlias(context, ['validFieldIds', 'valid_field_ids']),
    'context.validFieldIds',
    { required: requireCatalogs, maxItems: MAX_FLOW_FIELDS }
  )

  if (requireCatalogs && stepIds.length === 0) {
    throw siteFlowError('context.validStepIds must contain at least one step')
  }

  return {
    siteId,
    formSiteId,
    publicPageId: cleanOpaqueIdentifier(
      readAlias(context, ['publicPageId', 'public_page_id']),
      'context.publicPageId'
    ),
    flowRevision,
    visitorId,
    sessionId,
    contactId: cleanOpaqueIdentifier(
      readAlias(context, ['contactId', 'contact_id']),
      'context.contactId'
    ),
    stepIds,
    stepIdSet: new Set(stepIds),
    stepPositions: new Map(stepIds.map((stepId, index) => [stepId, index + 1])),
    fieldIds,
    fieldIdSet: new Set(fieldIds)
  }
}

function normalizeReceivedAt(value) {
  const parsed = value instanceof Date ? value : new Date(value || Date.now())
  return Number.isFinite(parsed.getTime()) ? parsed : new Date()
}

function normalizeClientEventTime(value, receivedAt) {
  const parsedNumber = typeof value === 'number' ? value : Number.NaN
  const parsed = value instanceof Date
    ? value
    : Number.isFinite(parsedNumber)
      ? new Date(parsedNumber)
      : new Date(String(value || ''))

  if (!Number.isFinite(parsed.getTime())) {
    return {
      clientEventAt: null,
      eventAt: receivedAt.toISOString(),
      timestampAdjusted: 1
    }
  }

  const clientEventAt = parsed.toISOString()
  if (Math.abs(parsed.getTime() - receivedAt.getTime()) > MAX_CLIENT_EVENT_CLOCK_SKEW_MS) {
    return {
      clientEventAt,
      eventAt: receivedAt.toISOString(),
      timestampAdjusted: 1
    }
  }

  return {
    clientEventAt,
    eventAt: clientEventAt,
    timestampAdjusted: 0
  }
}

function normalizeClientEvent(rawEvent, context, receivedAt) {
  assertPlainObject(rawEvent, 'event')
  assertAllowedKeys(rawEvent, CLIENT_EVENT_KEYS, 'event')

  const eventName = cleanString(
    readAlias(rawEvent, ['event_name', 'eventName']),
    'event.eventName',
    { required: true, maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase()
  if (!SITE_FLOW_CLIENT_EVENT_SET.has(eventName)) {
    if (SITE_FLOW_TERMINAL_EVENT_SET.has(eventName)) {
      throw siteFlowError(`${eventName} is server-authoritative`)
    }
    throw siteFlowError(`Unsupported site flow event: ${eventName}`)
  }

  const eventId = cleanOpaqueIdentifier(
    readAlias(rawEvent, ['event_id', 'eventId']),
    'event.eventId',
    { required: true, maxLength: EVENT_ID_MAX_LENGTH }
  )
  const eventSequence = positiveInteger(
    readAlias(rawEvent, ['event_sequence', 'eventSequence']),
    'event.eventSequence',
    { required: true, max: MAX_CLIENT_EVENT_SEQUENCE }
  )
  if (eventId.startsWith(SERVER_TERMINAL_EVENT_ID_PREFIX)) {
    throw siteFlowError('event.eventId uses a server-reserved prefix')
  }
  const stepId = cleanOpaqueIdentifier(
    readAlias(rawEvent, ['step_id', 'stepId']),
    'event.stepId'
  )
  const targetStepId = cleanOpaqueIdentifier(
    readAlias(rawEvent, ['target_step_id', 'targetStepId']),
    'event.targetStepId'
  )
  const fieldId = cleanOpaqueIdentifier(
    readAlias(rawEvent, ['field_id', 'fieldId']),
    'event.fieldId'
  )

  if (eventName !== 'attempt_start' && !stepId) {
    throw siteFlowError(`${eventName} requires event.stepId`)
  }
  if (stepId && !context.stepIdSet.has(stepId)) {
    throw siteFlowError(`Unknown event.stepId: ${stepId}`)
  }
  if (targetStepId && eventName !== 'step_complete') {
    throw siteFlowError('event.targetStepId is only valid for step_complete')
  }
  if (targetStepId && !context.stepIdSet.has(targetStepId)) {
    throw siteFlowError(`Unknown event.targetStepId: ${targetStepId}`)
  }
  if (eventName === 'step_complete' && !targetStepId) {
    throw siteFlowError('step_complete requires event.targetStepId')
  }
  if (eventName === 'step_complete' && targetStepId === stepId) {
    throw siteFlowError('step_complete cannot target the same step')
  }
  if (eventName === 'field_answered' && !fieldId) {
    throw siteFlowError('field_answered requires event.fieldId')
  }
  if (fieldId && eventName !== 'field_answered') {
    throw siteFlowError('event.fieldId is only valid for field_answered')
  }
  if (fieldId && !context.fieldIdSet.has(fieldId)) {
    throw siteFlowError(`Unknown event.fieldId: ${fieldId}`)
  }

  const stepKind = cleanString(
    readAlias(rawEvent, ['step_kind', 'stepKind']),
    'event.stepKind',
    { maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase() || null
  if (stepKind && !CLIENT_STEP_KINDS.has(stepKind)) {
    throw siteFlowError(`Unsupported event.stepKind: ${stepKind}`)
  }
  const outcome = cleanString(
    rawEvent.outcome,
    'event.outcome',
    { maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase() || null
  if (outcome && eventName !== 'step_complete') {
    throw siteFlowError('event.outcome is only valid for step_complete')
  }
  if (outcome && !CLIENT_STEP_OUTCOMES.has(outcome)) {
    throw siteFlowError(`Unsupported event.outcome: ${outcome}`)
  }

  const suppliedStepIndex = positiveInteger(
    readAlias(rawEvent, ['step_index', 'stepIndex']),
    'event.stepIndex',
    { max: MAX_FLOW_STEPS }
  )
  const suppliedStepTotal = positiveInteger(
    readAlias(rawEvent, ['step_total', 'stepTotal']),
    'event.stepTotal',
    { max: MAX_FLOW_STEPS }
  )
  const expectedStepIndex = stepId ? context.stepPositions.get(stepId) : null
  if (suppliedStepIndex && suppliedStepIndex !== expectedStepIndex) {
    throw siteFlowError('event.stepIndex does not match context.validStepIds')
  }
  if (suppliedStepTotal && suppliedStepTotal !== context.stepIds.length) {
    throw siteFlowError('event.stepTotal does not match context.validStepIds')
  }

  const clientTime = normalizeClientEventTime(
    readAlias(rawEvent, ['client_event_at', 'clientEventAt', 'ts', 'timestamp']),
    receivedAt
  )

  return {
    eventId,
    eventSequence,
    eventName,
    stepId,
    targetStepId,
    fieldId,
    stepIndex: expectedStepIndex,
    stepTotal: context.stepIds.length,
    stepKind,
    outcome,
    submissionId: null,
    receivedAt: receivedAt.toISOString(),
    ...clientTime
  }
}

function buildSiteFlowPayloadHash(event, context, attemptId) {
  // contactId es una asociación resoluble/mutable del servidor, no parte del
  // payload inmutable del navegador. Un retry del mismo evento no debe volverse
  // conflicto sólo porque el contacto se identificó entre ambas peticiones.
  const canonical = {
    version: 1,
    eventId: event.eventId,
    attemptId,
    eventSequence: event.eventSequence,
    eventName: event.eventName,
    visitorId: context.visitorId,
    sessionId: context.sessionId,
    siteId: context.siteId,
    formSiteId: context.formSiteId,
    publicPageId: context.publicPageId,
    flowRevision: context.flowRevision,
    stepId: event.stepId,
    targetStepId: event.targetStepId,
    fieldId: event.fieldId,
    stepIndex: event.stepIndex,
    stepTotal: event.stepTotal,
    stepKind: event.stepKind,
    outcome: event.outcome,
    submissionId: event.submissionId,
    clientEventAt: event.clientEventAt
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

async function getAttemptLedger(tx, attemptId) {
  return tx.all(`
    SELECT
      id,
      event_id,
      payload_hash,
      attempt_id,
      event_sequence,
      event_name,
      visitor_id,
      session_id,
      contact_id,
      site_id,
      form_site_id,
      public_page_id,
      flow_revision,
      step_id,
      target_step_id,
      field_id,
      step_index,
      step_total,
      step_kind,
      outcome,
      submission_id,
      client_event_at,
      event_at,
      created_at,
      timestamp_adjusted
    FROM site_flow_events
    WHERE attempt_id = ?
    ORDER BY event_sequence ASC, id ASC
  `, [attemptId])
}

async function getSiteFlowEventById(tx, eventId) {
  return tx.get(`
    SELECT
      event_id,
      attempt_id,
      event_sequence,
      event_name,
      visitor_id,
      session_id,
      contact_id,
      site_id,
      form_site_id,
      public_page_id,
      flow_revision,
      step_id,
      step_kind,
      outcome,
      submission_id,
      event_at
    FROM site_flow_events
    WHERE event_id = ?
    LIMIT 1
  `, [eventId])
}

function assertStableAttemptContext(existing, incoming) {
  if (!existing) return
  for (const [column, field] of [
    ['site_id', 'siteId'],
    ['form_site_id', 'formSiteId'],
    ['flow_revision', 'flowRevision'],
    ['visitor_id', 'visitorId'],
    ['session_id', 'sessionId']
  ]) {
    const persisted = existing[column] === null || existing[column] === undefined
      ? null
      : String(existing[column])
    if (persisted && incoming[field] && persisted !== incoming[field]) {
      throw siteFlowConflict(`Attempt context changed for ${field}`)
    }
  }
}

function isSamePersistedEvent(existing, event, payloadHash, attemptId) {
  return Boolean(
    existing &&
    String(existing.event_id) === event.eventId &&
    String(existing.attempt_id) === attemptId &&
    Number(existing.event_sequence) === event.eventSequence &&
    String(existing.payload_hash) === payloadHash
  )
}

function siteFlowAttemptExpired() {
  return siteFlowError('Site flow attempt expired', {
    status: 410,
    code: 'SITE_FLOW_ATTEMPT_EXPIRED'
  })
}

function initialAttemptMachine(existingRows = []) {
  const start = existingRows.find(row => row.event_name === 'attempt_start') || null
  return {
    eventCount: existingRows.length,
    hasStart: Boolean(start),
    startedAt: start?.created_at ? new Date(start.created_at) : null,
    terminal: existingRows.some(row => SITE_FLOW_TERMINAL_EVENT_SET.has(row.event_name)),
    maxClientSequence: existingRows.reduce((max, row) => (
      SITE_FLOW_TERMINAL_EVENT_SET.has(row.event_name)
        ? max
        : Math.max(max, Number(row.event_sequence || 0))
    ), 0),
    viewedSteps: new Set(
      existingRows
        .filter(row => row.event_name === 'step_view' && row.step_id)
        .map(row => String(row.step_id))
    )
  }
}

function assertClientEventTransition(machine, event, receivedAt) {
  if (!machine.hasStart) {
    if (event.eventName !== 'attempt_start' || event.eventSequence !== 1) {
      throw siteFlowConflict('attempt_start must be the first event with sequence 1')
    }
    machine.hasStart = true
    machine.startedAt = receivedAt
    return
  }

  if (event.eventName === 'attempt_start') {
    throw siteFlowConflict('attempt_start can only be recorded once')
  }
  if (
    (event.eventName === 'field_answered' || event.eventName === 'step_complete') &&
    !machine.viewedSteps.has(event.stepId)
  ) {
    throw siteFlowConflict(`${event.eventName} requires a prior step_view for the same step`)
  }
  if (event.eventName === 'step_view') {
    machine.viewedSteps.add(event.stepId)
  }
}

function assertAttemptCanAcceptNewEvent(machine, event, receivedAt) {
  if (machine.terminal) {
    throw siteFlowConflict('The attempt is already terminal')
  }
  if (
    machine.startedAt &&
    Number.isFinite(machine.startedAt.getTime()) &&
    receivedAt.getTime() - machine.startedAt.getTime() > MAX_SITE_FLOW_ATTEMPT_AGE_MS
  ) {
    throw siteFlowAttemptExpired()
  }
  if (machine.eventCount >= MAX_CLIENT_EVENTS_PER_ATTEMPT) {
    throw siteFlowConflict(
      `The attempt exceeds ${MAX_CLIENT_EVENTS_PER_ATTEMPT} client events`
    )
  }
  if (event.eventSequence !== machine.maxClientSequence + 1) {
    throw siteFlowConflict('New events must continue the global attempt sequence')
  }
  assertClientEventTransition(machine, event, receivedAt)
  machine.maxClientSequence = event.eventSequence
  machine.eventCount += 1
}

function preflightClientBatch({
  existingRows,
  events,
  context,
  attemptId,
  receivedAt
}) {
  const byEventId = new Map(existingRows.map(row => [String(row.event_id), row]))
  const bySequence = new Map(existingRows.map(row => [Number(row.event_sequence), row]))
  const machine = initialAttemptMachine(existingRows)

  for (const event of events) {
    const payloadHash = buildSiteFlowPayloadHash(event, context, attemptId)
    const existingById = byEventId.get(event.eventId)
    const existingBySequence = bySequence.get(event.eventSequence)

    if (
      isSamePersistedEvent(existingById, event, payloadHash, attemptId) &&
      existingBySequence === existingById
    ) {
      // Un retry exacto siempre es inocuo, aun si el intento expiró o terminó.
      continue
    }
    if (existingById || existingBySequence) {
      throw siteFlowConflict(
        'Site flow event id or attempt sequence was already used with a different payload'
      )
    }

    assertAttemptCanAcceptNewEvent(machine, event, receivedAt)
    const projected = {
      event_id: event.eventId,
      payload_hash: payloadHash,
      attempt_id: attemptId,
      event_sequence: event.eventSequence,
      event_name: event.eventName,
      step_id: event.stepId,
      event_at: event.eventAt
    }
    byEventId.set(event.eventId, projected)
    bySequence.set(event.eventSequence, projected)
  }
}

function attemptLockName(attemptId) {
  const digest = crypto.createHash('sha256').update(attemptId).digest('hex')
  return `site-flow-attempt:${digest}`
}

async function withAttemptLock(attemptId, callback, {
  maxAttempts = 4,
  retryDelayMs = 25
} = {}) {
  if (typeof db.withAdvisoryLock !== 'function') return callback()
  const attempts = Math.max(1, Math.min(12, Number(maxAttempts) || 1))
  const baseDelay = Math.max(5, Math.min(150, Number(retryDelayMs) || 25))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await db.withAdvisoryLock(attemptLockName(attemptId), callback)
    } catch (error) {
      if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY' || attempt >= attempts) {
        throw error
      }
      await new Promise(resolve => {
        setTimeout(resolve, Math.min(200, baseDelay * attempt))
      })
    }
  }
  throw siteFlowConflict('The attempt is temporarily busy')
}

async function insertSiteFlowEvent(tx, {
  attemptId,
  context,
  event
}) {
  const payloadHash = buildSiteFlowPayloadHash(event, context, attemptId)
  const result = await tx.run(`
    INSERT INTO site_flow_events (
      id,
      event_id,
      payload_hash,
      attempt_id,
      event_sequence,
      event_name,
      visitor_id,
      session_id,
      contact_id,
      site_id,
      form_site_id,
      public_page_id,
      flow_revision,
      step_id,
      target_step_id,
      field_id,
      step_index,
      step_total,
      step_kind,
      outcome,
      submission_id,
      client_event_at,
      event_at,
      created_at,
      timestamp_adjusted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, [
    crypto.randomUUID(),
    event.eventId,
    payloadHash,
    attemptId,
    event.eventSequence,
    event.eventName,
    context.visitorId,
    context.sessionId,
    context.contactId,
    context.siteId,
    context.formSiteId,
    context.publicPageId,
    context.flowRevision,
    event.stepId,
    event.targetStepId,
    event.fieldId,
    event.stepIndex,
    event.stepTotal,
    event.stepKind,
    event.outcome,
    event.submissionId,
    event.clientEventAt,
    event.eventAt,
    event.receivedAt,
    event.timestampAdjusted
  ])

  if (Number(result.changes || 0) === 1) {
    return {
      inserted: true,
      deduplicated: false,
      payloadHash,
      eventAt: event.eventAt,
      timestampAdjusted: event.timestampAdjusted
    }
  }

  const existing = await tx.get(`
    SELECT
      event_id,
      payload_hash,
      attempt_id,
      event_sequence,
      event_at,
      timestamp_adjusted
    FROM site_flow_events
    WHERE event_id = ?
       OR (attempt_id = ? AND event_sequence = ?)
    ORDER BY CASE WHEN event_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `, [
    event.eventId,
    attemptId,
    event.eventSequence,
    event.eventId
  ])

  if (
    existing &&
    String(existing.event_id) === event.eventId &&
    String(existing.attempt_id) === attemptId &&
    Number(existing.event_sequence) === event.eventSequence &&
    String(existing.payload_hash) === payloadHash
  ) {
    return {
      inserted: false,
      deduplicated: true,
      payloadHash,
      eventAt: new Date(existing.event_at).toISOString(),
      timestampAdjusted: Number(existing.timestamp_adjusted || 0)
    }
  }

  throw siteFlowConflict(
    'Site flow event id or attempt sequence was already used with a different payload'
  )
}

/**
 * Persiste un lote público ya contextualizado por el renderer/controller.
 *
 * body:
 *   { attemptId, events: [{ eventId, eventSequence, eventName, ...metadata }] }
 * context:
 *   { siteId, formSiteId, publicPageId?, flowRevision, validStepIds,
 *     validFieldIds, visitorId, sessionId, contactId? }
 */
export async function ingestSiteFlowEventBatch({
  body,
  context
} = {}) {
  assertPlainObject(body, 'body')
  assertAllowedKeys(body, BATCH_BODY_KEYS, 'body')
  let serializedBody
  try {
    serializedBody = JSON.stringify(body)
  } catch {
    throw siteFlowError('body must be JSON-serializable')
  }
  if (Buffer.byteLength(serializedBody || '', 'utf8') > SITE_FLOW_MAX_BATCH_BYTES) {
    throw siteFlowError(`body exceeds ${SITE_FLOW_MAX_BATCH_BYTES} bytes`)
  }

  const attemptId = cleanOpaqueIdentifier(
    readAlias(body, ['attempt_id', 'attemptId']),
    'body.attemptId',
    { required: true }
  )
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw siteFlowError('body.events must contain at least one event')
  }
  if (body.events.length > SITE_FLOW_MAX_BATCH_EVENTS) {
    throw siteFlowError(
      `body.events exceeds ${SITE_FLOW_MAX_BATCH_EVENTS} events`
    )
  }

  const normalizedContext = normalizeContext(context, {
    requireCatalogs: true,
    requireStableIdentity: true
  })
  const receivedAt = normalizeReceivedAt(
    readAlias(context, ['receivedAt', 'received_at'])
  )
  const events = body.events.map(rawEvent => (
    normalizeClientEvent(rawEvent, normalizedContext, receivedAt)
  ))

  const eventIds = new Set()
  let previousSequence = 0
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      throw siteFlowError('body.events contains duplicate eventId values')
    }
    if (event.eventSequence <= previousSequence) {
      throw siteFlowError('body.events must be strictly ordered by eventSequence')
    }
    eventIds.add(event.eventId)
    previousSequence = event.eventSequence
  }

  return withAttemptLock(attemptId, () => db.transaction(async tx => {
    const existingRows = await getAttemptLedger(tx, attemptId)
    const existingContext = existingRows[0] || null
    assertStableAttemptContext(existingContext, normalizedContext)
    preflightClientBatch({
      existingRows,
      events,
      context: normalizedContext,
      attemptId,
      receivedAt
    })

    const acceptedEvents = []
    let inserted = 0
    let deduplicated = 0
    for (const event of events) {
      const ledger = await insertSiteFlowEvent(tx, {
        attemptId,
        context: normalizedContext,
        event
      })
      inserted += ledger.inserted ? 1 : 0
      deduplicated += ledger.deduplicated ? 1 : 0
      acceptedEvents.push({
        eventId: event.eventId,
        eventSequence: event.eventSequence,
        eventName: event.eventName,
        inserted: ledger.inserted,
        deduplicated: ledger.deduplicated,
        eventAt: ledger.eventAt,
        timestampAdjusted: ledger.timestampAdjusted
      })
    }

    return {
      accepted: true,
      attemptId,
      inserted,
      deduplicated,
      events: acceptedEvents
    }
  }), {
    maxAttempts: 4,
    retryDelayMs: 20
  })
}

function resolveTerminalContext(existing, incoming) {
  assertStableAttemptContext(existing, incoming)
  const resolved = {
    ...incoming,
    siteId: incoming.siteId || existing?.site_id || null,
    formSiteId: incoming.formSiteId || existing?.form_site_id || null,
    publicPageId: incoming.publicPageId || existing?.public_page_id || null,
    flowRevision: incoming.flowRevision || existing?.flow_revision || null,
    visitorId: incoming.visitorId || existing?.visitor_id || null,
    sessionId: incoming.sessionId || existing?.session_id || null,
    contactId: incoming.contactId || existing?.contact_id || null
  }
  for (const field of [
    'siteId',
    'formSiteId',
    'flowRevision',
    'visitorId',
    'sessionId'
  ]) {
    if (!resolved[field]) {
      throw siteFlowError(`context.${field} is required for a terminal event`)
    }
  }
  return resolved
}

function deterministicTerminalEventId({
  attemptId,
  eventName,
  submissionId
}) {
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    attemptId,
    eventName,
    submissionId
  })).digest('hex')
  return `${SERVER_TERMINAL_EVENT_ID_PREFIX}${digest}`
}

/**
 * Registra el cierre confirmado por el servidor. El navegador no puede escribir
 * attempt_completed/attempt_terminal. La secuencia máxima reservada garantiza un
 * solo cierre por intento; el event_id determinista vuelve inocuo el reintento de
 * la misma submission y hace conflicto si intentan cerrar con otra evidencia.
 */
export async function recordSiteFlowTerminalEvent({
  attemptId,
  eventName = 'attempt_completed',
  submissionId,
  outcome,
  context = {},
  stepId,
  stepKind,
  occurredAt
} = {}) {
  const normalizedAttemptId = cleanOpaqueIdentifier(
    attemptId,
    'attemptId',
    { required: true }
  )
  const normalizedEventName = cleanString(
    eventName,
    'eventName',
    { required: true, maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase()
  if (!SITE_FLOW_TERMINAL_EVENT_SET.has(normalizedEventName)) {
    throw siteFlowError('eventName must be attempt_completed or attempt_terminal')
  }
  const normalizedSubmissionId = cleanOpaqueIdentifier(
    submissionId,
    'submissionId',
    { required: true }
  )
  const incomingContext = normalizeContext(context)
  const normalizedStepId = cleanOpaqueIdentifier(stepId, 'stepId')
  if (
    normalizedStepId &&
    incomingContext.stepIdSet.size > 0 &&
    !incomingContext.stepIdSet.has(normalizedStepId)
  ) {
    throw siteFlowError(`Unknown stepId: ${normalizedStepId}`)
  }
  const eventAtDate = occurredAt === undefined || occurredAt === null
    ? new Date()
    : new Date(occurredAt)
  if (!Number.isFinite(eventAtDate.getTime())) {
    throw siteFlowError('occurredAt must be a valid server timestamp')
  }
  const eventAt = eventAtDate.toISOString()
  const normalizedStepKind = cleanString(
    stepKind,
    'stepKind',
    { maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase() || null
  const normalizedOutcome = cleanString(
    outcome || (normalizedEventName === 'attempt_completed' ? 'completed' : 'terminal'),
    'outcome',
    { required: true, maxLength: EVENT_LABEL_MAX_LENGTH }
  )?.toLowerCase()
  const terminalEventId = deterministicTerminalEventId({
    attemptId: normalizedAttemptId,
    eventName: normalizedEventName,
    submissionId: normalizedSubmissionId
  })

  return withAttemptLock(normalizedAttemptId, () => db.transaction(async tx => {
    const persistedTerminal = await getSiteFlowEventById(tx, terminalEventId)
    if (persistedTerminal) {
      assertStableAttemptContext(persistedTerminal, incomingContext)
      if (
        String(persistedTerminal.attempt_id) !== normalizedAttemptId ||
        String(persistedTerminal.event_name) !== normalizedEventName ||
        String(persistedTerminal.submission_id) !== normalizedSubmissionId ||
        String(persistedTerminal.outcome) !== normalizedOutcome ||
        (
          normalizedStepId &&
          String(persistedTerminal.step_id || '') !== normalizedStepId
        ) ||
        (
          normalizedStepKind &&
          String(persistedTerminal.step_kind || '') !== normalizedStepKind
        ) ||
        (
          incomingContext.publicPageId &&
          persistedTerminal.public_page_id &&
          String(persistedTerminal.public_page_id) !== incomingContext.publicPageId
        )
      ) {
        throw siteFlowConflict(
          'Terminal event was already recorded with different server evidence'
        )
      }
      return {
        accepted: true,
        attemptId: normalizedAttemptId,
        eventId: terminalEventId,
        eventSequence: Number(persistedTerminal.event_sequence),
        eventName: normalizedEventName,
        submissionId: normalizedSubmissionId,
        inserted: false,
        deduplicated: true,
        eventAt: new Date(persistedTerminal.event_at).toISOString()
      }
    }

    const existingRows = await getAttemptLedger(tx, normalizedAttemptId)
    const existingContext = existingRows[0] || null
    const existingTerminal = existingRows.find(row => (
      SITE_FLOW_TERMINAL_EVENT_SET.has(row.event_name)
    ))
    if (existingTerminal) {
      throw siteFlowConflict('The attempt is already terminal')
    }
    if (existingRows.length >= SITE_FLOW_MAX_EVENTS_PER_ATTEMPT) {
      throw siteFlowConflict(
        `The attempt exceeds ${SITE_FLOW_MAX_EVENTS_PER_ATTEMPT} total events`
      )
    }
    const start = existingRows.find(row => row.event_name === 'attempt_start')
    if (
      start?.created_at &&
      eventAtDate.getTime() - new Date(start.created_at).getTime() > MAX_SITE_FLOW_ATTEMPT_AGE_MS
    ) {
      throw siteFlowAttemptExpired()
    }
    const resolvedContext = resolveTerminalContext(existingContext, incomingContext)
    const resolvedStepIndex = normalizedStepId
      ? incomingContext.stepPositions.get(normalizedStepId) || null
      : null
    const event = {
      eventId: terminalEventId,
      eventSequence: SITE_FLOW_SERVER_TERMINAL_SEQUENCE,
      eventName: normalizedEventName,
      stepId: normalizedStepId,
      targetStepId: null,
      fieldId: null,
      stepIndex: resolvedStepIndex,
      stepTotal: incomingContext.stepIds.length || null,
      stepKind: normalizedStepKind,
      outcome: normalizedOutcome,
      submissionId: normalizedSubmissionId,
      clientEventAt: null,
      eventAt,
      receivedAt: eventAt,
      timestampAdjusted: 0
    }
    const ledger = await insertSiteFlowEvent(tx, {
      attemptId: normalizedAttemptId,
      context: resolvedContext,
      event
    })

    return {
      accepted: true,
      attemptId: normalizedAttemptId,
      eventId: event.eventId,
      eventSequence: event.eventSequence,
      eventName: event.eventName,
      submissionId: normalizedSubmissionId,
      inserted: ledger.inserted,
      deduplicated: ledger.deduplicated,
      eventAt: ledger.eventAt
    }
  }), {
    // El cierre viene de un submit real. Espera de forma acotada una escritura
    // de telemetría concurrente antes de rendirse; nunca bloquea indefinidamente.
    maxAttempts: 8,
    retryDelayMs: 25
  })
}
