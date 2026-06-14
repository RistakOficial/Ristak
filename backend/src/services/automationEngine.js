import crypto from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getAccountTimezone, isValidTimezone } from '../utils/dateUtils.js'
import { buildTagMatchKeys, resolveTagIds, tagNamesForIds } from './contactTagsService.js'
import {
  findContactByPhoneCandidates,
  finalizePreparedPhoneUpsert,
  generateContactId,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'

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
const WAIT_KIND_TRIGGER_LINK_CLICK = 'trigger-link-click'
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
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

function normalizeText(value) {
  return String(value || '').trim().toLowerCase()
}

function boolText(value) {
  return value ? 'true' : 'false'
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

function paymentActionMatches(configAction, ctx = {}, eventType = '') {
  const wanted = normalizeText(configAction) || 'successful'
  if (wanted === 'any') return true
  const actual = paymentActionFromContext(ctx, eventType) || 'successful'
  return actual === wanted
}

function paymentDataFromContext(ctx = {}) {
  return {
    id_pago: ctx.paymentId || ctx.payment_id || ctx.id || '',
    monto: ctx.amount ?? '',
    moneda: ctx.currency || '',
    estado: ctx.paymentStatus || ctx.payment_status || ctx.status || '',
    producto: ctx.product || ctx.title || ctx.description || '',
    proveedor: ctx.provider || ctx.paymentProvider || ctx.gateway || '',
    metodo_pago: ctx.paymentMethod || ctx.payment_method || ctx.method || '',
    recibo: ctx.receipt || ctx.reference || ctx.invoiceNumber || ctx.invoiceId || '',
    numero_factura: ctx.invoiceNumber || ctx.invoice_number || '',
    fecha: ctx.paymentDate || ctx.date || ctx.createdAt || ''
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
  return {
    id_formulario: ctx.formId || ctx.form_id || '',
    nombre_formulario: ctx.formName || ctx.form_name || '',
    estado: status,
    descalificado: formDisqualifiedFromContext(ctx),
    id_envio: ctx.submissionId || ctx.submission_id || '',
    fecha_de_envio: ctx.submittedAt || ctx.submitted_at || ctx.createdAt || ctx.created_at || ''
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
  const payment = paymentDataFromContext(ctx)
  if (Object.values(payment).some((value) => value !== '')) {
    setDeepVariable(map, 'pago', payment)
    setDeepVariable(map, 'pago_1', payment)
    map['payment.id'] = String(payment.id_pago ?? '')
    map['payment.amount'] = String(payment.monto ?? '')
    map['payment.currency'] = String(payment.moneda ?? '')
    map['payment.status'] = String(payment.estado ?? '')
    map['payment.product'] = String(payment.producto ?? '')
    map['payment.provider'] = String(payment.proveedor ?? '')
    map['payment.method'] = String(payment.metodo_pago ?? '')
    map['payment.receipt'] = String(payment.recibo ?? '')
    map['payment.invoice_number'] = String(payment.numero_factura ?? '')
    map['payment.date'] = String(payment.fecha ?? '')
  }
  const form = formDataFromContext(ctx)
  if (Object.values(form).some((value) => value !== '' && value !== false)) {
    setDeepVariable(map, 'formulario', form)
    setDeepVariable(map, 'formulario_1', form)
    map['form.id'] = String(form.id_formulario ?? '')
    map['form.name'] = String(form.nombre_formulario ?? '')
    map['form.status'] = String(form.estado ?? '')
    map['form.disqualified'] = boolText(Boolean(form.descalificado))
    map['form.submission_id'] = String(form.id_envio ?? '')
    map['form.submitted_at'] = String(form.fecha_de_envio ?? '')
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

// ---------------------------------------------------------------------------
// Coincidencia de disparadores y filtros
// ---------------------------------------------------------------------------

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

function filterFieldValue(filter, ctx) {
  const contact = ctx.contact || {}
  const custom = contact.customFields || {}
  switch (filter.field) {
    case 'message': return ctx.messageText || ''
    case 'channel': return ctx.channel || ''
    case 'first_name': return contact.firstName || ''
    case 'last_name': return contact.lastName || ''
    case 'source': return contact.source || ''
    case 'email': return contact.email || ''
    case 'phone': return contact.phone || ''
    case 'country': return contact.country || ''
    case 'stage': return contact.stage || custom.stage || ''
    case 'assigned': return contact.assignedUser || custom.assignedUser || ''
    case 'tag': return (contact.tagKeys || contact.tags || []).join(' , ')
    case 'custom': return String(custom[filter.customKey] ?? '')
    // Atribución de anuncios (vive en el contacto)
    case 'ad': return contact.adName || contact.adId || ''
    case 'ad_id': return contact.adId || ''
    case 'attribution_url': return contact.attributionUrl || ''
    case 'medium': return contact.attributionMedium || ''
    // Campos del evento (cita, pago, anuncio…)
    case 'calendar': return ctx.calendarId || null
    case 'appointment_type': return ctx.appointmentType || null
    case 'payment_status': return ctx.paymentStatus || ctx.payment_status || ctx.status || null
    case 'amount': return ctx.amount ?? null
    case 'product': return ctx.product || null
    case 'currency': return ctx.currency || null
    case 'provider': return ctx.provider || ctx.paymentProvider || ctx.gateway || null
    case 'payment_method': return ctx.paymentMethod || ctx.payment_method || ctx.method || null
    case 'payment_id': return ctx.paymentId || ctx.payment_id || ctx.id || null
    case 'receipt': return ctx.receipt || ctx.reference || ctx.invoiceNumber || ctx.invoiceId || ctx.title || ctx.description || null
    case 'invoice_number': return ctx.invoiceNumber || ctx.invoice_number || null
    case 'campaign': return ctx.campaign || null
    case 'form_disqualified': return boolText(formDisqualifiedFromContext(ctx))
    case 'form_status': return ctx.formStatus || ctx.form_status || ctx.submissionStatus || ctx.submission_status || ctx.status || ''
    case 'link': return ctx.triggerLinkName || ctx.triggerLinkPublicId || ctx.triggerLinkId || ''
    case 'trigger_link': return ctx.triggerLinkName || ctx.triggerLinkPublicId || ctx.triggerLinkId || ''
    case 'destination_url': return ctx.destinationUrl || ''
    default: return null // campo sin dato local: no bloquea
  }
}

/** Operadores de filtro que no comparan contra un valor capturado */
const NO_VALUE_FILTER_OPERATORS = new Set(['empty', 'not_empty', 'is_disqualified', 'not_disqualified'])

function evaluateFilter(filter, ctx) {
  const actualRaw = filterFieldValue(filter, ctx)
  if (actualRaw === null) return true
  const actual = normalizeText(actualRaw)
  const expected = normalizeText(filter.value)
  switch (filter.match) {
    case 'not': return actual !== expected
    case 'contains': return actual.includes(expected)
    case 'not_contains': return !actual.includes(expected)
    case 'starts_with': return actual.startsWith(expected)
    case 'ends_with': return actual.endsWith(expected)
    case 'empty': return actual === ''
    case 'not_empty': return actual !== ''
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
  if (!filtersMatch(config.filters, ctx)) return false

  switch (eventType) {
    case 'message-received': {
      if (trigger.type !== 'trigger-customer-replied') return false
      const channel = str(config.channel) || 'any'
      if (channel !== 'any' && channel !== ctx.channel) return false
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
      const changed = (ctx.changedFields || []).map(normalizeText)
      return changed.includes(normalizeText(field)) || changed.includes(normalizeText(field.replace(/^custom:/, '')))
    }

    case 'tag-changed': {
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
      return !form || form === str(ctx.formId)
    }

    case 'scheduler': {
      if (trigger.type !== 'trigger-scheduler') return false
      const triggerKey = str(ctx.scheduleTriggerKey)
      if (!triggerKey) return true
      return triggerKey === (str(trigger.id) || trigger.type)
    }

    case 'appointment-booked': {
      if (trigger.type !== 'trigger-appointment-booked') return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'appointment-status': {
      if (trigger.type !== 'trigger-appointment-status') return false
      const wanted = str(config.status) || 'confirmed'
      const actualRaw = normalizeText(ctx.status)
      const actual = APPOINTMENT_STATUS_ALIASES[actualRaw] || actualRaw
      if (wanted !== actual) return false
      const calendar = str(config.calendar)
      return !calendar || calendar === str(ctx.calendarId)
    }

    case 'payment-received': {
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
      return !product || normalizeText(product) === normalizeText(ctx.product)
    }

    case 'refund':
      if (trigger.type === 'trigger-refund') return true
      if (trigger.type !== 'trigger-payment-received') return false
      if (!str(config.paymentAction)) return false
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
  'message-received': (ctx) => `el contacto respondió por ${ctx.channel}`,
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
    case 'pay-product': return ctx.product || ctx.title || ctx.description || ''
    case 'pay-currency': return ctx.currency || ''
    case 'pay-date': return ctx.paymentDate || ctx.date || ctx.createdAt || ''
    case 'tag-has':
    case 'tag-any-of':
      return (contact.tagKeys || contact.tags || []).join(' , ')
    default: return null
  }
}

function evaluateRule(rule, ctx) {
  const actualRaw = ruleFieldValue(rule, ctx)
  if (actualRaw === null) return { ok: false, known: false }
  const actual = normalizeText(actualRaw)
  const expected = normalizeText(renderTemplate(String(rule.value ?? ''), ctx))
  switch (rule.operator) {
    case 'is': return { ok: actual === expected, known: true }
    case 'is_not': return { ok: actual !== expected, known: true }
    case 'contains': return { ok: actual.includes(expected), known: true }
    case 'not_contains': return { ok: !actual.includes(expected), known: true }
    case 'starts_with': return { ok: actual.startsWith(expected), known: true }
    case 'ends_with': return { ok: actual.endsWith(expected), known: true }
    case 'is_empty': return { ok: actual === '', known: true }
    case 'is_not_empty': return { ok: actual !== '', known: true }
    case 'is_true': return { ok: actual === 'true', known: true }
    case 'is_false': return { ok: actual !== 'true', known: true }
    case 'gt': return { ok: Number(actual) > Number(expected), known: true }
    case 'gte': return { ok: Number(actual) >= Number(expected), known: true }
    case 'lt': return { ok: Number(actual) < Number(expected), known: true }
    case 'lte': return { ok: Number(actual) <= Number(expected), known: true }
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
      formStatus: ctx.formStatus || ctx.form_status || ctx.submissionStatus || ctx.submission_status || ctx.status || null,
      formDisqualified: formDisqualifiedFromContext(ctx),
      submissionId: ctx.submissionId || ctx.submission_id || null,
      submittedAt: ctx.submittedAt || ctx.submitted_at || null,
      scheduledFor: ctx.scheduledFor || null,
      scheduleRunKey: ctx.scheduleRunKey || null,
      scheduleRecurrence: ctx.scheduleRecurrence || null,
      scheduleTimezone: ctx.scheduleTimezone || null
    }
  }
  await db.run(
    `INSERT INTO automation_enrollments
       (id, automation_id, contact_id, contact_name, status, current_node_id, log, context)
     VALUES (?, ?, ?, ?, 'active', 'start', '[]', ?)`,
    [id, automation.id, enrollment.contactId, enrollment.contactName, JSON.stringify(enrollment.context)]
  )
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
  const next = remove
    ? list.filter((candidate) => candidate !== tagId && normalizeText(candidate) !== normalizeText(tag))
    : [...new Set([...list, tagId].filter(Boolean))]
  await db.run('UPDATE contacts SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    JSON.stringify(next),
    ctx.contact.id
  ])
  ctx.contact.tags = next
  // El cambio de etiqueta puede disparar otras automatizaciones
  setImmediate(() => {
    handleAutomationEvent('tag-changed', {
      contactId: ctx.contact.id,
      tag: displayName,
      tagId: tagId || null,
      tagAction: remove ? 'removed' : 'added'
    }).catch(() => undefined)
  })
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
  return contact.fullName || contact.phone || contact.email
    ? `Contacto listo: ${contact.fullName || contact.phone || contact.email}`
    : 'Contacto creado'
}

async function executeFindContact(node, ctx) {
  const config = node.config || {}
  const searchBy = str(config.searchBy) || 'phone'
  const lookupValue = renderedConfigValue(config.lookupValue || defaultLookupValueFor(searchBy, ctx), ctx)
  const found = await findContactByLookup(searchBy, lookupValue)
  if (found?.id) {
    ctx.contact = await loadContact(found.id, ctx.contact || {})
    return { handle: 'out', detail: `Contacto encontrado: ${ctx.contact.fullName || ctx.contact.phone || ctx.contact.email || ctx.contact.id}` }
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
    return { handle: 'out', detail: `Contacto creado: ${contact.fullName || contact.phone || contact.email || contact.id}` }
  }
  return { handle: 'out', detail: 'Contacto no encontrado: continúa sin cambiar contacto' }
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
  return remove
    ? 'Usuario asignado eliminado'
    : `Usuario asignado: ${str(config.userName) || userId}`
}

/** Envía un bloque adjunto: si es un archivo subido a Ristak se manda como
    data URL (el servicio de WhatsApp lo publica); si es URL externa, directo */
async function sendMediaBlock({ block, to, phoneNumberId, ctx }) {
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
    await sendWhatsAppApiImageMessage({ to, imageDataUrl: dataUrl || undefined, imageUrl: externalUrl || undefined, caption, contactId: ctx.contact?.id, phoneNumberId })
  } else if (block.type === 'audio') {
    await sendWhatsAppApiAudioMessage({
      to,
      audioDataUrl: dataUrl || undefined,
      audioUrl: externalUrl || undefined,
      // Nota de voz de WhatsApp (ogg/opus) salvo que el usuario lo apague
      voice: block.voiceNote !== false,
      phoneNumberId
    })
  } else {
    // video y archivo se envían como documento (conserva calidad y nombre)
    await sendWhatsAppApiDocumentMessage({
      to,
      documentDataUrl: dataUrl || undefined,
      documentUrl: externalUrl || undefined,
      filename,
      mimeType,
      caption,
      contactId: ctx.contact?.id,
      phoneNumberId
    })
  }
}

async function sendWhatsAppBlocks(node, ctx) {
  const { sendWhatsAppApiTextMessage, sendWhatsAppApiTemplateMessage } = await import('./whatsappApiService.js')
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

  if (str(config.messageType) === 'template') {
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
        // Variables {{n}}: se rellenan con datos del contacto si traen tokens
        const rawVariables = block.templateVariables || {}
        const variables = {}
        Object.entries(rawVariables).forEach(([key, value]) => {
          const rendered = renderTemplate(String(value ?? ''), ctx, { preserveUnknown: true }).trim()
          if (rendered) variables[key] = rendered
        })

        // Encabezado multimedia: el archivo subido se publica y va como link
        let components
        const headerUrl = str(block.headerMediaUrl)
        if (headerUrl) {
          const { saveWhatsAppImageDataUrl, buildLocalMediaUrl } = await import('./whatsappApiService.js')
          const { extractMediaAssetIdFromUrl, getMediaAssetDataUrl } = await import('./mediaStorageService.js')
          let link = headerUrl
          const mediaAssetId = extractMediaAssetIdFromUrl(headerUrl)
          const assetMatch = /\/api\/automations\/assets\/([\w-]+)/.exec(headerUrl)
          if (mediaAssetId) {
            const media = await getMediaAssetDataUrl(mediaAssetId)
            if (media.mimeType.startsWith('image/')) {
              const localMedia = await saveWhatsAppImageDataUrl(media.dataUrl)
              link = buildLocalMediaUrl(localMedia)
            }
          } else if (assetMatch) {
            const row = await db.get('SELECT * FROM automation_assets WHERE id = ?', [assetMatch[1]])
            if (row && row.content_type.startsWith('image/')) {
              const media = await saveWhatsAppImageDataUrl(`data:${row.content_type};base64,${row.content_base64}`)
              link = buildLocalMediaUrl(media)
            }
          }
          if (link && /^https?:/.test(link)) {
            components = [
              { type: 'header', parameters: [{ type: 'image', image: { link } }] },
              ...(Object.keys(variables).length
                ? [{
                    type: 'body',
                    parameters: Object.keys(variables)
                      .sort((a, b) => Number(a) - Number(b))
                      .map((key) => ({ type: 'text', text: variables[key] }))
                  }]
                : [])
            ]
          }
        }

        await sendWhatsAppApiTemplateMessage({
          to,
          templateId: str(block.templateId) || undefined,
          templateName: str(block.templateName) || undefined,
          ...(components ? { components } : { variables }),
          contactId: ctx.contact?.id,
          phoneNumberId
        })
        sentNames.push(str(block.templateName) || str(block.templateId))
      }
    }
    if (sentNames.length === 0) throw new Error('No hay plantilla seleccionada')
    return sentNames.length === 1
      ? `Plantilla "${sentNames[0]}" enviada`
      : `${sentNames.length} plantillas enviadas (${sentNames.join(', ')})`
  }

  const blocks = Array.isArray(config.messageBlocks) ? config.messageBlocks : []
  let sent = 0
  const notes = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(str(block.compiledText), ctx, { preserveUnknown: true }).trim()
      if (!text) continue
      const buttons = Array.isArray(block.buttons) ? block.buttons.filter((b) => str(b.label).trim()) : []
      const body = buttons.length
        ? `${text}\n\n${buttons.map((b) => `▸ ${b.label.trim()}`).join('\n')}`
        : text
      await sendWhatsAppApiTextMessage({ to, text: body, contactId: ctx.contact?.id, phoneNumberId })
      sent += 1
    } else if (block.type === 'delay') {
      const seconds = Math.min(
        MAX_INLINE_DELAY_SECONDS,
        Math.max(0, (Number(block.amount) || 0) * (block.unit === 'minutes' ? 60 : 1))
      )
      if (seconds > 0) await sleep(seconds * 1000)
    } else if (['image', 'video', 'audio', 'file'].includes(block.type) && str(block.url)) {
      await sendMediaBlock({ block, to, phoneNumberId, ctx })
      sent += 1
    } else {
      notes.push(`adjunto "${block.type}" sin archivo: omitido`)
    }
  }
  if (sent === 0) throw new Error('El mensaje está vacío: configura al menos un globo de texto')
  return `${sent} mensaje${sent > 1 ? 's' : ''} de WhatsApp enviado${sent > 1 ? 's' : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`
}

/**
 * Ejecuta un nodo. Devuelve:
 *  { handle, detail }            → continuar por esa salida
 *  { wait: {kind, resumeAt}, detail } → pausar la inscripción
 *  { skipped: true, handle }     → paso no soportado, se registra y continúa
 */
async function executeNode(node, ctx) {
  switch (node.type) {
    case 'channel-whatsapp':
      return { handle: 'out', detail: await sendWhatsAppBlocks(node, ctx) }

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
        return {
          wait: {
            kind: WAIT_KIND_REPLY,
            resumeAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : null
          },
          detail: 'Esperando la respuesta del contacto'
        }
      }
      if (mode === 'action') {
        const expectedAction = str(config.expectedAction) || 'click_link'
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

    case 'logic-condition': {
      const result = evaluateConditionNode(node.config, ctx)
      return { handle: result.handle, detail: `Condición evaluada → ${result.label}` }
    }

    case 'logic-goal':
      return { handle: 'out', detail: 'Objetivo registrado' }

    case 'action-create-contact':
      return { handle: 'out', detail: await executeCreateContact(node, ctx) }

    case 'action-find-contact':
      return executeFindContact(node, ctx)

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
      result = await executeNode(node, ctx)
    } catch (error) {
      addLog(enrollment, { nodeId: node.id, label: nodeLabel(node), status: 'error', detail: error.message })
      enrollment.status = 'exited'
      logger.warn(`[Automatizaciones] Error en paso ${node.type}: ${error.message}`)
      break
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

async function loadContact(contactId, fallback = {}) {
  const row = contactId ? await db.get('SELECT * FROM contacts WHERE id = ?', [contactId]) : null
  const bag = customFieldsBag(row?.custom_fields)
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
    source: row?.source || bag.source || '',
    country: row?.country || bag.country || '',
    stage: row?.stage || bag.stage || '',
    assignedUser: row?.assigned_user || bag.assignedUser || '',
    // Atribución de anuncios (filtros "Anuncio de origen", "URL de origen"…)
    adName: row?.attribution_ad_name || '',
    adId: row?.attribution_ad_id || '',
    attributionUrl: row?.attribution_url || '',
    attributionMedium: row?.attribution_medium || '',
    customFields: bag,
    tags: storedTags,
    tagKeys
  }
}

async function listPublishedAutomations() {
  const rows = await db.all(`SELECT id, name, COALESCE(published_flow, flow) AS flow FROM automations WHERE status = 'published'`)
  return rows.map((row) => ({ id: row.id, name: row.name, flow: parseJson(row.flow, { nodes: [], edges: [] }) }))
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
export async function handleIncomingMessage({ contactId, phone, contactName, text, channel = 'whatsapp', businessPhoneNumberId = null }) {
  try {
    const contact = await loadContact(contactId, { phone, name: contactName })
    const baseCtx = { contact, messageText: text || '', channel, businessPhoneNumberId }
    const automations = await listPublishedAutomations()

    // 1) Reanudar inscripciones que esperaban respuesta de este contacto
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
      addLog(enrollment, { nodeId: row.current_node_id, label: 'Esperar', status: 'ok', detail: 'El contacto respondió' })
      const edge = edgesFrom(automation.flow, row.current_node_id, 'out')[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        await saveEnrollment(enrollment)
      }
    }

    // 2) Detener flujos configurados con "salir al responder"
    for (const automation of automations) {
      if (automation.flow?.settings?.stopOnContactResponse) {
        await db.run(
          `UPDATE automation_enrollments SET status = 'exited', updated_at = CURRENT_TIMESTAMP
           WHERE automation_id = ? AND contact_id = ? AND status IN ('active', 'waiting') AND wait_kind IS DISTINCT FROM ?`,
          [automation.id, contact.id, WAIT_KIND_REPLY]
        ).catch(async () => {
          // SQLite no soporta IS DISTINCT FROM
          await db.run(
            `UPDATE automation_enrollments SET status = 'exited', updated_at = CURRENT_TIMESTAMP
             WHERE automation_id = ? AND contact_id = ? AND status IN ('active', 'waiting') AND (wait_kind IS NULL OR wait_kind != ?)`,
            [automation.id, contact.id, WAIT_KIND_REPLY]
          )
        })
      }
    }

    // 3) Inscribir en automatizaciones cuyo disparador coincide
    await enrollMatching(automations, 'message-received', baseCtx)
  } catch (error) {
    logger.error(`[Automatizaciones] Error procesando mensaje entrante: ${error.message}`)
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
    let contact = await loadContact(data.contactId, { phone: data.phone, name: data.contactName })
    // Resolver contacto por teléfono o email cuando no llega id (webhooks)
    if (!contact.id && (data.phone || data.email)) {
      const row = await db.get(
        'SELECT id FROM contacts WHERE (phone = ? AND ? != \'\') OR (email = ? AND ? != \'\') LIMIT 1',
        [data.phone || '', data.phone || '', data.email || '', data.email || '']
      )
      if (row) contact = await loadContact(row.id)
    }
    const ctx = { ...data, contact, messageText: data.messageText || '', channel: data.channel || '' }
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

function resolveScheduleZone(config = {}, flow = {}, accountTimezone = 'America/Mexico_City') {
  const requested = cleanString(config.timezone || flow?.settings?.timezone)
  if (requested && isValidTimezone(requested)) return requested
  return isValidTimezone(accountTimezone) ? accountTimezone : 'America/Mexico_City'
}

function computeDueSchedule(config = {}, flow = {}, nowUtc = DateTime.utc(), accountTimezone = 'America/Mexico_City') {
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
      getAccountTimezone().catch(() => 'America/Mexico_City')
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
      const wasReplyTimeout = row.wait_kind === WAIT_KIND_REPLY
      const wasTriggerLinkTimeout = row.wait_kind === WAIT_KIND_TRIGGER_LINK_CLICK
      const handle = wasReplyTimeout || wasTriggerLinkTimeout ? 'timeout' : 'out'
      addLog(enrollment, {
        nodeId: row.current_node_id,
        label: 'Esperar',
        status: 'ok',
        detail: wasReplyTimeout
          ? 'No respondió a tiempo'
          : wasTriggerLinkTimeout
            ? 'No hubo clic de disparo a tiempo'
            : 'Espera terminada'
      })
      const edge = edgesFrom(automation.flow, row.current_node_id, handle)[0]
      if (edge) await runFrom(automation.flow, enrollment, edge.targetNodeId, ctx)
      else {
        enrollment.status = 'completed'
        addLog(enrollment, { nodeId: row.current_node_id, label: 'Esperar', status: 'ok', detail: 'Fin del flujo' })
        await saveEnrollment(enrollment)
      }
    }
  } catch (error) {
    logger.error(`[Automatizaciones] Error reanudando esperas: ${error.message}`)
  }
}

let schedulerStarted = false

/** Arranca el tick del programador (idempotente) */
export function startAutomationScheduler(intervalMs = 20000) {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(() => {
    processDueResumes().catch(() => undefined)
    processScheduledTriggers().catch(() => undefined)
  }, intervalMs)
  logger.info('⚙️ Motor de automatizaciones activo (tick cada 20s)')
}
