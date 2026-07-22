import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  collapseHighLevelPhoneMirrorRowsForDisplay,
  getHighLevelConversationalChannelPreference,
  resolveHighLevelConversationalPhoneRoute,
  setHighLevelConversationalChannelPreference,
  stripHighLevelPhoneMirrorAnnotation
} from '../src/services/highLevelConversationalChannelRoutingService.js'

async function createContact(marker) {
  const contactId = `contact_ghl_route_${marker}`
  const phone = `+52656${marker.slice(0, 10).replace(/[a-f]/g, '7')}`
  await db.run(
    `INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at)
     VALUES (?, ?, 'Canal GHL', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, phone]
  )
  return { contactId, phone }
}

async function insertInbound({
  id,
  contactId,
  phone,
  transport,
  text,
  timestamp,
  businessPhone
}) {
  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, ycloud_message_id, contact_id, phone, from_phone, business_phone,
      transport, direction, message_type, message_text, status,
      message_timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', 'text', ?, 'received', ?, ?)
  `, [
    id,
    `remote_${id}`,
    contactId,
    phone,
    phone,
    businessPhone,
    transport,
    text,
    timestamp,
    timestamp
  ])
}

async function cleanup(contactId) {
  await db.run('DELETE FROM contact_conversational_channel_preferences WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('GHL elige WhatsApp y suprime el SMS duplicado cuando la ventana previa sigue abierta', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-01T18:00:00.000Z')
  const duplicateAt = new Date(nowMs - 1_000).toISOString()
  const whatsappBusinessPhone = '+19155550111'

  try {
    await insertInbound({
      id: `wa_prior_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Mensaje anterior',
      timestamp: new Date(nowMs - 60 * 60 * 1000).toISOString(),
      businessPhone: whatsappBusinessPhone
    })
    await insertInbound({
      id: `wa_duplicate_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Quiero información',
      timestamp: duplicateAt,
      businessPhone: whatsappBusinessPhone
    })
    await insertInbound({
      id: `sms_duplicate_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Quiero información',
      timestamp: duplicateAt,
      businessPhone: '+19155550222'
    })

    const whatsapp = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `wa_duplicate_${marker}`,
      inboundChannel: 'whatsapp',
      nowMs
    })
    const sms = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_duplicate_${marker}`,
      inboundChannel: 'sms',
      nowMs
    })

    assert.equal(whatsapp.replyChannel, 'whatsapp')
    assert.equal(whatsapp.shouldHandle, true)
    assert.equal(whatsapp.replyFromNumber, whatsappBusinessPhone)
    assert.equal(sms.replyChannel, 'whatsapp')
    assert.equal(sms.shouldHandle, false)
    assert.equal(sms.reason, 'cross_channel_duplicate_suppressed')
  } finally {
    await cleanup(contactId)
  }
})

test('GHL reconoce el espejo CUSTOM_SMS aunque agregue Received on al cuerpo', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-01T19:00:00.000Z')
  const whatsappBusinessPhone = '+19155550999'

  try {
    await insertInbound({
      id: `wa_annotated_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Buenos días quiero reagendar la cita por favor',
      timestamp: new Date(nowMs - 900).toISOString(),
      businessPhone: whatsappBusinessPhone
    })
    await insertInbound({
      id: `sms_annotated_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Buenos días quiero reagendar la cita por favor\n\n📱 [Received on Raúl Gómez (5218123802444)]',
      timestamp: new Date(nowMs - 1_000).toISOString(),
      businessPhone: '+19155550888'
    })

    const sms = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_annotated_${marker}`,
      inboundChannel: 'sms',
      nowMs
    })

    assert.equal(sms.shouldHandle, false)
    assert.equal(sms.replyChannel, 'whatsapp')
    assert.equal(sms.reason, 'cross_channel_duplicate_suppressed')
  } finally {
    await cleanup(contactId)
  }
})

test('el historial oculta solo las firmas espejo y conserva envíos reales repetidos', () => {
  const phone = '+529614398181'
  const rows = [
    {
      id: 'wa_real_1',
      transport: 'ghl_whatsapp',
      direction: 'outbound',
      phone,
      message_text: 'Listo, aquí tienes el enlace',
      message_timestamp: '2030-06-01T20:00:00.000Z'
    },
    {
      id: 'sms_mirror_1',
      transport: 'ghl_sms',
      direction: 'outbound',
      phone,
      message_text: 'Listo, aquí tienes el enlace\n\n🔁 Sent from another device (5218123802444 ) 🔁',
      message_timestamp: '2030-06-01T20:00:02.000Z'
    },
    {
      id: 'wa_real_2',
      transport: 'ghl_whatsapp',
      direction: 'outbound',
      phone,
      message_text: 'Listo, aquí tienes el enlace',
      message_timestamp: '2030-06-01T20:00:04.000Z'
    },
    {
      id: 'sms_mirror_2',
      transport: 'ghl_sms',
      direction: 'outbound',
      phone,
      message_text: 'Listo, aquí tienes el enlace\n\n🔁 Sent from another device (5218123802444 ) 🔁',
      message_timestamp: '2030-06-01T20:00:06.000Z'
    }
  ]

  const visible = collapseHighLevelPhoneMirrorRowsForDisplay(rows)

  assert.deepEqual(visible.map(row => row.id), ['wa_real_1', 'wa_real_2'])
  assert.deepEqual(visible.map(row => row.message_text), [
    'Listo, aquí tienes el enlace',
    'Listo, aquí tienes el enlace'
  ])
  assert.equal(stripHighLevelPhoneMirrorAnnotation(
    'Confirmo\n\n📱 [Received on Raúl Gómez (5218123802444)]'
  ), 'Confirmo')
})

test('el historial no mezcla direcciones ni limpia anotaciones fuera de HighLevel', () => {
  const phone = '+529614398181'
  const visible = collapseHighLevelPhoneMirrorRowsForDisplay([
    {
      id: 'wa_inbound',
      transport: 'ghl_whatsapp',
      direction: 'inbound',
      phone,
      message_text: 'Sí, confirmo',
      message_timestamp: '2030-06-01T20:01:00.000Z'
    },
    {
      id: 'sms_outbound',
      transport: 'ghl_sms',
      direction: 'outbound',
      phone,
      message_text: 'Sí, confirmo 📱 [Received on Raúl Gómez (5218123802444)]',
      message_timestamp: '2030-06-01T20:01:01.000Z'
    },
    {
      id: 'plain_api',
      transport: 'api',
      direction: 'inbound',
      phone,
      message_text: 'Texto legítimo 📱 [Received on demostración] ',
      message_timestamp: '2030-06-01T20:02:00.000Z'
    }
  ])

  assert.deepEqual(visible.map(row => row.id), ['wa_inbound', 'sms_outbound', 'plain_api'])
  assert.equal(visible[1].message_text, 'Sí, confirmo')
  assert.equal(visible[2].message_text, 'Texto legítimo 📱 [Received on demostración] ')
})

test('GHL elige SMS después de 24 horas y no deja que el espejo WhatsApp reabra la ventana', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-02T18:00:00.000Z')
  const duplicateAt = new Date(nowMs - 1_000).toISOString()

  try {
    await insertInbound({
      id: `wa_stale_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Mensaje viejo',
      timestamp: new Date(nowMs - 25 * 60 * 60 * 1000).toISOString(),
      businessPhone: '+19155550333'
    })
    await insertInbound({
      id: `wa_mirror_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Retomo la conversación',
      timestamp: duplicateAt,
      businessPhone: '+19155550333'
    })
    await insertInbound({
      id: `sms_winner_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Retomo la conversación',
      timestamp: duplicateAt,
      businessPhone: '+19155550444'
    })

    const whatsapp = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `wa_mirror_${marker}`,
      nowMs
    })
    const sms = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_winner_${marker}`,
      nowMs
    })

    assert.equal(whatsapp.replyChannel, 'sms')
    assert.equal(whatsapp.shouldHandle, false)
    assert.equal(sms.replyChannel, 'sms')
    assert.equal(sms.shouldHandle, true)
    assert.equal(sms.whatsappWindowOpen, false)
  } finally {
    await cleanup(contactId)
  }
})

test('la última elección manual de SMS manda aunque WhatsApp siga dentro de 24 horas', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-03T18:00:00.000Z')

  try {
    await insertInbound({
      id: `wa_recent_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Hola por WhatsApp',
      timestamp: new Date(nowMs - 30 * 60 * 1000).toISOString(),
      businessPhone: '+19155550555'
    })
    await insertInbound({
      id: `sms_manual_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Contéstame por SMS',
      timestamp: new Date(nowMs - 1_000).toISOString(),
      businessPhone: '+19155550666'
    })
    await setHighLevelConversationalChannelPreference(contactId, 'sms', {
      selectedByUserId: 'user_test',
      source: 'manual'
    })

    const stored = await getHighLevelConversationalChannelPreference(contactId)
    const route = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_manual_${marker}`,
      nowMs
    })

    assert.equal(stored.channel, 'sms')
    assert.equal(stored.selectedByUserId, 'user_test')
    assert.equal(route.replyChannel, 'sms')
    assert.equal(route.shouldHandle, true)
    assert.equal(route.reason, 'manual_channel_preference')
  } finally {
    await cleanup(contactId)
  }
})

test('un SMS único no se pierde: el agente lo procesa y responde por WhatsApp si la ventana está abierta', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-04T18:00:00.000Z')
  const whatsappBusinessPhone = '+19155550777'

  try {
    await insertInbound({
      id: `wa_window_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Ventana abierta',
      timestamp: new Date(nowMs - 2 * 60 * 60 * 1000).toISOString(),
      businessPhone: whatsappBusinessPhone
    })
    await insertInbound({
      id: `sms_only_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Sólo llegó por SMS',
      timestamp: new Date(nowMs - 1_000).toISOString(),
      businessPhone: '+19155550888'
    })

    const route = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_only_${marker}`,
      nowMs
    })

    assert.equal(route.duplicateDetected, false)
    assert.equal(route.shouldHandle, true)
    assert.equal(route.sourceChannel, 'sms')
    assert.equal(route.replyChannel, 'whatsapp')
    assert.equal(route.replyFromNumber, whatsappBusinessPhone)
  } finally {
    await cleanup(contactId)
  }
})

test('la selección manual más reciente de WhatsApp gana aunque la ruta automática elegiría SMS', async () => {
  const marker = randomUUID().replace(/-/g, '')
  const { contactId, phone } = await createContact(marker)
  const nowMs = Date.parse('2030-06-05T18:00:00.000Z')
  const duplicateAt = new Date(nowMs - 1_000).toISOString()

  try {
    await insertInbound({
      id: `wa_manual_${marker}`,
      contactId,
      phone,
      transport: 'ghl_whatsapp',
      text: 'Duplicado manual',
      timestamp: duplicateAt,
      businessPhone: '+19155550999'
    })
    await insertInbound({
      id: `sms_auto_${marker}`,
      contactId,
      phone,
      transport: 'ghl_sms',
      text: 'Duplicado manual',
      timestamp: duplicateAt,
      businessPhone: '+19155550000'
    })
    await setHighLevelConversationalChannelPreference(contactId, 'sms', { source: 'manual' })
    await setHighLevelConversationalChannelPreference(contactId, 'whatsapp', { source: 'manual' })

    const whatsapp = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `wa_manual_${marker}`,
      nowMs
    })
    const sms = await resolveHighLevelConversationalPhoneRoute({
      contactId,
      inboundMessageId: `sms_auto_${marker}`,
      nowMs
    })

    assert.equal(whatsapp.manualPreference, 'whatsapp')
    assert.equal(whatsapp.replyChannel, 'whatsapp')
    assert.equal(whatsapp.shouldHandle, true)
    assert.equal(sms.replyChannel, 'whatsapp')
    assert.equal(sms.shouldHandle, false)
  } finally {
    await cleanup(contactId)
  }
})
