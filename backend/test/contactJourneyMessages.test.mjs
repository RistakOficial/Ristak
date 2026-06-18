import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getChatContacts, getContactJourney } from '../src/controllers/contactsController.js'

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

async function readChatContacts(query = {}) {
  const res = createMockResponse()
  await getChatContacts({ query }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)
  assert.ok(Array.isArray(res.body.data))

  return res.body.data
}

async function cleanup(contactId, phone) {
  await db.run('DELETE FROM video_playback_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM video_playback_sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

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
