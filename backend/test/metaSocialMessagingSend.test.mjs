import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { sendMetaSocialTextMessage } from '../src/services/metaSocialMessagingService.js'

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
              assert.match(error.message, /Instagram User access token/)
              assert.equal(error.meta?.actionRequired, 'meta_app_capability')
              assert.equal(error.meta?.graphError?.code, 3)
              assert.equal(error.meta?.graphError?.type, 'OAuthException')
              return true
            }
          )

          assert.equal(calls.length, 1)
          assert.equal(calls[0].method, 'POST')
          assert.equal(calls[0].url, '/ig-business-send-test/messages')
          assert.equal(calls[0].authorization, 'Bearer user-token-send-test')
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
