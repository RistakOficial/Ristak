import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  buildPaymentNotificationPayload,
  normalizeNotificationPayload,
  sendAppNotificationPayload,
  setAppNotificationPayloadSenderForTest
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
  assert.equal(received.contactName, 'Ana Pago')
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

test('push de contacto unico usa avatar del contacto cuando existe foto publica', async () => {
  const suffix = randomUUID()
  const contactId = `push_avatar_contact_${suffix}`
  const apiContactId = `push_avatar_api_${suffix}`
  const phone = `+52155${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Ana Avatar', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Ana Avatar', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendAppNotificationPayload({
      title: 'Ana Avatar',
      body: 'Hola',
      category: 'chat',
      contactName: 'Ana Avatar',
      contactId
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].contactName, 'Ana Avatar')
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, avatarUrl)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push general o de multiples contactos no usa imagen aunque llegue imageUrl', async () => {
  const sentPayloads = []
  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await sendAppNotificationPayload({
      title: 'Resumen',
      body: 'Varias personas agendaron',
      category: 'appointment_booked',
      contactIds: ['contact_a', 'contact_b'],
      imageUrl: 'https://cdn.example.test/avatars/nope.jpg'
    })

    await sendAppNotificationPayload({
      title: 'Actualizacion',
      body: 'Nueva version lista',
      category: 'system',
      imageUrl: 'https://cdn.example.test/avatars/nope.jpg'
    })

    assert.equal(sentPayloads.length, 2)
    assert.equal(sentPayloads[0].contactAvatarUrl, undefined)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)
    assert.equal(sentPayloads[1].contactAvatarUrl, undefined)
    assert.equal(sentPayloads[1].notificationImageUrl, undefined)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
  }
})
