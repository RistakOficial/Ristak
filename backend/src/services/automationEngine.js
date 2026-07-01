import { DateTime } from 'luxon'
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { isDeployShutdownStarted, trackDeployDrainWork } from '../utils/deployDrainTracker.js'
import { DEFAULT_TIMEZONE, getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'
import { createInternalNotification } from './notificationsService.js'
import {
  findContactByPhoneCandidates,
  finalizePreparedPhoneUpsert,
  generateContactId,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import { createRistakId } from '../utils/idGenerator.js'

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
const SCHEDULE_TRIGGER_WINDOW_MINUTES = 2
const WAIT_KIND_REPLY = 'reply'
const WAIT_KIND_BUTTON_REPLY = 'button_reply'
const WAIT_KIND_TRIGGER_LINK_CLICK = 'trigger-link-click'
const WAIT_KIND_DRIP = 'drip'
// (AUTO-005) Espera especial para reintentar el MISMO nodo que falló de forma
// transitoria, en vez de expulsar la inscripción ('exited') al primer error.
const WAIT_KIND_RETRY = 'retry'
const RETRY_MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = [60000, 300000, 900000] // 1 min, 5 min, 15 min
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

function setAnswerAlias(target, key, value) {
  const directKey = cleanString(key)
  const normalizedKey = normalizeAnswerLookupKey(directKey)
  if (directKey && target[directKey] === undefined) target[directKey] = value
  if (normalizedKey && target[normalizedKey] === undefined) target[normalizedKey] = value
}

function addFormAnswer(normalized, answer = {}, index = 0) {
  const value = Object.prototype.hasOwnProperty.call(answer, 'value')
    ? answer.value
    : Object.prototype.hasOwnProperty.call(answer, 'answer')
      ? answer.answer
      : ''
  const id = cleanString(answer.id || answer.fieldId || answer.field_id || answer.blockId || answer.block_id)
  const key = cleanString(answer.key || answer.fieldKey || answer.field_key || answer.name || answer.internalName || answer.internal_name)
  const label = cleanString(answer.label || answer.question || answer.title || answer.name || key || id || `Respuesta ${index + 1}`)
  const entry = {
    id,
    key: key || normalizeAnswerLookupKey(label || id || `respuesta_${index + 1}`),
    label,
    value,
    type: cleanString(answer.type || answer.blockType || answer.block_type || '')
  }

  normalized.answers.push(entry)
  setAnswerAlias(normalized.byId, id, value)
  setAnswerAlias(normalized.byKey, entry.key, value)
  setAnswerAlias(normalized.byLabel, label, value)
}

function normalizeFormResponses(raw) {
  const normalized = {
    answers: [],
    byId: {},
    byKey: {},
    byLabel: {},
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
    ['byLabel', source.byLabel || source.by_label]
  ]
  for (const [targetKey, bag] of bags) {
    if (!isPlainObject(bag)) continue
    Object.entries(bag).forEach(([key, value]) => setAnswerAlias(normalized[targetKey], key, value))
  }

  for (const section of ['standard', 'custom', 'system', 'ignored', 'raw']) {
    const bag = source[section]
    if (!isPlainObject(bag)) continue
    Object.entries(bag).forEach(([key, value]) => {
      setAnswerAlias(normalized.byKey, key, value)
      setAnswerAlias(normalized.byKey, `${section}.${key}`, value)
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
  })

  normalized.summary = cleanString(source.summary || source.text) || normalized.answers
    .filter(answer => answer.label || answer.key)
    .map(answer => `${answer.label || answer.key}: ${answerComparableValue(answer.value)}`)
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
    Object.keys(responses.byLabel).length
  )
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
    respuestas_por_id: responses.byId,
    respuestas_por_etiqueta: responses.byLabel,
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
      // comentarios (y viceversa). Se filtra por platform (campo de ctx, no por el
      // canal normalizado, que colapsa *_comment → messenger/instagram).
      if (trigger.type !== 'trigger-facebook-comment' && trigger.type !== 'trigger-instagram-comment') return false
      const wantPlatform = trigger.type === 'trigger-instagram-comment' ? 'instagram' : 'messenger'
      if (str(ctx.platform) !== wantPlatform) return false
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
      return !endpointId || endpointId === str(ctx.endpointId)
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
    case 'contact-first-name': return contact.firstName || ''
    case 'contact-last-name': return contact.lastName || ''
    case 'contact-phone': return contact.phone || ''
    case 'contact-email': return contact.email || ''
    case 'contact-source': return contact.source || ''
    case 'contact-custom-field': return String((contact.customFields || {})[rule.customKey] ?? '')
    case 'conv-last-received': return ctx.messageText || ''
    case 'conv-keyword': return ctx.messageText || ''
    case 'conv-replied': return ctx.messageText ? 'true' : 'false'
    case 'pay-has': return (ctx.paymentId || ctx.payment_id || ctx.amount || ctx.status || ctx.paymentStatus) ? 'true' : 'false'
    case 'pay-status': return ctx.paymentStatus || ctx.payment_status || ctx.status || ''
    case 'pay-amount': return ctx.amount ?? ''
    case 'pay-product': return paymentProductCandidatesFromContext(ctx)[0] || ctx.product || ctx.title || ctx.description || ''
    case 'pay-currency': return ctx.currency || ''
    case 'pay-date': return ctx.paymentDate || ctx.date || ctx.createdAt || ''
    case 'form-submitted': return (ctx.submissionId || ctx.submission_id || primaryFormIdFromContext(ctx)) ? 'true' : 'false'
    case 'form-specific': return primaryFormIdFromContext(ctx)
    case 'form-date': return ctx.submittedAt || ctx.submitted_at || ctx.createdAt || ctx.created_at || ''
    case 'form_disqualified': return boolText(formDisqualifiedFromContext(ctx))
    case 'form-field-value':
    case 'form_field': return formResponseValue(ctx, rule.customKey || rule.custom_key || rule.fieldKey || rule.field_key)
    case 'tag-has':
    case 'tag-any-of':
      return (contact.tagKeys || contact.tags || []).join(' , ')
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
  await db.run(
    `UPDATE automation_enrollments
     SET status = ?, current_node_id = ?, log = ?, resume_at = ?, wait_kind = ?, context = ?,
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
      enrollment.contactId || null,
      enrollment.contactName || null,
      enrollment.id
    ]
  )
}

function addLog(enrollment, entry) {
  enrollment.log.push({ at: nowIso(), ...entry })
  if (enrollment.log.length > 200) enrollment.log = enrollment.log.slice(-200)
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
    resumeAt: null,
    waitKind: null,
    context: {
      messageText: ctx.messageText || '',
      channel: ctx.channel || '',
      businessPhoneNumberId: ctx.businessPhoneNumberId || null,
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
      `SELECT id, automation_id, contact_id, contact_name, status, current_node_id, log, resume_at, wait_kind, context
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
  const url = renderTemplate(str(config.url), ctx, { preserveUnknown: true }).trim()
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

  const headers = webhookHeadersFromConfig(config, ctx)
  const body = webhookBodyFromConfig(config, ctx)
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
  const firstName = renderedConfigValue(overrides.firstName ?? config.firstName, ctx)
  const lastName = renderedConfigValue(overrides.lastName ?? config.lastName, ctx)
  const phone = renderedConfigValue(overrides.phone ?? config.phone, ctx)
  const email = renderedConfigValue(overrides.email ?? config.email, ctx)
  const source = renderedConfigValue(overrides.source ?? config.source, ctx)
  const fullName = compactName(firstName, lastName, overrides.fullName ?? config.fullName)
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

async function resolveNotificationContact(config = {}, ctx = {}) {
  const contactId = cleanString(renderedConfigValue(config.contactId, ctx) || ctx.contact?.id || '')
  if (!contactId) return { contactId: '', contact: ctx.contact || null }
  if (ctx.contact?.id === contactId) return { contactId, contact: ctx.contact }
  return {
    contactId,
    contact: await loadContact(contactId, ctx.contact || {}).catch(() => null)
  }
}

async function executeSystemNotification(node, ctx, enrollment) {
  const config = node.config || {}
  const recipientMode = str(config.recipientMode) || 'all'
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

  const result = await createInternalNotification({
    broadcast,
    recipientUserIds,
    source: 'Automatizaciones',
    severity: 'info',
    title: title || 'Notificación interna',
    message,
    actionUrl,
    actionLabel: notificationActionLabel(config),
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
    pushBody: message
  })

  return {
    handle: 'out',
    detail: broadcast
      ? 'Notificación interna enviada a todos'
      : `Notificación interna enviada a ${recipientUserIds.length} usuario${recipientUserIds.length === 1 ? '' : 's'}`,
    output: {
      estado: result.created > 0 ? 'creada' : 'omitida',
      destinatarios: broadcast ? 'todos' : recipientUserIds.join(', '),
      titulo: title,
      url: actionUrl,
      push_enviados: result.push?.sent || 0
    },
    outputBaseId: 'notificacion'
  }
}

/** Envía un bloque adjunto: si es un archivo subido a Ristak se manda como
    data URL (el servicio de WhatsApp lo publica); si es URL externa, directo */
async function sendMediaBlock({ block, to, phoneNumberId, fromPhone, transport = 'api', allowQrFallback = true, ctx }) {
  const {
    sendWhatsAppApiImageMessage,
    sendWhatsAppApiAudioMessage,
    sendWhatsAppApiDocumentMessage
  } = await import('./whatsappApiService.js')

  const caption = renderTemplate(str(block.caption), ctx, { preserveUnknown: true }).trim() || undefined
  let dataUrl = null
  let externalUrl = null
  let filename = str(block.caption) || 'archivo'
  let mimeType

  const mediaUrl = str(block.url)
  const { extractMediaAssetIdFromUrl, getMediaAssetDataUrl } = await import('./mediaStorageService.js')
  const mediaAssetId = extractMediaAssetIdFromUrl(mediaUrl)
  const assetMatch = /\/api\/automations\/assets\/([\w-]+)/.exec(mediaUrl)
  if (mediaAssetId) {
    const media = await getMediaAssetDataUrl(mediaAssetId)
    dataUrl = media.dataUrl
    mimeType = media.mimeType
    filename = media.filename || filename
  } else if (assetMatch) {
    const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetMatch[1]])
    if (!row) throw new Error('El archivo adjunto ya no existe')
    dataUrl = `data:${row.content_type};base64,${row.content_base64}`
    mimeType = row.content_type
    filename = row.filename || filename
  } else {
    externalUrl = mediaUrl
  }

  if (block.type === 'image') {
    return sendWhatsAppApiImageMessage({ to, from: fromPhone, imageDataUrl: dataUrl || undefined, imageUrl: externalUrl || undefined, caption, contactId: ctx.contact?.id, phoneNumberId, transport, allowQrFallback })
  } else if (block.type === 'audio') {
    return sendWhatsAppApiAudioMessage({
      to,
      from: fromPhone,
      audioDataUrl: dataUrl || undefined,
      audioUrl: externalUrl || undefined,
      // Nota de voz de WhatsApp (ogg/opus) salvo que el usuario lo apague
      voice: block.voiceNote !== false,
      phoneNumberId,
      transport,
      allowQrFallback
    })
  } else {
    // video y archivo se envían como documento (conserva calidad y nombre)
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

function isQrSenderReady(row = {}) {
  return Number(row.qr_send_enabled || 0) === 1 &&
    cleanString(row.qr_status).toLowerCase() === 'connected'
}

function whatsappSenderPhone(row = {}) {
  return cleanString(row.phone_number) || cleanString(row.display_phone_number)
}

async function resolveAutomationQrSender(preferredPhoneNumberId) {
  const preferred = await loadWhatsAppPhoneSnapshot(preferredPhoneNumberId)
  if (preferred && isQrSenderReady(preferred)) {
    return {
      phoneNumberId: preferred.id,
      fromPhone: whatsappSenderPhone(preferred)
    }
  }

  const fallback = await db.get(`
    SELECT id, phone_number, display_phone_number, verified_name, label,
      is_default_sender, qr_send_enabled, qr_status, updated_at
    FROM whatsapp_api_phone_numbers
    WHERE qr_send_enabled = 1 AND LOWER(COALESCE(qr_status, '')) = 'connected'
    ORDER BY is_default_sender DESC, updated_at DESC
    LIMIT 1
  `)

  if (!fallback) {
    throw new Error('No hay un número de WhatsApp conectado por QR para esta automatización')
  }

  return {
    phoneNumberId: fallback.id,
    fromPhone: whatsappSenderPhone(fallback)
  }
}

function shouldRetryWhatsAppAutomationViaQr(error) {
  const message = cleanString(error?.message)
  if (!message) return false
  const normalized = message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  return (
    normalized.includes('whatsapp_api no esta conectado') ||
    normalized.includes('whatsapp api no esta conectado') ||
    normalized.includes('falta el numero emisor') ||
    normalized.includes('restricc') ||
    normalized.includes('bloque') ||
    normalized.includes('quality') ||
    normalized.includes('messaging limit') ||
    normalized.includes('customer service window') ||
    normalized.includes('outside the 24') ||
    normalized.includes('24 horas') ||
    /\b(470|131021|131026|131047)\b/.test(normalized)
  )
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

async function sendWhatsAppAutomationMessage({ send, allowQrFallback, phoneNumberId, fromPhone, description }) {
  try {
    return await send({ phoneNumberId, fromPhone, transport: 'api', allowQrFallback })
  } catch (error) {
    if (!allowQrFallback || !shouldRetryWhatsAppAutomationViaQr(error)) throw error

    const qrSender = await resolveAutomationQrSender(phoneNumberId)
    logger.warn(`[Automatizaciones] WhatsApp API no disponible; usando QR como respaldo para ${description || 'mensaje'}: ${error.message}`)
    return send({
      phoneNumberId: qrSender.phoneNumberId,
      fromPhone: qrSender.fromPhone,
      transport: 'qr',
      allowQrFallback: true
    })
  }
}

async function sendWhatsAppBlocks(node, ctx) {
  const {
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

  const allowQrFallback = str(config.messageType) !== 'template' && (
    config.sendViaQr === true ||
    str(config.transport).toLowerCase() === 'qr'
  )
  let fromPhone

  if (str(config.messageType) === 'template') {
    const { buildDefaultMessageTemplateSendComponents } = await import('./messageTemplatesService.js')
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
          phoneNumberId
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
          allowQrFallback,
          phoneNumberId,
          fromPhone,
          description: 'botones de WhatsApp',
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
          allowQrFallback,
          phoneNumberId,
          fromPhone,
          description: 'botón de URL de WhatsApp',
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
          allowQrFallback,
          phoneNumberId,
          fromPhone,
          description: 'mensaje de texto de WhatsApp',
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
    } else if (['image', 'video', 'audio', 'file'].includes(block.type) && str(block.url)) {
      const response = await sendWhatsAppAutomationMessage({
        allowQrFallback,
        phoneNumberId,
        fromPhone,
        description: `adjunto de WhatsApp (${block.type})`,
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
    } else {
      notes.push(`adjunto "${block.type}" sin archivo: omitido`)
    }
  }
  if (sent === 0) throw new Error('El mensaje está vacío: configura al menos un globo de texto')
  return {
    detail: `${sent} mensaje${sent > 1 ? 's' : ''} de WhatsApp enviado${sent > 1 ? 's' : ''} por ${whatsappTransportLabel(transports)}${notes.length ? ` (${notes.join(', ')})` : ''}`
  }
}

async function sendMetaSocialBlocks(node, ctx, platform) {
  const { sendMetaSocialTextMessage } = await import('./metaSocialMessagingService.js')
  const config = node.config || {}
  const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  const sentMessages = []
  const notes = []

  for (const block of blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(str(block.compiledText || block.text || block.message), ctx, { preserveUnknown: true }).trim()
      if (!text) continue
      await sendMetaSocialTextMessage({
        contactId: ctx.contact?.id,
        platform,
        message: text,
        externalId: `${ctx.automationId || 'automation'}:${ctx.enrollmentId || ''}:${node.id}:${sentMessages.length + 1}`
      })
      sentMessages.push(text)
    } else if (block.type === 'delay') {
      const seconds = Math.min(
        MAX_INLINE_DELAY_SECONDS,
        Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
      )
      if (seconds > 0) await sleep(seconds * 1000)
    } else if (block.type) {
      notes.push(`bloque "${block.type}" sin soporte en ${platform}: omitido`)
    }
  }

  if (sentMessages.length === 0) {
    throw new Error(`El mensaje de ${platform === 'instagram' ? 'Instagram' : 'Messenger'} está vacío: configura al menos un globo de texto`)
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

/**
 * Ejecuta un nodo. Devuelve:
 *  { handle, detail }            → continuar por esa salida
 *  { wait: {kind, resumeAt}, detail } → pausar la inscripción
 *  { skipped: true, handle }     → paso no soportado, se registra y continúa
 */
async function executeNode(node, ctx, enrollment) {
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
      const sendResult = await sendMetaSocialBlocks(node, ctx, 'messenger')
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
      const sendResult = await sendMetaSocialBlocks(node, ctx, 'instagram')
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
        enrollment.context = { ...enrollment.context, __retryAttempts: nextAttempt, __retryNodeId: node.id }
        enrollment.currentNodeId = node.id
        enrollment.status = 'waiting'
        enrollment.waitKind = WAIT_KIND_RETRY
        enrollment.resumeAt = new Date(Date.now() + backoffMs).toISOString()
        addLog(enrollment, {
          nodeId: node.id,
          label: nodeLabel(node),
          status: 'waiting',
          detail: `Error temporal (${error.message}); reintento ${nextAttempt}/${RETRY_MAX_ATTEMPTS} programado`
        })
        logger.warn(`[Automatizaciones] Error temporal en paso ${node.type}, reintento ${nextAttempt}/${RETRY_MAX_ATTEMPTS}: ${error.message}`)
        break
      }
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'error', detail: `${error.message} (sin más reintentos)` })
      enrollment.status = 'exited'
      logger.warn(`[Automatizaciones] Error en paso ${node.type} tras ${retryAttempts} reintentos: ${error.message}`)
      break
    }

    // (AUTO-005) El nodo se ejecutó sin lanzar: limpiamos el contador de reintentos
    // para que un fallo posterior empiece de cero y no herede intentos de otro nodo.
    if (enrollment.context?.__retryAttempts || enrollment.context?.__retryNodeId) {
      const { __retryAttempts, __retryNodeId, ...restContext } = enrollment.context
      enrollment.context = restContext
    }

    if (result.wait) {
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'waiting', detail: result.detail })
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

    addLog(enrollment, {
      nodeId: node.id,
      label: nodeLabel(node),
      status: result.skipped ? 'skipped' : 'ok',
      detail: result.detail
    })

    if (result.stop) {
      enrollment.status = 'exited'
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
      hasActiveAppointment: false
    }
  }

  const [paymentAgg, appointmentAgg, activeAppointment] = await Promise.all([
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
    `, [contactId]).catch(() => null)
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
    activeAppointmentDate: activeAppointment?.start_time || ''
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
      is_default_sender, qr_send_enabled, qr_status, updated_at
    FROM whatsapp_api_phone_numbers
    WHERE id = ?
  `, [id]).catch(() => null)
}

async function listPublishedAutomations() {
  const rows = await db.all(`SELECT id, name, COALESCE(published_flow, flow) AS flow FROM automations WHERE status = 'published'`)
  return rows.map((row) => ({ id: row.id, name: row.name, flow: parseJson(row.flow, { nodes: [], edges: [] }) }))
}

async function getPublishedAutomation(automationId) {
  const id = cleanString(automationId)
  if (!id) throw engineError(400, 'Selecciona una automatización')

  const row = await db.get(
    `SELECT id, name, COALESCE(published_flow, flow) AS flow
     FROM automations
     WHERE id = ? AND status = 'published'`,
    [id]
  )
  if (!row) throw engineError(404, 'Automatización publicada no encontrada')
  return { id: row.id, name: row.name, flow: parseJson(row.flow, { nodes: [], edges: [] }) }
}

function mapEnrollmentResult(enrollment) {
  return {
    id: enrollment.id,
    automationId: enrollment.automationId,
    contactId: enrollment.contactId || null,
    contactName: enrollment.contactName || 'Contacto',
    status: enrollment.status || 'active',
    currentNodeId: enrollment.currentNodeId || null,
    log: enrollment.log || [],
    enteredAt: enrollment.enteredAt || null,
    updatedAt: enrollment.updatedAt || null
  }
}

export async function enrollContactManually({ automationId, contactId, source = 'manual', scheduledFor = null } = {}) {
  const cleanContactId = cleanString(contactId)
  if (!cleanContactId) throw engineError(400, 'Selecciona un contacto')

  const contactExists = await db.get('SELECT id FROM contacts WHERE id = ?', [cleanContactId])
  if (!contactExists) throw engineError(404, 'Contacto no encontrado')

  const automation = await getPublishedAutomation(automationId)
  const flow = automation.flow || {}
  const startNode = getStartNode(flow)
  if (!startNode) throw engineError(400, 'La automatización no tiene inicio configurado')

  const contact = await loadContact(cleanContactId)
  const settings = flow.settings || {}
  if (settings.preventDuplicateActiveEnrollment !== false) {
    const active = await db.get(
      `SELECT id FROM automation_enrollments
       WHERE automation_id = ? AND contact_id = ? AND status IN ('active','waiting')`,
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

async function resumeWaitingTriggerLinkClicks(automations, baseCtx) {
  const contact = baseCtx.contact || {}
  if (!contact.id || !hasTriggerLinkEventContext(baseCtx)) return

  const waiting = await db.all(
    `SELECT * FROM automation_enrollments
     WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
    [contact.id, WAIT_KIND_TRIGGER_LINK_CLICK]
  )

  for (const row of waiting) {
    const automation = automations.find((candidate) => candidate.id === row.automation_id)
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
    const automations = await listPublishedAutomations()

    // 1) Reanudar inscripciones que esperaban un botón de este contacto
    const waitingButtons = await db.all(
      `SELECT * FROM automation_enrollments WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
      [contact.id, WAIT_KIND_BUTTON_REPLY]
    )
    for (const row of waitingButtons) {
      const automation = automations.find((candidate) => candidate.id === row.automation_id)
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
    const waiting = await db.all(
      `SELECT * FROM automation_enrollments WHERE contact_id = ? AND status = 'waiting' AND wait_kind = ?`,
      [contact.id, WAIT_KIND_REPLY]
    )
    for (const row of waiting) {
      const automation = automations.find((candidate) => candidate.id === row.automation_id)
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
    for (const automation of automations) {
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
    await enrollMatching(automations, 'message-received', baseCtx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando mensaje entrante: ${error.message}`)
  }
}

// Ejecuta las respuestas inline configuradas en un disparo de comentario:
// pública (en el post) y/o por DM privado, con variables renderizadas. Respeta
// 'first_only' (una sola vez por persona por publicación). Echo-safe: nuestra
// respuesta pública vuelve como isEcho y no re-dispara.
async function maybeReplyToCommentFromTrigger(trigger, ctx) {
  const config = trigger.config || {}
  const contactId = ctx.contact?.id
  const commentId = str(ctx.commentId)
  if (!contactId || !commentId) return
  if (!config.publicReplyEnabled && !config.dmReplyEnabled) return

  const platform = str(ctx.platform) === 'instagram' ? 'instagram' : 'messenger'
  const postId = str(ctx.postId)

  if (str(config.allowedComments) === 'first_only') {
    const already = await db.get(
      `SELECT 1 FROM meta_social_messages
       WHERE contact_id = ? AND platform = ?
         AND message_type IN ('comment_reply_public','comment_reply_private')
         AND COALESCE(post_id, '') = ?
       LIMIT 1`,
      [contactId, platform, postId]
    ).catch(() => null)
    if (already) return
  }

  const { sendMetaSocialCommentReply } = await import('./metaSocialMessagingService.js')

  if (config.publicReplyEnabled) {
    const text = renderTemplate(str(config.publicReply), ctx, { preserveUnknown: true }).trim()
    if (text) {
      await sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'public', commentId, postId })
        .catch((error) => logger.warn(`[Automatizaciones] Respuesta pública a comentario falló: ${error.message}`))
    }
  }

  if (config.dmReplyEnabled) {
    const text = renderTemplate(str(config.dmReply), ctx, { preserveUnknown: true }).trim()
    if (text) {
      await sendMetaSocialCommentReply({ contactId, platform, message: text, replyType: 'private', commentId, postId })
        .catch((error) => logger.warn(`[Automatizaciones] Respuesta privada a comentario falló: ${error.message}`))
    }
  }
}

async function enrollMatching(automations, eventType, baseCtx) {
  const contact = baseCtx.contact || {}
  for (const automation of automations) {
    const flow = automation.flow
    const startNode = getStartNode(flow)
    if (!startNode) continue
    const matched = getTriggers(startNode).find((trigger) => triggerMatches(trigger, eventType, baseCtx))
    if (!matched) continue

    // Respuestas inline del disparo de comentario (público / DM), configuradas en
    // el propio trigger. Se ejecutan al empatar, aunque el contacto ya esté
    // inscrito, porque cada comentario nuevo merece su respuesta.
    if (eventType === 'comment-received') {
      await maybeReplyToCommentFromTrigger(matched, baseCtx).catch((error) => {
        logger.warn(`[Automatizaciones] Respuesta inline a comentario falló: ${error.message}`)
      })
    }

    const settings = flow.settings || {}
    if (contact.id && settings.preventDuplicateActiveEnrollment !== false) {
      const active = await db.get(
        `SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? AND status IN ('active','waiting')`,
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

/**
 * Entrada genérica para cualquier evento del CRM.
 * data: { contactId?, phone?, email?, contactName?, ...campos del evento }
 */
export async function handleAutomationEvent(eventType, data = {}) {
  try {
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
    const automations = await listPublishedAutomations()
    if (eventType === 'trigger-link-clicked') {
      await resumeWaitingTriggerLinkClicks(automations, ctx)
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

function computeDueSchedule(config = {}, flow = {}, nowUtc = DateTime.utc(), accountTimezone = DEFAULT_TIMEZONE) {
  const zone = resolveScheduleZone(config, flow, accountTimezone)
  const datetime = cleanString(config.datetime)
  if (!datetime) return null

  const base = DateTime.fromISO(datetime, { zone })
  if (!base.isValid) return null

  const recurrence = normalizeScheduleRecurrence(config)
  const localNow = nowUtc.setZone(zone)
  const scheduledToday = localNow.set({
    hour: base.hour,
    minute: base.minute,
    second: 0,
    millisecond: 0
  })
  const minutesAfterScheduled = localNow.diff(scheduledToday, 'minutes').minutes
  if (minutesAfterScheduled < 0 || minutesAfterScheduled > SCHEDULE_TRIGGER_WINDOW_MINUTES) return null

  if (recurrence === 'none') {
    if (scheduledToday.toFormat('yyyyLLddHHmm') !== base.toFormat('yyyyLLddHHmm')) return null
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
    if (!allowedWeekdays.includes(weekdayKey(localNow))) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `weekly:${scheduledToday.toFormat('kkkk-WW')}:${weekdayKey(localNow)}:${base.toFormat('HHmm')}`,
      scheduledFor: scheduledToday.toUTC().toISO()
    }
  }

  if (recurrence === 'monthly') {
    if (localNow.day !== base.day) return null
    return {
      recurrence,
      timezone: zone,
      runKey: `monthly:${scheduledToday.toFormat('yyyyLL')}:${String(base.day).padStart(2, '0')}:${base.toFormat('HHmm')}`,
      scheduledFor: scheduledToday.toUTC().toISO()
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
    const nowUtc = referenceDate instanceof Date
      ? DateTime.fromJSDate(referenceDate, { zone: 'utc' })
      : DateTime.fromISO(String(referenceDate), { zone: 'utc' })
    if (!nowUtc.isValid) return

    const [automations, accountTimezone] = await Promise.all([
      listPublishedAutomations(),
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

      try {
        const enrollment = await enrollContactManually({
          automationId: row.automation_id,
          contactId: row.contact_id,
          source: 'manual-scheduled',
          scheduledFor: row.scheduled_at
        })

        await db.run(
          `UPDATE automation_contact_enrollment_jobs
           SET status = 'completed', enrollment_id = ?, error = NULL,
               executed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [enrollment.id, row.id]
        )
      } catch (error) {
        await db.run(
          `UPDATE automation_contact_enrollment_jobs
           SET status = 'error', error = ?, executed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [error.message || 'No se pudo agregar el contacto a la automatización', row.id]
        )
        logger.warn(`[Automatizaciones] No se pudo ejecutar inscripción programada ${row.id}: ${error.message}`)
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando contactos programados: ${error.message}`)
  }
}

/** Tick del programador: reanuda esperas vencidas (duración o timeout) */
export async function processDueResumes() {
  try {
    const rows = await db.all(
      `SELECT * FROM automation_enrollments
       WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ?
       LIMIT 50`,
      [nowIso()]
    )
    if (rows.length === 0) return
    const automations = await listPublishedAutomations()

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
