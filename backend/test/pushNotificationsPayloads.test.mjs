import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  buildFcmMessageBody,
  buildPaymentNotificationPayload,
  normalizeNotificationPayload,
  renderNotificationInitialsAvatarPng,
  sendChatMessageNotification,
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
      title: 'Pago completado',
      body: 'Ana Pago · $1,500.00',
      category: 'payment'
    }).title,
    '💸 Pago completado'
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

  assert.equal(received.title, '💸 Pago completado')
  assert.equal(received.contactName, 'Ana Pago')
  assert.match(received.body, /Pago completado/)
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
  assert.match(rejected.body, /Pago rechazado/)
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
  assert.match(refunded.body, /Pago reembolsado/)
})

test('push de pago publico no usa Pago requerido como resultado del checkout', () => {
  const payload = buildPaymentNotificationPayload({
    id: 'site_payment_completed_test',
    contactName: 'Raul Cliente',
    amount: 2000,
    currency: 'MXN',
    status: 'paid',
    title: 'Pago requerido',
    description: 'Completa el pago para continuar.',
    payment_provider: 'rebill',
    public_payment_id: 'rstk_pay_push_test'
  })

  assert.equal(payload.title, '💸 Pago completado')
  assert.match(payload.body, /Pago completado/)
  assert.match(payload.body, /Raul Cliente/)
  assert.match(payload.body, /\$2,000\.00/)
  assert.doesNotMatch(payload.body, /Pago requerido/i)
})

test('push de pagos cubre estados pendientes y de atencion sin sonar a exito', () => {
  const pending = buildPaymentNotificationPayload({
    id: 'pay_pending_test',
    contactName: 'Ana Pendiente',
    amount: 750,
    currency: 'MXN',
    status: 'pending',
    title: 'Pago requerido'
  })

  assert.equal(pending.title, '⏳ Pago pendiente')
  assert.match(pending.body, /Pago pendiente/)
  assert.doesNotMatch(pending.body, /Pago completado/)
  assert.doesNotMatch(pending.body, /Pago requerido/i)

  const requiresAction = buildPaymentNotificationPayload({
    id: 'pay_requires_action_test',
    contactName: 'Luis Atencion',
    amount: 900,
    currency: 'MXN',
    status: 'requires_action',
    failureReason: 'El banco pide autenticacion adicional.'
  })

  assert.equal(requiresAction.title, '⚠️ Pago requiere atención')
  assert.match(requiresAction.body, /Pago requiere atención/)
  assert.match(requiresAction.body, /autenticacion adicional/)
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
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push de chat con multimedia separa avatar del contacto y attachment del mensaje', async () => {
  const suffix = randomUUID()
  const contactId = `push_media_contact_${suffix}`
  const apiContactId = `push_media_api_${suffix}`
  const phone = `+52156${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const mediaUrl = `https://cdn.example.test/messages/${suffix}.jpg`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Ana Media', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Ana Media', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendAppNotificationPayload({
      title: 'Ana Media',
      body: 'Foto',
      category: 'chat',
      contactName: 'Ana Media',
      contactId,
      notificationImageUrl: mediaUrl,
      notificationAttachmentUrl: mediaUrl
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, mediaUrl)
    assert.equal(sentPayloads[0].notificationAttachmentUrl, mediaUrl)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push de chat de foto usa copy tipo WhatsApp y thumbnail de la media', async () => {
  const suffix = randomUUID()
  const contactId = `push_photo_contact_${suffix}`
  const apiContactId = `push_photo_api_${suffix}`
  const phone = `+52157${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const mediaUrl = `https://cdn.example.test/messages/${suffix}.jpg`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Raul Foto', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Raul Foto', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendChatMessageNotification({
      contactId,
      contactName: 'Raul Foto',
      text: 'Foto',
      messageType: 'image',
      mediaUrl,
      messageId: `photo_${suffix}`,
      timestamp: new Date().toISOString()
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].title, 'Raul Foto')
    assert.equal(sentPayloads[0].body, '📷 Envió una foto.')
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, mediaUrl)
    assert.equal(sentPayloads[0].notificationAttachmentUrl, mediaUrl)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push de chat de nota de voz usa copy con duracion tipo WhatsApp', async () => {
  const suffix = randomUUID()
  const contactId = `push_voice_contact_${suffix}`
  const apiContactId = `push_voice_api_${suffix}`
  const phone = `+52158${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Raul Voz', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Raul Voz', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendChatMessageNotification({
      contactId,
      contactName: 'Raul Voz',
      text: 'Audio',
      messageType: 'audio',
      mediaDurationMs: 2200,
      messageId: `voice_${suffix}`,
      timestamp: new Date().toISOString()
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].title, 'Raul Voz')
    assert.equal(sentPayloads[0].body, '🎤 Mensaje de voz (0:02)')
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push de chat de ubicacion usa pin y no attachment lateral', async () => {
  const suffix = randomUUID()
  const contactId = `push_location_contact_${suffix}`
  const apiContactId = `push_location_api_${suffix}`
  const phone = `+52157${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Raul Ubicacion', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Raul Ubicacion', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendChatMessageNotification({
      contactId,
      contactName: 'Raul Ubicacion',
      text: 'Ubicación',
      messageType: 'location',
      messageId: `location_${suffix}`,
      timestamp: new Date().toISOString()
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].title, 'Raul Ubicacion')
    assert.equal(sentPayloads[0].body, '📍 Ubicación')
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)
    assert.equal(sentPayloads[0].notificationAttachmentUrl, undefined)
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [apiContactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('push de chat de documento usa nombre de archivo y paginas cuando existen', async () => {
  const suffix = randomUUID()
  const contactId = `push_document_contact_${suffix}`
  const apiContactId = `push_document_api_${suffix}`
  const phone = `+52159${Date.now().toString().slice(-8)}`
  const avatarUrl = `https://cdn.example.test/avatars/${suffix}.jpg`
  const documentUrl = `https://cdn.example.test/docs/${suffix}.pdf`
  const sentPayloads = []

  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
      VALUES (?, ?, 'Raul Documento', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId, phone])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Raul Documento', ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [apiContactId, contactId, phone, avatarUrl])

    await sendChatMessageNotification({
      contactId,
      contactName: 'Raul Documento',
      text: 'Documento',
      messageType: 'document',
      mediaUrl: documentUrl,
      mediaFilename: 'CONSTANCIA JUNIO 2026.pdf',
      pageCount: 3,
      messageId: `document_${suffix}`,
      timestamp: new Date().toISOString()
    })

    assert.equal(sentPayloads.length, 1)
    assert.equal(sentPayloads[0].title, 'Raul Documento')
    assert.equal(sentPayloads[0].body, '📄 CONSTANCIA JUNIO 2026.pdf (3 páginas)')
    assert.equal(sentPayloads[0].contactAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].senderAvatarUrl, avatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)
    assert.equal(sentPayloads[0].notificationAttachmentUrl, undefined)
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

test('push de un contacto sin foto usa avatar de iniciales firmado', async () => {
  const previousPublicUrl = process.env.PUBLIC_URL
  process.env.PUBLIC_URL = 'https://push.example.test'

  const contactId = `contact_${randomUUID()}`
  const sentPayloads = []
  setAppNotificationPayloadSenderForTest(async (payload) => {
    sentPayloads.push(payload)
    return { sent: 1, skipped: false }
  })

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, first_name, last_name, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [contactId, `+52656${Date.now()}`, `${contactId}@example.test`, 'Raul Gomez', 'Raul', 'Gomez', 'whatsapp_api']
    )

    await sendAppNotificationPayload({
      title: 'Raul Gomez',
      body: 'Hola desde WhatsApp',
      category: 'chat',
      contactId,
      contactName: 'Raul Gomez'
    })

    assert.equal(sentPayloads.length, 1)
    assert.match(sentPayloads[0].contactAvatarUrl, /^https:\/\/push\.example\.test\/api\/push\/contact-avatar\//)
    assert.equal(sentPayloads[0].senderAvatarUrl, sentPayloads[0].contactAvatarUrl)
    assert.equal(sentPayloads[0].notificationImageUrl, undefined)

    const avatarUrl = new URL(sentPayloads[0].contactAvatarUrl)
    assert.equal(avatarUrl.searchParams.get('i'), 'RG')
    const png = await renderNotificationInitialsAvatarPng({
      contactId,
      initials: avatarUrl.searchParams.get('i'),
      colorIndex: avatarUrl.searchParams.get('c'),
      signature: avatarUrl.searchParams.get('s')
    })
    assert.equal(png[0], 0x89)
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
  } finally {
    if (previousPublicUrl === undefined) {
      delete process.env.PUBLIC_URL
    } else {
      process.env.PUBLIC_URL = previousPublicUrl
    }
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('payload FCM Android viaja data-only para que la app renderice avatar y media nativa', () => {
  const requestBody = buildFcmMessageBody(
    { token: 'android-token-rich' },
    {
      title: 'Paciente Demo',
      body: '📷 Envió una foto.',
      url: '/movil?contact=con_1',
      category: 'chat',
      tag: 'chat-message-1',
      threadId: 'chat-con_1',
      contactId: 'con_1',
      contactName: 'Paciente Demo',
      contactAvatarUrl: 'https://cdn.example.test/avatars/con_1.jpg',
      notificationImageUrl: 'https://cdn.example.test/messages/photo_1.jpg',
      notificationAttachmentUrl: 'https://cdn.example.test/messages/photo_1.jpg'
    },
    { soundEnabled: false, vibrationEnabled: true }
  )

  assert.equal(requestBody.message.token, 'android-token-rich')
  assert.equal(requestBody.message.notification, undefined)
  assert.equal(requestBody.message.android.notification, undefined)
  assert.equal(requestBody.message.android.priority, 'HIGH')
  assert.equal(requestBody.message.data.title, 'Paciente Demo')
  assert.equal(requestBody.message.data.body, '📷 Envió una foto.')
  assert.equal(requestBody.message.data.channelId, 'ristak_vibrate')
  assert.equal(requestBody.message.data.androidChannelId, 'ristak_vibrate')
  assert.equal(requestBody.message.data.contactAvatarUrl, 'https://cdn.example.test/avatars/con_1.jpg')
  assert.equal(requestBody.message.data.senderAvatarUrl, 'https://cdn.example.test/avatars/con_1.jpg')
  assert.equal(requestBody.message.data.notificationImageUrl, 'https://cdn.example.test/messages/photo_1.jpg')
  assert.equal(requestBody.message.data.notificationAttachmentUrl, 'https://cdn.example.test/messages/photo_1.jpg')
  assert.equal(requestBody.message.data.soundEnabled, 'false')
  assert.equal(requestBody.message.data.vibrationEnabled, 'true')
})
