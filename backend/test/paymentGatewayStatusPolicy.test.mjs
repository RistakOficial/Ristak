import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isGatewayPaymentFailureStatus,
  mapGatewayPaymentStatus,
  normalizeGatewayPaymentStatus
} from '../src/services/paymentGatewayStatusPolicy.js'
import { mapOrderStatus as mapConektaOrderStatus } from '../src/services/conektaPaymentService.js'
import { mapClipStatus } from '../src/services/clipPaymentService.js'
import { mapMercadoPagoStatus } from '../src/services/mercadoPagoPaymentService.js'
import { mapRebillStatus } from '../src/services/rebillPaymentService.js'
import { mapStripePaymentIntentStatus } from '../src/services/stripePaymentService.js'

test('politica pagos: abandono, expiracion y cancelacion externa no son fallo local', () => {
  assert.equal(normalizeGatewayPaymentStatus('Requires Payment Method'), 'requires_payment_method')
  assert.equal(mapGatewayPaymentStatus('expired'), 'pending')
  assert.equal(mapGatewayPaymentStatus('canceled'), 'pending')
  assert.equal(mapGatewayPaymentStatus('cancelled'), 'pending')
  assert.equal(mapGatewayPaymentStatus('requires_payment_method'), 'pending')

  assert.equal(mapConektaOrderStatus({ payment_status: 'expired' }), 'pending')
  assert.equal(mapConektaOrderStatus({ payment_status: 'canceled' }), 'pending')
  assert.equal(mapMercadoPagoStatus('cancelled'), 'pending')
  assert.equal(mapMercadoPagoStatus('expired'), 'pending')
  assert.equal(mapClipStatus('canceled'), 'pending')
  assert.equal(mapClipStatus('expired'), 'pending')
  assert.equal(mapRebillStatus('canceled'), 'pending')
  assert.equal(mapRebillStatus('expired'), 'pending')
  assert.equal(mapStripePaymentIntentStatus({ status: 'canceled' }), 'pending')
  assert.equal(mapStripePaymentIntentStatus({ status: 'requires_payment_method' }), 'pending')
})

test('politica pagos: solo rechazos o fallos explicitos marcan failed', () => {
  assert.equal(isGatewayPaymentFailureStatus('declined'), true)
  assert.equal(isGatewayPaymentFailureStatus('rejected'), true)
  assert.equal(isGatewayPaymentFailureStatus('payment_failed'), true)

  assert.equal(mapConektaOrderStatus({ payment_status: 'declined' }), 'failed')
  assert.equal(mapConektaOrderStatus({ payment_status: 'charged_back' }), 'failed')
  assert.equal(mapMercadoPagoStatus('rejected'), 'failed')
  assert.equal(mapClipStatus('rejected'), 'failed')
  assert.equal(mapRebillStatus('rejected'), 'failed')
  assert.equal(
    mapStripePaymentIntentStatus({
      status: 'requires_payment_method',
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'generic_decline',
        message: 'Your card was declined.'
      }
    }),
    'failed'
  )
})
