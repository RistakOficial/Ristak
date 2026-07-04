import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  processMetaSocialWebhook,
  sendMetaSocialTextMessage
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

      if (req.method === 'GET' && req.url.startsWith('/page-send-test')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-send-test' }))
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

      if (req.method === 'GET' && req.url.startsWith('/me/conversations')) {
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

      if (req.method === 'POST' && req.url.startsWith('/page-send-test/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ recipient_id: 'psid-send-test', message_id: 'mid-messenger-send-test' }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/ig-business-send-test/messages')) {
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
