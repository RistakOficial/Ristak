import { randomBytes } from 'crypto'
import { DateTime } from 'luxon'
import { db } from '../config/database.js'
import { getGHLClient } from './ghlClient.js'
import { buildInvoicePaymentUrl } from '../utils/paymentUrl.js'
import { getInvoicePaymentMode } from '../utils/paymentMode.js'
import { updateSingleContactStats } from '../utils/updateContactsStats.js'
import { logger } from '../utils/logger.js'

export const PAYMENT_FLOW_STATES = {
  DRAFT: 'draft',
  FIRST_PAYMENT_PENDING: 'first_payment_pending',
  FIRST_PAYMENT_REGISTERED: 'first_payment_registered',
  OFFLINE_PAYMENT_REGISTERED: 'offline_payment_registered',
  CARD_SETUP_LINK_SENT: 'card_setup_link_sent',
  WAITING_CARD_AUTHORIZATION: 'waiting_card_authorization',
  CARD_AUTHORIZED: 'card_authorized',
  INSTALLMENT_PLAN_CREATED: 'installment_plan_created',
  INSTALLMENT_PLAN_ACTIVE: 'installment_plan_active',
  CANCELLED: 'cancelled',
  OVERDUE: 'overdue'
}

const DEFAULT_CARD_SETUP_AMOUNT = 25
const DEFAULT_PAYMENT_TIMEZONE = 'America/Mexico_City'
const OFFLINE_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'offline', 'manual', 'check', 'other'])
const CARD_METHODS = new Set(['card', 'payment_link', 'direct_card', 'saved_card'])
const CURRENCY_DEFAULT = 'MXN'

function normalizeGhlInvoiceMode(mode) {
  return mode === 'test' ? 'test' : 'live'
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function normalizeAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100) / 100
}

function normalizeDateOnly(value, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const zone = resolveScheduleTimezone(timezone)
  if (!value) return DateTime.now().setZone(zone).toISODate()

  if (value instanceof Date) {
    const date = DateTime.fromJSDate(value, { zone: 'utc' })
    return date.isValid ? date.toISODate() : DateTime.now().setZone(zone).toISODate()
  }

  if (typeof value === 'object' && typeof value.toISOString === 'function') {
    const isoText = value.toISOString()
    const dateOnlyMatch = isoText.match(/^(\d{4}-\d{2}-\d{2})/)
    if (dateOnlyMatch) return dateOnlyMatch[1]

    const date = DateTime.fromISO(isoText, { zone: 'utc' })
    return date.isValid ? date.toISODate() : DateTime.now().setZone(zone).toISODate()
  }

  const text = String(value).trim()
  const dateOnlyMatch = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (dateOnlyMatch) return dateOnlyMatch[1]

  const isoDate = DateTime.fromISO(text, { setZone: true })
  if (isoDate.isValid) return isoDate.setZone(zone).toISODate()

  const jsDate = new Date(text)
  if (!Number.isNaN(jsDate.getTime())) {
    const parsedDate = DateTime.fromJSDate(jsDate, { zone: 'utc' }).setZone(zone)
    if (parsedDate.isValid) return parsedDate.toISODate()
  }

  return DateTime.now().setZone(zone).toISODate()
}

function todayDateOnly(timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const zone = resolveScheduleTimezone(timezone)
  return DateTime.now().setZone(zone).toISODate()
}

function resolveInvoiceDates(dueDate, fallbackDueDate, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const issueDate = todayDateOnly(timezone)
  const requestedDueDate = normalizeDateOnly(dueDate || fallbackDueDate || issueDate, timezone)

  return {
    issueDate,
    dueDate: requestedDueDate < issueDate ? issueDate : requestedDueDate
  }
}

function addState(history, state) {
  if (!state) return history
  return [
    ...history,
    {
      state,
      at: new Date().toISOString()
    }
  ]
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function maybeJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  return safeJsonParse(value, {})
}

function normalizeText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    return String(value.status || value.value || value.name || '').trim().toLowerCase()
  }
  return String(value).trim().toLowerCase()
}

function shouldForceNewCardAuthorization(payload = {}) {
  const preference = normalizeText(
    payload.cardAuthorizationPreference ||
    payload.cardPreference ||
    payload.storedCardPreference ||
    payload.paymentCardPreference ||
    payload.savedCardPreference ||
    ''
  )

  if (payload.useStoredCard === false || payload.useSavedCard === false || payload.useExistingCard === false) return true
  if (payload.forceCardSetup === true || payload.requireNewCard === true || payload.newCard === true) return true

  return /(new_card|nueva|nuevo|otra|otro|different|link|domicili|autoriza|authorization|setup)/.test(preference)
}

function normalizeLookupText(value) {
  return String(value || '').trim()
}

function maskIdentifier(value) {
  if (!value) return null
  const text = String(value)
  if (text.length <= 10) return text
  return `${text.slice(0, 6)}...${text.slice(-4)}`
}

function amountsMatch(left, right, tolerance = 0.01) {
  return Math.abs(normalizeAmount(left) - normalizeAmount(right)) <= tolerance
}

function combineTextSections(...sections) {
  return sections
    .map(section => String(section || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

function formatCurrencyAmount(amount, currency = CURRENCY_DEFAULT) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(normalizeAmount(amount))
}

function formatPercentValue(value) {
  const percentage = Number(value)
  if (!Number.isFinite(percentage)) return null
  return `${Number.isInteger(percentage) ? percentage : percentage.toFixed(2).replace(/\.?0+$/, '')}%`
}

function formatPlanDate(value, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const normalizedDate = normalizeDateOnly(value, timezone)
  const date = DateTime.fromISO(normalizedDate, { zone: resolveScheduleTimezone(timezone) })
  return date.isValid ? date.toFormat('dd/LL/yyyy') : normalizedDate
}

function paymentOrdinalLabel(index) {
  if (index === 1) return '1er'
  if (index === 3) return '3er'
  return `${index}o`
}

function frequencyLabel(frequency, count) {
  const plural = count === 1 ? '' : 's'
  const labels = {
    weekly: `semanal${plural === 's' ? 'es' : ''}`,
    biweekly: `quincenal${plural === 's' ? 'es' : ''}`,
    monthly: `mensual${plural === 's' ? 'es' : ''}`,
    custom: `personalizado${plural}`
  }

  return labels[frequency] || labels.custom
}

function getPlanFeePercentage(flow) {
  const metadata = safeJsonParse(flow?.metadata, {})
  const value = (
    metadata.installmentFeePercentage ??
    metadata.paymentPlanFeePercentage ??
    metadata.planFeePercentage ??
    metadata.financingPercentage ??
    metadata.surchargePercentage ??
    null
  )
  const percentage = Number(value)
  return Number.isFinite(percentage) && percentage > 0 ? percentage : null
}

function getPaymentPercentage({ explicitPercentage, amount, totalAmount }) {
  if (explicitPercentage !== null && explicitPercentage !== undefined && explicitPercentage !== '') {
    return Number(explicitPercentage)
  }

  if (totalAmount > 0) {
    return normalizeAmount((normalizeAmount(amount) / totalAmount) * 100)
  }

  return null
}

function buildPaymentPlanSummary(flow, installments = [], options = {}) {
  if (!flow) return ''

  const currency = flow.currency || CURRENCY_DEFAULT
  const timezone = options.timezone || DEFAULT_PAYMENT_TIMEZONE
  const totalAmount = normalizeAmount(flow.total_amount || flow.totalAmount)
  const frequency = options.frequency || safeJsonParse(flow.metadata, {}).remainingFrequency || installments[0]?.frequency || 'custom'
  const payments = []

  if (normalizeAmount(flow.first_payment_amount) > 0 && flow.first_payment_status !== 'not_required') {
    const firstPaymentPercentage = flow.first_payment_type === 'percentage'
      ? Number(flow.first_payment_value)
      : getPaymentPercentage({
        explicitPercentage: null,
        amount: flow.first_payment_amount,
        totalAmount
      })

    payments.push({
      amount: normalizeAmount(flow.first_payment_amount),
      percentage: firstPaymentPercentage,
      date: flow.first_payment_date || todayDateOnly(timezone)
    })
  }

  for (const installment of installments) {
    payments.push({
      amount: normalizeAmount(installment.amount),
      percentage: getPaymentPercentage({
        explicitPercentage: installment.percentage,
        amount: installment.amount,
        totalAmount
      }),
      date: getInstallmentDueDateValue(installment)
    })
  }

  if (payments.length === 0) return ''

  const feePercentage = getPlanFeePercentage(flow)
  const header = [
    `${payments.length} pago${payments.length === 1 ? '' : 's'} ${frequencyLabel(frequency, payments.length)}${feePercentage ? ` (+${formatPercentValue(feePercentage)})` : ''}`,
    `Total: ${formatCurrencyAmount(totalAmount, currency)}`
  ]

  const detailLines = payments.flatMap((payment, index) => {
    const percentLabel = formatPercentValue(payment.percentage)
    return [
      `${paymentOrdinalLabel(index + 1)} pago - ${formatPlanDate(payment.date, timezone)}${percentLabel ? ` - ${percentLabel}` : ''}`,
      formatCurrencyAmount(payment.amount, currency)
    ]
  })

  return [...header, ...detailLines].join('\n')
}

function hasFirstPlanPayment(flow) {
  return normalizeAmount(flow?.first_payment_amount) > 0 && flow?.first_payment_status !== 'not_required'
}

function getInstallmentPaymentNumber(flow, installment) {
  return Number(installment.sequence || 1) + (hasFirstPlanPayment(flow) ? 1 : 0)
}

function normalizeOptionalBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'live', 'production', 'prod'].includes(normalized)) return true
  if (['false', '0', 'test', 'testing', 'sandbox'].includes(normalized)) return false
  return null
}

function normalizeTransactionList(response) {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.data)) return response.data
  if (Array.isArray(response?.transactions)) return response.transactions
  if (Array.isArray(response?.payments)) return response.payments
  return []
}

function getTransactionInvoiceId(transaction, chargeSnapshot = {}) {
  const entitySource = maybeJsonObject(transaction.entitySource || transaction.entity_source)
  const entitySourceMeta = maybeJsonObject(transaction.entitySourceMeta || transaction.entity_source_meta)
  const metadata = maybeJsonObject(chargeSnapshot.metadata)

  return (
    transaction.invoiceId ||
    transaction.invoice_id ||
    transaction.entitySourceId ||
    transaction.entity_source_id ||
    transaction.entityId ||
    transaction.entity_id ||
    entitySource.id ||
    entitySource.invoiceId ||
    entitySourceMeta.invoiceId ||
    metadata.invoiceId ||
    metadata.invoice_id ||
    null
  )
}

function isSuccessfulGhlTransaction(transaction, chargeSnapshot = {}) {
  const transactionStatus = normalizeText(transaction.status)
  const chargeStatus = normalizeText(chargeSnapshot.status)
  const liveMode = normalizeOptionalBoolean(
    transaction.liveMode ??
    transaction.live_mode ??
    chargeSnapshot.livemode ??
    chargeSnapshot.liveMode
  )
  const chargeSucceeded = ['paid', 'succeeded', 'captured', 'complete', 'completed', 'success'].includes(chargeStatus)

  // En test mode GHL puede devolver la transacción como refunded aunque el charge
  // haya autorizado la tarjeta correctamente. Para producción, refunded sigue bloqueado.
  if (transactionStatus === 'refunded' && liveMode === false && chargeSucceeded) {
    return true
  }

  if (['failed', 'declined', 'canceled', 'cancelled', 'void', 'refunded'].includes(transactionStatus)) {
    return false
  }

  if (['paid', 'succeeded', 'captured', 'complete', 'completed', 'success'].includes(transactionStatus)) {
    return true
  }

  return chargeSucceeded
}

function extractGhlPaymentMethodFromTransaction(transaction, authorizationInvoiceId = null) {
  if (!transaction) return null

  const chargeSnapshot = maybeJsonObject(transaction.chargeSnapshot || transaction.charge_snapshot)
  if (!isSuccessfulGhlTransaction(transaction, chargeSnapshot)) return null

  const rawPaymentMethod = (
    chargeSnapshot.payment_method ||
    chargeSnapshot.paymentMethod ||
    transaction.payment_method ||
    transaction.paymentMethod
  )
  const paymentMethodSnapshot = typeof rawPaymentMethod === 'string'
    ? { id: rawPaymentMethod }
    : maybeJsonObject(rawPaymentMethod)
  const transactionPaymentMethod = maybeJsonObject(transaction.paymentMethod || transaction.payment_method)
  const card = maybeJsonObject(paymentMethodSnapshot.card || transactionPaymentMethod.card || chargeSnapshot.payment_method_details?.card)
  const paymentMethodId = (
    paymentMethodSnapshot.id ||
    chargeSnapshot.payment_method_id ||
    chargeSnapshot.paymentMethodId ||
    transaction.paymentMethodId ||
    transaction.payment_method_id ||
    transaction.cardId ||
    null
  )
  const customerId = (
    paymentMethodSnapshot.customer ||
    chargeSnapshot.customer ||
    transaction.customerId ||
    transaction.customer_id ||
    transaction.customer?.id ||
    null
  )

  if (!paymentMethodId || !customerId) return null

  const liveMode = normalizeOptionalBoolean(
    transaction.liveMode ??
    transaction.live_mode ??
    chargeSnapshot.livemode ??
    chargeSnapshot.liveMode ??
    paymentMethodSnapshot.livemode
  )

  return {
    customerId,
    paymentMethodId,
    type: paymentMethodSnapshot.type || transactionPaymentMethod.type || 'card',
    brand: card.brand || transactionPaymentMethod.card?.brand || 'card',
    last4: card.last4 || transactionPaymentMethod.card?.last4 || '****',
    authorizationInvoiceId,
    providerType: transaction.paymentProviderType || transaction.payment_provider_type || transaction.paymentProvider?.type || null,
    providerAccount: transaction.paymentProviderConnectedAccount || transaction.payment_provider_connected_account || transaction.paymentProvider?.connectedAccount?.accountId || transaction.paymentProvider?.connectedAccount?._id || null,
    liveMode
  }
}

function pickSendMethod(contact, channels = {}) {
  const wantsEmail = channels.email !== false
  const wantsSms = channels.sms !== false
  const wantsWhatsapp = channels.whatsapp !== false
  const hasEmail = Boolean(contact?.email && wantsEmail)
  const hasPhone = Boolean(contact?.phone && (wantsSms || wantsWhatsapp))

  if (hasEmail && hasPhone) return 'both'
  if (hasPhone) return 'sms'
  if (hasEmail) return 'email'
  return 'none'
}

function hasExplicitChannelSelection(channels = {}) {
  if (!channels || typeof channels !== 'object') return false

  return ['email', 'sms', 'whatsapp'].some((channel) => (
    channels[channel] === true || channels[channel] === false
  ))
}

function assertAiAgentSendablePaymentChannel(payload = {}, contact = {}, actionLabel = 'el cobro') {
  if (payload.source !== 'ai_agent') return

  if (!hasExplicitChannelSelection(payload.channels)) {
    throw new Error(`Antes de crear ${actionLabel}, el Agente AI debe pedir y recibir un canal de envío real: correo, WhatsApp, SMS o todos.`)
  }

  if (pickSendMethod(contact, payload.channels) === 'none') {
    throw new Error(`No se puede crear ${actionLabel} desde el Agente AI sin un correo o teléfono válido para enviar el enlace.`)
  }
}

async function getInvoiceSendContext() {
  const config = await db.get(`
    SELECT location_data, ghl_invoice_mode, invoice_title, invoice_terms_notes, invoice_number_prefix
    FROM highlevel_config
    LIMIT 1
  `)

  if (!config || !config.location_data) {
    throw new Error('Configura tu cuenta de HighLevel antes de enviar cobros')
  }

  const locationData = typeof config.location_data === 'string'
    ? JSON.parse(config.location_data)
    : config.location_data

  const business = locationData?.business || {}
  const fromName = business.name || locationData?.name || null
  const fromEmail = business.email || locationData?.email || null
  const businessDetails = {
    name: fromName || 'Mi Negocio',
    phoneNo: business.phone || locationData?.phone || '',
    website: business.website || locationData?.website || '',
    address: business.address || locationData?.address || '',
    city: business.city || locationData?.city || '',
    state: business.state || locationData?.state || '',
    country: business.country || locationData?.country || '',
    countryCode: business.countryCode || locationData?.countryCode || '',
    postalCode: business.postalCode || locationData?.postalCode || ''
  }

  return {
    domain: locationData?.domain || null,
    liveMode: normalizeGhlInvoiceMode(config.ghl_invoice_mode) === 'live',
    timezone: locationData?.timezone || DEFAULT_PAYMENT_TIMEZONE,
    invoiceTitle: config.invoice_title || 'PAGO',
    termsNotes: config.invoice_terms_notes || null,
    invoiceNumberPrefix: config.invoice_number_prefix || null,
    businessDetails,
    sentFrom: {
      fromName,
      fromEmail
    }
  }
}

async function getPaymentFlowConfig() {
  const config = await db.get('SELECT location_id, card_setup_amount, ghl_invoice_mode FROM highlevel_config LIMIT 1')
  const cardSetupAmount = normalizeAmount(config?.card_setup_amount || DEFAULT_CARD_SETUP_AMOUNT)

  return {
    locationId: config?.location_id || null,
    cardSetupAmount: cardSetupAmount > 0 ? cardSetupAmount : DEFAULT_CARD_SETUP_AMOUNT,
    liveMode: normalizeGhlInvoiceMode(config?.ghl_invoice_mode) === 'live'
  }
}

function getStoredGhlPaymentMethod(flow) {
  if (!flow?.ghl_customer_id || !flow?.ghl_payment_method_id) return null

  return {
    customerId: flow.ghl_customer_id,
    paymentMethodId: flow.ghl_payment_method_id,
    type: flow.ghl_payment_method_type || 'card',
    brand: flow.ghl_card_brand || 'card',
    last4: flow.ghl_card_last4 || '****',
    authorizationInvoiceId: flow.ghl_card_authorization_invoice_id || null,
    providerType: flow.ghl_payment_provider_type || null,
    providerAccount: flow.ghl_payment_provider_account || null,
    liveMode: normalizeOptionalBoolean(flow.ghl_payment_live_mode)
  }
}

async function persistGhlPaymentMethodForFlow(flowId, paymentMethod) {
  if (!flowId || !paymentMethod?.customerId || !paymentMethod?.paymentMethodId) return

  await db.run(
    `UPDATE payment_flows
     SET ghl_customer_id = ?,
         ghl_payment_method_id = ?,
         ghl_payment_method_type = ?,
         ghl_card_brand = ?,
         ghl_card_last4 = ?,
         ghl_card_authorization_invoice_id = ?,
         ghl_payment_provider_type = ?,
         ghl_payment_provider_account = ?,
         ghl_payment_live_mode = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      paymentMethod.customerId,
      paymentMethod.paymentMethodId,
      paymentMethod.type || 'card',
      paymentMethod.brand || 'card',
      paymentMethod.last4 || '****',
      paymentMethod.authorizationInvoiceId || null,
      paymentMethod.providerType || null,
      paymentMethod.providerAccount || null,
      paymentMethod.liveMode === null || paymentMethod.liveMode === undefined ? null : (paymentMethod.liveMode ? 1 : 0),
      flowId
    ]
  )
}

function getPaidAuthorizationInvoiceId(flow) {
  const firstPaymentMethod = flow.first_payment_method || flow.firstPaymentMethod
  const firstPaymentStatus = flow.first_payment_status || flow.firstPaymentStatus
  const firstPaymentInvoiceId = flow.first_payment_invoice_id || flow.firstPaymentInvoiceId
  const cardSetupStatus = flow.card_setup_status || flow.cardSetupStatus
  const cardSetupInvoiceId = flow.card_setup_invoice_id || flow.cardSetupInvoiceId

  if (cardSetupInvoiceId && cardSetupStatus === 'paid') {
    return cardSetupInvoiceId
  }

  if (firstPaymentInvoiceId && firstPaymentStatus === 'paid' && CARD_METHODS.has(firstPaymentMethod)) {
    return firstPaymentInvoiceId
  }

  return null
}

async function findGhlPaymentMethodFromInvoice({ ghlClient, invoiceId, contactId }) {
  if (!invoiceId) return null

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await ghlClient.listPaymentTransactions({
      entityId: invoiceId,
      ...(contactId ? { contactId } : {}),
      limit: 20,
      offset: 0
    })
    const transactions = normalizeTransactionList(response)
    const invoiceTransactions = transactions.filter((transaction) => {
      const chargeSnapshot = maybeJsonObject(transaction.chargeSnapshot || transaction.charge_snapshot)
      const transactionInvoiceId = getTransactionInvoiceId(transaction, chargeSnapshot)
      return !transactionInvoiceId || transactionInvoiceId === invoiceId
    })
    const candidates = invoiceTransactions.length > 0 ? invoiceTransactions : transactions

    candidates.sort((a, b) => {
      const aTime = Date.parse(a.fulfilledAt || a.createdAt || a.updatedAt || 0) || 0
      const bTime = Date.parse(b.fulfilledAt || b.createdAt || b.updatedAt || 0) || 0
      return bTime - aTime
    })

    for (const transaction of candidates) {
      const method = extractGhlPaymentMethodFromTransaction(transaction, invoiceId)
      if (method) return method
    }

    if (attempt === 0 && candidates.length > 0) {
      const statuses = candidates.map((transaction) => {
        const chargeSnapshot = maybeJsonObject(transaction.chargeSnapshot || transaction.charge_snapshot)
        const liveMode = normalizeOptionalBoolean(transaction.liveMode ?? transaction.live_mode ?? chargeSnapshot.livemode ?? chargeSnapshot.liveMode)
        return `${normalizeText(transaction.status) || 'sin_status'}/${normalizeText(chargeSnapshot.status) || 'sin_charge'}${liveMode === false ? '/test' : liveMode === true ? '/live' : ''}`
      })
      logger.warn(`GHL devolvió transacciones sin paymentMethod utilizable para invoice ${invoiceId}: ${statuses.join(', ')}`)
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }

  return null
}

function extractScheduleId(response) {
  return (
    response?._id ||
    response?.id ||
    response?.schedule?._id ||
    response?.schedule?.id ||
    response?.data?._id ||
    response?.data?.id ||
    null
  )
}

async function findStoredGhlPaymentMethodForContact(contactId, expectedLiveMode) {
  if (!contactId) return null

  const row = await db.get(
    `SELECT ghl_customer_id, ghl_payment_method_id, ghl_payment_method_type,
            ghl_card_brand, ghl_card_last4, ghl_card_authorization_invoice_id,
            ghl_payment_provider_type, ghl_payment_provider_account, ghl_payment_live_mode
     FROM payment_flows
     WHERE contact_id = ?
       AND ghl_customer_id IS NOT NULL
       AND ghl_payment_method_id IS NOT NULL
       AND (ghl_payment_live_mode IS NULL OR ghl_payment_live_mode = ?)
     ORDER BY card_authorized_at DESC, updated_at DESC
     LIMIT 1`,
    [contactId, expectedLiveMode ? 1 : 0]
  )

  return getStoredGhlPaymentMethod(row)
}

async function getAuthorizedPaymentMethod(contactOrFlow, options = {}) {
  const isFlow = Boolean(contactOrFlow.contact_id || contactOrFlow.first_payment_invoice_id || contactOrFlow.card_setup_invoice_id)
  const flowId = isFlow ? contactOrFlow.id : contactOrFlow.flow_id
  const contactId = contactOrFlow.contact_id || contactOrFlow.id
  const storedMethod = getStoredGhlPaymentMethod(contactOrFlow)

  if (storedMethod) return storedMethod

  const { liveMode } = await getPaymentFlowConfig()
  const authorizationInvoiceId = getPaidAuthorizationInvoiceId(contactOrFlow)

  if (authorizationInvoiceId) {
    const ghlClient = options.ghlClient || await getGHLClient()
    const paymentMethod = await findGhlPaymentMethodFromInvoice({
      ghlClient,
      invoiceId: authorizationInvoiceId,
      contactId
    })

    if (paymentMethod) {
      await persistGhlPaymentMethodForFlow(flowId, paymentMethod)
      return paymentMethod
    }

    logger.warn(`GHL no devolvió paymentMethod autorizado para invoice ${authorizationInvoiceId}`)
  }

  return await findStoredGhlPaymentMethodForContact(contactId, liveMode)
}

function buildInvoicePayload({ basePayload, contact, amount, currency, concept, title, dueDate, summaryDetails }) {
  const contactName = contact.name || contact.email || contact.phone || 'Cliente'
  const businessDetails = basePayload?.businessDetails || { name: 'Mi Negocio' }
  const termsNotes = combineTextSections(basePayload?.termsNotes, summaryDetails)
  const invoiceDates = resolveInvoiceDates(dueDate, basePayload?.dueDate, basePayload?.timezone)
  const itemDescription = combineTextSections(concept || title || 'Pago', summaryDetails)

  return {
    name: concept || title || 'Pago',
    title: basePayload?.title || 'PAGO',
    currency,
    businessDetails,
    contactDetails: {
      id: contact.id,
      name: contactName,
      email: contact.email || '',
      phoneNo: contact.phone || ''
    },
    items: [
      {
        name: title || concept || 'Pago',
        description: itemDescription,
        amount,
        qty: 1,
        currency
      }
    ],
    issueDate: invoiceDates.issueDate,
    dueDate: invoiceDates.dueDate,
    liveMode: basePayload?.liveMode !== undefined ? basePayload.liveMode : true,
    sentTo: {
      email: contact.email ? [contact.email] : [],
      phoneNo: contact.phone ? [contact.phone] : []
    },
    paymentMethods: basePayload?.paymentMethods || {
      stripe: {
        enableBankDebitOnly: false
      }
    },
    ...(termsNotes && { termsNotes })
  }
}

async function insertLocalInvoicePayment({ invoice, contactId, fallbackAmount, fallbackCurrency, fallbackDescription, sentAt = null, status = 'draft', paymentMode = 'live' }) {
  const ghlInvoiceId = invoice.id || invoice._id
  const items = invoice.items || invoice.invoiceItems || []
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0) * Number(item.qty || 1), 0)
  const taxAmount = Number(invoice.tax?.amount || 0)
  const total = normalizeAmount(invoice.total || invoice.amount || subtotal + taxAmount || fallbackAmount)
  const resolvedPaymentMode = getInvoicePaymentMode(invoice, paymentMode)

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      reference, description, date, ghl_invoice_id, invoice_number,
      due_date, sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      amount = excluded.amount,
      currency = excluded.currency,
      status = excluded.status,
      payment_mode = excluded.payment_mode,
      reference = excluded.reference,
      description = excluded.description,
      due_date = excluded.due_date,
      sent_at = excluded.sent_at,
      ghl_invoice_id = excluded.ghl_invoice_id,
      invoice_number = excluded.invoice_number,
      updated_at = CURRENT_TIMESTAMP`,
    [
      ghlInvoiceId,
      contactId || null,
      total,
      invoice.currency || fallbackCurrency || CURRENCY_DEFAULT,
      status,
      null,
      resolvedPaymentMode,
      invoice.invoiceNumber || null,
      invoice.name || invoice.title || fallbackDescription || 'Pago',
      invoice.issueDate || invoice.createdAt || new Date().toISOString(),
      ghlInvoiceId,
      invoice.invoiceNumber || null,
      invoice.dueDate || null,
      sentAt
    ]
  )
}

async function createInvoice({ ghlClient, basePayload, contact, amount, currency, concept, title, dueDate, summaryDetails }) {
  const context = await getInvoiceSendContext()
  const payload = buildInvoicePayload({
    basePayload: {
      ...(basePayload || {}),
      timezone: basePayload?.timezone || context.timezone
    },
    contact,
    amount,
    currency,
    concept,
    title,
    dueDate,
    summaryDetails
  })

  if (!basePayload?.businessDetails) {
    payload.businessDetails = context.businessDetails
  }

  if (!basePayload?.title && context.invoiceTitle) {
    payload.title = context.invoiceTitle
  }

  if (!payload.termsNotes && (context.termsNotes || summaryDetails)) {
    payload.termsNotes = combineTextSections(context.termsNotes, summaryDetails)
  } else if (payload.termsNotes && summaryDetails && context.termsNotes && !payload.termsNotes.includes(context.termsNotes)) {
    payload.termsNotes = combineTextSections(context.termsNotes, payload.termsNotes)
  }

  payload.liveMode = context.liveMode

  const response = await ghlClient.createInvoice(payload)
  const invoice = response.invoice || response
  const invoiceId = invoice.id || invoice._id

  if (!invoiceId) {
    throw new Error('No se pudo obtener el ID del invoice creado')
  }

  await insertLocalInvoicePayment({
    invoice,
    contactId: contact.id,
    fallbackAmount: amount,
    fallbackCurrency: currency,
    fallbackDescription: concept,
    status: 'draft',
    paymentMode: context.liveMode ? 'live' : 'test'
  })

  return invoice
}

async function sendInvoice({ ghlClient, invoiceId, contact, channels, forceAllAvailable = false }) {
  const sendMethod = pickSendMethod(contact, forceAllAvailable ? { email: true, sms: true, whatsapp: true } : channels)
  const context = await getInvoiceSendContext()
  const paymentLink = buildInvoicePaymentUrl(context.domain, invoiceId)

  if (sendMethod === 'none') {
    return {
      sendMethod,
      paymentLink
    }
  }

  if (!context.sentFrom.fromName || !context.sentFrom.fromEmail) {
    throw new Error('Tu perfil de HighLevel requiere nombre y correo del negocio para enviar cobros')
  }

  await ghlClient.sendInvoice(invoiceId, {
    sentFrom: context.sentFrom,
    sendMethod,
    liveMode: context.liveMode
  })

  await db.run(
    `UPDATE payments
     SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE ghl_invoice_id = ?`,
    [new Date().toISOString(), invoiceId]
  )

  return {
    sendMethod,
    paymentLink
  }
}

export async function createSinglePaymentLink(payload) {
  const contact = payload.contact || {}
  const amount = normalizeAmount(payload.amount || payload.totalAmount)
  const currency = payload.currency || CURRENCY_DEFAULT
  const concept = payload.description || payload.concept || payload.title || 'Pago'
  const title = payload.title || concept || 'Pago'

  if (!contact.id) {
    throw new Error('Selecciona un cliente para crear el link de pago')
  }

  if (amount <= 0) {
    throw new Error('El monto del link de pago debe ser mayor a 0')
  }

  assertAiAgentSendablePaymentChannel(payload, contact, 'el link de pago')

  const ghlClient = await getGHLClient()
  const invoice = await createInvoice({
    ghlClient,
    basePayload: payload.invoicePayload,
    contact,
    amount,
    currency,
    concept,
    title,
    dueDate: payload.dueDate
  })
  const invoiceId = invoice.id || invoice._id
  const sent = await sendInvoice({
    ghlClient,
    invoiceId,
    contact,
    channels: payload.channels || {},
    forceAllAvailable: payload.forceAllAvailable === true
  })

  logger.info(`Link de pago creado desde ${payload.source || 'app'} para contacto ${contact.id}: ${amount} ${currency}`)

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber || null,
    paymentLink: sent.paymentLink,
    sendMethod: sent.sendMethod,
    amount,
    currency,
    status: sent.sendMethod === 'none' ? 'draft' : 'sent'
  }
}

function normalizeOfflineRecordMethod(value) {
  const normalized = normalizeText(value || 'cash')

  if (/(transfer|spei|bank|banco)/.test(normalized)) return 'bank_transfer'
  if (/(deposit|deposito)/.test(normalized)) return 'deposit'
  if (/(card|tarjeta|saved_card|stored_card|direct_card)/.test(normalized)) return 'card'
  if (/(cheque|check)/.test(normalized)) return 'check'
  if (/(manual|offline)/.test(normalized)) return 'manual'
  if (/(otro|other)/.test(normalized)) return 'other'

  return 'cash'
}

export async function createOfflineContactPayment(payload) {
  const contact = payload.contact || {}
  const amount = normalizeAmount(payload.amount || payload.totalAmount)
  const currency = payload.currency || CURRENCY_DEFAULT
  const concept = payload.description || payload.concept || payload.title || 'Pago registrado'
  const title = payload.title || concept || 'Pago registrado'
  const paymentMethod = normalizeOfflineRecordMethod(payload.paymentMethod || payload.method)
  const paymentDate = normalizeDateOnly(payload.paymentDate || payload.fulfilledAt || payload.date || new Date().toISOString(), payload.timezone)
  const { liveMode } = await getPaymentFlowConfig()

  if (!contact.id) {
    throw new Error('Selecciona un cliente para registrar el pago')
  }

  if (amount <= 0) {
    throw new Error('El monto del pago debe ser mayor a 0')
  }

  const ghlClient = await getGHLClient()
  const invoice = await createInvoice({
    ghlClient,
    basePayload: payload.invoicePayload,
    contact,
    amount,
    currency,
    concept,
    title,
    dueDate: paymentDate,
    summaryDetails: payload.notes || null
  })
  const invoiceId = invoice.id || invoice._id
  const methodLabels = {
    cash: 'Efectivo',
    bank_transfer: 'Transferencia',
    deposit: 'Depósito',
    card: 'Tarjeta',
    check: 'Cheque',
    manual: 'Manual',
    other: 'Otro'
  }

  await ghlClient.recordPayment(invoiceId, {
    amount,
    currency,
    fulfilledAt: paymentDate,
    note: [
      'Pago registrado desde Ristak',
      `Método: ${methodLabels[paymentMethod] || paymentMethod}`,
      payload.reference ? `Referencia: ${payload.reference}` : '',
      payload.notes ? `Notas: ${payload.notes}` : ''
    ].filter(Boolean).join('\n'),
    mode: paymentMethod,
    liveMode
  })

  await db.run(
    `UPDATE payments
     SET status = 'paid',
         payment_method = ?,
         reference = ?,
         date = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE ghl_invoice_id = ?`,
    [
      paymentMethod,
      payload.reference || null,
      paymentDate,
      invoiceId
    ]
  )

  await updateSingleContactStats(contact.id)
  logger.info(`Pago offline registrado desde ${payload.source || 'app'} para contacto ${contact.id}: ${amount} ${currency}`)

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber || null,
    amount,
    currency,
    status: 'paid',
    paymentMethod,
    paymentDate,
    paymentMode: liveMode ? 'live' : 'test'
  }
}

function resolveScheduleTimezone(timezone) {
  const zone = timezone || DEFAULT_PAYMENT_TIMEZONE
  return DateTime.now().setZone(zone).isValid ? zone : DEFAULT_PAYMENT_TIMEZONE
}

function buildScheduleExecuteAt(dueDate, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const date = normalizeDateOnly(dueDate, timezone)
  const zone = resolveScheduleTimezone(timezone)
  const scheduledAt = DateTime.fromISO(`${date}T09:00:00`, { zone }).toUTC()
  const minimumFutureAt = DateTime.utc().plus({ minutes: 5 })

  const executeAt = scheduledAt.isValid && scheduledAt.toMillis() > minimumFutureAt.toMillis()
    ? scheduledAt
    : minimumFutureAt

  return executeAt
    .toUTC()
    .set({ millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'")
}

function getScheduleStart(dueDate, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const zone = resolveScheduleTimezone(timezone)
  const executeAt = buildScheduleExecuteAt(dueDate, timezone)
  const localStart = DateTime.fromISO(executeAt, { zone: 'utc' }).setZone(zone)

  return {
    executeAt,
    startDate: localStart.toISODate(),
    startTime: localStart.set({ millisecond: 0 }).toFormat('HH:mm:ss')
  }
}

function addMonthsClamped(date, months) {
  return date.plus({ months }).startOf('day')
}

function getInstallmentDueDateValue(installment) {
  return installment.effective_due_date || installment.effectiveDueDate || installment.due_date || installment.dueDate
}

function getEffectiveInstallmentDueDate(flow, installment, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const frequency = normalizeText(installment.frequency || safeJsonParse(flow?.metadata, {}).remainingFrequency || 'custom')
  const sequence = Number(installment.sequence || 1)
  const zone = resolveScheduleTimezone(timezone)
  const firstPaymentDate = flow?.first_payment_date || flow?.firstPaymentDate

  if (!hasFirstPlanPayment(flow) || !firstPaymentDate || sequence <= 0) {
    return normalizeDateOnly(installment.due_date || installment.dueDate, timezone)
  }

  const baseDate = DateTime.fromISO(normalizeDateOnly(firstPaymentDate, timezone), { zone }).startOf('day')
  if (!baseDate.isValid) return normalizeDateOnly(installment.due_date || installment.dueDate, timezone)

  if (frequency === 'monthly') {
    return addMonthsClamped(baseDate, sequence).toISODate()
  }

  if (frequency === 'weekly') {
    return baseDate.plus({ days: 7 * sequence }).toISODate()
  }

  if (frequency === 'biweekly') {
    return baseDate.plus({ days: 14 * sequence }).toISODate()
  }

  if (frequency === 'daily') {
    return baseDate.plus({ days: sequence }).toISODate()
  }

  if (frequency === 'yearly') {
    return addMonthsClamped(baseDate, 12 * sequence).toISODate()
  }

  return normalizeDateOnly(installment.due_date || installment.dueDate, timezone)
}

function withEffectiveInstallmentDates(flow, installments, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return installments.map(installment => ({
    ...installment,
    effective_due_date: getEffectiveInstallmentDueDate(flow, installment, timezone)
  }))
}

function parseInstallmentDate(installment, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const rawDate = getInstallmentDueDateValue(installment)
  if (!rawDate) return null

  const date = DateTime.fromISO(normalizeDateOnly(rawDate, timezone), {
    zone: resolveScheduleTimezone(timezone)
  })

  return date.isValid ? date.startOf('day') : null
}

function isLastDayOfMonth(date) {
  return date?.isValid && date.day === date.endOf('month').day
}

function datesMatch(left, right) {
  return Boolean(left?.isValid && right?.isValid && left.toISODate() === right.toISODate())
}

function expectedMonthlyDate(firstDate, index, interval) {
  const expected = firstDate.plus({ months: index * interval })
  return isLastDayOfMonth(firstDate) ? expected.endOf('month').startOf('day') : expected.startOf('day')
}

function matchesMonthlyCadence(dates, interval = 1) {
  if (dates.length < 2 || dates.some(date => !date?.isValid)) return false

  return dates.every((date, index) => (
    index === 0 || datesMatch(date, expectedMonthlyDate(dates[0], index, interval))
  ))
}

function matchesDayCadence(dates, days) {
  if (dates.length < 2 || dates.some(date => !date?.isValid)) return false

  return dates.every((date, index) => (
    index === 0 || datesMatch(date, dates[0].plus({ days: days * index }).startOf('day'))
  ))
}

function dayOfWeekCode(date) {
  const codes = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']
  return codes[(date.weekday || 1) - 1]
}

function monthOfYearCode(date) {
  const codes = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  return codes[(date.month || 1) - 1]
}

function getMonthlyDayOfMonth(date) {
  if (isLastDayOfMonth(date)) return -1
  return date.day <= 28 ? date.day : undefined
}

function buildRecurrenceFromDates(installments, frequency, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  if (!installments || installments.length < 2) return null

  const dates = installments.map(installment => parseInstallmentDate(installment, timezone))
  if (dates.some(date => !date?.isValid)) return null

  const normalizedFrequency = normalizeText(frequency || installments[0]?.frequency || 'custom')
  let recurrence = null

  if (normalizedFrequency === 'monthly' && matchesMonthlyCadence(dates, 1)) {
    recurrence = { intervalType: 'monthly', interval: 1 }
  } else if (normalizedFrequency === 'weekly' && matchesDayCadence(dates, 7)) {
    recurrence = { intervalType: 'weekly', interval: 1 }
  } else if (normalizedFrequency === 'biweekly' && matchesDayCadence(dates, 14)) {
    recurrence = { intervalType: 'weekly', interval: 2 }
  } else if (normalizedFrequency === 'daily' && matchesDayCadence(dates, 1)) {
    recurrence = { intervalType: 'daily', interval: 1 }
  } else if (normalizedFrequency === 'yearly' && matchesMonthlyCadence(dates, 12)) {
    recurrence = { intervalType: 'yearly', interval: 1 }
  } else if (normalizedFrequency === 'custom') {
    if (matchesMonthlyCadence(dates, 1)) {
      recurrence = { intervalType: 'monthly', interval: 1 }
    } else if (matchesDayCadence(dates, 14)) {
      recurrence = { intervalType: 'weekly', interval: 2 }
    } else if (matchesDayCadence(dates, 7)) {
      recurrence = { intervalType: 'weekly', interval: 1 }
    } else if (matchesDayCadence(dates, 1)) {
      recurrence = { intervalType: 'daily', interval: 1 }
    } else if (matchesMonthlyCadence(dates, 12)) {
      recurrence = { intervalType: 'yearly', interval: 1 }
    }
  }

  if (!recurrence) return null

  if (recurrence.intervalType === 'monthly' || recurrence.intervalType === 'yearly') {
    const dayOfMonth = getMonthlyDayOfMonth(dates[0])
    if (dayOfMonth !== undefined) {
      recurrence.dayOfMonth = dayOfMonth
    }
  }

  if (recurrence.intervalType === 'weekly') {
    recurrence.dayOfWeek = dayOfWeekCode(dates[0])
  }

  if (recurrence.intervalType === 'yearly') {
    recurrence.monthOfYear = monthOfYearCode(dates[0])
  }

  return recurrence
}

function sameInstallmentAmount(left, right) {
  return amountsMatch(left?.amount, right?.amount)
}

function createSingleInstallmentScheduleGroup(installment, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  return {
    installments: [installment],
    amount: normalizeAmount(installment.amount),
    frequency: installment.frequency || 'custom',
    recurrence: null,
    schedule: {
      executeAt: buildScheduleExecuteAt(getInstallmentDueDateValue(installment), timezone)
    }
  }
}

function createStoredInstallmentScheduleGroup(installments, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const firstInstallment = installments[0]

  return {
    installments,
    amount: normalizeAmount(firstInstallment.amount),
    frequency: firstInstallment.frequency || 'custom',
    recurrence: null,
    schedule: {
      executeAt: buildScheduleExecuteAt(getInstallmentDueDateValue(firstInstallment), timezone)
    },
    scheduleId: firstInstallment.ghl_schedule_id
  }
}

function createRecurringInstallmentScheduleGroup(installments, recurrence, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const firstInstallment = installments[0]
  const start = getScheduleStart(getInstallmentDueDateValue(firstInstallment), timezone)

  return {
    installments,
    amount: normalizeAmount(firstInstallment.amount),
    frequency: firstInstallment.frequency || 'custom',
    recurrence,
    schedule: {
      rrule: {
        ...recurrence,
        startDate: start.startDate,
        startTime: start.startTime,
        count: installments.length,
        daysBefore: 0,
        endType: 'count'
      }
    }
  }
}

function buildNewInstallmentScheduleGroups(installments, timezone = DEFAULT_PAYMENT_TIMEZONE) {
  const groups = []
  let index = 0

  while (index < installments.length) {
    const start = installments[index]

    if (start.ghl_schedule_id) {
      const sameSchedule = []
      while (index < installments.length && installments[index].ghl_schedule_id === start.ghl_schedule_id) {
        sameSchedule.push(installments[index])
        index++
      }
      groups.push(createStoredInstallmentScheduleGroup(sameSchedule, timezone))
      continue
    }

    const amountRun = []
    while (
      index < installments.length &&
      !installments[index].ghl_schedule_id &&
      sameInstallmentAmount(start, installments[index])
    ) {
      amountRun.push(installments[index])
      index++
    }

    const recurrence = buildRecurrenceFromDates(amountRun, start.frequency, timezone)
    if (recurrence) {
      groups.push(createRecurringInstallmentScheduleGroup(amountRun, recurrence, timezone))
    } else {
      amountRun.forEach(installment => {
        groups.push(createSingleInstallmentScheduleGroup(installment, timezone))
      })
    }
  }

  return groups
}

function resolveAutoPaymentType(paymentMethod = {}) {
  const rawType = normalizeText(paymentMethod.type)
  const hasCardFingerprint = Boolean(paymentMethod.cardId || paymentMethod.brand || paymentMethod.last4 || String(paymentMethod.paymentMethodId || '').startsWith('pm_'))

  if (['card', 'credit_card', 'creditcard'].includes(rawType) || hasCardFingerprint) {
    return 'customer_card'
  }

  const typeMap = {
    us_bank_account: 'us_bank_account',
    bank_account: 'us_bank_account',
    ach: 'us_bank_account',
    sepa_debit: 'sepa_debit',
    sepa_direct_debit: 'sepa_debit',
    bacs_debit: 'bacs_debit',
    bacs_direct_debit: 'bacs_debit',
    becs_debit: 'becs_debit',
    becs_direct_debit: 'becs_debit'
  }

  return typeMap[rawType] || 'customer_card'
}

function buildAutoPayment(paymentMethod, options = {}) {
  const type = resolveAutoPaymentType(paymentMethod)
  const autoPayment = {
    enable: true,
    type,
    paymentMethodId: paymentMethod.paymentMethodId,
    customerId: paymentMethod.customerId,
  }

  if (options.amount !== undefined) {
    autoPayment.amount = normalizeAmount(options.amount)
  }

  if (options.currency) {
    autoPayment.currency = options.currency
  }

  if (type === 'customer_card') {
    autoPayment.card = {
      brand: paymentMethod.brand || 'card',
      last4: paymentMethod.last4 || '****'
    }
  }

  if (paymentMethod.cardId) {
    autoPayment.cardId = paymentMethod.cardId
  }

  return autoPayment
}

function buildInstallmentSchedulePayload({ flow, group, context, planSummary }) {
  const contactName = flow.contact_name || flow.contact_email || flow.contact_phone || 'Cliente'
  const currency = flow.currency || CURRENCY_DEFAULT
  const concept = flow.concept || 'Plan de parcialidades'
  const installments = group.installments
  const firstInstallment = installments[0]
  const lastInstallment = installments[installments.length - 1]
  const firstPaymentNumber = getInstallmentPaymentNumber(flow, firstInstallment)
  const lastPaymentNumber = getInstallmentPaymentNumber(flow, lastInstallment)
  const paymentLabel = installments.length === 1
    ? `Pago ${firstPaymentNumber}`
    : `Pagos ${firstPaymentNumber}-${lastPaymentNumber}`
  const amount = normalizeAmount(group.amount)
  const description = combineTextSections(
    `${concept} - ${paymentLabel}`,
    planSummary
  )

  return {
    name: `${concept} - ${paymentLabel}`,
    title: 'PAGO PROGRAMADO',
    currency,
    total: amount,
    termsNotes: combineTextSections(context.termsNotes, planSummary),
    ...(context.invoiceNumberPrefix && { invoiceNumberPrefix: context.invoiceNumberPrefix }),
    businessDetails: context.businessDetails,
    contactDetails: {
      id: flow.contact_id,
      name: contactName,
      email: flow.contact_email || '',
      phoneNo: flow.contact_phone || ''
    },
    sentTo: {
      email: flow.contact_email ? [flow.contact_email] : [],
      phoneNo: flow.contact_phone ? [flow.contact_phone] : []
    },
    schedule: group.schedule,
    liveMode: context.liveMode,
    items: [
      {
        name: paymentLabel,
        description,
        amount,
        qty: 1,
        currency,
        type: 'one_time'
      }
    ],
    discount: {
      value: 0,
      type: 'percentage'
    },
    paymentMethods: {
      stripe: {
        enableBankDebitOnly: false
      }
    }
  }
}

function isGhlScheduleNotFoundError(error) {
  const message = String(error?.message || '').toLowerCase()
  return message.includes('404') && message.includes('invoice schedule not found')
}

async function createDraftInstallmentSchedule({ ghlClient, flow, group, context, planSummary }) {
  const schedulePayload = buildInstallmentSchedulePayload({ flow, group, context, planSummary })
  const installmentIds = group.installments.map(installment => installment.id)
  const sequenceLabel = group.installments.map(installment => installment.sequence).join(',')
  const scheduleTiming = schedulePayload.schedule?.rrule
    ? `rrule=${JSON.stringify(schedulePayload.schedule.rrule)}`
    : `executeAt=${schedulePayload.schedule?.executeAt}`
  logger.info(`Creando schedule GHL para flujo ${flow.id}, parcialidad(es) ${sequenceLabel}: amount=${schedulePayload.total}, ${scheduleTiming}, live=${schedulePayload.liveMode}`)

  const schedule = await ghlClient.createInvoiceSchedule(schedulePayload)
  const scheduleId = extractScheduleId(schedule)

  if (!scheduleId) {
    throw new Error(`HighLevel no devolvió ID del schedule: ${Object.keys(schedule || {}).join(', ') || 'respuesta vacía'}`)
  }

  for (const installmentId of installmentIds) {
    await db.run(
      `UPDATE installment_payments
       SET ghl_schedule_id = ?, ghl_schedule_status = 'draft', notes = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [scheduleId, installmentId]
    )
  }
  logger.info(`Schedule GHL creado para flujo ${flow.id}, parcialidad(es) ${sequenceLabel}: ${scheduleId}`)

  return scheduleId
}

async function markInstallmentScheduleMissing(group, scheduleId) {
  const installmentIds = group.installments.map(installment => installment.id)
  for (const installmentId of installmentIds) {
    await db.run(
      `UPDATE installment_payments
       SET status = 'cancelled',
           automatic = 0,
           ghl_schedule_id = NULL,
           ghl_schedule_status = 'not_found',
           notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [`GHL schedule ${scheduleId || 'sin_id'} no existe; se detuvo reintento automático`, installmentId]
    )
  }
}

async function getAutomaticInstallmentCounts(flowId) {
  const row = await db.get(
    `SELECT
       SUM(CASE WHEN automatic = 1 AND status = 'scheduled' AND ghl_schedule_status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_count,
       SUM(CASE WHEN automatic = 1 AND status IN ('pending_card_authorization', 'scheduled', 'schedule_failed') THEN 1 ELSE 0 END) AS active_count
     FROM installment_payments
     WHERE flow_id = ?`,
    [flowId]
  )

  return {
    scheduled: Number(row?.scheduled_count || 0),
    active: Number(row?.active_count || 0)
  }
}

async function scheduleAutomaticInstallmentsForFlow(flow, paymentMethod, existingClient = null) {
  if (!Number(flow.remaining_automatic)) return []

  if (!paymentMethod?.customerId || !paymentMethod?.paymentMethodId) {
    throw new Error('No hay tarjeta autorizada de GoHighLevel para programar autopagos')
  }

  const installments = await db.all(
    `SELECT *
     FROM installment_payments
     WHERE flow_id = ?
       AND automatic = 1
       AND status IN ('pending_card_authorization', 'scheduled', 'schedule_failed')
       AND (ghl_schedule_status IS NULL OR ghl_schedule_status != 'scheduled')
     ORDER BY sequence ASC`,
    [flow.id]
  )

  if (installments.length === 0) return []

  const allFlowInstallmentsRaw = await db.all(
    `SELECT *
     FROM installment_payments
     WHERE flow_id = ?
     ORDER BY sequence ASC`,
    [flow.id]
  )

  const ghlClient = existingClient || await getGHLClient()
  const context = await getInvoiceSendContext()
  const effectiveInstallments = withEffectiveInstallmentDates(flow, installments, context.timezone)
  const allFlowInstallments = withEffectiveInstallmentDates(flow, allFlowInstallmentsRaw, context.timezone)
  const planSummary = buildPaymentPlanSummary(flow, allFlowInstallments, {
    timezone: context.timezone
  })
  const scheduled = []
  const resolvedAutoPaymentType = resolveAutoPaymentType(paymentMethod)
  const scheduleGroups = buildNewInstallmentScheduleGroups(effectiveInstallments, context.timezone)

  logger.info(`Programando ${installments.length} parcialidad(es) automática(s) en ${scheduleGroups.length} schedule(s) GHL para flujo ${flow.id}`)
  logger.info(`Autopago GHL para flujo ${flow.id}: customer=${maskIdentifier(paymentMethod.customerId)}, method=${maskIdentifier(paymentMethod.paymentMethodId)}, type=${resolvedAutoPaymentType}, rawType=${paymentMethod.type || 'n/a'}, card=${paymentMethod.brand || 'card'} ${paymentMethod.last4 || '****'}, live=${context.liveMode}`)

  for (const group of scheduleGroups) {
    let scheduleId = group.scheduleId || group.installments[0]?.ghl_schedule_id
    const hadStoredScheduleId = Boolean(scheduleId)
    const autoPayment = buildAutoPayment(paymentMethod, {
      amount: group.amount,
      currency: flow.currency || CURRENCY_DEFAULT
    })
    const sequenceLabel = group.installments.map(installment => installment.sequence).join(',')
    const installmentIds = group.installments.map(installment => installment.id)

    try {
      if (!scheduleId) {
        scheduleId = await createDraftInstallmentSchedule({ ghlClient, flow, group, context, planSummary })
      }

      try {
        await ghlClient.scheduleInvoiceSchedule(scheduleId, {
          liveMode: context.liveMode,
          autoPayment
        })
      } catch (error) {
        if (isGhlScheduleNotFoundError(error) && hadStoredScheduleId) {
          await markInstallmentScheduleMissing(group, scheduleId)
          logger.warn(`Schedule GHL ${scheduleId} ya no existe para flujo ${flow.id}, parcialidad(es) ${sequenceLabel}; se limpió y no se reintentará`)
          continue
        }

        throw error
      }

      for (const installmentId of installmentIds) {
        await db.run(
          `UPDATE installment_payments
           SET status = 'scheduled',
               ghl_schedule_id = ?,
               ghl_schedule_status = 'scheduled',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [scheduleId, installmentId]
        )
      }

      scheduled.push({
        installmentIds,
        scheduleId,
        sequences: group.installments.map(installment => installment.sequence),
        recurring: Boolean(group.recurrence),
        count: group.installments.length
      })
    } catch (error) {
      const scheduleError = `GHL schedule failed: ${error.message}`.slice(0, 800)
      for (const installmentId of installmentIds) {
        await db.run(
          `UPDATE installment_payments
           SET ghl_schedule_status = 'schedule_failed',
               notes = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [scheduleError, installmentId]
        )
      }

      logger.error(`Falló programación GHL para flujo ${flow.id}, parcialidad(es) ${sequenceLabel}: ${error.message}`)
      throw new Error(`No se pudo programar la(s) parcialidad(es) ${sequenceLabel} en HighLevel: ${error.message}`)
    }
  }

  return scheduled
}

async function cancelFlowWithoutAutomaticInstallments(flow) {
  const currentHistory = safeJsonParse(flow.state_history, [])
  const stateHistory = addState(currentHistory, PAYMENT_FLOW_STATES.CANCELLED)
  await updateFlowState(flow.id, PAYMENT_FLOW_STATES.CANCELLED, stateHistory)
  logger.warn(`Flujo ${flow.id} quedó sin parcialidades automáticas activas; marcado como cancelado para no reintentarlo`)
}

async function updateFlowState(flowId, state, stateHistory, fields = {}) {
  const allowedFields = [
    'first_payment_status',
    'first_payment_invoice_id',
    'card_setup_status',
    'card_setup_invoice_id',
    'card_setup_payment_link',
    'card_authorized_at',
    'installment_plan_created_at',
    'installment_plan_active_at'
  ]

  const setFields = ['current_state = ?', 'state_history = ?', 'updated_at = CURRENT_TIMESTAMP']
  const values = [state, JSON.stringify(stateHistory)]

  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.includes(key)) continue
    setFields.push(`${key} = ?`)
    values.push(value)
  }

  values.push(flowId)
  await db.run(`UPDATE payment_flows SET ${setFields.join(', ')} WHERE id = ?`, values)
}

async function createRemainingInstallments({ flowId, payments, automatic }) {
  const initialStatus = automatic ? 'pending_card_authorization' : 'manual_pending'

  for (const payment of payments) {
    await db.run(
      `INSERT INTO installment_payments (
        id, flow_id, sequence, amount, percentage, due_date,
        frequency, payment_method, automatic, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('inst'),
        flowId,
        Number(payment.sequence || 1),
        normalizeAmount(payment.amount),
        payment.percentage === null || payment.percentage === undefined ? null : Number(payment.percentage),
        payment.dueDate || payment.due_date || null,
        payment.frequency || 'custom',
        automatic ? 'card' : (payment.paymentMethod || 'manual'),
        automatic ? 1 : 0,
        initialStatus,
        payment.notes || null
      ]
    )
  }
}

function validateInstallmentFlowPayload(payload) {
  const contact = payload.contact || {}
  const totalAmount = normalizeAmount(payload.totalAmount)
  const currency = payload.currency || CURRENCY_DEFAULT
  const remainingPayments = Array.isArray(payload.remainingPayments) ? payload.remainingPayments : []
  const firstPayment = payload.firstPayment || {}
  const firstPaymentEnabled = firstPayment.enabled !== false && normalizeAmount(firstPayment.amount) > 0
  const firstPaymentAmount = firstPaymentEnabled ? normalizeAmount(firstPayment.amount) : 0
  const remainingTotal = normalizeAmount(remainingPayments.reduce((sum, payment) => sum + normalizeAmount(payment.amount), 0))

  if (!contact.id) {
    throw new Error('Selecciona un cliente para crear el plan de parcialidades')
  }

  if (totalAmount <= 0) {
    throw new Error('El total a cobrar debe ser mayor a 0')
  }

  if (remainingPayments.length === 0) {
    throw new Error('Agrega al menos un pago restante')
  }

  if (remainingPayments.some(payment => normalizeAmount(payment.amount) <= 0)) {
    throw new Error('Todos los pagos restantes deben tener monto mayor a 0')
  }

  const planTotal = normalizeAmount(firstPaymentAmount + remainingTotal)
  if (Math.abs(planTotal - totalAmount) > 0.5) {
    throw new Error(`Las parcialidades suman ${planTotal.toFixed(2)} ${currency}, pero el total a cobrar es ${totalAmount.toFixed(2)} ${currency}`)
  }

  const firstPaymentMethod = firstPaymentEnabled ? firstPayment.method : 'none'
  if (firstPaymentEnabled && !firstPaymentMethod) {
    throw new Error('Selecciona un método de pago para el primer pago')
  }

  return {
    contact,
    totalAmount,
    currency,
    remainingPayments,
    remainingTotal,
    firstPayment,
    firstPaymentEnabled,
    firstPaymentAmount,
    firstPaymentMethod
  }
}

export async function createInstallmentPaymentFlow(payload) {
  const {
    contact,
    totalAmount,
    currency,
    remainingPayments,
    firstPayment,
    firstPaymentEnabled,
    firstPaymentAmount,
    firstPaymentMethod
  } = validateInstallmentFlowPayload(payload)

  const remainingAutomatic = Boolean(payload.remainingAutomatic)
  const concept = payload.description || payload.concept || 'Plan de parcialidades'
  const flowId = createId('flow')
  const firstPaymentType = firstPaymentEnabled ? (firstPayment.type || 'amount') : 'none'
  const firstPaymentValue = firstPaymentEnabled ? Number(firstPayment.value || firstPaymentAmount) : 0
  const firstPaymentDate = firstPaymentEnabled ? (firstPayment.date || todayDateOnly()) : null
  const firstPaymentIsOffline = firstPaymentEnabled && OFFLINE_METHODS.has(firstPaymentMethod)
  const firstPaymentIsCard = firstPaymentEnabled && CARD_METHODS.has(firstPaymentMethod)
  const { cardSetupAmount, liveMode } = await getPaymentFlowConfig()
  const forceNewCardAuthorization = remainingAutomatic && shouldForceNewCardAuthorization(payload) && !firstPaymentIsCard
  const authorizedCard = remainingAutomatic && !forceNewCardAuthorization ? await getAuthorizedPaymentMethod(contact) : null
  const alreadyHasAuthorizedCard = Boolean(authorizedCard)
  const firstPaymentUsesStoredCard = firstPaymentIsCard &&
    remainingAutomatic &&
    alreadyHasAuthorizedCard &&
    payload.useStoredCard === true &&
    !forceNewCardAuthorization
  const firstPaymentStoredCardShouldRecordNow = firstPaymentUsesStoredCard &&
    normalizeDateOnly(firstPaymentDate) <= todayDateOnly()
  const cardSetupRequired = remainingAutomatic && !firstPaymentIsCard && (
    forceNewCardAuthorization ||
    (!alreadyHasAuthorizedCard && (!firstPaymentEnabled || firstPaymentIsOffline))
  )

  if (firstPaymentUsesStoredCard && !firstPaymentStoredCardShouldRecordNow) {
    throw new Error('Para programar un primer pago futuro con tarjeta guardada, envíalo como pago automático restante, no como primer pago inmediato.')
  }

  if ((firstPaymentIsCard && !firstPaymentUsesStoredCard) || cardSetupRequired) {
    assertAiAgentSendablePaymentChannel(
      payload,
      contact,
      firstPaymentIsCard ? 'el primer pago con tarjeta' : 'la domiciliación de tarjeta'
    )
  }

  let stateHistory = addState([], PAYMENT_FLOW_STATES.DRAFT)

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, contact_email, contact_phone,
      total_amount, currency, concept, payment_type,
      first_payment_amount, first_payment_type, first_payment_value,
      first_payment_date, first_payment_method, first_payment_status,
      remaining_automatic, card_setup_required, card_setup_amount,
      current_state, state_history, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      flowId,
      contact.id,
      contact.name || null,
      contact.email || null,
      contact.phone || null,
      totalAmount,
      currency,
      concept,
      firstPaymentAmount,
      firstPaymentType,
      firstPaymentValue,
      firstPaymentDate,
      firstPaymentMethod,
      firstPaymentEnabled ? 'pending' : 'not_required',
      remainingAutomatic ? 1 : 0,
      cardSetupRequired ? 1 : 0,
      cardSetupAmount,
      PAYMENT_FLOW_STATES.DRAFT,
      JSON.stringify(stateHistory),
      JSON.stringify({
        channels: payload.channels || {},
        remainingFrequency: payload.remainingFrequency || 'custom',
        installmentFeePercentage: payload.installmentFeePercentage ?? payload.paymentPlanFeePercentage ?? payload.planFeePercentage ?? payload.financingPercentage ?? payload.surchargePercentage,
        cardAuthorizationPreference: forceNewCardAuthorization ? 'new_card' : payload.cardAuthorizationPreference || null,
        forceCardSetup: forceNewCardAuthorization,
        source: payload.source || 'record_payment_modal'
      })
    ]
  )

  await createRemainingInstallments({
    flowId,
    payments: remainingPayments,
    automatic: remainingAutomatic
  })

  const flowForSummary = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flowId])
  const installmentsForSummary = await db.all(
    `SELECT *
     FROM installment_payments
     WHERE flow_id = ?
     ORDER BY sequence ASC`,
    [flowId]
  )
  const installmentsForSummaryWithDates = withEffectiveInstallmentDates(flowForSummary, installmentsForSummary)
  const planSummary = buildPaymentPlanSummary(flowForSummary, installmentsForSummaryWithDates, {
    frequency: payload.remainingFrequency || 'custom'
  })

  const ghlClient = await getGHLClient()
  const response = {
    flowId,
    currentState: PAYMENT_FLOW_STATES.DRAFT,
    paymentMode: liveMode ? 'live' : 'test',
    firstPaymentInvoiceId: null,
    firstPaymentLink: null,
    cardSetupInvoiceId: null,
    cardSetupPaymentLink: null,
    cardSetupSendMethod: null,
    stateHistory
  }

  if (firstPaymentEnabled && firstPaymentIsOffline) {
    const invoice = await createInvoice({
      ghlClient,
      basePayload: payload.invoicePayload,
      contact,
      amount: firstPaymentAmount,
      currency,
      concept: `${concept} - primer pago`,
      title: 'Primer pago',
      dueDate: firstPaymentDate,
      summaryDetails: planSummary
    })
    const invoiceId = invoice.id || invoice._id

    const methodLabels = {
      cash: 'Efectivo',
      bank_transfer: 'Transferencia',
      transfer: 'Transferencia',
      deposit: 'Depósito',
      offline: 'Pago offline',
      manual: 'Pago manual',
      check: 'Cheque',
      other: 'Otro'
    }

    await ghlClient.recordPayment(invoiceId, {
      amount: firstPaymentAmount,
      currency,
      fulfilledAt: firstPaymentDate || new Date().toISOString(),
      note: [
        'Primer pago parcial registrado desde Ristak',
        `Método: ${methodLabels[firstPaymentMethod] || firstPaymentMethod}`,
        firstPayment.reference ? `Referencia: ${firstPayment.reference}` : '',
        firstPayment.notes ? `Notas: ${firstPayment.notes}` : ''
      ].filter(Boolean).join('\n'),
      mode: firstPaymentMethod === 'bank_transfer' || firstPaymentMethod === 'transfer' || firstPaymentMethod === 'deposit'
        ? 'bank_transfer'
        : firstPaymentMethod,
      liveMode
    })

    await db.run(
      `UPDATE payments
       SET status = 'paid', payment_method = ?, reference = ?, updated_at = CURRENT_TIMESTAMP
       WHERE ghl_invoice_id = ?`,
      [firstPaymentMethod, firstPayment.reference || null, invoiceId]
    )

    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.OFFLINE_PAYMENT_REGISTERED)
    await updateFlowState(flowId, PAYMENT_FLOW_STATES.OFFLINE_PAYMENT_REGISTERED, stateHistory, {
      first_payment_status: 'registered',
      first_payment_invoice_id: invoiceId
    })

    response.firstPaymentInvoiceId = invoiceId
    response.currentState = PAYMENT_FLOW_STATES.OFFLINE_PAYMENT_REGISTERED
    response.stateHistory = stateHistory
  }

  if (firstPaymentEnabled && firstPaymentIsCard && firstPaymentStoredCardShouldRecordNow) {
    const invoice = await createInvoice({
      ghlClient,
      basePayload: payload.invoicePayload,
      contact,
      amount: firstPaymentAmount,
      currency,
      concept: `${concept} - primer pago con tarjeta guardada`,
      title: 'Primer pago con tarjeta guardada',
      dueDate: firstPaymentDate,
      summaryDetails: planSummary
    })
    const invoiceId = invoice.id || invoice._id

    await ghlClient.recordPayment(invoiceId, {
      amount: firstPaymentAmount,
      currency,
      fulfilledAt: firstPaymentDate || new Date().toISOString(),
      note: [
        'Primer pago parcial registrado desde Ristak con tarjeta guardada',
        authorizedCard.brand || authorizedCard.last4
          ? `Tarjeta: ${authorizedCard.brand || 'card'} ${authorizedCard.last4 || '****'}`
          : '',
        firstPayment.reference ? `Referencia: ${firstPayment.reference}` : '',
        firstPayment.notes ? `Notas: ${firstPayment.notes}` : ''
      ].filter(Boolean).join('\n'),
      mode: 'card',
      liveMode
    })

    await db.run(
      `UPDATE payments
       SET status = 'paid', payment_method = 'card', reference = ?, updated_at = CURRENT_TIMESTAMP
       WHERE ghl_invoice_id = ?`,
      [firstPayment.reference || null, invoiceId]
    )

    await persistGhlPaymentMethodForFlow(flowId, authorizedCard)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.FIRST_PAYMENT_REGISTERED)
    await updateFlowState(flowId, PAYMENT_FLOW_STATES.FIRST_PAYMENT_REGISTERED, stateHistory, {
      first_payment_status: 'registered',
      first_payment_invoice_id: invoiceId
    })

    response.firstPaymentInvoiceId = invoiceId
    response.currentState = PAYMENT_FLOW_STATES.FIRST_PAYMENT_REGISTERED
    response.stateHistory = stateHistory
  } else if (firstPaymentEnabled && firstPaymentIsCard) {
    const invoice = await createInvoice({
      ghlClient,
      basePayload: payload.invoicePayload,
      contact,
      amount: firstPaymentAmount,
      currency,
      concept: `${concept} - primer pago con tarjeta`,
      title: 'Primer pago con tarjeta',
      dueDate: firstPaymentDate,
      summaryDetails: planSummary
    })
    const invoiceId = invoice.id || invoice._id
    const sent = await sendInvoice({
      ghlClient,
      invoiceId,
      contact,
      channels: payload.channels || {}
    })

    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING)
    await updateFlowState(flowId, PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING, stateHistory, {
      first_payment_status: 'pending',
      first_payment_invoice_id: invoiceId
    })

    response.firstPaymentInvoiceId = invoiceId
    response.firstPaymentLink = sent.paymentLink
    response.currentState = PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING
    response.stateHistory = stateHistory
  }

  if (remainingAutomatic && firstPaymentIsCard && !firstPaymentUsesStoredCard) {
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION)
    await updateFlowState(flowId, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION, stateHistory)
    response.currentState = PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION
    response.stateHistory = stateHistory
  }

  if (cardSetupRequired) {
    const invoice = await createInvoice({
      ghlClient,
      basePayload: payload.invoicePayload,
      contact,
      amount: cardSetupAmount,
      currency,
      concept: 'Domiciliación de tarjeta',
      title: 'Autorización de tarjeta',
      dueDate: todayDateOnly(),
      summaryDetails: combineTextSections(
        'Este cobro autoriza la tarjeta y no descuenta saldo del plan.',
        planSummary
      )
    })
    const invoiceId = invoice.id || invoice._id
    const sent = await sendInvoice({
      ghlClient,
      invoiceId,
      contact,
      channels: payload.channels || {},
      forceAllAvailable: !hasExplicitChannelSelection(payload.channels)
    })

    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.CARD_SETUP_LINK_SENT)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION)
    const cardSetupStatus = sent.sendMethod === 'none' ? 'link_generated' : 'sent'

    await updateFlowState(flowId, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION, stateHistory, {
      card_setup_status: cardSetupStatus,
      card_setup_invoice_id: invoiceId,
      card_setup_payment_link: sent.paymentLink
    })

    response.cardSetupInvoiceId = invoiceId
    response.cardSetupPaymentLink = sent.paymentLink
    response.cardSetupSendMethod = sent.sendMethod
    response.currentState = PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION
    response.stateHistory = stateHistory
  }

  if (remainingAutomatic && alreadyHasAuthorizedCard && (firstPaymentUsesStoredCard || !firstPaymentIsCard)) {
    await persistGhlPaymentMethodForFlow(flowId, authorizedCard)
    const createdFlow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flowId])
    const installmentSchedules = await scheduleAutomaticInstallmentsForFlow(createdFlow, authorizedCard, ghlClient)

    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.CARD_AUTHORIZED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_CREATED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE)
    const now = new Date().toISOString()

    await updateFlowState(flowId, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE, stateHistory, {
      card_authorized_at: now,
      installment_plan_created_at: now,
      installment_plan_active_at: now
    })

    response.currentState = PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE
    response.stateHistory = stateHistory
    response.installmentSchedules = installmentSchedules
  }

  if (!remainingAutomatic && !firstPaymentIsCard) {
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_CREATED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE)
    const now = new Date().toISOString()

    await updateFlowState(flowId, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE, stateHistory, {
      installment_plan_created_at: now,
      installment_plan_active_at: now
    })

    await db.run(
      `UPDATE installment_payments
       SET status = 'manual_pending', updated_at = CURRENT_TIMESTAMP
       WHERE flow_id = ?`,
      [flowId]
    )

    response.currentState = PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE
    response.stateHistory = stateHistory
  }

  logger.info(`Flujo de parcialidades creado: ${flowId} (${response.currentState})`)

  return response
}

async function activateFlowIfReady(flow) {
  const ghlClient = await getGHLClient()
  logger.info(`Intentando activar flujo de parcialidades ${flow.id}: firstInvoice=${maskIdentifier(flow.first_payment_invoice_id)}, cardSetupInvoice=${maskIdentifier(flow.card_setup_invoice_id)}, firstStatus=${flow.first_payment_status}, cardSetupStatus=${flow.card_setup_status}`)
  const authorizedCard = await getAuthorizedPaymentMethod(flow, { ghlClient })

  if (!authorizedCard) {
    logger.warn(`Flujo ${flow.id} todavía no tiene paymentMethod autorizado en GHL`)
    return false
  }

  await scheduleAutomaticInstallmentsForFlow(flow, authorizedCard, ghlClient)

  const installmentCounts = await getAutomaticInstallmentCounts(flow.id)
  if (installmentCounts.scheduled === 0 && installmentCounts.active === 0) {
    await cancelFlowWithoutAutomaticInstallments(flow)
    return false
  }

  if (installmentCounts.scheduled === 0) {
    logger.warn(`Flujo ${flow.id} no tiene parcialidades programadas todavía; se queda pendiente`)
    return false
  }

  const currentHistory = safeJsonParse(flow.state_history, [])
  let stateHistory = addState(currentHistory, PAYMENT_FLOW_STATES.CARD_AUTHORIZED)
  stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_CREATED)
  stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE)
  const now = new Date().toISOString()

  await updateFlowState(flow.id, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE, stateHistory, {
    card_authorized_at: now,
    installment_plan_created_at: now,
    installment_plan_active_at: now
  })

  logger.info(`Flujo de parcialidades activado con tarjeta autorizada: ${flow.id}`)
  return true
}

async function findPaymentFlowPaidTarget(invoiceId, paymentSignal = {}) {
  if (invoiceId) {
    const flow = await db.get(
      `SELECT *
       FROM payment_flows
       WHERE first_payment_invoice_id = ? OR card_setup_invoice_id = ?
       LIMIT 1`,
      [invoiceId, invoiceId]
    )

    if (flow) {
      return {
        flow,
        target: flow.first_payment_invoice_id === invoiceId ? 'first_payment' : 'card_setup'
      }
    }
  }

  const contactId = paymentSignal.contactId || paymentSignal.contact_id
  const invoiceNumber = normalizeLookupText(paymentSignal.invoiceNumber || paymentSignal.invoice_number)

  if (invoiceNumber) {
    const paymentRow = await db.get(
      `SELECT id, ghl_invoice_id
       FROM payments
       WHERE (? IS NULL OR contact_id = ?)
         AND (
           invoice_number = ?
           OR reference = ?
           OR reference = ?
         )
       ORDER BY
         CASE WHEN ghl_invoice_id IS NOT NULL AND ghl_invoice_id != '' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [contactId || null, contactId || null, invoiceNumber, invoiceNumber, `Invoice #${invoiceNumber}`]
    )

    const resolvedInvoiceId = paymentRow?.ghl_invoice_id || paymentRow?.id
    if (resolvedInvoiceId) {
      const flow = await db.get(
        `SELECT *
         FROM payment_flows
         WHERE first_payment_invoice_id = ? OR card_setup_invoice_id = ?
         LIMIT 1`,
        [resolvedInvoiceId, resolvedInvoiceId]
      )

      if (flow) {
        logger.info(`Invoice de flujo reconocido por número de factura ${invoiceNumber}: flujo=${flow.id}`)
        return {
          flow,
          target: flow.first_payment_invoice_id === resolvedInvoiceId ? 'first_payment' : 'card_setup'
        }
      }
    }
  }

  const amount = normalizeAmount(paymentSignal.amount)
  const description = normalizeText(paymentSignal.description)

  if (!contactId || amount <= 0) return null

  const flows = await db.all(
    `SELECT *
     FROM payment_flows
     WHERE contact_id = ?
       AND remaining_automatic = 1
       AND current_state IN (?, ?, ?)
     ORDER BY created_at DESC
     LIMIT 10`,
    [
      contactId,
      PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION,
      PAYMENT_FLOW_STATES.CARD_SETUP_LINK_SENT,
      PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING
    ]
  )

  const cardSetupFlow = flows.find((flow) => (
    flow.card_setup_invoice_id &&
    flow.card_setup_status !== 'paid' &&
    amountsMatch(flow.card_setup_amount, amount) &&
    (description.includes('domicili') || description.includes('autoriz') || description.includes('tarjeta'))
  ))

  if (cardSetupFlow) {
    logger.warn(`Webhook de pago sin invoiceId exacto; emparejado con domiciliación del flujo ${cardSetupFlow.id}`)
    return { flow: cardSetupFlow, target: 'card_setup' }
  }

  const firstPaymentFlow = flows.find((flow) => {
    const concept = normalizeText(flow.concept)
    return (
      flow.first_payment_invoice_id &&
      flow.first_payment_status !== 'paid' &&
      CARD_METHODS.has(flow.first_payment_method) &&
      amountsMatch(flow.first_payment_amount, amount) &&
      (description.includes('primer pago') || description.includes('tarjeta') || (concept && description.includes(concept)))
    )
  })

  if (firstPaymentFlow) {
    logger.warn(`Webhook de pago sin invoiceId exacto; emparejado con primer pago del flujo ${firstPaymentFlow.id}`)
    return { flow: firstPaymentFlow, target: 'first_payment' }
  }

  return null
}

export async function markPaymentFlowInvoicePaid(invoiceId, paymentSignal = {}) {
  const matched = await findPaymentFlowPaidTarget(invoiceId, paymentSignal)
  const flow = matched?.flow

  if (!flow) {
    return null
  }

  const firstPaymentWasPaid = matched.target === 'first_payment'
  const cardSetupWasPaid = matched.target === 'card_setup'

  if (firstPaymentWasPaid) {
    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = 'paid', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [flow.id]
    )
  }

  if (cardSetupWasPaid) {
    await db.run(
      `UPDATE payment_flows
       SET card_setup_status = 'paid', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [flow.id]
    )
  }

  const refreshed = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flow.id])
  logger.info(`Invoice de flujo pagado: flujo=${flow.id}, target=${matched.target}, invoice=${invoiceId || 'fallback'}`)

  if (firstPaymentWasPaid && !Number(refreshed.remaining_automatic)) {
    const currentHistory = safeJsonParse(refreshed.state_history, [])
    let stateHistory = addState(currentHistory, PAYMENT_FLOW_STATES.FIRST_PAYMENT_REGISTERED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_CREATED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE)
    const now = new Date().toISOString()

    await updateFlowState(refreshed.id, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE, stateHistory, {
      installment_plan_created_at: now,
      installment_plan_active_at: now
    })

    return refreshed
  }

  try {
    await activateFlowIfReady(refreshed)
  } catch (error) {
    logger.error(`No se pudo activar flujo ${refreshed.id} después de pago confirmado: ${error.message}`)
    throw error
  }

  return refreshed
}

export async function activatePendingPaymentFlowsForContact(contactId) {
  if (!contactId) return 0

  const flows = await db.all(
    `SELECT *
     FROM payment_flows
     WHERE contact_id = ?
       AND remaining_automatic = 1
       AND current_state IN (?, ?, ?)
       AND (
         (first_payment_method IN ('card', 'payment_link', 'direct_card', 'saved_card') AND first_payment_status = 'paid')
         OR (card_setup_required = 1 AND card_setup_status = 'paid')
       )`,
    [
      contactId,
      PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION,
      PAYMENT_FLOW_STATES.CARD_SETUP_LINK_SENT,
      PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING
    ]
  )

  let activated = 0
  for (const flow of flows) {
    const didActivate = await activateFlowIfReady(flow)
    if (didActivate) activated++
  }

  return activated
}

export async function repairPendingPaymentFlows(limit = 25) {
  const flows = await db.all(
    `SELECT *
     FROM payment_flows
     WHERE remaining_automatic = 1
       AND current_state IN (?, ?, ?)
     ORDER BY updated_at ASC
     LIMIT ?`,
    [
      PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION,
      PAYMENT_FLOW_STATES.CARD_SETUP_LINK_SENT,
      PAYMENT_FLOW_STATES.FIRST_PAYMENT_PENDING,
      limit
    ]
  )

  let repaired = 0

  for (const flow of flows) {
    try {
      const invoiceId = getPaidAuthorizationInvoiceId(flow)

      if (invoiceId) {
        const didActivate = await activateFlowIfReady(flow)
        if (didActivate) repaired++
        continue
      }

      const candidates = [
        {
          invoiceId: flow.first_payment_invoice_id,
          target: 'first_payment',
          alreadyPaid: flow.first_payment_status === 'paid'
        },
        {
          invoiceId: flow.card_setup_invoice_id,
          target: 'card_setup',
          alreadyPaid: flow.card_setup_status === 'paid'
        }
      ].filter(candidate => candidate.invoiceId && !candidate.alreadyPaid)

      for (const candidate of candidates) {
        const payment = await db.get(
          `SELECT amount, description, status
           FROM payments
           WHERE ghl_invoice_id = ? OR id = ?
           LIMIT 1`,
          [candidate.invoiceId, candidate.invoiceId]
        )

        if (!payment || !['paid', 'succeeded', 'completed'].includes(normalizeText(payment.status))) {
          continue
        }

        await markPaymentFlowInvoicePaid(candidate.invoiceId, {
          contactId: flow.contact_id,
          amount: payment.amount,
          description: payment.description
        })
        repaired++
        break
      }
    } catch (error) {
      logger.error(`No se pudo reparar flujo de parcialidades ${flow.id}: ${error.message}`)
    }
  }

  if (repaired > 0) {
    logger.info(`Reparación de parcialidades activó ${repaired} flujo(s) pendiente(s)`)
  }

  return repaired
}
