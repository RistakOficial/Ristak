import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getPaymentLiveClientCount,
  publishPaymentChangedEvent,
  publishSubscriptionChangedEvent,
  subscribePaymentLiveEvents
} from '../src/services/paymentLiveEventsService.js'

function createStreamMock() {
  const req = new EventEmitter()
  req.user = { userId: 'test-user' }

  const writes = []
  const res = new EventEmitter()
  res.writableEnded = false
  res.destroyed = false
  res.status = (statusCode) => {
    res.statusCode = statusCode
    return res
  }
  res.set = (headers) => {
    res.headers = headers
    return res
  }
  res.flushHeaders = () => undefined
  res.write = (chunk) => {
    writes.push(String(chunk))
    return true
  }

  return { req, res, writes }
}

function collectNamedEvents(writes, eventName) {
  return writes
    .join('')
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.includes(`event: ${eventName}\n`))
    .map((frame) => {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data: '))
      return JSON.parse(dataLine.slice('data: '.length))
    })
}

test('payment live stream publishes payment scopes for transactions and payment plans', () => {
  const { req, res, writes } = createStreamMock()
  const cleanup = subscribePaymentLiveEvents(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(getPaymentLiveClientCount(), 1)

  publishPaymentChangedEvent({
    id: 'pay_live_scope_test',
    status: 'paid',
    payment_method: 'stripe',
    payment_provider: 'stripe',
    metadata_json: JSON.stringify({
      paymentPlan: {
        paymentPlanId: 'plan_scope_test'
      }
    })
  }, { previousStatus: 'pending' })

  const [event] = collectNamedEvents(writes, 'payment_changed')
  assert.equal(event.paymentId, 'pay_live_scope_test')
  assert.equal(event.status, 'paid')
  assert.equal(event.previousStatus, 'pending')
  assert.deepEqual(event.scopes.sort(), ['payment_plans', 'transactions'])

  cleanup()
  assert.equal(getPaymentLiveClientCount(), 0)
})

test('payment live stream publishes subscription scope for subscription changes', () => {
  const stream = createStreamMock()
  const secondCleanup = subscribePaymentLiveEvents(stream.req, stream.res)

  publishSubscriptionChangedEvent({
    id: 'sub_live_scope_test',
    contact_id: 'contact_live_scope_test',
    status: 'active',
    payment_provider: 'mercadopago'
  }, { previousStatus: 'incomplete' })

  const [event] = collectNamedEvents(stream.writes, 'subscription_changed')
  assert.equal(event.subscriptionId, 'sub_live_scope_test')
  assert.equal(event.contactId, 'contact_live_scope_test')
  assert.equal(event.status, 'active')
  assert.equal(event.previousStatus, 'incomplete')
  assert.deepEqual(event.scopes, ['subscriptions'])

  secondCleanup()
  assert.equal(getPaymentLiveClientCount(), 0)
})
