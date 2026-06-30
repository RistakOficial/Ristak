import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPaymentNotificationPayload,
  normalizeNotificationPayload
} from '../src/services/pushNotificationsService.js'

test('normaliza payloads push para no usar Ristak/Reistack como titulo', () => {
  assert.deepEqual(
    normalizeNotificationPayload({
      title: 'Reistack',
      body: 'Ristak: Hola, necesito informes',
      category: 'chat'
    }),
    {
      title: 'Mensaje nuevo',
      body: 'Hola, necesito informes',
      category: 'chat'
    }
  )

  assert.equal(
    normalizeNotificationPayload({
      title: 'Ristak - Ana Lopez',
      body: 'Nos vemos a las 5'
    }).title,
    'Ana Lopez'
  )
})

test('agrega emoji inicial a titulos semanticos de citas y pagos', () => {
  assert.equal(
    normalizeNotificationPayload({
      title: 'Pago recibido',
      body: 'Ana Pago · $1,500.00',
      category: 'payment'
    }).title,
    '💸 Pago recibido'
  )

  assert.equal(
    normalizeNotificationPayload({
      title: '↩️ Pago reembolsado',
      body: 'Maria Cliente',
      category: 'payment'
    }).title,
    '↩️ Pago reembolsado'
  )

  assert.equal(
    normalizeNotificationPayload({
      title: 'Cita reprogramada',
      body: 'Ana · Consulta dental',
      category: 'appointment_rescheduled'
    }).title,
    '↩️ Cita reprogramada'
  )
})

test('construye titulos semanticos para pagos', () => {
  const received = buildPaymentNotificationPayload({
    id: 'pay_received_test',
    contactName: 'Ana Pago',
    amount: 1500,
    currency: 'MXN',
    status: 'paid',
    title: 'Consulta dental'
  })

  assert.equal(received.title, '💸 Pago recibido')
  assert.match(received.body, /Ana Pago/)
  assert.match(received.body, /\$1,500\.00/)
  assert.match(received.body, /Consulta dental/)

  const rejected = buildPaymentNotificationPayload({
    id: 'pay_rejected_test',
    contactName: 'Luis Cliente',
    amount: 800,
    currency: 'MXN',
    status: 'failed',
    failureReason: 'Tarjeta rechazada'
  })

  assert.equal(rejected.title, '❌ Pago rechazado')
  assert.match(rejected.body, /Luis Cliente/)
  assert.match(rejected.body, /Tarjeta rechazada/)

  const refunded = buildPaymentNotificationPayload({
    id: 'pay_refunded_test',
    contactName: 'Maria Cliente',
    amount: 400,
    currency: 'MXN',
    status: 'refunded'
  })

  assert.equal(refunded.title, '↩️ Pago reembolsado')
})
