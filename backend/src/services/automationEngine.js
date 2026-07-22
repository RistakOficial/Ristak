import { DateTime } from 'luxon'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { DEFAULT_TIMEZONE, getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'
import { createInternalNotification } from './notificationsService.js'
import {
  collectAutomationFlowRequiredFeatures,
  getAutomationNodeRequiredFeatures
} from './automationFlowValidation.js'
import { canRunBackgroundJob, hasFeature, isLicenseEnforced } from './licenseService.js'
import {
  findContactByPhoneCandidates,
  finalizePreparedPhoneUpsert,
  generateContactId,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import { createRistakId } from '../utils/idGenerator.js'
import { invalidateTrackingAnalyticsCache } from './trackingAnalyticsCache.js'
import { normalizeContactNameFields } from '../utils/contactNameFormatter.js'
import {
  claimAppointmentTestAction,
  completeAppointmentTestAction,
  recordSimulatedAppointmentTestAction
} from './conversationalAppointmentTestAutomationAuditService.js'
import {
  AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE,
  listPublishedAutomationRowsByIds,
  listPublishedAutomationRowsForEvent
} from './automationTriggerIndexService.js'

/**
 * Motor de ejecución de automatizaciones.
 *
 * Cuando ocurre un evento real (p. ej. un contacto escribe por WhatsApp),
 * inscribe al contacto en las automatizaciones publicadas cuyo disparador
 * coincide y recorre el flujo paso a paso, registrando TODO en
 * automation_enrollments.log para que el usuario vea qué pasó y dónde se
 * detuvo. Los pasos que el motor aún no sabe ejecutar se registran como
 * "omitido" y el flujo continúa: nunca se pierde silenciosamente.
 */

const MAX_STEPS = 60
const MAX_INLINE_DELAY_SECONDS = 120
// Si un deploy o reinicio cruza la hora exacta de un disparador, el trabajo no
// debe desaparecer. Recuperamos una ejecución reciente, pero no revivimos
// campañas viejas al volver a levantar el backend.
const SCHEDULE_TRIGGER_CATCHUP_MINUTES = 24 * 60
const WAIT_KIND_REPLY = 'reply'
const WAIT_KIND_BUTTON_REPLY = 'button_reply'
const WAIT_KIND_TRIGGER_LINK_CLICK = 'trigger-link-click'
const WAIT_KIND_DRIP = 'drip'
// (AUTO-005) Espera especial para reintentar el MISMO nodo que falló de forma
// transitoria, en vez de expulsar la inscripción ('exited') al primer error.
const WAIT_KIND_RETRY = 'retry'
const RETRY_MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = [60000, 300000, 900000] // 1 min, 5 min, 15 min
const ACTIVE_ENROLLMENT_STATUS_SQL = "'active', 'waiting', 'paused'"
// (AUTO-008) Tope global de profundidad de cascada: una acción (p. ej. poner una
// etiqueta) puede disparar otra automatización cuya acción dispara otra, y así en
// cadena. Sin tope, un par de automatizaciones que se etiquetan mutuamente con
// etiquetas distintas se re-disparan indefinidamente.
const MAX_CASCADE_DEPTH = 5
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const CONDITION_VARIABLE_FIELD_PREFIX = 'var:'
const MESSAGE_TRIGGER_CHANNELS = {
  'trigger-whatsapp-message': 'whatsapp',
  'trigger-click-to-whatsapp': 'whatsapp',
  'trigger-instagram-message': 'instagram',
  'trigger-messenger-message': 'messenger',
  'trigger-email-message': 'email'
}

async function canRunAutomationFlow(flow = {}) {
  if (!(await canRunBackgroundJob('automations'))) return false
  if (!isLicenseEnforced()) return true

  for (const featureKey of collectAutomationFlowRequiredFeatures(flow)) {
    if (!(await hasFeature(featureKey))) return false
  }
  return true
}

async function assertAutomationNodeFeatureAccess(node = {}) {
  if (!isLicenseEnforced()) return
  for (const featureKey of getAutomationNodeRequiredFeatures(node)) {
    if (!(await hasFeature(featureKey))) {
      throw engineError(403, `El paso "${nodeLabel(node)}" necesita una función que no está incluida en tu plan actual.`)
    }
  }
}

function makeId(prefix) {
  return createRistakId(prefix)
}

function nowIso() {
  return new Date().toISOString()
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function engineError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeConversationChannel(value = '') {
  const channel = cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
  if (!channel) return ''
  if (channel.includes('whatsapp') || channel === 'wa') return 'whatsapp'
  if (channel.includes('instagram') || channel === 'ig' || channel === 'instagram_dm') return 'instagram'
  if (channel.includes('messenger') || channel === 'facebook' || channel === 'fb') return 'messenger'
  if (channel.includes('email') || channel.includes('correo') || channel === 'mail') return 'email'
  return channel
}

function normalizeButtonMatchText(value) {
  return normalizeText(value).replace(/\s+/g, ' ')
}

function normalizeMessageButtons(value = []) {
  if (!Array.isArray(value)) return []
  return value
    .map((button, index) => {
      const label = cleanString(button?.label || button?.title || button?.text)
      const id = cleanString(button?.id || button?.payload || `btn_${index}`)
      const action = cleanString(button?.action) === 'url' ? 'url' : 'branch'
      return {
        id,
        label,
        action,
        url: cleanString(button?.url)
      }
    })
    .filter(button => button.label)
}

function findMatchingWaitButton(waitButtons = [], reply = {}) {
  const buttons = normalizeMessageButtons(waitButtons)
  if (!buttons.length) return null

  const candidates = [
    reply.buttonId,
    reply.buttonPayload,
    reply.buttonTitle,
    reply.text
  ].map(normalizeButtonMatchText).filter(Boolean)

  return buttons.find(button => {
    const buttonCandidates = [
      button.id,
      `btn_${button.id}`,
      button.label
    ].map(normalizeButtonMatchText).filter(Boolean)
    return buttonCandidates.some(candidate => candidates.includes(candidate))
  }) || null
}

function boolText(value) {
  return value ? 'true' : 'false'
}

function isConditionVariableField(field) {
  return str(field).startsWith(CONDITION_VARIABLE_FIELD_PREFIX)
}

function conditionVariableTokenFromField(field) {
  const value = str(field)
  return isConditionVariableField(value) ? value.slice(CONDITION_VARIABLE_FIELD_PREFIX.length) : value
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function customFieldsBag(raw) {
  const parsed = parseJson(raw, raw)
  if (Array.isArray(parsed)) {
    return parsed.reduce((bag, field) => {
      if (!isPlainObject(field)) return bag
      const key = cleanString(field.key || field.fieldKey || field.field_key || field.id || field.label || field.name)
      if (!key) return bag
      const value = Object.prototype.hasOwnProperty.call(field, 'value')
        ? field.value
        : Object.prototype.hasOwnProperty.call(field, 'fieldValue')
          ? field.fieldValue
          : Object.prototype.hasOwnProperty.call(field, 'field_value')
            ? field.field_value
            : ''
      bag[key] = value
      return bag
    }, {})
  }
  if (isPlainObject(parsed)) {
    return Object.entries(parsed).reduce((bag, [key, value]) => {
      bag[key] = isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value
      return bag
    }, {})
  }
  return {}
}

function setDeepVariable(map, prefix, value) {
  if (value === null || value === undefined) {
    map[prefix] = ''
    return
  }
  if (Array.isArray(value)) {
    if (value.length === 0) map[prefix] = ''
    value.forEach((child, index) => setDeepVariable(map, `${prefix}[${index}]`, child))
    return
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) map[prefix] = ''
    entries.forEach(([key, child]) => setDeepVariable(map, `${prefix}.${key}`, child))
    return
  }
  map[prefix] = String(value)
}

function pathSegments(path) {
  const segments = []
  const pattern = /([^[.\]]+)|\[(\d+)\]/g
  let match
  while ((match = pattern.exec(path))) {
    segments.push(match[1] !== undefined ? match[1] : Number(match[2]))
  }
  return segments
}

function readPath(source, path) {
  if (!path) return source
  let current = source
  for (const segment of pathSegments(path)) {
    if (current === null || current === undefined) return undefined
    current = current[segment]
  }
  return current
}

function normalizeAnswerLookupKey(value) {
  return cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function answerComparableValue(value) {
  if (Array.isArray(value)) return value.map(answerComparableValue).filter(Boolean).join(', ')
  if (isPlainObject(value)) return JSON.stringify(value)
  return cleanString(value)
}

function setAnswerAlias(target, key, value, { overwrite = false } = {}) {
  const directKey = cleanString(key)
  const normalizedKey = normalizeAnswerLookupKey(directKey)
  if (directKey && (overwrite || target[directKey] === undefined)) target[directKey] = value
  if (normalizedKey && (overwrite || target[normalizedKey] === undefined)) target[normalizedKey] = value
}

function answerProperty(answer, keys, fallback = undefined) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(answer, key)) return answer[key]
  }
  return fallback
}

function addFormAnswer(normalized, answer = {}, index = 0) {
  const value = answerProperty(answer, [
    'value',
    'answer',
    'fieldValue',
    'field_value',
    'rawValue',
    'raw_value'
  ], '')
  const text = answerProperty(answer, [
    'text',
    'displayText',
    'display_text',
    'displayValue',
    'display_value',
    'labelValue',
    'label_value',
    'answerText',
    'answer_text'
  ], value)
  const id = cleanString(answer.id || answer.fieldId || answer.field_id || answer.blockId || answer.block_id)
  const key = cleanString(answer.key || answer.fieldKey || answer.field_key || answer.name || answer.internalName || answer.internal_name)
  const label = cleanString(answer.label || answer.question || answer.title || answer.name || key || id || `Respuesta ${index + 1}`)
  const entry = {
    id,
    key: key || normalizeAnswerLookupKey(label || id || `respuesta_${index + 1}`),
    label,
    value,
    text,
    type: cleanString(answer.type || answer.blockType || answer.block_type || '')
  }

  normalized.answers.push(entry)
  setAnswerAlias(normalized.byId, id, value)
  setAnswerAlias(normalized.byKey, entry.key, value)
  setAnswerAlias(normalized.byLabel, label, value)
  setAnswerAlias(normalized.valueById, id, value)
  setAnswerAlias(normalized.valueByKey, entry.key, value)
  setAnswerAlias(normalized.valueByLabel, label, value)
  setAnswerAlias(normalized.textById, id, text)
  setAnswerAlias(normalized.textByKey, entry.key, text)
  setAnswerAlias(normalized.textByLabel, label, text)
}

function normalizeFormResponses(raw) {
  const normalized = {
    answers: [],
    byId: {},
    byKey: {},
    byLabel: {},
    valueById: {},
    valueByKey: {},
    valueByLabel: {},
    textById: {},
    textByKey: {},
    textByLabel: {},
    summary: ''
  }
  const source = parseJson(raw, raw)
  if (!source || typeof source !== 'object') return normalized

  if (Array.isArray(source.answers)) {
    source.answers.forEach((answer, index) => addFormAnswer(normalized, answer, index))
  }

  const bags = [
    ['byId', source.byId || source.by_id],
    ['byKey', source.byKey || source.by_key],
    ['byLabel', source.byLabel || source.by_label],
    ['valueById', source.valueById || source.value_by_id],
    ['valueByKey', source.valueByKey || source.value_by_key],
    ['valueByLabel', source.valueByLabel || source.value_by_label],
    ['textById', source.textById || source.text_by_id],
    ['textByKey', source.textByKey || source.text_by_key],
    ['textByLabel', source.textByLabel || source.text_by_label]
  ]
  for (const [targetKey, bag] of bags) {
    if (!isPlainObject(bag)) continue
    Object.entries(bag).forEach(([key, value]) => {
      const overwrite = targetKey.startsWith('text') || targetKey.startsWith('value')
      setAnswerAlias(normalized[targetKey], key, value, { overwrite })
      if (targetKey === 'byId') {
        setAnswerAlias(normalized.valueById, key, value)
        setAnswerAlias(normalized.textById, key, value)
      } else if (targetKey === 'byKey') {
        setAnswerAlias(normalized.valueByKey, key, value)
        setAnswerAlias(normalized.textByKey, key, value)
      } else if (targetKey === 'byLabel') {
        setAnswerAlias(normalized.valueByLabel, key, value)
        setAnswerAlias(normalized.textByLabel, key, value)
      }
    })
  }

  for (const section of ['standard', 'custom', 'system', 'ignored', 'raw']) {
    const bag = source[section]
    if (!isPlainObject(bag)) continue
    Object.entries(bag).forEach(([key, value]) => {
      setAnswerAlias(normalized.byKey, key, value)
      setAnswerAlias(normalized.byKey, `${section}.${key}`, value)
      setAnswerAlias(normalized.valueByKey, key, value)
      setAnswerAlias(normalized.valueByKey, `${section}.${key}`, value)
      setAnswerAlias(normalized.textByKey, key, value)
      setAnswerAlias(normalized.textByKey, `${section}.${key}`, value)
    })
  }

  const knownEnvelopeKeys = new Set([
    'answers',
    'byId',
    'by_id',
    'byKey',
    'by_key',
    'byLabel',
    'by_label',
    'valueById',
    'value_by_id',
    'valueByKey',
    'value_by_key',
    'valueByLabel',
    'value_by_label',
    'textById',
    'text_by_id',
    'textByKey',
    'text_by_key',
    'textByLabel',
    'text_by_label',
    'summary',
    'text',
    'standard',
    'custom',
    'system',
    'ignored',
    'raw'
  ])
  Object.entries(source).forEach(([key, value]) => {
    if (knownEnvelopeKeys.has(key)) return
    setAnswerAlias(normalized.byKey, key, value)
    setAnswerAlias(normalized.valueByKey, key, value)
    setAnswerAlias(normalized.textByKey, key, value)
  })

  normalized.summary = cleanString(source.summary || source.text) || normalized.answers
    .filter(answer => answer.label || answer.key)
    .map(answer => `${answer.label || answer.key}: ${answerComparableValue(answer.text ?? answer.value)}`)
    .filter(line => cleanString(line.replace(/^[^:]+:\s*$/, '')))
    .join('\n')

  if (!normalized.summary && Object.keys(normalized.byKey).length) {
    normalized.summary = Object.entries(normalized.byKey)
      .map(([key, value]) => `${key}: ${answerComparableValue(value)}`)
      .join('\n')
  }

  return normalized
}

function formResponsesFromContext(ctx = {}) {
  return normalizeFormResponses(
    ctx.formResponses ||
    ctx.form_responses ||
    ctx.formAnswers ||
    ctx.form_answers ||
    ctx.responses ||
    {}
  )
}

function hasFormResponses(responses) {
  return Boolean(
    responses.summary ||
    responses.answers.length ||
    Object.keys(responses.byId).length ||
    Object.keys(responses.byKey).length ||
    Object.keys(responses.byLabel).length ||
    Object.keys(responses.valueById).length ||
    Object.keys(responses.valueByKey).length ||
    Object.keys(responses.valueByLabel).length ||
    Object.keys(responses.textById).length ||
    Object.keys(responses.textByKey).length ||
    Object.keys(responses.textByLabel).length
  )
}

function setFormResponseDetailVariables(map, prefix, valueBag = {}, textBag = {}, { valueKey = 'value', textKey = 'text' } = {}) {
  const values = valueBag || {}
  const texts = textBag || {}
  const keys = new Set([
    ...Object.keys(values),
    ...Object.keys(texts)
  ])
  keys.forEach((key) => {
    const cleanKey = cleanString(key)
    if (!cleanKey) return
    const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : texts[key]
    const text = Object.prototype.hasOwnProperty.call(texts, key) ? texts[key] : value
    map[`${prefix}.${cleanKey}.${valueKey}`] = answerComparableValue(value)
    map[`${prefix}.${cleanKey}.${textKey}`] = answerComparableValue(text)
  })
}

function formResponseValue(ctx = {}, key = '') {
  const responses = formResponsesFromContext(ctx)
  if (!cleanString(key)) return responses.summary
  const wanted = normalizeAnswerLookupKey(key)
  const bags = [responses.byKey, responses.byId, responses.byLabel]
  for (const bag of bags) {
    for (const [candidate, value] of Object.entries(bag)) {
      if (normalizeAnswerLookupKey(candidate) === wanted) return value
    }
  }
  const answer = responses.answers.find(item => (
    [item.id, item.key, item.label].some(candidate => normalizeAnswerLookupKey(candidate) === wanted)
  ))
  return answer ? answer.value : ''
}

function resolveDynamicToken(token, ctx) {
  if (!token) return undefined
  const webhookRoot = token.match(/^(webhook(?:_\d+)?)(.*)$/)
  if (webhookRoot && (webhookRoot[2] === '' || webhookRoot[2].startsWith('.') || webhookRoot[2].startsWith('['))) {
    const payload = ctx.payload ?? ctx.webhook ?? {}
    const rest = webhookRoot[2]
    const path = rest.startsWith('.') ? rest.slice(1) : rest
    return readPath(payload, path)
  }
  return readPath(ctx, token)
}

function triggerLinkCandidateValues(ctx = {}) {
  return [
    ctx.triggerLinkId,
    ctx.triggerLinkPublicId,
    ctx.triggerLinkName,
    ctx.publicId,
    ctx.link
  ]
}

function triggerLinkMatchesValue(configured, ctx = {}) {
  const wanted = normalizeText(configured)
  if (!wanted) return true
  return triggerLinkCandidateValues(ctx).map(normalizeText).includes(wanted)
}

function hasTriggerLinkEventContext(ctx = {}) {
  return triggerLinkCandidateValues(ctx).some((value) => Boolean(normalizeText(value)))
}

function triggerLinkDisplayName(ctx = {}) {
  return String(ctx.triggerLinkName || ctx.triggerLinkPublicId || ctx.triggerLinkId || ctx.publicId || ctx.link || '')
}

const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'successful'])
const SUCCESS_PAYMENT_STATUS_SQL = [...SUCCESS_PAYMENT_STATUSES].map((status) => `'${status}'`).join(', ')
const FAILED_PAYMENT_STATUSES = new Set(['failed', 'failure', 'error', 'declined', 'canceled', 'cancelled', 'void', 'voided', 'overdue'])
const REFUNDED_PAYMENT_STATUSES = new Set(['refunded', 'refund', 'partially_refunded'])
const PENDING_PAYMENT_STATUSES = new Set([
  'pending',
  'partial',
  'partially_paid',
  'incomplete',
  'requires_action',
  'requires_payment_method',
  'processing',
  'payment_processing',
  'draft',
  'sent'
])

function normalizePaymentEventAction(value) {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (SUCCESS_PAYMENT_STATUSES.has(normalized)) return 'successful'
  if (FAILED_PAYMENT_STATUSES.has(normalized)) return 'failed'
  if (REFUNDED_PAYMENT_STATUSES.has(normalized)) return 'refunded'
  if (PENDING_PAYMENT_STATUSES.has(normalized)) return 'pending'
  return normalized
}

function paymentActionFromContext(ctx = {}, eventType = '') {
  if (eventType === 'refund') return 'refunded'
  return normalizePaymentEventAction(
    ctx.paymentAction ||
    ctx.paymentStatus ||
    ctx.payment_status ||
    ctx.status ||
    ''
  )
}

const CONTACT_CHANGE_EVENT_TYPES = new Set([
  'contact-updated',
  'tag-changed',
  'payment-received',
  'refund',
  'appointment-booked',
  'appointment-status'
])

const CHANGE_SOURCE_BY_EVENT = {
  'contact-updated': 'webhook',
  'tag-changed': 'tag',
  'payment-received': 'payment',
  refund: 'payment',
  'appointment-booked': 'appointment',
  'appointment-status': 'appointment'
}

function changeFieldCandidates(value) {
  const raw = cleanString(value)
  if (!raw) return []
  const withoutPrefix = raw.replace(/^custom:/i, '')
  const snake = withoutPrefix.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return [...new Set([
    raw,
    withoutPrefix,
    snake,
    snake.replace(/_/g, ''),
    raw === 'preferred_whatsapp_phone_number_id' ? 'preferredWhatsAppPhoneNumberId' : '',
    raw === 'preferredWhatsAppPhoneNumberId' ? 'preferred_whatsapp_phone_number_id' : '',
    raw === 'assignedUser' ? 'assigned_user' : '',
    raw === 'totalPaid' ? 'total_paid' : '',
    raw === 'purchasesCount' ? 'purchases_count' : '',
    raw === 'paymentsCount' ? 'payments_count' : '',
    raw === 'appointmentsCount' ? 'appointments_count' : '',
    raw === 'activeAppointment' ? 'active_appointment' : '',
    raw === 'appointmentStatus' ? 'appointment_status' : '',
    raw === 'appointmentCalendar' ? 'appointment_calendar' : '',
    raw === 'appointmentAssignedUser' ? 'appointment_assigned_user' : '',
    raw === 'appointmentDate' ? 'appointment_date' : ''
  ].filter(Boolean).map(normalizeText))]
}

function changedFieldMatches(changedFields = [], expectedValue = '') {
  const expected = changeFieldCandidates(expectedValue)
  if (expected.length === 0) return false
  return (Array.isArray(changedFields) ? changedFields : [])
    .flatMap(changeFieldCandidates)
    .some((candidate) => expected.includes(candidate))
}

function contactChangeFieldsForEvent(eventType, ctx = {}) {
  const explicit = Array.isArray(ctx.changedFields) ? ctx.changedFields : []
  const fields = [...explicit]
  if (CONTACT_CHANGE_EVENT_TYPES.has(eventType)) fields.push('updatedAt')
  if (eventType === 'tag-changed') fields.push('tags')
  if (eventType === 'payment-received' || eventType === 'refund') {
    fields.push('payments', 'paymentsCount', 'totalPaid', 'purchasesCount', 'lastPurchaseDate')
  }
  if (eventType === 'appointment-booked') {
    fields.push('appointments', 'appointmentsCount', 'activeAppointmentsCount', 'activeAppointment', 'appointmentStatus', 'appointmentCalendar', 'appointmentDate')
  }
  if (eventType === 'appointment-status') {
    fields.push('appointments', 'activeAppointment', 'appointmentStatus')
  }
  return [...new Set(fields.map(cleanString).filter(Boolean))]
}

function withContactChangeContext(eventType, ctx = {}) {
  if (!CONTACT_CHANGE_EVENT_TYPES.has(eventType)) return ctx
  return {
    ...ctx,
    changedFields: contactChangeFieldsForEvent(eventType, ctx),
    contactChangeEventType: eventType,
    contactChangeSource: ctx.contactChangeSource || ctx.changeSource || CHANGE_SOURCE_BY_EVENT[eventType] || 'webhook'
  }
}

function paymentActionMatches(configAction, ctx = {}, eventType = '') {
  const wanted = normalizeText(configAction) || 'any'
  if (wanted === 'any') return true
  const actual = paymentActionFromContext(ctx, eventType) || 'successful'
  return actual === wanted
}

function firstCleanPaymentValue(...values) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return ''
}

function paymentObjectFromContext(ctx = {}) {
  return ctx.payment && typeof ctx.payment === 'object' && !Array.isArray(ctx.payment)
    ? ctx.payment
    : {}
}

function paymentMetadataFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  return {
    ...parseJson(payment.metadata_json, {}),
    ...parseJson(payment.metadataJson, {}),
    ...parseJson(payment.metadata, {}),
    ...parseJson(ctx.metadata_json, {}),
    ...parseJson(ctx.metadataJson, {}),
    ...parseJson(ctx.metadata, {})
  }
}

function firstPaymentContextValue(ctx = {}, ...paths) {
  const payment = paymentObjectFromContext(ctx)
  const metadata = paymentMetadataFromContext(ctx)
  const sources = [ctx, payment, metadata]

  for (const path of paths) {
    for (const source of sources) {
      const cleaned = cleanString(readPath(source, path))
      if (cleaned) return cleaned
    }
  }

  return ''
}

function pushCleanPaymentCandidate(candidates, ...values) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) candidates.push(cleaned)
  }
}

function paymentLineItemsFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  const metadata = paymentMetadataFromContext(ctx)
  const sources = [
    ctx.lineItems,
    ctx.line_items,
    payment.lineItems,
    payment.line_items,
    payment.items,
    metadata.lineItems,
    metadata.line_items,
    metadata.items,
    metadata.invoicePayload?.items
  ]
  return sources.find((source) => Array.isArray(source) && source.length > 0) ||
    sources.find((source) => Array.isArray(source)) ||
    []
}

function uniquePaymentCandidates(candidates = []) {
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = normalizeText(candidate)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function paymentProductCandidatesFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  const candidates = []
  pushCleanPaymentCandidate(
    candidates,
    ctx.product,
    ctx.productName,
    ctx.product_name,
    payment.product,
    payment.productName,
    payment.product_name,
    ctx.title,
    payment.title,
    ctx.description,
    payment.description,
    ctx.productId,
    ctx.product_id,
    payment.productId,
    payment.product_id,
    ctx.localProductId,
    ctx.local_product_id,
    payment.localProductId,
    payment.local_product_id,
    ctx.ghlProductId,
    ctx.ghl_product_id,
    payment.ghlProductId,
    payment.ghl_product_id
  )

  for (const item of paymentLineItemsFromContext(ctx)) {
    if (!item || typeof item !== 'object') continue
    pushCleanPaymentCandidate(
      candidates,
      item.name,
      item.title,
      item.description,
      item.productName,
      item.product_name,
      item.productId,
      item.product_id,
      item.product,
      item.localProductId,
      item.local_product_id,
      item.ghlProductId,
      item.ghl_product_id,
      item.sku
    )
  }

  return uniquePaymentCandidates(candidates)
}

function paymentProductFieldCandidatesFromContext(ctx = {}, field = '') {
  const payment = paymentObjectFromContext(ctx)
  const metadata = paymentMetadataFromContext(ctx)
  const candidates = []

  switch (field) {
    case 'product_name':
      pushCleanPaymentCandidate(
        candidates,
        ctx.productName,
        ctx.product_name,
        ctx.product,
        payment.productName,
        payment.product_name,
        payment.product,
        metadata.productName,
        metadata.product_name,
        metadata.product,
        ctx.title,
        payment.title,
        ctx.description,
        payment.description
      )
      break
    case 'product_id':
      pushCleanPaymentCandidate(
        candidates,
        ctx.productId,
        ctx.product_id,
        payment.productId,
        payment.product_id,
        metadata.productId,
        metadata.product_id
      )
      break
    case 'local_product_id':
      pushCleanPaymentCandidate(candidates, ctx.localProductId, ctx.local_product_id, payment.localProductId, payment.local_product_id, metadata.localProductId, metadata.local_product_id)
      break
    case 'ghl_product_id':
      pushCleanPaymentCandidate(candidates, ctx.ghlProductId, ctx.ghl_product_id, payment.ghlProductId, payment.ghl_product_id, metadata.ghlProductId, metadata.ghl_product_id)
      break
    case 'product_sku':
      pushCleanPaymentCandidate(candidates, ctx.sku, payment.sku, metadata.sku)
      break
    case 'price_name':
      pushCleanPaymentCandidate(candidates, ctx.priceName, ctx.price_name, payment.priceName, payment.price_name, metadata.priceName, metadata.price_name)
      break
    case 'price_id':
      pushCleanPaymentCandidate(candidates, ctx.priceId, ctx.price_id, payment.priceId, payment.price_id, metadata.priceId, metadata.price_id)
      break
    case 'local_price_id':
      pushCleanPaymentCandidate(candidates, ctx.localPriceId, ctx.local_price_id, payment.localPriceId, payment.local_price_id, metadata.localPriceId, metadata.local_price_id)
      break
    case 'ghl_price_id':
      pushCleanPaymentCandidate(candidates, ctx.ghlPriceId, ctx.ghl_price_id, payment.ghlPriceId, payment.ghl_price_id, metadata.ghlPriceId, metadata.ghl_price_id)
      break
    default:
      return paymentProductCandidatesFromContext(ctx)
  }

  for (const item of paymentLineItemsFromContext(ctx)) {
    if (!item || typeof item !== 'object') continue
    switch (field) {
      case 'product_name':
        pushCleanPaymentCandidate(candidates, item.name, item.title, item.description, item.productName, item.product_name, item.product)
        break
      case 'product_id':
        pushCleanPaymentCandidate(candidates, item.productId, item.product_id, item.product)
        break
      case 'local_product_id':
        pushCleanPaymentCandidate(candidates, item.localProductId, item.local_product_id)
        break
      case 'ghl_product_id':
        pushCleanPaymentCandidate(candidates, item.ghlProductId, item.ghl_product_id)
        break
      case 'product_sku':
        pushCleanPaymentCandidate(candidates, item.sku)
        break
      case 'price_name':
        pushCleanPaymentCandidate(candidates, item.priceName, item.price_name, item.variantName, item.variant_name)
        break
      case 'price_id':
        pushCleanPaymentCandidate(candidates, item.priceId, item.price_id, item.price)
        break
      case 'local_price_id':
        pushCleanPaymentCandidate(candidates, item.localPriceId, item.local_price_id)
        break
      case 'ghl_price_id':
        pushCleanPaymentCandidate(candidates, item.ghlPriceId, item.ghl_price_id)
        break
      default:
        break
    }
  }

  return uniquePaymentCandidates(candidates)
}

function publicPaymentIdFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  return firstCleanPaymentValue(
    ctx.publicPaymentId,
    ctx.public_payment_id,
    ctx.paymentPublicId,
    ctx.payment_public_id,
    payment.publicPaymentId,
    payment.public_payment_id,
    payment.publicId,
    payment.public_id
  )
}

function buildPaymentPageUrlFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  const explicitUrl = firstCleanPaymentValue(
    ctx.paymentUrl,
    ctx.payment_url,
    ctx.checkoutUrl,
    ctx.checkout_url,
    ctx.paymentLink,
    ctx.payment_link,
    payment.paymentUrl,
    payment.payment_url,
    payment.checkoutUrl,
    payment.checkout_url,
    payment.paymentLink,
    payment.payment_link
  )
  if (explicitUrl) return explicitUrl

  const publicPaymentId = publicPaymentIdFromContext(ctx)
  const baseUrl = firstCleanPaymentValue(
    ctx.publicBaseUrl,
    ctx.public_base_url,
    process.env.PUBLIC_URL,
    process.env.RENDER_EXTERNAL_URL
  ).replace(/\/+$/, '')
  return publicPaymentId && /^https?:\/\//i.test(baseUrl)
    ? `${baseUrl}/pay/${encodeURIComponent(publicPaymentId)}`
    : ''
}

function appendPaymentReceiptQuery(paymentUrl = '') {
  const url = cleanString(paymentUrl)
  if (!url) return ''
  return url.includes('?') ? `${url}&receipt=1` : `${url}?receipt=1`
}

function paymentDataFromContext(ctx = {}) {
  const payment = paymentObjectFromContext(ctx)
  const publicPaymentId = publicPaymentIdFromContext(ctx)
  const paymentUrl = buildPaymentPageUrlFromContext(ctx)
  const productCandidates = paymentProductCandidatesFromContext(ctx)
  const paymentId = firstPaymentContextValue(ctx, 'paymentId', 'payment_id', 'id')
  const amount = firstPaymentContextValue(ctx, 'amount')
  const currency = firstPaymentContextValue(ctx, 'currency')
  const status = firstPaymentContextValue(ctx, 'paymentStatus', 'payment_status', 'status')
  const paymentMode = firstPaymentContextValue(ctx, 'paymentMode', 'payment_mode', 'mode')
  const eventId = firstPaymentContextValue(
    ctx,
    'eventId',
    'event_id',
    'webhookEventId',
    'webhook_event_id',
    'sourceEventId',
    'source_event_id',
    'stripeEventId',
    'stripe_event_id',
    'mercadoPagoEventId',
    'mercadopagoEventId',
    'mercadopago_event_id',
    'conektaEventId',
    'conekta_event_id',
    'clipEventId',
    'clip_event_id',
    'rebillEventId',
    'rebill_event_id',
    'payload.id',
    'payload.eventId',
    'payload.event_id',
    'event.id',
    'webhook.id'
  )
  const provider = firstPaymentContextValue(ctx, 'provider', 'paymentProvider', 'payment_provider', 'gateway', 'processor')
  const paymentMethod = firstPaymentContextValue(ctx, 'paymentMethod', 'payment_method', 'method')
  const invoiceId = firstPaymentContextValue(ctx, 'invoiceId', 'invoice_id', 'ghl_invoice_id')
  const invoiceNumber = firstPaymentContextValue(ctx, 'invoiceNumber', 'invoice_number')
  const reference = firstPaymentContextValue(ctx, 'reference')
  const title = firstPaymentContextValue(ctx, 'title', 'name')
  const description = firstPaymentContextValue(ctx, 'description')
  const stripePaymentIntentId = firstPaymentContextValue(
    ctx,
    'stripePaymentIntentId',
    'stripe_payment_intent_id',
    'paymentIntentId',
    'payment_intent_id',
    'stripe.paymentIntentId',
    'stripe.payment_intent_id',
    'stripe.paymentIntent.id',
    'stripe.payment_intent.id'
  )
  const stripeChargeId = firstPaymentContextValue(
    ctx,
    'stripeChargeId',
    'stripe_charge_id',
    'chargeId',
    'charge_id',
    'stripe.chargeId',
    'stripe.charge_id',
    'stripe.charge.id'
  )
  const mercadoPagoPaymentId = firstPaymentContextValue(
    ctx,
    'mercadoPagoPaymentId',
    'mercadopagoPaymentId',
    'mercadopago_payment_id',
    'mercadoPago.paymentId',
    'mercadoPago.payment_id',
    'mercado_pago.paymentId',
    'mercado_pago.payment_id'
  )
  const mercadoPagoPreferenceId = firstPaymentContextValue(
    ctx,
    'mercadoPagoPreferenceId',
    'mercadopagoPreferenceId',
    'mercadopago_preference_id',
    'preferenceId',
    'preference_id',
    'mercadoPago.preferenceId',
    'mercadoPago.preference_id',
    'mercado_pago.preferenceId',
    'mercado_pago.preference_id'
  )
  const conektaOrderId = firstPaymentContextValue(ctx, 'conektaOrderId', 'conekta_order_id', 'orderId', 'order_id', 'conekta.orderId', 'conekta.order_id')
  const conektaChargeId = firstPaymentContextValue(ctx, 'conektaChargeId', 'conekta_charge_id', 'chargeId', 'charge_id', 'conekta.chargeId', 'conekta.charge_id')
  const conektaPaymentSourceId = firstPaymentContextValue(
    ctx,
    'conektaPaymentSourceId',
    'conekta_payment_source_id',
    'paymentSourceId',
    'payment_source_id',
    'sourceId',
    'source_id',
    'conekta.paymentSourceId',
    'conekta.payment_source_id'
  )
  const clipPaymentId = firstPaymentContextValue(ctx, 'clipPaymentId', 'clip_payment_id', 'clip.paymentId', 'clip.payment_id', 'clip.id')
  const clipReceiptNo = firstPaymentContextValue(ctx, 'clipReceiptNo', 'clip_receipt_no', 'receiptNo', 'receipt_no', 'clip.receiptNo', 'clip.receipt_no')
  const rebillPaymentId = firstPaymentContextValue(ctx, 'rebillPaymentId', 'rebill_payment_id', 'rebill.paymentId', 'rebill.payment_id', 'rebill.id')
  const rebillSubscriptionId = firstPaymentContextValue(ctx, 'rebillSubscriptionId', 'rebill_subscription_id', 'rebill.subscriptionId', 'rebill.subscription_id')
  const rebillCustomerId = firstPaymentContextValue(ctx, 'rebillCustomerId', 'rebill_customer_id', 'rebill.customerId', 'rebill.customer_id')
  const rebillCardId = firstPaymentContextValue(ctx, 'rebillCardId', 'rebill_card_id', 'rebill.cardId', 'rebill.card_id')
  const paidAt = firstPaymentContextValue(ctx, 'paidAt', 'paid_at', 'fulfilledAt', 'fulfilled_at')
  const paymentDate = firstPaymentContextValue(ctx, 'paymentDate', 'payment_date', 'date', 'createdAt', 'created_at')
  const dueDate = firstPaymentContextValue(ctx, 'dueDate', 'due_date')
  const sentAt = firstPaymentContextValue(ctx, 'sentAt', 'sent_at')
  const createdAt = firstPaymentContextValue(ctx, 'createdAt', 'created_at')
  const updatedAt = firstPaymentContextValue(ctx, 'updatedAt', 'updated_at')
  const receiptUrl = firstCleanPaymentValue(
    ctx.receiptUrl,
    ctx.receipt_url,
    ctx.receiptDownloadUrl,
    ctx.receipt_download_url,
    ctx.paymentReceiptUrl,
    ctx.payment_receipt_url,
    payment.receiptUrl,
    payment.receipt_url,
    payment.receiptDownloadUrl,
    payment.receipt_download_url,
    appendPaymentReceiptQuery(paymentUrl)
  )
  return {
    id_pago: paymentId,
    id_publico: publicPaymentId,
    monto: amount,
    moneda: currency,
    estado: status,
    modo_pago: paymentMode,
    id_evento: eventId,
    producto: firstCleanPaymentValue(ctx.product, paymentProductCandidatesFromContext(ctx)[0], productCandidates[0], title, description),
    proveedor: provider,
    metodo_pago: paymentMethod,
    referencia: reference,
    titulo: title,
    descripcion: description,
    recibo: firstPaymentContextValue(ctx, 'receipt') || reference || invoiceNumber || invoiceId || title || '',
    id_factura: invoiceId,
    numero_factura: invoiceNumber,
    id_stripe_payment_intent: stripePaymentIntentId,
    id_stripe_charge: stripeChargeId,
    id_mercadopago_pago: mercadoPagoPaymentId,
    id_mercadopago_preferencia: mercadoPagoPreferenceId,
    id_conekta_order: conektaOrderId,
    id_conekta_charge: conektaChargeId,
    id_conekta_fuente_pago: conektaPaymentSourceId,
    id_clip_pago: clipPaymentId,
    id_clip_recibo: clipReceiptNo,
    id_rebill_pago: rebillPaymentId,
    id_rebill_suscripcion: rebillSubscriptionId,
    id_rebill_cliente: rebillCustomerId,
    id_rebill_tarjeta: rebillCardId,
    fecha: paymentDate,
    fecha_pago: paidAt,
    fecha_vencimiento: dueDate,
    fecha_envio: sentAt,
    fecha_creacion: createdAt,
    fecha_actualizacion: updatedAt,
    url_pago: paymentUrl,
    url_comprobante: receiptUrl,
    ruta_comprobante: publicPaymentId ? `${publicPaymentId}?receipt=1` : ''
  }
}

function replyDataFromContext(ctx = {}) {
  return {
    cuerpo: ctx.messageText || ctx.body || ctx.text || '',
    numero_contacto: ctx.contact?.phone || ctx.phone || ctx.from || '',
    nombre_contacto: ctx.contact?.fullName || ctx.contact?.firstName || ctx.name || '',
    fecha_mensaje: ctx.messageAt || ctx.receivedAt || ctx.timestamp || ctx.createdAt || '',
    id_mensaje: ctx.messageId || ctx.message_id || ctx.id || '',
    canal: ctx.channel || '',
    archivo_adjunto: ctx.attachment || ctx.media || null
  }
}

// Datos del comentario FB/IG para exponerlos como variable {{comentario.*}} en
// las acciones. Las claves coinciden con COMMENT_FIELDS del nodeRegistry.
function commentDataFromContext(ctx = {}) {
  return {
    texto: ctx.messageText || '',
    autor: ctx.contact?.fullName || ctx.contact?.firstName || ctx.contactName || '',
    id_comentario: ctx.commentId || '',
    id_publicacion: ctx.postId || ctx.mediaId || '',
    permalink: ctx.permalink || '',
    plataforma: ctx.platform || ''
  }
}

function formDisqualifiedFromContext(ctx = {}) {
  const explicit = ctx.formDisqualified ?? ctx.form_disqualified ?? ctx.disqualified ?? ctx.importedDisqualified ?? ctx.imported_disqualified
  if (typeof explicit === 'boolean') return explicit
  if (typeof explicit === 'number') return explicit === 1
  if (typeof explicit === 'string') {
    const normalized = normalizeText(explicit)
    if (['true', '1', 'yes', 'si', 'sí', 'descalificado', 'disqualified'].includes(normalized)) return true
    if (['false', '0', 'no', 'recibido', 'received', 'qualified', 'calificado'].includes(normalized)) return false
  }

  const status = normalizeText(
    ctx.formStatus ||
    ctx.form_status ||
    ctx.submissionStatus ||
    ctx.submission_status ||
    ctx.status
  )
  if (['disqualified', 'descalificado'].includes(status)) return true
  return false
}

function formDataFromContext(ctx = {}) {
  const status = ctx.formStatus || ctx.form_status || ctx.submissionStatus || ctx.submission_status || ctx.status || ''
  const responses = formResponsesFromContext(ctx)
  return {
    id_formulario: primaryFormIdFromContext(ctx),
    nombre_formulario: primaryFormNameFromContext(ctx),
    nombre: ctx.contact?.fullName || ctx.contactName || '',
    telefono: ctx.contact?.phone || ctx.phone || '',
    email: ctx.contact?.email || ctx.email || '',
    estado: status,
    descalificado: formDisqualifiedFromContext(ctx),
    id_envio: ctx.submissionId || ctx.submission_id || '',
    fecha_de_envio: ctx.submittedAt || ctx.submitted_at || ctx.createdAt || ctx.created_at || '',
    respuestas: responses.byKey,
    respuestas_valor: responses.valueByKey,
    respuestas_texto: responses.textByKey,
    respuestas_por_id: responses.byId,
    respuestas_por_id_valor: responses.valueById,
    respuestas_por_id_texto: responses.textById,
    respuestas_por_etiqueta: responses.byLabel,
    respuestas_por_etiqueta_valor: responses.valueByLabel,
    respuestas_por_etiqueta_texto: responses.textByLabel,
    resumen_respuestas: responses.summary
  }
}

function automationImportedFormId(siteId, importedFormId) {
  const site = str(siteId)
  const form = str(importedFormId)
  return site && form ? `${site}:imported:${form}` : ''
}

function primaryFormIdFromContext(ctx = {}) {
  return (
    ctx.automationFormId ||
    ctx.automation_form_id ||
    ctx.formSiteId ||
    ctx.form_site_id ||
    ctx.formId ||
    ctx.form_id ||
    ctx.importedFormId ||
    ctx.imported_form_id ||
    ctx.siteId ||
    ctx.site_id ||
    ''
  )
}

function primaryFormNameFromContext(ctx = {}) {
  return (
    ctx.formName ||
    ctx.form_name ||
    ctx.formSiteName ||
    ctx.form_site_name ||
    ctx.importedFormName ||
    ctx.imported_form_name ||
    ctx.importedFormTitle ||
    ctx.imported_form_title ||
    ctx.siteName ||
    ctx.site_name ||
    ''
  )
}

function formIdsFromContext(ctx = {}) {
  const ids = new Set()
  const add = (value) => {
    const clean = str(value)
    if (clean) ids.add(clean)
  }

  add(ctx.automationFormId)
  add(ctx.automation_form_id)
  add(ctx.formId)
  add(ctx.form_id)
  add(ctx.formSiteId)
  add(ctx.form_site_id)
  add(ctx.siteId)
  add(ctx.site_id)
  add(ctx.importedFormId)
  add(ctx.imported_form_id)

  const siteId = str(ctx.siteId || ctx.site_id || ctx.formId || ctx.form_id)
  const importedFormId = str(ctx.importedFormId || ctx.imported_form_id)
  add(automationImportedFormId(siteId, importedFormId))

  return ids
}

function formSubmittedMatches(selectedForm, ctx = {}) {
  const selected = str(selectedForm)
  if (!selected) return true
  return formIdsFromContext(ctx).has(selected)
}

function appointmentDataFromContext(ctx = {}) {
  return {
    id_cita: ctx.appointmentId || ctx.appointment_id || ctx.eventId || ctx.event_id || ctx.id || '',
    nombre_contacto: ctx.contact?.fullName || ctx.contactName || '',
    fecha: ctx.appointmentDate || ctx.date || ctx.startDate || ctx.start_at || ctx.startAt || '',
    hora: ctx.appointmentTime || ctx.time || '',
    servicio: ctx.appointmentType || ctx.service || ctx.title || '',
    estado: ctx.appointmentStatus || ctx.status || '',
    calendario: ctx.calendarName || ctx.calendarId || ctx.calendar_id || '',
    notas: ctx.notes || ctx.note || ctx.description || ''
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Flujo: lectura de nodos, disparadores y aristas
// ---------------------------------------------------------------------------

function getStartNode(flow) {
  return (flow.nodes || []).find((node) => node.type === 'start') || null
}

function getTriggers(startNode) {
  const triggers = startNode?.config?.triggers
  return Array.isArray(triggers) ? triggers : []
}

function getNode(flow, nodeId) {
  return (flow.nodes || []).find((node) => node.id === nodeId) || null
}

function edgesFrom(flow, nodeId, handle) {
  return (flow.edges || []).filter(
    (edge) => edge.sourceNodeId === nodeId && (handle === undefined || edge.sourceHandle === handle)
  )
}

function nodeLabel(node) {
  const custom = str(node?.config?.customTitle).trim()
  return custom || node?.label || node?.type || 'Paso'
}

// ---------------------------------------------------------------------------
// Variables {{contact.x}} → datos reales del contacto / conversación
// ---------------------------------------------------------------------------

function buildVariableMap(ctx) {
  const contact = ctx.contact || {}
  const custom = contact.customFields || {}
  const map = {
    first_name: contact.firstName || (contact.fullName || '').split(' ')[0] || '',
    last_name: contact.lastName || '',
    full_name: contact.fullName || '',
    name: contact.fullName || contact.firstName || '',
    phone: contact.phone || '',
    email: contact.email || '',
    'contact.first_name': contact.firstName || (contact.fullName || '').split(' ')[0] || '',
    'contact.last_name': contact.lastName || '',
    'contact.full_name': contact.fullName || '',
    'contact.name': contact.fullName || contact.firstName || '',
    'contact.phone': contact.phone || '',
    'contact.email': contact.email || '',
    'conversation.last_message': ctx.messageText || '',
    'message.text': ctx.messageText || '',
    'enlace_disparo.id_enlace': ctx.triggerLinkPublicId || ctx.triggerLinkId || '',
    'enlace_disparo.nombre_enlace': ctx.triggerLinkName || '',
    'enlace_disparo.url_publica': ctx.triggerLinkUrl || '',
    'enlace_disparo.destino_final': ctx.destinationUrl || '',
    'enlace_disparo.fecha_disparo': ctx.clickedAt || '',
    'automation.name': ctx.automationName || ''
  }
  const reply = replyDataFromContext(ctx)
  if (reply.cuerpo || reply.numero_contacto || reply.id_mensaje || reply.canal) {
    setDeepVariable(map, 'respuesta_whatsapp', reply)
    setDeepVariable(map, 'respuesta_whatsapp_1', reply)
  }
  const comment = commentDataFromContext(ctx)
  if (comment.texto || comment.id_comentario) {
    setDeepVariable(map, 'comentario', comment)
    setDeepVariable(map, 'comentario_1', comment)
  }
  const payment = paymentDataFromContext(ctx)
  if (Object.values(payment).some((value) => value !== '')) {
    setDeepVariable(map, 'pago', payment)
    setDeepVariable(map, 'pago_1', payment)
    map['payment.id'] = String(payment.id_pago ?? '')
    map['payment.public_id'] = String(payment.id_publico ?? '')
    map['payment.amount'] = String(payment.monto ?? '')
    map['payment.currency'] = String(payment.moneda ?? '')
    map['payment.status'] = String(payment.estado ?? '')
    map['payment.mode'] = String(payment.modo_pago ?? '')
    map['payment.payment_mode'] = String(payment.modo_pago ?? '')
    map['payment.event_id'] = String(payment.id_evento ?? '')
    map['payment.product'] = String(payment.producto ?? '')
    map['payment.provider'] = String(payment.proveedor ?? '')
    map['payment.method'] = String(payment.metodo_pago ?? '')
    map['payment.reference'] = String(payment.referencia ?? '')
    map['payment.title'] = String(payment.titulo ?? '')
    map['payment.description'] = String(payment.descripcion ?? '')
    map['payment.receipt'] = String(payment.recibo ?? '')
    map['payment.invoice_id'] = String(payment.id_factura ?? '')
    map['payment.invoice_number'] = String(payment.numero_factura ?? '')
    map['payment.stripe_payment_intent_id'] = String(payment.id_stripe_payment_intent ?? '')
    map['payment.stripe_charge_id'] = String(payment.id_stripe_charge ?? '')
    map['payment.mercadopago_payment_id'] = String(payment.id_mercadopago_pago ?? '')
    map['payment.mercadopago_preference_id'] = String(payment.id_mercadopago_preferencia ?? '')
    map['payment.conekta_order_id'] = String(payment.id_conekta_order ?? '')
    map['payment.conekta_charge_id'] = String(payment.id_conekta_charge ?? '')
    map['payment.conekta_payment_source_id'] = String(payment.id_conekta_fuente_pago ?? '')
    map['payment.clip_payment_id'] = String(payment.id_clip_pago ?? '')
    map['payment.clip_receipt_no'] = String(payment.id_clip_recibo ?? '')
    map['payment.rebill_payment_id'] = String(payment.id_rebill_pago ?? '')
    map['payment.rebill_subscription_id'] = String(payment.id_rebill_suscripcion ?? '')
    map['payment.rebill_customer_id'] = String(payment.id_rebill_cliente ?? '')
    map['payment.rebill_card_id'] = String(payment.id_rebill_tarjeta ?? '')
    map['payment.date'] = String(payment.fecha ?? '')
    map['payment.paid_at'] = String(payment.fecha_pago ?? '')
    map['payment.due_date'] = String(payment.fecha_vencimiento ?? '')
    map['payment.sent_at'] = String(payment.fecha_envio ?? '')
    map['payment.created_at'] = String(payment.fecha_creacion ?? '')
    map['payment.updated_at'] = String(payment.fecha_actualizacion ?? '')
    map['payment.url'] = String(payment.url_pago ?? '')
    map['payment.receipt_url'] = String(payment.url_comprobante ?? '')
    map['payment.receipt_path'] = String(payment.ruta_comprobante ?? '')
  }
  const form = formDataFromContext(ctx)
  const formResponses = formResponsesFromContext(ctx)
  const hasFormData = Boolean(
    form.id_formulario ||
    form.nombre_formulario ||
    form.estado ||
    form.id_envio ||
    form.fecha_de_envio ||
    hasFormResponses(formResponses)
  )
  if (hasFormData) {
    setDeepVariable(map, 'formulario', form)
    setDeepVariable(map, 'formulario_1', form)
    map['form.id'] = String(form.id_formulario ?? '')
    map['form.name'] = String(form.nombre_formulario ?? '')
    map['form.status'] = String(form.estado ?? '')
    map['form.disqualified'] = boolText(Boolean(form.descalificado))
    map['form.submission_id'] = String(form.id_envio ?? '')
    map['form.submitted_at'] = String(form.fecha_de_envio ?? '')
    map['form.answers'] = formResponses.summary
    map['form.answers_text'] = formResponses.summary
    if (hasFormResponses(formResponses)) {
      map['formulario.respuestas'] = JSON.stringify(formResponses.byKey)
      map['formulario_1.respuestas'] = JSON.stringify(formResponses.byKey)
      map['formulario.respuestas_por_id'] = JSON.stringify(formResponses.byId)
      map['formulario.respuestas_por_etiqueta'] = JSON.stringify(formResponses.byLabel)
      map['formulario.resumen_respuestas'] = formResponses.summary
      setDeepVariable(map, 'form.responses', formResponses.byKey)
      setDeepVariable(map, 'form.answers_by_id', formResponses.byId)
      setDeepVariable(map, 'form.response_values', formResponses.valueByKey)
      setDeepVariable(map, 'form.response_text', formResponses.textByKey)
      setDeepVariable(map, 'form.answer_values_by_id', formResponses.valueById)
      setDeepVariable(map, 'form.answer_text_by_id', formResponses.textById)
      setFormResponseDetailVariables(map, 'form.responses', formResponses.valueByKey, formResponses.textByKey)
      setFormResponseDetailVariables(map, 'form.answers_by_id', formResponses.valueById, formResponses.textById)
      setFormResponseDetailVariables(map, 'formulario.respuestas', formResponses.valueByKey, formResponses.textByKey)
      setFormResponseDetailVariables(map, 'formulario_1.respuestas', formResponses.valueByKey, formResponses.textByKey)
      setFormResponseDetailVariables(map, 'formulario.respuestas_por_id', formResponses.valueById, formResponses.textById)
      setFormResponseDetailVariables(map, 'formulario_1.respuestas_por_id', formResponses.valueById, formResponses.textById)
      setFormResponseDetailVariables(map, 'formulario.respuestas', formResponses.valueByKey, formResponses.textByKey, { valueKey: 'valor', textKey: 'texto' })
      setFormResponseDetailVariables(map, 'formulario_1.respuestas', formResponses.valueByKey, formResponses.textByKey, { valueKey: 'valor', textKey: 'texto' })
      setFormResponseDetailVariables(map, 'formulario.respuestas_por_id', formResponses.valueById, formResponses.textById, { valueKey: 'valor', textKey: 'texto' })
      setFormResponseDetailVariables(map, 'formulario_1.respuestas_por_id', formResponses.valueById, formResponses.textById, { valueKey: 'valor', textKey: 'texto' })
    }
  }
  const appointment = appointmentDataFromContext(ctx)
  if (Object.values(appointment).some((value) => value !== '')) {
    setDeepVariable(map, 'cita', appointment)
    setDeepVariable(map, 'cita_1', appointment)
    map['appointment.id'] = String(appointment.id_cita ?? '')
    map['appointment.date'] = String(appointment.fecha ?? '')
    map['appointment.time'] = String(appointment.hora ?? '')
    map['appointment.status'] = String(appointment.estado ?? '')
    map['appointment.calendar'] = String(appointment.calendario ?? '')
    map['appointment.type'] = String(appointment.servicio ?? '')
  }
  if (ctx.scheduledFor || ctx.scheduleRunKey) {
    const schedule = {
      fecha_programada: ctx.scheduledFor || '',
      zona_horaria: ctx.scheduleTimezone || '',
      recurrencia: ctx.scheduleRecurrence || ''
    }
    setDeepVariable(map, 'programacion', schedule)
    map['schedule.scheduled_for'] = String(schedule.fecha_programada)
    map['schedule.timezone'] = String(schedule.zona_horaria)
    map['schedule.recurrence'] = String(schedule.recurrencia)
  }
  Object.entries(custom).forEach(([key, value]) => {
    map[`contact.custom.${key}`] = String(value ?? '')
    map[`custom.${key}`] = String(value ?? '')
    if (map[key] === undefined) map[key] = String(value ?? '')
  })
  if (ctx.payload && typeof ctx.payload === 'object') {
    setDeepVariable(map, 'webhook', ctx.payload)
    setDeepVariable(map, 'webhook_1', ctx.payload)
  }
  return map
}

export function renderTemplate(text, ctx, { preserveUnknown = false } = {}) {
  const map = buildVariableMap(ctx)
  return String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawToken) => {
    const token = cleanString(rawToken)
    if (map[token] !== undefined) return map[token]
    const dynamic = resolveDynamicToken(token, ctx)
    if (dynamic !== undefined) return typeof dynamic === 'object' ? JSON.stringify(dynamic) : String(dynamic ?? '')
    return preserveUnknown ? match : ''
  })
}

// AUTO-010: detectar tokens {{...}} que NO resuelven con el contexto dado.
// Antes, una variable mal escrita (p. ej. {{nombre_contacto}} en vez de
// {{first_name}}) se renderizaba como cadena vacía sin aviso y el cliente
// recibía "Hola ,". Este helper permite a la validación de publicación avisar
// del token desconocido en vez de enviarlo silenciosamente vacío. Reutiliza la
// misma resolución que renderTemplate (mapa estático + token dinámico) para que
// no haya falsos positivos. No altera el comportamiento de renderTemplate.
export function findUnknownTemplateTokens(text, ctx) {
  const map = buildVariableMap(ctx)
  const unknown = new Set()
  String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawToken) => {
    const token = cleanString(rawToken)
    if (map[token] !== undefined) return match
    const dynamic = resolveDynamicToken(token, ctx)
    if (dynamic !== undefined) return match
    if (token) unknown.add(token)
    return match
  })
  return [...unknown]
}

// ---------------------------------------------------------------------------
// Coincidencia de disparadores y filtros
// ---------------------------------------------------------------------------

// Empata la "Publicación" configurada (URL o ID) contra el post/permalink del
// comentario. El usuario pega una URL o un ID; el webhook trae post_id/media_id
// (y a veces permalink), así que aceptamos coincidencia exacta o que uno contenga
// al otro (URL contiene el ID). Umbral de 6 chars para no empatar por basura.
function postMatches(post, ctx) {
  const wanted = normalizeText(str(post))
  if (!wanted) return true
  const candidates = [ctx.postId, ctx.mediaId, ctx.permalink, ctx.parentCommentId]
    .map((v) => normalizeText(str(v)))
    .filter(Boolean)
  return candidates.some((c) => (
    c === wanted ||
    (wanted.length >= 6 && c.includes(wanted)) ||
    (c.length >= 6 && wanted.includes(c))
  ))
}

function keywordsMatch(config, messageText) {
  const keywords = Array.isArray(config.keywords) ? config.keywords.filter(Boolean) : []
  if (keywords.length === 0) return true
  const text = normalizeText(messageText)
  const mode = str(config.match) || 'contains'
  return keywords.some((keyword) => {
    const needle = normalizeText(keyword)
    if (!needle) return false
    if (mode === 'exact') return text === needle
    if (mode === 'starts_with') return text.startsWith(needle)
    return text.includes(needle)
  })
}

function paymentTriggerFieldValue(field, ctx = {}) {
  switch (field) {
    case 'payment_status':
      return firstPaymentContextValue(ctx, 'paymentStatus', 'payment_status', 'status')
    case 'amount':
      return firstPaymentContextValue(ctx, 'amount')
    case 'currency':
      return firstPaymentContextValue(ctx, 'currency')
    case 'provider':
      return firstPaymentContextValue(ctx, 'provider', 'paymentProvider', 'payment_provider', 'gateway', 'processor')
    case 'payment_mode':
      return firstPaymentContextValue(ctx, 'paymentMode', 'payment_mode', 'mode')
    case 'payment_method':
      return firstPaymentContextValue(ctx, 'paymentMethod', 'payment_method', 'method')
    case 'payment_id':
      return firstPaymentContextValue(ctx, 'paymentId', 'payment_id', 'id')
    case 'event_id':
      return firstPaymentContextValue(
        ctx,
        'eventId',
        'event_id',
        'webhookEventId',
        'webhook_event_id',
        'sourceEventId',
        'source_event_id',
        'stripeEventId',
        'stripe_event_id',
        'mercadoPagoEventId',
        'mercadopagoEventId',
        'mercadopago_event_id',
        'conektaEventId',
        'conekta_event_id',
        'clipEventId',
        'clip_event_id',
        'rebillEventId',
        'rebill_event_id',
        'payload.id',
        'payload.eventId',
        'payload.event_id',
        'event.id',
        'webhook.id'
      )
    case 'reference':
      return firstPaymentContextValue(ctx, 'reference')
    case 'title':
      return firstPaymentContextValue(ctx, 'title', 'name')
    case 'description':
      return firstPaymentContextValue(ctx, 'description')
    case 'receipt':
      return firstPaymentContextValue(ctx, 'receipt', 'reference', 'invoiceNumber', 'invoice_number', 'invoiceId', 'invoice_id', 'ghl_invoice_id', 'title', 'description')
    case 'receipt_url':
      return firstPaymentContextValue(ctx, 'receiptUrl', 'receipt_url', 'receiptDownloadUrl', 'receipt_download_url', 'paymentReceiptUrl', 'payment_receipt_url') ||
        appendPaymentReceiptQuery(buildPaymentPageUrlFromContext(ctx))
    case 'public_payment_id':
      return publicPaymentIdFromContext(ctx)
    case 'payment_url':
      return buildPaymentPageUrlFromContext(ctx)
    case 'invoice_id':
      return firstPaymentContextValue(ctx, 'invoiceId', 'invoice_id', 'ghl_invoice_id')
    case 'invoice_number':
      return firstPaymentContextValue(ctx, 'invoiceNumber', 'invoice_number')
    case 'product_name':
    case 'product_id':
    case 'local_product_id':
    case 'ghl_product_id':
    case 'product_sku':
    case 'price_name':
    case 'price_id':
    case 'local_price_id':
    case 'ghl_price_id':
      return paymentProductFieldCandidatesFromContext(ctx, field)[0] || ''
    case 'stripe_payment_intent_id':
      return firstPaymentContextValue(
        ctx,
        'stripePaymentIntentId',
        'stripe_payment_intent_id',
        'paymentIntentId',
        'payment_intent_id',
        'stripe.paymentIntentId',
        'stripe.payment_intent_id',
        'stripe.paymentIntent.id',
        'stripe.payment_intent.id'
      )
    case 'stripe_charge_id':
      return firstPaymentContextValue(ctx, 'stripeChargeId', 'stripe_charge_id', 'chargeId', 'charge_id', 'stripe.chargeId', 'stripe.charge_id', 'stripe.charge.id')
    case 'mercadopago_payment_id':
      return firstPaymentContextValue(
        ctx,
        'mercadoPagoPaymentId',
        'mercadopagoPaymentId',
        'mercadopago_payment_id',
        'mercadoPago.paymentId',
        'mercadoPago.payment_id',
        'mercado_pago.paymentId',
        'mercado_pago.payment_id'
      )
    case 'mercadopago_preference_id':
      return firstPaymentContextValue(
        ctx,
        'mercadoPagoPreferenceId',
        'mercadopagoPreferenceId',
        'mercadopago_preference_id',
        'preferenceId',
        'preference_id',
        'mercadoPago.preferenceId',
        'mercadoPago.preference_id',
        'mercado_pago.preferenceId',
        'mercado_pago.preference_id'
      )
    case 'conekta_order_id':
      return firstPaymentContextValue(ctx, 'conektaOrderId', 'conekta_order_id', 'orderId', 'order_id', 'conekta.orderId', 'conekta.order_id')
    case 'conekta_charge_id':
      return firstPaymentContextValue(ctx, 'conektaChargeId', 'conekta_charge_id', 'chargeId', 'charge_id', 'conekta.chargeId', 'conekta.charge_id')
    case 'conekta_payment_source_id':
      return firstPaymentContextValue(
        ctx,
        'conektaPaymentSourceId',
        'conekta_payment_source_id',
        'paymentSourceId',
        'payment_source_id',
        'sourceId',
        'source_id',
        'conekta.paymentSourceId',
        'conekta.payment_source_id'
      )
    case 'clip_payment_id':
      return firstPaymentContextValue(ctx, 'clipPaymentId', 'clip_payment_id', 'clip.paymentId', 'clip.payment_id', 'clip.id')
    case 'clip_receipt_no':
      return firstPaymentContextValue(ctx, 'clipReceiptNo', 'clip_receipt_no', 'receiptNo', 'receipt_no', 'clip.receiptNo', 'clip.receipt_no')
    case 'rebill_payment_id':
      return firstPaymentContextValue(ctx, 'rebillPaymentId', 'rebill_payment_id', 'rebill.paymentId', 'rebill.payment_id', 'rebill.id')
    case 'rebill_subscription_id':
      return firstPaymentContextValue(ctx, 'rebillSubscriptionId', 'rebill_subscription_id', 'rebill.subscriptionId', 'rebill.subscription_id')
    case 'rebill_customer_id':
      return firstPaymentContextValue(ctx, 'rebillCustomerId', 'rebill_customer_id', 'rebill.customerId', 'rebill.customer_id')
    case 'rebill_card_id':
      return firstPaymentContextValue(ctx, 'rebillCardId', 'rebill_card_id', 'rebill.cardId', 'rebill.card_id')
    case 'paid_at':
      return firstPaymentContextValue(ctx, 'paidAt', 'paid_at', 'fulfilledAt', 'fulfilled_at')
    case 'payment_date':
      return firstPaymentContextValue(ctx, 'paymentDate', 'payment_date', 'date', 'createdAt', 'created_at')
    case 'due_date':
      return firstPaymentContextValue(ctx, 'dueDate', 'due_date')
    case 'sent_at':
      return firstPaymentContextValue(ctx, 'sentAt', 'sent_at')
    case 'payment_created_at':
      return firstPaymentContextValue(ctx, 'createdAt', 'created_at')
    case 'payment_updated_at':
      return firstPaymentContextValue(ctx, 'updatedAt', 'updated_at')
    default:
      return ''
  }
}

function filterFieldValue(filter, ctx) {
  const contact = ctx.contact || {}
  const custom = contact.customFields || {}
  switch (filter.field) {
    case 'changed_detail': return ctx.changedFields || []
    case 'change_source': return ctx.contactChangeSource || ctx.changeSource || ''
    case 'message': return ctx.messageText || ''
    case 'channel': return ctx.channel || ''
    case 'comment_text': return ctx.messageText || ''
    case 'comment_platform': return ctx.platform || ''
    case 'comment_post': return ctx.postId || ctx.mediaId || ctx.permalink || ''
    case 'first_name': return contact.firstName || ''
    case 'last_name': return contact.lastName || ''
    case 'source': return contact.source || ''
    case 'email': return contact.email || ''
    case 'phone': return contact.phone || ''
    case 'preferred_whatsapp_number': return contact.preferredWhatsAppPhoneNumberId || contact.preferred_whatsapp_phone_number_id || ''
    case 'country': return contact.country || ''
    case 'stage': return contact.stage || custom.stage || ''
    case 'assigned': return contact.assignedUser || custom.assignedUser || ''
    case 'tag': return (contact.tagKeys || contact.tags || []).join(' , ')
    case 'custom': return String(custom[filter.customKey] ?? '')
    case 'created_at': return contact.createdAt || ''
    case 'updated_at': return contact.updatedAt || ''
    case 'visitor_id': return contact.visitorId || ''
    case 'total_paid': return contact.totalPaid ?? contact.total_paid ?? 0
    case 'payments_count': return contact.paymentsCount ?? 0
    case 'successful_payments_count': return contact.purchasesCount ?? contact.purchases_count ?? 0
    case 'last_purchase_date': return contact.lastPurchaseDate || ''
    case 'appointments_count': return contact.appointmentsCount ?? 0
    case 'active_appointments_count': return contact.activeAppointmentsCount ?? 0
    case 'has_active_appointment': return boolText(Boolean(contact.hasActiveAppointment))
    case 'active_appointment_status': return contact.activeAppointmentStatus || ''
    case 'active_appointment_calendar': return contact.activeAppointmentCalendarId || ''
    case 'active_appointment_assigned': return contact.activeAppointmentAssignedUserId || ''
    case 'active_appointment_date': return contact.activeAppointmentDate || ''
    // Atribución de anuncios (vive en el contacto)
    case 'ad': return contact.adName || contact.adId || ''
    case 'ad_id': return contact.adId || ''
    case 'attribution_url': return contact.attributionUrl || ''
    case 'medium': return contact.attributionMedium || ''
    // Campos del evento (cita, pago, anuncio…)
    case 'calendar': return ctx.calendarId || null
    case 'appointment_type': return ctx.appointmentType || null
    case 'payment_status': return paymentTriggerFieldValue(filter.field, ctx) || null
    case 'amount': return paymentTriggerFieldValue(filter.field, ctx) || null
    case 'product': return paymentProductCandidatesFromContext(ctx)[0] || null
    case 'currency':
    case 'provider':
    case 'payment_mode':
    case 'payment_method':
    case 'payment_id':
    case 'event_id':
    case 'reference':
    case 'title':
    case 'description':
    case 'receipt':
    case 'receipt_url':
    case 'public_payment_id':
    case 'payment_url':
    case 'invoice_id':
    case 'invoice_number':
    case 'stripe_payment_intent_id':
    case 'stripe_charge_id':
    case 'mercadopago_payment_id':
    case 'mercadopago_preference_id':
    case 'conekta_order_id':
    case 'conekta_charge_id':
    case 'conekta_payment_source_id':
    case 'clip_payment_id':
    case 'clip_receipt_no':
    case 'rebill_payment_id':
    case 'rebill_subscription_id':
    case 'rebill_customer_id':
    case 'rebill_card_id':
    case 'paid_at':
    case 'payment_date':
    case 'due_date':
    case 'sent_at':
    case 'payment_created_at':
    case 'payment_updated_at':
      return paymentTriggerFieldValue(filter.field, ctx) || null
    case 'campaign': return ctx.campaign || null
    case 'form_disqualified': return boolText(formDisqualifiedFromContext(ctx))
    case 'form_status': return ctx.formStatus || ctx.form_status || ctx.submissionStatus || ctx.submission_status || ctx.status || ''
    case 'form-submitted': return (ctx.submissionId || ctx.submission_id || primaryFormIdFromContext(ctx)) ? 'true' : 'false'
    case 'form-specific': return primaryFormIdFromContext(ctx)
    case 'form-date': return ctx.submittedAt || ctx.submitted_at || ctx.createdAt || ctx.created_at || ''
    case 'form-field-value':
    case 'form_field': return formResponseValue(ctx, filter.customKey || filter.custom_key || filter.fieldKey || filter.field_key)
    case 'link': return ctx.triggerLinkName || ctx.triggerLinkPublicId || ctx.triggerLinkId || ''
    case 'trigger_link': return ctx.triggerLinkName || ctx.triggerLinkPublicId || ctx.triggerLinkId || ''
    case 'destination_url': return ctx.destinationUrl || ''
    case 'previous_whatsapp_number': return ctx.previousPhoneNumber || ctx.previousPhoneNumberLabel || ctx.previousPhoneNumberId || ''
    case 'new_whatsapp_number': return ctx.newPhoneNumber || ctx.newPhoneNumberLabel || ctx.newPhoneNumberId || ''
    case 'whatsapp_routing_source': return ctx.routingSource || ''
    default: return null // campo sin dato local: no bloquea
  }
}

/** Operadores de filtro que no comparan contra un valor capturado */
const NO_VALUE_FILTER_OPERATORS = new Set(['empty', 'not_empty', 'yes', 'no', 'is_disqualified', 'not_disqualified'])

function truthyFilterValue(value) {
  return ['true', '1', 'yes', 'si', 'sí'].includes(normalizeText(value))
}

function numericCompare(actualRaw, expectedRaw, operator) {
  const actual = Number(actualRaw)
  const expected = Number(expectedRaw)
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false
  switch (operator) {
    case 'neq': return actual !== expected
    case 'gt': return actual > expected
    case 'gte': return actual >= expected
    case 'lt': return actual < expected
    case 'lte': return actual <= expected
    default: return actual === expected
  }
}

function evaluateChangedDetailFilter(filter, ctx) {
  const matched = changedFieldMatches(ctx.changedFields, filter.value)
  switch (filter.match) {
    case 'not':
    case 'not_contains':
      return !matched
    case 'empty':
      return !(Array.isArray(ctx.changedFields) && ctx.changedFields.length > 0)
    case 'not_empty':
      return Array.isArray(ctx.changedFields) && ctx.changedFields.length > 0
    default:
      return matched
  }
}

const PAYMENT_CANDIDATE_FILTER_FIELDS = new Set([
  'product',
  'product_name',
  'product_id',
  'local_product_id',
  'ghl_product_id',
  'product_sku',
  'price_name',
  'price_id',
  'local_price_id',
  'ghl_price_id'
])

function evaluatePaymentCandidateFilter(filter, ctx) {
  const candidates = filter.field === 'product'
    ? paymentProductCandidatesFromContext(ctx)
    : paymentProductFieldCandidatesFromContext(ctx, filter.field)
  if (candidates.length === 0) return true
  const normalizedCandidates = candidates.map(normalizeText).filter(Boolean)
  const expected = normalizeText(filter.value)
  const exactMatch = normalizedCandidates.some((candidate) => candidate === expected)
  const partialMatch = normalizedCandidates.some((candidate) => candidate.includes(expected))
  switch (filter.match) {
    case 'not': return !exactMatch
    case 'contains': return partialMatch
    case 'not_contains': return !partialMatch
    case 'starts_with': return normalizedCandidates.some((candidate) => candidate.startsWith(expected))
    case 'ends_with': return normalizedCandidates.some((candidate) => candidate.endsWith(expected))
    case 'empty': return normalizedCandidates.length === 0
    case 'not_empty': return normalizedCandidates.length > 0
    default: return exactMatch
  }
}

function evaluateFilter(filter, ctx) {
  if (filter.field === 'changed_detail') return evaluateChangedDetailFilter(filter, ctx)
  if (PAYMENT_CANDIDATE_FILTER_FIELDS.has(filter.field)) return evaluatePaymentCandidateFilter(filter, ctx)
  const actualRaw = filterFieldValue(filter, ctx)
  if (actualRaw === null) return true
  const actual = normalizeText(actualRaw)
  const expected = normalizeText(filter.value)
  switch (filter.match) {
    case 'not': return actual !== expected
    case 'eq': return numericCompare(actualRaw, filter.value, 'eq')
    case 'neq': return numericCompare(actualRaw, filter.value, 'neq')
    case 'gt': return numericCompare(actualRaw, filter.value, 'gt')
    case 'gte': return numericCompare(actualRaw, filter.value, 'gte')
    case 'lt': return numericCompare(actualRaw, filter.value, 'lt')
    case 'lte': return numericCompare(actualRaw, filter.value, 'lte')
    case 'contains': return actual.includes(expected)
    case 'not_contains': return !actual.includes(expected)
    case 'starts_with': return actual.startsWith(expected)
    case 'ends_with': return actual.endsWith(expected)
    case 'empty': return actual === ''
    case 'not_empty': return actual !== ''
    case 'yes': return truthyFilterValue(actualRaw)
    case 'no': return !truthyFilterValue(actualRaw)
    case 'is_disqualified': return actual === 'true' || actual === 'disqualified' || actual === 'descalificado'
    case 'not_disqualified': return actual !== 'true' && actual !== 'disqualified' && actual !== 'descalificado'
    default: return actual === expected
  }
}

export function filtersMatch(filters, ctx) {
  // Los filtros se unen en secuencia con Y / O (connector del propio filtro)
  const list = (Array.isArray(filters) ? filters : []).filter(
    (filter) =>
      filter?.field &&
      (NO_VALUE_FILTER_OPERATORS.has(filter.match) || String(filter.value || '').trim())
  )
  return list.reduce((accumulated, filter, index) => {
    const met = evaluateFilter(filter, ctx)
    if (index === 0) return met
    return filter.connector === 'or' ? accumulated || met : accumulated && met
  }, true)
}

const APPOINTMENT_STATUS_ALIASES = {
  showed: 'completed',
  noshow: 'no_show',
  'no-show': 'no_show'
}

function triggerMatches(trigger, eventType, ctx) {
  const config = trigger.config || {}
  const matchCtx = trigger.type === 'trigger-contact-updated' ? withContactChangeContext(eventType, ctx) : ctx
  if (!filtersMatch(config.filters, matchCtx)) return false

  switch (eventType) {
    case 'message-received': {
      const fixedTriggerChannel = MESSAGE_TRIGGER_CHANNELS[trigger.type]
      if (!fixedTriggerChannel && trigger.type !== 'trigger-customer-replied') return false
      const configuredChannel = fixedTriggerChannel || normalizeConversationChannel(config.channel) || 'any'
      const eventChannel = normalizeConversationChannel(ctx.channel)
      if (configuredChannel !== 'any' && configuredChannel !== eventChannel) return false
      return keywordsMatch(config, ctx.messageText)
    }

    case 'comment-received': {
      // AISLADO de 'message-received' a propósito: solo los disparos de comentario
      // entran aquí, así que las automatizaciones de DM NUNCA se disparan con
      // comentarios (y viceversa). Se filtra por platform del evento: Facebook
      // queda como Facebook para producto, aunque el transporte privado sea Messenger.
      if (trigger.type !== 'trigger-facebook-comment' && trigger.type !== 'trigger-instagram-comment') return false
      const wantPlatform = trigger.type === 'trigger-instagram-comment' ? 'instagram' : 'facebook'
      if (normalizeCommentEventPlatform(ctx.platform) !== wantPlatform) return false
      const post = str(config.post)
      if (post && !postMatches(post, ctx)) return false
      return keywordsMatch(config, ctx.messageText)
    }

    case 'contact-created': {
      if (trigger.type !== 'trigger-contact-created') return false
      const source = str(config.source)
      return !source || normalizeText(source) === normalizeText(ctx.contact?.source)
    }

    case 'contact-updated': {
      if (trigger.type !== 'trigger-contact-updated') return false
      const field = str(config.field)
      if (!field) return true
      return changedFieldMatches(matchCtx.changedFields, field)
    }

    case 'tag-changed': {
      if (trigger.type === 'trigger-contact-updated') return true
      if (trigger.type !== 'trigger-contact-tag') return false
      const operator = str(config.operator) || 'added'
      const tag = normalizeText(config.tag)
      if (!tag) return false
      if (operator === 'contains') return (ctx.contact?.tagKeys || ctx.contact?.tags || []).map(normalizeText).includes(tag)
      // El evento trae el nombre (ctx.tag) y el ID (ctx.tagId); la config puede tener cualquiera de los dos
      return ctx.tagAction === operator && (normalizeText(ctx.tag) === tag || normalizeText(ctx.tagId) === tag)
    }

    case 'form-submitted': {
      if (trigger.type !== 'trigger-form-submitted') return false
      const form = str(config.form)
      return formSubmittedMatches(form, ctx)
    }

    case 'scheduler': {
      if (trigger.type !== 'trigger-scheduler') return false
      const triggerKey = str(ctx.scheduleTriggerKey)
      if (!triggerKey) return true
      return triggerKey === (str(trigger.id) || trigger.type)
    }

    case 'appointment-booked': {
      if (trigger.type === 'trigger-contact-updated') return true
      if (trigger.type !== 'trigger-appointment-booked') return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'appointment-status': {
      if (trigger.type === 'trigger-contact-updated') return true
      if (trigger.type !== 'trigger-appointment-status') return false
      const wanted = str(config.status) || 'confirmed'
      const actualRaw = normalizeText(ctx.status)
      const actual = APPOINTMENT_STATUS_ALIASES[actualRaw] || actualRaw
      if (wanted !== actual) return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'payment-received': {
      if (trigger.type === 'trigger-contact-updated') return true
      if (trigger.type !== 'trigger-payment-received') return false
      if (!paymentActionMatches(config.paymentAction, ctx, eventType)) return false
      const operator = str(config.amountOperator) || 'any'
      if (operator !== 'any') {
        const amount = Number(ctx.amount) || 0
        const expected = Number(config.amount) || 0
        if (operator === 'gt' && !(amount > expected)) return false
        if (operator === 'gte' && !(amount >= expected)) return false
        if (operator === 'lt' && !(amount < expected)) return false
        if (operator === 'eq' && amount !== expected) return false
      }
      const product = str(config.product)
      if (!product) return true
      return paymentProductCandidatesFromContext(ctx).some((candidate) => normalizeText(candidate) === normalizeText(product))
    }

    case 'refund':
      if (trigger.type === 'trigger-contact-updated') return true
      if (trigger.type === 'trigger-refund') return true
      if (trigger.type !== 'trigger-payment-received') return false
      return paymentActionMatches(config.paymentAction, ctx, eventType)

    case 'webhook-received': {
      if (trigger.type !== 'trigger-incoming-webhook') return false
      const endpointId = str(config.endpointId)
      return Boolean(endpointId) && endpointId === str(ctx.endpointId)
    }

    case 'trigger-link-clicked': {
      if (trigger.type !== 'trigger-activation-link' && trigger.type !== 'trigger-link-clicked') return false
      const configured = str(config.link || config.triggerLinkId || config.publicId)
      return triggerLinkMatchesValue(configured, ctx)
    }

    default:
      return false
  }
}

function normalizeCommentEventPlatform(platform) {
  return str(platform) === 'instagram' ? 'instagram' : 'facebook'
}

const EVENT_DESCRIPTIONS = {
  'message-received': (ctx) => `llegó un mensaje por ${ctx.channel || 'el canal configurado'}`,
  'comment-received': (ctx) => `comentó en tu publicación de ${str(ctx.platform) === 'instagram' ? 'Instagram' : 'Facebook'}`,
  'contact-created': () => 'se creó el contacto',
  'contact-updated': (ctx) => `cambió ${(ctx.changedFields || []).join(', ') || 'un campo'} del contacto`,
  'tag-changed': (ctx) => `etiqueta "${ctx.tag}" ${ctx.tagAction === 'removed' ? 'eliminada' : 'añadida'}`,
  'form-submitted': (ctx) => `envió el formulario${ctx.formName ? ` "${ctx.formName}"` : ''}`,
  'appointment-booked': () => 'agendó una cita',
  'appointment-status': (ctx) => `la cita cambió a ${ctx.status}`,
  'payment-received': (ctx) => {
    const labels = {
      successful: 'se registró un pago exitoso',
      failed: 'se registró un error de pago',
      refunded: 'se registró un reembolso',
      pending: 'se registró un pago pendiente o incompleto'
    }
    const action = paymentActionFromContext(ctx, 'payment-received')
    return `${labels[action] || 'se registró un evento de pago'}${ctx.amount ? ` de $${ctx.amount}` : ''}`
  },
  refund: () => 'se procesó un reembolso',
  'webhook-received': () => 'se recibió un webhook',
  'trigger-link-clicked': (ctx) => `recibió un clic de disparo${ctx.triggerLinkName ? ` en "${ctx.triggerLinkName}"` : ''}`,
  scheduler: (ctx) => `llegó la fecha programada${ctx.scheduledFor ? ` (${ctx.scheduledFor})` : ''}`
}

// ---------------------------------------------------------------------------
// Condiciones (modelo avanzado: ramas → grupos → reglas)
// ---------------------------------------------------------------------------

function ruleFieldValue(rule, ctx) {
  if (isConditionVariableField(rule.field)) {
    const value = conditionVariableValue(rule, ctx)
    return value === undefined ? null : value
  }
  const contact = ctx.contact || {}
  switch (rule.field) {
    // Contacto — estado del contacto (siempre disponible)
    case 'contact-first-name': return contact.firstName || ''
    case 'contact-last-name': return contact.lastName || ''
    case 'contact-phone': return contact.phone || ''
    case 'contact-email': return contact.email || ''
    case 'contact-source': return contact.source || ''
    case 'contact-country': return contact.country || ''
    case 'contact-stage': return contact.stage || ''
    case 'contact-assigned-user': return contact.assignedUser || ''
    case 'contact-created': return contact.createdAt || ''
    case 'contact-updated': return contact.updatedAt || ''
    case 'contact-custom-field': return String((contact.customFields || {})[rule.customKey] ?? '')
    // Etiquetas — la lógica (cualquiera/todas/ninguna) la aplica el operador
    case 'tag-has':
    case 'tag-any-of':
    case 'tag-not-has':
    case 'tag-all-of':
      return (contact.tagKeys || contact.tags || []).join(' , ')
    // Citas — agregados de la cita activa del contacto (estado, siempre)
    case 'appt-has': return contact.hasActiveAppointment ? 'true' : 'false'
    case 'appt-status': return contact.activeAppointmentStatus || ''
    case 'appt-calendar': return contact.activeAppointmentCalendarId || ''
    case 'appt-date': return contact.activeAppointmentDate || ''
    // Pagos — historial del contacto (estado, siempre) + el pago del evento
    case 'pay-has':
      return (Number(contact.paymentsCount) > 0
        || ctx.paymentId || ctx.payment_id || ctx.amount || ctx.status || ctx.paymentStatus)
        ? 'true' : 'false'
    case 'pay-total': return contact.totalPaid ?? 0
    case 'pay-last-date': return contact.lastPurchaseDate || ''
    case 'pay-status': return ctx.paymentStatus || ctx.payment_status || ctx.status || ''
    case 'pay-amount': return ctx.amount ?? ''
    case 'pay-product': return paymentProductCandidatesFromContext(ctx)[0] || ctx.product || ctx.title || ctx.description || ''
    case 'pay-currency': return ctx.currency || ''
    case 'pay-date': return ctx.paymentDate || ctx.date || ctx.createdAt || ''
    // Anuncio / atribución — de dónde vino el contacto (estado, siempre)
    case 'ads-ad': return contact.adName || contact.adId || ''
    case 'ads-ad-id': return contact.adId || ''
    case 'ads-medium': return contact.attributionMedium || contact.source || ''
    case 'ads-url': return contact.attributionUrl || ''
    // Automatizaciones — membresía del contacto (estado, siempre). El operador
    // (cualquiera/ninguna) decide "está en" / "no está en".
    case 'auto-enrolled': return (contact.activeAutomationIds || []).join(' , ')
    // Conversación — del evento de mensaje
    case 'conv-last-received': return ctx.messageText || ''
    case 'conv-keyword': return ctx.messageText || ''
    case 'conv-replied': return ctx.messageText ? 'true' : 'false'
    case 'conv-channel': return ctx.channel || ''
    // Comentario — del evento de comentario
    case 'comment-text': return ctx.messageText || ''
    case 'comment-platform': return ctx.platform || ''
    case 'comment-post-fb': return ctx.postId || ''
    case 'comment-post-ig': return ctx.mediaId || ''
    // Formularios — del evento de envío
    case 'form-submitted': return (ctx.submissionId || ctx.submission_id || primaryFormIdFromContext(ctx)) ? 'true' : 'false'
    case 'form-specific': return primaryFormIdFromContext(ctx)
    case 'form-date': return ctx.submittedAt || ctx.submitted_at || ctx.createdAt || ctx.created_at || ''
    case 'form_disqualified': return boolText(formDisqualifiedFromContext(ctx))
    case 'form-field-value':
    case 'form_field': return formResponseValue(ctx, rule.customKey || rule.custom_key || rule.fieldKey || rule.field_key)
    // Clics de disparo — del evento del enlace de activación
    case 'link-clicked': return (ctx.triggerLinkId || ctx.triggerLinkPublicId) ? 'true' : 'false'
    case 'link-specific': return ctx.triggerLinkId || ''
    case 'link-date': return ctx.clickedAt || ''
    default: return null
  }
}

function comparableValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function pathAfterTokenRoot(token) {
  const dotIndex = token.indexOf('.')
  const bracketIndex = token.indexOf('[')
  const candidates = [dotIndex, bracketIndex].filter((index) => index >= 0)
  if (candidates.length === 0) return ''
  const index = Math.min(...candidates)
  return token[index] === '.' ? token.slice(index + 1) : token.slice(index)
}

function conditionVariableValue(rule, ctx) {
  const token = conditionVariableTokenFromField(rule.field)
  const sourceId = str(rule.fieldSourceId)
  if (sourceId && ctx.__nodeOutputs && typeof ctx.__nodeOutputs === 'object') {
    const sourceOutput = ctx.__nodeOutputs[sourceId]
    if (sourceOutput !== undefined) {
      const path = str(rule.fieldPath) || pathAfterTokenRoot(token)
      const value = readPath(sourceOutput, path)
      if (value !== undefined) return value
    }
  }

  const map = buildVariableMap(ctx)
  if (Object.prototype.hasOwnProperty.call(map, token)) return map[token]
  return resolveDynamicToken(token, ctx)
}

function dateTimeMs(value) {
  const raw = comparableValue(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean)
  return comparableValue(value)
    .split(',')
    .map(normalizeText)
    .filter(Boolean)
}

function numberBetween(actual, from, to) {
  const actualNumber = Number(actual)
  const fromNumber = Number(from)
  const toNumber = Number(to)
  if ([actualNumber, fromNumber, toNumber].every(Number.isFinite)) {
    return actualNumber >= fromNumber && actualNumber <= toNumber
  }
  const actualDate = dateTimeMs(actual)
  const fromDate = dateTimeMs(from)
  const toDate = dateTimeMs(to)
  if ([actualDate, fromDate, toDate].every((value) => value !== null)) {
    return actualDate >= fromDate && actualDate <= toDate
  }
  const normalizedActual = normalizeText(actual)
  return normalizedActual >= normalizeText(from) && normalizedActual <= normalizeText(to)
}

function evaluateRule(rule, ctx) {
  const actualRaw = ruleFieldValue(rule, ctx)
  if (actualRaw === null) return { ok: false, known: false }
  const actualValue = comparableValue(actualRaw)
  const expectedValue = renderTemplate(String(rule.value ?? ''), ctx)
  const expectedToValue = renderTemplate(String(rule.valueTo ?? ''), ctx)
  const actual = normalizeText(actualValue)
  const expected = normalizeText(expectedValue)
  switch (rule.operator) {
    case 'is':
    case 'eq':
      return { ok: actual === expected, known: true }
    case 'is_not':
    case 'neq':
      return { ok: actual !== expected, known: true }
    case 'contains': return { ok: actual.includes(expected), known: true }
    case 'not_contains': return { ok: !actual.includes(expected), known: true }
    case 'starts_with': return { ok: actual.startsWith(expected), known: true }
    case 'ends_with': return { ok: actual.endsWith(expected), known: true }
    case 'empty':
    case 'is_empty':
      return { ok: actual === '', known: true }
    case 'not_empty':
    case 'is_not_empty':
      return { ok: actual !== '', known: true }
    case 'yes':
    case 'is_true':
      return { ok: ['true', '1', 'yes', 'si', 'sí'].includes(actual), known: true }
    case 'no':
    case 'is_false':
      return { ok: !['true', '1', 'yes', 'si', 'sí'].includes(actual), known: true }
    case 'gt': return { ok: Number(actualValue) > Number(expectedValue), known: true }
    case 'gte': return { ok: Number(actualValue) >= Number(expectedValue), known: true }
    case 'lt': return { ok: Number(actualValue) < Number(expectedValue), known: true }
    case 'lte': return { ok: Number(actualValue) <= Number(expectedValue), known: true }
    case 'between':
      return { ok: numberBetween(actualValue, expectedValue, expectedToValue), known: true }
    case 'before': {
      const actualDate = dateTimeMs(actualValue)
      const expectedDate = dateTimeMs(expectedValue)
      return { ok: actualDate !== null && expectedDate !== null && actualDate < expectedDate, known: true }
    }
    case 'after': {
      const actualDate = dateTimeMs(actualValue)
      const expectedDate = dateTimeMs(expectedValue)
      return { ok: actualDate !== null && expectedDate !== null && actualDate > expectedDate, known: true }
    }
    case 'on': {
      const actualDate = comparableValue(actualValue).slice(0, 10)
      const expectedDate = comparableValue(expectedValue).slice(0, 10)
      return { ok: Boolean(actualDate && expectedDate && actualDate === expectedDate), known: true }
    }
    case 'last_days': {
      const actualDate = dateTimeMs(actualValue)
      const days = Number(expectedValue)
      return { ok: actualDate !== null && Number.isFinite(days) && actualDate >= Date.now() - days * 24 * 60 * 60 * 1000, known: true }
    }
    case 'older_days': {
      const actualDate = dateTimeMs(actualValue)
      const days = Number(expectedValue)
      return { ok: actualDate !== null && Number.isFinite(days) && actualDate < Date.now() - days * 24 * 60 * 60 * 1000, known: true }
    }
    case 'any': {
      const actualList = splitList(actualRaw)
      const expectedList = splitList(expectedValue)
      return { ok: expectedList.some((item) => actualList.includes(item)), known: true }
    }
    case 'all': {
      const actualList = splitList(actualRaw)
      const expectedList = splitList(expectedValue)
      return { ok: expectedList.length > 0 && expectedList.every((item) => actualList.includes(item)), known: true }
    }
    case 'none': {
      const actualList = splitList(actualRaw)
      const expectedList = splitList(expectedValue)
      return { ok: expectedList.every((item) => !actualList.includes(item)), known: true }
    }
    default: return { ok: false, known: false }
  }
}

function evaluateGroup(group, ctx) {
  const rules = Array.isArray(group.rules) ? group.rules : []
  if (rules.length === 0) return true
  const results = rules.map((rule) => evaluateRule(rule, ctx).ok)
  const met = (group.operator || 'AND') === 'OR' ? results.some(Boolean) : results.every(Boolean)
  return group.negate ? !met : met
}

function evaluateBranch(branch, ctx) {
  const groups = Array.isArray(branch.groups) ? branch.groups : []
  if (groups.length === 0) return false
  const results = groups.map((group) => evaluateGroup(group, ctx))
  return (branch.groupsOperator || 'AND') === 'OR' ? results.some(Boolean) : results.every(Boolean)
}

/** Devuelve el handle de salida que corresponde según la condición */
export function evaluateConditionNode(config, ctx) {
  const branches = Array.isArray(config?.branches) ? config.branches : []
  if (branches.length <= 1) {
    const met = branches.length === 1 ? evaluateBranch(branches[0], ctx) : false
    return { handle: met ? 'yes' : 'no', label: met ? 'Sí' : 'No' }
  }
  for (let index = 0; index < branches.length; index += 1) {
    if (evaluateBranch(branches[index], ctx)) {
      const id = str(branches[index].id) || `branch-${index + 1}`
      return { handle: id, label: str(branches[index].name) || `Rama ${index + 1}` }
    }
  }
  return { handle: 'none', label: 'Ninguna' }
}

// ---------------------------------------------------------------------------
// Inscripciones: persistencia y bitácora
// ---------------------------------------------------------------------------

async function saveEnrollment(enrollment) {
  finalizeEnrollmentOutcome(enrollment)
  await db.run(
    `UPDATE automation_enrollments
     SET status = ?, current_node_id = ?, log = ?, resume_at = ?, wait_kind = ?, context = ?,
         execution_outcome = ?, last_error = ?,
         contact_id = COALESCE(?, contact_id), contact_name = COALESCE(?, contact_name),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      enrollment.status,
      enrollment.currentNodeId,
      JSON.stringify(enrollment.log),
      enrollment.resumeAt || null,
      enrollment.waitKind || null,
      JSON.stringify(enrollment.context || {}),
      enrollment.executionOutcome || 'pending',
      enrollment.lastError || null,
      enrollment.contactId || null,
      enrollment.contactName || null,
      enrollment.id
    ]
  )
}

const LOG_OUTCOMES = new Set(['success', 'error', 'waiting', 'skipped', 'info'])
const ENROLLMENT_EXECUTION_OUTCOMES = new Set(['pending', 'success', 'error', 'stopped'])

function normalizeLogOutcome(entry = {}) {
  const explicit = cleanString(entry.outcome).toLowerCase()
  if (LOG_OUTCOMES.has(explicit)) return explicit

  const status = cleanString(entry.status).toLowerCase()
  if (status === 'error' || status === 'failed' || status === 'failure') return 'error'
  if (status === 'waiting' || status === 'retrying') return 'waiting'
  if (status === 'skipped' || status === 'omitted') return 'skipped'
  if (status === 'info' || status === 'exited' || status === 'paused') return 'info'
  return 'success'
}

function logErrorMessage(entry = {}) {
  return cleanString(entry.errorMessage || entry.error || (normalizeLogOutcome(entry) === 'error' ? entry.detail : ''))
}

function hasUnresolvedExecutionErrors(log = []) {
  return (Array.isArray(log) ? log : []).some((entry) =>
    normalizeLogOutcome(entry) === 'error' && !entry.resolved && !entry.resolvedAt
  )
}

function latestExecutionError(log = [], { unresolvedOnly = false } = {}) {
  const entries = Array.isArray(log) ? log : []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (normalizeLogOutcome(entry) !== 'error') continue
    if (unresolvedOnly && (entry.resolved || entry.resolvedAt)) continue
    const message = logErrorMessage(entry)
    if (message) return message
  }
  return null
}

function finalizeEnrollmentOutcome(enrollment) {
  const status = cleanString(enrollment.status).toLowerCase()
  if (['active', 'waiting', 'paused'].includes(status)) {
    enrollment.executionOutcome = 'pending'
    enrollment.lastError = latestExecutionError(enrollment.log, { unresolvedOnly: true })
    return enrollment.executionOutcome
  }

  if (hasUnresolvedExecutionErrors(enrollment.log)) {
    enrollment.executionOutcome = 'error'
    enrollment.lastError = latestExecutionError(enrollment.log, { unresolvedOnly: true })
    return enrollment.executionOutcome
  }

  if (status === 'completed' || enrollment.executionOutcome === 'success') {
    enrollment.executionOutcome = 'success'
    enrollment.lastError = null
    return enrollment.executionOutcome
  }

  if (status === 'exited') {
    enrollment.executionOutcome = 'stopped'
    enrollment.lastError = null
    return enrollment.executionOutcome
  }

  if (!ENROLLMENT_EXECUTION_OUTCOMES.has(enrollment.executionOutcome)) {
    enrollment.executionOutcome = 'pending'
  }
  return enrollment.executionOutcome
}

function addLog(enrollment, entry) {
  const outcome = normalizeLogOutcome(entry)
  const errorMessage = logErrorMessage({ ...entry, outcome })
  const detail = cleanString(entry.detail || errorMessage)
  const logEntry = {
    ...entry,
    id: entry.id || makeId('exec'),
    at: entry.at || nowIso(),
    status: entry.status || (outcome === 'success' ? 'ok' : outcome),
    outcome,
    ...(detail ? { detail } : {}),
    ...(errorMessage ? { errorMessage } : {})
  }
  if (!Array.isArray(enrollment.log)) enrollment.log = []
  enrollment.log.push(logEntry)
  if (enrollment.log.length > 200) enrollment.log = enrollment.log.slice(-200)

  if (outcome === 'error' && !logEntry.retryable) {
    enrollment.executionOutcome = 'error'
  }
  if (outcome === 'error' && errorMessage) enrollment.lastError = errorMessage
}

function executionOutcomeForResult(result = {}) {
  const explicit = cleanString(result.outcome).toLowerCase()
  if (LOG_OUTCOMES.has(explicit)) return explicit
  if (cleanString(result.output?.status).toLowerCase() === 'error' || result.output?.error) return 'error'
  if (result.skipped) return 'skipped'
  if (result.wait) return 'waiting'
  return 'success'
}

function logStatusForOutcome(outcome) {
  if (outcome === 'success') return 'ok'
  if (outcome === 'waiting') return 'waiting'
  if (outcome === 'skipped') return 'skipped'
  if (outcome === 'info') return 'info'
  return 'error'
}

function resolveRetryErrors(enrollment, nodeId) {
  const resolvedAt = nowIso()
  enrollment.log = (enrollment.log || []).map((entry) => {
    if (
      entry.nodeId === nodeId &&
      normalizeLogOutcome(entry) === 'error' &&
      entry.retryable &&
      !entry.resolved &&
      !entry.resolvedAt
    ) {
      return { ...entry, resolved: true, resolvedAt }
    }
    return entry
  })
}

function getPersistentRuntimeContext(ctx = {}, current = {}) {
  return {
    messageText: ctx.messageText || current.messageText || '',
    channel: ctx.channel || current.channel || '',
    businessPhoneNumberId: ctx.businessPhoneNumberId || current.businessPhoneNumberId || null,
    platform: ctx.platform || current.platform || '',
    commentId: ctx.commentId || current.commentId || null,
    postId: ctx.postId || current.postId || null,
    mediaId: ctx.mediaId || current.mediaId || null,
    parentCommentId: ctx.parentCommentId || current.parentCommentId || null,
    permalink: ctx.permalink || current.permalink || null
  }
}

async function createEnrollment(automation, contact, ctx) {
  const id = makeId('enr')
  const enrollment = {
    id,
    automationId: automation.id,
    contactId: contact.id || null,
    contactName: contact.fullName || contact.phone || contact.email || 'Contacto',
    status: 'active',
    currentNodeId: 'start',
    log: [],
    executionOutcome: 'pending',
    lastError: null,
    resumeAt: null,
    waitKind: null,
    context: {
      ...getPersistentRuntimeContext(ctx),
      triggerLinkId: ctx.triggerLinkId || null,
      triggerLinkPublicId: ctx.triggerLinkPublicId || null,
      triggerLinkName: ctx.triggerLinkName || null,
      triggerLinkUrl: ctx.triggerLinkUrl || null,
      destinationUrl: ctx.destinationUrl || null,
      visitorId: ctx.visitorId || null,
      referrer: ctx.referrer || null,
      eventId: ctx.eventId || null,
      clickedAt: ctx.clickedAt || null,
      query: ctx.query || null,
      payload: ctx.payload || null,
      formId: ctx.formId || null,
      formName: ctx.formName || null,
      automationFormId: ctx.automationFormId || ctx.automation_form_id || null,
      siteId: ctx.siteId || ctx.site_id || null,
      siteName: ctx.siteName || ctx.site_name || null,
      formSiteId: ctx.formSiteId || ctx.form_site_id || null,
      formSiteName: ctx.formSiteName || ctx.form_site_name || null,
      importedFormId: ctx.importedFormId || ctx.imported_form_id || null,
      importedFormName: ctx.importedFormName || ctx.imported_form_name || ctx.importedFormTitle || ctx.imported_form_title || null,
      formStatus: ctx.formStatus || ctx.form_status || ctx.submissionStatus || ctx.submission_status || ctx.status || null,
      formDisqualified: formDisqualifiedFromContext(ctx),
      submissionId: ctx.submissionId || ctx.submission_id || null,
      submittedAt: ctx.submittedAt || ctx.submitted_at || null,
      formResponses: ctx.formResponses || ctx.form_responses || null,
      formAnswers: ctx.formAnswers || ctx.form_answers || null,
      formAnswersText: ctx.formAnswersText || ctx.form_answers_text || '',
      scheduledFor: ctx.scheduledFor || null,
      scheduleRunKey: ctx.scheduleRunKey || null,
      scheduleRecurrence: ctx.scheduleRecurrence || null,
      scheduleTimezone: ctx.scheduleTimezone || null,
      manualEnrollment: Boolean(ctx.manualEnrollment),
      manualEnrollmentSource: ctx.manualEnrollmentSource || null,
      manualScheduledFor: ctx.manualScheduledFor || null
    }
  }
  // (AUTO-004) ON CONFLICT DO NOTHING contra el índice único parcial
  // uq_automation_enrollments_auto_contact (automation_id, contact_id WHERE contact_id IS NOT NULL).
  // Si dos triggers corren la misma inscripción en paralelo, solo una gana la carrera.
  const result = await db.run(
    `INSERT INTO automation_enrollments
       (id, automation_id, contact_id, contact_name, status, current_node_id, log, context)
     VALUES (?, ?, ?, ?, 'active', 'start', '[]', ?)
     ON CONFLICT DO NOTHING`,
    [id, automation.id, enrollment.contactId, enrollment.contactName, JSON.stringify(enrollment.context)]
  )
  // (AUTO-004) Si no se insertó (changes === 0) ya existía una inscripción para este
  // contacto+automatización: recuperamos la real y la devolvemos en vez del objeto recién
  // construido, para no procesar una inscripción fantasma con id que no está en la tabla.
  if (result && result.changes === 0 && enrollment.contactId) {
    const existing = await db.get(
      `SELECT id, automation_id, contact_id, contact_name, status, current_node_id, log,
              execution_outcome, last_error, resume_at, wait_kind, context
         FROM automation_enrollments
        WHERE automation_id = ? AND contact_id = ?
        ORDER BY entered_at ASC, id ASC
        LIMIT 1`,
      [automation.id, enrollment.contactId]
    )
    if (existing) {
      return {
        id: existing.id,
        automationId: existing.automation_id,
        contactId: existing.contact_id || null,
        contactName: existing.contact_name || enrollment.contactName,
        status: existing.status || 'active',
        currentNodeId: existing.current_node_id || 'start',
        log: parseJson(existing.log, []),
        executionOutcome: existing.execution_outcome || 'pending',
        lastError: existing.last_error || null,
        resumeAt: existing.resume_at || null,
        waitKind: existing.wait_kind || null,
        context: parseJson(existing.context, {})
      }
    }
  }
  return enrollment
}

// ---------------------------------------------------------------------------
// Ejecución de nodos
// ---------------------------------------------------------------------------

const DURATION_MS = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000
}

const DRIP_DURATION_MS = {
  minutes: DURATION_MS.minutes,
  hours: DURATION_MS.hours,
  days: DURATION_MS.days
}

const DRIP_UNIT_LABELS = {
  minutes: ['minuto', 'minutos'],
  hours: ['hora', 'horas'],
  days: ['día', 'días']
}

function durationLabel(amount, unit) {
  const [singular, plural] = DRIP_UNIT_LABELS[unit] || DRIP_UNIT_LABELS.minutes
  return `${amount} ${amount === 1 ? singular : plural}`
}

function dateToIso(value, fallback = nowIso()) {
  if (!value) return fallback
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function isUniqueConstraintError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code === 'SQLITE_CONSTRAINT' ||
    code === '23505' ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('duplicate key value')
}

function normalizeDripConfig(config = {}) {
  const batchSize = Math.max(1, Math.floor(Number(config.batchSize) || 1))
  const intervalAmount = Math.max(1, Number(config.intervalAmount) || 1)
  const intervalUnit = DRIP_DURATION_MS[str(config.intervalUnit)] ? str(config.intervalUnit) : 'minutes'
  return {
    batchSize,
    intervalAmount,
    intervalUnit,
    intervalMs: intervalAmount * DRIP_DURATION_MS[intervalUnit]
  }
}

async function assignDripEntry({ automationId, nodeId, enrollmentId, batchSize, intervalMs }) {
  if (!automationId || !nodeId || !enrollmentId) {
    const now = nowIso()
    return { position: 1, batchIndex: 0, scheduledFor: now }
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const existing = await tx.get(
          `SELECT position, batch_index, scheduled_for
           FROM automation_drip_entries
           WHERE automation_id = ? AND node_id = ? AND enrollment_id = ?`,
          [automationId, nodeId, enrollmentId]
        )
        if (existing) {
          return {
            position: Number(existing.position) || 1,
            batchIndex: Number(existing.batch_index) || 0,
            scheduledFor: dateToIso(existing.scheduled_for)
          }
        }

        const state = await tx.get(
          `SELECT MIN(created_at) AS first_created_at, MAX(position) AS last_position
           FROM automation_drip_entries
           WHERE automation_id = ? AND node_id = ?`,
          [automationId, nodeId]
        )
        const createdAt = nowIso()
        const anchor = dateToIso(state?.first_created_at, createdAt)
        const position = (Number(state?.last_position) || 0) + 1
        const batchIndex = Math.floor((position - 1) / batchSize)
        const scheduledFor = new Date(new Date(anchor).getTime() + batchIndex * intervalMs).toISOString()

        await tx.run(
          `INSERT INTO automation_drip_entries
             (id, automation_id, node_id, enrollment_id, position, batch_index, scheduled_for, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [makeId('drip'), automationId, nodeId, enrollmentId, position, batchIndex, scheduledFor, createdAt]
        )

        return { position, batchIndex, scheduledFor }
      })
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 4) continue
      throw error
    }
  }

  throw new Error('No se pudo asignar el lote de goteo')
}

async function executeDripNode(node, enrollment) {
  const { batchSize, intervalAmount, intervalUnit, intervalMs } = normalizeDripConfig(node.config || {})
  const assignment = await assignDripEntry({
    automationId: enrollment?.automationId,
    nodeId: node.id,
    enrollmentId: enrollment?.id,
    batchSize,
    intervalMs
  })
  const batchNumber = assignment.batchIndex + 1
  const scheduledTime = new Date(assignment.scheduledFor).getTime()
  const batchDetail = `lote ${batchNumber} (${batchSize} contacto${batchSize === 1 ? '' : 's'} cada ${durationLabel(intervalAmount, intervalUnit)})`

  if (Number.isNaN(scheduledTime) || scheduledTime <= Date.now()) {
    return {
      handle: 'out',
      detail: `Goteo liberado: ${batchDetail}`
    }
  }

  return {
    wait: {
      kind: WAIT_KIND_DRIP,
      resumeAt: assignment.scheduledFor,
      context: {
        dripNodeId: node.id,
        dripBatch: batchNumber,
        dripPosition: assignment.position,
        dripBatchSize: batchSize,
        dripScheduledFor: assignment.scheduledFor
      }
    },
    detail: `Goteo programado: ${batchDetail}`
  }
}

async function applyTagAction(node, ctx, remove) {
  const tag = str(node.config?.tag)
  if (!tag || !ctx.contact?.id) return `Etiqueta no aplicada (sin ${tag ? 'contacto' : 'etiqueta'})`
  // La config puede traer el ID del catálogo (editor nuevo) o el nombre
  // (automatizaciones viejas); siempre se guarda el ID en contacts.tags.
  const [tagId] = await resolveTagIds([tag], { createMissing: !remove })
  const [tagName] = tagId ? await tagNamesForIds([tagId]) : []
  const displayName = tagName || tag
  const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [ctx.contact.id])
  const tags = parseJson(row?.tags, [])
  const list = Array.isArray(tags) ? tags : []
  const matchesTag = (candidate) => {
    const normalized = normalizeText(candidate)
    return Boolean(
      candidate === tagId ||
        normalized === normalizeText(tag) ||
        normalized === normalizeText(displayName)
    )
  }
  const hadTag = list.some(matchesTag)
  const next = remove
    ? list.filter((candidate) => !matchesTag(candidate))
    : hadTag
      ? [...new Set(list.map((candidate) => (matchesTag(candidate) && tagId ? tagId : candidate)).filter(Boolean))]
      : [...new Set([...list, tagId || tag].filter(Boolean))]
  const changedTags = JSON.stringify(next) !== JSON.stringify(list)
  if (changedTags) {
    await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
      JSON.stringify(next),
      ctx.contact.id
    ])
  }
  ctx.contact.tags = next
  ctx.contact.tagKeys = await buildTagMatchKeys(ctx.contact.id, next)
    .then((keys) => [...keys])
    .catch(() => next)
  const didChangeSemanticTag = remove ? hadTag : !hadTag
  if (didChangeSemanticTag) {
    // El cambio real de etiqueta puede disparar otras automatizaciones.
    // (AUTO-008) Propagamos la profundidad de cascada para que handleAutomationEvent
    // pueda cortar re-disparos en cadena entre automatizaciones que se etiquetan
    // mutuamente.
    const nextCascadeDepth = (Number(ctx.__cascadeDepth) || 0) + 1
    setImmediate(() => {
      handleAutomationEvent('tag-changed', {
        contactId: ctx.contact.id,
        tag: displayName,
        tagId: tagId || null,
        tagAction: remove ? 'removed' : 'added',
        __cascadeDepth: nextCascadeDepth
      }).catch(() => undefined)
    })
  }
  if (!didChangeSemanticTag) {
    return remove
      ? `Etiqueta "${displayName}" ya no estaba aplicada`
      : `Etiqueta "${displayName}" ya estaba aplicada`
  }
  return remove ? `Etiqueta "${displayName}" quitada` : `Etiqueta "${displayName}" añadida`
}

function renderedConfigValue(value, ctx) {
  return renderTemplate(str(value), ctx).trim()
}

function compactName(firstName, lastName, fallback = '') {
  return [firstName, lastName].map((part) => str(part).trim()).filter(Boolean).join(' ') || str(fallback).trim()
}

function objectFromCustomFields(value) {
  return customFieldsBag(value)
}

function customFieldRowsToObject(rows, ctx) {
  const values = {}
  if (!Array.isArray(rows)) return values
  rows.forEach((row) => {
    const key = str(row?.key).trim()
    if (!key) return
    values[key] = renderedConfigValue(row?.value, ctx)
  })
  return values
}

function contactAutomationOutput(contact = {}) {
  return {
    id_contacto: contact.id || '',
    nombre: contact.fullName || contact.firstName || '',
    telefono: contact.phone || '',
    email: contact.email || '',
    id_numero_whatsapp_preferido: contact.preferredWhatsAppPhoneNumberId || contact.preferred_whatsapp_phone_number_id || '',
    etiquetas: contact.tags || contact.tagKeys || [],
    campos_personalizados: contact.customFields || {}
  }
}

function webhookResponseRoot(occurrence) {
  return `Webhook.response_${String(occurrence).padStart(2, '0')}`
}

function setOutputAtTokenRoot(ctx, root, output) {
  const segments = cleanString(root).split('.').filter(Boolean)
  if (segments.length === 0) return
  let target = ctx
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(target[segment])) target[segment] = {}
    target = target[segment]
  }
  target[segments[segments.length - 1]] = output
}

function exposeNodeOutput(ctx, node, result) {
  if (!result?.output || !result.outputBaseId || !node?.id) return
  if (!ctx.__nodeOutputs || typeof ctx.__nodeOutputs !== 'object') ctx.__nodeOutputs = {}
  if (!ctx.__outputOccurrences || typeof ctx.__outputOccurrences !== 'object') ctx.__outputOccurrences = {}

  ctx.__nodeOutputs[node.id] = result.output

  const baseId = str(result.outputBaseId)
  const nextOccurrence = (Number(ctx.__outputOccurrences[baseId]) || 0) + 1
  ctx.__outputOccurrences[baseId] = nextOccurrence

  const fixedRoot = str(result.outputFixedRoot)
  const root = fixedRoot
    ? nextOccurrence === 1 ? fixedRoot : `${fixedRoot}_${nextOccurrence}`
    : `${baseId}_${nextOccurrence}`
  if (baseId === 'http_request') {
    setOutputAtTokenRoot(ctx, webhookResponseRoot(nextOccurrence), result.output)
  }
  ctx[root] = result.output
  if (nextOccurrence === 1 && !fixedRoot && ctx[baseId] === undefined) {
    ctx[baseId] = result.output
  }
}

function responseBodyFromText(text) {
  if (!str(text).trim()) return ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function webhookHeadersModeFromConfig(config = {}) {
  const mode = cleanString(config.headersMode).toLowerCase()
  if (mode === 'fields' || mode === 'json') return mode
  return str(config.headersJson).trim() ? 'json' : 'fields'
}

function addRenderedWebhookHeader(headers, key, value, ctx) {
  const cleanKey = str(key).trim()
  if (!cleanKey) return
  headers[cleanKey] = renderTemplate(String(value ?? ''), ctx, { preserveUnknown: true })
}

function webhookHeadersFromConfig(config = {}, ctx) {
  const headers = {}
  if (webhookHeadersModeFromConfig(config) === 'json') {
    const rawJson = str(config.headersJson).trim()
    if (!rawJson) return headers

    try {
      const parsed = JSON.parse(rawJson)
      if (isPlainObject(parsed)) {
        Object.entries(parsed).forEach(([key, value]) => addRenderedWebhookHeader(headers, key, value, ctx))
      }
    } catch (error) {
      logger.warn(`[Automations] Headers JSON inválidos para webhook: ${error.message}`)
    }
    return headers
  }

  const rawHeaders = config.headers
  if (Array.isArray(rawHeaders)) {
    rawHeaders.forEach((row) => {
      addRenderedWebhookHeader(headers, row?.key || row?.name, row?.value, ctx)
    })
    return headers
  }
  if (isPlainObject(rawHeaders)) {
    Object.entries(rawHeaders).forEach(([key, value]) => {
      addRenderedWebhookHeader(headers, key, value, ctx)
    })
  }
  return headers
}

function hasWebhookHeader(headers, name) {
  const expected = cleanString(name).toLowerCase()
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === expected)
}

function deleteWebhookHeader(headers, name) {
  const expected = cleanString(name).toLowerCase()
  Object.keys(headers || {}).forEach((key) => {
    if (key.toLowerCase() === expected) delete headers[key]
  })
}

function webhookAppointmentTestContext(ctx = {}) {
  if (ctx.testMode !== true) return null
  const testEffectId = cleanString(ctx.testEffectId || ctx.test_effect_id)
  const testRunId = cleanString(ctx.testRunId || ctx.test_run_id)
  const appointmentId = cleanString(ctx.appointmentId || ctx.appointment_id)
  if (!testEffectId || !testRunId || !appointmentId) return null
  return {
    testMode: true,
    source: 'ristak_conversational_agent_test',
    testRunId,
    testEffectId,
    appointmentId,
    eventType: cleanString(ctx.eventType || ctx.event_type || 'appointment-test'),
    automationId: cleanString(ctx.automationId),
    automationName: cleanString(ctx.automationName),
    nodeId: cleanString(ctx.automationNodeId),
    idempotencyKey: cleanString(ctx.testActionIdempotencyKey),
    expiresAt: cleanString(ctx.testExpiresAt || ctx.test_expires_at)
  }
}

function addAppointmentTestWebhookHeaders(headers, testContext) {
  if (!testContext) return
  headers['X-Ristak-Test-Mode'] = 'true'
  headers['X-Ristak-Test-Run-Id'] = testContext.testRunId
  headers['X-Ristak-Test-Effect-Id'] = testContext.testEffectId
  headers['X-Ristak-Test-Appointment-Id'] = testContext.appointmentId
  headers['X-Ristak-Test-Event-Type'] = testContext.eventType
  if (testContext.idempotencyKey) {
    headers['X-Ristak-Test-Idempotency-Key'] = testContext.idempotencyKey
    if (!hasWebhookHeader(headers, 'idempotency-key')) {
      headers['Idempotency-Key'] = testContext.idempotencyKey
    }
  }
}

function addAppointmentTestWebhookPayload(body, testContext) {
  if (!testContext) return body
  let originalPayload = null
  if (body.text) {
    try {
      originalPayload = JSON.parse(body.text)
    } catch {
      originalPayload = body.text
    }
  }
  const payload = isPlainObject(originalPayload)
    ? { ...originalPayload }
    : originalPayload === null
      ? {}
      : { payload: originalPayload }
  payload.testMode = true
  payload.ristakTest = testContext
  return { text: JSON.stringify(payload), json: true }
}

function webhookBodyModeFromConfig(config = {}) {
  const mode = cleanString(config.bodyMode).toLowerCase()
  if (mode === 'fields' || mode === 'json') return mode
  const rawFields = config.bodyFields
  if (Array.isArray(rawFields) && rawFields.some((row) => cleanString(row?.key || row?.name))) return 'fields'
  if (isPlainObject(rawFields) && Object.keys(rawFields).some((key) => cleanString(key))) return 'fields'
  return str(config.body).trim() ? 'json' : 'fields'
}

function renderWebhookBodyValue(value, ctx) {
  return typeof value === 'string'
    ? renderTemplate(value, ctx, { preserveUnknown: true })
    : value ?? ''
}

function webhookBodyFieldsFromConfig(rawFields, ctx) {
  const body = {}
  if (Array.isArray(rawFields)) {
    rawFields.forEach((row) => {
      const key = cleanString(row?.key || row?.name)
      if (!key) return
      body[key] = renderWebhookBodyValue(row?.value, ctx)
    })
    return body
  }
  if (isPlainObject(rawFields)) {
    Object.entries(rawFields).forEach(([key, value]) => {
      if (!cleanString(key)) return
      body[key] = renderWebhookBodyValue(value, ctx)
    })
  }
  return body
}

function webhookBodyFromConfig(config = {}, ctx = {}) {
  if (webhookBodyModeFromConfig(config) === 'fields') {
    const body = webhookBodyFieldsFromConfig(config.bodyFields, ctx)
    if (!Object.keys(body).length) return { text: '', json: false }
    return { text: JSON.stringify(body), json: true }
  }
  const bodyText = renderTemplate(str(config.body), ctx, { preserveUnknown: true }).trim()
  return { text: bodyText, json: /^[\[{]/.test(bodyText) }
}

async function runWebhookRequestFromConfig(config = {}, ctx = {}) {
  const method = (str(config.method) || 'POST').toUpperCase()
  let url = renderTemplate(str(config.url), ctx, { preserveUnknown: true }).trim()
  const onError = str(config.onError) || 'continue'
  const timeoutMs = Math.max(1, Number(config.timeout) || 15) * 1000

  const fail = (detail, output) => ({
    handle: onError === 'branch' ? 'error' : 'out',
    stop: onError === 'stop',
    detail,
    output,
    outputBaseId: 'http_request'
  })

  if (!url) {
    return fail('Webhook no enviado: falta URL', {
      status: 'error',
      status_code: 0,
      respuesta: '',
      error: 'Falta URL'
    })
  }

  const testContext = webhookAppointmentTestContext(ctx)
  const headers = webhookHeadersFromConfig(config, ctx)
  addAppointmentTestWebhookHeaders(headers, testContext)
  let body = webhookBodyFromConfig(config, ctx)
  if (testContext && ['GET', 'HEAD'].includes(method)) {
    try {
      const parsedUrl = new URL(url)
      parsedUrl.searchParams.set('testMode', 'true')
      parsedUrl.searchParams.set('ristakTestEffectId', testContext.testEffectId)
      parsedUrl.searchParams.set('ristakTestRunId', testContext.testRunId)
      url = parsedUrl.toString()
    } catch {
      // La validación normal del fetch reportará una URL inválida. Nunca se
      // degrada a un request sin las cabeceras inequívocas de Modo test.
    }
  } else if (testContext) {
    body = addAppointmentTestWebhookPayload(body, testContext)
    deleteWebhookHeader(headers, 'content-length')
  }
  const init = { method, headers }
  if (!['GET', 'HEAD'].includes(method) && body.text) {
    init.body = body.text
    if (!hasWebhookHeader(headers, 'content-type') && body.json) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    const respuesta = responseBodyFromText(text)
    const output = {
      ...(isPlainObject(respuesta) ? respuesta : {}),
      status: response.ok ? 'ok' : 'error',
      status_code: response.status,
      respuesta
    }
    if (!response.ok) {
      return fail(`Webhook respondió ${response.status}`, output)
    }
    return {
      handle: 'out',
      detail: `Webhook enviado (${response.status})`,
      output,
      outputBaseId: 'http_request'
    }
  } catch (error) {
    return fail(`Webhook falló: ${error.message}`, {
      status: 'error',
      status_code: 0,
      respuesta: '',
      error: error.message
    })
  } finally {
    clearTimeout(timer)
  }
}

async function executeWebhookAction(node, ctx) {
  return runWebhookRequestFromConfig(node.config || {}, ctx)
}

export async function testWebhookAction(config = {}, ctx = {}) {
  const result = await runWebhookRequestFromConfig(config, ctx)
  return {
    ok: result.output?.status === 'ok',
    detail: result.detail || '',
    handle: result.handle || 'out',
    stop: Boolean(result.stop),
    output: result.output || {},
    testedAt: nowIso()
  }
}

async function findContactByLookup(searchBy, lookupValue) {
  const value = str(lookupValue).trim()
  if (!value) return null
  if (searchBy === 'phone') {
    return findContactByPhoneCandidates(value)
  }
  if (searchBy === 'email') {
    return db.get('SELECT * FROM contacts WHERE LOWER(email) = LOWER(?) LIMIT 1', [value])
  }
  if (searchBy === 'id') {
    return db.get('SELECT * FROM contacts WHERE id = ? LIMIT 1', [value])
  }
  return null
}

function defaultLookupValueFor(searchBy, ctx) {
  if (searchBy === 'phone') return ctx.contact?.phone || ''
  if (searchBy === 'email') return ctx.contact?.email || ''
  if (searchBy === 'id') return ctx.contact?.id || ''
  return ''
}

async function applyContactTags(contactId, tags) {
  const configured = Array.isArray(tags) ? tags.map(str).filter(Boolean) : []
  if (!contactId || configured.length === 0) return []
  const tagIds = await resolveTagIds(configured, { createMissing: true })
  const row = await db.get('SELECT tags FROM contacts WHERE id = ?', [contactId])
  const current = parseJson(row?.tags, [])
  const list = Array.isArray(current) ? current : []
  const next = [...new Set([...list, ...tagIds].filter(Boolean))]
  await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    JSON.stringify(next),
    contactId
  ])
  return next
}

async function upsertContactFromConfig(config, ctx, overrides = {}) {
  const rawFirstName = renderedConfigValue(overrides.firstName ?? config.firstName, ctx)
  const rawLastName = renderedConfigValue(overrides.lastName ?? config.lastName, ctx)
  const rawFullName = renderedConfigValue(overrides.fullName ?? config.fullName, ctx)
  const nameFields = normalizeContactNameFields({
    fullName: rawFullName,
    firstName: rawFirstName,
    lastName: rawLastName
  })
  const firstName = nameFields.firstName
  const lastName = nameFields.lastName
  const phone = renderedConfigValue(overrides.phone ?? config.phone, ctx)
  const email = renderedConfigValue(overrides.email ?? config.email, ctx)
  const source = renderedConfigValue(overrides.source ?? config.source, ctx)
  const fullName = nameFields.fullName || compactName(firstName, lastName, rawFullName)
  const customFields = {
    ...customFieldRowsToObject(config.customFields, ctx),
    ...objectFromCustomFields(overrides.customFields)
  }

  let contactId = str(overrides.id || config.contactId).trim()
  let existing = contactId ? await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]) : null
  if (!existing && phone) existing = await findContactByLookup('phone', phone)
  if (!existing && email) existing = await findContactByLookup('email', email)
  if (existing?.id) {
    contactId = existing.id
    existing = await db.get('SELECT * FROM contacts WHERE id = ?', [contactId])
  }
  if (!contactId) contactId = generateContactId()

  const preparedPhone = await prepareContactPhoneUpsert({ contactId, phone })
  const resolvedPhone = preparedPhone.phone || null
  const existingCustom = objectFromCustomFields(existing?.custom_fields)
  const nextCustom = { ...existingCustom, ...customFields }
  const assignedUser = str(config.assignedUser)
  if (assignedUser) {
    nextCustom.assignedUser = assignedUser
    if (str(config.assignedUserName)) nextCustom.assignedUserName = str(config.assignedUserName)
  }
  const customJson = JSON.stringify(nextCustom)
  const customFieldsPlaceholder = process.env.DATABASE_URL ? '?::jsonb' : '?'

  if (existing) {
    await db.run(
      `UPDATE contacts
       SET phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           full_name = COALESCE(?, full_name),
           first_name = COALESCE(?, first_name),
           last_name = COALESCE(?, last_name),
           source = COALESCE(?, source),
           custom_fields = ${customFieldsPlaceholder},
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        resolvedPhone,
        email || null,
        fullName || null,
        firstName || null,
        lastName || null,
        source || null,
        customJson,
        contactId
      ]
    )
  } else {
    await db.run(
      `INSERT INTO contacts
       (id, phone, email, full_name, first_name, last_name, source, custom_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${customFieldsPlaceholder}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        contactId,
        resolvedPhone,
        email || null,
        fullName || null,
        firstName || null,
        lastName || null,
        source || null,
        customJson
      ]
    )
  }

  contactId = await finalizePreparedPhoneUpsert(preparedPhone, contactId)
  await applyContactTags(contactId, config.tags)
  ctx.contact = await loadContact(contactId, ctx.contact || {})
  return ctx.contact
}

async function executeCreateContact(node, ctx) {
  const contact = await upsertContactFromConfig(node.config || {}, ctx)
  const detail = contact.fullName || contact.phone || contact.email
    ? `Contacto listo: ${contact.fullName || contact.phone || contact.email}`
    : 'Contacto creado'
  return {
    handle: 'out',
    detail,
    output: contactAutomationOutput(contact),
    outputBaseId: 'contacto'
  }
}

async function executeFindContact(node, ctx) {
  const config = node.config || {}
  const searchBy = str(config.searchBy) || 'phone'
  const lookupValue = renderedConfigValue(config.lookupValue || defaultLookupValueFor(searchBy, ctx), ctx)
  const found = await findContactByLookup(searchBy, lookupValue)
  if (found?.id) {
    ctx.contact = await loadContact(found.id, ctx.contact || {})
    return {
      handle: 'out',
      detail: `Contacto encontrado: ${ctx.contact.fullName || ctx.contact.phone || ctx.contact.email || ctx.contact.id}`,
      output: contactAutomationOutput(ctx.contact),
      outputBaseId: 'contacto'
    }
  }

  const notFound = str(config.notFound) || 'continue'
  if (notFound === 'branch') {
    return { handle: 'notfound', detail: 'Contacto no encontrado' }
  }
  if (notFound === 'stop') {
    return { stop: true, handle: 'stop', detail: 'Contacto no encontrado: automatización detenida' }
  }
  if (notFound === 'create') {
    const overrides = searchBy === 'phone'
      ? { phone: lookupValue }
      : searchBy === 'email'
        ? { email: lookupValue }
        : searchBy === 'id'
          ? { id: lookupValue }
          : {}
    const contact = await upsertContactFromConfig({}, ctx, overrides)
    return {
      handle: 'out',
      detail: `Contacto creado: ${contact.fullName || contact.phone || contact.email || contact.id}`,
      output: contactAutomationOutput(contact),
      outputBaseId: 'contacto'
    }
  }
  return { handle: 'out', detail: 'Contacto no encontrado: continúa sin cambiar contacto' }
}

async function applyContactWhatsAppNumberAction(node, ctx) {
  const config = node.config || {}
  const contactId = cleanString(ctx.contact?.id)
  if (!contactId) {
    return {
      handle: 'out',
      detail: 'Número de WhatsApp no cambiado (sin contacto)',
      output: { estado_actualizacion: 'sin_contacto' },
      outputBaseId: 'contacto_actualizado'
    }
  }

  const targetPhoneNumberId = cleanString(config.phoneNumberId || config.whatsappPhoneNumberId || config.targetPhoneNumberId)
  if (!targetPhoneNumberId) {
    return {
      handle: 'out',
      detail: 'Número de WhatsApp no cambiado (falta seleccionar número)',
      output: { ...contactAutomationOutput(ctx.contact), estado_actualizacion: 'sin_numero' },
      outputBaseId: 'contacto_actualizado'
    }
  }

  const targetPhone = await loadWhatsAppPhoneSnapshot(targetPhoneNumberId)
  if (!targetPhone?.id) throw new Error('Ese número de WhatsApp no está conectado')

  const contactRow = await db.get(
    'SELECT id, preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?',
    [contactId]
  )
  if (!contactRow?.id) throw new Error('Contacto no encontrado')

  const previousPhoneNumberId = cleanString(contactRow.preferred_whatsapp_phone_number_id)
  const targetLabel = whatsappPhoneLabel(targetPhone)
  if (previousPhoneNumberId === targetPhoneNumberId) {
    ctx.contact = await loadContact(contactId, ctx.contact)
    return {
      handle: 'out',
      detail: `El contacto ya usa ${targetLabel || targetPhoneNumberId}`,
      output: { ...contactAutomationOutput(ctx.contact), estado_actualizacion: 'sin_cambios' },
      outputBaseId: 'contacto_actualizado'
    }
  }

  await db.run(
    'UPDATE contacts SET preferred_whatsapp_phone_number_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [targetPhoneNumberId, contactId]
  )
  await db.run(`
    INSERT INTO whatsapp_routing_events (id, contact_id, previous_phone_number_id, new_phone_number_id, reason, source)
    VALUES (?, ?, ?, ?, ?, 'automation')
  `, [
    createRistakId('whatsapp_routing_event'),
    contactId,
    previousPhoneNumberId || null,
    targetPhoneNumberId,
    renderedConfigValue(config.reason || config.routingReason || 'Cambio desde automatización', ctx)
  ]).catch((error) => {
    logger.warn(`[Automatizaciones] No se pudo registrar cambio de número de ${contactId}: ${error.message}`)
  })

  ctx.contact = await loadContact(contactId, ctx.contact)
  // (AUTO-008) Propaga profundidad de cascada para acotar re-disparos en cadena.
  const nextCascadeDepthNumber = (Number(ctx.__cascadeDepth) || 0) + 1
  setImmediate(() => {
    handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: ['preferredWhatsAppPhoneNumberId', 'preferred_whatsapp_phone_number_id'],
      previousPhoneNumberId: previousPhoneNumberId || null,
      newPhoneNumberId: targetPhoneNumberId,
      contactChangeSource: 'automation',
      __cascadeDepth: nextCascadeDepthNumber
    }).catch(() => undefined)
  })
  return {
    handle: 'out',
    detail: `Número de WhatsApp cambiado a ${targetLabel || targetPhoneNumberId}`,
    output: { ...contactAutomationOutput(ctx.contact), estado_actualizacion: 'actualizado' },
    outputBaseId: 'contacto_actualizado'
  }
}

async function applyContactUserAction(node, ctx) {
  if (!ctx.contact?.id) return 'Usuario no modificado (sin contacto)'
  const config = node.config || {}
  const remove = node.type === 'action-unassign-user' || str(config.userAction) === 'unassign'
  const userId = str(config.user)
  if (!remove && !userId) return 'Usuario no asignado (falta seleccionar usuario)'

  const row = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [ctx.contact.id])
  const customFields = objectFromCustomFields(row?.custom_fields)
  if (remove) {
    delete customFields.assignedUser
    delete customFields.assignedUserName
  } else {
    customFields.assignedUser = userId
    if (str(config.userName)) customFields.assignedUserName = str(config.userName)
  }
  await db.run(`UPDATE contacts SET custom_fields = ${process.env.DATABASE_URL ? '?::jsonb' : '?'}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    JSON.stringify(customFields),
    ctx.contact.id
  ])
  ctx.contact = await loadContact(ctx.contact.id, ctx.contact)
  // (AUTO-008) Propaga profundidad de cascada para acotar re-disparos en cadena.
  const nextCascadeDepthUser = (Number(ctx.__cascadeDepth) || 0) + 1
  setImmediate(() => {
    handleAutomationEvent('contact-updated', {
      contactId: ctx.contact.id,
      changedFields: ['assignedUser', 'assigned_user'],
      contactChangeSource: 'automation',
      __cascadeDepth: nextCascadeDepthUser
    }).catch(() => undefined)
  })
  return remove
    ? 'Usuario asignado eliminado'
    : `Usuario asignado: ${str(config.userName) || userId}`
}

function notificationClickUrl(config = {}, ctx = {}) {
  const action = str(config.clickAction) || 'phone_chat'
  const contactId = cleanString(renderedConfigValue(config.contactId, ctx) || ctx.contact?.id || '')
  const contactQuery = contactId ? `?contact=${encodeURIComponent(contactId)}` : ''
  const contactOpenQuery = contactId ? `?open=contact&id=${encodeURIComponent(contactId)}` : ''

  if (action === 'phone_contacts') return '/movil/contacts'
  if (action === 'desktop_contacts') return contactId ? `/contacts${contactOpenQuery}` : '/contacts'
  if (action === 'desktop_chat') return '/chat'
  if (action === 'custom_url') {
    const customUrl = cleanString(renderedConfigValue(config.customUrl, ctx))
    if (!customUrl) return '/movil'
    return customUrl.startsWith('/') ? customUrl : `/${customUrl}`
  }
  return `/movil${contactQuery}`
}

function notificationActionLabel(config = {}) {
  const labels = {
    phone_chat: 'Abrir chat',
    phone_contacts: 'Abrir contactos',
    desktop_contacts: 'Abrir contacto',
    desktop_chat: 'Abrir chat',
    custom_url: 'Abrir'
  }
  return labels[str(config.clickAction)] || 'Abrir'
}

function hasOwnConfigKey(config = {}, key = '') {
  return Object.prototype.hasOwnProperty.call(config, key)
}

function resolveNotificationDelivery(config = {}) {
  const hasModernDeliveryConfig = ['deliverToBell', 'deliverToPush', 'deliverToEmail']
    .some((key) => hasOwnConfigKey(config, key))

  return {
    bell: hasModernDeliveryConfig ? Boolean(config.deliverToBell) : true,
    push: hasModernDeliveryConfig ? Boolean(config.deliverToPush) : true,
    email: hasModernDeliveryConfig ? Boolean(config.deliverToEmail) : false
  }
}

async function resolveNotificationContact(config = {}, ctx = {}) {
  const contactId = cleanString(renderedConfigValue(config.contactId, ctx) || ctx.contact?.id || '')
  if (!contactId) return { contactId: '', contact: ctx.contact || null }
  if (ctx.contact?.id === contactId) return { contactId, contact: ctx.contact }
  return {
    contactId,
    contact: await loadContact(contactId, ctx.contact || {}).catch(() => null)
  }
}

function normalizeNotificationUserIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanString(item)).filter(Boolean))]
}

function isValidNotificationEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanString(value).toLowerCase())
}

async function getNotificationRecipientUsers({ broadcast = false, recipientUserIds = [] } = {}) {
  if (broadcast) {
    return db.all(`
      SELECT id, email, full_name, username
      FROM users
      WHERE is_active = 1
      ORDER BY id ASC
    `)
  }

  const ids = normalizeNotificationUserIds(recipientUserIds)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db.all(
    `SELECT id, email, full_name, username
       FROM users
      WHERE is_active = 1
        AND CAST(id AS TEXT) IN (${placeholders})
      ORDER BY id ASC`,
    ids
  )
}

function notificationEmailActionUrl(actionUrl = '') {
  const cleanUrl = cleanString(actionUrl)
  if (!cleanUrl) return ''
  if (/^https?:\/\//i.test(cleanUrl)) return cleanUrl

  const baseUrl = cleanString(
    process.env.PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    ''
  )
  if (!baseUrl) return cleanUrl

  try {
    return new URL(cleanUrl.startsWith('/') ? cleanUrl : `/${cleanUrl}`, baseUrl).toString()
  } catch {
    return cleanUrl
  }
}

function buildInternalNotificationEmailText({ title = '', message = '', actionUrl = '', actionLabel = 'Abrir' } = {}) {
  const lines = [
    cleanString(title) || 'Notificación de Ristak',
    '',
    cleanString(message),
    '',
    actionUrl ? `${cleanString(actionLabel) || 'Abrir'}: ${actionUrl}` : ''
  ].filter((line, index, array) => line || (index > 0 && array[index - 1]))

  return lines.join('\n').trim()
}

async function sendInternalNotificationEmails({
  broadcast = false,
  recipientUserIds = [],
  title = '',
  message = '',
  actionUrl = '',
  actionLabel = 'Abrir'
} = {}) {
  const users = await getNotificationRecipientUsers({ broadcast, recipientUserIds })
  const recipients = users
    .map((user) => ({
      id: cleanString(user.id),
      email: cleanString(user.email).toLowerCase(),
      name: cleanString(user.full_name || user.username)
    }))
    .filter((user) => isValidNotificationEmail(user.email))

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, skipped: true, reason: 'missing_email_recipients' }
  }

  const { sendEmail } = await import('./emailService.js')
  const resolvedActionUrl = notificationEmailActionUrl(actionUrl)
  const subject = cleanString(title) || 'Notificación de Ristak'
  const text = buildInternalNotificationEmailText({
    title: subject,
    message,
    actionUrl: resolvedActionUrl,
    actionLabel
  })
  let sent = 0
  let failed = 0
  let firstError = ''

  for (const recipient of recipients) {
    try {
      await sendEmail({
        to: recipient.email,
        subject,
        text,
        includeSignature: false
      })
      sent += 1
    } catch (error) {
      failed += 1
      if (!firstError) firstError = error.message || 'Error enviando correo interno'
      logger.warn(`[Automatizaciones] No se pudo enviar correo interno a ${recipient.id || recipient.email}: ${error.message}`)
      if (error?.status === 409) break
    }
  }

  return {
    sent,
    failed,
    skipped: sent === 0,
    reason: sent === 0 ? (firstError || 'email_error') : ''
  }
}

function summarizeNotificationChannelResult(label, enabled, count, skippedReason = '') {
  if (!enabled) return ''
  if (count > 0) return `${label}: ${count}`
  return `${label}: omitido${skippedReason ? ` (${skippedReason})` : ''}`
}

async function executeSystemNotification(node, ctx, enrollment) {
  const config = node.config || {}
  const recipientMode = str(config.recipientMode) || 'all'
  const delivery = resolveNotificationDelivery(config)
  const { contactId, contact } = await resolveNotificationContact(config, ctx)
  const title = renderedConfigValue(config.pushTitle || config.title, ctx).slice(0, 120)
  const message = renderedConfigValue(config.pushBody || config.body, ctx).slice(0, 700)
  const actionUrl = notificationClickUrl(config, ctx)
  const recipientUserIds = []
  let broadcast = false

  if (recipientMode === 'all') {
    broadcast = true
  } else if (recipientMode === 'assigned_user') {
    const assignedUserId = cleanString(
      contact?.assignedUser ||
      contact?.assigned_user ||
      contact?.customFields?.assignedUser
    )
    if (assignedUserId) recipientUserIds.push(assignedUserId)
  } else if (recipientMode === 'specific_user') {
    const userId = cleanString(config.user || config.userId)
    if (userId) recipientUserIds.push(userId)
  }

  if (!broadcast && recipientUserIds.length === 0) {
    return {
      handle: 'out',
      detail: recipientMode === 'assigned_user'
        ? 'Notificación omitida: el contacto no tiene usuario asignado'
        : 'Notificación omitida: no hay destinatario interno'
    }
  }

  if (!delivery.bell && !delivery.push && !delivery.email) {
    return {
      handle: 'out',
      detail: 'Notificación omitida: no hay canales seleccionados'
    }
  }

  const actionLabel = notificationActionLabel(config)
  const result = delivery.bell || delivery.push
    ? await createInternalNotification({
        broadcast,
        recipientUserIds,
        source: 'Automatizaciones',
        severity: 'info',
        title: title || 'Notificación interna',
        message,
        actionUrl,
        actionLabel,
        category: 'automation',
        contactId,
        automationId: enrollment?.automationId || ctx.automationId || '',
        automationNodeId: node.id,
        enrollmentId: enrollment?.id || '',
        metadata: {
          nodeLabel: nodeLabel(node),
          automationName: ctx.automationName || ''
        },
        pushTitle: title,
        pushBody: message,
        createBellNotification: delivery.bell,
        sendPushNotification: delivery.push
      })
    : {
        created: 0,
        ids: [],
        push: { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'disabled' }
      }
  const email = delivery.email
    ? await sendInternalNotificationEmails({
        broadcast,
        recipientUserIds,
        title: title || 'Notificación interna',
        message,
        actionUrl,
        actionLabel
      }).catch((error) => {
        logger.warn(`[Automatizaciones] No se pudo preparar correo interno: ${error.message}`)
        return { sent: 0, failed: 1, skipped: true, reason: 'email_error' }
      })
    : { sent: 0, failed: 0, skipped: true, reason: 'disabled' }

  const detailParts = [
    summarizeNotificationChannelResult('campanita', delivery.bell, result.created),
    summarizeNotificationChannelResult('push', delivery.push, result.push?.sent || 0, result.push?.reason || ''),
    summarizeNotificationChannelResult('correo', delivery.email, email.sent || 0, email.reason || '')
  ].filter(Boolean)
  const deliveredCount = Number(result.created || 0) + Number(result.push?.sent || 0) + Number(email.sent || 0)

  return {
    handle: 'out',
    detail: `${broadcast ? 'Notificación para todos' : `Notificación para ${recipientUserIds.length} usuario${recipientUserIds.length === 1 ? '' : 's'}`} · ${detailParts.join(' · ')}`,
    output: {
      estado: deliveredCount > 0 ? 'enviada' : 'omitida',
      destinatarios: broadcast ? 'todos' : recipientUserIds.join(', '),
      titulo: title,
      url: actionUrl,
      campanita_creadas: result.created || 0,
      push_enviados: result.push?.sent || 0,
      push_web_enviados: result.push?.webSent || 0,
      push_nativos_enviados: result.push?.nativeSent || 0,
      correos_enviados: email.sent || 0
    },
    outputBaseId: 'notificacion'
  }
}

/** Resuelve tanto URLs-proxy legacy como la URL pública CDN de un asset Ristak. */
export async function resolveAutomationMediaAssetId(mediaUrl = '') {
  const cleanMediaUrl = str(mediaUrl)
  const { extractMediaAssetIdFromUrl, findMediaAssetsByPublicUrls } = await import('./mediaStorageService.js')
  let mediaAssetId = extractMediaAssetIdFromUrl(cleanMediaUrl)
  // Los assets nuevos se guardan con la URL pública del CDN. Esa URL no contiene
  // /media/assets/:id, así que antes se trataba como un link externo y WhatsApp
  // recibía el WebP tal cual. Resolverla contra el asset permite usar su contenido
  // y el conversor JPEG que ya usamos para los chats normales.
  if (!mediaAssetId && cleanMediaUrl) {
    const [mediaAsset] = await findMediaAssetsByPublicUrls([cleanMediaUrl])
    mediaAssetId = mediaAsset?.id || ''
  }
  return mediaAssetId
}

/**
 * Lee un adjunto administrado por Ristak como data URL. Así WhatsApp, Messenger
 * e Instagram pueden aplicar la misma normalización que el chat directo antes
 * de entregarlo al proveedor. Las URLs externas se conservan como links.
 */
export async function resolveAutomationMediaSource(mediaUrl = '') {
  const cleanMediaUrl = str(mediaUrl)
  const mediaAssetId = await resolveAutomationMediaAssetId(cleanMediaUrl)
  if (mediaAssetId) {
    const { getMediaAsset, getMediaAssetDataUrl } = await import('./mediaStorageService.js')
    const [media, asset] = await Promise.all([
      getMediaAssetDataUrl(mediaAssetId),
      getMediaAsset(mediaAssetId)
    ])
    return {
      dataUrl: media.dataUrl,
      externalUrl: '',
      publicUrl: str(asset.publicUrl),
      mimeType: media.mimeType,
      filename: media.filename || '',
      mediaAssetId
    }
  }

  const assetMatch = /\/api\/automations\/assets\/([\w-]+)/.exec(cleanMediaUrl)
  if (assetMatch) {
    const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetMatch[1]])
    if (!row) throw new Error('El archivo adjunto ya no existe')
    return {
      dataUrl: `data:${row.content_type};base64,${row.content_base64}`,
      externalUrl: '',
      publicUrl: '',
      mimeType: row.content_type || '',
      filename: row.filename || '',
      mediaAssetId: ''
    }
  }

  return {
    dataUrl: '',
    externalUrl: cleanMediaUrl,
    publicUrl: '',
    mimeType: '',
    filename: '',
    mediaAssetId: ''
  }
}

/**
 * Los assets propios de audio usan su URL pública ya normalizada. Los assets
 * legacy sin URL conservan el data URL para que el servicio los publique antes
 * de enviar; una URL externa permanece como enlace.
 */
export function resolveAutomationAudioDelivery({
  dataUrl = '',
  externalUrl = '',
  publicUrl = '',
  publicUrlVerified = false
} = {}) {
  const candidatePublicUrl = str(publicUrl)
  const stablePublicUrl = publicUrlVerified && /^https:\/\//i.test(candidatePublicUrl)
    ? candidatePublicUrl
    : ''
  const remoteUrl = str(externalUrl)
  return {
    // Conserva también los bytes del asset administrado. YCloud necesita
    // subir la nota como Media ID con `audio/ogg` base: su importador de links
    // puede reclasificar el mismo OGG/Opus como application/octet-stream.
    // Meta Direct y QR todavía pueden reutilizar la URL pública verificada.
    audioDataUrl: str(dataUrl) || undefined,
    audioUrl: stablePublicUrl || remoteUrl || undefined
  }
}

export function resolveAutomationVoicePublicUrl({
  publicUrl = '',
  publicUrlVerified = false,
  mediaAssetId = '',
  ctx = {}
} = {}) {
  const assetId = str(mediaAssetId)
  if (!publicUrlVerified || !assetId) return str(publicUrl)

  // Meta valida en conjunto bytes, MIME, extensión de URL y filename. Todos
  // los assets de voz administrados pasan por esta ruta, aunque su MIME ya
  // incluya codecs=opus, para que un nombre original .mp3 jamás contradiga al
  // OGG convertido durante el procesamiento asíncrono.
  return publicAutomationMediaUrl(
    `/media/assets/${encodeURIComponent(assetId)}/voice.ogg`,
    ctx
  )
}

export function inferAutomationDownloadedAudioMimeType({ mimeType = '', url = '', buffer = null } = {}) {
  const declared = str(mimeType).toLowerCase().split(';')[0].trim()
  if (/^audio\//.test(declared) || declared === 'video/mp4') return declared

  let extension = ''
  try {
    extension = new URL(str(url)).pathname.split('.').pop()?.toLowerCase() || ''
  } catch {
    extension = str(url).split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || ''
  }
  const byExtension = {
    aac: 'audio/aac',
    amr: 'audio/amr',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    wave: 'audio/wav',
    webm: 'audio/webm'
  }
  if (byExtension[extension]) return byExtension[extension]

  if (Buffer.isBuffer(buffer)) {
    if (buffer.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
    if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav'
    if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg'
    if (buffer.subarray(0, 5).toString('latin1') === '#!AMR') return 'audio/amr'
    if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4'
    if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm'
  }

  throw new Error('El enlace no declara un formato de audio reconocible. Usa MP3, M4A, AAC, AMR, OGG/Opus, WAV o WebM.')
}

/** Envía un bloque adjunto: si es un archivo subido a Ristak se manda como
    data URL (el servicio de WhatsApp lo publica); si es URL externa, directo */
async function sendMediaBlock({ block, to, phoneNumberId, fromPhone, transport = 'api', allowQrFallback = true, ctx }) {
  const {
    isWhatsAppRegularAudioCompatible,
    isValidWhatsAppVoiceNoteBuffer,
    sendWhatsAppApiImageMessage,
    sendWhatsAppApiVideoMessage,
    sendWhatsAppApiAudioMessage,
    sendWhatsAppApiDocumentMessage
  } = await import('./whatsappApiService.js')

  const caption = renderTemplate(str(block.caption), ctx, { preserveUnknown: true }).trim() || undefined
  let dataUrl = null
  let externalUrl = null
  let filename = str(block.caption) || 'archivo'
  let mimeType

  const mediaUrl = str(block.url)
  const media = await resolveAutomationMediaSource(mediaUrl)
  dataUrl = media.dataUrl || null
  externalUrl = media.externalUrl || null
  mimeType = media.mimeType || undefined
  filename = media.filename || filename

  if (block.type === 'image') {
    return sendWhatsAppApiImageMessage({ to, from: fromPhone, imageDataUrl: dataUrl || undefined, imageUrl: externalUrl || undefined, caption, contactId: ctx.contact?.id, phoneNumberId, transport, allowQrFallback })
  } else if (block.type === 'video') {
    return sendWhatsAppApiVideoMessage({ to, from: fromPhone, videoDataUrl: dataUrl || undefined, videoUrl: externalUrl || undefined, caption, contactId: ctx.contact?.id, phoneNumberId, transport, allowQrFallback })
  } else if (block.type === 'audio' || block.type === 'voice') {
    const isVoiceNote = block.type === 'voice' || block.voiceNote !== false
    if (externalUrl && !dataUrl) {
      const { downloadSafeOutboundMediaUrl } = await import('./outboundMediaReferenceService.js')
      const downloaded = await downloadSafeOutboundMediaUrl(externalUrl, {
        maxBytes: 16 * 1024 * 1024
      })
      const downloadedMimeType = inferAutomationDownloadedAudioMimeType({
        mimeType: downloaded.mimeType,
        url: downloaded.url || externalUrl,
        buffer: downloaded.buffer
      })
      dataUrl = `data:${downloadedMimeType};base64,${downloaded.buffer.toString('base64')}`
      externalUrl = null
      mimeType = downloadedMimeType
    }
    let publicUrlVerified = false
    let voiceDeliveryPublicUrl = str(media.publicUrl)
    if (media.publicUrl && dataUrl) {
      try {
        const encodedAudio = str(dataUrl).slice(str(dataUrl).indexOf(',') + 1)
        const audioBuffer = Buffer.from(encodedAudio, 'base64')
        if (isVoiceNote) {
          publicUrlVerified = isValidWhatsAppVoiceNoteBuffer(audioBuffer)
          voiceDeliveryPublicUrl = resolveAutomationVoicePublicUrl({
            publicUrl: media.publicUrl,
            publicUrlVerified,
            mediaAssetId: media.mediaAssetId,
            ctx
          })
        } else {
          // Un bloque "Audio" no es PTT: conserva la URL y el formato que el
          // usuario subió, sin convertirlo ni pasarlo por el proxy de voz.
          publicUrlVerified = isWhatsAppRegularAudioCompatible({
            mimeType: media.mimeType,
            buffer: audioBuffer
          })
        }
      } catch {
        publicUrlVerified = false
      }
    }
    // Un asset propio ya está normalizado y publicado por Ristak, así que se
    // entrega por su URL estable sólo después de validar sus bytes. Si storage
    // conservó un MP3/M4A porque una compresión vieja falló, se fuerza la
    // conversión/publicación antes de marcarlo como nota de voz.
    const audioDelivery = resolveAutomationAudioDelivery({
      dataUrl,
      externalUrl,
      publicUrl: voiceDeliveryPublicUrl,
      publicUrlVerified
    })
    return sendWhatsAppApiAudioMessage({
      to,
      from: fromPhone,
      ...audioDelivery,
      // Los bloques nuevos son explícitos. Los flujos viejos guardaban "audio"
      // como nota de voz por default; conservamos ese comportamiento.
      voice: isVoiceNote,
      contactId: ctx.contact?.id,
      phoneNumberId,
      transport,
      allowQrFallback
    })
  } else {
    return sendWhatsAppApiDocumentMessage({
      to,
      from: fromPhone,
      documentDataUrl: dataUrl || undefined,
      documentUrl: externalUrl || undefined,
      filename,
      mimeType,
      caption,
      contactId: ctx.contact?.id,
      phoneNumberId,
      transport,
      allowQrFallback
    })
  }
}

function whatsappTransportFromResult(result) {
  const transport = typeof result === 'string' ? result : result?.transport
  return cleanString(transport).toLowerCase() === 'qr' ? 'qr' : 'api'
}

function whatsappTransportLabel(transports = []) {
  const unique = [...new Set(transports.map(whatsappTransportFromResult))]
  if (unique.length === 1) return unique[0] === 'qr' ? 'QR' : 'WhatsApp API'
  if (unique.includes('api') && unique.includes('qr')) return 'WhatsApp API y QR'
  return 'WhatsApp API'
}

async function sendWhatsAppAutomationMessage({ send, phoneNumberId, fromPhone }) {
  // La capa oficial clasifica el error y sólo ella puede autorizar el respaldo
  // asociado al mismo número. El flag viejo sendViaQr ya no decide el canal:
  // QR-only usa QR, API-only usa API y API+QR intenta API una sola vez antes
  // de recurrir al QR gemelo por indisponibilidad real.
  return send({ phoneNumberId, fromPhone, transport: 'api', allowQrFallback: true })
}

async function sendWhatsAppBlocks(node, ctx) {
  const {
    resolveWhatsAppOutboundRoute,
    sendWhatsAppApiInteractiveMessage,
    sendWhatsAppApiTextMessage,
    sendWhatsAppApiTemplateMessage
  } = await import('./whatsappApiService.js')
  const config = node.config || {}
  const to = ctx.contact?.phone
  if (!to) throw new Error('El contacto no tiene teléfono')

  // Remitente: último número donde escribió > principal > específico
  let phoneNumberId
  if (str(config.sender) === 'specific' && str(config.senderNumberId)) {
    phoneNumberId = str(config.senderNumberId)
  } else if (str(config.sender) !== 'default' && ctx.businessPhoneNumberId) {
    phoneNumberId = ctx.businessPhoneNumberId
  }

  const route = await resolveWhatsAppOutboundRoute({ phoneNumberId })
  if (!route.available) throw new Error('No hay un número de WhatsApp conectado para esta automatización')
  phoneNumberId = route.phoneNumberId || phoneNumberId
  let fromPhone = route.fromPhone || undefined

  if (str(config.messageType) === 'template') {
    const {
      buildDefaultMessageTemplateSendComponents
    } = await import('./messageTemplatesService.js')
    const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
    const sequence = blocks.filter((block) => block.type === 'template' || block.type === 'delay')
    // Compatibilidad: configs viejas con un solo templateId suelto
    if (!sequence.some((block) => block.type === 'template') && str(config.templateId)) {
      sequence.push({ type: 'template', templateId: str(config.templateId), templateName: str(config.templateName) })
    }
    const sentNames = []
    for (const block of sequence) {
      if (block.type === 'delay') {
        const seconds = Math.min(
          MAX_INLINE_DELAY_SECONDS,
          Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
        )
        if (seconds > 0) await sleep(seconds * 1000)
      } else if (str(block.templateId) || str(block.templateName)) {
        const extraVariables = buildVariableMap(ctx)
        const components = await buildDefaultMessageTemplateSendComponents({
          templateId: str(block.templateId),
          templateName: str(block.templateName),
          language: str(block.language || config.language),
          variableOptions: {
            contactId: ctx.contact?.id,
            phone: to,
            userId: ctx.userId,
            publicBaseUrl: ctx.publicBaseUrl,
            extraVariables
          }
        })

        await sendWhatsAppApiTemplateMessage({
          to,
          templateId: str(block.templateId) || undefined,
          templateName: str(block.templateName) || undefined,
          language: str(block.language || config.language) || undefined,
          ...(components.length ? { components } : {}),
          contactId: ctx.contact?.id,
          publicBaseUrl: ctx.publicBaseUrl,
          extraVariables,
          phoneNumberId,
          allowQrFallback: true
        })
        sentNames.push(str(block.templateName) || str(block.templateId))
      }
    }
    if (sentNames.length === 0) throw new Error('No hay plantilla seleccionada')
    return {
      detail: sentNames.length === 1
        ? `Plantilla "${sentNames[0]}" enviada`
        : `${sentNames.length} plantillas enviadas (${sentNames.join(', ')})`
    }
  }

  const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  let sent = 0
  const notes = []
  const transports = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(str(block.compiledText), ctx, { preserveUnknown: true }).trim()
      if (!text) continue
      const buttons = normalizeMessageButtons(block.buttons)
      const branchButtons = buttons.filter(button => button.action !== 'url')
      const urlButtons = buttons.filter(button => button.action === 'url')
      if (branchButtons.length && urlButtons.length) {
        throw new Error('WhatsApp no permite mezclar botones de salida y botones de URL en el mismo globo')
      }
      if (urlButtons.length > 1) {
        throw new Error('WhatsApp permite un solo botón de URL por globo')
      }

      if (branchButtons.length) {
        const response = await sendWhatsAppAutomationMessage({
          phoneNumberId,
          fromPhone,
          send: ({ phoneNumberId: nextPhoneNumberId, fromPhone: nextFromPhone, transport, allowQrFallback: nextAllowQrFallback }) => sendWhatsAppApiInteractiveMessage({
            to,
            from: nextFromPhone,
            body: text,
            buttons: branchButtons.map(button => ({ id: button.id, title: button.label })),
            contactId: ctx.contact?.id,
            phoneNumberId: nextPhoneNumberId,
            transport,
            allowQrFallback: nextAllowQrFallback
          })
        })
        transports.push(whatsappTransportFromResult(response))
        sent += 1
        return {
          detail: `${sent} mensaje${sent > 1 ? 's' : ''} de WhatsApp enviado${sent > 1 ? 's' : ''} por ${whatsappTransportLabel(transports)}; esperando botón`,
          waitForButtons: branchButtons.map(button => ({ id: button.id, label: button.label }))
        }
      }

      if (urlButtons.length) {
        const response = await sendWhatsAppAutomationMessage({
          phoneNumberId,
          fromPhone,
          send: ({ phoneNumberId: nextPhoneNumberId, fromPhone: nextFromPhone, transport, allowQrFallback: nextAllowQrFallback }) => sendWhatsAppApiInteractiveMessage({
            to,
            from: nextFromPhone,
            body: text,
            urlButton: { title: urlButtons[0].label, url: urlButtons[0].url },
            contactId: ctx.contact?.id,
            phoneNumberId: nextPhoneNumberId,
            transport,
            allowQrFallback: nextAllowQrFallback
          })
        })
        transports.push(whatsappTransportFromResult(response))
      } else {
        const response = await sendWhatsAppAutomationMessage({
          phoneNumberId,
          fromPhone,
          send: ({ phoneNumberId: nextPhoneNumberId, fromPhone: nextFromPhone, transport, allowQrFallback: nextAllowQrFallback }) => sendWhatsAppApiTextMessage({
            to,
            from: nextFromPhone,
            text,
            contactId: ctx.contact?.id,
            phoneNumberId: nextPhoneNumberId,
            transport,
            allowQrFallback: nextAllowQrFallback
          })
        })
        transports.push(whatsappTransportFromResult(response))
      }
      sent += 1
    } else if (block.type === 'delay') {
      const seconds = Math.min(
        MAX_INLINE_DELAY_SECONDS,
        Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
      )
      if (seconds > 0) await sleep(seconds * 1000)
    } else if (['image', 'video', 'audio', 'voice', 'file'].includes(block.type) && str(block.url)) {
      const response = await sendWhatsAppAutomationMessage({
        phoneNumberId,
        fromPhone,
        send: ({ phoneNumberId: nextPhoneNumberId, fromPhone: nextFromPhone, transport, allowQrFallback: nextAllowQrFallback }) => sendMediaBlock({
          block,
          to,
          phoneNumberId: nextPhoneNumberId,
          fromPhone: nextFromPhone,
          transport,
          allowQrFallback: nextAllowQrFallback,
          ctx
        })
      })
      transports.push(whatsappTransportFromResult(response))
      sent += 1
      if (block.type === 'audio' || block.type === 'voice') {
        const caption = renderTemplate(str(block.caption), ctx, { preserveUnknown: true }).trim()
        if (caption) {
          const captionResponse = await sendWhatsAppAutomationMessage({
            phoneNumberId,
            fromPhone,
            send: ({ phoneNumberId: nextPhoneNumberId, fromPhone: nextFromPhone, transport, allowQrFallback: nextAllowQrFallback }) => sendWhatsAppApiTextMessage({
              to,
              from: nextFromPhone,
              text: caption,
              contactId: ctx.contact?.id,
              phoneNumberId: nextPhoneNumberId,
              transport,
              allowQrFallback: nextAllowQrFallback
            })
          })
          transports.push(whatsappTransportFromResult(captionResponse))
          sent += 1
        }
      }
    } else {
      notes.push(`adjunto "${block.type}" sin archivo: omitido`)
    }
  }
  if (sent === 0) throw new Error('El mensaje está vacío: configura texto o un adjunto multimedia')
  return {
    detail: `${sent} mensaje${sent > 1 ? 's' : ''} de WhatsApp enviado${sent > 1 ? 's' : ''} por ${whatsappTransportLabel(transports)}${notes.length ? ` (${notes.join(', ')})` : ''}`
  }
}

function publicAutomationMediaUrl(rawUrl, ctx = {}) {
  const mediaUrl = renderTemplate(str(rawUrl), ctx, { preserveUnknown: true }).trim()
  if (/^https:\/\//i.test(mediaUrl)) return mediaUrl

  const baseUrl = [
    ctx.publicBaseUrl,
    ctx.public_base_url,
    process.env.RENDER_EXTERNAL_URL,
    process.env.PUBLIC_URL,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL
  ].map(str).find((candidate) => /^https:\/\//i.test(candidate))

  if (!baseUrl || !mediaUrl) return mediaUrl
  try {
    return new URL(mediaUrl, baseUrl).toString()
  } catch {
    return mediaUrl
  }
}

export function buildMetaSocialAutomationExternalIdBase(node, ctx = {}, enrollment = {}) {
  const automationId = str(enrollment?.automationId || ctx?.automationId) || 'automation'
  const enrollmentId = str(enrollment?.id || ctx?.enrollmentId)
  return `${automationId}:${enrollmentId}:${node?.id || 'node'}`
}

async function sendMetaSocialBlocks(node, ctx, platform, enrollment = {}) {
  const {
    sendMetaSocialAttachmentMessage,
    sendMetaSocialAudioMessage,
    sendMetaSocialTextMessage
  } = await import('./metaSocialMessagingService.js')
  const config = node.config || {}
  const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  const sentMessages = []
  const notes = []
  // La inscripción, no el contacto ni el nodo por sí solos, define una ejecución
  // visible. Conservamos este ID durante los reintentos de ESA inscripción y lo
  // cambiamos cuando el contacto vuelve a entrar al flujo.
  const baseExternalId = buildMetaSocialAutomationExternalIdBase(node, ctx, enrollment)

  const nextExternalId = () => `${baseExternalId}:${sentMessages.length + 1}`

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(str(block.compiledText || block.text || block.message), ctx, { preserveUnknown: true }).trim()
      if (!text) continue
      await sendMetaSocialTextMessage({
        contactId: ctx.contact?.id,
        platform,
        message: text,
        externalId: nextExternalId()
      })
      sentMessages.push(text)
    } else if (block.type === 'delay') {
      const seconds = Math.min(
        MAX_INLINE_DELAY_SECONDS,
        Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
      )
      if (seconds > 0) await sleep(seconds * 1000)
    } else if (['image', 'video', 'audio', 'voice', 'file'].includes(block.type) && str(block.url)) {
      const renderedMediaUrl = renderTemplate(str(block.url), ctx, { preserveUnknown: true }).trim()
      const attachmentUrl = publicAutomationMediaUrl(renderedMediaUrl, ctx)
      const externalId = nextExternalId()
      const media = await resolveAutomationMediaSource(renderedMediaUrl)
      if (block.type === 'audio' || block.type === 'voice') {
        // Meta no tiene un equivalente a `ptt`. Su representación correcta de
        // una nota de voz es un attachment de audio. Si el archivo es nuestro,
        // lo entregamos como data URL para que use exactamente la misma tubería
        // del chat directo (preview M4A/AAC público y reproducible).
        await sendMetaSocialAudioMessage({
          contactId: ctx.contact?.id,
          platform,
          audioDataUrl: media.dataUrl || undefined,
          audioUrl: media.dataUrl ? undefined : attachmentUrl,
          audioMimeType: media.mimeType,
          filename: media.filename,
          voice: block.type === 'voice' || block.voiceNote !== false,
          externalId,
          publicBaseUrl: ctx.publicBaseUrl || ctx.public_base_url || ''
        })
      } else {
        await sendMetaSocialAttachmentMessage({
          contactId: ctx.contact?.id,
          platform,
          attachmentType: block.type,
          attachmentDataUrl: media.dataUrl || undefined,
          attachmentUrl: media.dataUrl ? undefined : attachmentUrl,
          mimeType: media.mimeType,
          filename: media.filename,
          externalId,
          publicBaseUrl: ctx.publicBaseUrl || ctx.public_base_url || ''
        })
      }
      sentMessages.push(block.type)

      // Meta no acepta captions dentro del payload de adjunto. Si el usuario
      // escribió uno, lo enviamos como un segundo mensaje deliberado; si no,
      // el adjunto queda perfectamente válido por sí solo.
      const caption = renderTemplate(str(block.caption), ctx, { preserveUnknown: true }).trim()
      if (caption) {
        await sendMetaSocialTextMessage({
          contactId: ctx.contact?.id,
          platform,
          message: caption,
          externalId: nextExternalId()
        })
        sentMessages.push(caption)
      }
    } else if (block.type) {
      notes.push(`bloque "${block.type}" sin soporte en ${platform}: omitido`)
    }
  }

  if (sentMessages.length === 0) {
    throw new Error(`El mensaje de ${platform === 'instagram' ? 'Instagram' : 'Messenger'} está vacío: configura texto o un adjunto multimedia`)
  }

  const label = platform === 'instagram' ? 'Instagram' : 'Messenger'
  return {
    detail: `${sentMessages.length} mensaje${sentMessages.length > 1 ? 's' : ''} de ${label} enviado${sentMessages.length > 1 ? 's' : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`
  }
}

async function sendEmailAutomationMessage(node, ctx) {
  const { sendEmailToContact } = await import('./emailService.js')
  const config = node.config || {}
  const subject = renderTemplate(str(config.subject), ctx, { preserveUnknown: true }).trim()
  const body = renderTemplate(str(config.body || config.message), ctx, { preserveUnknown: true }).trim()
  const html = renderTemplate(str(config.bodyHtml || config.html || config.messageHtml), ctx, { preserveUnknown: true }).trim()
  const to = renderTemplate(str(config.toEmail || config.to), ctx, { preserveUnknown: true }).trim()

  if (!subject) throw new Error('El correo necesita asunto')
  if (!body && !html) throw new Error('El correo necesita contenido')

  const result = await sendEmailToContact({
    contactId: ctx.contact?.id,
    to,
    subject,
    text: body,
    html: html || undefined,
    includeSignature: config.includeSignature !== false,
    externalId: makeId('automation_email')
  })

  return {
    detail: `Correo enviado a ${result.to || ctx.contact?.email || 'el contacto'}`,
    result,
    output: {
      id_mensaje: result.localMessageId || result.messageId || '',
      estado: result.status || 'sent',
      correo_destino: result.to || ctx.contact?.email || '',
      asunto: subject,
      fecha_envio: result.sentAt || nowIso()
    }
  }
}

function executeRandomizerNode(node) {
  const branches = Array.isArray(node.config?.branches) ? node.config.branches : []
  const normalized = branches
    .map((branch, index) => ({
      id: str(branch?.id) || `branch-${index + 1}`,
      label: str(branch?.label) || str(branch?.name) || `Rama ${index + 1}`,
      percent: Math.max(0, Number(branch?.percent) || 0)
    }))
    .filter((branch) => branch.id && branch.percent > 0)

  const total = normalized.reduce((sum, branch) => sum + branch.percent, 0)
  if (total <= 0) {
    return { handle: 'none', detail: 'Aleatorizador sin ramas válidas' }
  }

  const roll = Math.random() * total
  let cursor = 0
  for (const branch of normalized) {
    cursor += branch.percent
    if (roll < cursor) {
      return { handle: branch.id, detail: `Aleatorizador eligió ${branch.label}` }
    }
  }

  const fallback = normalized[normalized.length - 1]
  return { handle: fallback.id, detail: `Aleatorizador eligió ${fallback.label}` }
}

// (AUTO-006) Evalúa, con el estado ACTUAL del contacto, si el objetivo del nodo
// ya está cumplido. Sólo decide para los tipos que se pueden comprobar contra el
// estado actual (etiqueta, pago, cita). Para tipos puramente por evento
// (formulario/link/conversación/personalizado/ads/avanzado) devuelve null =
// "no evaluable inline": el flujo conserva el comportamiento anterior (continúa).
// Devuelve true (cumplido), false (no cumplido) o null (no evaluable aquí).
function evaluateGoalMet(config, ctx) {
  const goalType = str(config?.goalType)
  const contact = ctx.contact || {}
  switch (goalType) {
    case 'tag': {
      const tag = normalizeText(config.tag)
      if (!tag) return null
      const has = (contact.tagKeys || contact.tags || []).map(normalizeText).includes(tag)
      const operator = str(config.tagOperator) || 'has'
      return operator === 'not-has' || operator === 'nothas' ? !has : has
    }
    case 'payment': {
      const purchases = Number(contact.purchasesCount || contact.purchases_count || 0) || 0
      if (purchases <= 0) return false
      const amountOperator = str(config.amountOperator) || 'any'
      if (amountOperator === 'any') return true
      const amount = Number(String(config.amount ?? '').trim())
      if (!Number.isFinite(amount)) return true
      const totalPaid = Number(contact.totalPaid || contact.total_paid || 0) || 0
      if (amountOperator === 'gte' || amountOperator === 'gt') return totalPaid >= amount
      if (amountOperator === 'lte' || amountOperator === 'lt') return totalPaid <= amount
      if (amountOperator === 'eq') return totalPaid === amount
      return true
    }
    case 'appointment': {
      const status = str(config.appointmentStatus) || 'booked'
      if (status === 'attended' || status === 'showed' || status === 'completed') {
        return Number(contact.attendedAppointmentsCount || 0) > 0
      }
      return Number(contact.activeAppointmentsCount || 0) > 0
    }
    default:
      return null
  }
}

// Nodo de acción: responder un comentario a mitad de un flujo. Usa el
// ctx.commentId/ctx.platform del disparo de comentario y exige que la acción
// declarada coincida con esa plataforma.
// Qué adjuntos acepta Meta al responder un comentario, por tipo de respuesta y
// plataforma (verificado en la doc oficial): público FB = 1 imagen; público IG =
// solo texto; la respuesta privada INICIAL por comment_id también es solo texto.
// Una vez que la persona responde y existe una conversación normal, los nodos de
// Messenger/Instagram sí pueden mandar imagen, video y audio por recipient.id.
const COMMENT_MEDIA_BLOCKS = ['image', 'video', 'audio', 'voice', 'file']
const COMMENT_REPLY_TARGETS = {
  facebook_public_comment: {
    value: 'facebook_public_comment',
    label: 'responder comentario público en Facebook',
    eventPlatform: 'facebook',
    apiPlatform: 'messenger',
    replyType: 'public',
    allowedBlockTypes: new Set(['text', 'image'])
  },
  instagram_public_comment: {
    value: 'instagram_public_comment',
    label: 'responder comentario público en Instagram',
    eventPlatform: 'instagram',
    apiPlatform: 'instagram',
    replyType: 'public',
    allowedBlockTypes: new Set(['text'])
  },
  messenger_private_message: {
    value: 'messenger_private_message',
    label: 'enviar mensaje privado por Messenger',
    eventPlatform: 'facebook',
    apiPlatform: 'messenger',
    replyType: 'private',
    allowedBlockTypes: new Set(['text'])
  },
  instagram_private_message: {
    value: 'instagram_private_message',
    label: 'enviar mensaje privado por Instagram DM',
    eventPlatform: 'instagram',
    apiPlatform: 'instagram',
    replyType: 'private',
    allowedBlockTypes: new Set(['text'])
  }
}

function commentReplyTargetFromConfig(config, eventPlatform, fallbackReplyType = 'public') {
  const explicit = COMMENT_REPLY_TARGETS[str(config?.commentReplyTarget)]
  if (explicit) return explicit
  const replyType = str(config?.replyType).toLowerCase() === 'private' ? 'private' : fallbackReplyType
  if (eventPlatform === 'instagram') {
    return COMMENT_REPLY_TARGETS[replyType === 'private' ? 'instagram_private_message' : 'instagram_public_comment']
  }
  return COMMENT_REPLY_TARGETS[replyType === 'private' ? 'messenger_private_message' : 'facebook_public_comment']
}

function commentContentBlock(block, ctx) {
  if (block.type === 'text') {
    const text = renderTemplate(str(block.compiledText || block.text || block.message), ctx, { preserveUnknown: true }).trim()
    return text ? { kind: 'text', text, block } : null
  }
  if (COMMENT_MEDIA_BLOCKS.includes(block.type)) {
    const url = str(block.url)
    return url ? { kind: 'media', type: block.type === 'voice' ? 'audio' : block.type, url, block } : null
  }
  return null
}

async function sendCommentReplyFromNode(node, ctx, fallbackReplyType = 'public', enrollment = {}) {
  const config = node.config || {}
  const contactId = ctx.contact?.id
  if (!contactId) throw new Error('Falta el contacto para responder el comentario')
  if (!str(ctx.platform)) {
    throw new Error('La acción Responder comentario necesita venir de un disparador de comentario de Facebook o Instagram')
  }

  const eventPlatform = normalizeCommentEventPlatform(ctx.platform)
  const target = commentReplyTargetFromConfig(config, eventPlatform, fallbackReplyType)
  if (target.eventPlatform !== eventPlatform) {
    throw new Error(`La acción está configurada para ${target.label}, pero el comentario recibido fue de ${eventPlatform === 'instagram' ? 'Instagram' : 'Facebook'}`)
  }
  const platform = target.apiPlatform
  const replyType = target.replyType
  const rawBlocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  // Compatibilidad con configs viejas de texto plano.
  const blocks = rawBlocks.length
    ? rawBlocks
    : (str(config.message || config.text) ? [{ type: 'text', compiledText: config.message || config.text }] : [])
  const contentBlocks = blocks.map((block) => commentContentBlock(block, ctx)).filter(Boolean)
  if (replyType === 'private' && contentBlocks.length > 1) {
    throw new Error('Meta solo permite un mensaje privado inicial por comentario; deja un solo bloque con contenido')
  }

  const { sendMetaSocialCommentReply } = await import('./metaSocialMessagingService.js')
  const baseExternal = buildMetaSocialAutomationExternalIdBase(node, ctx, enrollment)

  let sent = 0
  let index = 0
  const skipped = []
  for (const content of contentBlocks) {
    index += 1
    const block = content.block
    if (content.kind === 'text') {
      await sendMetaSocialCommentReply({
        contactId, platform, message: content.text, replyType,
        commentId: str(ctx.commentId), postId: str(ctx.postId),
        externalId: `${baseExternal}:${index}`
      })
      sent += 1
    } else if (content.kind === 'media') {
      if (!target.allowedBlockTypes.has(content.type)) {
        if (replyType === 'private') {
          throw new Error('La respuesta privada inicial a un comentario solo admite texto. Cuando la persona responda, usa un paso normal de Messenger o Instagram para enviar multimedia')
        }
        skipped.push(content.type)
        continue
      }
      // El pie de foto solo se combina con la imagen en respuestas públicas de FB;
      // en DM el texto va en su propio bloque.
      const caption = target.value === 'facebook_public_comment' && block.caption
        ? renderTemplate(str(block.caption), ctx, { preserveUnknown: true }).trim()
        : ''
      const renderedMediaUrl = renderTemplate(str(content.url), ctx, { preserveUnknown: true }).trim()
      const attachmentUrl = publicAutomationMediaUrl(renderedMediaUrl, ctx)
      const media = await resolveAutomationMediaSource(renderedMediaUrl)
      await sendMetaSocialCommentReply({
        contactId, platform, replyType, message: caption,
        attachment: {
          type: content.type,
          dataUrl: media.dataUrl || undefined,
          url: media.dataUrl ? undefined : attachmentUrl,
          mimeType: media.mimeType,
          filename: media.filename
        },
        commentId: str(ctx.commentId), postId: str(ctx.postId),
        externalId: `${baseExternal}:${index}`,
        publicBaseUrl: ctx.publicBaseUrl || ctx.public_base_url || ''
      })
      sent += 1
    }
  }

  if (!sent) throw new Error('La respuesta al comentario no tiene contenido válido para este canal')
  const kind = replyType === 'public' ? 'pública' : 'por privado'
  const note = skipped.length
    ? ` (adjuntos no soportados aquí: ${[...new Set(skipped)].join(', ')})`
    : ''
  return { detail: `Respuesta ${kind} al comentario enviada (${target.label})${note}`, target }
}

/**
 * Ejecuta un nodo. Devuelve:
 *  { handle, detail }            → continuar por esa salida
 *  { wait: {kind, resumeAt}, detail } → pausar la inscripción
 *  { skipped: true, handle }     → paso no soportado, se registra y continúa
 */
async function executeNode(node, ctx, enrollment) {
  await assertAutomationNodeFeatureAccess(node)

  switch (node.type) {
    case 'channel-whatsapp': {
      const sendResult = await sendWhatsAppBlocks(node, ctx)
      const detail = sendResult?.detail || 'Mensaje de WhatsApp enviado'
      const output = {
        id_mensaje: '',
        estado: 'enviado',
        numero_destino: ctx.contact?.phone || '',
        fecha_envio: nowIso()
      }
      if (Array.isArray(sendResult?.waitForButtons) && sendResult.waitForButtons.length) {
        return {
          wait: {
            kind: WAIT_KIND_BUTTON_REPLY,
            resumeAt: null,
            context: {
              waitExpectedAction: 'button_reply',
              waitActionResource: node.id,
              waitActionResourceName: node.label || nodeLabel(node),
              waitActionChannel: 'whatsapp',
              waitButtons: sendResult.waitForButtons
            }
          },
          detail,
          output,
          outputBaseId: 'enviar_whatsapp'
        }
      }
      return {
        handle: 'out',
        detail,
        output,
        outputBaseId: 'enviar_whatsapp'
      }
    }

    case 'channel-messenger': {
      const sendResult = await sendMetaSocialBlocks(node, ctx, 'messenger', enrollment)
      return {
        handle: 'out',
        detail: sendResult.detail,
        output: {
          estado: 'enviado',
          canal: 'messenger',
          fecha_envio: nowIso()
        },
        outputBaseId: 'enviar_messenger'
      }
    }

    case 'channel-instagram': {
      const sendResult = await sendMetaSocialBlocks(node, ctx, 'instagram', enrollment)
      return {
        handle: 'out',
        detail: sendResult.detail,
        output: {
          estado: 'enviado',
          canal: 'instagram',
          fecha_envio: nowIso()
        },
        outputBaseId: 'enviar_instagram'
      }
    }

    case 'channel-comment-public-reply': {
      const sendResult = await sendCommentReplyFromNode(node, ctx, 'public', enrollment)
      const isPrivate = sendResult.target?.replyType === 'private'
      return {
        handle: 'out',
        detail: sendResult.detail,
        output: {
          estado: 'enviado',
          canal: isPrivate ? sendResult.target.apiPlatform : 'comentario_publico',
          fecha_envio: nowIso()
        },
        outputBaseId: isPrivate ? 'responder_comentario_privado' : 'responder_comentario_publico'
      }
    }

    case 'channel-comment-dm-reply': {
      const sendResult = await sendCommentReplyFromNode(node, ctx, 'private', enrollment)
      return {
        handle: 'out',
        detail: sendResult.detail,
        output: { estado: 'enviado', canal: 'comentario_privado', fecha_envio: nowIso() },
        outputBaseId: 'responder_comentario_privado'
      }
    }

    case 'channel-email': {
      const sendResult = await sendEmailAutomationMessage(node, ctx)
      return {
        handle: 'out',
        detail: sendResult.detail,
        output: sendResult.output,
        outputBaseId: 'enviar_correo'
      }
    }

    case 'logic-wait': {
      const config = node.config || {}
      const mode = str(config.mode)
      if (mode === 'duration') {
        const ms = (Number(config.amount) || 0) * (DURATION_MS[str(config.unit) || 'hours'] || DURATION_MS.hours)
        return {
          wait: { kind: 'duration', resumeAt: new Date(Date.now() + ms).toISOString() },
          detail: `Esperando ${config.amount} ${str(config.unit) || 'hours'}`
        }
      }
      if ((mode === 'datetime' || mode === 'until-datetime') && (str(config.untilDate) || str(config.untilDatetime))) {
        const until = str(config.untilDate) || str(config.untilDatetime)
        return {
          wait: { kind: 'duration', resumeAt: new Date(until).toISOString() },
          detail: `Esperando hasta ${until}`
        }
      }
      if (mode === 'reply') {
        const timeoutMs = config.timeoutEnabled
          ? (Number(config.timeoutAmount) || 0) * (DURATION_MS[str(config.timeoutUnit) || 'hours'] || DURATION_MS.hours)
          : 0
        const sourceId = str(config.replySourceNodeId || config.actionResource)
        const sourceName = str(config.replySourceName || config.actionResourceName)
        return {
          wait: {
            kind: WAIT_KIND_REPLY,
            resumeAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null,
            context: sourceId || sourceName
              ? {
                  waitExpectedAction: 'reply_message',
                  waitActionResource: sourceId,
                  waitActionResourceName: sourceName,
                  waitActionChannel: str(config.replyChannel)
                }
              : undefined
          },
          detail: sourceName ? `Esperando respuesta al mensaje "${sourceName}"` : 'Esperando la respuesta del contacto'
        }
      }
      if (mode === 'action') {
        const expectedAction = str(config.expectedAction) || 'click_link'
        if (expectedAction === 'reply_message' || expectedAction === 'reply-message') {
          const timeoutMs = config.timeoutEnabled
            ? (Number(config.timeoutAmount) || 0) * (DURATION_MS[str(config.timeoutUnit) || 'hours'] || DURATION_MS.hours)
            : 0
          const actionResource = str(config.actionResource || config.messageSourceNodeId || config.replySourceNodeId)
          const actionResourceName = str(config.actionResourceName || config.messageSourceName || config.replySourceName)
          return {
            wait: {
              kind: WAIT_KIND_REPLY,
              resumeAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null,
              context: {
                waitExpectedAction: 'reply_message',
                waitActionResource: actionResource,
                waitActionResourceName: actionResourceName,
                waitActionChannel: str(config.actionChannel)
              }
            },
            detail: actionResourceName
              ? `Esperando respuesta al mensaje "${actionResourceName}"`
              : 'Esperando respuesta al mensaje enviado'
          }
        }
        if (expectedAction === 'click_link' || expectedAction === 'trigger_link_click' || expectedAction === 'trigger-link-click') {
          const timeoutMs = config.timeoutEnabled
            ? (Number(config.timeoutAmount) || 0) * (DURATION_MS[str(config.timeoutUnit) || 'hours'] || DURATION_MS.hours)
            : 0
          const actionResource = str(config.actionResource || config.link || config.triggerLinkId)
          const actionResourceName = str(config.actionResourceName || config.linkName)
          const displayName = actionResourceName || actionResource
          return {
            wait: {
              kind: WAIT_KIND_TRIGGER_LINK_CLICK,
              resumeAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null,
              context: {
                waitExpectedAction: 'trigger_link_click',
                waitActionResource: actionResource,
                waitActionResourceName: actionResourceName
              }
            },
            detail: displayName ? `Esperando clic de disparo en "${displayName}"` : 'Esperando un clic de disparo'
          }
        }
        return { skipped: true, handle: 'out', detail: `Espera por acción "${expectedAction}" aún no soportada: continúa` }
      }
      return { skipped: true, handle: 'out', detail: `Espera "${mode}" aún no soportada: continúa` }
    }

    case 'logic-drip':
      return executeDripNode(node, enrollment)

    case 'logic-condition': {
      const result = evaluateConditionNode(node.config, ctx)
      return { handle: result.handle, detail: `Condición evaluada → ${result.label}` }
    }

    case 'randomizer':
      return executeRandomizerNode(node)

    case 'logic-goal': {
      // (AUTO-006) Antes este nodo SIEMPRE tomaba la salida "cumplido" sin evaluar
      // nada, así que un contacto que ya cumplió la meta (p. ej. ya pagó) seguía
      // recibiendo la secuencia. Ahora evaluamos el estado actual del contacto:
      //  - Si el objetivo YA está cumplido y onMet es "end-automation" (el default del
      //    editor), sacamos al contacto del flujo (stop).
      //  - Si está cumplido y onMet es "continue", seguimos por la salida "out".
      //  - Si NO está cumplido y onNotMet es "timeout-branch", tomamos la rama "notmet".
      //  - En cualquier otro caso (no cumplido + continuar, o tipo no evaluable inline
      //    como formulario/link/conversación/personalizado), conservamos el
      //    comportamiento anterior: seguir por "out" sin cortar el flujo.
      const config = node.config || {}
      const met = evaluateGoalMet(config, ctx)
      const onMet = str(config.onMet) || 'end-automation'
      const onNotMet = str(config.onNotMet) || 'continue'
      if (met === true) {
        if (onMet === 'continue') {
          return { handle: 'out', detail: 'Objetivo cumplido: continúa por la salida "cumplido"' }
        }
        return { stop: true, detail: 'Objetivo cumplido: el contacto sale de la automatización' }
      }
      if (met === false && onNotMet === 'timeout-branch') {
        return { handle: 'notmet', detail: 'Objetivo no cumplido: rama "no cumplido"' }
      }
      return { handle: 'out', detail: 'Objetivo registrado' }
    }

    case 'action-create-contact':
      return executeCreateContact(node, ctx)

    case 'action-find-contact':
      return executeFindContact(node, ctx)

    case 'action-change-whatsapp-number':
      return applyContactWhatsAppNumberAction(node, ctx)

    case 'action-webhook':
      return executeWebhookAction(node, ctx)

    case 'action-contact-tag':
      return {
        handle: 'out',
        detail: await applyTagAction(node, ctx, str(node.config?.tagAction) === 'remove')
      }

    case 'action-add-contact-tag':
      return { handle: 'out', detail: await applyTagAction(node, ctx, false) }

    case 'action-remove-contact-tag':
      return { handle: 'out', detail: await applyTagAction(node, ctx, true) }

    case 'action-contact-user':
    case 'action-assign-user':
    case 'action-unassign-user':
      return { handle: 'out', detail: await applyContactUserAction(node, ctx) }

    case 'action-system-notification':
      return executeSystemNotification(node, ctx, enrollment)

    default:
      return { skipped: true, handle: 'out', detail: 'Paso aún no soportado por el motor: se omitió' }
  }
}

// ---------------------------------------------------------------------------
// Recorrido del flujo
// ---------------------------------------------------------------------------

async function runFrom(flow, enrollment, startNodeId, ctx) {
  let currentId = startNodeId
  let steps = 0

  while (currentId && steps < MAX_STEPS) {
    steps += 1
    const node = getNode(flow, currentId)
    if (!node) {
      addLog(enrollment, { nodeId: currentId, label: 'Paso', status: 'error', detail: 'El paso ya no existe en el flujo' })
      enrollment.status = 'exited'
      break
    }

    enrollment.currentNodeId = node.id
    let result
    try {
      result = await executeNode(node, ctx, enrollment)
    } catch (error) {
      // (AUTO-005) Un fallo transitorio de un nodo (WhatsApp/email caído un instante)
      // ya no expulsa la inscripción de inmediato: se reprograma un reintento del MISMO
      // nodo con backoff, hasta RETRY_MAX_ATTEMPTS. El contador vive en el contexto
      // persistido (no requiere esquema). Sólo tras agotar los intentos se marca 'exited'.
      const retryAttempts = Number(enrollment.context?.__retryAttempts) || 0
      if (retryAttempts < RETRY_MAX_ATTEMPTS) {
        const nextAttempt = retryAttempts + 1
        const backoffMs = RETRY_BACKOFF_MS[Math.min(retryAttempts, RETRY_BACKOFF_MS.length - 1)]
        const errorMessage = error instanceof Error ? error.message : String(error || 'Error desconocido')
        enrollment.context = {
          ...enrollment.context,
          ...getPersistentRuntimeContext(ctx, enrollment.context),
          __retryAttempts: nextAttempt,
          __retryNodeId: node.id
        }
        enrollment.currentNodeId = node.id
        enrollment.status = 'waiting'
        enrollment.waitKind = WAIT_KIND_RETRY
        enrollment.resumeAt = new Date(Date.now() + backoffMs).toISOString()
        addLog(enrollment, {
          nodeId: node.id,
          label: nodeLabel(node),
          status: 'waiting',
          outcome: 'error',
          errorMessage,
          retryable: true,
          retryAttempt: nextAttempt,
          detail: `Error temporal (${errorMessage}); reintento ${nextAttempt}/${RETRY_MAX_ATTEMPTS} programado`
        })
        logger.warn(`[Automatizaciones] Error temporal en paso ${node.type}, reintento ${nextAttempt}/${RETRY_MAX_ATTEMPTS}: ${errorMessage}`)
        break
      }
      const errorMessage = error instanceof Error ? error.message : String(error || 'Error desconocido')
      addLog(enrollment, {
        nodeId: node.id,
        label: nodeLabel(node),
        status: 'error',
        outcome: 'error',
        errorMessage,
        retryable: false,
        detail: `${errorMessage} (sin más reintentos)`
      })
      enrollment.status = 'exited'
      logger.warn(`[Automatizaciones] Error en paso ${node.type} tras ${retryAttempts} reintentos: ${errorMessage}`)
      break
    }

    // (AUTO-005) El nodo se ejecutó sin lanzar: limpiamos el contador de reintentos
    // para que un fallo posterior empiece de cero y no herede intentos de otro nodo.
    if (enrollment.context?.__retryAttempts || enrollment.context?.__retryNodeId) {
      const { __retryAttempts, __retryNodeId, ...restContext } = enrollment.context
      resolveRetryErrors(enrollment, __retryNodeId)
      enrollment.context = restContext
    }

    if (result.wait) {
      addLog(enrollment, {
        nodeId: node.id,
        label: nodeLabel(node),
        status: 'waiting',
        outcome: 'waiting',
        detail: result.detail
      })
      enrollment.status = 'waiting'
      enrollment.waitKind = result.wait.kind
      enrollment.resumeAt = result.wait.resumeAt
      enrollment.context = { ...enrollment.context, ...(result.wait.context || {}) }
      break
    }

    if (ctx.contact?.id) {
      enrollment.contactId = ctx.contact.id
      enrollment.contactName =
        ctx.contact.fullName ||
        ctx.contact.phone ||
        ctx.contact.email ||
        enrollment.contactName ||
        'Contacto'
    }

    exposeNodeOutput(ctx, node, result)

    const outcome = executionOutcomeForResult(result)
    addLog(enrollment, {
      nodeId: node.id,
      label: nodeLabel(node),
      status: logStatusForOutcome(outcome),
      outcome,
      detail: result.detail,
      ...(outcome === 'error'
        ? {
            errorMessage: cleanString(result.detail || result.output?.error || 'El paso reportó un error'),
            errorDetail: cleanString(result.output?.error || ''),
            errorCode: result.output?.status_code || null,
            retryable: false
          }
        : {})
    })

    if (result.stop) {
      enrollment.status = 'exited'
      if (outcome !== 'error' && !hasUnresolvedExecutionErrors(enrollment.log)) {
        enrollment.executionOutcome = 'success'
      }
      break
    }

    const edge = edgesFrom(flow, node.id, result.handle)[0] || (node.type === 'start' ? edgesFrom(flow, node.id)[0] : null)
    if (!edge) {
      // (AUTO-001) Si el paso se omitió (tipo no soportado por el motor) pero sí tiene
      // salidas conectadas por otros handles (p.ej. un aleatorizador con ramas a/b), NO
      // terminamos el flujo en silencio como si hubiera concluido: marcamos error para
      // que sea visible que un paso ramificado no soportado cortó el flujo.
      if (result.skipped && edgesFrom(flow, node.id).length > 0) {
        enrollment.status = 'exited'
        addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'error', detail: 'Paso no soportado con ramas conectadas: el flujo no puede continuar' })
        break
      }
      enrollment.status = 'completed'
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'ok', detail: 'Fin del flujo' })
      break
    }
    currentId = edge.targetNodeId
  }

  if (steps >= MAX_STEPS) {
    enrollment.status = 'exited'
    addLog(enrollment, { nodeId: currentId, label: 'Flujo', status: 'error', detail: 'Límite de pasos alcanzado (posible ciclo)' })
  }

  await saveEnrollment(enrollment)
}

// ---------------------------------------------------------------------------
// Entradas del motor
// ---------------------------------------------------------------------------

async function loadContactMetrics(contactId, row = {}) {
  if (!contactId) {
    return {
      totalPaid: 0,
      purchasesCount: 0,
      paymentsCount: 0,
      appointmentsCount: 0,
      activeAppointmentsCount: 0,
      attendedAppointmentsCount: 0,
      hasActiveAppointment: false,
      activeAutomationIds: []
    }
  }

  const [paymentAgg, appointmentAgg, activeAppointment, enrollmentRows] = await Promise.all([
    db.get(`
      SELECT
        COUNT(*) AS payments_count,
        COALESCE(SUM(CASE WHEN amount > 0 AND LOWER(COALESCE(status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL}) THEN amount ELSE 0 END), 0) AS successful_total,
        COALESCE(SUM(CASE WHEN amount > 0 AND LOWER(COALESCE(status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL}) THEN 1 ELSE 0 END), 0) AS successful_count,
        MAX(CASE WHEN amount > 0 AND LOWER(COALESCE(status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL}) THEN COALESCE(date, created_at) ELSE NULL END) AS last_purchase_date
      FROM payments
      WHERE contact_id = ?
    `, [contactId]).catch(() => ({})),
    db.get(`
      SELECT
        COUNT(*) AS appointments_count,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'deleted') THEN 1 ELSE 0 END), 0) AS active_appointments_count,
        COALESCE(SUM(CASE WHEN LOWER(COALESCE(appointment_status, status, '')) IN ('showed', 'show', 'attended', 'completed', 'complete') THEN 1 ELSE 0 END), 0) AS attended_appointments_count
      FROM appointments
      WHERE contact_id = ?
    `, [contactId]).catch(() => ({})),
    db.get(`
      SELECT id, calendar_id, assigned_user_id, start_time, end_time, appointment_status, status, title
      FROM appointments
      WHERE contact_id = ?
        AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'no_show', 'no-show', 'noshow', 'deleted')
      ORDER BY CASE WHEN start_time >= CURRENT_TIMESTAMP THEN 0 ELSE 1 END, start_time ASC
      LIMIT 1
    `, [contactId]).catch(() => null),
    db.all(`
      SELECT DISTINCT automation_id
      FROM automation_enrollments
      WHERE contact_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUS_SQL})
    `, [contactId]).catch(() => [])
  ])

  const totalPaid = Number(paymentAgg?.successful_total ?? row?.total_paid ?? 0) || 0
  const purchasesCount = Number(paymentAgg?.successful_count ?? row?.purchases_count ?? 0) || 0
  const activeAppointmentsCount = Number(appointmentAgg?.active_appointments_count || 0)

  return {
    totalPaid,
    total_paid: totalPaid,
    purchasesCount,
    purchases_count: purchasesCount,
    paymentsCount: Number(paymentAgg?.payments_count || 0),
    appointmentsCount: Number(appointmentAgg?.appointments_count || 0),
    activeAppointmentsCount,
    attendedAppointmentsCount: Number(appointmentAgg?.attended_appointments_count || 0),
    hasActiveAppointment: activeAppointmentsCount > 0,
    lastPurchaseDate: paymentAgg?.last_purchase_date || row?.last_purchase_date || '',
    activeAppointmentId: activeAppointment?.id || '',
    activeAppointmentTitle: activeAppointment?.title || '',
    activeAppointmentStatus: activeAppointment?.appointment_status || activeAppointment?.status || '',
    activeAppointmentCalendarId: activeAppointment?.calendar_id || '',
    activeAppointmentAssignedUserId: activeAppointment?.assigned_user_id || '',
    activeAppointmentDate: activeAppointment?.start_time || '',
    activeAutomationIds: (Array.isArray(enrollmentRows) ? enrollmentRows : [])
      .map((enrollmentRow) => enrollmentRow?.automation_id)
      .filter(Boolean)
  }
}

async function loadContact(contactId, fallback = {}) {
  const row = contactId ? await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]) : null
  const bag = customFieldsBag(row?.custom_fields)
  const metrics = await loadContactMetrics(row?.id || contactId || null, row || {})
  const storedTags = (() => {
    const parsed = parseJson(row?.tags, [])
    return Array.isArray(parsed) ? parsed : []
  })()
  // tagKeys: IDs del catálogo + nombres (configs viejas guardaban el nombre) +
  // etiquetas internas calculadas (Cliente, Cita agendada, Prospecto); es lo
  // que usan filtros y condiciones para comparar.
  const tagKeys = await buildTagMatchKeys(row?.id || contactId || null, storedTags)
    .then((keys) => [...keys])
    .catch(() => storedTags)
  return {
    id: row?.id || contactId || null,
    firstName: row?.first_name || '',
    lastName: row?.last_name || '',
    fullName: row?.full_name || fallback.name || '',
    phone: row?.phone || fallback.phone || '',
    email: row?.email || '',
    visitorId: row?.visitor_id || '',
    preferredWhatsAppPhoneNumberId: row?.preferred_whatsapp_phone_number_id || '',
    preferred_whatsapp_phone_number_id: row?.preferred_whatsapp_phone_number_id || '',
    source: row?.source || bag.source || '',
    country: row?.country || bag.country || '',
    stage: row?.stage || bag.stage || '',
    assignedUser: row?.assigned_user || bag.assignedUser || '',
    // Atribución de anuncios (filtros "Anuncio de origen", "URL de origen"…)
    adName: row?.attribution_ad_name || '',
    adId: row?.attribution_ad_id || '',
    attributionUrl: row?.attribution_url || '',
    attributionMedium: row?.attribution_medium || '',
    createdAt: row?.created_at || '',
    updatedAt: row?.updated_at || '',
    ...metrics,
    customFields: bag,
    tags: storedTags,
    tagKeys
  }
}

function whatsappPhoneLabel(row = {}) {
  return cleanString(row.label) ||
    cleanString(row.verified_name) ||
    cleanString(row.display_phone_number) ||
    cleanString(row.phone_number) ||
    cleanString(row.id)
}

async function loadWhatsAppPhoneSnapshot(phoneNumberId) {
  const id = cleanString(phoneNumberId)
  if (!id) return null
  return db.get(`
    SELECT id, phone_number, display_phone_number, verified_name, label,
      is_default_sender, api_send_enabled, qr_send_enabled, qr_status, updated_at
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [id]).catch(() => null)
}

async function listPublishedAutomations({ eventType = '', endpointId = '', automationIds = null } = {}) {
  let rows
  if (Array.isArray(automationIds)) {
    rows = await listPublishedAutomationRowsByIds(automationIds)
  } else if (cleanString(eventType)) {
    const result = await listPublishedAutomationRowsForEvent(eventType, { endpointId })
    rows = result.rows
  } else {
    throw new Error('El motor necesita un evento o IDs explícitos para cargar automatizaciones publicadas')
  }

  const automations = []
  for (const row of rows) {
    const flow = parseJson(row.published_flow || row.flow, { nodes: [], edges: [] })
    if (await canRunAutomationFlow(flow)) {
      automations.push({ id: row.id, name: row.name, flow })
    }
  }
  return automations
}

async function getPublishedAutomation(automationId) {
  const id = cleanString(automationId)
  if (!id) throw engineError(400, 'Selecciona una automatización')

  const row = await getAutomationEnrollmentRow(id)
  if (!row || row.status !== 'published') throw engineError(404, 'Automatización publicada no encontrada')
  const flow = parseJson(row.published_flow || row.flow, { nodes: [], edges: [] })
  if (!(await canRunAutomationFlow(flow))) {
    throw engineError(403, 'Esta automatización usa funciones que no están incluidas en tu plan actual')
  }
  return { id: row.id, name: row.name, flow }
}

async function getSavedAutomationForTestRun(automationId) {
  const id = cleanString(automationId)
  if (!id) throw engineError(400, 'Selecciona una automatización')

  const row = await getAutomationEnrollmentRow(id)
  if (!row) throw engineError(404, 'Automatización guardada no encontrada')
  if (row.status === 'archived') throw engineError(400, 'No puedes probar una automatización archivada')
  const flow = parseJson(row.flow, { nodes: [], edges: [] })
  if (!(await canRunAutomationFlow(flow))) {
    throw engineError(403, 'Esta automatización usa funciones que no están incluidas en tu plan actual')
  }
  return { id: row.id, name: row.name, flow }
}

async function getAutomationEnrollmentRow(id) {
  const row = await db.get(
    `SELECT id, name, status, flow, published_flow
     FROM automations
     WHERE id = ?`,
    [id]
  )
  return row || null
}

function mapEnrollmentResult(enrollment) {
  finalizeEnrollmentOutcome(enrollment)
  return {
    id: enrollment.id,
    automationId: enrollment.automationId,
    contactId: enrollment.contactId || null,
    contactName: enrollment.contactName || 'Contacto',
    status: enrollment.status || 'active',
    currentNodeId: enrollment.currentNodeId || null,
    log: enrollment.log || [],
    executionOutcome: enrollment.executionOutcome || 'pending',
    lastError: enrollment.lastError || null,
    resumeAt: enrollment.resumeAt || null,
    waitKind: enrollment.waitKind || null,
    enteredAt: enrollment.enteredAt || null,
    updatedAt: enrollment.updatedAt || null
  }
}

function mapEnrollmentRow(row) {
  return {
    id: row.id,
    automationId: row.automation_id,
    contactId: row.contact_id || null,
    contactName: row.contact_name || 'Contacto',
    status: row.status || 'active',
    currentNodeId: row.current_node_id || 'start',
    log: parseJson(row.log, []),
    executionOutcome: row.execution_outcome || null,
    lastError: row.last_error || null,
    resumeAt: row.resume_at || null,
    waitKind: row.wait_kind || null,
    context: parseJson(row.context, {}),
    enteredAt: row.entered_at || null,
    updatedAt: row.updated_at || null
  }
}

async function getEnrollmentControlRow(automationId, enrollmentId) {
  const cleanAutomationId = cleanString(automationId)
  const cleanEnrollmentId = cleanString(enrollmentId)
  if (!cleanAutomationId) throw engineError(400, 'Selecciona una automatización')
  if (!cleanEnrollmentId) throw engineError(400, 'Selecciona una inscripción')

  const row = await db.get(
    `SELECT * FROM automation_enrollments WHERE id = ? AND automation_id = ?`,
    [cleanEnrollmentId, cleanAutomationId]
  )
  if (!row) throw engineError(404, 'Inscripción no encontrada')
  return mapEnrollmentRow(row)
}

async function reloadEnrollmentResult(enrollmentId) {
  const row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollmentId])
  if (!row) throw engineError(404, 'Inscripción no encontrada')
  return mapEnrollmentResult(mapEnrollmentRow(row))
}

async function getAutomationForEnrollmentControl(automationId, { requirePublished = false } = {}) {
  const automation = await getAutomationEnrollmentRow(automationId)
  if (!automation) throw engineError(404, 'Automatización no encontrada')
  if (automation.status === 'archived') throw engineError(400, 'No puedes modificar inscripciones de una automatización archivada')
  if (requirePublished && automation.status !== 'published') {
    throw engineError(400, 'La automatización debe estar publicada para mover, avanzar o reintentar contactos')
  }

  const flow = parseJson(automation.published_flow || automation.flow, { nodes: [], edges: [] })
  if (!(await canRunAutomationFlow(flow))) {
    throw engineError(403, 'Esta automatización usa funciones que no están incluidas en tu plan actual')
  }

  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    flow
  }
}

function clearManualControlContext(context = {}) {
  const {
    __retryAttempts,
    __retryNodeId,
    __pausedStatus,
    __pausedResumeAt,
    __pausedWaitKind,
    waitExpectedAction,
    waitActionResource,
    waitActionResourceName,
    waitActionChannel,
    waitButtons,
    ...rest
  } = context || {}
  return rest
}

function clearPauseContext(context = {}) {
  const {
    __pausedStatus,
    __pausedResumeAt,
    __pausedWaitKind,
    ...rest
  } = context || {}
  return rest
}

async function buildEnrollmentControlContext(automation, enrollment) {
  if (!enrollment.contactId) {
    throw engineError(400, 'Esta inscripción no tiene contacto asociado')
  }
  const contact = await loadContact(enrollment.contactId)
  return {
    ...(enrollment.context || {}),
    contact,
    automationName: automation.name,
    manualControl: true,
    manualControlSource: 'automation-editor'
  }
}

function ensureTargetNode(flow, nodeId) {
  const cleanNodeId = cleanString(nodeId)
  if (!cleanNodeId) throw engineError(400, 'Selecciona el paso destino')
  const node = getNode(flow, cleanNodeId)
  if (!node) throw engineError(404, 'El paso destino ya no existe en el flujo')
  if (node.type === 'start') throw engineError(400, 'Elige un paso de la secuencia, no el disparador inicial')
  return node
}

export async function enrollContactManually({
  automationId,
  contactId,
  source = 'manual',
  scheduledFor = null,
  useSavedDraftFlow = false
} = {}) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) throw engineError(400, 'Selecciona un contacto')

  const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [cleanContactId])
  if (!contactExists) throw engineError(404, 'Contacto no encontrado')

  const automation = useSavedDraftFlow
    ? await getSavedAutomationForTestRun(automationId)
    : await getPublishedAutomation(automationId)
  const flow = automation.flow || {}
  const startNode = getStartNode(flow)
  if (!startNode) throw engineError(400, 'La automatización no tiene inicio configurado')

  const contact = await loadContact(cleanContactId)
  const settings = flow.settings || {}
  if (settings.preventDuplicateActiveEnrollment !== false) {
    const active = await db.get(
      `SELECT id FROM automation_enrollments
       WHERE automation_id = ? AND contact_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUS_SQL})`,
      [automation.id, contact.id]
    )
    if (active) throw engineError(409, 'Este contacto ya está activo en esa automatización')
  }
  if (settings.allowReentry === false) {
    const existing = await db.get(
      'SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automation.id, contact.id]
    )
    if (existing) throw engineError(409, 'Esta automatización no permite volver a meter al mismo contacto')
  }

  const ctx = {
    contact,
    automationName: automation.name,
    channel: 'manual',
    messageText: '',
    manualEnrollment: true,
    manualEnrollmentSource: source,
    manualScheduledFor: scheduledFor || null,
    scheduledFor: scheduledFor || null
  }
  const enrollment = await createEnrollment(automation, contact, ctx)
  addLog(enrollment, {
    nodeId: 'start',
    label: 'Cuando...',
    status: 'ok',
    detail: scheduledFor
      ? `Agregado manualmente para ${scheduledFor}`
      : source === 'test-run'
        ? 'Prueba iniciada desde Automatizaciones'
        : 'Agregado manualmente desde el contacto'
  })

  const edge = edgesFrom(flow, startNode.id)[0]
  if (edge) {
    logger.info(`[Automatizaciones] "${automation.name}": contacto agregado manualmente (${contact.fullName || contact.phone || cleanContactId})`)
    await runFrom(flow, enrollment, edge.targetNodeId, ctx)
  } else {
    addLog(enrollment, { nodeId: 'start', label: 'Cuando...', status: 'error', detail: 'El inicio no está conectado a ningún paso' })
    enrollment.status = 'exited'
    await saveEnrollment(enrollment)
  }

  const row = await db.get('SELECT entered_at, updated_at FROM automation_enrollments WHERE id = ?', [enrollment.id])
  return mapEnrollmentResult({
    ...enrollment,
    enteredAt: row?.entered_at || null,
    updatedAt: row?.updated_at || null
  })
}

export async function controlAutomationEnrollment({
  automationId,
  enrollmentId,
  action,
  targetNodeId
} = {}) {
  const command = cleanString(action).toLowerCase()
  const enrollment = await getEnrollmentControlRow(automationId, enrollmentId)

  if (command === 'exit') {
    enrollment.status = 'exited'
    enrollment.resumeAt = null
    enrollment.waitKind = null
    enrollment.context = clearManualControlContext(enrollment.context)
    addLog(enrollment, {
      nodeId: enrollment.currentNodeId || 'flow',
      label: 'Flujo',
      status: 'exited',
      detail: 'Sacado manualmente desde Automatizaciones'
    })
    await saveEnrollment(enrollment)
    return reloadEnrollmentResult(enrollment.id)
  }

  if (command === 'pause') {
    if (!['active', 'waiting'].includes(enrollment.status)) {
      throw engineError(400, 'Solo puedes pausar contactos activos o en espera')
    }
    enrollment.context = {
      ...(enrollment.context || {}),
      __pausedStatus: enrollment.status,
      __pausedResumeAt: enrollment.resumeAt || null,
      __pausedWaitKind: enrollment.waitKind || null
    }
    enrollment.status = 'paused'
    addLog(enrollment, {
      nodeId: enrollment.currentNodeId || 'flow',
      label: 'Flujo',
      status: 'paused',
      detail: 'Pausado manualmente desde Automatizaciones'
    })
    await saveEnrollment(enrollment)
    return reloadEnrollmentResult(enrollment.id)
  }

  if (command === 'resume') {
    if (enrollment.status !== 'paused') {
      throw engineError(400, 'Solo puedes reanudar contactos pausados')
    }
    const pausedStatus = cleanString(enrollment.context?.__pausedStatus)
    const nextStatus = pausedStatus === 'waiting' || enrollment.resumeAt || enrollment.waitKind ? 'waiting' : 'active'
    enrollment.status = nextStatus
    enrollment.context = clearPauseContext(enrollment.context)
    addLog(enrollment, {
      nodeId: enrollment.currentNodeId || 'flow',
      label: 'Flujo',
      status: 'active',
      detail: nextStatus === 'waiting'
        ? 'Reanudado manualmente; conserva su espera pendiente'
        : 'Reanudado manualmente desde Automatizaciones'
    })

    if (nextStatus === 'active' && enrollment.currentNodeId) {
      const automation = await getAutomationForEnrollmentControl(automationId, { requirePublished: true })
      const ctx = await buildEnrollmentControlContext(automation, enrollment)
      await runFrom(automation.flow, enrollment, enrollment.currentNodeId, ctx)
      return reloadEnrollmentResult(enrollment.id)
    }

    await saveEnrollment(enrollment)
    return reloadEnrollmentResult(enrollment.id)
  }

  if (['advance', 'move_to_node', 'retry'].includes(command)) {
    const automation = await getAutomationForEnrollmentControl(automationId, { requirePublished: true })
    const flow = automation.flow
    const retryNodeId = cleanString(enrollment.context?.__retryNodeId) || enrollment.currentNodeId
    enrollment.status = 'active'
    enrollment.resumeAt = null
    enrollment.waitKind = null
    enrollment.context = clearManualControlContext(enrollment.context)
    const ctx = await buildEnrollmentControlContext(automation, enrollment)

    if (command === 'advance') {
      const currentNodeId = enrollment.currentNodeId
      const edge = edgesFrom(flow, currentNodeId, 'out')[0] || edgesFrom(flow, currentNodeId)[0]
      addLog(enrollment, {
        nodeId: currentNodeId || 'flow',
        label: 'Flujo',
        status: 'ok',
        detail: 'Empujado manualmente al siguiente paso'
      })
      if (!edge) {
        enrollment.status = 'completed'
        addLog(enrollment, {
          nodeId: currentNodeId || 'flow',
          label: 'Flujo',
          status: 'ok',
          detail: 'Fin del flujo'
        })
        await saveEnrollment(enrollment)
        return reloadEnrollmentResult(enrollment.id)
      }
      await runFrom(flow, enrollment, edge.targetNodeId, ctx)
      return reloadEnrollmentResult(enrollment.id)
    }

    const node = command === 'retry'
      ? ensureTargetNode(flow, retryNodeId)
      : ensureTargetNode(flow, targetNodeId)

    addLog(enrollment, {
      nodeId: node.id,
      label: nodeLabel(node),
      status: 'ok',
      detail: command === 'retry'
        ? 'Reintentado manualmente desde Automatizaciones'
        : `Movido manualmente a "${nodeLabel(node)}"`
    })
    await runFrom(flow, enrollment, node.id, ctx)
    return reloadEnrollmentResult(enrollment.id)
  }

  throw engineError(400, 'Acción de inscripción no soportada')
}

async function resumeWaitingTriggerLinkClicks(baseCtx) {
  const contact = baseCtx.contact || {}
  if (!contact.id || !hasTriggerLinkEventContext(baseCtx)) return

  const waiting = await db.all(
    `SELECT * FROM automation_enrollments
     WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
    [contact.id, WAIT_KIND_TRIGGER_LINK_CLICK]
  )
  const automations = await listPublishedAutomations({
    automationIds: waiting.map((row) => row.automation_id)
  })
  const automationsById = new Map(automations.map((automation) => [automation.id, automation]))

  for (const row of waiting) {
    const automation = automationsById.get(row.automation_id)
    if (!automation) continue

    const storedContext = parseJson(row.context, {})
    if (!triggerLinkMatchesValue(storedContext.waitActionResource, baseCtx)) continue

    const clickedContext = {
      triggerLinkId: baseCtx.triggerLinkId || null,
      triggerLinkPublicId: baseCtx.triggerLinkPublicId || null,
      triggerLinkName: baseCtx.triggerLinkName || null,
      triggerLinkUrl: baseCtx.triggerLinkUrl || null,
      destinationUrl: baseCtx.destinationUrl || null,
      visitorId: baseCtx.visitorId || null,
      referrer: baseCtx.referrer || null,
      eventId: baseCtx.eventId || null,
      clickedAt: baseCtx.clickedAt || nowIso(),
      query: baseCtx.query || null
    }
    const enrollment = {
      id: row.id,
      automationId: row.automation_id,
      status: 'active',
      currentNodeId: row.current_node_id,
      log: parseJson(row.log, []),
      resumeAt: null,
      waitKind: null,
      context: { ...storedContext, ...clickedContext }
    }
    const ctx = {
      ...storedContext,
      ...baseCtx,
      ...clickedContext,
      contact,
      messageText: baseCtx.messageText || storedContext.messageText || '',
      channel: baseCtx.channel || storedContext.channel || '',
      businessPhoneNumberId: baseCtx.businessPhoneNumberId || storedContext.businessPhoneNumberId || null,
      automationName: automation.name
    }
    const displayName = triggerLinkDisplayName(baseCtx) || storedContext.waitActionResourceName || storedContext.waitActionResource
    addLog(enrollment, {
      nodeId: row.current_node_id,
      label: 'Esperar',
      status: 'ok',
      detail: displayName ? `Clic de disparo recibido en "${displayName}"` : 'Clic de disparo recibido'
    })
    const edge = edgesFrom(automation.flow, row.current_node_id, 'out')[0]
    if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
    else {
      enrollment.status = 'completed'
      addLog(enrollment, { nodeId: row.current_node_id, label: 'Esperar', status: 'ok', detail: 'Fin del flujo' })
      await saveEnrollment(enrollment)
    }
  }
}

/** Evento principal: llega un mensaje entrante (WhatsApp por ahora) */
export async function handleIncomingMessage({
  contactId,
  phone,
  contactName,
  text,
  messageType = '',
  buttonId = '',
  buttonPayload = '',
  buttonTitle = '',
  buttonReplyType = '',
  channel = 'whatsapp',
  businessPhoneNumberId = null
}) {
  try {
    if (!(await canRunBackgroundJob('automations'))) return
    const contact = await loadContact(contactId, { phone, name: contactName })
    const baseCtx = {
      contact,
      messageText: text || '',
      channel: normalizeConversationChannel(channel) || 'whatsapp',
      businessPhoneNumberId,
      messageType,
      buttonId,
      buttonPayload,
      buttonTitle,
      buttonReplyType
    }
    const [waitingButtons, waiting] = await Promise.all([
      db.all(
        `SELECT * FROM automation_enrollments WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
        [contact.id, WAIT_KIND_BUTTON_REPLY]
      ),
      db.all(
        `SELECT * FROM automation_enrollments WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
        [contact.id, WAIT_KIND_REPLY]
      )
    ])
    const waitingAutomationIds = [...waitingButtons, ...waiting].map((row) => row.automation_id)
    const [messageAutomations, stopOnResponseAutomations, waitingAutomations] = await Promise.all([
      listPublishedAutomations({ eventType: 'message-received' }),
      listPublishedAutomations({ eventType: AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE }),
      listPublishedAutomations({ automationIds: waitingAutomationIds })
    ])
    const waitingAutomationsById = new Map(
      waitingAutomations.map((automation) => [automation.id, automation])
    )

    // 1) Reanudar inscripciones que esperaban un botón de este contacto
    for (const row of waitingButtons) {
      const automation = waitingAutomationsById.get(row.automation_id)
      if (!automation) continue
      const storedContext = parseJson(row.context, {})
      const matchedButton = findMatchingWaitButton(storedContext.waitButtons, {
        buttonId,
        buttonPayload,
        buttonTitle,
        text
      })
      if (!matchedButton) continue

      const enrollment = {
        id: row.id,
        automationId: row.automation_id,
        status: 'active',
        currentNodeId: row.current_node_id,
        log: parseJson(row.log, []),
        resumeAt: null,
        waitKind: null,
        context: storedContext
      }
      const ctx = {
        ...baseCtx,
        buttonId: matchedButton.id,
        buttonTitle: buttonTitle || matchedButton.label,
        buttonPayload: buttonPayload || matchedButton.id,
        businessPhoneNumberId: businessPhoneNumberId || enrollment.context.businessPhoneNumberId
      }
      addLog(enrollment, {
        nodeId: row.current_node_id,
        label: nodeLabel(getNode(automation.flow, row.current_node_id)) || 'WhatsApp',
        status: 'ok',
        detail: `Botón "${matchedButton.label}" recibido`
      })
      const edge = edgesFrom(automation.flow, row.current_node_id, `btn_${matchedButton.id}`)[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        await saveEnrollment(enrollment)
      }
    }

    // 2) Reanudar inscripciones que esperaban respuesta de este contacto
    for (const row of waiting) {
      const automation = waitingAutomationsById.get(row.automation_id)
      if (!automation) continue
      const enrollment = {
        id: row.id,
        automationId: row.automation_id,
        status: 'active',
        currentNodeId: row.current_node_id,
        log: parseJson(row.log, []),
        resumeAt: null,
        waitKind: null,
        context: parseJson(row.context, {})
      }
      const ctx = { ...baseCtx, businessPhoneNumberId: businessPhoneNumberId || enrollment.context.businessPhoneNumberId }
      const sourceName = str(enrollment.context.waitActionResourceName)
      addLog(enrollment, {
        nodeId: row.current_node_id,
        label: 'Esperar',
        status: 'ok',
        detail: sourceName ? `El contacto respondió a "${sourceName}"` : 'El contacto respondió'
      })
      const edge = edgesFrom(automation.flow, row.current_node_id, 'out')[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        await saveEnrollment(enrollment)
      }
    }

    // 3) Detener flujos configurados con "salir al responder"
    for (const automation of stopOnResponseAutomations) {
      if (automation.flow?.settings?.stopOnContactResponse) {
        await db.run(
          `UPDATE automation_enrollments SET status = 'exited', updated_at = CURRENT_TIMESTAMP
           WHERE automation_id = ? AND contact_id = ? AND status IN ('active', 'waiting')
             AND (wait_kind IS NULL OR wait_kind NOT IN (?, ?))`,
          [automation.id, contact.id, WAIT_KIND_REPLY, WAIT_KIND_BUTTON_REPLY]
        )
      }
    }

    // 4) Inscribir en automatizaciones cuyo disparador coincide
    await enrollMatching(messageAutomations, 'message-received', baseCtx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando mensaje entrante: ${error.message}`)
  }
}

// Control del disparador de comentario que necesita la BD (no cabe en el
// triggerMatches síncrono): "Solo el primer comentario de cada persona" ignora
// los comentarios posteriores del mismo autor en la misma publicación. El
// comentario idéntico repetido ya se bloquea al recibirse (isNew), y los
// reingresos de la misma persona se controlan en la config de reingreso del flujo.
async function commentTriggerShouldSkip(trigger, ctx) {
  const config = trigger.config || {}
  const contactId = ctx.contact?.id
  if (!contactId) return false
  const platform = str(ctx.platform) === 'instagram' ? 'instagram' : 'messenger'
  const postId = str(ctx.postId) || str(ctx.mediaId)
  const commentId = str(ctx.commentId)

  if (str(config.allowedComments) === 'first_only' && postId) {
    const earlier = await db.get(
      `SELECT 1 FROM meta_social_messages
       WHERE contact_id = ? AND platform = ? AND message_type = 'comment'
         AND LOWER(COALESCE(direction, '')) = 'inbound'
         AND COALESCE(post_id, '') = ?
         AND COALESCE(comment_id, '') <> '' AND comment_id <> ?
       LIMIT 1`,
      [contactId, platform, postId, commentId]
    ).catch(() => null)
    if (earlier) return true
  }

  return false
}

async function enrollMatching(automations, eventType, baseCtx) {
  const contact = baseCtx.contact || {}
  for (const automation of automations) {
    const flow = automation.flow
    const startNode = getStartNode(flow)
    if (!startNode) continue
    const matched = getTriggers(startNode).find((trigger) => triggerMatches(trigger, eventType, baseCtx))
    if (!matched) continue

    // La respuesta al comentario ya NO se configura en el disparador: se hace con
    // el nodo de acción "Responder comentario" dentro del flujo.

    // Controles del disparador de comentario ("Evitar disparos duplicados" y
    // "Solo el primer comentario de cada persona"): consultan la BD, por eso van
    // aquí y no en el triggerMatches síncrono.
    if (eventType === 'comment-received' && await commentTriggerShouldSkip(matched, baseCtx)) continue

    const settings = flow.settings || {}
    if (contact.id && settings.preventDuplicateActiveEnrollment !== false) {
      const active = await db.get(
        `SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUS_SQL})`,
        [automation.id, contact.id]
      )
      if (active) continue
    }
    if (contact.id && settings.allowReentry === false) {
      const any = await db.get(
        `SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?`,
        [automation.id, contact.id]
      )
      if (any) continue
    }

    const ctx = { ...baseCtx, automationName: automation.name }
    const enrollment = await createEnrollment(automation, contact, ctx)
    const describe = EVENT_DESCRIPTIONS[eventType]
    addLog(enrollment, {
      nodeId: 'start',
      label: 'Cuando...',
      status: 'ok',
      detail: `Disparador: ${describe ? describe(ctx) : eventType}`
    })
    const edge = edgesFrom(flow, startNode.id)[0]
    if (edge) {
      logger.info(`[Automatizaciones] "${automation.name}": inscrito ${contact.fullName || contact.phone || 'contacto'} (${eventType})`)
      await runFrom(flow, enrollment, edge.targetNodeId, ctx)
    } else {
      addLog(enrollment, { nodeId: 'start', label: 'Cuando...', status: 'error', detail: 'El disparador no está conectado a ningún paso' })
      enrollment.status = 'exited'
      await saveEnrollment(enrollment)
    }
  }
}

function testReceiptResult(receipt, fallbackDetail = '') {
  const response = receipt?.response && typeof receipt.response === 'object' ? receipt.response : {}
  return {
    handle: cleanString(response.handle) || 'out',
    stop: Boolean(response.stop),
    detail: cleanString(receipt?.detail || response.detail || fallbackDetail),
    testMode: true,
    idempotent: true,
    auditReceiptId: receipt?.id || null,
    auditStatus: receipt?.status || 'unknown'
  }
}

function testActionAuditContext(ctx = {}) {
  return {
    testMode: true,
    testRunId: ctx.testRunId,
    testEffectId: ctx.testEffectId,
    appointmentId: ctx.appointmentId,
    eventType: ctx.eventType,
    testExpiresAt: ctx.testExpiresAt
  }
}

function testActionAuditNode(ctx = {}, node = {}, actionType, request = {}) {
  return {
    automationId: ctx.automationId,
    automationName: ctx.automationName,
    nodeId: node.id,
    nodeType: node.type,
    actionType,
    request
  }
}

async function executeAppointmentTestWebhook(node, ctx) {
  const auditContext = testActionAuditContext(ctx)
  const action = testActionAuditNode(ctx, node, 'webhook', {
    method: cleanString(node.config?.method || 'POST').toUpperCase(),
    configured: Boolean(cleanString(node.config?.url)),
    testMode: true
  })
  const claim = await claimAppointmentTestAction(auditContext, action)
  if (!claim.claimed) {
    if (claim.receipt?.status === 'dispatching') {
      return {
        handle: 'out',
        stop: true,
        detail: 'Webhook de prueba con resultado incierto; no se reenvió para evitar duplicarlo.',
        testMode: true,
        idempotent: true,
        auditReceiptId: claim.receipt?.id || null,
        auditStatus: 'dispatching'
      }
    }
    return testReceiptResult(claim.receipt, 'Webhook de prueba ya procesado; no se duplicó.')
  }

  const webhookCtx = {
    ...ctx,
    automationNodeId: node.id,
    testActionIdempotencyKey: claim.idempotencyKey
  }
  let result
  try {
    result = await executeWebhookAction(node, webhookCtx)
  } catch (error) {
    const receipt = await completeAppointmentTestAction(claim.receipt.id, {
      status: 'failed',
      detail: `Webhook de prueba falló: ${error.message}`,
      response: { handle: 'out', stop: true, detail: error.message, error: true }
    })
    return {
      handle: 'out',
      stop: true,
      detail: receipt?.detail || `Webhook de prueba falló: ${error.message}`,
      testMode: true,
      auditReceiptId: receipt?.id || claim.receipt.id,
      auditStatus: 'failed'
    }
  }

  const ok = result.output?.status === 'ok'
  const receipt = await completeAppointmentTestAction(claim.receipt.id, {
    status: ok ? 'sent' : 'failed',
    detail: result.detail || (ok ? 'Webhook de prueba enviado.' : 'Webhook de prueba falló.'),
    response: {
      handle: result.handle || 'out',
      stop: Boolean(result.stop),
      detail: result.detail || '',
      status: result.output?.status || (ok ? 'ok' : 'error'),
      statusCode: Number(result.output?.status_code || 0)
    }
  })
  return {
    ...result,
    testMode: true,
    auditReceiptId: receipt?.id || claim.receipt.id,
    auditStatus: receipt?.status || (ok ? 'sent' : 'failed')
  }
}

async function executeAppointmentTestSystemNotification(node, ctx) {
  const config = node.config || {}
  const delivery = resolveNotificationDelivery(config)
  const auditContext = testActionAuditContext(ctx)
  const action = testActionAuditNode(ctx, node, 'internal-notification', {
    configuredRecipientMode: cleanString(config.recipientMode || 'all'),
    delivery,
    testMode: true
  })

  if (!delivery.bell && !delivery.push && !delivery.email) {
    const receipt = await recordSimulatedAppointmentTestAction(auditContext, {
      ...action,
      detail: 'Notificación omitida: el paso no tiene canales seleccionados.'
    })
    return {
      handle: 'out',
      detail: receipt?.detail || 'Notificación omitida: no hay canales seleccionados.',
      testMode: true,
      simulated: true,
      auditReceiptId: receipt?.id || null,
      auditStatus: 'simulated'
    }
  }

  const claim = await claimAppointmentTestAction(auditContext, action)
  if (!claim.claimed) {
    if (claim.receipt?.status === 'dispatching') {
      return {
        handle: 'out',
        stop: true,
        detail: 'Notificación de prueba con resultado incierto; no se duplicó.',
        testMode: true,
        idempotent: true,
        auditReceiptId: claim.receipt?.id || null,
        auditStatus: 'dispatching'
      }
    }
    return testReceiptResult(claim.receipt, 'Notificación de prueba ya enviada; no se duplicó.')
  }

  const requestedByUserId = cleanString(ctx.requestedByUserId)
  const rawTitle = renderedConfigValue(config.pushTitle || config.title, ctx).slice(0, 110)
  const rawMessage = renderedConfigValue(config.pushBody || config.body, ctx).slice(0, 650)
  const title = `Prueba · ${rawTitle || 'Notificación interna'}`
  const message = `${rawMessage || 'La automatización llegó a este paso.'}\n\nModo test: se envió únicamente a quien inició la prueba.`
  const actionUrl = notificationClickUrl(config, ctx)
  const actionLabel = notificationActionLabel(config)

  try {
    const notification = delivery.bell || delivery.push
      ? await createInternalNotification({
          recipientUserIds: [requestedByUserId],
          source: 'Automatizaciones · Modo test',
          severity: 'info',
          title,
          message,
          actionUrl,
          actionLabel,
          category: 'automation_test',
          contactId: ctx.contact?.id || '',
          automationId: ctx.automationId,
          automationNodeId: node.id,
          metadata: {
            testMode: true,
            testRunId: ctx.testRunId,
            testEffectId: ctx.testEffectId,
            appointmentId: ctx.appointmentId,
            eventType: ctx.eventType,
            configuredRecipientMode: cleanString(config.recipientMode || 'all'),
            routedOnlyToTestOwner: true
          },
          pushTitle: title,
          pushBody: message,
          createBellNotification: delivery.bell,
          sendPushNotification: delivery.push
        })
      : { created: 0, ids: [], push: { sent: 0, skipped: true, reason: 'disabled' } }
    const email = delivery.email
      ? await sendInternalNotificationEmails({
          recipientUserIds: [requestedByUserId],
          title,
          message,
          actionUrl,
          actionLabel
        })
      : { sent: 0, skipped: true, reason: 'disabled' }
    const response = {
      handle: 'out',
      stop: false,
      bellCreated: Number(notification.created || 0),
      pushSent: Number(notification.push?.sent || 0),
      emailSent: Number(email.sent || 0),
      routedOnlyToTestOwner: true
    }
    const delivered = response.bellCreated + response.pushSent + response.emailSent
    const detail = delivered > 0
      ? `Notificación de prueba enviada al dueño de la prueba (${delivered} entrega${delivered === 1 ? '' : 's'}).`
      : 'La notificación de prueba se ejecutó, pero ningún transporte estaba disponible.'
    const receipt = await completeAppointmentTestAction(claim.receipt.id, {
      status: delivered > 0 ? 'sent' : 'failed',
      detail,
      response
    })
    return {
      handle: 'out',
      detail,
      testMode: true,
      auditReceiptId: receipt?.id || claim.receipt.id,
      auditStatus: receipt?.status || (delivered > 0 ? 'sent' : 'failed')
    }
  } catch (error) {
    const receipt = await completeAppointmentTestAction(claim.receipt.id, {
      status: 'failed',
      detail: `No se pudo enviar la notificación de prueba: ${error.message}`,
      response: { handle: 'out', stop: false, error: true }
    })
    return {
      handle: 'out',
      detail: receipt?.detail || error.message,
      testMode: true,
      auditReceiptId: receipt?.id || claim.receipt.id,
      auditStatus: 'failed'
    }
  }
}

async function simulateAppointmentTestNode(node, ctx, detail) {
  const receipt = await recordSimulatedAppointmentTestAction(
    testActionAuditContext(ctx),
    {
      ...testActionAuditNode(ctx, node, 'irreversible-node', { testMode: true }),
      detail
    }
  )
  return {
    handle: 'out',
    detail: receipt?.detail || detail,
    testMode: true,
    simulated: true,
    auditReceiptId: receipt?.id || null,
    auditStatus: 'simulated'
  }
}

function isReadOnlyTestNode(node = {}) {
  return ['logic-condition', 'randomizer', 'logic-goal'].includes(node.type)
}

async function runAppointmentTestFlow(flow, automation, startNodeId, baseCtx) {
  let currentId = startNodeId
  let steps = 0
  const trace = []
  const ctx = {
    ...baseCtx,
    automationId: automation.id,
    automationName: automation.name
  }

  while (currentId && steps < MAX_STEPS) {
    steps += 1
    const node = getNode(flow, currentId)
    if (!node) {
      trace.push({ nodeId: currentId, status: 'error', mode: 'validation', detail: 'El paso ya no existe.' })
      break
    }

    let result
    try {
      await assertAutomationNodeFeatureAccess(node)
      if (node.type === 'action-webhook') {
        result = await executeAppointmentTestWebhook(node, ctx)
      } else if (node.type === 'action-system-notification') {
        result = await executeAppointmentTestSystemNotification(node, ctx)
      } else if (isReadOnlyTestNode(node)) {
        result = await executeNode(node, ctx, { automationId: automation.id, id: '' })
      } else if (node.type === 'logic-wait' || node.type === 'logic-drip') {
        result = await simulateAppointmentTestNode(
          node,
          ctx,
          'Espera simulada: el Modo test continuó inmediatamente sin crear una inscripción pendiente.'
        )
      } else {
        result = await simulateAppointmentTestNode(
          node,
          ctx,
          'Efecto irreversible simulado: no se enviaron mensajes externos ni se modificó el contacto.'
        )
      }
    } catch (error) {
      trace.push({
        nodeId: node.id,
        nodeType: node.type,
        label: nodeLabel(node),
        status: 'error',
        mode: 'validation',
        detail: error.message
      })
      break
    }

    if (result?.output) exposeNodeOutput(ctx, node, result)
    const status = result.auditStatus === 'failed' || result.auditStatus === 'dispatching'
      ? 'error'
      : result.simulated
        ? 'simulated'
        : 'ok'
    trace.push({
      nodeId: node.id,
      nodeType: node.type,
      label: nodeLabel(node),
      status,
      mode: result.simulated ? 'simulated' : (isReadOnlyTestNode(node) ? 'read_only' : 'real'),
      detail: result.detail || '',
      auditReceiptId: result.auditReceiptId || null,
      idempotent: Boolean(result.idempotent)
    })

    if (result.stop) break
    const edge = edgesFrom(flow, node.id, result.handle)[0]
    if (!edge) break
    currentId = edge.targetNodeId
  }

  if (steps >= MAX_STEPS) {
    trace.push({ nodeId: currentId, status: 'error', mode: 'validation', detail: 'Límite de pasos alcanzado.' })
  }
  return trace
}

/**
 * Ejecuta una cita de Modo test sobre el flujo publicado sin crear una
 * inscripción productiva. Sólo los webhooks inequívocamente marcados como test
 * y las notificaciones internas dirigidas al dueño de la prueba salen de
 * verdad. Todo lo demás se recorre y se registra como simulación auditable.
 */
export async function executeTestAutomationEvent(eventType, data = {}) {
  if (!(await canRunBackgroundJob('automations'))) {
    return { executed: false, reason: 'feature_unavailable', matched: [] }
  }

  const eventData = data && typeof data === 'object' ? data : {}
  const testRunId = cleanString(eventData.testRunId || eventData.test_run_id)
  const testEffectId = cleanString(eventData.testEffectId || eventData.test_effect_id)
  const appointmentId = cleanString(eventData.appointmentId || eventData.appointment_id)
  if (!testRunId || !testEffectId || !appointmentId || eventData.isTest !== true) {
    const error = new Error('El motor seguro sólo acepta citas autenticadas de Modo test.')
    error.code = 'test_automation_identity_required'
    throw error
  }
  const run = await db.get(
    'SELECT requested_by_user_id FROM conversational_agent_test_runs WHERE id = ? AND status IN (\'active\', \'expired\')',
    [testRunId]
  )
  if (!run?.requested_by_user_id) {
    const error = new Error('La corrida de Modo test ya no existe o no tiene dueño.')
    error.code = 'test_automation_run_not_found'
    throw error
  }

  const contact = await loadContact(eventData.contactId, {
    phone: eventData.phone,
    name: eventData.contactName
  })
  const ctx = withContactChangeContext(eventType, {
    ...eventData,
    contact,
    messageText: eventData.messageText || '',
    channel: normalizeConversationChannel(eventData.channel || ''),
    testMode: true,
    testRunId,
    testEffectId,
    appointmentId,
    eventType,
    requestedByUserId: cleanString(run.requested_by_user_id)
  })
  const automations = await listPublishedAutomations({ eventType, endpointId: eventData.endpointId })
  const matched = []

  for (const automation of automations) {
    const flow = automation.flow
    const startNode = getStartNode(flow)
    if (!startNode) continue
    const trigger = getTriggers(startNode).find((candidate) => triggerMatches(candidate, eventType, ctx))
    if (!trigger) continue
    const edge = edgesFrom(flow, startNode.id)[0]
    if (!edge) {
      matched.push({ id: automation.id, name: automation.name, valid: false, trace: [], errors: ['El disparador no está conectado a ningún paso.'] })
      continue
    }
    const trace = await runAppointmentTestFlow(flow, automation, edge.targetNodeId, ctx)
    matched.push({
      id: automation.id,
      name: automation.name,
      valid: !trace.some((step) => step.status === 'error'),
      trace,
      errors: trace.filter((step) => step.status === 'error').map((step) => step.detail)
    })
  }

  const flatTrace = matched.flatMap((automation) => automation.trace || [])
  return {
    executed: true,
    testMode: true,
    isolated: true,
    eventType,
    matched,
    matchedCount: matched.length,
    validCount: matched.filter((automation) => automation.valid).length,
    invalidCount: matched.filter((automation) => !automation.valid).length,
    realActionCount: flatTrace.filter((step) => step.mode === 'real' && step.status === 'ok').length,
    simulatedActionCount: flatTrace.filter((step) => step.mode === 'simulated').length,
    failedActionCount: flatTrace.filter((step) => step.status === 'error').length
  }
}

/**
 * Valida qué automatizaciones responderían a un evento de Modo test sin crear
 * inscripciones ni ejecutar mensajes, webhooks, tags, oportunidades o cambios
 * de contacto. Es deliberadamente read-only: esos efectos no se pueden
 * "deshacer" cinco minutos después y por eso no pertenecen a una prueba
 * aislada. La cita y su push de prueba sí recorren sus integraciones propias.
 */
export async function previewAutomationEvent(eventType, data = {}) {
  if (!(await canRunBackgroundJob('automations'))) {
    return { previewed: false, reason: 'feature_unavailable', matched: [] }
  }

  const eventData = data && typeof data === 'object' ? data : {}
  let contact = await loadContact(eventData.contactId, {
    phone: eventData.phone,
    name: eventData.contactName
  })
  if (!contact.id && (eventData.phone || eventData.email)) {
    const row = await db.get(
      'SELECT id FROM contacts WHERE (phone = ? AND ? != \'\') OR (email = ? AND ? != \'\') LIMIT 1',
      [eventData.phone || '', eventData.phone || '', eventData.email || '', eventData.email || '']
    )
    if (row) contact = await loadContact(row.id)
  }

  const ctx = withContactChangeContext(eventType, {
    ...eventData,
    contact,
    messageText: eventData.messageText || '',
    channel: normalizeConversationChannel(eventData.channel || '')
  })
  const automations = await listPublishedAutomations({ eventType, endpointId: eventData.endpointId })
  const matched = []

  for (const automation of automations) {
    const flow = automation.flow
    const startNode = getStartNode(flow)
    if (!startNode) continue
    const trigger = getTriggers(startNode).find((candidate) => triggerMatches(candidate, eventType, ctx))
    if (!trigger) continue

    const errors = []
    if (!edgesFrom(flow, startNode.id).length) {
      errors.push('El disparador no está conectado a ningún paso.')
    }
    for (const node of Array.isArray(flow?.nodes) ? flow.nodes : []) {
      if (!node || node.id === startNode.id || node.type === 'start') continue
      try {
        await assertAutomationNodeFeatureAccess(node)
      } catch (error) {
        errors.push(`${nodeLabel(node) || node.type || 'Paso'}: ${error.message}`)
      }
    }
    matched.push({
      id: automation.id,
      name: automation.name,
      valid: errors.length === 0,
      errors
    })
  }

  return {
    previewed: true,
    isolated: true,
    eventType,
    matched,
    matchedCount: matched.length,
    validCount: matched.filter((automation) => automation.valid).length,
    invalidCount: matched.filter((automation) => !automation.valid).length
  }
}

/**
 * Entrada genérica para cualquier evento del CRM.
 * data: { contactId?, phone?, email?, contactName?, ...campos del evento }
 */
export async function handleAutomationEvent(eventType, data = {}) {
  try {
    if (
      eventType === 'contact-created'
      || eventType === 'contact-updated'
      || eventType === 'tag-changed'
      || eventType === 'payment-received'
      || eventType === 'refund'
      || eventType === 'appointment-booked'
      || eventType === 'appointment-status'
    ) {
      // El dato ya se guardó antes de publicar el evento. Invalidar aun cuando
      // Automatizaciones esté apagado mantiene frescos KPIs y conversiones.
      invalidateTrackingAnalyticsCache()
    }
    if (!(await canRunBackgroundJob('automations'))) return
    const eventData = data
    // (AUTO-008) Corte de cascada: si este evento proviene de acciones encadenadas de
    // otras automatizaciones (etiqueta → dispara otra → etiqueta → …) y ya superamos la
    // profundidad máxima, no inscribimos para no re-disparar en cadena sin tope.
    const cascadeDepth = Number(eventData.__cascadeDepth) || 0
    if (cascadeDepth > MAX_CASCADE_DEPTH) {
      logger.warn(`[Automatizaciones] Cascada de eventos cortada en ${eventType} (profundidad ${cascadeDepth} > ${MAX_CASCADE_DEPTH})`)
      return
    }
    let contact = await loadContact(eventData.contactId, { phone: eventData.phone, name: eventData.contactName })
    // Resolver contacto por teléfono o email cuando no llega id (webhooks)
    if (!contact.id && (eventData.phone || eventData.email)) {
      const row = await db.get(
        'SELECT id FROM contacts WHERE (phone = ? AND ? != \'\') OR (email = ? AND ? != \'\') LIMIT 1',
        [eventData.phone || '', eventData.phone || '', eventData.email || '', eventData.email || '']
      )
      if (row) contact = await loadContact(row.id)
    }
    const ctx = withContactChangeContext(eventType, {
      ...eventData,
      contact,
      messageText: eventData.messageText || '',
      channel: normalizeConversationChannel(eventData.channel || '')
    })
    const automations = await listPublishedAutomations({ eventType, endpointId: eventData.endpointId })
    if (eventType === 'trigger-link-clicked') {
      await resumeWaitingTriggerLinkClicks(ctx)
    }
    await enrollMatching(automations, eventType, ctx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error en evento ${eventType}: ${error.message}`)
  }
}

function weekdayKey(date) {
  return WEEKDAY_KEYS[Math.max(0, Math.min(6, date.weekday - 1))]
}

function normalizeScheduleRecurrence(config = {}) {
  const recurrence = cleanString(config.recurrence)
  if (['daily', 'weekly', 'monthly'].includes(recurrence)) return recurrence
  if (cleanString(config.scheduleMode) === 'recurring') return 'daily'
  return 'none'
}

function resolveScheduleZone(config = {}, flow = {}, accountTimezone = DEFAULT_TIMEZONE) {
  const requested = cleanString(config.timezone || flow?.settings?.timezone)
  if (requested && isValidTimezone(requested)) return requested
  return isValidTimezone(accountTimezone) ? accountTimezone : DEFAULT_TIMEZONE
}

function isScheduleWithinCatchupWindow(scheduledAt, localNow) {
  const minutesLate = localNow.diff(scheduledAt, 'minutes').minutes
  return minutesLate >= 0 && minutesLate <= SCHEDULE_TRIGGER_CATCHUP_MINUTES
}

function scheduledAtForDate(date, base) {
  return date.set({
    hour: base.hour,
    minute: base.minute,
    second: 0,
    millisecond: 0
  })
}

function mostRecentWeeklySchedule(localNow, base, allowedWeekdays) {
  const candidates = allowedWeekdays
    .map((weekday) => WEEKDAY_KEYS.indexOf(weekday) + 1)
    .filter((weekday) => weekday > 0)
    .map((weekday) => {
      const daysSinceWeekday = (localNow.weekday - weekday + 7) % 7
      let candidate = scheduledAtForDate(localNow.minus({ days: daysSinceWeekday }), base)
      if (candidate > localNow) candidate = candidate.minus({ days: 7 })
      return candidate
    })
    .filter((candidate) => candidate.isValid)
    .sort((left, right) => right.toMillis() - left.toMillis())

  return candidates[0] || null
}

function mostRecentMonthlySchedule(localNow, base) {
  let month = localNow.startOf('month')
  for (let index = 0; index < 2; index += 1) {
    if (base.day <= month.daysInMonth) {
      const candidate = scheduledAtForDate(month.set({ day: base.day }), base)
      if (candidate <= localNow) return candidate
    }
    month = month.minus({ months: 1 }).startOf('month')
  }
  return null
}

function computeDueSchedule(config = {}, flow = {}, nowUtc = DateTime.utc(), accountTimezone = DEFAULT_TIMEZONE) {
  const zone = resolveScheduleZone(config, flow, accountTimezone)
  const datetime = cleanString(config.datetime)
  if (!datetime) return null

  const base = DateTime.fromISO(datetime, { zone })
  if (!base.isValid) return null

  const recurrence = normalizeScheduleRecurrence(config)
  const localNow = nowUtc.setZone(zone)
  if (recurrence === 'none') {
    if (!isScheduleWithinCatchupWindow(base, localNow)) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `once:${base.toFormat('yyyyLLddHHmm')}`,
      scheduledFor: base.toUTC().toISO()
    }
  }

  if (localNow < base.minus({ seconds: 1 })) return null

  if (recurrence === 'daily') {
    const allowedWeekdays = Array.isArray(config.weekdays) ? config.weekdays.filter(Boolean) : []
    if (allowedWeekdays.length > 0 && !allowedWeekdays.includes(weekdayKey(localNow))) return null
    const scheduledToday = scheduledAtForDate(localNow, base)
    if (!isScheduleWithinCatchupWindow(scheduledToday, localNow)) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `daily:${scheduledToday.toFormat('yyyyLLdd')}:${base.toFormat('HHmm')}`,
      scheduledFor: scheduledToday.toUTC().toISO()
    }
  }

  if (recurrence === 'weekly') {
    const allowedWeekdays = Array.isArray(config.weekdays) && config.weekdays.length > 0
      ? config.weekdays
      : [weekdayKey(base)]
    const scheduledAt = mostRecentWeeklySchedule(localNow, base, allowedWeekdays)
    if (!scheduledAt || !isScheduleWithinCatchupWindow(scheduledAt, localNow)) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `weekly:${scheduledAt.toFormat('kkkk-WW')}:${weekdayKey(scheduledAt)}:${base.toFormat('HHmm')}`,
      scheduledFor: scheduledAt.toUTC().toISO()
    }
  }

  if (recurrence === 'monthly') {
    const scheduledAt = mostRecentMonthlySchedule(localNow, base)
    if (!scheduledAt || !isScheduleWithinCatchupWindow(scheduledAt, localNow)) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `monthly:${scheduledAt.toFormat('yyyyLL')}:${String(base.day).padStart(2, '0')}:${base.toFormat('HHmm')}`,
      scheduledFor: scheduledAt.toUTC().toISO()
    }
  }

  return null
}

async function claimScheduleRun({ automationId, triggerKey, runKey, scheduledFor }) {
  const id = makeId('sched')
  const result = await db.run(
    `INSERT INTO automation_schedule_runs (id, automation_id, trigger_id, run_key, scheduled_for)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (automation_id, trigger_id, run_key) DO NOTHING`,
    [id, automationId, triggerKey, runKey, scheduledFor]
  )
  return Number(result?.changes || 0) > 0
}

/** Dispara automatizaciones cuyo disparador programado ya llegó. */
export async function processScheduledTriggers(referenceDate = new Date()) {
  try {
    if (!(await canRunBackgroundJob('automations'))) return
    const nowUtc = referenceDate instanceof Date
      ? DateTime.fromJSDate(referenceDate, { zone: 'utc' })
      : DateTime.fromISO(String(referenceDate), { zone: 'utc' })
    if (!nowUtc.isValid) return

    const [automations, accountTimezone] = await Promise.all([
      listPublishedAutomations({ eventType: 'scheduler' }),
      getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
    ])

    for (const automation of automations) {
      const flow = automation.flow || {}
      const startNode = getStartNode(flow)
      if (!startNode) continue
      const triggers = getTriggers(startNode)
      for (let index = 0; index < triggers.length; index += 1) {
        const trigger = triggers[index]
        if (trigger?.type !== 'trigger-scheduler') continue
        const due = computeDueSchedule(trigger.config || {}, flow, nowUtc, accountTimezone)
        if (!due) continue

        const triggerKey = str(trigger.id) || trigger.type
        const claimed = await claimScheduleRun({
          automationId: automation.id,
          triggerKey,
          runKey: due.runKey,
          scheduledFor: due.scheduledFor
        })
        if (!claimed) continue

        await enrollMatching([automation], 'scheduler', {
          scheduleTriggerKey: triggerKey,
          scheduleRunKey: due.runKey,
          scheduleRecurrence: due.recurrence,
          scheduledFor: due.scheduledFor,
          scheduleTimezone: due.timezone
        })
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando horarios programados: ${error.message}`)
  }
}

/** Inscribe contactos que se dejaron programados manualmente desde su ficha. */
export async function processScheduledContactEnrollments(referenceDate = new Date()) {
  if (!(await canRunBackgroundJob('automations'))) return
  const dueDate = referenceDate instanceof Date ? referenceDate : new Date(referenceDate)
  if (Number.isNaN(dueDate.getTime())) return
  const dueAt = dueDate.toISOString()

  try {
    const rows = await db.all(
      `SELECT * FROM automation_contact_enrollment_jobs
       WHERE status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC, created_at ASC
       LIMIT 50`,
      [dueAt]
    )

    for (const row of rows) {
      const claimed = await db.run(
        `UPDATE automation_contact_enrollment_jobs
         SET status = 'processing', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'scheduled'`,
        [row.id]
      )
      if (Number(claimed?.changes || 0) === 0) continue

      const job = { log: parseJson(row.log, []) }
      addLog(job, {
        status: 'processing',
        outcome: 'waiting',
        detail: 'Inscripción programada tomada por el motor'
      })
      await db.run(
        `UPDATE automation_contact_enrollment_jobs
         SET log = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(job.log), row.id]
      )

      try {
        const enrollment = await enrollContactManually({
          automationId: row.automation_id,
          contactId: row.contact_id,
          source: 'manual-scheduled',
          scheduledFor: row.scheduled_at
        })

        addLog(job, {
          status: 'ok',
          outcome: 'success',
          detail: `Inscripción creada correctamente (${enrollment.id})`
        })

        await db.run(
          `UPDATE automation_contact_enrollment_jobs
           SET status = 'completed', enrollment_id = ?, error = NULL, log = ?,
               executed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [enrollment.id, JSON.stringify(job.log), row.id]
        )
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error || 'No se pudo agregar el contacto a la automatización')
        addLog(job, {
          status: 'error',
          outcome: 'error',
          errorMessage,
          detail: `No se pudo ejecutar la inscripción programada: ${errorMessage}`
        })
        await db.run(
          `UPDATE automation_contact_enrollment_jobs
           SET status = 'error', error = ?, log = ?, executed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [errorMessage, JSON.stringify(job.log), row.id]
        )
        logger.warn(`[Automatizaciones] No se pudo ejecutar inscripción programada ${row.id}: ${errorMessage}`)
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando contactos programados: ${error.message}`)
  }
}

/** Tick del programador: reanuda esperas vencidas (duración o timeout) */
export async function processDueResumes() {
  try {
    if (!(await canRunBackgroundJob('automations'))) return
    const rows = await db.all(
      `SELECT * FROM automation_enrollments
       WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ?
       ORDER BY resume_at ASC, entered_at ASC, id ASC
       LIMIT 50`,
      [nowIso()]
    )
    if (rows.length === 0) return
    const automations = await listPublishedAutomations({
      automationIds: rows.map((row) => row.automation_id)
    })

    for (const row of rows) {
      // (AUTO-003/CRON-004) Claim atómico antes de actuar: solo procesamos esta espera
      // si la reclamamos nosotros (status pasa de 'waiting' a 'active'). Sin esto, dos
      // ticks solapados o dos réplicas/deploy ejecutan la misma rama y duplican el
      // WhatsApp/acción visible al contacto.
      const claimed = await db.run(
        `UPDATE automation_enrollments
         SET status = 'active', resume_at = NULL
         WHERE id = ? AND status = 'waiting'`,
        [row.id]
      )
      if (Number(claimed?.changes || 0) === 0) continue

      const automation = automations.find((candidate) => candidate.id === row.automation_id)
      const enrollment = {
        id: row.id,
        automationId: row.automation_id,
        status: 'active',
        currentNodeId: row.current_node_id,
        log: parseJson(row.log, []),
        resumeAt: null,
        waitKind: null,
        context: parseJson(row.context, {})
      }
      if (!automation) {
        // (AUTO-007) Distinguimos "pausada" de "despublicada/archivada". Si la
        // automatización está sólo PAUSADA, no expulsamos al contacto: re-aparcamos la
        // espera tal cual (status 'waiting' con su resume_at original) para que, al
        // reanudarla, los contactos en espera continúen donde estaban en vez de quedar
        // 'exited' irreversibles.
        const automationRow = await db.get('SELECT status FROM automations WHERE id = ?', [row.automation_id])
        if (cleanString(automationRow?.status) === 'paused') {
          await db.run(
            `UPDATE automation_enrollments
             SET status = 'waiting', resume_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'active'`,
            [row.resume_at || null, row.id]
          )
          continue
        }
        enrollment.status = 'exited'
        addLog(enrollment, { nodeId: row.current_node_id, label: 'Flujo', status: 'error', detail: 'La automatización ya no está publicada' })
        await saveEnrollment(enrollment)
        continue
      }
      const contact = await loadContact(row.contact_id)
      const ctx = {
        ...enrollment.context,
        contact,
        messageText: enrollment.context.messageText || '',
        channel: enrollment.context.channel || 'whatsapp',
        businessPhoneNumberId: enrollment.context.businessPhoneNumberId || null,
        automationName: automation.name
      }
      // (AUTO-005) Reintento de un nodo que falló de forma transitoria: re-ejecutamos
      // EL MISMO nodo (no avanzamos por una arista), así el WhatsApp/email que no salió
      // vuelve a intentarse.
      if (row.wait_kind === WAIT_KIND_RETRY) {
        const retryNodeId = str(enrollment.context.__retryNodeId) || row.current_node_id
        addLog(enrollment, {
          nodeId: retryNodeId,
          label: 'Reintento',
          status: 'ok',
          detail: 'Reintentando paso que falló temporalmente'
        })
        await runFrom(automation.flow, enrollment, retryNodeId, ctx)
        continue
      }
      const wasReplyTimeout = row.wait_kind === WAIT_KIND_REPLY
      const wasTriggerLinkTimeout = row.wait_kind === WAIT_KIND_TRIGGER_LINK_CLICK
      const wasDripResume = row.wait_kind === WAIT_KIND_DRIP
      const handle = wasReplyTimeout || wasTriggerLinkTimeout ? 'timeout' : 'out'
      const sourceName = str(enrollment.context.waitActionResourceName)
      const dripBatch = Number(enrollment.context.dripBatch) || 0
      addLog(enrollment, {
        nodeId: row.current_node_id,
        label: wasDripResume ? 'Goteo' : 'Esperar',
        status: 'ok',
        detail: wasDripResume
          ? dripBatch > 0 ? `Goteo liberado: lote ${dripBatch}` : 'Goteo liberado'
          : wasReplyTimeout
            ? sourceName ? `No respondió a "${sourceName}" a tiempo` : 'No respondió a tiempo'
            : wasTriggerLinkTimeout
              ? 'No hubo clic de disparo a tiempo'
              : 'Espera terminada'
      })
      const edge = edgesFrom(automation.flow, row.current_node_id, handle)[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        addLog(enrollment, { nodeId: row.current_node_id, label: wasDripResume ? 'Goteo' : 'Esperar', status: 'ok', detail: 'Fin del flujo' })
        await saveEnrollment(enrollment)
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error reanudando esperas: ${error.message}`)
  }
}

let schedulerStarted = false
let schedulerTickRunning = false

/** Arranca el tick del programador (idempotente) */
export function startAutomationScheduler(intervalMs = 20000) {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(() => {
    if (isDeployShutdownStarted()) return
    // (CRON) Guard anti-solape intra-proceso: si el tick anterior aún corre (una
    // corrida tardó más que el intervalo), no encimamos otra ejecución.
    if (schedulerTickRunning) return
    schedulerTickRunning = true
    trackDeployDrainWork('cron:automation-scheduler', async () => {
      await Promise.all([
        processDueResumes(),
        processScheduledTriggers(),
        processScheduledContactEnrollments()
      ])
    })
      .catch(() => undefined)
      .finally(() => { schedulerTickRunning = false })
  }, intervalMs)
  logger.info('⚙️ Motor de automatizaciones activo (tick cada 20s)')
}
