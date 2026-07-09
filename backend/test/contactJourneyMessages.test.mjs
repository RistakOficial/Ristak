import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getChatContacts, getContactJourney, updateContact } from '../src/controllers/contactsController.js'

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

async function readJourney(contactId, query = {}) {
  const res = createMockResponse()
  await getContactJourney({ params: { id: contactId }, query }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function readChatContacts(query = {}, user = {}) {
  const res = createMockResponse()
  await getChatContacts({ query, user }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function cleanup(contactId, phone, extraPhones = []) {
  const phones = [phone, ...extraPhones].filter(Boolean)
  await db.run('DELETE FROM video_playback_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM video_playback_sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  for (const phoneValue of phones) {
    await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR phone = ?', [contactId, phoneValue]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phoneValue]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ? OR phone = ?', [contactId, phoneValue]).catch(() => undefined)
  }
  await db.run('DELETE FROM appointment_confirmation_windows WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM chat_read_states WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

async function insertRow(table, values) {
  const columns = Object.keys(values)
  const placeholders = columns.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map(column => values[column])
  )
}

test('contact journey enriches WhatsApp messages that only carry rstkad_id marker text', async () => {
  const id = randomUUID()
  const contactId = `journey_rstkad_${id}`
  const phone = `+52991${Date.now().toString().slice(-7)}`
  const adId = `343${Date.now().toString().slice(-10)}`

  await cleanup(contactId, phone)
  await db.run('DELETE FROM meta_ads WHERE ad_id = ?', [adId]).catch(() => undefined)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente RSTKAD',
      first_name: 'Cliente',
      source: 'WhatsApp_API',
      created_at: '2099-07-04T12:00:00.000Z',
      updated_at: '2099-07-04T12:00:00.000Z'
    })
    await insertRow('meta_ads', {
      date: '2099-07-04',
      ad_account_id: `act_rstkad_${id}`,
      campaign_id: `camp_rstkad_${id}`,
      campaign_name: 'Campaña marcador RSTKAD',
      adset_id: `adset_rstkad_${id}`,
      adset_name: 'Conjunto marcador RSTKAD',
      ad_id: adId,
      ad_name: 'Anuncio marcador RSTKAD',
      creative_thumbnail_url: 'https://example.test/thumb.jpg',
      creative_preview_url: 'https://example.test/preview'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_rstkad_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: `Hola me gustaria saber costos rstkad_id=${adId}! mi cel termina en 7788`,
      message_timestamp: '2099-07-04T12:01:00.000Z',
      created_at: '2099-07-04T12:01:00.000Z'
    })

    const journey = await readJourney(contactId)
    const message = journey.find((event) => event.type === 'whatsapp_message')

    assert.ok(message)
    assert.equal(message.data.referral_source_id, adId)
    assert.equal(message.data.referral_source_type, 'ad')
    assert.equal(message.data.is_ad_attributed, true)
    assert.equal(message.data.attribution_ad_id, adId)
    assert.equal(message.data.campaign_name, 'Campaña marcador RSTKAD')
    assert.equal(message.data.adset_name, 'Conjunto marcador RSTKAD')
    assert.equal(message.data.attribution_ad_name, 'Anuncio marcador RSTKAD')
    assert.equal(message.data.creative_thumbnail_url, 'https://example.test/thumb.jpg')
    assert.equal(message.data.creative_preview_url, 'https://example.test/preview')
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_id = ?', [adId]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})

test('contact journey exposes every WhatsApp ad touch without decorating organic retouches', async () => {
  const id = randomUUID()
  const contactId = `journey_multi_ad_${id}`
  const phone = `+52990${Date.now().toString().slice(-7)}`
  const seed = Date.now().toString().slice(-10)
  const firstAdId = `781${seed}01`
  const secondAdId = `782${seed}02`

  await cleanup(contactId, phone)
  await db.run('DELETE FROM meta_ads WHERE ad_id IN (?, ?)', [firstAdId, secondAdId]).catch(() => undefined)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Retouch Ads',
      first_name: 'Cliente',
      source: 'WhatsApp_API',
      attribution_ad_id: firstAdId,
      created_at: '2099-05-01T12:00:00.000Z',
      updated_at: '2099-05-01T12:00:00.000Z'
    })
    await insertRow('meta_ads', {
      date: '2099-05-01',
      ad_account_id: `act_multi_${id}`,
      campaign_id: `camp_may_${id}`,
      campaign_name: 'Campaña mayo',
      adset_id: `adset_may_${id}`,
      adset_name: 'Conjunto mayo',
      ad_id: firstAdId,
      ad_name: 'Anuncio mayo',
      creative_thumbnail_url: 'https://example.test/may-thumb.jpg',
      creative_preview_url: 'https://example.test/may-preview'
    })
    await insertRow('meta_ads', {
      date: '2099-06-15',
      ad_account_id: `act_multi_${id}`,
      campaign_id: `camp_june_${id}`,
      campaign_name: 'Campaña junio',
      adset_id: `adset_june_${id}`,
      adset_name: 'Conjunto junio',
      ad_id: secondAdId,
      ad_name: 'Anuncio junio',
      creative_thumbnail_url: 'https://example.test/june-thumb.jpg',
      creative_preview_url: 'https://example.test/june-preview'
    })

    await insertRow('whatsapp_api_messages', {
      id: `api_multi_may_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: `Hola, vengo del anuncio de mayo rstkad_id=${firstAdId}!`,
      message_timestamp: '2099-05-01T12:01:00.000Z',
      created_at: '2099-05-01T12:01:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_multi_organic_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Hola otra vez, tengo una duda normal',
      message_timestamp: '2099-05-20T12:01:00.000Z',
      created_at: '2099-05-20T12:01:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_multi_june_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: `Hola, ahora vengo del anuncio de junio rstkad_id=${secondAdId}!`,
      message_timestamp: '2099-06-15T12:01:00.000Z',
      created_at: '2099-06-15T12:01:00.000Z'
    })

    const journey = await readJourney(contactId, { chatMessagesOnly: 'true' })
    const messages = journey.filter((event) => event.type === 'whatsapp_message')
    const mayMessage = messages.find((event) => String(event.data?.message_text || '').includes('mayo'))
    const organicMessage = messages.find((event) => String(event.data?.message_text || '').includes('duda normal'))
    const juneMessage = messages.find((event) => String(event.data?.message_text || '').includes('junio'))

    assert.ok(mayMessage)
    assert.ok(organicMessage)
    assert.ok(juneMessage)
    assert.equal(mayMessage.data.referral_source_id, firstAdId)
    assert.equal(mayMessage.data.attribution_ad_name, 'Anuncio mayo')
    assert.equal(mayMessage.data.creative_preview_url, 'https://example.test/may-preview')
    assert.equal(organicMessage.data.is_ad_attributed, false)
    assert.equal(organicMessage.data.referral_source_id || '', '')
    assert.equal(juneMessage.data.referral_source_id, secondAdId)
    assert.equal(juneMessage.data.attribution_ad_name, 'Anuncio junio')
    assert.equal(juneMessage.data.creative_preview_url, 'https://example.test/june-preview')
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_id IN (?, ?)', [firstAdId, secondAdId]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})

test('chat contacts caps oversized pages for safer inbox prefetch', async () => {
  const id = randomUUID().replace(/-/g, '')
  const prefix = `chat_page_${id}`
  const phoneSeed = Date.now().toString().slice(-6)

  try {
    for (let index = 0; index < 120; index += 1) {
      const contactId = `${prefix}_${index}`
      const phone = `+52998${phoneSeed}${String(index).padStart(3, '0')}`
      const minute = String(Math.floor(index / 60)).padStart(2, '0')
      const second = String(index % 60).padStart(2, '0')
      const timestamp = `2099-07-01T12:${minute}:${second}.000Z`

      await insertRow('contacts', {
        id: contactId,
        phone,
        full_name: `Cliente Paginado ${index}`,
        first_name: 'Cliente',
        source: 'manual',
        created_at: timestamp,
        updated_at: timestamp
      })

      await insertRow('whatsapp_api_messages', {
        id: `api_${contactId}`,
        contact_id: contactId,
        phone,
        from_phone: phone,
        to_phone: '+526561000000',
        business_phone: '+526561000000',
        transport: 'api',
        direction: 'inbound',
        message_type: 'text',
        message_text: `Mensaje paginado ${index}`,
        message_timestamp: timestamp,
        created_at: timestamp
      })
    }

    const firstPage = await readChatContacts({ limit: '110' })
    const firstPageSyntheticChats = firstPage.filter(chat => String(chat.id).startsWith(prefix))
    assert.equal(firstPageSyntheticChats.length, 100)

    const secondPage = await readChatContacts({ limit: '110', offset: '100' })
    const secondPageSyntheticChats = secondPage.filter(chat => String(chat.id).startsWith(prefix))
    assert.equal(secondPageSyntheticChats.length, 20)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('chat contacts returns persisted unread counts for requester', async () => {
  const id = randomUUID()
  const contactId = `chat_unread_${id}`
  const phone = `+52992${Date.now().toString().slice(-7)}`
  const username = `chat_unread_user_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Unread',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-07-02T12:00:00.000Z',
      updated_at: '2099-07-02T12:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_unread_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Mensaje pendiente real',
      message_timestamp: '2099-07-02T12:01:00.000Z',
      created_at: '2099-07-02T12:01:00.000Z'
    })
    await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, `${username}@example.test`, 'test_hash', 'Usuario Chat', 'admin', 1]
    )
    const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
    await insertRow('chat_read_states', {
      user_id: String(user.id),
      contact_id: contactId,
      unread_count: 4,
      last_unread_at: '2099-07-02T12:01:00.000Z'
    })

    const chats = await readChatContacts({ limit: '10' }, { userId: user.id })
    const chat = chats.find((item) => item.id === contactId)
    assert.ok(chat)
    assert.equal(chat.unreadCount, 4)
  } finally {
    await db.run('DELETE FROM chat_read_states WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE username = ?', [username]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})

test('chat contacts combines channel stats before loading selected messages', async () => {
  const id = randomUUID()
  const contactId = `chat_channel_stats_${id}`
  const phone = `+52994${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Multicanal',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-07-03T12:00:00.000Z',
      updated_at: '2099-07-03T12:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_channel_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'WhatsApp viejo',
      message_timestamp: '2099-07-03T12:01:00.000Z',
      created_at: '2099-07-03T12:01:00.000Z'
    })
    await insertRow('meta_social_messages', {
      id: `meta_channel_${id}`,
      platform: 'instagram',
      meta_message_id: `meta_channel_message_${id}`,
      contact_id: contactId,
      sender_id: 'ig_customer',
      recipient_id: 'ig_business',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'DM intermedio',
      message_timestamp: '2099-07-03T12:02:00.000Z',
      created_at: '2099-07-03T12:02:00.000Z'
    })
    await insertRow('email_messages', {
      id: `email_channel_${id}`,
      contact_id: contactId,
      from_email: `cliente_${id}@example.test`,
      to_email: 'negocio@example.test',
      direction: 'inbound',
      status: 'received',
      subject: 'Correo final',
      message_text: 'Respuesta reciente',
      message_timestamp: '2099-07-03T12:03:00.000Z',
      created_at: '2099-07-03T12:03:00.000Z',
      raw_payload_json: '{"provider":"highlevel"}'
    })

    const chats = await readChatContacts({ limit: '100' })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.messageCount, 3)
    assert.equal(chat.lastMessageText, 'Correo final · Respuesta reciente')
    assert.equal(chat.lastMessageChannel, 'email')
    assert.equal(chat.lastMessageTransport, 'ghl_email')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('meta comment messages keep readable deleted text when the source post is gone', async () => {
  const id = randomUUID().replace(/-/g, '')
  const facebookContactId = `meta_deleted_fb_${id}`
  const instagramContactId = `meta_deleted_ig_${id}`
  const facebookPhone = `+52995${Date.now().toString().slice(-7)}`
  const instagramPhone = `+52996${Date.now().toString().slice(-7)}`
  const facebookPostId = `fb_post_deleted_${id}`
  const instagramPostId = `ig_media_deleted_${id}`

  await cleanup(facebookContactId, facebookPhone)
  await cleanup(instagramContactId, instagramPhone)

  try {
    await insertRow('contacts', {
      id: facebookContactId,
      phone: facebookPhone,
      full_name: 'Cliente Comentario Facebook',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-07-03T12:00:00.000Z',
      updated_at: '2099-07-03T12:00:00.000Z'
    })
    await insertRow('contacts', {
      id: instagramContactId,
      phone: instagramPhone,
      full_name: 'Cliente Comentario Instagram',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-07-03T12:00:00.000Z',
      updated_at: '2099-07-03T12:00:00.000Z'
    })

    await insertRow('meta_social_posts', {
      id: facebookPostId,
      platform: 'messenger',
      post_type: 'deleted',
      message: '',
      image_url: '',
      permalink: '',
      raw_json: '{"unavailable":true}',
      fetched_at: '2099-07-03T12:01:00.000Z',
      updated_at: '2099-07-03T12:01:00.000Z'
    })
    await insertRow('meta_social_posts', {
      id: instagramPostId,
      platform: 'instagram',
      post_type: 'deleted',
      message: '',
      image_url: '',
      permalink: '',
      raw_json: '{"unavailable":true}',
      fetched_at: '2099-07-03T12:01:00.000Z',
      updated_at: '2099-07-03T12:01:00.000Z'
    })

    await insertRow('meta_social_messages', {
      id: `meta_deleted_comment_fb_${id}`,
      platform: 'messenger',
      meta_message_id: `fb_comment_${id}`,
      contact_id: facebookContactId,
      sender_id: 'fb_customer',
      recipient_id: 'fb_page',
      page_id: 'fb_page',
      direction: 'inbound',
      status: 'received',
      message_type: 'comment',
      message_text: '',
      post_id: facebookPostId,
      comment_id: `fb_comment_${id}`,
      message_timestamp: '2099-07-03T12:04:00.000Z',
      created_at: '2099-07-03T12:04:00.000Z'
    })
    await insertRow('meta_social_messages', {
      id: `meta_deleted_comment_ig_${id}`,
      platform: 'instagram',
      meta_message_id: `ig_comment_${id}`,
      contact_id: instagramContactId,
      sender_id: 'ig_customer',
      recipient_id: 'ig_business',
      instagram_account_id: 'ig_business',
      direction: 'inbound',
      status: 'received',
      message_type: 'comment',
      message_text: '',
      media_id: instagramPostId,
      comment_id: `ig_comment_${id}`,
      message_timestamp: '2099-07-03T12:05:00.000Z',
      created_at: '2099-07-03T12:05:00.000Z'
    })

    const facebookJourney = await readJourney(facebookContactId, { includeBusinessMessages: 'true' })
    const instagramJourney = await readJourney(instagramContactId, { includeBusinessMessages: 'true' })
    const facebookMessage = facebookJourney.find(event => event.type === 'meta_message')
    const instagramMessage = instagramJourney.find(event => event.type === 'meta_message')

    assert.ok(facebookMessage)
    assert.ok(instagramMessage)
    assert.equal(facebookMessage.data.source, 'Facebook')
    assert.equal(instagramMessage.data.source, 'Instagram')
    assert.equal(facebookMessage.data.message_text, 'Comentario eliminado')
    assert.equal(instagramMessage.data.message_text, 'Comentario eliminado')
    assert.equal(facebookMessage.data.post_message, 'Publicación eliminada')
    assert.equal(instagramMessage.data.post_message, 'Publicación eliminada')
    assert.equal(facebookMessage.data.post_deleted, 1)
    assert.equal(instagramMessage.data.post_deleted, 1)

    const chats = await readChatContacts({ limit: '100' })
    const facebookChat = chats.find(item => item.id === facebookContactId)
    const instagramChat = chats.find(item => item.id === instagramContactId)

    assert.ok(facebookChat)
    assert.ok(instagramChat)
    assert.equal(facebookChat.lastMessageText, 'Comentario eliminado')
    assert.equal(instagramChat.lastMessageText, 'Comentario eliminado')
  } finally {
    await db.run('DELETE FROM meta_social_posts WHERE id IN (?, ?)', [facebookPostId, instagramPostId]).catch(() => undefined)
    await cleanup(facebookContactId, facebookPhone)
    await cleanup(instagramContactId, instagramPhone)
  }
})

test('contact journey exposes provider for HighLevel mirrored meta messages', async () => {
  const id = randomUUID().replace(/-/g, '')
  const contactId = `journey_hl_meta_${id}`
  const phone = `+52997${Date.now().toString().slice(-7)}`
  const metaMessageId = `hl_meta_message_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente HighLevel Meta',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-07-03T12:00:00.000Z',
      updated_at: '2099-07-03T12:00:00.000Z'
    })

    await insertRow('meta_social_messages', {
      id: `meta_highlevel_${id}`,
      platform: 'messenger',
      meta_message_id: metaMessageId,
      contact_id: contactId,
      sender_id: 'fb_customer',
      recipient_id: 'fb_page',
      page_id: 'fb_page',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'DM sincronizado desde HighLevel',
      message_timestamp: '2099-07-03T12:06:00.000Z',
      created_at: '2099-07-03T12:06:00.000Z',
      raw_payload_json: '{"provider":"highlevel","source":"conversations_sync"}'
    })

    const journey = await readJourney(contactId)
    const message = journey.find(event => event.type === 'meta_message')

    assert.ok(message)
    assert.equal(message.data.provider, 'highlevel')
    assert.equal(message.data.provider_message_id, metaMessageId)
    assert.equal(message.data.transport, 'messenger')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey defaults to contact-authored messages only', async () => {
  const id = randomUUID()
  const contactId = `journey_msg_${id}`
  const phone = `+52991${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Journey',
      'Cliente',
      'manual',
      '2026-06-16T10:00:00.000Z',
      '2026-06-16T10:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_inbound_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'text',
      'Mensaje del contacto',
      '2026-06-16T10:01:00.000Z',
      '2026-06-16T10:01:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_outbound_${id}`,
      contactId,
      phone,
      '+526561000000',
      phone,
      '+526561000000',
      'api',
      'outbound',
      'text',
      'Mensaje del negocio',
      '2026-06-16T10:02:00.000Z',
      '2026-06-16T10:02:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_echo_${id}`,
      contactId,
      phone,
      '+526561000000',
      phone,
      '+526561000000',
      'api',
      'business_echo',
      'text',
      'Eco del negocio',
      '2026-06-16T10:03:00.000Z',
      '2026-06-16T10:03:00.000Z'
    ])

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, recipient_id,
        direction, status, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `meta_inbound_${id}`,
      'instagram',
      `meta_inbound_message_${id}`,
      contactId,
      'ig_customer',
      'ig_business',
      'inbound',
      'received',
      'text',
      'DM del contacto',
      '2026-06-16T10:04:00.000Z',
      '2026-06-16T10:04:00.000Z'
    ])

    await db.run(`
      INSERT INTO meta_social_messages (
        id, platform, meta_message_id, contact_id, sender_id, recipient_id,
        direction, status, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `meta_outbound_${id}`,
      'instagram',
      `meta_outbound_message_${id}`,
      contactId,
      'ig_business',
      'ig_customer',
      'outbound',
      'sent',
      'text',
      'DM del negocio',
      '2026-06-16T10:05:00.000Z',
      '2026-06-16T10:05:00.000Z'
    ])

    const journey = await readJourney(contactId)
    const messageEvents = journey.filter(event => event.type === 'whatsapp_message' || event.type === 'meta_message')

    assert.deepEqual(
      messageEvents.map(event => `${event.type}:${event.data.direction}:${event.data.message_text}`),
      [
        'whatsapp_message:inbound:Mensaje del contacto',
        'meta_message:inbound:DM del contacto'
      ]
    )

    const fullConversationJourney = await readJourney(contactId, { includeBusinessMessages: 'true' })
    const fullConversationMessages = fullConversationJourney
      .filter(event => event.type === 'whatsapp_message' || event.type === 'meta_message')

    assert.deepEqual(
      fullConversationMessages.map(event => `${event.type}:${event.data.direction}:${event.data.message_text}`),
      [
        'whatsapp_message:inbound:Mensaje del contacto',
        'whatsapp_message:outbound:Mensaje del negocio',
        'whatsapp_message:business_echo:Eco del negocio',
        'meta_message:inbound:DM del contacto',
        'meta_message:outbound:DM del negocio'
      ]
    )
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey messageLimit returns the most recent chat messages in chronological order', async () => {
  const id = randomUUID()
  const contactId = `journey_recent_${id}`
  const phone = `+52992${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con mucho historial',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-17T09:00:00.000Z',
      updated_at: '2026-06-17T09:00:00.000Z'
    })

    for (let index = 0; index < 10; index += 1) {
      const timestamp = `2026-06-17T10:${String(index).padStart(2, '0')}:00.000Z`
      await insertRow('whatsapp_api_messages', {
        id: `api_recent_${id}_${index}`,
        contact_id: contactId,
        phone,
        from_phone: index % 2 === 0 ? phone : '+526561000000',
        to_phone: index % 2 === 0 ? '+526561000000' : phone,
        business_phone: '+526561000000',
        transport: 'api',
        direction: index % 2 === 0 ? 'inbound' : 'outbound',
        message_type: 'text',
        message_text: `Mensaje ${index}`,
        message_timestamp: timestamp,
        created_at: timestamp
      })
    }

    const fullJourney = await readJourney(contactId, { includeBusinessMessages: 'true' })
    const fullMessages = fullJourney.filter(event => event.type === 'whatsapp_message')
    assert.equal(fullMessages.length, 10)

    const limitedJourney = await readJourney(contactId, {
      includeBusinessMessages: 'true',
      messageLimit: '3'
    })
    const limitedMessages = limitedJourney.filter(event => event.type === 'whatsapp_message')

    assert.deepEqual(
      limitedMessages.map(event => event.data.message_text),
      ['Mensaje 7', 'Mensaje 8', 'Mensaje 9']
    )
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat-only journey applies messageLimit globally and pages older messages with beforeMessageDate', async () => {
  const id = randomUUID()
  const contactId = `journey_global_page_${id}`
  const phone = `+52993${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con historial mezclado',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-18T09:00:00.000Z',
      updated_at: '2026-06-18T09:00:00.000Z'
    })

    for (let index = 0; index < 12; index += 1) {
      const timestamp = `2026-06-18T10:${String(index).padStart(2, '0')}:00.000Z`
      if (index % 2 === 0) {
        await insertRow('whatsapp_api_messages', {
          id: `api_global_page_${id}_${index}`,
          contact_id: contactId,
          phone,
          from_phone: phone,
          to_phone: '+526561000000',
          business_phone: '+526561000000',
          transport: 'api',
          direction: 'inbound',
          message_type: 'text',
          message_text: `Global ${index}`,
          message_timestamp: timestamp,
          created_at: timestamp
        })
      } else {
        await insertRow('meta_social_messages', {
          id: `meta_global_page_${id}_${index}`,
          platform: 'instagram',
          meta_message_id: `meta_global_page_message_${id}_${index}`,
          contact_id: contactId,
          sender_id: 'ig_customer',
          recipient_id: 'ig_business',
          direction: 'inbound',
          status: 'received',
          message_type: 'text',
          message_text: `Global ${index}`,
          message_timestamp: timestamp,
          created_at: timestamp
        })
      }
    }

    const firstPage = await readJourney(contactId, {
      includeBusinessMessages: 'true',
      chatMessagesOnly: 'true',
      messageLimit: '5'
    })
    assert.deepEqual(
      firstPage.map(event => event.data.message_text),
      ['Global 7', 'Global 8', 'Global 9', 'Global 10', 'Global 11']
    )

    const olderPage = await readJourney(contactId, {
      includeBusinessMessages: 'true',
      chatMessagesOnly: 'true',
      messageLimit: '5',
      beforeMessageDate: firstPage[0].date
    })
    assert.deepEqual(
      olderPage.map(event => event.data.message_text),
      ['Global 2', 'Global 3', 'Global 4', 'Global 5', 'Global 6']
    )
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat-only journey includes appointment confirmation cards without full contact journey events', async () => {
  const id = randomUUID()
  const contactId = `journey_chat_confirmation_${id}`
  const appointmentId = `appointment_chat_confirmation_${id}`
  const phone = `+52994${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con confirmacion',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-19T09:00:00.000Z',
      updated_at: '2026-06-19T09:00:00.000Z'
    })
    await insertRow('appointments', {
      id: appointmentId,
      calendar_id: `calendar_chat_confirmation_${id}`,
      contact_id: contactId,
      title: 'Consulta inicial',
      status: 'confirmed',
      appointment_status: 'confirmed',
      start_time: '2026-06-20T16:00:00.000Z',
      end_time: '2026-06-20T17:00:00.000Z',
      date_added: '2026-06-19T09:30:00.000Z',
      date_updated: '2026-06-19T09:30:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_chat_confirmation_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Si confirmo mi cita',
      message_timestamp: '2026-06-19T10:00:00.000Z',
      created_at: '2026-06-19T10:00:00.000Z'
    })
    await insertRow('appointment_confirmation_windows', {
      id: `window_chat_confirmation_${id}`,
      contact_id: contactId,
      appointment_id: appointmentId,
      reminder_send_id: `send_chat_confirmation_${id}`,
      status: 'done',
      accumulated_messages: JSON.stringify(['Si confirmo mi cita']),
      bypass_automations: 0,
      confirmation_success_action: 'chat_card',
      last_message_at: '2026-06-19T10:00:00.000Z',
      result: 'confirmed',
      result_detail: 'Confirmo asistencia',
      processed_at: '2026-06-19T10:02:00.000Z',
      created_at: '2026-06-19T10:01:00.000Z',
      updated_at: '2026-06-19T10:02:00.000Z'
    })

    const journey = await readJourney(contactId, {
      includeBusinessMessages: 'true',
      chatMessagesOnly: 'true'
    })

    assert.deepEqual(journey.map(event => event.type), ['whatsapp_message', 'appointment_confirmation'])
    assert.equal(journey[1].data.appointment_id, appointmentId)
    assert.equal(journey[1].data.result_detail, 'Confirmo asistencia')

    const olderJourney = await readJourney(contactId, {
      includeBusinessMessages: 'true',
      chatMessagesOnly: 'true',
      beforeMessageDate: '2026-06-19T10:02:00.000Z'
    })

    assert.deepEqual(olderJourney.map(event => event.type), ['whatsapp_message'])
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat and journey include WhatsApp messages from secondary contact phones', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const contactId = `journey_multi_phone_${id}`
  const primaryPhone = `+521550${suffix}`
  const secondaryPhone = `+521551${suffix}`

  await cleanup(contactId, primaryPhone, [secondaryPhone])

  try {
    await insertRow('contacts', {
      id: contactId,
      phone: primaryPhone,
      full_name: 'Cliente Dos Numeros',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-06-16T10:00:00.000Z',
      updated_at: '2099-06-16T10:00:00.000Z'
    })

    await insertRow('contact_phone_numbers', {
      id: `contact_phone_primary_${id}`,
      contact_id: contactId,
      phone: primaryPhone,
      label: 'Principal',
      is_primary: 1,
      source: 'test',
      created_at: '2099-06-16T10:00:00.000Z',
      updated_at: '2099-06-16T10:00:00.000Z'
    })

    await insertRow('contact_phone_numbers', {
      id: `contact_phone_secondary_${id}`,
      contact_id: contactId,
      phone: secondaryPhone,
      label: 'Adicional',
      is_primary: 0,
      source: 'whatsapp_api',
      created_at: '2099-06-16T10:01:00.000Z',
      updated_at: '2099-06-16T10:01:00.000Z'
    })

    await insertRow('whatsapp_api_messages', {
      id: `api_secondary_${id}`,
      contact_id: null,
      phone: secondaryPhone,
      from_phone: secondaryPhone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Mensaje desde segundo numero',
      message_timestamp: '2099-06-16T10:02:00.000Z',
      created_at: '2099-06-16T10:02:00.000Z'
    })

    const chats = await readChatContacts()
    const chat = chats.find(contact => contact.id === contactId)
    assert.ok(chat, 'chat list should resolve the secondary phone message to the existing contact')
    assert.equal(chat.lastMessageText, 'Mensaje desde segundo numero')
    assert.deepEqual(
      chat.phones.map(entry => entry.phone),
      [primaryPhone, secondaryPhone]
    )

    const journey = await readJourney(contactId, { includeBusinessMessages: 'true' })
    assert.ok(
      journey.some(event => event.type === 'whatsapp_message' && event.data.phone === secondaryPhone),
      'journey should include WhatsApp messages matched by secondary phone'
    )
  } finally {
    await cleanup(contactId, primaryPhone, [secondaryPhone])
  }
})

test('updating contact phone promotes a secondary number to primary', async () => {
  const id = randomUUID()
  const suffix = Date.now().toString().slice(-7)
  const contactId = `journey_primary_phone_${id}`
  const primaryPhone = `+52656${suffix}`
  const secondaryPhone = `+52657${suffix}`

  await cleanup(contactId, primaryPhone, [secondaryPhone])

  try {
    await insertRow('contacts', {
      id: contactId,
      phone: primaryPhone,
      full_name: 'Cliente Principal',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-06-16T10:00:00.000Z',
      updated_at: '2099-06-16T10:00:00.000Z'
    })

    await insertRow('contact_phone_numbers', {
      id: `contact_phone_primary_${id}`,
      contact_id: contactId,
      phone: primaryPhone,
      label: 'Principal',
      is_primary: 1,
      source: 'test',
      created_at: '2099-06-16T10:00:00.000Z',
      updated_at: '2099-06-16T10:00:00.000Z'
    })

    await insertRow('contact_phone_numbers', {
      id: `contact_phone_secondary_${id}`,
      contact_id: contactId,
      phone: secondaryPhone,
      label: 'Adicional',
      is_primary: 0,
      source: 'whatsapp_api',
      created_at: '2099-06-16T10:01:00.000Z',
      updated_at: '2099-06-16T10:01:00.000Z'
    })

    const res = createMockResponse()
    await updateContact({ params: { id: contactId }, body: { phone: secondaryPhone } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.phone, secondaryPhone)
    assert.deepEqual(
      res.body.data.phones.map(phone => ({ phone: phone.phone, isPrimary: phone.isPrimary, label: phone.label })),
      [
        { phone: secondaryPhone, isPrimary: true, label: 'Principal' },
        { phone: primaryPhone, isPrimary: false, label: 'Adicional' }
      ]
    )

    const rows = await db.all(
      'SELECT phone, is_primary, label FROM contact_phone_numbers WHERE contact_id = ? ORDER BY is_primary DESC, phone ASC',
      [contactId]
    )
    assert.deepEqual(
      rows.map(row => ({ phone: row.phone, isPrimary: Boolean(row.is_primary), label: row.label })),
      [
        { phone: secondaryPhone, isPrimary: true, label: 'Principal' },
        { phone: primaryPhone, isPrimary: false, label: 'Adicional' }
      ]
    )
  } finally {
    await cleanup(contactId, primaryPhone, [secondaryPhone])
  }
})

test('contact journey exposes playable WhatsApp audio media from raw payload', async () => {
  const id = randomUUID()
  const contactId = `journey_audio_${id}`
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const audioUrl = `https://cdn.ristak.test/audio/${id}.ogg`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Audio',
      'Cliente',
      'manual',
      '2026-06-16T10:10:00.000Z',
      '2026-06-16T10:10:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at,
        raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_audio_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'audio',
      '>AUDIO< [Received on Ristak]',
      '2026-06-16T10:11:00.000Z',
      '2026-06-16T10:11:00.000Z',
      JSON.stringify({
        type: 'audio',
        audio: {
          id: `media_${id}`,
          downloadUrl: audioUrl,
          mimeType: 'audio/ogg',
          fileName: 'nota-de-voz.ogg',
          durationMs: 12400
        }
      })
    ])

    const journey = await readJourney(contactId)
    const audioEvent = journey.find(event => event.type === 'whatsapp_message' && event.data.message_type === 'audio')

    assert.ok(audioEvent)
    assert.equal(audioEvent.data.media_url, audioUrl)
    assert.equal(audioEvent.data.media_id, `media_${id}`)
    assert.equal(audioEvent.data.media_mime_type, 'audio/ogg')
    assert.equal(audioEvent.data.media_filename, 'nota-de-voz.ogg')
    assert.equal(audioEvent.data.media_duration_ms, 12400)
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey exposes image and video media from raw payload', async () => {
  const id = randomUUID()
  const contactId = `journey_visual_media_${id}`
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const imageUrl = `https://cdn.ristak.test/images/${id}.jpg`
  const videoUrl = `https://cdn.ristak.test/videos/${id}.mp4`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Multimedia',
      'Cliente',
      'manual',
      '2026-06-16T10:20:00.000Z',
      '2026-06-16T10:20:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at,
        raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_image_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'image',
      '>IMAGE< [Received on Ristak]',
      '2026-06-16T10:21:00.000Z',
      '2026-06-16T10:21:00.000Z',
      JSON.stringify({
        type: 'image',
        image: {
          mediaId: `image_${id}`,
          publicUrl: imageUrl,
          contentType: 'image/jpeg',
          name: 'foto-del-cliente.jpg'
        }
      })
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at,
        raw_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_video_${id}`,
      contactId,
      phone,
      phone,
      '+526561000000',
      '+526561000000',
      'api',
      'inbound',
      'video',
      '>VIDEO< [Received on Ristak]',
      '2026-06-16T10:22:00.000Z',
      '2026-06-16T10:22:00.000Z',
      JSON.stringify({
        type: 'video',
        video: {
          media_id: `video_${id}`,
          fileUrl: videoUrl,
          mime_type: 'video/mp4',
          filename: 'video-del-cliente.mp4'
        }
      })
    ])

    const journey = await readJourney(contactId)
    const imageEvent = journey.find(event => event.type === 'whatsapp_message' && event.data.message_type === 'image')
    const videoEvent = journey.find(event => event.type === 'whatsapp_message' && event.data.message_type === 'video')

    assert.ok(imageEvent)
    assert.equal(imageEvent.data.media_url, imageUrl)
    assert.equal(imageEvent.data.media_id, `image_${id}`)
    assert.equal(imageEvent.data.media_mime_type, 'image/jpeg')
    assert.equal(imageEvent.data.media_filename, 'foto-del-cliente.jpg')

    assert.ok(videoEvent)
    assert.equal(videoEvent.data.media_url, videoUrl)
    assert.equal(videoEvent.data.media_id, `video_${id}`)
    assert.equal(videoEvent.data.media_mime_type, 'video/mp4')
    assert.equal(videoEvent.data.media_filename, 'video-del-cliente.mp4')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey annotates page visits with matched video playback', async () => {
  const id = randomUUID()
  const contactId = `journey_video_${id}`
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const visitorId = `visitor_${id}`
  const sessionId = `session_${id}`
  const playbackId = `playback_${id}`
  const orphanPlaybackId = `orphan_playback_${id}`

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, first_name, source, visitor_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      `video-${id}@ristak.test`,
      'Cliente Video',
      'Cliente',
      'native_site',
      visitorId,
      '2026-06-16T12:00:00.000Z',
      '2026-06-16T12:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, full_name, email, event_name,
        started_at, created_at, page_url, referrer_url, tracking_source,
        site_id, site_name, public_page_id, public_page_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `session_row_${id}`,
      sessionId,
      visitorId,
      contactId,
      'Cliente Video',
      `video-${id}@ristak.test`,
      'page_view',
      '2026-06-16T12:01:00.000Z',
      '2026-06-16T12:01:00.000Z',
      'https://demo.ristak.test/landing?utm_source=instagram',
      'https://instagram.com/',
      'native_site',
      `site_${id}`,
      'Sitio Demo',
      `page_${id}`,
      'Landing Demo'
    ])

    await db.run(`
      INSERT INTO video_playback_sessions (
        id, playback_id, visitor_id, session_id, contact_id, full_name, email,
        media_asset_id, stream_video_id, video_provider, video_title,
        tracking_source, site_id, site_name, public_page_id, public_page_title,
        block_id, block_label, page_url, duration_seconds, max_position_seconds,
        last_position_seconds, watched_seconds, max_progress_percent, play_count,
        ended, match_method, first_event_at, started_at, last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `video_session_${id}`,
      playbackId,
      visitorId,
      sessionId,
      contactId,
      'Cliente Video',
      `video-${id}@ristak.test`,
      `asset_${id}`,
      `stream_${id}`,
      'bunny_stream',
      'Video de Oferta',
      'native_site_video',
      `site_${id}`,
      'Sitio Demo',
      `page_${id}`,
      'Landing Demo',
      `block_${id}`,
      'Sección principal',
      'https://demo.ristak.test/landing?utm_source=instagram&rstk_play_id=temp',
      120,
      90,
      90,
      84,
      75,
      1,
      0,
      'direct_contact_id',
      '2026-06-16T12:01:15.000Z',
      '2026-06-16T12:01:15.000Z',
      '2026-06-16T12:03:00.000Z'
    ])

    await db.run(`
      INSERT INTO video_playback_events (
        id, event_id, playback_id, visitor_id, session_id, contact_id, event_name,
        media_asset_id, stream_video_id, video_provider, site_id, public_page_id,
        block_id, page_url, position_seconds, duration_seconds, progress_percent,
        watched_delta_seconds, event_at
      ) VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `video_event_start_${id}`,
      `video_event_start_id_${id}`,
      playbackId,
      visitorId,
      sessionId,
      contactId,
      'video_play',
      `asset_${id}`,
      `stream_${id}`,
      'bunny_stream',
      `site_${id}`,
      `page_${id}`,
      `block_${id}`,
      'https://demo.ristak.test/landing?utm_source=instagram',
      0,
      120,
      0,
      0,
      '2026-06-16T12:01:15.000Z',
      `video_event_progress_${id}`,
      `video_event_progress_id_${id}`,
      playbackId,
      visitorId,
      sessionId,
      contactId,
      'video_progress',
      `asset_${id}`,
      `stream_${id}`,
      'bunny_stream',
      `site_${id}`,
      `page_${id}`,
      `block_${id}`,
      'https://demo.ristak.test/landing?utm_source=instagram',
      90,
      120,
      75,
      30,
      '2026-06-16T12:03:00.000Z'
    ])

    await db.run(`
      INSERT INTO video_playback_sessions (
        id, playback_id, visitor_id, session_id, contact_id, full_name, email,
        media_asset_id, stream_video_id, video_provider, video_title,
        tracking_source, page_url, duration_seconds, max_position_seconds,
        watched_seconds, max_progress_percent, play_count, ended, match_method,
        first_event_at, started_at, last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `orphan_video_session_${id}`,
      orphanPlaybackId,
      visitorId,
      `orphan_session_${id}`,
      contactId,
      'Cliente Video',
      `video-${id}@ristak.test`,
      `orphan_asset_${id}`,
      `orphan_stream_${id}`,
      'bunny_stream',
      'Video sin visita exacta',
      'native_site_video',
      'https://demo.ristak.test/otra-pagina',
      60,
      18,
      18,
      30,
      1,
      0,
      'direct_contact_id',
      '2026-06-16T12:05:00.000Z',
      '2026-06-16T12:05:00.000Z',
      '2026-06-16T12:05:30.000Z'
    ])

    const journey = await readJourney(contactId)
    const pageVisit = journey.find(event => event.type === 'page_visit')
    const standaloneVideo = journey.find(event => event.type === 'video_playback')

    assert.ok(pageVisit)
    assert.equal(pageVisit.data.video_engagements?.length, 1)
    assert.equal(pageVisit.data.video_engagements[0].playback_id, playbackId)
    assert.equal(pageVisit.data.video_engagements[0].video_title, 'Video de Oferta')
    assert.equal(pageVisit.data.video_engagements[0].max_progress_percent, 75)
    assert.equal(pageVisit.data.video_engagements[0].end_position_seconds, 90)

    assert.ok(standaloneVideo)
    assert.equal(standaloneVideo.data.playback_id, orphanPlaybackId)
    assert.equal(standaloneVideo.data.standalone, true)
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey summarizes tracking rows into one page visit per session', async () => {
  const id = randomUUID()
  const contactId = `journey_session_summary_${id}`
  const phone = `+52997${Date.now().toString().slice(-7)}`
  const visitorId = `visitor_summary_${id}`
  const sessionId = `session_summary_${id}`
  const nextSessionId = `session_summary_next_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      email: `summary-${id}@ristak.test`,
      full_name: 'Cliente Sesión Resumida',
      first_name: 'Cliente',
      source: 'native_site',
      visitor_id: visitorId,
      created_at: '2026-06-16T10:10:00.000Z',
      updated_at: '2026-06-16T10:10:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_summary_start_${id}`,
      session_id: sessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Sesión Resumida',
      email: `summary-${id}@ristak.test`,
      event_name: 'session_start',
      started_at: '2026-06-16T10:00:00.000Z',
      created_at: '2026-06-16T10:00:00.000Z',
      page_url: 'https://demo.ristak.test/landing?utm_source=facebook',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      campaign_id: `campaign_${id}`,
      campaign_name: 'Campaña Demo',
      adset_id: `adset_${id}`,
      adset_name: 'Audiencia Demo',
      ad_id: `ad_${id}`,
      ad_name: 'Anuncio Demo',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_name: 'Sitio Demo',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Demo'
    })

    await insertRow('sessions', {
      id: `session_summary_page_${id}`,
      session_id: sessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Sesión Resumida',
      email: `summary-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-16T10:03:00.000Z',
      created_at: '2026-06-16T10:03:00.000Z',
      page_url: 'https://demo.ristak.test/landing/detalle?utm_source=facebook',
      referrer_url: 'https://demo.ristak.test/landing?utm_source=facebook',
      utm_source: 'facebook',
      utm_medium: 'paid',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_name: 'Sitio Demo',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Demo'
    })

    await insertRow('sessions', {
      id: `session_summary_conversion_${id}`,
      session_id: sessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Sesión Resumida',
      email: `summary-${id}@ristak.test`,
      event_name: 'native_site_conversion',
      started_at: '2026-06-16T10:05:00.000Z',
      created_at: '2026-06-16T10:05:00.000Z',
      page_url: 'https://demo.ristak.test/landing#form',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      campaign_id: `campaign_${id}`,
      campaign_name: 'Campaña Demo',
      adset_id: `adset_${id}`,
      adset_name: 'Audiencia Demo',
      ad_id: `ad_${id}`,
      ad_name: 'Anuncio Demo',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_name: 'Sitio Demo',
      form_site_id: `form_${id}`,
      form_site_name: 'Formulario Demo',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Demo',
      conversion_type: 'form_submit',
      submission_id: `submission_${id}`,
      match_method: 'direct_contact_id',
      match_confidence: 100,
      identity_evidence_json: JSON.stringify({ directContact: true })
    })

    await insertRow('sessions', {
      id: `session_summary_end_${id}`,
      session_id: sessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Sesión Resumida',
      email: `summary-${id}@ristak.test`,
      event_name: 'session_end',
      started_at: '2026-06-16T10:06:00.000Z',
      created_at: '2026-06-16T10:06:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_summary_next_${id}`,
      session_id: nextSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Sesión Resumida',
      email: `summary-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-17T11:00:00.000Z',
      created_at: '2026-06-17T11:00:00.000Z',
      page_url: 'https://demo.ristak.test/gracias',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_name: 'Sitio Demo'
    })

    const journey = await readJourney(contactId)
    const pageVisits = journey.filter(event => event.type === 'page_visit')
    const summaryVisit = pageVisits.find(event => event.data.session_id === sessionId)

    assert.equal(pageVisits.length, 2)
    assert.ok(summaryVisit)
    assert.equal(summaryVisit.date, '2026-06-16T10:00:00.000Z')
    assert.equal(summaryVisit.data.session_event_count, 4)
    assert.equal(summaryVisit.data.session_page_view_count, 2)
    assert.equal(summaryVisit.data.session_conversion_count, 1)
    assert.equal(summaryVisit.data.pages_visited, 3)
    assert.equal(summaryVisit.data.session_duration_seconds, 360)
    assert.equal(summaryVisit.data.first_page_url, 'https://demo.ristak.test/landing?utm_source=facebook')
    assert.equal(summaryVisit.data.last_page_url, 'https://demo.ristak.test/landing#form')
    assert.equal(summaryVisit.data.form_site_id, `form_${id}`)
    assert.equal(summaryVisit.data.submission_id, `submission_${id}`)
    assert.equal(summaryVisit.data.match_method, 'direct_contact_id')
    assert.equal(summaryVisit.data.match_confidence, 100)
    assert.deepEqual(summaryVisit.data.event_names, ['session_start', 'page_view', 'native_site_conversion', 'session_end'])
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey rolls same-day visits into one visible web summary', async () => {
  const id = randomUUID()
  const contactId = `journey_visible_visit_${id}`
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const visitorId = `visitor_visible_${id}`
  const firstSessionId = `session_visible_first_${id}`
  const secondSessionId = `session_visible_second_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      email: `visible-${id}@ristak.test`,
      full_name: 'Cliente Visita Visible',
      first_name: 'Cliente',
      source: 'native_site',
      visitor_id: visitorId,
      created_at: '2026-06-16T11:00:00.000Z',
      updated_at: '2026-06-16T11:00:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_visible_first_page_${id}`,
      session_id: firstSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Visita Visible',
      email: `visible-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-16T10:00:00.000Z',
      created_at: '2026-06-16T10:00:00.000Z',
      page_url: 'https://demo.ristak.test/landing',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      campaign_id: `campaign_visible_${id}`,
      campaign_name: 'Campaña Visible',
      ad_id: `ad_visible_${id}`,
      ad_name: 'Anuncio Visible',
      tracking_source: 'native_site',
      site_id: `site_visible_${id}`,
      site_name: 'Sitio Visible',
      public_page_id: `page_visible_${id}`,
      public_page_title: 'Landing Visible'
    })

    await insertRow('sessions', {
      id: `session_visible_first_end_${id}`,
      session_id: firstSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Visita Visible',
      email: `visible-${id}@ristak.test`,
      event_name: 'session_end',
      started_at: '2026-06-16T10:05:00.000Z',
      created_at: '2026-06-16T10:05:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_visible_second_page_${id}`,
      session_id: secondSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Visita Visible',
      email: `visible-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-16T10:15:00.000Z',
      created_at: '2026-06-16T10:15:00.000Z',
      page_url: 'https://demo.ristak.test/landing',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      tracking_source: 'native_site',
      site_id: `site_visible_${id}`,
      site_name: 'Sitio Visible',
      public_page_id: `page_visible_${id}`,
      public_page_title: 'Landing Visible'
    })

    const journey = await readJourney(contactId)
    const pageVisits = journey.filter(event => event.type === 'page_visit')

    assert.equal(pageVisits.length, 1)
    assert.equal(pageVisits[0].date, '2026-06-16T10:00:00.000Z')
    assert.equal(pageVisits[0].data.session_event_count, 3)
    assert.equal(pageVisits[0].data.session_page_view_count, 2)
    assert.equal(pageVisits[0].data.pages_visited, 1)
    assert.equal(pageVisits[0].data.session_duration_seconds, 900)
    assert.equal(pageVisits[0].data.visible_session_count, 2)
    assert.deepEqual(pageVisits[0].data.session_ids, [firstSessionId, secondSessionId])
    assert.deepEqual(pageVisits[0].data.event_names, ['page_view', 'session_end'])
    assert.equal(pageVisits[0].data.first_page_url, 'https://demo.ristak.test/landing')
    assert.equal(pageVisits[0].data.last_page_url, 'https://demo.ristak.test/landing')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey suppresses inflated metrics from ad-like visitor ids', async () => {
  const id = randomUUID()
  const contactId = `journey_ad_like_visitor_${id}`
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const adLikeVisitorId = '120241691100910604'
  const firstSessionId = `session_ad_like_first_${id}`
  const secondSessionId = `session_ad_like_second_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      email: `ad-like-${id}@ristak.test`,
      full_name: 'Cliente Visitor Compartido',
      first_name: 'Cliente',
      source: 'native_site',
      visitor_id: adLikeVisitorId,
      attribution_ad_id: adLikeVisitorId,
      created_at: '2026-06-22T18:00:00.000Z',
      updated_at: '2026-06-22T18:00:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_ad_like_first_page_${id}`,
      session_id: firstSessionId,
      visitor_id: adLikeVisitorId,
      contact_id: contactId,
      full_name: 'Cliente Visitor Compartido',
      email: `ad-like-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-22T18:19:00.000Z',
      created_at: '2026-06-22T18:19:00.000Z',
      page_url: `https://raulgomez.com.mx/quiero-pacientes?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}&utm_source=facebook`,
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      ad_id: adLikeVisitorId,
      ad_name: 'Video Error',
      tracking_source: 'native_site',
      site_id: `site_ad_like_${id}`,
      site_name: 'Raúl Gómez',
      public_page_id: `page_ad_like_${id}`,
      public_page_title: 'Quiero Pacientes'
    })

    await insertRow('sessions', {
      id: `session_ad_like_second_page_${id}`,
      session_id: secondSessionId,
      visitor_id: adLikeVisitorId,
      contact_id: contactId,
      full_name: 'Cliente Visitor Compartido',
      email: `ad-like-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-22T23:40:00.000Z',
      created_at: '2026-06-22T23:40:00.000Z',
      page_url: `https://raulgomez.com.mx/quiero-pacientes?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}&utm_source=facebook`,
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      ad_id: adLikeVisitorId,
      tracking_source: 'native_site',
      site_id: `site_ad_like_${id}`,
      site_name: 'Raúl Gómez',
      public_page_id: `page_ad_like_${id}`,
      public_page_title: 'Quiero Pacientes'
    })

    const journey = await readJourney(contactId)
    const pageVisits = journey.filter(event => event.type === 'page_visit')

    assert.equal(pageVisits.length, 1)
    assert.equal(pageVisits[0].data.tracking_identity_untrusted, true)
    assert.equal(pageVisits[0].data.identity_warning, 'shared_ad_like_visitor_id')
    assert.equal(pageVisits[0].data.session_event_count, 0)
    assert.equal(pageVisits[0].data.session_page_view_count, 0)
    assert.equal(pageVisits[0].data.pages_visited, 0)
    assert.equal(pageVisits[0].data.session_duration_seconds, 0)
    assert.equal(pageVisits[0].data.visible_session_count, 0)
    assert.deepEqual(pageVisits[0].data.visitor_ids, [adLikeVisitorId])
    assert.equal(pageVisits[0].data.first_page_url, `https://raulgomez.com.mx/quiero-pacientes?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}&utm_source=facebook`)
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact journey exposes pre-registration tracking attribution and match evidence', async () => {
  const id = randomUUID()
  const contactId = `journey_pre_registration_${id}`
  const phone = `+52996${Date.now().toString().slice(-7)}`
  const visitorId = `visitor_pre_${id}`
  const preSessionId = `session_pre_${id}`
  const conversionSessionId = `session_conversion_${id}`
  const playbackId = `playback_pre_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      email: `pre-${id}@ristak.test`,
      full_name: 'Cliente Pre Registro',
      first_name: 'Cliente',
      source: 'native_site',
      visitor_id: visitorId,
      created_at: '2026-06-16T10:00:00.000Z',
      updated_at: '2026-06-16T10:00:00.000Z'
    })

    await insertRow('sessions', {
      id: `session_row_pre_${id}`,
      session_id: preSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Pre Registro',
      email: `pre-${id}@ristak.test`,
      event_name: 'page_view',
      started_at: '2026-06-16T09:15:00.000Z',
      created_at: '2026-06-16T09:15:00.000Z',
      page_url: 'https://demo.ristak.test/landing?utm_source=facebook&utm_medium=paid&utm_campaign=pre_launch&utm_content=video_ad&utm_term=curso',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      utm_campaign: 'pre_launch',
      utm_term: 'curso',
      utm_content: 'video_ad',
      gclid: `gclid_${id}`,
      fbclid: `fbclid_${id}`,
      fbc: `fb.1.${Date.now()}.${id}`,
      fbp: `fb.1.${Date.now()}.browser`,
      ttclid: `ttclid_${id}`,
      channel: 'paid_social',
      source_platform: 'facebook',
      campaign_id: `campaign_${id}`,
      adset_id: `adset_${id}`,
      ad_group_id: `group_${id}`,
      ad_id: `ad_${id}`,
      campaign_name: 'Pre Launch',
      adset_name: 'Audiencia Caliente',
      ad_group_name: 'Grupo Principal',
      ad_name: 'Video Hook 01',
      placement: 'facebook_feed',
      site_source_name: 'facebook',
      network: 'meta',
      match_type: 'broad',
      keyword: 'curso marketing',
      search_query: 'como vender mas',
      creative_id: `creative_${id}`,
      ad_position: 'feed',
      device_type: 'mobile',
      os: 'iOS 18',
      browser: 'Facebook In-App Browser',
      browser_version: '520',
      language: 'es-MX',
      timezone: 'America/Mexico_City',
      geo_country: 'MX',
      geo_region: 'Chihuahua',
      geo_city: 'Juarez',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_slug: 'landing-pre',
      site_name: 'Landing Pre Registro',
      site_type: 'landing',
      form_site_id: `form_${id}`,
      form_site_name: 'Formulario Lead',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Principal',
      match_method: 'related_identity_source',
      match_confidence: 90,
      identity_evidence_json: JSON.stringify({
        deviceSignals: 12,
        hasNetwork: true,
        hasBrowser: true,
        sourceKeys: ['utm_campaign', 'site_id', 'fbclid'],
        clickIdKeys: ['gclid', 'fbclid', 'ttclid'],
        sourceMatches: 3,
        strongSourceMatches: 2
      })
    })

    await insertRow('sessions', {
      id: `session_row_conversion_${id}`,
      session_id: conversionSessionId,
      visitor_id: visitorId,
      contact_id: contactId,
      full_name: 'Cliente Pre Registro',
      email: `pre-${id}@ristak.test`,
      event_name: 'native_site_conversion',
      started_at: '2026-06-16T10:00:00.000Z',
      created_at: '2026-06-16T10:00:00.000Z',
      page_url: 'https://demo.ristak.test/landing#form',
      referrer_url: 'https://facebook.com/ads/click',
      utm_source: 'facebook',
      utm_medium: 'paid',
      utm_campaign: 'pre_launch',
      utm_content: 'form_submit',
      gclid: `gclid_${id}`,
      fbclid: `fbclid_${id}`,
      source_platform: 'facebook',
      campaign_id: `campaign_${id}`,
      adset_id: `adset_${id}`,
      ad_id: `ad_${id}`,
      campaign_name: 'Pre Launch',
      adset_name: 'Audiencia Caliente',
      ad_name: 'Formulario Final',
      tracking_source: 'native_site',
      site_id: `site_${id}`,
      site_name: 'Landing Pre Registro',
      form_site_id: `form_${id}`,
      form_site_name: 'Formulario Lead',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Principal',
      conversion_type: 'form_submit',
      submission_id: `submission_${id}`,
      match_method: 'direct_contact_id',
      match_confidence: 100,
      identity_evidence_json: JSON.stringify({ directContact: true, clickIdKeys: ['gclid', 'fbclid'] })
    })

    await insertRow('video_playback_sessions', {
      id: `video_session_pre_${id}`,
      playback_id: playbackId,
      visitor_id: visitorId,
      session_id: preSessionId,
      contact_id: contactId,
      full_name: 'Cliente Pre Registro',
      email: `pre-${id}@ristak.test`,
      media_asset_id: `asset_${id}`,
      stream_video_id: `stream_${id}`,
      video_provider: 'bunny_stream',
      video_title: 'Video Antes del Registro',
      tracking_source: 'native_site_video',
      site_id: `site_${id}`,
      site_name: 'Landing Pre Registro',
      public_page_id: `page_${id}`,
      public_page_title: 'Landing Principal',
      block_id: `block_${id}`,
      block_label: 'Video de oferta',
      page_url: 'https://demo.ristak.test/landing?utm_source=facebook',
      duration_seconds: 180,
      max_position_seconds: 126,
      watched_seconds: 120,
      max_progress_percent: 70,
      play_count: 1,
      ended: 0,
      match_method: 'related_identity_source',
      match_confidence: 90,
      identity_evidence_json: JSON.stringify({ deviceSignals: 12, sourceKeys: ['site_id'] }),
      first_event_at: '2026-06-16T09:16:00.000Z',
      started_at: '2026-06-16T09:16:00.000Z',
      last_event_at: '2026-06-16T09:18:00.000Z'
    })

    const journey = await readJourney(contactId)
    const preVisit = journey.find(event => event.type === 'page_visit' && event.data.session_id === preSessionId)
    const conversion = journey.find(event => event.type === 'contact_created')

    assert.ok(preVisit)
    assert.equal(preVisit.data.is_pre_registration, true)
    assert.equal(preVisit.data.minutes_before_contact, 45)
    assert.equal(preVisit.data.visitor_id, visitorId)
    assert.equal(preVisit.data.utm_term, 'curso')
    assert.equal(preVisit.data.gclid, `gclid_${id}`)
    assert.equal(preVisit.data.ttclid, `ttclid_${id}`)
    assert.equal(preVisit.data.campaign_id, `campaign_${id}`)
    assert.equal(preVisit.data.ad_group_name, 'Grupo Principal')
    assert.equal(preVisit.data.keyword, 'curso marketing')
    assert.equal(preVisit.data.search_query, 'como vender mas')
    assert.equal(preVisit.data.browser_version, '520')
    assert.equal(preVisit.data.match_method, 'related_identity_source')
    assert.equal(preVisit.data.match_confidence, 90)
    assert.equal(preVisit.data.identity_evidence.deviceSignals, 12)
    assert.deepEqual(preVisit.data.identity_evidence.clickIdKeys, ['gclid', 'fbclid', 'ttclid'])
    assert.equal(preVisit.data.identity_hash, undefined)
    assert.equal(preVisit.data.device_signature, undefined)
    assert.equal(preVisit.data.network_signature, undefined)
    assert.equal(preVisit.data.ip, undefined)

    assert.equal(preVisit.data.video_engagements?.length, 1)
    assert.equal(preVisit.data.video_engagements[0].playback_id, playbackId)
    assert.equal(preVisit.data.video_engagements[0].is_pre_registration, true)
    assert.equal(preVisit.data.video_engagements[0].match_confidence, 90)

    assert.ok(conversion)
    assert.equal(conversion.data.conversion_channel, 'web')
    assert.equal(conversion.data.submission_id, `submission_${id}`)
    assert.equal(conversion.data.campaign_id, `campaign_${id}`)
    assert.equal(conversion.data.gclid, `gclid_${id}`)
    assert.equal(conversion.data.match_method, 'direct_contact_id')
    assert.equal(conversion.data.match_confidence, 100)
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat history includes WhatsApp messages matched by phone when contact_id is missing', async () => {
  const id = randomUUID()
  const contactId = `journey_phone_match_${id}`
  const phone = `+52992${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'

  await cleanup(contactId, phone)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, full_name, first_name, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      phone,
      'Cliente Phone Match',
      'Cliente',
      'manual',
      '2026-06-16T11:00:00.000Z',
      '2026-06-16T11:00:00.000Z'
    ])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, contact_id, phone, from_phone, to_phone, business_phone, transport,
        direction, message_type, message_text, message_timestamp, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `api_phone_only_${id}`,
      phone,
      phone,
      businessPhone,
      businessPhone,
      'api',
      'inbound',
      'text',
      'Mensaje entrante sin contacto enlazado',
      '2026-06-16T11:01:00.000Z',
      '2026-06-16T11:01:00.000Z'
    ])

    const journey = await readJourney(contactId, { includeBusinessMessages: 'true' })
    const whatsappMessages = journey.filter(event => event.type === 'whatsapp_message')

    assert.deepEqual(
      whatsappMessages.map(event => `${event.data.direction}:${event.data.message_text}`),
      ['inbound:Mensaje entrante sin contacto enlazado']
    )

    const chats = await readChatContacts({ limit: '100' })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.messageCount, 1)
    assert.equal(chat.lastMessageText, 'Mensaje entrante sin contacto enlazado')
    assert.equal(chat.lastMessageDirection, 'inbound')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('chat contacts phone filter includes API and QR records for the same business number', async () => {
  const id = randomUUID()
  const contactId = `chat_phone_filter_${id}`
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000000'
  const apiPhoneNumberId = `wa_api_${id}`
  const qrPhoneNumberId = `wa_qr_${id}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Filtro QR API',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-19T12:00:00.000Z',
      updated_at: '2026-06-19T12:00:00.000Z'
    })

    await insertRow('whatsapp_api_phone_numbers', {
      id: apiPhoneNumberId,
      provider: 'ycloud',
      phone_number: businessPhone,
      display_phone_number: businessPhone,
      verified_name: 'API',
      status: 'CONNECTED',
      api_send_enabled: 1,
      qr_send_enabled: 1,
      qr_status: 'connected',
      qr_connected_phone: businessPhone,
      updated_at: '2026-06-19T12:00:00.000Z'
    })

    await insertRow('whatsapp_api_phone_numbers', {
      id: qrPhoneNumberId,
      provider: 'qr',
      phone_number: businessPhone,
      display_phone_number: '+52 1 656 100 0000',
      verified_name: 'QR',
      status: 'QR_ONLY',
      api_send_enabled: 0,
      qr_send_enabled: 1,
      qr_status: 'connected',
      qr_connected_phone: '+5216561000000',
      updated_at: '2026-06-19T12:00:00.000Z'
    })

    await insertRow('whatsapp_api_messages', {
      id: `api_filtered_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: businessPhone,
      business_phone: businessPhone,
      business_phone_number_id: apiPhoneNumberId,
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Mensaje visible desde filtro QR',
      message_timestamp: '2026-06-19T12:01:00.000Z',
      created_at: '2026-06-19T12:01:00.000Z'
    })

    const chats = await readChatContacts({
      businessPhoneNumberId: qrPhoneNumberId,
      businessPhone: '+52 1 656 100 0000',
      limit: '100'
    })
    const chat = chats.find(item => item.id === contactId)

    assert.ok(chat)
    assert.equal(chat.lastMessageText, 'Mensaje visible desde filtro QR')
    assert.equal(chat.lastBusinessPhoneNumberId, apiPhoneNumberId)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [apiPhoneNumberId, qrPhoneNumberId]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})
