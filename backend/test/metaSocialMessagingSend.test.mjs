import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  processMetaSocialWebhook,
  sendMetaSocialAudioMessage,
  sendMetaSocialReactionMessage,
  sendMetaSocialTextMessage,
  syncMetaSocialConversationHistory
} from '../src/services/metaSocialMessagingService.js'

function hashTestId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32)}`
}

async function snapshotMetaConfig(callback) {
  const previousRows = await db.all('SELECT * FROM meta_config')
  try {
    await db.run('DELETE FROM meta_config')
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_config')
    for (const row of previousRows) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function snapshotAppConfig(keys, callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(',')
  const previousRows = uniqueKeys.length
    ? await db.all(`SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    : []

  try {
    if (uniqueKeys.length) await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    return await callback()
  } finally {
    if (uniqueKeys.length) await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    for (const row of previousRows) {
      await setAppConfig(row.config_key, row.config_value)
    }
  }
}

async function startMetaSendServer(calls) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization || '' })

      if (req.method === 'GET' && /^\/page-send-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-send-test' }))
        return
      }

      if (req.method === 'GET' && /^\/page-history-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-history-test' }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/page-history-test/conversations')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            {
              id: 'conversation-messenger-history',
              updated_time: '2026-07-03T22:42:00+0000',
              participants: {
                data: [
                  { id: 'page-history-test', name: 'Ristak Page' },
                  { id: 'psid-history-test', name: 'Cliente Messenger Historial' }
                ]
              }
            }
          ]
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/conversation-messenger-history/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            {
              id: 'mid-history-inbound',
              message: 'Hola desde historial Messenger',
              created_time: '2026-07-03T22:40:00+0000',
              from: { id: 'psid-history-test', name: 'Cliente Messenger Historial' },
              to: { data: [{ id: 'page-history-test', name: 'Ristak Page' }] }
            },
            {
              id: 'mid-history-outbound',
              message: 'Respuesta histórica Messenger',
              created_time: '2026-07-03T22:41:00+0000',
              from: { id: 'page-history-test', name: 'Ristak Page' },
              to: { data: [{ id: 'psid-history-test', name: 'Cliente Messenger Historial' }] }
            }
          ]
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/psid-history-test')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'psid-history-test',
          name: 'Cliente Messenger Historial',
          profile_pic: 'https://cdn.example.test/messenger-history.jpg'
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/igsid-profile-test')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'igsid-profile-test',
          name: 'Cliente Correcto',
          username: 'cliente.correcto',
          profile_pic: 'https://cdn.example.test/ig-profile.jpg'
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/igsid-comment-test')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'igsid-comment-test',
          name: 'Comentarista Real',
          username: 'comentarista.real',
          profile_pic: 'https://cdn.example.test/ig-comment-profile.jpg'
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/igsid-fallback-test')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: 'Profile blocked for test',
            type: 'OAuthException',
            code: 200
          }
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/igsid-history-test')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'igsid-history-test',
          name: 'Cliente Instagram Historial',
          username: 'cliente.historial',
          profile_pic: 'https://cdn.example.test/instagram-history.jpg'
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/me/conversations')) {
        const requestUrl = new URL(req.url, 'http://127.0.0.1')
        if (!requestUrl.searchParams.get('user_id')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            data: [
              {
                id: 'conversation-instagram-history',
                updated_time: '2026-07-03T23:02:00+0000',
                participants: {
                  data: [
                    { id: 'ig-business-history-test', name: 'Ristak IG' },
                    { id: 'igsid-history-test', name: 'Cliente Instagram Historial', username: 'cliente.historial' }
                  ]
                }
              }
            ]
          }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            {
              id: 'conversation-fallback-test',
              participants: {
                data: [
                  { id: 'ig-business-send-test', name: 'Ristak IG' },
                  { id: 'igsid-fallback-test', name: 'Nombre Por Conversacion' }
                ]
              }
            }
          ]
        }))
        return
      }

      if (req.method === 'GET' && req.url.startsWith('/conversation-instagram-history/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            {
              id: 'ig-mid-history-inbound',
              message: 'Hola desde historial Instagram',
              created_time: '2026-07-03T23:00:00+0000',
              from: { id: 'igsid-history-test', name: 'Cliente Instagram Historial', username: 'cliente.historial' },
              to: { data: [{ id: 'ig-business-history-test', name: 'Ristak IG' }] }
            },
            {
              id: 'ig-mid-history-outbound',
              message: 'Respuesta histórica Instagram',
              created_time: '2026-07-03T23:01:00+0000',
              from: { id: 'ig-business-history-test', name: 'Ristak IG' },
              to: { data: [{ id: 'igsid-history-test', name: 'Cliente Instagram Historial', username: 'cliente.historial' }] }
            }
          ]
        }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/page-send-test/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ recipient_id: 'psid-send-test', message_id: 'mid-messenger-send-test' }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/ig-business-send-test/messages')) {
        const parsedBody = JSON.parse(body || '{}')
        if (parsedBody?.message?.attachment?.type === 'audio') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ recipient_id: 'igsid-send-test', message_id: 'mid-instagram-send-test' }))
          return
        }

        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: '(#3) Application does not have the capability to make this API call.',
            type: 'OAuthException',
            code: 3,
            fbtrace_id: 'trace-send-test'
          }
        }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not found', code: 100 } }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function seedInstagramContact({ contactId, metaContactId }) {
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    [contactId, 'Instagram Test', 'Instagram Test', 'Instagram DM']
  )

  await db.run(
    `INSERT INTO meta_social_contacts (
       id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id,
       profile_name, message_count, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(platform, sender_id) DO UPDATE SET
       contact_id = excluded.contact_id,
       recipient_id = excluded.recipient_id,
       page_id = excluded.page_id,
       instagram_account_id = excluded.instagram_account_id,
       updated_at = CURRENT_TIMESTAMP`,
    [
      metaContactId,
      contactId,
      'instagram',
      'igsid-send-test',
      'ig-business-send-test',
      'page-send-test',
      'ig-business-send-test',
      'Instagram Test'
    ]
  )
}

async function seedMessengerContact({ contactId, metaContactId }) {
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    [contactId, 'Messenger Test', 'Messenger Test', 'Messenger']
  )

  await db.run(
    `INSERT INTO meta_social_contacts (
       id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id,
       profile_name, message_count, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(platform, sender_id) DO UPDATE SET
       contact_id = excluded.contact_id,
       recipient_id = excluded.recipient_id,
       page_id = excluded.page_id,
       instagram_account_id = excluded.instagram_account_id,
       updated_at = CURRENT_TIMESTAMP`,
    [
      metaContactId,
      contactId,
      'messenger',
      'psid-send-test',
      'page-send-test',
      'page-send-test',
      null,
      'Messenger Test'
    ]
  )
}

async function seedMetaConfigForInstagramTests() {
  await db.run(`
    INSERT INTO meta_config (
      ad_account_id, access_token, instagram_access_token, pixel_id, page_id, instagram_account_id,
      timezone_id, timezone_name, timezone_offset_hours_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    'act-send-test',
    encrypt('user-token-send-test'),
    encrypt('instagram-token-send-test'),
    null,
    'page-send-test',
    'ig-business-send-test',
    null,
    null,
    null
  ])
}

async function cleanupSocialRows({ senderId, metaMessageId }) {
  const contactId = hashTestId('meta_social_contact', `instagram:${senderId}`)
  await db.run('DELETE FROM meta_social_messages WHERE sender_id = ? OR meta_message_id = ?', [senderId, metaMessageId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_webhook_events WHERE raw_payload_json LIKE ?', [`%${metaMessageId}%`]).catch(() => undefined)
}

test('syncMetaSocialConversationHistory importa historial disponible de Messenger al chat', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'psid-history-test'
  const contactId = hashTestId('meta_social_contact', `messenger:${senderId}`)

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-history-test',
            encrypt('user-token-history-test'),
            null,
            'page-history-test',
            null,
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')

          const result = await syncMetaSocialConversationHistory({
            platform: 'messenger',
            maxConversations: 5,
            maxMessagesPerConversation: 5,
            maxTotalMessages: 10,
            publishEvents: false
          })

          assert.equal(result.skipped, false)
          assert.equal(result.conversations, 1)
          assert.equal(result.saved, 2)
          assert.equal(result.messagesScanned, 2)

          const rows = await db.all(`
            SELECT meta_message_id, direction, sender_id, recipient_id, page_id, message_text, platform
            FROM meta_social_messages
            WHERE sender_id = ?
            ORDER BY message_timestamp ASC
          `, [senderId])
          assert.equal(rows.length, 2)
          assert.deepEqual(rows.map(row => row.meta_message_id), ['mid-history-inbound', 'mid-history-outbound'])
          assert.deepEqual(rows.map(row => row.direction), ['inbound', 'outbound'])
          assert.equal(rows[0].recipient_id, 'page-history-test')
          assert.equal(rows[1].recipient_id, 'page-history-test')
          assert.equal(rows[0].page_id, 'page-history-test')
          assert.equal(rows[0].platform, 'messenger')

          const profile = await db.get(
            'SELECT contact_id, profile_name, profile_picture_url FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
            ['messenger', senderId]
          )
          assert.equal(profile.contact_id, contactId)
          assert.equal(profile.profile_name, 'Cliente Messenger Historial')
          assert.equal(profile.profile_picture_url, 'https://cdn.example.test/messenger-history.jpg')

          assert.equal(calls.some(call => call.url.startsWith('/page-history-test/conversations')), true)
          const messagesCall = calls.find(call => call.url.startsWith('/conversation-messenger-history/messages'))
          assert.equal(messagesCall?.authorization, 'Bearer page-token-history-test')
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousInstagramGraphDescriptor) Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
  }
})

test('syncMetaSocialConversationHistory importa historial disponible de Instagram con Instagram Graph', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-history-test'
  const contactId = hashTestId('meta_social_contact', `instagram:${senderId}`)

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, instagram_access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-history-test',
            encrypt('user-token-history-test'),
            encrypt('instagram-token-history-test'),
            null,
            'page-history-test',
            'ig-business-history-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_instagram_messaging_enabled', '1')

          const result = await syncMetaSocialConversationHistory({
            platform: 'instagram',
            maxConversations: 5,
            maxMessagesPerConversation: 5,
            maxTotalMessages: 10,
            publishEvents: false
          })

          assert.equal(result.skipped, false)
          assert.equal(result.conversations, 1)
          assert.equal(result.saved, 2)
          assert.equal(result.messagesScanned, 2)

          const rows = await db.all(`
            SELECT meta_message_id, direction, sender_id, recipient_id, instagram_account_id, message_text, platform
            FROM meta_social_messages
            WHERE sender_id = ?
            ORDER BY message_timestamp ASC
          `, [senderId])
          assert.equal(rows.length, 2)
          assert.deepEqual(rows.map(row => row.meta_message_id), ['ig-mid-history-inbound', 'ig-mid-history-outbound'])
          assert.deepEqual(rows.map(row => row.direction), ['inbound', 'outbound'])
          assert.equal(rows[0].recipient_id, 'ig-business-history-test')
          assert.equal(rows[1].recipient_id, 'ig-business-history-test')
          assert.equal(rows[0].instagram_account_id, 'ig-business-history-test')
          assert.equal(rows[0].platform, 'instagram')

          const profile = await db.get(
            'SELECT contact_id, profile_name, username, profile_picture_url FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
            ['instagram', senderId]
          )
          assert.equal(profile.contact_id, contactId)
          assert.equal(profile.profile_name, 'Cliente Instagram Historial')
          assert.equal(profile.username, 'cliente.historial')
          assert.equal(profile.profile_picture_url, 'https://cdn.example.test/instagram-history.jpg')

          const conversationsCall = calls.find(call => call.url.startsWith('/me/conversations'))
          assert.equal(conversationsCall?.authorization, 'Bearer instagram-token-history-test')
          const messagesCall = calls.find(call => call.url.startsWith('/conversation-instagram-history/messages'))
          assert.equal(messagesCall?.authorization, 'Bearer instagram-token-history-test')
          assert.equal(calls.some(call => call.url.startsWith('/page-history-test?')), false)
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousInstagramGraphDescriptor) Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
  }
})

test('processMetaSocialWebhook enriquece DMs de Instagram con Instagram Graph y token directo', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-profile-test'
  const metaMessageId = 'mid-profile-test'
  const messageTimestamp = '2026-07-03T22:38:10.003Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}/facebook`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await cleanupSocialRows({ senderId, metaMessageId })
          await seedMetaConfigForInstagramTests()
          await setAppConfig('meta_instagram_messaging_enabled', '1')

          await db.run(`
            INSERT INTO meta_social_messages (
              id, platform, meta_message_id, sender_id, recipient_id, page_id, instagram_account_id,
              direction, message_type, message_text, message_timestamp, raw_payload_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [
            hashTestId('meta_social_msg', metaMessageId),
            'instagram',
            metaMessageId,
            senderId,
            'ig-business-send-test',
            'page-send-test',
            'ig-business-send-test',
            'inbound',
            'text',
            'Hola',
            messageTimestamp,
            '{}'
          ])

          await processMetaSocialWebhook({
            payload: {
              object: 'instagram',
              entry: [
                {
                  id: 'ig-business-send-test',
                  time: 1783108690,
                  messaging: [
                    {
                      sender: { id: senderId },
                      recipient: { id: 'ig-business-send-test' },
                      timestamp: Date.parse(messageTimestamp),
                      message: { mid: metaMessageId, text: 'Hola' }
                    }
                  ]
                }
              ]
            }
          })

          const profile = await db.get(
            'SELECT profile_name, username, profile_picture_url, meta_user_id FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
            ['instagram', senderId]
          )
          assert.equal(profile.profile_name, 'Cliente Correcto')
          assert.equal(profile.username, 'cliente.correcto')
          assert.equal(profile.profile_picture_url, 'https://cdn.example.test/ig-profile.jpg')
          assert.equal(profile.meta_user_id, senderId)

          const profileCall = calls.find(call => call.method === 'GET' && call.url.startsWith(`/${senderId}?`))
          assert.ok(profileCall)
          assert.equal(profileCall.authorization, 'Bearer instagram-token-send-test')
          assert.match(profileCall.url, /fields=name%2Cusername%2Cprofile_pic/)
          assert.equal(calls.some(call => call.url.startsWith('/page-send-test?')), false)
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousInstagramGraphDescriptor) Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
  }
})

test('processMetaSocialWebhook enriquece comentarios de Instagram con perfil del autor', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-comment-test'
  const metaMessageId = 'ig-comment-profile-test'
  const messageTimestamp = '2026-07-03T23:00:00.000Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}/facebook`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_comments_enabled'], async () => {
        try {
          await cleanupSocialRows({ senderId, metaMessageId })
          await seedMetaConfigForInstagramTests()
          await setAppConfig('meta_instagram_comments_enabled', '1')

          await db.run(`
            INSERT INTO meta_social_messages (
              id, platform, meta_message_id, sender_id, recipient_id, instagram_account_id,
              direction, message_type, message_text, message_timestamp, raw_payload_json, comment_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [
            hashTestId('meta_social_msg', metaMessageId),
            'instagram',
            metaMessageId,
            senderId,
            'ig-business-send-test',
            'ig-business-send-test',
            'inbound',
            'comment',
            'Me interesa',
            messageTimestamp,
            '{}',
            metaMessageId
          ])

          await processMetaSocialWebhook({
            payload: {
              object: 'instagram',
              entry: [
                {
                  id: 'ig-business-send-test',
                  time: 1783110000,
                  changes: [
                    {
                      field: 'comments',
                      value: {
                        id: metaMessageId,
                        from: { id: senderId, name: 'Nombre Webhook', username: 'nombre.webhook' },
                        text: 'Me interesa',
                        media: { id: 'ig-media-test' },
                        created_time: Math.floor(Date.parse(messageTimestamp) / 1000)
                      }
                    }
                  ]
                }
              ]
            }
          })

          const profile = await db.get(
            'SELECT profile_name, username, profile_picture_url, meta_user_id FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
            ['instagram', senderId]
          )
          assert.equal(profile.profile_name, 'Comentarista Real')
          assert.equal(profile.username, 'comentarista.real')
          assert.equal(profile.profile_picture_url, 'https://cdn.example.test/ig-comment-profile.jpg')
          assert.equal(profile.meta_user_id, senderId)

          const profileCall = calls.find(call => call.method === 'GET' && call.url.startsWith(`/${senderId}?`))
          assert.ok(profileCall)
          assert.equal(profileCall.authorization, 'Bearer instagram-token-send-test')
          assert.equal(calls.some(call => call.url.startsWith('/page-send-test?')), false)
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousInstagramGraphDescriptor) Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
  }
})

test('processMetaSocialWebhook refleja respuestas propias a comentarios en el chat del contacto', async () => {
  const contactId = 'meta_comment_echo_contact'
  const metaContactId = 'meta_comment_echo_profile'
  const inboundCommentId = 'fb-comment-echo-parent'
  const replyCommentId = 'fb-comment-echo-reply'

  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await snapshotAppConfig(['meta_facebook_comments_enabled'], async () => {
      try {
        await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR meta_message_id IN (?, ?)', [contactId, inboundCommentId, replyCommentId]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ? OR sender_id = ?', [contactId, 'page-send-test']).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

        await db.run(`
          INSERT INTO meta_config (
            ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
            timezone_id, timezone_name, timezone_offset_hours_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          'act-send-test',
          encrypt('user-token-send-test'),
          null,
          'page-send-test',
          'ig-business-send-test',
          null,
          null,
          null
        ])
        await setAppConfig('meta_facebook_comments_enabled', '1')
        await seedMessengerContact({ contactId, metaContactId })

        await db.run(`
          INSERT INTO meta_social_messages (
            id, platform, meta_message_id, meta_social_contact_id, contact_id,
            sender_id, recipient_id, page_id, direction, status, message_type,
            message_text, message_timestamp, raw_payload_json, comment_id, post_id, updated_at
          ) VALUES (?, 'messenger', ?, ?, ?, 'psid-send-test', 'page-send-test', 'page-send-test', 'inbound', 'received', 'comment',
            'Quiero informes', '2026-07-04T16:00:00.000Z', '{}', ?, 'fb-post-echo-test', CURRENT_TIMESTAMP)
        `, [
          hashTestId('meta_social_msg', inboundCommentId),
          inboundCommentId,
          metaContactId,
          contactId,
          inboundCommentId
        ])

        const result = await processMetaSocialWebhook({
          payload: {
            object: 'page',
            entry: [
              {
                id: 'page-send-test',
                time: 1783180860,
                changes: [
                  {
                    field: 'feed',
                    value: {
                      item: 'comment',
                      verb: 'add',
                      comment_id: replyCommentId,
                      parent_id: inboundCommentId,
                      post_id: 'fb-post-echo-test',
                      from: { id: 'page-send-test', name: 'Ristak' },
                      message: 'Claro, te mando la info.',
                      created_time: 1783180860
                    }
                  }
                ]
              }
            ]
          }
        })

        assert.equal(result.messages, 1)

        const stored = await db.get(
          `SELECT contact_id, meta_social_contact_id, sender_id, recipient_id, direction, status, message_type,
                  message_text, comment_id, parent_comment_id, post_id
             FROM meta_social_messages
            WHERE meta_message_id = ?`,
          [replyCommentId]
        )

        assert.equal(stored.contact_id, contactId)
        assert.equal(stored.meta_social_contact_id, metaContactId)
        assert.equal(stored.sender_id, 'page-send-test')
        assert.equal(stored.recipient_id, 'psid-send-test')
        assert.equal(stored.direction, 'outbound')
        assert.equal(stored.status, 'sent')
        assert.equal(stored.message_type, 'comment_reply_public')
        assert.equal(stored.message_text, 'Claro, te mando la info.')
        assert.equal(stored.comment_id, inboundCommentId)
        assert.equal(stored.parent_comment_id, inboundCommentId)
        assert.equal(stored.post_id, 'fb-post-echo-test')

        const pageContact = await db.get(
          'SELECT id FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
          ['messenger', 'page-send-test']
        )
        assert.equal(pageContact, null)
      } finally {
        await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR meta_message_id IN (?, ?)', [contactId, inboundCommentId, replyCommentId]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ? OR sender_id = ?', [contactId, 'page-send-test']).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
      }
    })
  })
})

test('processMetaSocialWebhook conserva el texto de comentario Facebook si un duplicado llega sin message', async () => {
  const senderId = 'psid-comment-preserve-test'
  const commentId = 'fb-comment-preserve-text'
  const postId = 'fb-post-preserve-text'

  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    await snapshotAppConfig(['meta_facebook_comments_enabled'], async () => {
      try {
        await db.run('DELETE FROM meta_social_messages WHERE sender_id = ? OR meta_message_id = ?', [senderId, commentId]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE id = ?', [hashTestId('meta_social_contact', `messenger:${senderId}`)]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_webhook_events WHERE raw_payload_json LIKE ?', [`%${commentId}%`]).catch(() => undefined)
        await setAppConfig('meta_facebook_comments_enabled', '1')

        await processMetaSocialWebhook({
          payload: {
            object: 'page',
            entry: [
              {
                id: 'page-send-test',
                time: 1783180860,
                changes: [
                  {
                    field: 'feed',
                    value: {
                      item: 'comment',
                      verb: 'add',
                      comment_id: commentId,
                      post_id: postId,
                      from: { id: senderId, name: 'Cliente Facebook' },
                      message: 'Quiero informes',
                      created_time: 1783180860
                    }
                  }
                ]
              }
            ]
          }
        })

        await processMetaSocialWebhook({
          payload: {
            object: 'page',
            entry: [
              {
                id: 'page-send-test',
                time: 1783180870,
                changes: [
                  {
                    field: 'feed',
                    value: {
                      item: 'comment',
                      verb: 'add',
                      comment_id: commentId,
                      post_id: postId,
                      from: { id: senderId, name: 'Cliente Facebook' },
                      created_time: 1783180870
                    }
                  }
                ]
              }
            ]
          }
        })

        const stored = await db.get(
          `SELECT message_text, message_type, comment_id, post_id
             FROM meta_social_messages
            WHERE meta_message_id = ?`,
          [commentId]
        )

        assert.equal(stored.message_text, 'Quiero informes')
        assert.equal(stored.message_type, 'comment')
        assert.equal(stored.comment_id, commentId)
        assert.equal(stored.post_id, postId)
      } finally {
        await db.run('DELETE FROM meta_social_messages WHERE sender_id = ? OR meta_message_id = ?', [senderId, commentId]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE id = ?', [hashTestId('meta_social_contact', `messenger:${senderId}`)]).catch(() => undefined)
        await db.run('DELETE FROM meta_social_webhook_events WHERE raw_payload_json LIKE ?', [`%${commentId}%`]).catch(() => undefined)
      }
    })
  })
})

test('processMetaSocialWebhook marca comentarios como eliminados cuando se borra la publicación', async () => {
  const contactId = 'meta_comment_deleted_post_contact'
  const metaContactId = 'meta_comment_deleted_post_profile'
  const commentId = 'fb-comment-deleted-post'
  const postId = 'fb-post-deleted-webhook-test'

  await initializeMasterKey()

  await snapshotMetaConfig(async () => {
    try {
      await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR post_id = ?', [contactId, postId]).catch(() => undefined)
      await db.run('DELETE FROM meta_social_posts WHERE id = ?', [postId]).catch(() => undefined)
      await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

      await db.run(`
        INSERT INTO meta_config (
          ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
          timezone_id, timezone_name, timezone_offset_hours_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        'act-send-test',
        encrypt('user-token-send-test'),
        null,
        'page-send-test',
        'ig-business-send-test',
        null,
        null,
        null
      ])
      await seedMessengerContact({ contactId, metaContactId })

      await db.run(`
        INSERT INTO meta_social_posts (
          id, platform, post_type, message, image_url, permalink, raw_json, fetched_at, updated_at
        ) VALUES (?, 'messenger', 'post', 'Texto previo del post', '', '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [postId])

      await db.run(`
        INSERT INTO meta_social_messages (
          id, platform, meta_message_id, meta_social_contact_id, contact_id,
          sender_id, recipient_id, page_id, direction, status, message_type,
          message_text, message_timestamp, raw_payload_json, comment_id, post_id, updated_at
        ) VALUES (?, 'messenger', ?, ?, ?, 'psid-send-test', 'page-send-test', 'page-send-test', 'inbound', 'received', 'comment',
          'Quiero informes', '2026-07-04T16:00:00.000Z', '{}', ?, ?, CURRENT_TIMESTAMP)
      `, [
        hashTestId('meta_social_msg', commentId),
        commentId,
        metaContactId,
        contactId,
        commentId,
        postId
      ])

      const result = await processMetaSocialWebhook({
        payload: {
          object: 'page',
          entry: [
            {
              id: 'page-send-test',
              time: 1783180860,
              changes: [
                {
                  field: 'feed',
                  value: {
                    item: 'post',
                    verb: 'remove',
                    post_id: postId
                  }
                }
              ]
            }
          ]
        }
      })

      assert.equal(result.messages, 0)

      const stored = await db.get(
        `SELECT message_text, status
           FROM meta_social_messages
          WHERE meta_message_id = ?`,
        [commentId]
      )
      const post = await db.get(
        `SELECT post_type, message
           FROM meta_social_posts
          WHERE id = ?`,
        [postId]
      )

      assert.equal(stored.message_text, 'Comentario eliminado')
      assert.equal(stored.status, 'removed')
      assert.equal(post.post_type, 'deleted')
      assert.equal(post.message, 'Texto previo del post')
    } finally {
      await db.run('DELETE FROM meta_social_messages WHERE contact_id = ? OR post_id = ?', [contactId, postId]).catch(() => undefined)
      await db.run('DELETE FROM meta_social_posts WHERE id = ?', [postId]).catch(() => undefined)
      await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    }
  })
})

test('processMetaSocialWebhook usa conversaciones de Instagram como fallback de nombre sin Page token', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-fallback-test'
  const metaMessageId = 'mid-fallback-test'
  const messageTimestamp = '2026-07-03T23:15:00.000Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}/facebook`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await cleanupSocialRows({ senderId, metaMessageId })
          await seedMetaConfigForInstagramTests()
          await setAppConfig('meta_instagram_messaging_enabled', '1')

          await db.run(`
            INSERT INTO meta_social_messages (
              id, platform, meta_message_id, sender_id, recipient_id, page_id, instagram_account_id,
              direction, message_type, message_text, message_timestamp, raw_payload_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [
            hashTestId('meta_social_msg', metaMessageId),
            'instagram',
            metaMessageId,
            senderId,
            'ig-business-send-test',
            'page-send-test',
            'ig-business-send-test',
            'inbound',
            'text',
            'Hola',
            messageTimestamp,
            '{}'
          ])

          await processMetaSocialWebhook({
            payload: {
              object: 'instagram',
              entry: [
                {
                  id: 'ig-business-send-test',
                  time: 1783110900,
                  messaging: [
                    {
                      sender: { id: senderId },
                      recipient: { id: 'ig-business-send-test' },
                      timestamp: Date.parse(messageTimestamp),
                      message: { mid: metaMessageId, text: 'Hola' }
                    }
                  ]
                }
              ]
            }
          })

          const profile = await db.get(
            'SELECT profile_name, username, profile_picture_url, meta_user_id FROM meta_social_contacts WHERE platform = ? AND sender_id = ?',
            ['instagram', senderId]
          )
          assert.equal(profile.profile_name, 'Nombre Por Conversacion')
          assert.equal(profile.username || '', '')
          assert.equal(profile.profile_picture_url || '', '')
          assert.equal(profile.meta_user_id, senderId)

          const conversationCall = calls.find(call => call.method === 'GET' && call.url.startsWith('/me/conversations?'))
          assert.ok(conversationCall)
          assert.equal(conversationCall.authorization, 'Bearer instagram-token-send-test')
          assert.match(conversationCall.url, /platform=instagram/)
          assert.match(conversationCall.url, /user_id=igsid-fallback-test/)
          assert.equal(calls.some(call => call.url.startsWith('/page-send-test/conversations')), false)
          assert.equal(calls.some(call => call.url.startsWith('/page-send-test?')), false)
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousInstagramGraphDescriptor) Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
  }
})

test('sendMetaSocialTextMessage explica el bloqueo de capability de Instagram DM', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_capability_contact'
  const metaContactId = 'meta_send_capability_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, instagram_access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-test',
            encrypt('user-token-send-test'),
            encrypt('instagram-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_instagram_messaging_enabled', '1')
          await seedInstagramContact({ contactId, metaContactId })

          await assert.rejects(
            () => sendMetaSocialTextMessage({
              contactId,
              platform: 'instagram',
              message: 'Hola'
            }),
            (error) => {
              assert.equal(error.statusCode, 400)
              assert.match(error.message, /Meta bloqueó Instagram DM/)
              assert.match(error.message, /instagram_business_manage_messages/)
              assert.match(error.message, /Instagram API token/)
              assert.equal(error.meta?.actionRequired, 'meta_app_capability')
              assert.equal(error.meta?.graphError?.code, 3)
              assert.equal(error.meta?.graphError?.type, 'OAuthException')
              return true
            }
          )

          assert.equal(calls.length, 1)
          assert.equal(calls[0].method, 'POST')
          assert.equal(calls[0].url, '/ig-business-send-test/messages')
          assert.equal(calls[0].authorization, 'Bearer instagram-token-send-test')
          assert.deepEqual(JSON.parse(calls[0].body), {
            recipient: { id: 'igsid-send-test' },
            message: { text: 'Hola' }
          })
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
    if (previousInstagramGraphDescriptor) {
      Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
    }
  }
})

test('sendMetaSocialTextMessage mantiene Messenger con Page token y messaging_type', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_messenger_contact'
  const metaContactId = 'meta_send_messenger_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-test',
            encrypt('user-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId })

          const result = await sendMetaSocialTextMessage({
            contactId,
            platform: 'messenger',
            message: 'Hola'
          })

          assert.equal(result.remoteMessageId, 'mid-messenger-send-test')
          assert.equal(calls.length, 2)
          assert.equal(calls[0].method, 'GET')
          assert.match(calls[0].url, /^\/page-send-test\?/)
          assert.equal(calls[0].authorization, 'Bearer user-token-send-test')
          assert.equal(calls[1].method, 'POST')
          assert.equal(calls[1].url, '/page-send-test/messages')
          assert.equal(calls[1].authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(calls[1].body), {
            messaging_type: 'RESPONSE',
            recipient: { id: 'psid-send-test' },
            message: { text: 'Hola' }
          })
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
})

test('sendMetaSocialAudioMessage manda audio Messenger con URL pública y lo persiste como audio', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_audio_messenger_contact'
  const metaContactId = 'meta_send_audio_messenger_profile'
  let mediaAssetId = ''

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-audio-test',
            encrypt('user-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId })

          const result = await sendMetaSocialAudioMessage({
            contactId,
            platform: 'messenger',
            audioDataUrl: `data:audio/mp4;base64,${Buffer.from('fake native meta audio').toString('base64')}`,
            durationMs: 1800,
            publicBaseUrl: 'https://ristak.test'
          })
          mediaAssetId = result.localMedia?.mediaAssetId || ''

          assert.equal(result.remoteMessageId, 'mid-messenger-send-test')
          assert.equal(result.audio?.mimeType, 'audio/mp4')
          assert.equal(result.audio?.durationMs, 1800)
          const tokenLookupCall = calls.find(call => call.method === 'GET')
          if (tokenLookupCall) assert.match(tokenLookupCall.url, /^\/page-send-test\?/)
          const sendCall = calls.find(call => call.method === 'POST')
          assert.ok(sendCall)
          assert.equal(sendCall.url, '/page-send-test/messages')
          assert.deepEqual(JSON.parse(sendCall.body), {
            messaging_type: 'RESPONSE',
            recipient: { id: 'psid-send-test' },
            message: {
              attachment: {
                type: 'audio',
                payload: {
                  url: result.audio.url,
                  is_reusable: false
                }
              }
            }
          })

          const row = await db.get(
            `SELECT message_type, message_text, media_url, media_mime_type, raw_payload_json
             FROM meta_social_messages
             WHERE contact_id = ? AND direction = 'outbound'
             ORDER BY message_timestamp DESC
             LIMIT 1`,
            [contactId]
          )
          assert.equal(row.message_type, 'audio')
          assert.equal(row.message_text, '')
          assert.match(row.media_url, /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
          assert.equal(row.media_mime_type, 'audio/mp4')
          assert.equal(JSON.parse(row.raw_payload_json).context.audio.durationMs, 1800)
        } finally {
          if (mediaAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
})

test('sendMetaSocialAudioMessage manda audio Instagram con token directo y lo persiste como audio', async () => {
  const previousInstagramGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'INSTAGRAM_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_audio_instagram_contact'
  const metaContactId = 'meta_send_audio_instagram_profile'
  let mediaAssetId = ''

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, instagram_access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-audio-ig-test',
            encrypt('user-token-send-test'),
            encrypt('instagram-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_instagram_messaging_enabled', '1')
          await seedInstagramContact({ contactId, metaContactId })

          const result = await sendMetaSocialAudioMessage({
            contactId,
            platform: 'instagram',
            audioDataUrl: `data:audio/mp4;base64,${Buffer.from('fake native instagram audio').toString('base64')}`,
            durationMs: 2400,
            publicBaseUrl: 'https://ristak.test'
          })
          mediaAssetId = result.localMedia?.mediaAssetId || ''

          assert.equal(result.remoteMessageId, 'mid-instagram-send-test')
          assert.equal(result.platform, 'instagram')
          assert.equal(result.audio?.mimeType, 'audio/mp4')
          assert.equal(result.audio?.durationMs, 2400)
          assert.equal(calls.length, 1)
          assert.equal(calls[0].method, 'POST')
          assert.equal(calls[0].url, '/ig-business-send-test/messages')
          assert.equal(calls[0].authorization, 'Bearer instagram-token-send-test')
          assert.deepEqual(JSON.parse(calls[0].body), {
            recipient: { id: 'igsid-send-test' },
            message: {
              attachment: {
                type: 'audio',
                payload: {
                  url: result.audio.url,
                  is_reusable: false
                }
              }
            }
          })

          const row = await db.get(
            `SELECT message_type, message_text, media_url, media_mime_type, raw_payload_json
             FROM meta_social_messages
             WHERE contact_id = ? AND platform = 'instagram' AND direction = 'outbound'
             ORDER BY message_timestamp DESC
             LIMIT 1`,
            [contactId]
          )
          assert.equal(row.message_type, 'audio')
          assert.equal(row.message_text, '')
          assert.match(row.media_url, /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
          assert.equal(row.media_mime_type, 'audio/mp4')
          assert.equal(JSON.parse(row.raw_payload_json).context.audio.durationMs, 2400)
        } finally {
          if (mediaAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousInstagramGraphDescriptor) {
      Object.defineProperty(API_URLS, 'INSTAGRAM_GRAPH', previousInstagramGraphDescriptor)
    }
  }
})

test('sendMetaSocialTextMessage envia reply_to para contestar un globo de Messenger', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_reply_messenger_contact'
  const metaContactId = 'meta_send_reply_messenger_profile'
  const targetMessageId = 'mid-messenger-reply-target'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-reply-test',
            encrypt('user-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId })
          await db.run(`
            INSERT INTO meta_social_messages (
              id, platform, meta_message_id, meta_social_contact_id, contact_id,
              sender_id, recipient_id, page_id, direction, status, message_type, message_text,
              message_timestamp, raw_payload_json, updated_at
            ) VALUES (?, 'messenger', ?, ?, ?, 'psid-send-test', 'page-send-test', 'page-send-test', 'inbound', 'received', 'text', 'Mensaje base', CURRENT_TIMESTAMP, '{}', CURRENT_TIMESTAMP)
          `, ['meta_reply_target_local', targetMessageId, metaContactId, contactId])

          await sendMetaSocialTextMessage({
            contactId,
            platform: 'messenger',
            message: 'Contestando',
            replyToMessageId: 'meta_reply_target_local'
          })

          assert.deepEqual(JSON.parse(calls.at(-1).body), {
            messaging_type: 'RESPONSE',
            recipient: { id: 'psid-send-test' },
            message: {
              text: 'Contestando',
              reply_to: { mid: targetMessageId }
            }
          })
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
})

test('sendMetaSocialReactionMessage envia sender_action react para Messenger', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_reaction_messenger_contact'
  const metaContactId = 'meta_send_reaction_messenger_profile'
  const targetMessageId = 'mid-messenger-reaction-target'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

          await db.run(`
            INSERT INTO meta_config (
              ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
              timezone_id, timezone_name, timezone_offset_hours_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            'act-send-reaction-test',
            encrypt('user-token-send-test'),
            null,
            'page-send-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId })
          await db.run(`
            INSERT INTO meta_social_messages (
              id, platform, meta_message_id, meta_social_contact_id, contact_id,
              sender_id, recipient_id, page_id, direction, status, message_type, message_text,
              message_timestamp, raw_payload_json, updated_at
            ) VALUES (?, 'messenger', ?, ?, ?, 'psid-send-test', 'page-send-test', 'page-send-test', 'inbound', 'received', 'text', 'Mensaje base', CURRENT_TIMESTAMP, '{}', CURRENT_TIMESTAMP)
          `, ['meta_reaction_target_local', targetMessageId, metaContactId, contactId])

          await sendMetaSocialReactionMessage({
            contactId,
            platform: 'messenger',
            emoji: '❤️',
            targetMessageId: 'meta_reaction_target_local'
          })

          assert.deepEqual(JSON.parse(calls.at(-1).body), {
            recipient: { id: 'psid-send-test' },
            sender_action: 'react',
            payload: {
              message_id: targetMessageId,
              reaction: 'love'
            }
          })
        } finally {
          await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
})
