import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'
import { getActiveMetaTestEventCode } from '../utils/metaTestCode.js'
import { nonTestPaymentCondition } from '../utils/paymentMode.js'
import { buildPhoneMatchCandidates } from '../utils/phoneUtils.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import { buildMetaParameterUserData, sanitizeMetaUrlForEvent } from './metaParameterManagerService.js'

const CONFIG_KEYS = {
  scheduleEnabled: 'meta_whatsapp_schedule_enabled',
  purchaseEnabled: 'meta_whatsapp_purchase_enabled',
  scheduleEventName: 'meta_whatsapp_schedule_event_name',
  purchaseEventName: 'meta_whatsapp_purchase_event_name',
  paymentPurchaseEventConfig: 'meta_payment_purchase_event_config',
  whatsappBusinessAccountId: 'meta_whatsapp_business_account_id'
}

const EVENT_TYPES = {
  schedule: 'appointment_booked',
  purchase: 'first_purchase'
}
const DEFAULT_CALENDAR_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME = 'LeadSubmitted'
const DEFAULT_PAYMENT_EVENT_NAME = 'Purchase'
const DEFAULT_PAYMENT_EVENT_CHANNEL = 'smart'
const PAYMENT_META_DEFAULT_CURRENCY = 'MXN'
const PAYMENT_META_MAX_CUSTOM_PARAMETERS = 12
const PAYMENT_META_EVENT_OPTIONS = new Set([
  'Purchase',
  'AddPaymentInfo',
  'Schedule',
  'Lead',
  'Contact',
  'FormSubmitted',
  'CompleteRegistration',
  'ViewContent',
  DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME
])
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
    channel: channel === 'whatsapp' ? 'whatsapp' : channel === 'smart' ? 'smart' : 'site',
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
    value: cleanString(source.value),
    predictedLtv: cleanString(source.predictedLtv || source.predicted_ltv),
    custom
  }
}

function normalizePaymentMetaPurchaseEventConfig(value = null) {
  const source = parseJson(value, {})
  const eventSource = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const channel = cleanString(
    eventSource.channel || eventSource.conversionChannel || eventSource.conversion_channel || DEFAULT_PAYMENT_EVENT_CHANNEL
  ).toLowerCase()
  const eventName = cleanString(eventSource.eventName || eventSource.event_name)

  return {
    enabled: parseBoolean(eventSource.enabled, false),
    channel: channel === 'whatsapp' ? 'whatsapp' : channel === 'smart' ? 'smart' : DEFAULT_PAYMENT_EVENT_CHANNEL,
    eventName: channel === 'whatsapp'
      ? normalizeBusinessMessagingEventName(eventName || DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME)
      : PAYMENT_META_EVENT_OPTIONS.has(eventName)
        ? eventName
        : DEFAULT_PAYMENT_EVENT_NAME,
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

function hasWhatsappAttributionSignal(whatsappAttribution = null) {
  if (!whatsappAttribution) return false

  return Boolean(
    cleanString(whatsappAttribution.referral_ctwa_clid)
    || cleanString(whatsappAttribution.referral_source_id)
    || cleanString(whatsappAttribution.referral_source_url)
    || cleanString(whatsappAttribution.referral_headline)
    || cleanString(whatsappAttribution.ad_id_thru_message)
  )
}

function extractPaymentMetaEventSourceUrl(payment = {}) {
  const sourceUrl = cleanString(
    payment.eventSourceUrl
    || payment.event_source_url
    || payment.sourceUrl
    || payment.source_url
    || payment.checkoutUrl
    || payment.checkout_url
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
    payment.ghl_invoice_id,
    payment.invoice_number,
    metadata.orderId,
    metadata.order_id,
    metadata.public_payment_id,
    metadata.ristak_payment_id,
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

function buildPaymentMetaPurchaseEventCustomData(parameters = {}, payment = {}, options = {}) {
  const normalizedParameters = normalizePaymentMetaPurchaseEventParameters(parameters)
  const normalizedAmount = parseMetaNumber(normalizedParameters.value)
  const paymentAmount = parseMetaNumber(payment.amount)
  const predictedLtv = parseMetaNumber(normalizedParameters.predictedLtv)
  const currency = normalizeMetaCurrency(options.currency)
  const metadata = getPaymentMetadata(payment)
  const paymentPlan = pickPaymentPlanMetadata(metadata)
  const customData = {
    source: 'ristak_payment',
    conversion_type: EVENT_TYPES.purchase
  }

  const finalValue = normalizedParameters.sendValue === false
    ? null
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

  const paymentPlanId = firstPaymentValue([paymentPlan.flowId, paymentPlan.flow_id, payment.flow_id, metadata.flow_id])
  if (paymentPlanId) {
    customData.payment_plan_id = paymentPlanId
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
      const value = cleanString(parameter.value)
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

  const paymentMode = cleanString(payment.payment_mode || payment.paymentMode).toLowerCase()
  if (paymentMode === 'test') return null

  const contactId = cleanString(
    options.contactId ||
    payment.contact_id ||
    payment.contactId ||
    payment.contact?.id
  )
  if (!contactId) return null

  const paymentMetaConfig = await getPaymentMetaPurchaseEventConfig()
  if (!paymentMetaConfig.enabled || paymentMetaConfig.channel !== 'site') return null

  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId) return null

  const accountCurrency = await getPaymentMetaCurrency()
  const customData = buildPaymentMetaPurchaseEventCustomData(paymentMetaConfig.parameters, payment, {
    currency: accountCurrency
  })

  return {
    pixelId: metaConfig.datasetId,
    eventName: paymentMetaConfig.eventName || DEFAULT_PAYMENT_EVENT_NAME,
    eventId: `purchase_contact_${contactId}`,
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

function buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution) {
  const userData = buildUserData(contact)
  const ctwaClid = cleanString(contact.attribution_ctwa_clid || whatsappAttribution?.referral_ctwa_clid)
  const pageId = cleanString(metaConfig?.pageId)
  const whatsappBusinessAccountId = cleanString(metaConfig?.whatsappBusinessAccountId)

  if (ctwaClid) {
    userData.ctwa_clid = ctwaClid
  }

  if (pageId) {
    userData.page_id = pageId
  }

  if (whatsappBusinessAccountId) {
    userData.whatsapp_business_account_id = whatsappBusinessAccountId
  }

  return userData
}

function buildBusinessMessagingCustomData(customData, contact, whatsappAttribution) {
  const enrichedData = { ...customData }
  const adId = cleanString(
    contact.attribution_ad_id ||
    whatsappAttribution?.referral_source_id ||
    whatsappAttribution?.ad_id_thru_message
  )
  const adName = cleanString(contact.attribution_ad_name || whatsappAttribution?.referral_headline)
  const referralSourceType = cleanString(whatsappAttribution?.referral_source_type)
  const referralSourceUrl = cleanString(whatsappAttribution?.referral_source_url)
  const attributionSource = cleanString(whatsappAttribution?.attribution_source)

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
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuración de Meta para WhatsApp CAPI: ${error.message}`)
    return null
  })

  const datasetId = cleanString(
    metaConfig?.pixel_id ||
    process.env.META_PIXEL_ID ||
    process.env.META_DATASET_ID ||
    process.env.DATASET_ID
  )

  const accessToken = cleanString(
    metaConfig?.pixel_api_token ||
    process.env.META_ACCESS_TOKEN ||
    metaConfig?.access_token
  )

  const testEventCode = cleanString(await getActiveMetaTestEventCode())

  const pageId = cleanString(
    metaConfig?.page_id ||
    process.env.META_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID
  )

  const whatsappBusinessAccountId = cleanString(
    await getAppConfig(CONFIG_KEYS.whatsappBusinessAccountId) ||
    process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ||
    process.env.META_WABA_ID ||
    process.env.WABA_ID
  )

  return {
    datasetId,
    accessToken,
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

async function postEventToMeta({ datasetId, accessToken, payload }) {
  const url = `${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  let responsePayload = null
  const responseText = await response.text()
  try {
    responsePayload = responseText ? JSON.parse(responseText) : {}
  } catch {
    responsePayload = { raw: responseText }
  }

  if (!response.ok || responsePayload?.error) {
    const message = responsePayload?.error?.message || `Meta CAPI error ${response.status}`
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
  customData
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

  if (!contact.phone) {
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

  if (contactAlreadySent(contact, eventType)) {
    return { sent: false, reason: 'already_sent' }
  }

  const whatsappAttribution = await getLatestWhatsappAttribution(contact)
  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId || !metaConfig.accessToken) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      errorMessage: 'Falta META_PIXEL_ID/DATASET_ID o META_ACCESS_TOKEN/Pixel API Token'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  const userData = buildBusinessMessagingUserData(contact, metaConfig, whatsappAttribution)
  if (!userData.ph || !userData.external_id) {
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

  if (!userData.ctwa_clid) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta ctwa_clid para atribuir el evento de WhatsApp'
    })
    return { sent: false, reason: 'missing_ctwa_clid' }
  }

  const enrichedCustomData = buildBusinessMessagingCustomData(customData, contact, whatsappAttribution)
  const payload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
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
      payload
    })

    await markContactEventSent(contactId, eventType, eventId)
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    logger.info(`✅ Evento WhatsApp ${eventType} enviado a Meta para contacto ${contactId}`)
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
  actionSource = 'website'
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

  if (contactAlreadySent(contact, eventType)) {
    return { sent: false, reason: 'already_sent' }
  }

  const metaConfig = await getMetaCapiConfig()
  if (!metaConfig.datasetId || !metaConfig.accessToken) {
    await logMetaEvent({
      contactId,
      eventType,
      metaEventName,
      eventId,
      status: 'error',
      errorMessage: 'Falta META_PIXEL_ID/DATASET_ID o META_ACCESS_TOKEN/Pixel API Token'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  const userData = buildUserData(contact)
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

  const payload = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: normalizeMetaActionSource(actionSource, 'website'),
        event_id: eventId,
        user_data: userData,
        custom_data: customData || {}
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
      payload
    })

    await markContactEventSent(contactId, eventType, eventId)
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

  if (usesCalendarConfig && calendarCustomEvents.channel !== 'whatsapp') {
    return { sent: false, reason: 'calendar_channel_not_whatsapp' }
  }

  if (!usesCalendarConfig && !await getConfigBoolean(CONFIG_KEYS.scheduleEnabled, false)) {
    return { sent: false, reason: 'disabled' }
  }

  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
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
  const appointmentId = cleanString(options.appointmentId || options.appointment_id)
  const eventId = appointmentId
    ? `schedule_appointment_${appointmentId}`
    : `schedule_contact_${contactId}`

  return sendMetaWhatsappEvent({
    contactId,
    eventType: EVENT_TYPES.schedule,
    metaEventName,
    eventId,
    customData: {
      source: 'whatsapp',
      conversion_type: EVENT_TYPES.schedule,
      appointment_id: appointmentId,
      calendar_id: calendarCustomEvents?.calendarId || calendarId || '',
      calendar_name: calendarCustomEvents?.calendarName || options.calendarName || ''
    }
  })
}

export async function triggerMetaPaymentPurchaseEvent(contactId, payment = {}) {
  const paymentMetaConfig = await getPaymentMetaPurchaseEventConfig()
  if (!paymentMetaConfig.enabled) {
    return { sent: false, reason: 'disabled' }
  }

  if (!contactId) {
    return { sent: false, reason: 'missing_contact_id' }
  }

  const paymentMode = String(payment.payment_mode || payment.paymentMode || '').trim().toLowerCase()
  if (paymentMode === 'test') {
    return { sent: false, reason: 'test_payment' }
  }

  const siteMetaEventName = paymentMetaConfig.eventName || DEFAULT_PAYMENT_EVENT_NAME
  const whatsappMetaEventName = normalizeBusinessMessagingEventName(
    paymentMetaConfig.channel === 'whatsapp'
      ? paymentMetaConfig.eventName || DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME
      : DEFAULT_PAYMENT_WHATSAPP_EVENT_NAME
  )
  const eventId = `purchase_contact_${contactId}`
  const eventSourceUrl = sanitizeMetaUrlForEvent(extractPaymentMetaEventSourceUrl(payment))
  const actionSource = resolvePaymentMetaActionSource(payment, eventSourceUrl)
  const accountCurrency = await getPaymentMetaCurrency()
  const customData = buildPaymentMetaPurchaseEventCustomData(paymentMetaConfig.parameters, payment, {
    currency: accountCurrency
  })

  if (paymentMetaConfig.channel === 'whatsapp') {
    return sendMetaWhatsappEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: whatsappMetaEventName,
      eventId,
      customData
    })
  }

  const smartChannel = paymentMetaConfig.channel === 'smart'
    ? hasWhatsappAttributionSignal(await getLatestWhatsappAttribution(await getContactForMetaEvent(contactId)))
    : false

  if (smartChannel) {
    const whatsappResult = await sendMetaWhatsappEvent({
      contactId,
      eventType: EVENT_TYPES.purchase,
      metaEventName: whatsappMetaEventName,
      eventId,
      customData
    })

    if (whatsappResult.sent || whatsappResult.reason === 'already_sent' || whatsappResult.reason === 'meta_error') {
      return whatsappResult
    }
  }

  return sendMetaSiteEvent({
    contactId,
    eventType: EVENT_TYPES.purchase,
    metaEventName: siteMetaEventName,
    eventId,
    customData,
    eventSourceUrl,
    actionSource
  })
}

export async function triggerMetaPurchaseEventForPaymentRow(paymentId) {
  if (!paymentId) {
    return { sent: false, reason: 'missing_payment_id' }
  }

  const payment = await db.get(
    `SELECT *
     FROM payments
     WHERE id = ?
       AND amount > 0
       AND ${nonTestPaymentCondition()}`,
    [paymentId]
  )

  if (!payment || !isSuccessfulPaymentStatus(payment.status)) {
    return { sent: false, reason: 'payment_not_successful' }
  }

  return triggerMetaPaymentPurchaseEvent(payment.contact_id, payment)
}

export const triggerWhatsappFirstPurchaseEvent = triggerMetaPaymentPurchaseEvent
export const triggerWhatsappPurchaseEventForPaymentRow = triggerMetaPurchaseEventForPaymentRow
