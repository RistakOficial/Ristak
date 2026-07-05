import { randomUUID } from 'crypto'

const HEARTBEAT_INTERVAL_MS = 25_000
const clients = new Map()
let eventSequence = 0

function cleanString(value, maxLength = 1000) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function nextEventId() {
  eventSequence += 1
  return String(eventSequence)
}

function writeSseEvent(res, event, data = {}) {
  if (res.writableEnded || res.destroyed) return false

  res.write(`id: ${nextEventId()}\n`)
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
  return true
}

function cleanupClient(clientId) {
  const client = clients.get(clientId)
  if (!client) return

  clearInterval(client.heartbeatId)
  clients.delete(clientId)
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function firstClean(...values) {
  for (const value of values) {
    const cleaned = cleanString(value, 240)
    if (cleaned) return cleaned
  }
  return ''
}

function textIncludesAny(value, needles) {
  const normalized = cleanString(value).toLowerCase()
  return Boolean(normalized && needles.some((needle) => normalized.includes(needle)))
}

function derivePaymentScopes(payment = {}) {
  const metadata = {
    ...parseJson(payment.metadata_json, {}),
    ...parseJson(payment.metadataJson, {}),
    ...parseJson(payment.metadata, {})
  }
  const paymentPlan = metadata.paymentPlan && typeof metadata.paymentPlan === 'object'
    ? metadata.paymentPlan
    : metadata.payment_plan && typeof metadata.payment_plan === 'object'
      ? metadata.payment_plan
      : {}
  const subscriptionStart = metadata.subscriptionStart && typeof metadata.subscriptionStart === 'object'
    ? metadata.subscriptionStart
    : metadata.subscription_start && typeof metadata.subscription_start === 'object'
      ? metadata.subscription_start
      : {}
  const subscriptionStartPayment = metadata.subscriptionStartPayment && typeof metadata.subscriptionStartPayment === 'object'
    ? metadata.subscriptionStartPayment
    : metadata.subscription_start_payment && typeof metadata.subscription_start_payment === 'object'
      ? metadata.subscription_start_payment
      : {}

  const scopes = new Set(['transactions'])
  const sourceText = [
    payment.source,
    payment.payment_source,
    payment.paymentProvider,
    payment.payment_provider,
    payment.provider,
    payment.paymentMethod,
    payment.payment_method,
    payment.method,
    metadata.source,
    paymentPlan.source,
    paymentPlan.trigger
  ].map((item) => cleanString(item).toLowerCase()).join(' ')

  if (
    payment.payment_plan_id ||
    payment.paymentPlanId ||
    payment.installment_id ||
    payment.installmentId ||
    payment.flow_id ||
    payment.flowId ||
    paymentPlan.flowId ||
    paymentPlan.flow_id ||
    paymentPlan.paymentPlanId ||
    paymentPlan.payment_plan_id ||
    paymentPlan.installmentId ||
    paymentPlan.installment_id ||
    textIncludesAny(sourceText, ['payment_plan', 'payment plan', 'installment'])
  ) {
    scopes.add('payment_plans')
  }

  if (
    payment.subscription_id ||
    payment.subscriptionId ||
    payment.stripe_subscription_id ||
    payment.stripeSubscriptionId ||
    payment.conekta_subscription_id ||
    payment.conektaSubscriptionId ||
    payment.mercadopago_subscription_id ||
    payment.mercadoPagoSubscriptionId ||
    payment.mercadopago_preapproval_id ||
    payment.mercadoPagoPreapprovalId ||
    payment.rebill_subscription_id ||
    payment.rebillSubscriptionId ||
    metadata.ristak_subscription_id ||
    metadata.ristakSubscriptionId ||
    metadata.subscription_id ||
    metadata.subscriptionId ||
    subscriptionStart.subscriptionId ||
    subscriptionStart.subscription_id ||
    subscriptionStartPayment.subscriptionId ||
    subscriptionStartPayment.subscription_id ||
    textIncludesAny(sourceText, ['subscription', 'suscrip', 'preapproval'])
  ) {
    scopes.add('subscriptions')
  }

  return Array.from(scopes)
}

function publishPaymentEvent(eventName, payload) {
  if (clients.size === 0) return

  for (const [clientId, client] of clients.entries()) {
    try {
      writeSseEvent(client.res, eventName, payload)
    } catch {
      cleanupClient(clientId)
    }
  }
}

export function subscribePaymentLiveEvents(req, res) {
  const clientId = randomUUID()
  const userId = cleanString(req.user?.userId)

  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()

  const heartbeatId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanupClient(clientId)
      return
    }
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, HEARTBEAT_INTERVAL_MS)

  clients.set(clientId, { res, heartbeatId, userId })
  writeSseEvent(res, 'connected', {
    connected: true,
    serverTime: new Date().toISOString()
  })

  const cleanup = () => cleanupClient(clientId)
  req.on('close', cleanup)
  res.on('close', cleanup)

  return cleanup
}

export function publishPaymentChangedEvent(payment = {}, options = {}) {
  const paymentId = firstClean(payment.id, payment.payment_id, payment.paymentId)
  const publicPaymentId = firstClean(payment.public_payment_id, payment.publicPaymentId)
  if (!paymentId && !publicPaymentId) return

  const previousStatus = firstClean(
    options.previousStatus,
    payment.previousStatus,
    payment.previous_status
  ).toLowerCase()
  const status = firstClean(payment.status, payment.paymentStatus, payment.payment_status).toLowerCase()

  publishPaymentEvent('payment_changed', {
    type: 'payment_changed',
    scopes: derivePaymentScopes(payment),
    paymentId,
    publicPaymentId,
    contactId: firstClean(payment.contact_id, payment.contactId),
    status,
    previousStatus,
    provider: firstClean(payment.payment_provider, payment.paymentProvider, payment.provider),
    method: firstClean(payment.payment_method, payment.paymentMethod, payment.method),
    receivedAt: new Date().toISOString()
  })
}

export function publishSubscriptionChangedEvent(subscription = {}, options = {}) {
  const subscriptionId = firstClean(subscription.id, subscription.subscription_id, subscription.subscriptionId)
  if (!subscriptionId) return

  publishPaymentEvent('subscription_changed', {
    type: 'subscription_changed',
    scopes: ['subscriptions'],
    subscriptionId,
    contactId: firstClean(subscription.contact_id, subscription.contactId),
    status: firstClean(subscription.status).toLowerCase(),
    previousStatus: firstClean(options.previousStatus, subscription.previousStatus, subscription.previous_status).toLowerCase(),
    provider: firstClean(subscription.payment_provider, subscription.paymentProvider),
    receivedAt: new Date().toISOString()
  })
}

export function getPaymentLiveClientCount() {
  return clients.size
}
