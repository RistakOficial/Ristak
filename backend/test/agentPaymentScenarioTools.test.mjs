import test from 'node:test'
import assert from 'node:assert/strict'

import { inferAgentCategoryFromMessage } from '../src/agents/runner.js'
import { buildInstallmentPayload, paymentFlowTools } from '../src/agents/tools/paymentFlowTools.js'

test('agente de pagos normaliza planes irregulares con porcentajes, meses saltados y tarjeta guardada', () => {
  const payload = buildInstallmentPayload({
    contact: {
      id: 'contact_agent_plan_1',
      name: 'Cliente Plan Inteligente',
      email: 'cliente@example.test',
      phone: '+5215555555555'
    },
    totalAmount: 10000,
    currency: 'MXN',
    concept: 'Plan irregular con meses saltados',
    paymentMethodId: 'stripe_pm_saved_123',
    remainingFrequency: 'custom',
    firstPayment: {
      percentage: 10,
      date: '2099-01-15',
      method: 'saved_card'
    },
    remainingPayments: [
      { percentage: 20, dueDate: '2099-02-15', notes: 'mes si' },
      { percentage: 25, dueDate: '2099-04-15', notes: 'se salto marzo' },
      { percentage: 25, dueDate: '2099-05-15', notes: 'segundo mes seguido' },
      { percentage: 20, dueDate: '2099-07-15', paymentMethod: 'bank_transfer', notes: 'se salto junio' }
    ]
  })

  assert.equal(payload.paymentMethodId, 'stripe_pm_saved_123')
  assert.deepEqual(payload.firstPayment, {
    enabled: true,
    amount: 1000,
    percentage: 10,
    type: 'percentage',
    value: 10,
    date: '2099-01-15',
    method: 'saved_card'
  })
  assert.deepEqual(
    payload.remainingPayments.map((payment) => ({
      sequence: payment.sequence,
      amount: payment.amount,
      percentage: payment.percentage,
      dueDate: payment.dueDate,
      frequency: payment.frequency,
      paymentMethod: payment.paymentMethod || null,
      notes: payment.notes || null
    })),
    [
      { sequence: 1, amount: 2000, percentage: 20, dueDate: '2099-02-15', frequency: 'custom', paymentMethod: null, notes: 'mes si' },
      { sequence: 2, amount: 2500, percentage: 25, dueDate: '2099-04-15', frequency: 'custom', paymentMethod: null, notes: 'se salto marzo' },
      { sequence: 3, amount: 2500, percentage: 25, dueDate: '2099-05-15', frequency: 'custom', paymentMethod: null, notes: 'segundo mes seguido' },
      { sequence: 4, amount: 2000, percentage: 20, dueDate: '2099-07-15', frequency: 'custom', paymentMethod: 'bank_transfer', notes: 'se salto junio' }
    ]
  )
  assert.equal(
    payload.remainingPayments.reduce((sum, payment) => sum + payment.amount, payload.firstPayment.amount),
    10000
  )
  assert.ok(!payload.remainingPayments.some((payment) => payment.amount === 0), 'no debe crear pagos de 0 para meses sin cobro')
  assert.ok(!payload.remainingPayments.some((payment) => payment.dueDate === '2099-03-15'), 'marzo se representa saltando la fecha')
  assert.ok(!payload.remainingPayments.some((payment) => payment.dueDate === '2099-06-15'), 'junio se representa saltando la fecha')
})

test('agente de pagos conserva montos fijos, porcentajes informativos y fechas distintas por parcialidad', () => {
  const payload = buildInstallmentPayload({
    contact: { id: 'contact_agent_plan_2', name: 'Cliente Mixto' },
    totalAmount: 3750,
    currency: 'MXN',
    concept: 'Plan mixto',
    firstPayment: {
      amount: 750,
      percentage: 20,
      date: '2099-01-05',
      method: 'transfer'
    },
    remainingPayments: [
      { amount: 500, percentage: 13.33, dueDate: '2099-01-20', frequency: 'custom' },
      { amount: 1250, percentage: 33.33, dueDate: '2099-03-10', frequency: 'custom' },
      { amount: 1250, percentage: 33.34, dueDate: '2099-06-30', frequency: 'custom' }
    ]
  })

  assert.equal(payload.firstPayment.amount, 750)
  assert.equal(payload.firstPayment.type, 'amount')
  assert.deepEqual(payload.remainingPayments.map((payment) => payment.amount), [500, 1250, 1250])
  assert.deepEqual(payload.remainingPayments.map((payment) => payment.percentage), [13.33, 33.33, 33.34])
  assert.deepEqual(payload.remainingPayments.map((payment) => payment.dueDate), ['2099-01-20', '2099-03-10', '2099-06-30'])
})

test('agente de pagos rechaza parcialidades sin monto ni porcentaje antes de crear un plan incompleto', () => {
  assert.throws(
    () => buildInstallmentPayload({
      contact: { id: 'contact_agent_plan_invalid', name: 'Cliente Incompleto' },
      totalAmount: 5000,
      currency: 'MXN',
      concept: 'Plan incompleto',
      firstPayment: null,
      remainingPayments: [
        { amount: 1000, dueDate: '2099-01-15' },
        { dueDate: '2099-02-15' }
      ]
    }),
    /parcialidad 2 necesita monto o porcentaje válido/i
  )
})

test('herramientas del agente cubren pago unico, planes, pasarelas, tarjetas y suscripciones', () => {
  const names = paymentFlowTools.map((tool) => tool.name)
  for (const expected of [
    'get_payment_gateways',
    'create_payment_link',
    'create_installment_plan',
    'list_saved_payment_methods',
    'charge_saved_card',
    'list_subscriptions',
    'create_subscription'
  ]) {
    assert.ok(names.includes(expected), `falta herramienta ${expected}`)
  }
})

test('ruteo inicial detecta pagos en frases reales de planes irregulares y pasarelas', () => {
  const messages = [
    'Hazle un plan de pagos por Stripe: un mes si, un mes no, dos meses si y uno no',
    'Crea un plan de pagos por HighLevel con 20% de anticipo y el resto en fechas distintas',
    'Haz un pago unico por Mercado Pago para Ana',
    'Crea una suscripcion anual con tarjeta guardada para Luis'
  ]

  for (const message of messages) {
    assert.equal(
      inferAgentCategoryFromMessage({ latestUserMessage: message }),
      'pagos',
      message
    )
  }
})
