import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { databaseDialect, db } from '../src/config/database.js'
import { runChatActivityProjectionBackfill } from '../src/services/chatActivityProjectionService.js'
import {
  getChatContacts,
  getContactConversation,
  getContactJourney,
  createContactConversationAbortScope,
  setContactConversationDeadlineMsForTest,
  setProfilePictureWarmupRunnerForTest,
  updateContact,
  waitForProfilePictureWarmupsForTest
} from '../src/controllers/contactsController.js'

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  for (const migration of [
    '095za_chat_activity_whatsapp_version.sqlite.sql',
    '095zb_chat_activity_meta_version.sqlite.sql',
    '095zc_chat_activity_email_version.sqlite.sql',
    '096_chat_activity_projection.sqlite.sql',
    '121_chat_conversation_cursor.sqlite.sql'
  ]) {
    await db.exec(await readFile(
      new URL(`../migrations/versioned/${migration}`, import.meta.url),
      'utf8'
    ))
  }
  await runChatActivityProjectionBackfill()
})

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    jsonCalls: 0,
    headersSent: false,
    writableEnded: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      this.headersSent = true
      this.jsonCalls += 1
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

async function readConversation(contactId, query = {}) {
  const res = createMockResponse()
  await getContactConversation({ params: { id: contactId }, query }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function readChatContacts(query = {}, user = {}) {
  // Los writes de identidad/message son síncronos, pero una reasignación puede
  // dejar trabajo deliberadamente en la cola incremental. La app lo procesa en
  // background; el fixture espera esa misma convergencia antes de afirmar datos.
  await runChatActivityProjectionBackfill()
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
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
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

test('contact conversation abort scope distinguishes deadline from client disconnect', async () => {
  const deadlineResponse = new EventEmitter()
  deadlineResponse.writableEnded = false
  const deadlineScope = createContactConversationAbortScope(deadlineResponse, { timeoutMs: 5 })
  try {
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(deadlineScope.signal.aborted, true)
    assert.equal(deadlineScope.reason, 'deadline')
  } finally {
    deadlineScope.cleanup()
  }

  const disconnectedResponse = new EventEmitter()
  disconnectedResponse.writableEnded = false
  const disconnectedScope = createContactConversationAbortScope(disconnectedResponse, { timeoutMs: 1000 })
  try {
    disconnectedResponse.emit('close')
    assert.equal(disconnectedScope.signal.aborted, true)
    assert.equal(disconnectedScope.reason, 'disconnect')
  } finally {
    disconnectedScope.cleanup()
  }
})

test('contact conversation deadline reaches the database signal and answers once', async () => {
  const originalGet = db.get
  let observedSignal = null
  db.get = function interceptedGet(sql, params, options) {
    if (String(sql).includes('FROM chat_activity_projection_state')) {
      observedSignal = options?.signal || null
      return new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error('cancelled query')
          error.name = 'AbortError'
          reject(error)
        }
        if (observedSignal?.aborted) abort()
        else observedSignal?.addEventListener('abort', abort, { once: true })
      })
    }
    return originalGet.call(db, sql, params, options)
  }
  setContactConversationDeadlineMsForTest(5)
  const res = createMockResponse()
  const keepEventLoopAlive = setInterval(() => undefined, 1000)

  try {
    await getContactConversation({ params: { id: `timeout_${randomUUID()}` }, query: {} }, res)
    assert.ok(observedSignal)
    assert.equal(observedSignal.aborted, true)
    assert.equal(res.statusCode, 504)
    assert.equal(res.body?.code, 'CHAT_CONVERSATION_TIMEOUT')
    assert.equal(res.jsonCalls, 1)
  } finally {
    clearInterval(keepEventLoopAlive)
    db.get = originalGet
    setContactConversationDeadlineMsForTest()
  }
})

test('contact conversation ready projection selects globally then hydrates only winning message ids', async () => {
  const id = randomUUID()
  const contactId = `conversation_projection_ready_${id}`
  const phone = `+52811${Date.now().toString().slice(-7)}`
  const olderMessageId = `api_projection_older_${id}`
  const newestMessageId = `api_projection_newest_${id}`
  const originalAll = db.all
  const calls = []

  await cleanup(contactId, phone)
  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente proyeccion lista',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2098-01-01T10:00:00.000Z',
      updated_at: '2098-01-01T10:00:00.000Z'
    })
    for (const [messageId, text, timestamp] of [
      [olderMessageId, 'Mensaje viejo no hidratado', '2098-01-01T10:01:00.000Z'],
      [newestMessageId, 'Mensaje nuevo hidratado', '2098-01-01T10:02:00.000Z']
    ]) {
      await insertRow('whatsapp_api_messages', {
        id: messageId,
        contact_id: contactId,
        phone,
        from_phone: phone,
        to_phone: '+526561000000',
        business_phone: '+526561000000',
        transport: 'api',
        direction: 'inbound',
        message_type: 'text',
        message_text: text,
        message_timestamp: timestamp,
        created_at: timestamp
      })
    }
    await runChatActivityProjectionBackfill()

    db.all = function interceptedAll(sql, params, options) {
      calls.push({ sql: String(sql), params: [...(params || [])], options })
      return originalAll.call(db, sql, params, options)
    }
    const conversation = await readConversation(contactId, { messageLimit: '1' })

    assert.deepEqual(conversation.map(event => event.data.message_text), ['Mensaje nuevo hidratado'])
    const selection = calls.find(call => call.sql.includes('FROM chat_message_activity'))
    assert.ok(selection)
    const selectionPlan = await originalAll.call(
      db,
      `EXPLAIN QUERY PLAN ${selection.sql}`,
      selection.params
    )
    assert.ok(selectionPlan.some(row => (
      String(row.detail || '').includes('idx_chat_message_activity_conversation_cursor')
    )))
    const hydration = calls.find(call => call.sql.includes('recent_whatsapp_api_messages'))
    assert.ok(hydration)
    assert.match(hydration.sql, /WHERE msg\.id IN \(\?\)/)
    assert.ok(hydration.params.includes(newestMessageId))
    assert.equal(hydration.params.includes(olderMessageId), false)
    assert.ok(hydration.options?.signal)
  } finally {
    db.all = originalAll
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('contact conversation falls back to legacy phone matching while projection is not ready', async () => {
  const id = randomUUID()
  const contactId = `conversation_projection_fallback_${id}`
  const phone = `+52812${Date.now().toString().slice(-7)}`
  const messageId = `api_projection_fallback_${id}`
  const originalAll = db.all
  const calls = []

  await cleanup(contactId, phone)
  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente fallback legacy',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2098-01-02T10:00:00.000Z',
      updated_at: '2098-01-02T10:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: messageId,
      contact_id: null,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Mensaje recuperado por telefono',
      message_timestamp: '2098-01-02T10:01:00.000Z',
      created_at: '2098-01-02T10:01:00.000Z'
    })
    await db.run("UPDATE chat_activity_projection_state SET status = 'dirty' WHERE singleton_id = 1")
    await db.run('DELETE FROM chat_message_activity WHERE source_kind = ? AND source_message_id = ?', ['whatsapp', messageId])

    db.all = function interceptedAll(sql, params, options) {
      calls.push({ sql: String(sql), params: [...(params || [])], options })
      return originalAll.call(db, sql, params, options)
    }
    const conversation = await readConversation(contactId)

    assert.ok(conversation.some(event => event.data.message_text === 'Mensaje recuperado por telefono'))
    assert.equal(calls.some(call => call.sql.includes('FROM chat_message_activity')), false)
    const hydration = calls.find(call => call.sql.includes('recent_whatsapp_api_messages'))
    assert.ok(hydration)
    assert.equal(hydration.sql.includes('WHERE msg.id IN ('), false)
    assert.ok(hydration.params.includes(phone))
    assert.ok(hydration.options?.signal)
  } finally {
    db.all = originalAll
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('contact conversation collapses HighLevel WhatsApp and SMS mirror rows', async () => {
  const id = randomUUID().replace(/-/g, '')
  const contactId = `conversation_ghl_mirror_${id}`
  const phone = `+52814${Date.now().toString().slice(-7)}`
  const whatsappInboundId = `ghl_wa_in_${id}`
  const whatsappOutboundId = `ghl_wa_out_${id}`

  await cleanup(contactId, phone)
  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente espejo HighLevel',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2098-01-02T11:00:00.000Z',
      updated_at: '2098-01-02T11:00:00.000Z'
    })
    for (const message of [
      {
        id: `ghl_sms_in_${id}`,
        transport: 'ghl_sms',
        direction: 'inbound',
        text: 'Quiero reagendar\n\n📱 [Received on Raúl Gómez (5218123802444)]',
        timestamp: '2098-01-02T11:01:00.000Z'
      },
      {
        id: whatsappInboundId,
        transport: 'ghl_whatsapp',
        direction: 'inbound',
        text: 'Quiero reagendar',
        timestamp: '2098-01-02T11:01:01.000Z'
      },
      {
        id: whatsappOutboundId,
        transport: 'ghl_whatsapp',
        direction: 'outbound',
        text: 'Claro, te ayudo',
        timestamp: '2098-01-02T11:02:00.000Z'
      },
      {
        id: `ghl_sms_out_${id}`,
        transport: 'ghl_sms',
        direction: 'outbound',
        text: 'Claro, te ayudo\n\n🔁 Sent from another device (5218123802444 ) 🔁',
        timestamp: '2098-01-02T11:02:02.000Z'
      }
    ]) {
      await insertRow('whatsapp_api_messages', {
        id: message.id,
        contact_id: contactId,
        phone,
        from_phone: message.direction === 'inbound' ? phone : '+526561000000',
        to_phone: message.direction === 'inbound' ? '+526561000000' : phone,
        business_phone: '+526561000000',
        transport: message.transport,
        direction: message.direction,
        message_type: 'text',
        message_text: message.text,
        status: message.direction === 'inbound' ? 'received' : 'sent',
        message_timestamp: message.timestamp,
        created_at: message.timestamp
      })
    }
    await runChatActivityProjectionBackfill()

    const conversation = await readConversation(contactId)
    const messages = conversation.filter(event => event.type === 'whatsapp_message')

    assert.deepEqual(messages.map(event => event.data.whatsapp_api_message_id), [
      whatsappInboundId,
      whatsappOutboundId
    ])
    assert.deepEqual(messages.map(event => event.data.message_text), [
      'Quiero reagendar',
      'Claro, te ayudo'
    ])
    assert.deepEqual(messages.map(event => event.data.transport), [
      'ghl_whatsapp',
      'ghl_whatsapp'
    ])
  } finally {
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('contact conversation preserves legacy WhatsApp attribution beside projected messages', async () => {
  const id = randomUUID()
  const contactId = `conversation_projection_aux_${id}`
  const phone = `+52813${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)
  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con rama auxiliar',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2098-01-03T10:00:00.000Z',
      updated_at: '2098-01-03T10:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_projection_aux_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Mensaje proyectado',
      message_timestamp: '2098-01-03T10:01:00.000Z',
      created_at: '2098-01-03T10:01:00.000Z'
    })
    await insertRow('whatsapp_attribution', {
      contact_id: contactId,
      phone,
      message_content: 'Mensaje auxiliar de atribucion',
      referral_source_type: 'ad',
      referral_source_id: `ad_${id}`,
      created_at: '2098-01-03T10:02:00.000Z'
    })
    await runChatActivityProjectionBackfill()

    const conversation = await readConversation(contactId, { messageLimit: '5' })
    assert.deepEqual(
      conversation.map(event => event.data.message_text),
      ['Mensaje proyectado', 'Mensaje auxiliar de atribucion']
    )
    assert.ok(conversation.some(event => event.cursorKey.startsWith('whatsapp_api:')))
    assert.ok(conversation.some(event => event.cursorKey.startsWith('whatsapp_attribution:')))
  } finally {
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('contact conversation includes linked social history resolved by one identity join', async () => {
  const id = randomUUID()
  const contactId = `conversation_social_main_${id}`
  const linkedContactId = `conversation_social_linked_${id}`
  const phone = `+52814${Date.now().toString().slice(-7)}`
  const linkedPhone = `+52815${Date.now().toString().slice(-7)}`
  const metaUserId = `ig_user_${id}`
  const mainIdentityId = `meta_identity_main_${id}`
  const linkedIdentityId = `meta_identity_linked_${id}`

  await cleanup(contactId, phone)
  await cleanup(linkedContactId, linkedPhone)
  try {
    for (const [rowId, rowPhone, name] of [
      [contactId, phone, 'Cliente social principal'],
      [linkedContactId, linkedPhone, 'Cliente social enlazado']
    ]) {
      await insertRow('contacts', {
        id: rowId,
        phone: rowPhone,
        full_name: name,
        first_name: 'Cliente',
        source: 'Meta',
        created_at: '2098-01-04T10:00:00.000Z',
        updated_at: '2098-01-04T10:00:00.000Z'
      })
    }
    await insertRow('meta_social_contacts', {
      id: mainIdentityId,
      contact_id: contactId,
      platform: 'instagram',
      sender_id: `ig_sender_main_${id}`,
      meta_user_id: metaUserId,
      profile_name: 'Perfil principal'
    })
    await insertRow('meta_social_contacts', {
      id: linkedIdentityId,
      contact_id: linkedContactId,
      platform: 'instagram',
      sender_id: `ig_sender_linked_${id}`,
      meta_user_id: metaUserId,
      profile_name: 'Perfil enlazado'
    })
    await insertRow('meta_social_messages', {
      id: `meta_linked_message_${id}`,
      platform: 'instagram',
      meta_message_id: `meta_provider_linked_${id}`,
      meta_social_contact_id: linkedIdentityId,
      contact_id: linkedContactId,
      sender_id: `ig_sender_linked_${id}`,
      recipient_id: 'ig_business',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'Mensaje del contacto social enlazado',
      message_timestamp: '2098-01-04T10:01:00.000Z',
      created_at: '2098-01-04T10:01:00.000Z'
    })
    await runChatActivityProjectionBackfill()

    const conversation = await readConversation(contactId)
    const linkedMessage = conversation.find(event => event.data.message_text === 'Mensaje del contacto social enlazado')
    assert.ok(linkedMessage)
    assert.equal(linkedMessage.data.profile_name, 'Perfil enlazado')
  } finally {
    await db.run('DELETE FROM meta_social_messages WHERE contact_id IN (?, ?)', [contactId, linkedContactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_contacts WHERE id IN (?, ?)', [mainIdentityId, linkedIdentityId]).catch(() => undefined)
    await cleanup(contactId, phone)
    await cleanup(linkedContactId, linkedPhone)
    await runChatActivityProjectionBackfill()
  }
})

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
      message_text: `Hola me gustaria saber costos (rstkad_id=${adId}!) mi cel termina en 7788`,
      message_timestamp: '2099-07-04T12:01:00.000Z',
      created_at: '2099-07-04T12:01:00.000Z'
    })

    const journey = await readJourney(contactId)
    const message = journey.find((event) => event.type === 'whatsapp_message')

    assert.ok(message)
    assert.equal(message.data.message_text, 'Hola me gustaria saber costos mi cel termina en 7788')
    assert.equal(message.data.referral_source_id, adId)
    assert.equal(message.data.referral_source_type, 'ad')
    assert.equal(message.data.is_ad_attributed, true)
    assert.equal(message.data.attribution_ad_id, adId)
    assert.equal(message.data.ad_account_id, `act_rstkad_${id}`)
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

test('contact conversation does not mark ordinary WhatsApp API metadata as ad attribution', async () => {
  const id = randomUUID()
  const contactId = `journey_organic_api_${id}`
  const phone = `+52989${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente WhatsApp API Orgánico',
      first_name: 'Cliente',
      source: 'WhatsApp_API',
      created_at: '2099-07-05T12:00:00.000Z',
      updated_at: '2099-07-05T12:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_organic_metadata_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Hola',
      detected_source_app: 'api',
      detected_entry_point: 'api',
      detected_headline: 'Hola',
      detected_body: 'Hola',
      message_timestamp: '2099-07-05T12:01:00.000Z',
      created_at: '2099-07-05T12:01:00.000Z'
    })

    const journey = await readConversation(contactId)
    const message = journey.find((event) => event.type === 'whatsapp_message')

    assert.ok(message)
    assert.equal(message.data.message_text, 'Hola')
    assert.equal(message.data.referral_source_app, 'api')
    assert.equal(message.data.referral_headline, 'Hola')
    assert.equal(message.data.is_ad_attributed, false)
    assert.equal(message.data.referral_source_id || '', '')
    assert.equal(message.data.referral_ctwa_clid || '', '')
    assert.equal(message.data.referral_source_type || '', '')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact conversation exposes every WhatsApp ad touch without decorating organic retouches', async () => {
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

    const journey = await readConversation(contactId)
    const messages = journey.filter((event) => event.type === 'whatsapp_message')
    const mayMessage = messages.find((event) => String(event.data?.message_text || '').includes('mayo'))
    const organicMessage = messages.find((event) => String(event.data?.message_text || '').includes('duda normal'))
    const juneMessage = messages.find((event) => String(event.data?.message_text || '').includes('junio'))

    assert.ok(mayMessage)
    assert.ok(organicMessage)
    assert.ok(juneMessage)
    assert.equal(mayMessage.data.referral_source_id, firstAdId)
    assert.equal(mayMessage.data.ad_account_id, `act_multi_${id}`)
    assert.equal(mayMessage.data.attribution_ad_name, 'Anuncio mayo')
    assert.equal(mayMessage.data.creative_preview_url, 'https://example.test/may-preview')
    assert.equal(organicMessage.data.is_ad_attributed, false)
    assert.equal(organicMessage.data.referral_source_id || '', '')
    assert.equal(juneMessage.data.referral_source_id, secondAdId)
    assert.equal(juneMessage.data.ad_account_id, `act_multi_${id}`)
    assert.equal(juneMessage.data.attribution_ad_name, 'Anuncio junio')
    assert.equal(juneMessage.data.creative_preview_url, 'https://example.test/june-preview')
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_id IN (?, ?)', [firstAdId, secondAdId]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})

test('contact conversation exposes WhatsApp ad preview media stored inside referral_json', async () => {
  const id = randomUUID()
  const contactId = `journey_whatsapp_preview_${id}`
  const phone = `+52988${Date.now().toString().slice(-7)}`
  const adId = `783${Date.now().toString().slice(-10)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Preview WhatsApp',
      first_name: 'Cliente',
      source: 'WhatsApp_API',
      created_at: '2099-06-20T12:00:00.000Z',
      updated_at: '2099-06-20T12:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_preview_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Hola, quiero información',
      detected_source_id: adId,
      detected_source_type: 'ad',
      detected_headline: 'Anuncio con imagen oficial',
      referral_json: JSON.stringify({
        source_id: adId,
        source_type: 'ad',
        image_url: 'https://ristak-media-cdn.b-cdn.net/accounts/test/chat/ad-preview.jpg',
        thumbnail_url: 'https://ristak-media-cdn.b-cdn.net/accounts/test/chat/ad-thumb.jpg'
      }),
      message_timestamp: '2099-06-20T12:01:00.000Z',
      created_at: '2099-06-20T12:01:00.000Z'
    })

    const journey = await readConversation(contactId)
    const message = journey.find((event) => event.type === 'whatsapp_message')

    assert.ok(message)
    assert.equal(message.data.is_ad_attributed, true)
    assert.equal(message.data.referral_source_id, adId)
    assert.equal(message.data.referral_image_url, 'https://ristak-media-cdn.b-cdn.net/accounts/test/chat/ad-preview.jpg')
    assert.equal(message.data.referral_thumbnail_url, 'https://ristak-media-cdn.b-cdn.net/accounts/test/chat/ad-thumb.jpg')
  } finally {
    await cleanup(contactId, phone)
  }
})

test('contact conversation exposes Messenger and Instagram ad touches for chat previews', async () => {
  const id = randomUUID()
  const contactId = `journey_social_ads_${id}`
  const phone = `+52989${Date.now().toString().slice(-7)}`
  const seed = Date.now().toString().slice(-10)
  const messengerAdId = `881${seed}01`
  const instagramAdId = `882${seed}02`

  await cleanup(contactId, phone)
  await db.run('DELETE FROM meta_ads WHERE ad_id IN (?, ?)', [messengerAdId, instagramAdId]).catch(() => undefined)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Social Ads',
      first_name: 'Cliente',
      source: 'Messenger',
      created_at: '2099-08-01T12:00:00.000Z',
      updated_at: '2099-08-01T12:00:00.000Z'
    })
    await insertRow('meta_ads', {
      date: '2099-08-01',
      ad_account_id: `act_social_${id}`,
      campaign_id: `camp_msg_${id}`,
      campaign_name: 'Campaña Messenger',
      adset_id: `adset_msg_${id}`,
      adset_name: 'Conjunto Messenger',
      ad_id: messengerAdId,
      ad_name: 'Anuncio Messenger',
      creative_thumbnail_url: 'https://example.test/messenger-thumb.jpg',
      creative_preview_url: 'https://example.test/messenger-preview'
    })
    await insertRow('meta_ads', {
      date: '2099-08-02',
      ad_account_id: `act_social_${id}`,
      campaign_id: `camp_ig_${id}`,
      campaign_name: 'Campaña Instagram',
      adset_id: `adset_ig_${id}`,
      adset_name: 'Conjunto Instagram',
      ad_id: instagramAdId,
      ad_name: 'Anuncio Instagram',
      creative_thumbnail_url: 'https://example.test/instagram-thumb.jpg',
      creative_preview_url: 'https://example.test/instagram-preview'
    })
    await insertRow('meta_social_messages', {
      id: `meta_msg_ad_${id}`,
      platform: 'messenger',
      meta_message_id: `mid_msg_ad_${id}`,
      contact_id: contactId,
      sender_id: `psid_${id}`,
      recipient_id: 'page_social_ads',
      page_id: 'page_social_ads',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'Hola por Messenger',
      message_timestamp: '2099-08-01T12:01:00.000Z',
      created_at: '2099-08-01T12:01:00.000Z',
      referral_json: JSON.stringify({
        source: 'ADS',
        type: 'OPEN_THREAD',
        ad_id: messengerAdId,
        ads_context_data: {
          ad_title: 'Headline Messenger',
          post_body: 'Body Messenger',
          ad_url: 'https://example.test/messenger-ad',
          photo_url: 'https://example.test/messenger-referral-photo.jpg',
          video_url: 'https://example.test/messenger-referral-video-thumb.jpg'
        }
      }),
      raw_payload_json: '{}'
    })
    await insertRow('meta_social_messages', {
      id: `meta_organic_${id}`,
      platform: 'messenger',
      meta_message_id: `mid_organic_${id}`,
      contact_id: contactId,
      sender_id: `psid_${id}`,
      recipient_id: 'page_social_ads',
      page_id: 'page_social_ads',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'Mensaje orgánico de Messenger',
      message_timestamp: '2099-08-01T12:05:00.000Z',
      created_at: '2099-08-01T12:05:00.000Z',
      raw_payload_json: '{}'
    })
    await insertRow('meta_social_messages', {
      id: `meta_ig_ad_${id}`,
      platform: 'instagram',
      meta_message_id: `mid_ig_ad_${id}`,
      contact_id: contactId,
      sender_id: `igsid_${id}`,
      recipient_id: 'ig_business_social_ads',
      instagram_account_id: 'ig_business_social_ads',
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'Hola por Instagram',
      message_timestamp: '2099-08-02T12:01:00.000Z',
      created_at: '2099-08-02T12:01:00.000Z',
      referral_json: JSON.stringify({
        source: 'ADS',
        type: 'OPEN_THREAD',
        ad_id: instagramAdId,
        ads_context_data: {
          ad_title: 'Headline Instagram',
          post_body: 'Body Instagram',
          ad_url: 'https://example.test/instagram-ad',
          video_url: 'https://example.test/instagram-referral-video-thumb.jpg'
        }
      }),
      raw_payload_json: '{}'
    })

    const journey = await readConversation(contactId)
    const messages = journey.filter((event) => event.type === 'meta_message')
    const messengerMessage = messages.find((event) => event.data?.meta_message_id === `mid_msg_ad_${id}`)
    const organicMessage = messages.find((event) => event.data?.meta_message_id === `mid_organic_${id}`)
    const instagramMessage = messages.find((event) => event.data?.meta_message_id === `mid_ig_ad_${id}`)

    assert.ok(messengerMessage)
    assert.ok(organicMessage)
    assert.ok(instagramMessage)
    assert.equal(messengerMessage.data.is_ad_attributed, true)
    assert.equal(messengerMessage.data.ad_platform, 'Messenger')
    assert.equal(messengerMessage.data.referral_source_id, messengerAdId)
    assert.equal(messengerMessage.data.ad_account_id, `act_social_${id}`)
    assert.equal(messengerMessage.data.referral_source_url, 'https://example.test/messenger-ad')
    assert.equal(messengerMessage.data.referral_headline, 'Headline Messenger')
    assert.equal(messengerMessage.data.referral_body, 'Body Messenger')
    assert.equal(messengerMessage.data.referral_image_url, 'https://example.test/messenger-referral-photo.jpg')
    assert.equal(messengerMessage.data.referral_video_url, 'https://example.test/messenger-referral-video-thumb.jpg')
    assert.equal(messengerMessage.data.referral_thumbnail_url, 'https://example.test/messenger-referral-photo.jpg')
    assert.equal(messengerMessage.data.attribution_ad_name, 'Anuncio Messenger')
    assert.equal(messengerMessage.data.creative_preview_url, 'https://example.test/messenger-preview')
    assert.equal(Boolean(organicMessage.data.is_ad_attributed), false)
    assert.equal(organicMessage.data.referral_source_id || '', '')
    assert.equal(instagramMessage.data.is_ad_attributed, true)
    assert.equal(instagramMessage.data.ad_platform, 'Instagram')
    assert.equal(instagramMessage.data.referral_source_id, instagramAdId)
    assert.equal(instagramMessage.data.ad_account_id, `act_social_${id}`)
    assert.equal(instagramMessage.data.referral_source_url, 'https://example.test/instagram-ad')
    assert.equal(instagramMessage.data.referral_headline, 'Headline Instagram')
    assert.equal(instagramMessage.data.referral_body, 'Body Instagram')
    assert.equal(instagramMessage.data.referral_video_url, 'https://example.test/instagram-referral-video-thumb.jpg')
    assert.equal(instagramMessage.data.referral_thumbnail_url, 'https://example.test/instagram-referral-video-thumb.jpg')
    assert.equal(instagramMessage.data.attribution_ad_name, 'Anuncio Instagram')
    assert.equal(instagramMessage.data.creative_preview_url, 'https://example.test/instagram-preview')
  } finally {
    await db.run('DELETE FROM meta_ads WHERE ad_id IN (?, ?)', [messengerAdId, instagramAdId]).catch(() => undefined)
    await cleanup(contactId, phone)
  }
})

test('chat contacts responds before external avatar warming finishes', async () => {
  const id = randomUUID()
  const contactId = `chat_avatar_async_${id}`
  const phone = `+52997${Date.now().toString().slice(-7)}`
  let releaseWarmup = () => {}
  const warmupGate = new Promise(resolve => { releaseWarmup = resolve })
  let warmupStartedResolve = () => {}
  const warmupStarted = new Promise(resolve => { warmupStartedResolve = resolve })

  await cleanup(contactId, phone)
  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente Avatar Asíncrono',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2099-06-30T12:00:00.000Z',
      updated_at: '2099-06-30T12:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_avatar_async_${id}`,
      contact_id: contactId,
      phone,
      from_phone: phone,
      to_phone: '+526561000000',
      business_phone: '+526561000000',
      transport: 'api',
      direction: 'inbound',
      message_type: 'text',
      message_text: 'La bandeja no espera mi avatar',
      message_timestamp: '2099-06-30T12:01:00.000Z',
      created_at: '2099-06-30T12:01:00.000Z'
    })

    setProfilePictureWarmupRunnerForTest(async rows => {
      warmupStartedResolve()
      await warmupGate
      return rows
    })

    const responsePromise = readChatContacts({
      limit: '10',
      warmProfilePictures: 'true'
    })
    const chats = await Promise.race([
      responsePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('La bandeja esperó el proveedor de avatares')), 1500))
    ])
    assert.ok(chats.some(chat => chat.id === contactId))
    await Promise.race([
      warmupStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('No se encoló el calentamiento de avatares')), 1500))
    ])
  } finally {
    releaseWarmup()
    assert.equal(await waitForProfilePictureWarmupsForTest(), true)
    setProfilePictureWarmupRunnerForTest(null)
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
      const isoTimestamp = `2099-07-01T12:${minute}:${second}.000Z`
      const timestamp = index % 2 === 0
        ? isoTimestamp.replace('T', ' ').replace('.000Z', '')
        : isoTimestamp

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
    assert.equal(firstPageSyntheticChats[0].id, `${prefix}_119`)
    assert.equal(firstPageSyntheticChats[99].id, `${prefix}_20`)

    const secondPage = await readChatContacts({ limit: '110', offset: '100' })
    const secondPageSyntheticChats = secondPage.filter(chat => String(chat.id).startsWith(prefix))
    assert.equal(secondPageSyntheticChats.length, 20)

    const boundary = firstPage[firstPage.length - 1]
    assert.ok(boundary?.lastMessageDate)
    assert.ok(boundary?.lastMessageCursorSort)
    const cursorPage = await readChatContacts({
      limit: '110',
      beforeMessageDate: boundary.lastMessageDate,
      beforeMessageSort: boundary.lastMessageCursorSort,
      beforeContactId: boundary.id
    })
    const cursorSyntheticChats = cursorPage.filter(chat => String(chat.id).startsWith(prefix))
    assert.equal(cursorSyntheticChats.length, 20)
    assert.equal(cursorSyntheticChats[0].id, `${prefix}_19`)
    assert.equal(cursorSyntheticChats[19].id, `${prefix}_0`)
    assert.equal(
      cursorSyntheticChats.some(chat => firstPageSyntheticChats.some(first => first.id === chat.id)),
      false
    )
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})

test('chat keyset uses the exact normalized sort instead of an unrelated textual MAX', async () => {
  const id = randomUUID().replace(/-/g, '')
  const marker = `cursor_mixed_${id}`
  const contactA = `${marker}_a`
  const contactB = `${marker}_b`
  const contactC = `${marker}_c`
  const contacts = [contactA, contactB, contactC]

  try {
    for (const contactId of contacts) {
      await insertRow('contacts', {
        id: contactId,
        phone: `+52990${contactId.slice(-8)}`,
        full_name: marker,
        first_name: marker,
        source: 'manual',
        created_at: '2098-08-01T11:00:00.000Z',
        updated_at: '2098-08-01T11:00:00.000Z'
      })
    }

    // El espacio gana cronológicamente, pero "T" gana con MAX textual en SQLite.
    // El cursor no puede salir de ese MAX independiente porque apuntaría a otro mensaje.
    await insertRow('whatsapp_api_messages', {
      id: `wa_${contactA}`,
      contact_id: contactA,
      phone: `+52990${contactA.slice(-8)}`,
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Más reciente con formato SQLite',
      message_timestamp: '2098-08-01 12:00:00.900',
      created_at: '2098-08-01 12:00:00.900'
    })
    await insertRow('email_messages', {
      id: `email_${contactA}`,
      contact_id: contactA,
      direction: 'inbound',
      subject: 'Más viejo con formato ISO',
      message_text: '',
      message_timestamp: '2098-08-01T12:00:00.100Z',
      created_at: '2098-08-01T12:00:00.100Z'
    })

    for (const contactId of [contactB, contactC]) {
      await insertRow('whatsapp_api_messages', {
        id: `wa_${contactId}`,
        contact_id: contactId,
        phone: `+52990${contactId.slice(-8)}`,
        direction: 'inbound',
        message_type: 'text',
        message_text: `Empate ${contactId}`,
        message_timestamp: '2098-08-01T12:00:00.500Z',
        created_at: '2098-08-01T12:00:00.500Z'
      })
    }

    const lexicalMax = await db.get(
      `SELECT MAX(message_date) AS value
       FROM (
         SELECT COALESCE(message_timestamp, created_at) AS message_date
         FROM whatsapp_api_messages
         WHERE contact_id = ?
         UNION ALL
         SELECT COALESCE(message_timestamp, created_at) AS message_date
         FROM email_messages
         WHERE contact_id = ?
       ) mixed_dates`,
      [contactA, contactA]
    )
    assert.equal(lexicalMax.value, '2098-08-01T12:00:00.100Z')

    const collected = []
    let cursor = null
    let firstCursor = null
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await readChatContacts({
        q: marker,
        limit: '1',
        ...(cursor ? {
          beforeMessageDate: cursor.lastMessageDate,
          beforeMessageSort: cursor.lastMessageCursorSort,
          beforeMessageScope: cursor.lastMessageCursorScope,
          beforeContactId: cursor.id
        } : {})
      })
      if (!page.length) break
      assert.ok(page[0].lastMessageCursorSort)
      assert.match(page[0].lastMessageCursorScope, /^[A-Za-z0-9_-]{40,}$/)
      collected.push(page[0].id)
      cursor = page[0]
      firstCursor ||= page[0]
    }

    assert.deepEqual(collected, [contactA, contactC, contactB])
    assert.equal(new Set(collected).size, contacts.length)

    const mismatchResponse = createMockResponse()
    await getChatContacts({
      query: {
        q: `${marker}_otra_vista`,
        limit: '1',
        beforeMessageDate: firstCursor.lastMessageDate,
        beforeMessageSort: firstCursor.lastMessageCursorSort,
        beforeMessageScope: firstCursor.lastMessageCursorScope,
        beforeContactId: firstCursor.id
      },
      user: {}
    }, mismatchResponse)
    assert.equal(mismatchResponse.statusCode, 400)
    assert.equal(mismatchResponse.body?.success, false)
    assert.match(mismatchResponse.body?.error, /ya no corresponde a esta vista/)

    // Durante la transición, clientes viejos sin scope conservan el cursor legacy.
    const wrongIndependentMaxPage = await readChatContacts({
      q: marker,
      limit: '10',
      beforeMessageDate: lexicalMax.value,
      beforeContactId: contactA
    })
    assert.deepEqual(wrongIndependentMaxPage, [])
  } finally {
    for (const contactId of contacts) {
      await cleanup(contactId, `+52990${contactId.slice(-8)}`)
    }
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

    const facebookJourney = await readJourney(facebookContactId)
    const instagramJourney = await readJourney(instagramContactId)
    const facebookMessage = facebookJourney.find(event => event.type === 'meta_message')
    const instagramMessage = instagramJourney.find(event => event.type === 'meta_message')

    assert.ok(facebookMessage)
    assert.ok(instagramMessage)
    assert.equal(facebookMessage.data.source, 'Facebook')
    assert.equal(instagramMessage.data.source, 'Instagram')
    assert.equal(facebookMessage.data.transport, 'facebook_comment')
    assert.equal(instagramMessage.data.transport, 'instagram_comment')
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
    assert.equal(message.data.transport, 'ghl_messenger')
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

    const fullConversationJourney = await readConversation(contactId)
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

test('contact conversation messageLimit returns the most recent chat messages in chronological order', async () => {
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

    const fullJourney = await readConversation(contactId)
    const fullMessages = fullJourney.filter(event => event.type === 'whatsapp_message')
    assert.equal(fullMessages.length, 10)

    const limitedJourney = await readConversation(contactId, {
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

test('contact conversation applies messageLimit globally and pages older messages with beforeMessageDate', async () => {
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

    const firstPage = await readConversation(contactId, {
      messageLimit: '5'
    })
    assert.deepEqual(
      firstPage.map(event => event.data.message_text),
      ['Global 7', 'Global 8', 'Global 9', 'Global 10', 'Global 11']
    )

    const olderPage = await readConversation(contactId, {
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

test('contact conversation compound cursor paginates equal timestamps without omissions or duplicates', async () => {
  const id = randomUUID().replace(/-/g, '')
  const contactId = `journey_tied_cursor_${id}`
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const tiedTimestamp = '2026-06-18T12:00:00.000Z'
  const expectedTexts = []

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con mensajes empatados',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-18T09:00:00.000Z',
      updated_at: '2026-06-18T09:00:00.000Z'
    })

    const whatsappIdSuffixes = ['-A', '_a', 'Zed', 'alpha', '9']
    for (let index = 0; index < whatsappIdSuffixes.length; index += 1) {
      const text = `WhatsApp empate ${index}`
      expectedTexts.push(text)
      await insertRow('whatsapp_api_messages', {
        id: `api_tied_${id}${whatsappIdSuffixes[index]}`,
        contact_id: contactId,
        phone,
        from_phone: phone,
        to_phone: '+526561000000',
        business_phone: '+526561000000',
        transport: 'api',
        direction: 'inbound',
        message_type: 'text',
        message_text: text,
        message_timestamp: tiedTimestamp,
        created_at: tiedTimestamp
      })
    }

    for (let index = 0; index < 5; index += 1) {
      const text = `Meta empate ${index}`
      expectedTexts.push(text)
      await insertRow('meta_social_messages', {
        id: `meta_tied_${id}_${index}`,
        platform: 'instagram',
        meta_message_id: `meta_tied_provider_${id}_${index}`,
        contact_id: contactId,
        sender_id: 'ig_customer',
        recipient_id: 'ig_business',
        direction: 'inbound',
        status: 'received',
        message_type: 'text',
        message_text: text,
        message_timestamp: tiedTimestamp,
        created_at: tiedTimestamp
      })
    }

    for (let index = 0; index < 4; index += 1) {
      const text = `Email empate ${index}`
      expectedTexts.push(text)
      await insertRow('email_messages', {
        id: `email_tied_${id}_${index}`,
        contact_id: contactId,
        from_email: `cliente_${id}@example.test`,
        to_email: 'negocio@example.test',
        direction: 'inbound',
        status: 'received',
        subject: text,
        message_text: '',
        message_timestamp: tiedTimestamp,
        created_at: tiedTimestamp
      })
    }
    await runChatActivityProjectionBackfill()
    const projectionState = await db.get(
      'SELECT status FROM chat_activity_projection_state WHERE singleton_id = 1'
    )
    assert.equal(projectionState?.status, 'ready')

    const collectedEvents = []
    let beforeMessageDate
    let beforeMessageCursor
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await readConversation(contactId, {
        messageLimit: '4',
        beforeMessageDate,
        beforeMessageCursor
      })
      if (!page.length) break
      assert.ok(page.every(event => event.date === tiedTimestamp))
      assert.ok(page.every(event => typeof event.cursorDate === 'string' && event.cursorDate.length > 0))
      assert.ok(page.every(event => typeof event.cursorKey === 'string' && event.cursorKey.length > 0))
      const pageCursorKeys = page.map(event => event.cursorKey)
      assert.deepEqual(pageCursorKeys, [...pageCursorKeys].sort((left, right) => (
        left === right ? 0 : left < right ? -1 : 1
      )))
      collectedEvents.push(...page)
      beforeMessageDate = page[0].cursorDate || page[0].date
      beforeMessageCursor = page[0].cursorKey
    }

    assert.equal(collectedEvents.length, expectedTexts.length)
    assert.equal(new Set(collectedEvents.map(event => event.cursorKey)).size, expectedTexts.length)
    assert.deepEqual(
      collectedEvents.map(event => event.data.message_text || event.data.subject).sort(),
      expectedTexts.sort()
    )

    // Los clientes viejos siguen usando fecha estricta y reciben el contrato previo.
    const legacyPage = await readConversation(contactId, {
      messageLimit: '4',
      beforeMessageDate: tiedTimestamp
    })
    assert.deepEqual(legacyPage, [])
  } finally {
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('contact conversation includes appointment confirmation cards without full contact journey events', async () => {
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
    await runChatActivityProjectionBackfill()

    const journey = await readConversation(contactId)

    assert.deepEqual(journey.map(event => event.type), ['whatsapp_message', 'appointment_confirmation'])
    assert.ok(journey.every(event => typeof event.cursorDate === 'string' && event.cursorDate.length > 0))
    assert.ok(journey.every(event => typeof event.cursorKey === 'string' && event.cursorKey.length > 0))
    assert.equal(journey[1].data.appointment_id, appointmentId)
    assert.equal(journey[1].data.result_detail, 'Confirmo asistencia')

    const olderJourney = await readConversation(contactId, {
      beforeMessageDate: '2026-06-19T10:02:00.000Z'
    })

    assert.deepEqual(olderJourney.map(event => event.type), ['whatsapp_message'])
  } finally {
    await cleanup(contactId, phone)
    await runChatActivityProjectionBackfill()
  }
})

test('chat activity journey returns only payment and appointment markers', async () => {
  const id = randomUUID()
  const contactId = `journey_chat_activity_${id}`
  const phone = `+52993${Date.now().toString().slice(-7)}`

  await cleanup(contactId, phone)

  try {
    await insertRow('contacts', {
      id: contactId,
      phone,
      full_name: 'Cliente con actividad',
      first_name: 'Cliente',
      source: 'manual',
      created_at: '2026-06-20T08:00:00.000Z',
      updated_at: '2026-06-20T08:00:00.000Z'
    })
    await insertRow('appointments', {
      id: `appointment_activity_${id}`,
      calendar_id: `calendar_activity_${id}`,
      contact_id: contactId,
      title: 'Diagnóstico',
      status: 'confirmed',
      appointment_status: 'confirmed',
      start_time: '2026-06-21T16:00:00.000Z',
      end_time: '2026-06-21T17:00:00.000Z',
      date_added: '2026-06-20T09:00:00.000Z',
      date_updated: '2026-06-20T09:00:00.000Z'
    })
    await insertRow('payments', {
      id: `payment_activity_${id}`,
      contact_id: contactId,
      amount: 1250,
      currency: 'USD',
      status: 'paid',
      payment_method: 'card',
      payment_provider: 'manual',
      payment_mode: 'live',
      title: 'Anticipo',
      date: '2026-06-20T10:00:00.000Z',
      created_at: '2026-06-20T10:00:00.000Z',
      updated_at: '2026-06-20T10:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: `api_activity_${id}`,
      contact_id: contactId,
      phone,
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Este mensaje no debe venir',
      message_timestamp: '2026-06-20T11:00:00.000Z',
      created_at: '2026-06-20T11:00:00.000Z'
    })

    const activity = await readJourney(contactId, { chatActivityOnly: 'true' })

    assert.deepEqual(activity.map(event => event.type), ['appointment', 'payment'])
    assert.equal(activity[0].data.id, `appointment_activity_${id}`)
    assert.equal(activity[1].data.currency, 'USD')
    assert.equal(activity.some(event => event.type === 'whatsapp_message'), false)
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

    const journey = await readJourney(contactId)
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

test('contact journey keeps same-day logical sessions as independent summaries', async () => {
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

    assert.equal(pageVisits.length, 2)
    assert.equal(new Set(pageVisits.map(event => event.cursorKey)).size, 2)

    const firstVisit = pageVisits.find(event => event.data.session_id === firstSessionId)
    const secondVisit = pageVisits.find(event => event.data.session_id === secondSessionId)
    assert.ok(firstVisit)
    assert.ok(secondVisit)

    assert.equal(firstVisit.cursorKey, `page_visit:${firstSessionId}`)
    assert.equal(firstVisit.date, '2026-06-16T10:00:00.000Z')
    assert.equal(firstVisit.data.session_event_count, 2)
    assert.equal(firstVisit.data.session_page_view_count, 1)
    assert.equal(firstVisit.data.pages_visited, 1)
    assert.equal(firstVisit.data.session_duration_seconds, 300)
    assert.equal(firstVisit.data.visible_session_count, 1)
    assert.deepEqual(firstVisit.data.session_ids, [firstSessionId])
    assert.deepEqual(firstVisit.data.event_names, ['page_view', 'session_end'])

    assert.equal(secondVisit.cursorKey, `page_visit:${secondSessionId}`)
    assert.equal(secondVisit.date, '2026-06-16T10:15:00.000Z')
    assert.equal(secondVisit.data.session_event_count, 1)
    assert.equal(secondVisit.data.session_page_view_count, 1)
    assert.equal(secondVisit.data.pages_visited, 1)
    assert.equal(secondVisit.data.session_duration_seconds, 0)
    assert.equal(secondVisit.data.visible_session_count, 1)
    assert.deepEqual(secondVisit.data.session_ids, [secondSessionId])
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

    assert.equal(pageVisits.length, 2)
    assert.equal(new Set(pageVisits.map(event => event.cursorKey)).size, 2)
    assert.deepEqual(
      new Set(pageVisits.map(event => event.data.session_id)),
      new Set([firstSessionId, secondSessionId])
    )
    pageVisits.forEach(visit => {
      assert.equal(visit.data.tracking_identity_untrusted, true)
      assert.equal(visit.data.identity_warning, 'shared_ad_like_visitor_id')
      assert.equal(visit.data.session_event_count, 0)
      assert.equal(visit.data.session_page_view_count, 0)
      assert.equal(visit.data.pages_visited, 0)
      assert.equal(visit.data.session_duration_seconds, 0)
      assert.equal(visit.data.visible_session_count, 0)
      assert.deepEqual(visit.data.visitor_ids, [adLikeVisitorId])
      assert.equal(visit.data.first_page_url, `https://raulgomez.com.mx/quiero-pacientes?rkvi_id=${adLikeVisitorId}&ad_id=${adLikeVisitorId}&utm_source=facebook`)
    })
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

    const journey = await readJourney(contactId)
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
