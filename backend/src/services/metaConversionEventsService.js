import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import {
  getMetaConfig,
  getMetaSocialConfig,
  getMetaWhatsAppBusinessAccountId,
  resolveMetaCapiAccessToken
} from './metaAdsService.js'
import { getActiveMetaTestEventCode } from '../utils/metaTestCode.js'
import { PAYMENT_MODE_LIVE, PAYMENT_MODE_TEST, normalizePaymentMode } from '../utils/paymentMode.js'
import { buildPhoneMatchCandidates } from '../utils/phoneUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { buildMetaParameterUserData, sanitizeMetaUrlForEvent } from './metaParameterManagerService.js'
import { parseContactCustomFields } from '../utils/contactCustomFields.js'
import { renderTemplate } from './automationEngine.js'
import { getVariableFieldValueMap } from './variableFieldsService.js'
import { applyWhatsAppQrPaidLabelForContact } from './whatsappQrService.js'
import { describeMetaCapiResponseError, safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js'
import {
  resolveConversionAttribution,
  persistPaymentConversionAttribution,
  persistAppointmentConversionAttribution,
  detectConversionSurface,
  getLatestContactWebSession
} from './conversionAttributionService.js'

const CONFIG_KEYS = {
  scheduleEnabled: 'meta_whatsapp_schedule_enabled',
  purchaseEnabled: 'meta_whatsapp_purchase_enabled',
  scheduleEventName: 'meta_whatsapp_schedule_event_name',
  purchaseEventName: 'meta_whatsapp_purchase_event_name',
  paymentPurchaseEventConfig: 'meta_payment_purchase_event_config'
}

const EVENT_TYPES = {
  schedule: 'appointment_booked',
  purchase: 'first_purchase'
}
const DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME = 'Purchase'
const DEFAULT_PAYMENT_EVENT_NAME = 'Purchase'
const DEFAULT_PAYMENT_EVENT_CHANNEL = 'smart'
const QR_LABEL_FALLBACK_PAYMENT_META_CONFIG = {
  enabled: true,
  channel: DEFAULT_PAYMENT_EVENT_CHANNEL,
  eventName: DEFAULT_PAYMENT_EVENT_NAME,
  parameters: {
    sendValue: true,
    usePaymentPlanTotalValue: true,
    value: '',
    predictedLtv: '',
    custom: []
  }
}
const PAYMENT_META_DEFAULT_CURRENCY = 'MXN'
const PAYMENT_META_MAX_CUSTOM_PARAMETERS = 12
const META_ACTION_SOURCES = new Set([
  'app',
  'business_messaging',
  'chat',
  'email',
  'other',
  'phone_call',
  'physical_store',
  'system_generated',
  'website'
])
const BUSINESS_MESSAGING_EVENT_CHANNELS = new Set(['whatsapp', 'messenger', 'instagram'])

const CONTACT_SENT_FIELDS = {
  [EVENT_TYPES.schedule]: {
    sent: 'meta_schedule_event_sent',
    sentAt: 'meta_schedule_event_sent_at',
    eventId: 'meta_schedule_event_id'
  },
  [EVENT_TYPES.purchase]: {
    sent: 'meta_purchase_event_sent',
    sentAt: 'meta_purchase_event_sent_at',
    eventId: 'meta_purchase_event_id'
  }
}

const SUCCESS_PAYMENT_STATUSES = new Set([
  'paid',
  'succeeded',
  'completed',
  'complete',
  'fulfilled',
  'success'
])

function parseBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === '') return defaultValue
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1

  const normalized = String(value).trim().toLowerCase()
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)
}

function cleanString(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeCalendarWhatsappCustomEvents(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const eventSource = source.customEvents && typeof source.customEvents === 'object'
    ? source.customEvents
    : source.custom_events && typeof source.custom_events === 'object'
      ? source.custom_events
      : source
  const channel = cleanString(eventSource.channel || eventSource.conversionChannel || eventSource.conversion_channel || 'site').toLowerCase()
  const eventName = normalizeBusinessMessagingEventName(eventSource.eventName || eventSource.event_name || DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME)

  return {
    enabled: parseBoolean(eventSource.enabled, false),
    channel: BUSINESS_MESSAGING_EVENT_CHANNELS.has(channel) ? channel : channel === 'smart' ? 'smart' : 'site',
    eventName: eventName || DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME
  }
}

function hasStructuredPaymentMetaPurchaseEventConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  return Object.prototype.hasOwnProperty.call(value, 'enabled')
    || Object.prototype.hasOwnProperty.call(value, 'channel')
    || Object.prototype.hasOwnProperty.call(value, 'eventName')
    || Object.prototype.hasOwnProperty.call(value, 'event_name')
    || Object.prototype.hasOwnProperty.call(value, 'conversionChannel')
    || Object.prototype.hasOwnProperty.call(value, 'conversion_channel')
    || Object.prototype.hasOwnProperty.call(value, 'parameters')
}

function normalizePaymentMetaPurchaseEventCustomParameterKey(value = '') {
  const key = cleanString(value)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)

  if (!key) return ''
  return /^[a-zA-Z_]/.test(key) ? key : `param_${key}`
}

function normalizePaymentMetaPurchaseEventParameters(value = {}) {
  const source = value && typeof value === 'object' ? value : parseJson(value, {})

  const rawCustom = Array.isArray(source.custom)
    ? source.custom
    : Array.isArray(source.customParameters)
      ? source.customParameters
      : Array.isArray(source.custom_parameters)
        ? source.custom_parameters
        : []

  const custom = rawCustom
    .map((parameter = {}) => ({
      id: cleanString(parameter.id),
      key: cleanString(parameter.key || parameter.name),
      value: cleanString(parameter.value)
    }))
    .filter(parameter => parameter.key || parameter.value)
    .slice(0, PAYMENT_META_MAX_CUSTOM_PARAMETERS)

  return {
    sendValue: Object.prototype.hasOwnProperty.call(source, 'sendValue')
      ? parseBoolean(source.sendValue, true)
      : true,
    usePaymentPlanTotalValue: Object.prototype.hasOwnProperty.call(source, 'usePaymentPlanTotalValue')
      ? parseBoolean(source.usePaymentPlanTotalValue, true)
      : true,
    value: cleanString(source.value),
    predictedLtv: cleanString(source.predictedLtv || source.predicted_ltv),
    custom
  }
}

function paymentContactCustomFieldBag(contact = {}) {
  const bag = {}
  parseContactCustomFields(contact?.custom_fields || contact?.customFields).forEach((field = {}) => {
    const key = cleanString(field.fieldKey || field.field_key || field.key || field.id)
    if (!key) return
    bag[key] = field.value ?? ''
  })
  return bag
}

function normalizeContactForPaymentMetaTemplate(contact = {}, contactId = '') {
  const fullName = cleanString(contact.fullName || contact.full_name || contact.name)
  const firstName = cleanString(contact.firstName || contact.first_name) || fullName.split(' ')[0] || ''
  const lastName = cleanString(contact.lastName || contact.last_name)
  return {
    id: cleanString(contact.id || contactId),
    firstName,
    lastName,
    first_name: firstName,
    last_name: lastName,
    fullName,
    full_name: fullName,
    name: fullName || firstName,
    phone: cleanString(contact.phone),
    email: cleanString(contact.email),
    customFields: paymentContactCustomFieldBag(contact)
  }
}

function buildPaymentMetaTemplateContext({ contact = {}, contactId = '', payment = {}, currency = '', variableFields = {} } = {}) {
  const metadata = getPaymentMetadata(payment)
  const amount = payment.amount ?? metadata.amount ?? ''
  const status = payment.status || payment.paymentStatus || payment.payment_status || metadata.status || ''
  const product = payment.title || payment.description || metadata.product || metadata.product_name || metadata.content_name || ''
  const normalizedCurrency = normalizeMetaCurrency(currency || payment.currency || metadata.currency || PAYMENT_META_DEFAULT_CURRENCY)
  return {
    contact: normalizeContactForPaymentMetaTemplate(contact, contactId),
    contactId: cleanString(contactId || contact?.id),
    variable: variableFields && typeof variableFields === 'object' ? variableFields : {},
    payment: {
      ...payment,
      id: payment.id || payment.payment_id || metadata.payment_id || '',
      public_id: payment.public_payment_id || payment.publicPaymentId || metadata.public_payment_id || '',
      amount,
      currency: normalizedCurrency,
      status,
      product,
      provider: payment.provider || payment.payment_provider || metadata.provider || '',
      paymentProvider: payment.provider || payment.payment_provider || metadata.provider || '',
      payment_method: payment.payment_method || payment.paymentMethod || metadata.payment_method || '',
      date: payment.created_at || payment.createdAt || payment.paid_at || payment.paidAt || ''
    },
    paymentId: payment.id || payment.payment_id || metadata.payment_id || '',
    amount,
    currency: normalizedCurrency,
    paymentStatus: status,
    product
  }
}

function renderPaymentMetaParameterValue(value, templateContext = {}) {
  const source = cleanString(value)
  if (!source) return ''
  if (!source.includes('{{')) return source
  return cleanString(renderTemplate(source, templateContext, { preserveUnknown: false }))
}

function normalizePaymentMetaPurchaseEventConfig(value = null) {
  const source = parseJson(value, {})
  const eventSource = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const channel = cleanString(
    eventSource.channel ||
    eventSource.conversionChannel ||
    eventSource.conversion_channel
  ).toLowerCase()

  return {
    enabled: parseBoolean(eventSource.enabled, false),
    channel: ['site', 'whatsapp', 'smart', 'messenger', 'instagram'].includes(channel) ? channel : DEFAULT_PAYMENT_EVENT_CHANNEL,
    eventName: DEFAULT_PAYMENT_EVENT_NAME,
    parameters: normalizePaymentMetaPurchaseEventParameters(eventSource.parameters || {})
  }
}

function jsonForLog(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ serializationError: true })
  }
}

function parseMetaNumber(value) {
  const raw = cleanString(value).replace(/[$,\s]/g, '')
  if (!raw) return null
  const number = Number(raw)
  return Number.isFinite(number) ? number : null
}

function normalizeMetaCurrency(value) {
  const currency = cleanString(value).toUpperCase().slice(0, 3)
  return /^[A-Z]{3}$/.test(currency) ? currency : PAYMENT_META_DEFAULT_CURRENCY
}

async function getPaymentMetaCurrency() {
  try {
    return normalizeMetaCurrency(await getAccountCurrency())
  } catch {
    return PAYMENT_META_DEFAULT_CURRENCY
  }
}

function extractPaymentMetaEventSourceUrl(payment = {}) {
  const sourceUrl = cleanString(
    payment.eventSourceUrl
    || payment.event_source_url
    || payment.sourceUrl
    || payment.source_url
    || payment.checkoutUrl
    || payment.checkout_url
    || payment.paymentUrl
    || payment.payment_url
  )

  return sourceUrl || ''
}

function normalizeMetaActionSource(value, fallback = 'website') {
  const actionSource = cleanString(value).toLowerCase()
  if (META_ACTION_SOURCES.has(actionSource)) return actionSource
  if (!fallback) return ''
  return META_ACTION_SOURCES.has(fallback) ? fallback : 'website'
}

function resolvePaymentMetaActionSource(payment = {}, eventSourceUrl = '') {
  const explicit = normalizeMetaActionSource(payment.actionSource || payment.action_source || payment.metaActionSource || payment.meta_action_source, '')
  if (explicit) return explicit

  const method = cleanString(payment.payment_method || payment.paymentMethod || payment.method).toLowerCase()
  const provider = cleanString(payment.payment_provider || payment.provider).toLowerCase()
  const source = cleanString(payment.source).toLowerCase()

  if (eventSourceUrl || payment.public_payment_id || payment.publicPaymentId || payment.payment_url || payment.paymentUrl) {
    return 'website'
  }
  if (/call|phone|telefono/.test(method) || /call|phone|telefono/.test(source)) {
    return 'phone_call'
  }
  if (/cash|efectivo|transfer|bank|deposit|manual|offline|check/.test(method) || /manual|offline|cash/.test(provider)) {
    return 'physical_store'
  }
  return 'system_generated'
}

function firstPaymentValue(values = []) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return ''
}

function asArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = parseJson(value, null)
    if (Array.isArray(parsed)) return parsed
    return value.split(',').map(item => cleanString(item)).filter(Boolean)
  }
  return []
}

function getPaymentMetadata(payment = {}) {
  return parseJson(payment.metadata_json || payment.metadataJson || payment.metadata, {})
}

function getMetaPaymentMode(payment = {}) {
  const metadata = getPaymentMetadata(payment)
  return normalizePaymentMode(firstPaymentValue([
    payment.payment_mode,
    payment.paymentMode,
    payment.mode,
    metadata.payment_mode,
    metadata.paymentMode,
    metadata.mode,
    metadata.stripeMode,
    metadata.conektaMode,
    metadata.mercadoPagoMode,
    metadata.mercadopagoMode,
    metadata.clipMode
  ]), PAYMENT_MODE_LIVE)
}

async function shouldSkipTestPaymentForMeta(payment = {}, { allowWithMetaTestMode = true } = {}) {
  if (getMetaPaymentMode(payment) !== PAYMENT_MODE_TEST) return false
  return !(allowWithMetaTestMode && cleanString(await getActiveMetaTestEventCode()))
}

function normalizeMetaContentId(value = '') {
  return cleanString(value).slice(0, 100)
}

function normalizeMetaQuantity(value) {
  const quantity = Number(value)
  if (!Number.isFinite(quantity) || quantity <= 0) return 1
  return Math.max(1, Math.trunc(quantity))
}

function normalizeMetaItemPrice(value) {
  const price = parseMetaNumber(value)
  return price !== null && price >= 0 ? Math.round(price * 100) / 100 : null
}

function extractPaymentLineItems(payment = {}, metadata = {}) {
  const sources = [
    payment.lineItems,
    payment.line_items,
    payment.items,
    metadata.lineItems,
    metadata.line_items,
    metadata.items,
    metadata.products,
    metadata.invoiceItems,
    metadata.invoice_items
  ]
  for (const source of sources) {
    const items = asArray(source)
    if (items.length) return items
  }
  return []
}

function buildMetaContentItems(payment = {}, metadata = {}, fallbackValue = null) {
  const lineItems = extractPaymentLineItems(payment, metadata)
  if (!lineItems.length) {
    const fallbackId = normalizeMetaContentId(payment.id || payment.public_payment_id || payment.reference || metadata.public_payment_id)
    const fallbackName = firstPaymentValue([payment.title, payment.description, metadata.title, metadata.description])
    if (!fallbackId && !fallbackName) return []
    return [{
      id: fallbackId || normalizeMetaContentId(fallbackName),
      name: fallbackName,
      quantity: 1,
      itemPrice: fallbackValue !== null && fallbackValue !== undefined ? Math.round(Number(fallbackValue) * 100) / 100 : null
    }]
  }

  return lineItems
    .map((item = {}, index) => {
      if (typeof item !== 'object') {
        const value = normalizeMetaContentId(item)
        return value ? { id: value, name: value, quantity: 1, itemPrice: null } : null
      }
      const id = normalizeMetaContentId(
        item.id ||
        item.sku ||
        item.product_id ||
        item.productId ||
        item.price_id ||
        item.priceId ||
        item.content_id ||
        item.contentId ||
        `${payment.id || payment.public_payment_id || 'payment'}_${index + 1}`
      )
      const quantity = normalizeMetaQuantity(item.quantity || item.qty || item.count)
      const itemPrice = normalizeMetaItemPrice(
        item.item_price ||
        item.itemPrice ||
        item.unit_price ||
        item.unitPrice ||
        item.price ||
        item.amount
      )
      const name = firstPaymentValue([item.name, item.title, item.description, item.label])
      return id || name ? { id: id || normalizeMetaContentId(name), name, quantity, itemPrice } : null
    })
    .filter(Boolean)
}

function buildMetaContentIds(payment = {}, metadata = {}, contentItems = []) {
  const explicitIds = [
    ...asArray(payment.content_ids || payment.contentIds),
    ...asArray(metadata.content_ids || metadata.contentIds)
  ].map(normalizeMetaContentId).filter(Boolean)
  const itemIds = contentItems.map(item => normalizeMetaContentId(item.id)).filter(Boolean)
  return [...new Set([...explicitIds, ...itemIds])].slice(0, 100)
}

function buildPaymentOrderId(payment = {}, metadata = {}) {
  return firstPaymentValue([
    payment.orderId,
    payment.order_id,
    payment.reference,
    payment.public_payment_id,
    payment.publicPaymentId,
    payment.stripe_payment_intent_id,
    payment.stripePaymentIntentId,
    payment.stripe_charge_id,
    payment.conekta_order_id,
    payment.conektaOrderId,
    payment.conekta_charge_id,
    payment.conektaChargeId,
    payment.mercadopago_payment_id,
    payment.mercadoPagoPaymentId,
    payment.mercadopago_preference_id,
    payment.mercadoPagoPreferenceId,
    payment.clip_payment_id,
    payment.clipPaymentId,
    payment.clip_receipt_no,
    payment.clipReceiptNo,
    payment.ghl_invoice_id,
    payment.invoice_number,
    metadata.orderId,
    metadata.order_id,
    metadata.public_payment_id,
    metadata.ristak_payment_id,
    metadata.clipPaymentId,
    metadata.clip?.paymentId,
    metadata.clip?.receiptNo,
    metadata.invoiceId,
    metadata.invoice_id
  ])
}

function pickPaymentPlanMetadata(metadata = {}) {
  return metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : metadata.payment_plan && typeof metadata.payment_plan === 'object'
      ? metadata.payment_plan
      : {}
}

function getPaymentPlanId(payment = {}, metadata = null) {
  const resolvedMetadata = metadata || getPaymentMetadata(payment)
  const paymentPlan = pickPaymentPlanMetadata(resolvedMetadata)
  return firstPaymentValue([
    paymentPlan.flowId,
    paymentPlan.flow_id,
    paymentPlan.paymentPlanId,
    paymentPlan.payment_plan_id,
    paymentPlan.id,
    payment.flow_id,
    payment.flowId,
    payment.payment_plan_id,
    payment.paymentPlanId,
    resolvedMetadata.flow_id,
    resolvedMetadata.flowId,
    resolvedMetadata.payment_plan_id,
    resolvedMetadata.paymentPlanId
  ])
}

function normalizeMetaEventIdSegment(value = '') {
  return cleanString(value)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
}

function buildPurchaseEventId(contactId, paymentPlanId = '') {
  const normalizedPlanId = normalizeMetaEventIdSegment(paymentPlanId)
  if (normalizedPlanId) return `purchase_plan_${normalizedPlanId}`
  return `purchase_contact_${contactId}`
}

async function getPaymentPlanTotalValue(paymentPlanId, metadata = {}) {
  const cleanPlanId = cleanString(paymentPlanId)
  if (!cleanPlanId) return null

  const metadataPlan = pickPaymentPlanMetadata(metadata)
  const metadataValue = parseMetaNumber(
    metadataPlan.total ||
    metadataPlan.totalAmount ||
    metadataPlan.total_amount ||
    metadata.total ||
    metadata.totalAmount ||
    metadata.total_amount
  )
  if (metadataValue !== null && metadataValue > 0) return metadataValue

  const mirror = await db.get(
    `SELECT total
     FROM payment_plans
     WHERE id = ? OR ghl_schedule_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
    [cleanPlanId, cleanPlanId]
  ).catch(() => null)
  const mirrorValue = parseMetaNumber(mirror?.total)
  if (mirrorValue !== null && mirrorValue > 0) return mirrorValue

  const flow = await db.get(
    `SELECT total_amount
     FROM payment_flows
     WHERE id = ?
     LIMIT 1`,
    [cleanPlanId]
  ).catch(() => null)
  const flowValue = parseMetaNumber(flow?.total_amount)
  if (flowValue !== null && flowValue > 0) return flowValue

  return null
}

async function hasSuccessfulPaymentPlanPurchaseEvent(paymentPlanId, eventId) {
  const cleanPlanId = cleanString(paymentPlanId)
  if (!cleanPlanId && !eventId) return false

  const jsonNeedle = cleanPlanId ? `"payment_plan_id":"${cleanPlanId}"` : ''
  const row = await db.get(
    `SELECT id
     FROM meta_conversion_event_logs
     WHERE event_type = ?
       AND status = 'success'
       AND (
         event_id = ?
         ${jsonNeedle ? 'OR request_payload LIKE ?' : ''}
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    jsonNeedle
      ? [EVENT_TYPES.purchase, eventId, `%${jsonNeedle}%`]
      : [EVENT_TYPES.purchase, eventId]
  )

  return Boolean(row?.id)
}

async function buildPaymentPurchaseEventContext(contactId, payment = {}, paymentMetaConfig = {}) {
  const parameters = normalizePaymentMetaPurchaseEventParameters(paymentMetaConfig.parameters || {})
  const metadata = getPaymentMetadata(payment)
  const paymentPlanId = getPaymentPlanId(payment, metadata)
  const usePlanTotalValue = Boolean(paymentPlanId && parameters.usePaymentPlanTotalValue)
  const eventId = buildPurchaseEventId(contactId, usePlanTotalValue ? paymentPlanId : '')

  if (usePlanTotalValue && await hasSuccessfulPaymentPlanPurchaseEvent(paymentPlanId, eventId)) {
    return {
      skip: true,
      reason: 'payment_plan_purchase_already_sent',
      eventId,
      paymentPlanId
    }
  }

  if (!usePlanTotalValue) {
    return {
      eventId,
      payment,
      customDataOptions: {},
      skipContactDedupe: false
    }
  }

  const paymentPlanTotalValue = await getPaymentPlanTotalValue(paymentPlanId, metadata)
  const currentPaymentValue = parseMetaNumber(payment.amount)
  const shouldOverrideValue = parameters.sendValue !== false && paymentPlanTotalValue !== null
  const enrichedPayment = shouldOverrideValue
    ? { ...payment, amount: paymentPlanTotalValue }
    : payment

  return {
    eventId,
    payment: enrichedPayment,
    customDataOptions: {
      paymentPlanId,
      paymentPlanValueMode: shouldOverrideValue ? 'payment_plan_total' : 'current_payment_amount',
      paymentPlanTotalValue,
      currentPaymentValue
    },
    skipContactDedupe: true
  }
}

function buildPaymentMetaPurchaseEventCustomData(parameters = {}, payment = {}, options = {}) {
  const normalizedParameters = normalizePaymentMetaPurchaseEventParameters(parameters)
  const templateContext = options.templateContext || {}
  const normalizedAmount = parseMetaNumber(renderPaymentMetaParameterValue(normalizedParameters.value, templateContext))
  const paymentAmount = parseMetaNumber(payment.amount)
  const predictedLtv = parseMetaNumber(renderPaymentMetaParameterValue(normalizedParameters.predictedLtv, templateContext))
  const currency = normalizeMetaCurrency(options.currency)
  const metadata = getPaymentMetadata(payment)
  const paymentPlan = pickPaymentPlanMetadata(metadata)
  const customData = {
    source: 'ristak_payment',
    conversion_type: EVENT_TYPES.purchase
  }

  const finalValue = normalizedParameters.sendValue === false
    ? normalizedAmount
    : (paymentAmount ?? normalizedAmount)
  if (finalValue !== null) {
    customData.value = finalValue
  }

  if (predictedLtv !== null) {
    customData.predicted_ltv = predictedLtv
  }

  if (/^[A-Z]{3}$/.test(currency)) {
    customData.currency = currency
  }

  const paymentId = firstPaymentValue([
    payment.id,
    payment.paymentId,
    payment.payment_id,
    metadata.ristak_payment_id,
    metadata.payment_id
  ])
  if (paymentId) {
    customData.payment_id = paymentId
  }

  const orderId = buildPaymentOrderId(payment, metadata)
  if (orderId) {
    customData.order_id = orderId
  }

  const paymentStatus = cleanString(payment.status)
  if (paymentStatus) {
    customData.payment_status = paymentStatus
  }

  const paymentProvider = firstPaymentValue([payment.payment_provider, payment.provider, metadata.provider])
  if (paymentProvider) {
    customData.payment_provider = paymentProvider
  }

  const paymentMethod = firstPaymentValue([payment.payment_method, payment.paymentMethod, metadata.payment_method])
  if (paymentMethod) {
    customData.payment_method = paymentMethod
  }

  const publicPaymentId = firstPaymentValue([payment.public_payment_id, payment.publicPaymentId, metadata.public_payment_id])
  if (publicPaymentId) {
    customData.public_payment_id = publicPaymentId
  }

  const invoiceNumber = firstPaymentValue([payment.invoice_number, payment.invoiceNumber, metadata.invoice_number])
  if (invoiceNumber) {
    customData.invoice_number = invoiceNumber
  }

  const subscriptionId = firstPaymentValue([
    payment.subscription_id,
    payment.subscriptionId,
    payment.stripe_subscription_id,
    payment.conekta_subscription_id,
    payment.mercadopago_subscription_id,
    metadata.subscription_id,
    metadata.subscriptionId,
    paymentPlan.subscriptionId,
    paymentPlan.subscription_id
  ])
  if (subscriptionId) {
    customData.subscription_id = subscriptionId
  }

  const paymentPlanId = firstPaymentValue([
    options.paymentPlanId,
    paymentPlan.flowId,
    paymentPlan.flow_id,
    paymentPlan.paymentPlanId,
    paymentPlan.payment_plan_id,
    paymentPlan.id,
    payment.flow_id,
    payment.flowId,
    payment.payment_plan_id,
    payment.paymentPlanId,
    metadata.flow_id,
    metadata.flowId,
    metadata.payment_plan_id,
    metadata.paymentPlanId
  ])
  if (paymentPlanId) {
    customData.payment_plan_id = paymentPlanId
  }

  if (options.paymentPlanValueMode) {
    customData.payment_plan_value_mode = options.paymentPlanValueMode
  }
  if (options.paymentPlanTotalValue !== null && options.paymentPlanTotalValue !== undefined) {
    customData.payment_plan_total_value = options.paymentPlanTotalValue
  }
  if (options.currentPaymentValue !== null && options.currentPaymentValue !== undefined) {
    customData.current_payment_value = options.currentPaymentValue
  }

  const installmentId = firstPaymentValue([paymentPlan.installmentId, paymentPlan.installment_id, payment.installment_id, metadata.installment_id])
  if (installmentId) {
    customData.installment_id = installmentId
  }

  const contentItems = buildMetaContentItems(payment, metadata, finalValue)
  const contentIds = buildMetaContentIds(payment, metadata, contentItems)
  if (contentIds.length) {
    customData.content_ids = contentIds
  }
  const contents = contentItems
    .map(item => ({
      id: normalizeMetaContentId(item.id),
      quantity: item.quantity,
      ...(item.itemPrice !== null && item.itemPrice !== undefined ? { item_price: item.itemPrice } : {})
    }))
    .filter(item => item.id)
  if (contents.length) {
    customData.contents = contents
    customData.content_type = firstPaymentValue([metadata.content_type, metadata.contentType]) || 'product'
    customData.num_items = contents.reduce((total, item) => total + normalizeMetaQuantity(item.quantity), 0)
  }
  const contentName = firstPaymentValue([
    metadata.content_name,
    metadata.contentName,
    payment.title,
    payment.description,
    contentItems[0]?.name
  ])
  if (contentName) {
    customData.content_name = contentName
  }

  if (Array.isArray(normalizedParameters.custom)) {
    normalizedParameters.custom.forEach((parameter) => {
      const key = normalizePaymentMetaPurchaseEventCustomParameterKey(parameter.key)
      const value = renderPaymentMetaParameterValue(parameter.value, templateContext)
      if (!key || !value) return
      customData[key] = value
    })
  }

  return customData
}

function prunePublicMetaPixelCustomData(customData = {}) {
  return Object.fromEntries(
    Object.entries(customData).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0
      return value !== null && value !== undefined && value !== ''
    })
  )
}

export async function buildMetaPublicPurchasePixelEvent(payment = {}, options = {}) {
  if (!isSuccessfulPaymentStatus(payment.status)) return null

  if (await shouldSkipTestPaymentForMeta(payment, { allowWithMetaTestMode: false })) return null

  const contactId = cleanString(
    options.contactId ||
    payment.contact_id ||
    payment.contactId ||
    payment.contact?.id
  )
  if (!contactId) return null

  const paymentMetaConfig = await getPaymentMetaPurchaseEventConfig()
  if (!paymentMetaConfig.enabled || BUSINESS_MESSAGING_EVENT_CHANNELS.has(paymentMetaConfig.channel)) return null

  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId) return null

  const accountCurrency = await getPaymentMetaCurrency()
  const eventContext = await buildPaymentPurchaseEventContext(contactId, payment, paymentMetaConfig)
  if (eventContext.skip) return { sent: false, reason: eventContext.reason, eventId: eventContext.eventId }
  const contact = await getContactForMetaEvent(contactId)
  // Un pago en checkout público ES superficie website: el pixel del navegador
  // siempre dispara y el evento server-side va también como website con el
  // mismo event_id, así que Meta deduplica a una sola conversión. (Antes, en
  // canal smart, se suprimía el pixel si el contacto tenía atribución de
  // mensajería — eso mezclaba atribución con superficie.)

  const variableFields = await getVariableFieldValueMap().catch(() => ({}))
  const templateContext = buildPaymentMetaTemplateContext({
    contact,
    contactId,
    payment: eventContext.payment || payment,
    currency: accountCurrency,
    variableFields
  })
  const customData = buildPaymentMetaPurchaseEventCustomData(paymentMetaConfig.parameters, eventContext.payment || payment, {
    currency: accountCurrency,
    templateContext,
    ...(eventContext.customDataOptions || {})
  })

  return {
    pixelId: metaConfig.datasetId,
    eventName: paymentMetaConfig.eventName || DEFAULT_PAYMENT_EVENT_NAME,
    eventId: eventContext.eventId,
    customData: prunePublicMetaPixelCustomData(customData)
  }
}

async function getPaymentMetaPurchaseEventConfig() {
  const rawConfig = parseJson(await getAppConfig(CONFIG_KEYS.paymentPurchaseEventConfig), null)
  if (hasStructuredPaymentMetaPurchaseEventConfig(rawConfig)) {
    return normalizePaymentMetaPurchaseEventConfig(rawConfig)
  }

  const legacyEnabled = await getConfigBoolean(CONFIG_KEYS.purchaseEnabled, false)
  if (!legacyEnabled) {
    return {
      enabled: false,
      channel: DEFAULT_PAYMENT_EVENT_CHANNEL,
      eventName: DEFAULT_PAYMENT_EVENT_NAME,
      parameters: {
        value: '',
        predictedLtv: '',
        custom: []
      }
    }
  }

  const legacyEventName = await getConfiguredEventName(CONFIG_KEYS.purchaseEventName, DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME)
  return {
    enabled: true,
    channel: 'whatsapp',
    eventName: normalizeBusinessMessagingEventName(legacyEventName),
    parameters: {
      usePaymentPlanTotalValue: true,
      value: '',
      predictedLtv: '',
      custom: []
    }
  }
}

function deriveNames(contact = {}) {
  const firstName = cleanString(contact.first_name)
  const lastName = cleanString(contact.last_name)

  if (firstName || lastName) {
    return { firstName, lastName }
  }

  const parts = cleanString(contact.full_name).split(' ').filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }

  return {
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
  }
}

function buildUserData(contact) {
  const { firstName, lastName } = deriveNames(contact)
  return buildMetaParameterUserData({
    contact,
    names: { firstName, lastName },
    externalId: contact.id,
    includeBrowserSignals: false
  })
}

function normalizeBusinessMessagingEventName(value) {
  const eventName = cleanString(value)
  const aliases = {
    lead: 'LeadSubmitted',
    schedule: 'LeadSubmitted'
  }

  return aliases[eventName.toLowerCase()] || eventName
}

// Identidad de user_data para eventos business_messaging, según el canal.
// NOTA: los nombres de campo de Messenger/Instagram (page_scoped_user_id,
// ig_account_id, ig_sid) están centralizados AQUÍ. Meta exige que el
// dataset tenga una Página asociada para eventos CTM/CTWA; una vez asociada, si
// Meta pidiera otro nombre de campo, se ajusta en este único lugar.
function buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution, channel = 'whatsapp', socialIdentity = null, attributionTouch = null) {
  const userData = buildUserData(contact)
  const pageId = cleanString(metaConfig?.pageId)
  // Los ids del touch de atribución solo sirven como identidad si el touch es
  // del MISMO canal que el evento: un IGSID jamás debe viajar como PSID de
  // Messenger ni viceversa.
  const touchIds = attributionTouch?.channel === channel ? (attributionTouch.ids || {}) : {}

  if (channel === 'messenger') {
    const mPageId = cleanString(socialIdentity?.pageId || touchIds.pageId) || pageId
    const psid = cleanString(socialIdentity?.senderId || touchIds.senderId)
    if (mPageId) userData.page_id = mPageId
    if (psid) userData.page_scoped_user_id = psid
    return userData
  }

  if (channel === 'instagram') {
    const igAccountId = cleanString(socialIdentity?.igAccountId || touchIds.igAccountId)
    const igsid = cleanString(socialIdentity?.senderId || touchIds.senderId)
    if (igAccountId) userData.ig_account_id = igAccountId
    if (igsid) userData.ig_sid = igsid
    return userData
  }

  // WhatsApp (default): ctwa_clid + page_id + whatsapp_business_account_id.
  const ctwaClid = cleanString(
    whatsappAttribution?.referral_ctwa_clid ||
    contact.attribution_ctwa_clid ||
    touchIds.ctwaClid
  )
  const whatsappBusinessAccountId = cleanString(metaConfig?.whatsappBusinessAccountId)

  if (ctwaClid) userData.ctwa_clid = ctwaClid
  if (pageId) userData.page_id = pageId
  if (whatsappBusinessAccountId) userData.whatsapp_business_account_id = whatsappBusinessAccountId

  return userData
}

// Identidad de mensajería social (Messenger/Instagram) de un contacto, para CAPI.
// Solo atribuye si el contacto tiene una conversación privada REAL (algún mensaje
// no-comentario): alguien que solo comentó no debe disparar un evento de
// mensajería. Se condiciona por message_type, no por el senderId (que tras la
// fusión es el PSID/IGSID real tanto para comentario como para DM).
export async function getSocialMessagingIdentity(contactId, platform = '') {
  if (!contactId) return null
  const normalizedPlatform = ['messenger', 'instagram'].includes(cleanString(platform).toLowerCase())
    ? cleanString(platform).toLowerCase()
    : ''
  const platformFilter = normalizedPlatform === 'instagram'
    ? " AND LOWER(COALESCE(platform, '')) = 'instagram'"
    : normalizedPlatform === 'messenger'
      ? " AND LOWER(COALESCE(platform, '')) != 'instagram'"
      : ''
  const row = await db.get(
    `SELECT platform, sender_id, page_id, instagram_account_id,
            first_seen_at, last_seen_at, created_at, updated_at
     FROM meta_social_contacts
     WHERE contact_id = ?${platformFilter}
       AND EXISTS (
         SELECT 1 FROM meta_social_messages m
         WHERE m.contact_id = ?
           AND COALESCE(m.message_type, '') NOT IN ('comment', 'comment_reply_public', 'comment_reply_private')
       )
     ORDER BY updated_at DESC, last_seen_at DESC
     LIMIT 1`,
    [contactId, contactId]
  ).catch(() => null)
  if (!row || !cleanString(row.sender_id)) return null
  const channel = cleanString(row.platform).toLowerCase() === 'instagram' ? 'instagram' : 'messenger'
  return {
    channel,
    senderId: cleanString(row.sender_id),
    pageId: cleanString(row.page_id),
    igAccountId: cleanString(row.instagram_account_id),
    firstSeenAt: row.first_seen_at || null,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  }
}

function buildBusinessMessagingCustomData(customData, contact, whatsappAttribution, attributionTouch = null) {
  const enrichedData = { ...customData }
  // El crédito interno lo manda el último paid touch; los campos del contacto
  // (first-touch) y de whatsapp_attribution quedan como fallback legacy.
  const adId = cleanString(
    attributionTouch?.adId ||
    contact.attribution_ad_id ||
    whatsappAttribution?.referral_source_id ||
    whatsappAttribution?.ad_id_thru_message
  )
  const adName = cleanString(
    attributionTouch?.adName ||
    contact.attribution_ad_name ||
    whatsappAttribution?.referral_headline
  )
  const referralSourceType = cleanString(whatsappAttribution?.referral_source_type)
  const referralSourceUrl = cleanString(whatsappAttribution?.referral_source_url)
  const attributionSource = cleanString(whatsappAttribution?.attribution_source)

  if (attributionTouch?.channel) {
    enrichedData.attribution_channel = attributionTouch.channel
  }
  if (attributionTouch?.campaignId) {
    enrichedData.campaign_id = attributionTouch.campaignId
  }
  if (attributionTouch?.adsetId) {
    enrichedData.adset_id = attributionTouch.adsetId
  }

  if (adId) {
    enrichedData.ad_id = adId
  }

  if (adName) {
    enrichedData.ad_name = adName
  }

  if (referralSourceType) {
    enrichedData.referral_source_type = referralSourceType
  }

  if (referralSourceUrl) {
    enrichedData.referral_source_url = referralSourceUrl
  }

  if (attributionSource) {
    enrichedData.attribution_source = attributionSource
  }

  return Object.fromEntries(
    Object.entries(enrichedData).filter(([, value]) => value !== null && value !== undefined && value !== '')
  )
}

async function getConfigBoolean(key, defaultValue = false) {
  const value = await getAppConfig(key)
  return parseBoolean(value, defaultValue)
}

async function getConfiguredEventName(key, fallback) {
  const value = cleanString(await getAppConfig(key))
  return normalizeBusinessMessagingEventName(value || fallback)
}

async function getMetaCapiConfig() {
  const [metaConfig, socialConfig] = await Promise.all([
    getMetaConfig().catch(error => {
      logger.warn(`No se pudo leer configuración de Meta Ads para CAPI: ${error.message}`)
      return null
    }),
    getMetaSocialConfig().catch(error => {
      logger.warn(`No se pudo leer configuración de Meta Social para CAPI: ${error.message}`)
      return null
    })
  ])

  const datasetId = cleanString(
    metaConfig?.pixel_id ||
    process.env.META_PIXEL_ID ||
    process.env.META_DATASET_ID ||
    process.env.DATASET_ID
  )

  const accessToken = cleanString(resolveMetaCapiAccessToken(metaConfig))

  const testEventCode = cleanString(await getActiveMetaTestEventCode())

  const pageId = cleanString(
    socialConfig?.page_id ||
    process.env.META_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID
  )

  const whatsappBusinessAccountId = cleanString(
    await getMetaWhatsAppBusinessAccountId() ||
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.META_WABA_ID ||
    process.env.WABA_ID
  )

  return {
    datasetId,
    accessToken,
    appSecretProof: cleanString(metaConfig?.oauth_appsecret_proof),
    testEventCode,
    pageId,
    whatsappBusinessAccountId
  }
}

async function getContactForMetaEvent(contactId) {
  if (!contactId) return null

  return db.get(
    `SELECT
       id,
       phone,
       email,
       full_name,
       first_name,
       last_name,
       custom_fields,
       preferred_whatsapp_phone_number_id,
       attribution_ctwa_clid,
       attribution_ad_id,
       attribution_ad_name,
       COALESCE(meta_schedule_event_sent, 0) as meta_schedule_event_sent,
       meta_schedule_event_sent_at,
       meta_schedule_event_id,
       COALESCE(meta_purchase_event_sent, 0) as meta_purchase_event_sent,
       meta_purchase_event_sent_at,
       meta_purchase_event_id
     FROM contacts
     WHERE id = ?`,
    [contactId]
  )
}

async function getLatestWhatsappAttribution(contact) {
  if (!contact?.id) return null

  const uniquePhoneCandidates = buildPhoneMatchCandidates(contact.phone)
  const phoneFilter = uniquePhoneCandidates.length
    ? ` OR phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})`
    : ''

  const legacyRows = await db.all(
    `SELECT
       'legacy' as attribution_source,
       referral_ctwa_clid,
       referral_source_id,
       referral_source_type,
       referral_source_url,
       referral_headline,
       ad_id_thru_message,
       created_at
     FROM whatsapp_attribution
     WHERE contact_id = ?${phoneFilter}
       AND (
         COALESCE(referral_ctwa_clid, '') != ''
         OR COALESCE(referral_source_id, '') != ''
         OR COALESCE(referral_source_url, '') != ''
         OR COALESCE(referral_headline, '') != ''
         OR COALESCE(ad_id_thru_message, '') != ''
       )`,
    [contact.id, ...uniquePhoneCandidates]
  )

  const apiPhoneFilter = uniquePhoneCandidates.length
    ? ` OR msg.phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})
        OR attr.phone IN (${uniquePhoneCandidates.map(() => '?').join(', ')})`
    : ''

  const apiRows = await db.all(
    `SELECT
       'whatsapp_api' as attribution_source,
       COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid) as referral_ctwa_clid,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as referral_source_id,
       COALESCE(attr.detected_source_type, msg.detected_source_type) as referral_source_type,
       COALESCE(attr.detected_source_url, msg.detected_source_url) as referral_source_url,
       COALESCE(attr.detected_headline, msg.detected_headline) as referral_headline,
       COALESCE(attr.detected_source_id, msg.detected_source_id) as ad_id_thru_message,
       COALESCE(attr.created_at, msg.created_at) as created_at
     FROM whatsapp_api_messages msg
     LEFT JOIN whatsapp_api_attribution attr ON attr.whatsapp_api_message_id = msg.id
     WHERE (msg.contact_id = ? OR attr.contact_id = ?${apiPhoneFilter})
       AND msg.direction = 'inbound'
       AND (
         COALESCE(attr.detected_ctwa_clid, msg.detected_ctwa_clid, '') != ''
         OR COALESCE(attr.detected_source_id, msg.detected_source_id, '') != ''
         OR COALESCE(attr.detected_source_url, msg.detected_source_url, '') != ''
         OR COALESCE(attr.detected_headline, msg.detected_headline, '') != ''
       )`,
    [contact.id, contact.id, ...uniquePhoneCandidates, ...uniquePhoneCandidates]
  )

  const rows = [...legacyRows, ...apiRows]
  if (!rows.length) return null

  return rows.sort((a, b) => {
    const aHasCtwa = cleanString(a.referral_ctwa_clid) ? 1 : 0
    const bHasCtwa = cleanString(b.referral_ctwa_clid) ? 1 : 0
    if (aHasCtwa !== bHasCtwa) return bHasCtwa - aHasCtwa

    const aTime = Date.parse(a.created_at || '') || 0
    const bTime = Date.parse(b.created_at || '') || 0
    return bTime - aTime
  })[0]
}

async function logMetaEvent({
  contactId,
  eventType,
  metaEventName,
  eventId,
  status,
  requestPayload = null,
  responsePayload = null,
  errorMessage = null
}) {
  await db.run(
    `INSERT INTO meta_conversion_event_logs (
       contact_id,
       event_type,
       meta_event_name,
       event_id,
       status,
       request_payload,
       response_payload,
       error_message,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      contactId || null,
      eventType,
      metaEventName,
      eventId,
      status,
      requestPayload ? jsonForLog(requestPayload) : null,
      responsePayload ? jsonForLog(responsePayload) : null,
      errorMessage || null
    ]
  )
}

async function sendWhatsAppQrPurchaseLabelFallback({ contact, eventType, metaEventName, eventId, customData } = {}) {
  if (!contact?.id) {
    await logMetaEvent({
      contactId: contact?.id,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto no encontrado para fallback de label QR'
    })
    return { sent: false, reason: 'contact_not_found' }
  }

  if (!contact.phone) {
    await logMetaEvent({
      contactId: contact.id,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto sin teléfono para fallback de label QR'
    })
    return { sent: false, reason: 'missing_phone' }
  }

  if (contactAlreadySent(contact, eventType)) {
    return { sent: false, reason: 'already_sent' }
  }

  const labelResult = await applyWhatsAppQrPaidLabelForContact(contact)
  const requestPayload = {
    source: 'whatsapp_qr_label_fallback',
    event_name: metaEventName,
    event_id: eventId,
    label: 'Paid',
    custom_data: customData || {}
  }

  if (labelResult.applied) {
    await markContactEventSent(contact.id, eventType, eventId)
    await logMetaEvent({
      contactId: contact.id,
      eventType,
      metaEventName,
      eventId,
      status: 'success',
      requestPayload,
      responsePayload: labelResult
    })
    logger.info(`Fallback QR aplicó label Paid para compra Meta del contacto ${contact.id}`)
    return { sent: true, eventId, transport: 'whatsapp_qr_label', labelResult }
  }

  await logMetaEvent({
    contactId: contact.id,
    eventType,
    metaEventName,
    eventId,
    status: 'skipped',
    requestPayload,
    responsePayload: labelResult,
    errorMessage: `Fallback label QR no aplicado: ${labelResult.reason || 'unknown'}`
  })
  return { sent: false, reason: labelResult.reason || 'qr_label_fallback_skipped', labelResult }
}

function contactAlreadySent(contact, eventType) {
  const fields = CONTACT_SENT_FIELDS[eventType]
  return Boolean(fields && Number(contact?.[fields.sent] || 0) === 1)
}

async function markContactEventSent(contactId, eventType, eventId) {
  const fields = CONTACT_SENT_FIELDS[eventType]
  if (!fields) return

  await db.run(
    `UPDATE contacts
     SET ${fields.sent} = 1,
         ${fields.sentAt} = CURRENT_TIMESTAMP,
         ${fields.eventId} = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [eventId, contactId]
  )
}

async function postEventToMeta({ datasetId, accessToken, appSecretProof = '', payload }) {
  const params = new URLSearchParams({ access_token: accessToken })
  if (appSecretProof) params.set('appsecret_proof', appSecretProof)
  const url = `${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?${params.toString()}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
  } catch (error) {
    throw new Error(safeMetaGraphTransportError(error))
  }

  let responsePayload = null
  const responseText = await response.text()
  try {
    responsePayload = responseText ? JSON.parse(responseText) : {}
  } catch {
    responsePayload = { raw: responseText }
  }

  if (!response.ok || responsePayload?.error) {
    const message = describeMetaCapiResponseError(responsePayload, response.status)
    const error = new Error(message)
    error.responsePayload = responsePayload
    throw error
  }

  return responsePayload
}

async function sendMetaWhatsappEvent({
  contactId,
  eventType,
  metaEventName,
  eventId,
  customData,
  skipContactDedupe = false,
  channel = 'whatsapp',
  socialIdentity = null,
  attributionTouch = null
}) {
  const cleanChannel = ['messenger', 'instagram'].includes(channel) ? channel : 'whatsapp'
  const isWhatsapp = cleanChannel === 'whatsapp'
  const contact = await getContactForMetaEvent(contactId)

  if (!contact) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto no encontrado'
    })
    return { sent: false, reason: 'contact_not_found' }
  }

  // WhatsApp exige teléfono; Messenger/Instagram se atribuyen por PSID/IGSID.
  if (isWhatsapp && !contact.phone) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto sin teléfono'
    })
    return { sent: false, reason: 'missing_phone' }
  }

  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId || !metaConfig.accessToken) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      errorMessage: 'Falta META_PIXEL_ID/DATASET_ID o System User Access Token'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  // Modo test (código de Test Events activo): NO deduplicamos por contacto ni
  // marcamos la bandera, para que el usuario pueda re-disparar el mismo evento
  // y verlo en Test Events. El evento real (dataset en vivo) se enviará luego.
  const metaTestModeActive = Boolean(metaConfig.testEventCode)

  if (!skipContactDedupe && !metaTestModeActive && contactAlreadySent(contact, eventType)) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Evento ya enviado previamente para este contacto (dedupe)'
    })
    return { sent: false, reason: 'already_sent' }
  }

  const whatsappAttribution = isWhatsapp ? await getLatestWhatsappAttribution(contact) : null

  const userData = buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution, cleanChannel, socialIdentity, attributionTouch)

  if (!userData.external_id) {
    await logMetaEvent({ contactId, eventType, metaEventName, eventId, status: 'skipped', errorMessage: 'user_data insuficiente para Meta' })
    return { sent: false, reason: 'insufficient_user_data' }
  }

  if (isWhatsapp) {
    if (!userData.ph) {
      await logMetaEvent({ contactId, eventType, metaEventName, eventId, status: 'skipped', errorMessage: 'user_data insuficiente para Meta' })
      return { sent: false, reason: 'insufficient_user_data' }
    }
    // Sin ctwa_clid Meta no puede atribuir el evento a un anuncio CTWA, pero
    // la superficie es la real (la conversión SÍ pasó por WhatsApp), así que
    // enviamos igual con ph/page_id en vez de falsificar el action_source.
    if (!userData.ctwa_clid) {
      logger.warn(`Evento ${eventType} de WhatsApp sin ctwa_clid para contacto ${contactId}: se envía como business_messaging con matching por teléfono`)
    }
  } else {
    // Messenger/Instagram: se requiere la identidad de mensajería social
    // (PSID/IGSID + page/ig id) ya resuelta en el user_data.
    const hasIdentity = Boolean(
      cleanString(userData.page_scoped_user_id || userData.ig_sid) &&
      (cleanChannel === 'messenger'
        ? cleanString(userData.page_id)
        : cleanString(userData.ig_account_id))
    )
    if (!hasIdentity) {
      await logMetaEvent({ contactId, eventType, metaEventName, eventId, status: 'skipped', errorMessage: `Falta identidad de ${cleanChannel} (PSID/IGSID + page/ig id)` })
      return { sent: false, reason: 'missing_messaging_identity' }
    }
  }

  const enrichedCustomData = buildBusinessMessagingCustomData(customData, contact, whatsappAttribution, attributionTouch)
  const payload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'business_messaging',
        messaging_channel: cleanChannel,
        event_id: eventId,
        user_data: userData,
        custom_data: enrichedCustomData
      }
    ]
  }

  if (metaConfig.testEventCode) {
    payload.test_event_code = metaConfig.testEventCode
  }

  try {
    const responsePayload = await postEventToMeta({
      datasetId: metaConfig.datasetId,
      accessToken: metaConfig.accessToken,
      appSecretProof: metaConfig.appSecretProof,
      payload
    })

    if (!metaTestModeActive) {
      await markContactEventSent(contactId, eventType, eventId)
    }
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    logger.info(`✅ Evento ${cleanChannel} ${eventType} enviado a Meta para contacto ${contactId}`)
    return { sent: true, eventId, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      responsePayload: error.responsePayload || null,
      errorMessage: error.message
    })

    logger.error(`Error enviando evento WhatsApp ${eventType} a Meta para contacto ${contactId}: ${error.message}`)
    return { sent: false, reason: 'meta_error', error: error.message }
  }
}

async function sendMetaSiteEvent({
  contactId,
  eventType,
  metaEventName,
  eventId,
  customData,
  eventSourceUrl = '',
  actionSource = 'website',
  skipContactDedupe = false,
  extraUserData = null,
  attributionTouch = null
}) {
  const contact = await getContactForMetaEvent(contactId)

  if (!contact) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto no encontrado'
    })
    return { sent: false, reason: 'contact_not_found' }
  }

  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId || !metaConfig.accessToken) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      errorMessage: 'Falta META_PIXEL_ID/DATASET_ID o System User Access Token'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  // Modo test (código de Test Events activo): NO deduplicamos por contacto ni
  // marcamos la bandera. Así el usuario puede re-disparar el mismo evento las
  // veces que quiera para verlo en la pestaña Test Events, y el evento real (al
  // dataset en vivo) sigue pudiéndose enviar después, cuando el modo test expire.
  const metaTestModeActive = Boolean(metaConfig.testEventCode)

  if (!skipContactDedupe && !metaTestModeActive && contactAlreadySent(contact, eventType)) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Evento ya enviado previamente para este contacto (dedupe)'
    })
    return { sent: false, reason: 'already_sent' }
  }

  const userData = buildUserData(contact)
  // Señales de navegador (fbp/fbc) de la última sesión web conocida: mejoran
  // el matching de eventos website enviados server-side (sin request vivo).
  if (extraUserData && typeof extraUserData === 'object') {
    if (!userData.fbp && cleanString(extraUserData.fbp)) userData.fbp = cleanString(extraUserData.fbp)
    if (!userData.fbc && cleanString(extraUserData.fbc)) userData.fbc = cleanString(extraUserData.fbc)
  }
  if (!userData.em && !userData.ph && !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data' }
  }

  const enrichedCustomData = { ...(customData || {}) }
  if (attributionTouch?.channel && !enrichedCustomData.attribution_channel) {
    enrichedCustomData.attribution_channel = attributionTouch.channel
  }
  if (attributionTouch?.adId && !enrichedCustomData.ad_id) {
    enrichedCustomData.ad_id = attributionTouch.adId
  }
  if (attributionTouch?.adName && !enrichedCustomData.ad_name) {
    enrichedCustomData.ad_name = attributionTouch.adName
  }
  if (attributionTouch?.campaignId && !enrichedCustomData.campaign_id) {
    enrichedCustomData.campaign_id = attributionTouch.campaignId
  }
  if (attributionTouch?.adsetId && !enrichedCustomData.adset_id) {
    enrichedCustomData.adset_id = attributionTouch.adsetId
  }

  const payload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: normalizeMetaActionSource(actionSource, 'website'),
        event_id: eventId,
        user_data: userData,
        custom_data: enrichedCustomData
      }
    ]
  }

  const normalizedEventSourceUrl = sanitizeMetaUrlForEvent(eventSourceUrl)
  if (normalizedEventSourceUrl) {
    payload.data[0].event_source_url = normalizedEventSourceUrl
  }

  if (metaConfig.testEventCode) {
    payload.test_event_code = metaConfig.testEventCode
  }

  try {
    const responsePayload = await postEventToMeta({
      datasetId: metaConfig.datasetId,
      accessToken: metaConfig.accessToken,
      appSecretProof: metaConfig.appSecretProof,
      payload
    })

    if (!metaTestModeActive) {
      await markContactEventSent(contactId, eventType, eventId)
    }
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    logger.info(`✅ Evento Meta ${eventType} enviado a Meta para contacto ${contactId}`)
    return { sent: true, eventId, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      responsePayload: error.responsePayload || null,
      errorMessage: error.message
    })

    logger.error(`Error enviando evento de sitio ${eventType} a Meta para contacto ${contactId}: ${error.message}`)
    return { sent: false, reason: 'meta_error', error: error.message }
  }
}

export function isSuccessfulPaymentStatus(status) {
  return SUCCESS_PAYMENT_STATUSES.has(String(status || '').trim().toLowerCase())
}

/**
 * Calendarios marcados para atribución. Devuelve `null` cuando no hay ninguno
 * seleccionado, lo que significa "todos" (sin filtro).
 */
async function getAttributionCalendarIds() {
  try {
    const config = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['attribution_calendar_ids']
    )

    if (!config || !config.config_value) {
      return null
    }

    const calendarIds = JSON.parse(config.config_value)
    return Array.isArray(calendarIds) && calendarIds.length > 0
      ? calendarIds.map((id) => String(id))
      : null
  } catch (error) {
    logger.warn(`Error al leer calendarios de atribución para eventos: ${error.message} - usando TODOS`)
    return null
  }
}

async function getCalendarCustomEvents(calendarId) {
  if (!calendarId) return null

  try {
    const row = await db.get(
      'SELECT id, name, raw_json FROM calendars WHERE id = ? OR ghl_calendar_id = ?',
      [calendarId, calendarId]
    )
    if (!row) return null

    const rawJson = parseJson(row.raw_json, {})
    return {
      calendarId: row.id,
      calendarName: row.name || '',
      ...normalizeCalendarWhatsappCustomEvents(rawJson.customEvents || rawJson.custom_events || rawJson)
    }
  } catch (error) {
    logger.warn(`Error al leer eventos personalizados del calendario ${calendarId}: ${error.message}`)
    return null
  }
}

export async function triggerWhatsappAppointmentBookedEvent(contactId, options = {}) {
  const calendarId = options.calendarId ? String(options.calendarId) : null
  const calendarCustomEvents = options.customEvents
    ? {
        calendarId,
        calendarName: options.calendarName || '',
        ...normalizeCalendarWhatsappCustomEvents(options.customEvents)
      }
    : await getCalendarCustomEvents(calendarId)
  const usesCalendarConfig = Boolean(calendarCustomEvents?.enabled)

  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
  }

  // Atribución interna (último paid touch) + superficie real. Se calcula y
  // persiste ANTES de cualquier gate de configuración (igual que en compras):
  // el snapshot interno no depende de que el CAPI esté habilitado. Es
  // write-once, así que los echos de webhooks no lo sobreescriben.
  const appointmentId = cleanString(options.appointmentId || options.appointment_id)
  const appointmentRow = appointmentId
    ? await db.get('SELECT date_added, start_time FROM appointments WHERE id = ?', [appointmentId]).catch(() => null)
    : null
  const conversionResolution = await resolveConversionAttribution({
    contactId,
    conversionType: 'appointment',
    conversionSurface: cleanString(options.conversionSurface || options.conversion_surface),
    conversionTime: appointmentRow?.date_added || null
  }).catch(error => {
    logger.warn(`No se pudo resolver atribución de conversión para cita del contacto ${contactId}: ${error.message}`)
    return null
  })
  if (conversionResolution && appointmentId) {
    await persistAppointmentConversionAttribution(appointmentId, conversionResolution)
  }
  const attributionTouch = conversionResolution?.touch || null

  if (usesCalendarConfig && !BUSINESS_MESSAGING_EVENT_CHANNELS.has(calendarCustomEvents.channel) && calendarCustomEvents.channel !== 'smart') {
    return { sent: false, reason: 'calendar_channel_not_business_messaging' }
  }

  if (!usesCalendarConfig && !await getConfigBoolean(CONFIG_KEYS.scheduleEnabled, false)) {
    return { sent: false, reason: 'disabled' }
  }

  // El evento de conversión solo se dispara para citas de calendarios marcados
  // para atribución. Si no hay ninguno seleccionado (null) se envía para todos.
  // Si la cita no trae calendario, no bloqueamos (evita perder conversiones por
  // un payload incompleto).
  const attributionCalendarIds = await getAttributionCalendarIds()
  if (!usesCalendarConfig && attributionCalendarIds && calendarId && !attributionCalendarIds.includes(calendarId)) {
    return { sent: false, reason: 'calendar_not_attributed' }
  }

  const metaEventName = usesCalendarConfig
    ? calendarCustomEvents.eventName
    : await getConfiguredEventName(CONFIG_KEYS.scheduleEventName, DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME)
  const eventId = appointmentId
    ? `schedule_appointment_${appointmentId}`
    : `schedule_contact_${contactId}`

  const buildScheduleArgs = (channel = 'whatsapp') => ({
    contactId,
    eventType: EVENT_TYPES.schedule,
    metaEventName,
    eventId,
    attributionTouch,
    customData: {
      source: channel,
      messaging_channel: channel,
      conversion_type: EVENT_TYPES.schedule,
      appointment_id: appointmentId,
      calendar_id: calendarCustomEvents?.calendarId || calendarId || '',
      calendar_name: calendarCustomEvents?.calendarName || options.calendarName || ''
    }
  })

  // Canal explícito = override forzado por configuración del calendario.
  if (calendarCustomEvents?.channel === 'messenger' || calendarCustomEvents?.channel === 'instagram') {
    const socialIdentity = await getSocialMessagingIdentity(contactId, calendarCustomEvents.channel)
    return sendMetaWhatsappEvent({
      ...buildScheduleArgs(calendarCustomEvents.channel),
      channel: calendarCustomEvents.channel,
      socialIdentity
    })
  }

  if (calendarCustomEvents?.channel === 'whatsapp') {
    return sendMetaWhatsappEvent({ ...buildScheduleArgs('whatsapp'), channel: 'whatsapp' })
  }

  // smart o configuración global legacy: el payload lo decide la SUPERFICIE
  // REAL de la conversión (dónde vive la conversación del contacto), no la
  // atribución. Sin fallbacks entre canales que falsifiquen el action_source.
  const surface = conversionResolution?.conversionSurface || 'whatsapp'

  if (surface === 'messenger' || surface === 'instagram') {
    const socialIdentity = await getSocialMessagingIdentity(contactId, surface)
    return sendMetaWhatsappEvent({ ...buildScheduleArgs(surface), channel: surface, socialIdentity })
  }

  if (surface === 'website') {
    // Cita creada sin contexto de navegador (webhook/agente) pero cuya
    // actividad real es web: evento website server-side con las señales de
    // la última sesión conocida. Las citas web usan el evento Schedule.
    const latestWebSession = await getLatestContactWebSession(contactId).catch(() => null)
    return sendMetaSiteEvent({
      contactId,
      eventType: EVENT_TYPES.schedule,
      metaEventName: 'Schedule',
      eventId,
      customData: {
        source: 'website',
        conversion_type: EVENT_TYPES.schedule,
        appointment_id: appointmentId,
        calendar_id: calendarCustomEvents?.calendarId || calendarId || '',
        calendar_name: calendarCustomEvents?.calendarName || options.calendarName || ''
      },
      eventSourceUrl: cleanString(latestWebSession?.page_url),
      actionSource: 'website',
      extraUserData: latestWebSession ? { fbp: latestWebSession.fbp, fbc: latestWebSession.fbc } : null,
      attributionTouch
    })
  }

  return sendMetaWhatsappEvent({ ...buildScheduleArgs('whatsapp'), channel: 'whatsapp' })
}

export async function triggerMetaPaymentPurchaseEvent(contactId, payment = {}) {
  const paymentMetaConfig = await getPaymentMetaPurchaseEventConfig()
  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
  }

  // Varios callers (webhooks, sync de invoices, transacciones manuales) pasan
  // objetos "flacos" {id, amount, currency, paymentMode}. Completamos con el
  // row real de payments para que la detección de superficie vea la URL de
  // checkout y el timestamp de conversión reales. Lo pasado explícito gana.
  const paymentRowId = firstPaymentValue([payment.id, payment.paymentId, payment.payment_id])
  if (paymentRowId) {
    const paymentRow = await db.get('SELECT * FROM payments WHERE id = ?', [paymentRowId]).catch(() => null)
    if (paymentRow) {
      payment = { ...paymentRow, ...payment }
    }
  }

  // Atribución interna (último paid touch) + superficie real de conversión.
  // Se calcula y persiste SIEMPRE (aunque el CAPI esté apagado o falle):
  // la atribución interna no depende de Meta. El snapshot es write-once: los
  // re-disparos no lo sobreescriben.
  const conversionResolution = await resolveConversionAttribution({
    contactId,
    conversionType: 'purchase',
    conversionSurface: payment.conversionSurface || payment.conversion_surface || '',
    conversionTime: payment.paid_at || payment.paidAt || payment.date || payment.created_at || payment.createdAt || null,
    payment
  }).catch(error => {
    logger.warn(`No se pudo resolver atribución de conversión para compra del contacto ${contactId}: ${error.message}`)
    return null
  })
  if (conversionResolution && paymentRowId) {
    await persistPaymentConversionAttribution(paymentRowId, conversionResolution)
  }
  const attributionTouch = conversionResolution?.touch || null

  const metaConfig = await getMetaCapiConfig()
  const hasDataset = Boolean(metaConfig.datasetId)
  const paymentMode = getMetaPaymentMode(payment)
  // Id de evento para dejar rastro en el log AUN cuando el envío se omite (antes
  // estos skips desaparecían sin registro y parecía que el pixel "no jalaba").
  const purchaseSkipEventId = `purchase_${firstPaymentValue([paymentRowId, payment.id, contactId]) || 'unknown'}`

  if (!hasDataset && paymentMode === PAYMENT_MODE_TEST) {
    return { sent: false, reason: 'test_payment' }
  }

  if (hasDataset && await shouldSkipTestPaymentForMeta(payment)) {
    await logMetaEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: DEFAULT_PAYMENT_EVENT_NAME,
      eventId: purchaseSkipEventId,
      status: 'skipped',
      errorMessage: 'Pago en modo prueba omitido: activa el código de Test Events de Meta ANTES de pagar para verlo en la pestaña Test Events'
    })
    return { sent: false, reason: 'test_payment', eventId: purchaseSkipEventId }
  }

  if (!paymentMetaConfig.enabled && hasDataset) {
    await logMetaEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: DEFAULT_PAYMENT_EVENT_NAME,
      eventId: purchaseSkipEventId,
      status: 'skipped',
      errorMessage: 'Evento de compra (Purchase) desactivado en Ajustes → Meta'
    })
    return { sent: false, reason: 'disabled', eventId: purchaseSkipEventId }
  }

  const effectivePaymentMetaConfig = paymentMetaConfig.enabled
    ? paymentMetaConfig
    : QR_LABEL_FALLBACK_PAYMENT_META_CONFIG
  const siteMetaEventName = effectivePaymentMetaConfig.eventName || DEFAULT_PAYMENT_EVENT_NAME
  const whatsappMetaEventName = normalizeBusinessMessagingEventName(
    effectivePaymentMetaConfig.channel === 'whatsapp'
      ? effectivePaymentMetaConfig.eventName || DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME
      : DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME
  )
  const eventSourceUrl = sanitizeMetaUrlForEvent(extractPaymentMetaEventSourceUrl(payment))
  const actionSource = resolvePaymentMetaActionSource(payment, eventSourceUrl)
  const eventContext = await buildPaymentPurchaseEventContext(contactId, payment, effectivePaymentMetaConfig)
  if (eventContext.skip) return { sent: false, reason: eventContext.reason, eventId: eventContext.eventId }
  const eventId = eventContext.eventId
  const accountCurrency = await getPaymentMetaCurrency()
  const contact = await getContactForMetaEvent(contactId)
  if (!contact) {
    await logMetaEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: hasDataset ? whatsappMetaEventName : DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME,
      eventId,
      status: 'skipped',
      errorMessage: 'Contacto no encontrado para evento de compra Meta'
    })
    return { sent: false, reason: 'contact_not_found', eventId }
  }

  const variableFields = await getVariableFieldValueMap().catch(() => ({}))
  const templateContext = buildPaymentMetaTemplateContext({
    contact,
    contactId,
    payment: eventContext.payment || payment,
    currency: accountCurrency,
    variableFields
  })
  const customData = buildPaymentMetaPurchaseEventCustomData(effectivePaymentMetaConfig.parameters, eventContext.payment || payment, {
    currency: accountCurrency,
    templateContext,
    ...(eventContext.customDataOptions || {})
  })

  if (!hasDataset) {
    return sendWhatsAppQrPurchaseLabelFallback({
      contact,
      eventType: EVENT_TYPES.purchase,
      metaEventName: DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME,
      eventId,
      customData
    })
  }

  const purchaseArgs = {
    contactId,
    eventType: EVENT_TYPES.purchase,
    metaEventName: whatsappMetaEventName,
    eventId,
    customData,
    skipContactDedupe: eventContext.skipContactDedupe,
    attributionTouch
  }
  const isConversionResult = (r) => Boolean(r) && (r.sent || r.reason === 'already_sent' || r.reason === 'meta_error')

  const sendPurchaseSiteEvent = async () => {
    // Superficie website enviada server-side: sumamos fbp/fbc de la última
    // sesión web conocida para mejorar el matching del evento.
    const latestWebSession = await getLatestContactWebSession(contactId).catch(() => null)
    return sendMetaSiteEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: siteMetaEventName,
      eventId,
      customData,
      eventSourceUrl,
      actionSource,
      skipContactDedupe: eventContext.skipContactDedupe,
      extraUserData: latestWebSession ? { fbp: latestWebSession.fbp, fbc: latestWebSession.fbc } : null,
      attributionTouch
    })
  }

  // Canal explícito = override forzado por configuración (documentado).
  if (paymentMetaConfig.channel === 'whatsapp') {
    return sendMetaWhatsappEvent({ ...purchaseArgs, channel: 'whatsapp' })
  }

  if (paymentMetaConfig.channel === 'messenger' || paymentMetaConfig.channel === 'instagram') {
    const socialIdentity = await getSocialMessagingIdentity(contactId, paymentMetaConfig.channel)
    if (socialIdentity && socialIdentity.channel === paymentMetaConfig.channel) {
      const socialResult = await sendMetaWhatsappEvent({ ...purchaseArgs, channel: socialIdentity.channel, socialIdentity })
      if (isConversionResult(socialResult)) return socialResult
    }
    return sendPurchaseSiteEvent()
  }

  // smart: el payload lo decide la SUPERFICIE REAL de la conversión, no la
  // atribución interna. Si la compra fue por WhatsApp, va como
  // business_messaging/whatsapp aunque el crédito sea de un anuncio web; si
  // fue en el checkout web, va como website aunque el crédito sea de un
  // anuncio de Messenger. Sin fallbacks que falsifiquen el action_source.
  if (paymentMetaConfig.channel === 'smart') {
    const surface = conversionResolution?.conversionSurface || 'website'

    if (surface === 'whatsapp') {
      return sendMetaWhatsappEvent({ ...purchaseArgs, channel: 'whatsapp' })
    }

    if (surface === 'messenger' || surface === 'instagram') {
      const socialIdentity = await getSocialMessagingIdentity(contactId, surface)
      return sendMetaWhatsappEvent({ ...purchaseArgs, channel: surface, socialIdentity })
    }
  }

  return sendPurchaseSiteEvent()
}

export async function triggerMetaPurchaseEventForPaymentRow(paymentId) {
  if (!paymentId) {
    return { sent: false, reason: 'missing_payment_id' }
  }

  const payment = await db.get(
    `SELECT *
     FROM payments
     WHERE id = ?
       AND amount > 0`,
    [paymentId]
  )

  if (!payment || !isSuccessfulPaymentStatus(payment.status)) {
    return { sent: false, reason: 'payment_not_successful' }
  }

  return triggerMetaPaymentPurchaseEvent(payment.contact_id, payment)
}

export const triggerWhatsappFirstPurchaseEvent = triggerMetaPaymentPurchaseEvent
export const triggerWhatsappPurchaseEventForPaymentRow = triggerMetaPurchaseEventForPaymentRow
