import { randomBytes } from 'crypto'
import { db } from '../config/database.js'
import { getGHLClient } from './ghlClient.js'
import { buildInvoicePaymentUrl } from '../utils/paymentUrl.js'
import { logger } from '../utils/logger.js'
import {
  findCustomerByEmail as stripeFindCustomerByEmail,
  listPaymentMethods as stripeListPaymentMethods
} from './stripeService.js'

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
const OFFLINE_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'offline', 'manual', 'check', 'other'])
const CARD_METHODS = new Set(['card', 'payment_link', 'direct_card', 'saved_card'])
const CURRENCY_DEFAULT = 'MXN'

function createId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(6).toString('hex')}`
}

function normalizeAmount(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  return Math.round(amount * 100) / 100
}

function normalizeDateOnly(value) {
  if (!value) return new Date().toISOString().split('T')[0]
  return String(value).split('T')[0]
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

async function getInvoiceSendContext() {
  const config = await db.get('SELECT location_data, stripe_mode FROM highlevel_config LIMIT 1')

  if (!config || !config.location_data) {
    throw new Error('Configura tu cuenta de HighLevel antes de enviar cobros')
  }

  const locationData = typeof config.location_data === 'string'
    ? JSON.parse(config.location_data)
    : config.location_data

  const business = locationData?.business || {}
  const fromName = business.name || locationData?.name || null
  const fromEmail = business.email || locationData?.email || null

  return {
    domain: locationData?.domain || null,
    liveMode: config.stripe_mode ? config.stripe_mode === 'live' : true,
    sentFrom: {
      fromName,
      fromEmail
    }
  }
}

async function getPaymentFlowConfig() {
  const config = await db.get('SELECT location_id, card_setup_amount FROM highlevel_config LIMIT 1')
  const cardSetupAmount = normalizeAmount(config?.card_setup_amount || DEFAULT_CARD_SETUP_AMOUNT)

  return {
    locationId: config?.location_id || null,
    cardSetupAmount: cardSetupAmount > 0 ? cardSetupAmount : DEFAULT_CARD_SETUP_AMOUNT
  }
}

async function contactHasAuthorizedCard(contactOrFlow) {
  const contactId = contactOrFlow.contact_id || contactOrFlow.id
  const contactEmail = contactOrFlow.contact_email || contactOrFlow.email
  const { locationId } = await getPaymentFlowConfig()

  if (contactId) {
    const localMethod = await db.get(
      `SELECT id FROM payment_methods
       WHERE contact_id = ? AND is_active = 1
       LIMIT 1`,
      [contactId]
    )

    if (localMethod) return true
  }

  if (!locationId || !contactEmail) return false

  const stripeCustomer = await stripeFindCustomerByEmail(locationId, contactEmail)
  if (!stripeCustomer) return false

  const methods = await stripeListPaymentMethods(locationId, stripeCustomer.id)
  return methods.length > 0
}

function buildInvoicePayload({ basePayload, contact, amount, currency, concept, title, dueDate }) {
  const contactName = contact.name || contact.email || contact.phone || 'Cliente'
  const businessDetails = basePayload?.businessDetails || { name: 'Mi Negocio' }
  const termsNotes = basePayload?.termsNotes

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
        description: concept || title || 'Pago',
        amount,
        qty: 1,
        currency
      }
    ],
    issueDate: new Date().toISOString().split('T')[0],
    dueDate: normalizeDateOnly(dueDate || basePayload?.dueDate),
    liveMode: basePayload?.liveMode !== undefined ? basePayload.liveMode : true,
    ...(termsNotes && { termsNotes })
  }
}

async function insertLocalInvoicePayment({ invoice, contactId, fallbackAmount, fallbackCurrency, fallbackDescription, sentAt = null, status = 'draft' }) {
  const ghlInvoiceId = invoice.id || invoice._id
  const items = invoice.items || invoice.invoiceItems || []
  const subtotal = items.reduce((sum, item) => sum + Number(item.amount || 0) * Number(item.qty || 1), 0)
  const taxAmount = Number(invoice.tax?.amount || 0)
  const total = normalizeAmount(invoice.total || invoice.amount || subtotal + taxAmount || fallbackAmount)

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method,
      reference, description, date, ghl_invoice_id, invoice_number,
      due_date, sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      contact_id = excluded.contact_id,
      amount = excluded.amount,
      currency = excluded.currency,
      status = excluded.status,
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

async function createInvoice({ ghlClient, basePayload, contact, amount, currency, concept, title, dueDate }) {
  const payload = buildInvoicePayload({
    basePayload,
    contact,
    amount,
    currency,
    concept,
    title,
    dueDate
  })

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
    status: 'draft'
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

  const firstPaymentMethod = firstPaymentEnabled ? (firstPayment.method || 'bank_transfer') : 'none'

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
  const firstPaymentDate = firstPaymentEnabled ? (firstPayment.date || new Date().toISOString().split('T')[0]) : null
  const firstPaymentIsOffline = firstPaymentEnabled && OFFLINE_METHODS.has(firstPaymentMethod)
  const firstPaymentIsCard = firstPaymentEnabled && CARD_METHODS.has(firstPaymentMethod)
  const { cardSetupAmount } = await getPaymentFlowConfig()
  const alreadyHasAuthorizedCard = remainingAutomatic ? await contactHasAuthorizedCard(contact) : false
  const cardSetupRequired = remainingAutomatic && !alreadyHasAuthorizedCard && (!firstPaymentEnabled || firstPaymentIsOffline)

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
        source: 'record_payment_modal'
      })
    ]
  )

  await createRemainingInstallments({
    flowId,
    payments: remainingPayments,
    automatic: remainingAutomatic
  })

  const ghlClient = await getGHLClient()
  const response = {
    flowId,
    currentState: PAYMENT_FLOW_STATES.DRAFT,
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
      dueDate: firstPaymentDate
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
        : firstPaymentMethod
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

  if (firstPaymentEnabled && firstPaymentIsCard) {
    const invoice = await createInvoice({
      ghlClient,
      basePayload: payload.invoicePayload,
      contact,
      amount: firstPaymentAmount,
      currency,
      concept: `${concept} - primer pago con tarjeta`,
      title: 'Primer pago con tarjeta',
      dueDate: firstPaymentDate
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

  if (remainingAutomatic && firstPaymentIsCard) {
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
      dueDate: new Date().toISOString().split('T')[0]
    })
    const invoiceId = invoice.id || invoice._id
    const sent = await sendInvoice({
      ghlClient,
      invoiceId,
      contact,
      channels: payload.channels || {},
      forceAllAvailable: true
    })

    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.CARD_SETUP_LINK_SENT)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION)

    await updateFlowState(flowId, PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION, stateHistory, {
      card_setup_status: 'sent',
      card_setup_invoice_id: invoiceId,
      card_setup_payment_link: sent.paymentLink
    })

    response.cardSetupInvoiceId = invoiceId
    response.cardSetupPaymentLink = sent.paymentLink
    response.cardSetupSendMethod = sent.sendMethod
    response.currentState = PAYMENT_FLOW_STATES.WAITING_CARD_AUTHORIZATION
    response.stateHistory = stateHistory
  }

  if (remainingAutomatic && alreadyHasAuthorizedCard && !firstPaymentIsCard) {
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.CARD_AUTHORIZED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_CREATED)
    stateHistory = addState(stateHistory, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE)
    const now = new Date().toISOString()

    await updateFlowState(flowId, PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE, stateHistory, {
      card_authorized_at: now,
      installment_plan_created_at: now,
      installment_plan_active_at: now
    })

    await db.run(
      `UPDATE installment_payments
       SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP
       WHERE flow_id = ? AND automatic = 1`,
      [flowId]
    )

    response.currentState = PAYMENT_FLOW_STATES.INSTALLMENT_PLAN_ACTIVE
    response.stateHistory = stateHistory
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
  const hasSavedCard = await contactHasAuthorizedCard(flow)

  if (!hasSavedCard) {
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

  await db.run(
    `UPDATE installment_payments
     SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP
     WHERE flow_id = ? AND automatic = 1 AND status = 'pending_card_authorization'`,
    [flow.id]
  )

  logger.info(`Flujo de parcialidades activado con tarjeta autorizada: ${flow.id}`)
  return true
}

export async function markPaymentFlowInvoicePaid(invoiceId) {
  const flow = await db.get(
    `SELECT *
     FROM payment_flows
     WHERE first_payment_invoice_id = ? OR card_setup_invoice_id = ?
     LIMIT 1`,
    [invoiceId, invoiceId]
  )

  if (!flow) {
    return null
  }

  const firstPaymentWasPaid = flow.first_payment_invoice_id === invoiceId

  if (firstPaymentWasPaid) {
    await db.run(
      `UPDATE payment_flows
       SET first_payment_status = 'paid', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [flow.id]
    )
  }

  if (flow.card_setup_invoice_id === invoiceId) {
    await db.run(
      `UPDATE payment_flows
       SET card_setup_status = 'paid', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [flow.id]
    )
  }

  const refreshed = await db.get('SELECT * FROM payment_flows WHERE id = ?', [flow.id])

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

  await activateFlowIfReady(refreshed)
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
