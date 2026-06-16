import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  db,
  repairWhatsAppApiContactIdentityFromMessages
} from '../src/config/database.js'
import {
  extractWhatsAppProfileName,
  normalizeWhatsAppProfileName
} from '../src/utils/whatsappContactProfile.js'
import {
  processYCloudWhatsAppWebhook,
  syncYCloudContacts,
  syncYCloudMessageRecords
} from '../src/services/whatsappApiService.js'

async function cleanup({ contactId, apiContactId, messageId, phone, eventId }) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR contact_id = ? OR phone = ?', [messageId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ? OR contact_id = ? OR phone = ?', [apiContactId, contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ? OR id = ?', [eventId, eventId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

test('normaliza nombres reales de YCloud y descarta los genéricos', () => {
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('Contacto WhatsApp_API', '+524433948272'), '')
  assert.equal(normalizeWhatsAppProfileName('+524433948272', '+524433948272'), '')
  assert.equal(extractWhatsAppProfileName({
    customerProfile: {
      name: 'Ana López',
      username: '@ana'
    }
  }, '+524433948272'), 'Ana López')
  assert.equal(extractWhatsAppProfileName({ displayName: 'Ana López' }, '+524433948272'), 'Ana López')
})

test('webhook entrante de YCloud reemplaza WhatsApp_API por customerProfile.name', async () => {
  const id = randomUUID()
  const phone = `+52997${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_live_profile_${id}`
  const eventId = `evt_live_profile_${id}`
  const messageAt = '2024-04-05T06:07:08.000Z'

  await cleanup({ contactId, messageId, phone, eventId })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'WhatsApp_API',
      'WhatsApp_API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.inbound_message.received',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappInboundMessage: {
        id: messageId,
        wamid: `wamid.${id}`,
        wabaId: 'WABA-ID',
        from: phone,
        customerProfile: {
          name: 'Ana López',
          username: '@ana'
        },
        to: '+526561000000',
        sendTime: messageAt,
        type: 'text',
        text: { body: 'Hola' }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const contact = await db.get('SELECT full_name, first_name FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')

    const apiContact = await db.get('SELECT profile_name FROM whatsapp_api_contacts WHERE contact_id = ?', [contactId])
    assert.equal(apiContact.profile_name, 'Ana López')
  } finally {
    await cleanup({ contactId, messageId, phone, eventId })
  }
})

test('webhook saliente respeta contactId existente aunque el teléfono todavía no esté guardado', async () => {
  const id = randomUUID()
  const phone = `+52996${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_outbound_contact_${id}`
  const eventId = `evt_outbound_contact_${id}`
  const messageAt = '2024-05-06T07:08:09.000Z'

  await cleanup({ contactId, messageId, phone, eventId })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?)
    `, [
      contactId,
      'Ana López',
      'Ana',
      'manual',
      '2024-05-01T00:00:00.000Z',
      '2024-05-01T00:00:00.000Z'
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.message.updated',
      apiVersion: 'v2',
      createTime: messageAt,
      contactId,
      whatsappMessage: {
        id: messageId,
        from: '+526561000000',
        to: phone,
        sendTime: messageAt,
        status: 'sent',
        type: 'text',
        text: { body: 'Hola Ana' }
      }
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const message = await db.get('SELECT contact_id, phone FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [messageId])
    assert.equal(message.contact_id, contactId)
    assert.equal(message.phone, phone)

    const contacts = await db.all('SELECT id, full_name, phone FROM contacts WHERE id = ? OR phone = ?', [contactId, phone])
    assert.equal(contacts.length, 1)
    assert.equal(contacts[0].id, contactId)
    assert.equal(contacts[0].full_name, 'Ana López')
    assert.equal(contacts[0].phone, phone)
  } finally {
    await cleanup({ contactId, messageId, phone, eventId })
  }
})

test('historial smb de YCloud infiere entrantes y salientes por teléfonos conocidos', async () => {
  const id = randomUUID()
  const phone = `+52990${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const phoneNumberId = `phone_history_direction_${id}`
  const eventId = `evt_history_direction_${id}`
  const inboundMessageId = `ycloud_history_inbound_${id}`
  const outboundMessageId = `ycloud_history_outbound_${id}`
  const messageAt = '2024-06-07T08:09:10.000Z'

  await cleanup({ phone, eventId })
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name, status, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, 'CONNECTED', ?, ?)
    `, [
      phoneNumberId,
      businessPhone,
      businessPhone,
      'Ristak Test',
      messageAt,
      messageAt
    ])

    const payload = {
      id: eventId,
      type: 'whatsapp.smb.history',
      apiVersion: 'v2',
      createTime: messageAt,
      whatsappMessages: [
        {
          id: inboundMessageId,
          from: phone,
          to: businessPhone,
          sendTime: messageAt,
          type: 'text',
          text: { body: 'Hola, soy cliente' },
          customerProfile: { name: 'Cliente Historial' }
        },
        {
          id: outboundMessageId,
          from: businessPhone,
          to: phone,
          sendTime: '2024-06-07T08:10:10.000Z',
          type: 'text',
          text: { body: 'Hola, soy negocio' }
        }
      ]
    }

    await processYCloudWhatsAppWebhook({
      payload,
      rawBody: JSON.stringify(payload),
      signatureHeader: '',
      endpointId: ''
    })

    const rows = await db.all(`
      SELECT ycloud_message_id, direction, contact_id, phone
      FROM whatsapp_api_messages
      WHERE ycloud_message_id IN (?, ?)
      ORDER BY message_timestamp ASC
    `, [inboundMessageId, outboundMessageId])

    assert.equal(rows.length, 2)
    assert.equal(rows[0].ycloud_message_id, inboundMessageId)
    assert.equal(rows[0].direction, 'inbound')
    assert.ok(rows[0].contact_id)
    assert.equal(rows[0].phone, phone)
    assert.equal(rows[1].ycloud_message_id, outboundMessageId)
    assert.equal(rows[1].direction, 'outbound')
    assert.equal(rows[1].contact_id, rows[0].contact_id)
    assert.equal(rows[1].phone, phone)
  } finally {
    await cleanup({ phone, eventId })
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  }
})

test('sync historico de YCloud conserva nombre real y source_id de anuncios', async () => {
  const id = randomUUID()
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const contactId = `rstk_contact_test_${id}`
  const messageId = `ycloud_history_ad_${id}`
  const messageAt = '2024-04-11T12:13:14.000Z'

  await cleanup({ contactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'WhatsApp_API',
      'WhatsApp_API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const result = await syncYCloudMessageRecords([{
      id: messageId,
      wamid: `wamid.${id}`,
      from: phone,
      to: businessPhone,
      sendTime: messageAt,
      type: 'text',
      text: { body: 'Quiero informes de la promo' },
      customerProfile: { name: 'Ana López' },
      referral: {
        source_url: 'https://fb.me/ad-test',
        source_type: 'ad',
        source_id: '238555000333444',
        headline: 'Promo junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_history_123'
      }
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.smb.history',
      source: 'ycloud_history_test'
    })

    assert.equal(result.messages, 1)
    assert.equal(result.attributed, 1)

    await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })

    const contact = await db.get(`
      SELECT full_name, first_name, attribution_ad_id, attribution_ad_name,
             attribution_ctwa_clid, attribution_url, attribution_medium, created_at
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')
    assert.equal(contact.attribution_ad_id, '238555000333444')
    assert.equal(contact.attribution_ad_name, 'Promo junio')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_history_123')
    assert.equal(contact.attribution_url, 'https://fb.me/ad-test')
    assert.equal(contact.attribution_medium, 'ad')
    assert.equal(new Date(contact.created_at).toISOString(), messageAt)

    const message = await db.get(`
      SELECT detected_source_id, detected_ctwa_clid, direction, origin
      FROM whatsapp_api_messages
      WHERE ycloud_message_id = ?
    `, [messageId])

    assert.equal(message.detected_source_id, '238555000333444')
    assert.equal(message.detected_ctwa_clid, 'ctwa_history_123')
    assert.equal(message.direction, 'inbound')
    assert.equal(message.origin, 'ycloud_history_test')
  } finally {
    await cleanup({ contactId, messageId, phone })
  }
})

test('sync de contactos YCloud no convierte el nombre en anuncio y respeta createTime', async () => {
  const id = randomUUID()
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const contactName = 'Mier Drogueria'
  const createTime = '2024-01-02T03:04:05.000Z'
  const lastSeen = '2026-06-16T05:06:07.000Z'

  await cleanup({ phone })

  try {
    await syncYCloudContacts([{
      id: `ycloud_contact_${id}`,
      phoneNumber: phone,
      nickname: contactName,
      sourceId: 'batch_import_123',
      sourceType: 'import',
      createTime,
      lastSeen
    }])

    const contact = await db.get(`
      SELECT id, full_name, first_name, attribution_ad_id, attribution_ad_name, created_at
      FROM contacts
      WHERE phone = ?
    `, [phone])

    assert.equal(contact.full_name, contactName)
    assert.equal(contact.first_name, contactName)
    assert.equal(contact.attribution_ad_id, null)
    assert.equal(contact.attribution_ad_name, null)
    assert.equal(new Date(contact.created_at).toISOString(), createTime)

    const apiContact = await db.get(`
      SELECT profile_name, first_seen_at, last_seen_at
      FROM whatsapp_api_contacts
      WHERE contact_id = ?
    `, [contact.id])

    assert.equal(apiContact.profile_name, contactName)
    assert.equal(new Date(apiContact.first_seen_at).toISOString(), createTime)
    assert.equal(new Date(apiContact.last_seen_at).toISOString(), lastSeen)
  } finally {
    await cleanup({ phone })
  }
})

test('reparacion limpia anuncios falsos que son solo el nombre del contacto', async () => {
  const id = randomUUID()
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`

  await cleanup({ contactId, apiContactId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Mier Drogueria',
      'Mier Drogueria',
      'WhatsApp_API',
      'Mier Drogueria',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Mier Drogueria',
      JSON.stringify({ nickname: 'Mier Drogueria' }),
      '2024-01-02T03:04:05.000Z',
      '2026-06-16T05:06:07.000Z',
      0,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)

    const contact = await db.get('SELECT attribution_ad_id, attribution_ad_name, created_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.attribution_ad_id, null)
    assert.equal(contact.attribution_ad_name, null)
    assert.equal(new Date(contact.created_at).toISOString(), '2024-01-02T03:04:05.000Z')
  } finally {
    await cleanup({ contactId, apiContactId, phone })
  }
})

test('repara contactos importados de WhatsApp API con nombre y primera fecha del historial', async () => {
  const id = randomUUID()
  const phone = `+52999${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_test_${id}`
  const realMessageAt = '2024-02-03T04:05:06.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Contacto WhatsApp API',
      'Contacto WhatsApp API',
      'WhatsApp_API',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Contacto WhatsApp_API',
      JSON.stringify({ nickname: 'Contacto WhatsApp API' }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z',
      1,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, origin, ycloud_message_id, whatsapp_api_contact_id,
        contact_id, phone, from_phone, to_phone, direction, message_type,
        message_text, status, message_timestamp, raw_payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      messageId,
      'ycloud',
      'whatsapp.smb.history',
      'ycloud_history_1',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Hola',
      'received',
      realMessageAt,
      JSON.stringify({
        id: 'ycloud_history_1',
        customerProfile: { name: 'Ana López', username: '@ana' },
        from: phone,
        to: '+526561000000',
        sendTime: realMessageAt,
        type: 'text',
        text: { body: 'Hola' }
      }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)
    assert.ok(repaired.apiContacts >= 1)

    const contact = await db.get('SELECT full_name, first_name, created_at FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Ana López')
    assert.equal(contact.first_name, 'Ana López')
    assert.equal(new Date(contact.created_at).toISOString(), realMessageAt)

    const apiContact = await db.get('SELECT profile_name, first_seen_at FROM whatsapp_api_contacts WHERE id = ?', [apiContactId])
    assert.equal(apiContact.profile_name, 'Ana López')
    assert.equal(new Date(apiContact.first_seen_at).toISOString(), realMessageAt)
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
  }
})

test('repara attribution_ad_id cuando YCloud importó un sourceId genérico antes del referral real', async () => {
  const id = randomUUID()
  const phone = `+52998${Date.now().toString().slice(-7)}`
  const contactId = `rstk_contact_test_${id}`
  const apiContactId = `waapi_profile_test_${id}`
  const messageId = `waapi_msg_test_${id}`
  const realMessageAt = '2024-03-04T05:06:07.000Z'

  await cleanup({ contactId, apiContactId, messageId, phone })

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source,
        attribution_ad_id, attribution_ad_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Contacto WhatsApp API',
      'Contacto WhatsApp API',
      'WhatsApp_API',
      'batch_import_123',
      'batch_import_123',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, raw_profile_json,
        first_seen_at, last_seen_at, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      apiContactId,
      contactId,
      phone,
      'Contacto WhatsApp_API',
      JSON.stringify({ sourceId: 'batch_import_123', sourceType: 'import' }),
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z',
      1,
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, origin, ycloud_message_id, whatsapp_api_contact_id,
        contact_id, phone, from_phone, to_phone, direction, message_type,
        message_text, status, message_timestamp, raw_payload_json, referral_json,
        detected_ctwa_clid, detected_source_id, detected_source_url,
        detected_source_type, detected_headline, detected_body,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      messageId,
      'ycloud',
      'whatsapp.inbound_message.received',
      'ycloud_ad_1',
      apiContactId,
      contactId,
      phone,
      phone,
      '+526561000000',
      'inbound',
      'text',
      'Quiero informes',
      'received',
      realMessageAt,
      JSON.stringify({
        id: 'ycloud_ad_1',
        customerProfile: { name: 'Ana López' },
        from: phone,
        to: '+526561000000',
        sendTime: realMessageAt,
        type: 'text',
        text: { body: 'Quiero informes' },
        referral: {
          source_url: 'https://fb.me/xxx',
          source_type: 'ad',
          source_id: '238555000111222',
          headline: 'Promo junio',
          body: 'Agenda por WhatsApp',
          ctwa_clid: 'ctwa_real_123'
        }
      }),
      JSON.stringify({
        source_url: 'https://fb.me/xxx',
        source_type: 'ad',
        source_id: '238555000111222',
        headline: 'Promo junio',
        body: 'Agenda por WhatsApp',
        ctwa_clid: 'ctwa_real_123'
      }),
      'ctwa_real_123',
      '238555000111222',
      'https://fb.me/xxx',
      'ad',
      'Promo junio',
      'Agenda por WhatsApp',
      '2026-06-15T23:31:29.000Z',
      '2026-06-15T23:31:29.000Z'
    ])

    const repaired = await repairWhatsAppApiContactIdentityFromMessages({ limit: 100 })
    assert.ok(repaired.contacts >= 1)

    const contact = await db.get(`
      SELECT attribution_ad_id, attribution_ad_name, attribution_ctwa_clid,
             attribution_url, attribution_medium
      FROM contacts
      WHERE id = ?
    `, [contactId])

    assert.equal(contact.attribution_ad_id, '238555000111222')
    assert.equal(contact.attribution_ad_name, 'Promo junio')
    assert.equal(contact.attribution_ctwa_clid, 'ctwa_real_123')
    assert.equal(contact.attribution_url, 'https://fb.me/xxx')
    assert.equal(contact.attribution_medium, 'ad')
  } finally {
    await cleanup({ contactId, apiContactId, messageId, phone })
  }
})
