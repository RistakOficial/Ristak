import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPaymentDisplay } from '../src/utils/paymentDisplay.js'

test('payment display separates manual cash method from Ristak channel', () => {
  assert.deepEqual(
    buildPaymentDisplay({
      status: 'paid',
      payment_method: 'cash',
      payment_provider: 'manual'
    }),
    {
      paymentMethodCategoryId: 'cash',
      paymentMethodCategory: 'Efectivo',
      paymentType: 'Pago único',
      paymentChannelId: 'ristak',
      paymentChannel: 'Ristak'
    }
  )
})

test('payment display reports Stripe card funding and selected MSI', () => {
  const display = buildPaymentDisplay({
    status: 'paid',
    payment_method: 'stripe',
    payment_provider: 'stripe',
    metadata_json: JSON.stringify({
      stripe: {
        cardFunding: 'credit',
        installments: {
          plan: {
            type: 'fixed_count',
            interval: 'month',
            count: 6
          }
        }
      }
    })
  })

  assert.equal(display.paymentMethodCategory, 'Tarjeta de crédito')
  assert.equal(display.paymentType, '6 MSI')
  assert.equal(display.paymentChannel, 'Stripe')
})

test('payment display uses Mercado Pago payment_type_id for debit card', () => {
  const display = buildPaymentDisplay({
    status: 'paid',
    payment_method: 'debit_card',
    payment_provider: 'mercadopago',
    metadata_json: JSON.stringify({
      mercadoPago: {
        paymentMethodId: 'debvisa',
        paymentTypeId: 'debit_card',
        installments: 1
      }
    })
  })

  assert.equal(display.paymentMethodCategory, 'Tarjeta de débito')
  assert.equal(display.paymentType, 'Pago único')
  assert.equal(display.paymentChannel, 'Mercado Pago')
})

test('payment display keeps SPEI as the method category', () => {
  const display = buildPaymentDisplay({
    status: 'paid',
    payment_method: 'spei',
    payment_provider: 'mercadopago'
  })

  assert.equal(display.paymentMethodCategory, 'SPEI')
  assert.equal(display.paymentChannel, 'Mercado Pago')
})

test('payment display does not pretend a pending checkout link already has a method', () => {
  const display = buildPaymentDisplay({
    status: 'sent',
    payment_method: 'stripe_link',
    payment_provider: 'stripe'
  })

  assert.equal(display.paymentMethodCategory, 'Pendiente de selección')
  assert.equal(display.paymentType, 'Pago único')
  assert.equal(display.paymentChannel, 'Stripe')
})

test('payment display identifies subscriptions as payment type, not payment method', () => {
  const display = buildPaymentDisplay({
    status: 'paid',
    payment_method: 'conekta_subscription',
    payment_provider: 'conekta',
    conekta_order_id: 'ord_123'
  })

  assert.equal(display.paymentMethodCategory, 'Tarjeta')
  assert.equal(display.paymentType, 'Suscripción')
  assert.equal(display.paymentChannel, 'Conekta')
})

test('payment display marks payment-plan scheduled charges as deferred payments', () => {
  const display = buildPaymentDisplay({
    status: 'scheduled',
    payment_method: 'stripe_scheduled_card',
    payment_provider: 'stripe',
    metadata_json: JSON.stringify({
      paymentPlan: {
        flowId: 'flow_123',
        source: 'stripe_payment_plan'
      }
    })
  })

  assert.equal(display.paymentMethodCategory, 'Tarjeta')
  assert.equal(display.paymentType, 'Pago diferido')
  assert.equal(display.paymentChannel, 'Stripe')
})
