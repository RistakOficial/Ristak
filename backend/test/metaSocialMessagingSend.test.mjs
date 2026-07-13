import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { encrypt, initializeMasterKey, isEncrypted } from '../src/utils/encryption.js'
import {
  enableMetaSocialChannelsForConnectedProfiles,
  getMetaConfig,
  getMetaDeveloperSetup,
  saveMetaMessengerUserToken
} from '../src/services/metaAdsService.js'
import {
  processMetaSocialWebhook,
  ensureMetaPageMessagingSubscription,
  reconcileMetaPageMessagingSubscription,
  resolveMetaPageAccessToken,
  sendMetaSocialAttachmentMessage,
  sendMetaSocialAudioMessage,
  sendMetaSocialCommentReply,
  sendMetaSocialReactionMessage,
  sendMetaSocialTextMessage,
  setMetaSocialGraphTimeoutForTest,
  setMetaSocialOutboundMediaTransportForTest,
  syncMetaSocialConversationHistory
} from '../src/services/metaSocialMessagingService.js'

const execFile = promisify(execFileCallback)
const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlIC9QYWdlcyAvQ291bnQgMD4+CmVuZG9iago='

function createPcmWavBuffer() {
  const sampleRate = 8_000
  const sampleCount = 2_000
  const dataSize = sampleCount * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8_000)
    buffer.writeInt16LE(value, 44 + (index * 2))
  }
  return buffer
}

let validMp3DataUrlPromise
async function getValidMp3DataUrl() {
  if (!validMp3DataUrlPromise) {
    validMp3DataUrlPromise = (async () => {
      const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-meta-mp3-'))
      const outputPath = join(folder, 'audio.mp3')
      try {
        await execFile(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi',
          '-i', 'sine=frequency=523:duration=0.35',
          '-ac', '1',
          '-ar', '22050',
          '-c:a', 'libmp3lame',
          '-b:a', '48k',
          outputPath
        ])
        const bytes = await fs.readFile(outputPath)
        return `data:audio/mpeg;base64,${bytes.toString('base64')}`
      } finally {
        await fs.rm(folder, { recursive: true, force: true })
      }
    })()
  }
  return validMp3DataUrlPromise
}

let validMp4VideoDataUrlPromise
async function getValidMp4VideoDataUrl() {
  if (!validMp4VideoDataUrlPromise) {
    validMp4VideoDataUrlPromise = (async () => {
      const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-meta-video-'))
      const outputPath = join(folder, 'video.mp4')
      try {
        await execFile(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi',
          '-i', 'color=c=0x2463eb:s=32x32:d=0.35',
          '-vf', 'format=yuv420p',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-movflags', '+faststart',
          '-an',
          outputPath
        ])
        const bytes = await fs.readFile(outputPath)
        return `data:video/mp4;base64,${bytes.toString('base64')}`
      } finally {
        await fs.rm(folder, { recursive: true, force: true })
      }
    })()
  }
  return validMp4VideoDataUrlPromise
}

let validWebmAudioDataUrlPromise
async function getValidWebmAudioDataUrl() {
  if (!validWebmAudioDataUrlPromise) {
    validWebmAudioDataUrlPromise = (async () => {
      const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-meta-webm-audio-'))
      const outputPath = join(folder, 'voice.webm')
      try {
        await execFile(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi',
          '-i', 'sine=frequency=659:duration=0.35',
          '-ac', '1',
          '-ar', '48000',
          '-c:a', 'libopus',
          '-b:a', '48k',
          outputPath
        ])
        const bytes = await fs.readFile(outputPath)
        return `data:audio/webm;base64,${bytes.toString('base64')}`
      } finally {
        await fs.rm(folder, { recursive: true, force: true })
      }
    })()
  }
  return validWebmAudioDataUrlPromise
}

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

async function startMetaSendServer(calls, { beforeMessageResponse } = {}) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      calls.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization || '' })

      if (req.method === 'GET' && /^\/debug_token(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: { is_valid: true, app_id: 'app-developer-setup-test', scopes: ['pages_messaging'] } }))
        return
      }

      if (req.method === 'GET' && /^\/app-developer-setup-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ business: { id: 'business-developer-setup-test' } }))
        return
      }

      if (req.method === 'GET' && /^\/page-messenger-user-token-test(?:\?|$)/.test(req.url)) {
        const pageToken = req.headers.authorization === 'Bearer messenger-user-token-test'
          ? 'page-token-from-messenger-user'
          : 'page-token-from-system-user'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: pageToken }))
        return
      }

      if (req.method === 'GET' && /^\/page-send-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-send-test' }))
        return
      }

      if (req.method === 'GET' && /^\/page-refresh-test(?:\?|$)/.test(req.url)) {
        const sourceToken = req.headers.authorization === 'Bearer user-token-refresh-new'
          ? 'page-token-refresh-new'
          : 'page-token-refresh-old'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: sourceToken }))
        return
      }

      if (req.method === 'GET' && /^\/page-permission-retry-test(?:\?|$)/.test(req.url)) {
        const derivations = calls.filter(call => call.method === 'GET' && /^\/page-permission-retry-test(?:\?|$)/.test(call.url)).length
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: derivations === 1 ? 'page-token-stale' : 'page-token-fresh' }))
        return
      }

      if (req.method === 'GET' && /^\/page-history-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-history-test' }))
        return
      }

      if (req.method === 'GET' && /^\/page-subscription-test(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'page-token-subscription-test' }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/page-subscription-test/subscribed_apps')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
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
              to: { data: [{ id: 'page-history-test', name: 'Ristak Page' }] },
              attachments: { data: [
                { type: 'image', image_data: { url: 'https://assets.example.test/history-1.jpg' }, mime_type: 'image/jpeg' },
                { type: 'file', file_data: { url: 'https://assets.example.test/history-2.pdf' }, mime_type: 'application/pdf', name: 'expediente.pdf' }
              ] }
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

      if (
        req.method === 'GET' &&
        (req.url.startsWith('/ig-business-history-test/conversations') || req.url.startsWith('/ig-business-send-test/conversations'))
      ) {
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
        const parsedBody = JSON.parse(body || '{}')
        if (parsedBody?.message?.text === 'Forzar capability') {
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
        const isInstagramRecipient = parsedBody?.recipient?.id === 'igsid-send-test' || parsedBody?.recipient?.comment_id
        if (typeof beforeMessageResponse === 'function') {
          await beforeMessageResponse({ parsedBody, isInstagramRecipient })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          recipient_id: isInstagramRecipient ? 'igsid-send-test' : 'psid-send-test',
          message_id: isInstagramRecipient ? 'mid-instagram-page-send-test' : 'mid-messenger-send-test'
        }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/page-permission-retry-test/messages')) {
        if (req.headers.authorization === 'Bearer page-token-stale') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: {
              message: '(#200) Requires pages_messaging permission to manage the object.',
              type: 'OAuthException',
              code: 200,
              fbtrace_id: 'trace-permission-retry-test'
            }
          }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ recipient_id: 'psid-send-test', message_id: 'mid-permission-retry-test' }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/fb-comment-permission-test/comments')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: '(#200) Requires pages_manage_engagement permission to manage the object.',
            type: 'OAuthException',
            code: 200,
            fbtrace_id: 'trace-comment-permission-test'
          }
        }))
        return
      }

      if (req.method === 'POST' && req.url.startsWith('/fb-comment-success-test/comments')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'fb-comment-reply-success-test' }))
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

async function seedMessengerContact({ contactId, metaContactId, pageId = 'page-send-test' }) {
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
      pageId,
      null,
      'Messenger Test'
    ]
  )
}

async function seedMetaConfigForInstagramTests() {
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
}

async function cleanupMetaMediaSendHarness({ contactId, platform }) {
  const senderId = platform === 'instagram' ? 'igsid-send-test' : 'psid-send-test'
  const derivedContactId = hashTestId('meta_social_contact', `${platform}:${senderId}`)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id IN (?, ?)', [contactId, derivedContactId]).catch(() => undefined)
  await db.run(
    'DELETE FROM meta_social_contacts WHERE contact_id = ? OR (platform = ? AND sender_id = ?)',
    [contactId, platform, senderId]
  ).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [contactId, derivedContactId]).catch(() => undefined)
}

async function withMetaMediaSendHarness({ platform, testId, downloader, beforeMessageResponse, enabledKey: requestedEnabledKey }, callback) {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  const uploads = []
  let metaServer
  const contactId = `meta_media_${platform}_${testId}_contact`
  const metaContactId = `meta_media_${platform}_${testId}_profile`
  const enabledKey = requestedEnabledKey || (platform === 'instagram'
    ? 'meta_instagram_messaging_enabled'
    : 'meta_messenger_messaging_enabled')

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls, { beforeMessageResponse })
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig([enabledKey], async () => {
        await cleanupMetaMediaSendHarness({ contactId, platform })
        await seedMetaConfigForInstagramTests()
        await setAppConfig(enabledKey, '1')
        if (platform === 'instagram') {
          await seedInstagramContact({ contactId, metaContactId })
        } else {
          await seedMessengerContact({ contactId, metaContactId })
        }

        setMetaSocialOutboundMediaTransportForTest({
          ...(typeof downloader === 'function' ? { downloader } : {}),
          uploader: async (input) => {
            uploads.push(input)
            const publicUrl = `https://media.ristak.test/${encodeURIComponent(testId)}/${uploads.length}`
            return {
              id: `media-asset-${testId}-${uploads.length}`,
              publicUrl,
              publicPath: publicUrl,
              mimeType: input.mimeType,
              originalFilename: input.filename,
              storedFilename: input.filename,
              sizeProcessed: input.buffer.length
            }
          }
        })

        try {
          await callback({ calls, uploads, contactId, metaContactId })
        } finally {
          setMetaSocialOutboundMediaTransportForTest()
          await cleanupMetaMediaSendHarness({ contactId, platform })
        }
      })
    })
  } finally {
    setMetaSocialOutboundMediaTransportForTest()
    await cleanupMetaMediaSendHarness({ contactId, platform })
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
}

function getMetaMessagePosts(calls) {
  return calls.filter(call => call.method === 'POST' && call.url === '/page-send-test/messages')
}

function assertPreparedMp4(upload, kind) {
  assert.ok(upload)
  assert.equal(upload.mimeType, kind === 'audio' ? 'audio/mp4' : 'video/mp4')
  assert.ok(Buffer.isBuffer(upload.buffer))
  assert.ok(upload.buffer.length > 100)
  assert.ok(upload.buffer.includes(Buffer.from('ftyp', 'ascii')))
}

async function cleanupSocialRows({ senderId, metaMessageId }) {
  const contactId = hashTestId('meta_social_contact', `instagram:${senderId}`)
  await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE sender_id = ? OR meta_message_id = ?', [senderId, metaMessageId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_webhook_events WHERE raw_payload_json LIKE ?', [`%${metaMessageId}%`]).catch(() => undefined)
}

test('ensureMetaPageMessagingSubscription conserva todos los eventos necesarios para inbox e historial vivo', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await db.run(`
        INSERT INTO meta_config (
          ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
          timezone_id, timezone_name, timezone_offset_hours_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        'act-subscription-test',
        encrypt('user-token-subscription-test'),
        null,
        'page-subscription-test',
        null,
        null,
        null,
        null
      ])

      const result = await ensureMetaPageMessagingSubscription()
      const expectedFields = [
        'messages',
        'message_echoes',
        'message_edits',
        'message_reactions',
        'message_reads',
        'message_deliveries',
        'messaging_postbacks',
        'messaging_referrals',
        'feed'
      ]

      assert.equal(result.pageId, 'page-subscription-test')
      assert.deepEqual(result.subscribedFields, expectedFields)

      const subscriptionCall = calls.find(call => (
        call.method === 'POST' && call.url.startsWith('/page-subscription-test/subscribed_apps')
      ))
      assert.equal(subscriptionCall?.authorization, 'Bearer page-token-subscription-test')
      const subscriptionUrl = new URL(subscriptionCall.url, 'http://127.0.0.1')
      assert.equal(subscriptionUrl.searchParams.get('subscribed_fields'), expectedFields.join(','))
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('reconcileMetaPageMessagingSubscription actualiza instalaciones existentes sólo si Messenger está activo', async () => {
  let ensureCalls = 0
  const skipped = await reconcileMetaPageMessagingSubscription({
    isMessengerEnabled: async (platform) => {
      assert.equal(platform, 'messenger')
      return false
    },
    ensureSubscription: async () => {
      ensureCalls += 1
      return { pageId: 'should-not-run' }
    }
  })

  assert.deepEqual(skipped, { skipped: true, reason: 'messenger-disabled' })
  assert.equal(ensureCalls, 0)

  const reconciled = await reconcileMetaPageMessagingSubscription({
    isMessengerEnabled: async () => true,
    ensureSubscription: async () => {
      ensureCalls += 1
      return {
        pageId: 'page-existing-connection',
        subscribedFields: ['messages', 'message_deliveries']
      }
    }
  })

  assert.deepEqual(reconciled, {
    skipped: false,
    pageId: 'page-existing-connection',
    subscribedFields: ['messages', 'message_deliveries']
  })
  assert.equal(ensureCalls, 1)
})

test('Messenger usa su User Token humano y arma enlaces de Developers con la app configurada', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const previousMetaTokenDebugDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_TOKEN_DEBUG')
  const calls = []
  let metaServer

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    const graphBase = `http://127.0.0.1:${metaServer.address().port}`
    Object.defineProperty(API_URLS, 'META_GRAPH', { value: graphBase, configurable: true })
    Object.defineProperty(API_URLS, 'META_TOKEN_DEBUG', { value: `${graphBase}/debug_token`, configurable: true })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig([
        'meta_messenger_messaging_enabled',
        'meta_facebook_comments_enabled',
        'meta_instagram_messaging_enabled',
        'meta_instagram_comments_enabled'
      ], async () => {
        await db.run(`
        INSERT INTO meta_config (
          ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
          timezone_id, timezone_name, timezone_offset_hours_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        'act-messenger-user-token-test',
        encrypt('system-user-token-test'),
        null,
        'page-messenger-user-token-test',
        'ig-business-user-token-test',
        null,
        null,
        null
      ])

        await saveMetaMessengerUserToken('messenger-user-token-test')
        const rawConfig = await db.get('SELECT messenger_user_token FROM meta_config LIMIT 1')
        assert.equal(isEncrypted(rawConfig?.messenger_user_token), true)

        const config = await getMetaConfig()
        assert.equal(config?.messenger_user_token, 'messenger-user-token-test')

        const enabledChannels = await enableMetaSocialChannelsForConnectedProfiles(config)
        assert.deepEqual(enabledChannels, {
          messengerMessaging: true,
          facebookComments: true,
          instagramMessaging: true,
          instagramComments: true
        })
        for (const key of [
          'meta_messenger_messaging_enabled',
          'meta_facebook_comments_enabled',
          'meta_instagram_messaging_enabled',
          'meta_instagram_comments_enabled'
        ]) {
          const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [key])
          assert.equal(row?.config_value, '1')
        }

        const messengerPageToken = await resolveMetaPageAccessToken({ config, platform: 'messenger' })
        const instagramPageToken = await resolveMetaPageAccessToken({ config, platform: 'instagram' })
        assert.equal(messengerPageToken, 'page-token-from-messenger-user')
        assert.equal(instagramPageToken, 'page-token-from-system-user')

        const setup = await getMetaDeveloperSetup()
        assert.equal(setup.appId, 'app-developer-setup-test')
        assert.equal(setup.businessId, 'business-developer-setup-test')
        assert.equal(setup.messengerUserTokenConfigured, true)
        assert.match(setup.messengerUrl, /use_case_enum=FACEBOOK_MESSAGING/)
        assert.match(setup.messengerUrl, /business_id=business-developer-setup-test/)
        assert.match(setup.instagramUrl, /use_case_enum=INSTAGRAM_BUSINESS/)
        assert.match(setup.instagramUrl, /selected_tab=API-Setup/)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    if (previousMetaTokenDebugDescriptor) Object.defineProperty(API_URLS, 'META_TOKEN_DEBUG', previousMetaTokenDebugDescriptor)
  }
})

test('syncMetaSocialConversationHistory importa historial disponible de Messenger al chat', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
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

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_messenger_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
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
          assert.equal(result.saved, 3)
          assert.equal(result.messagesScanned, 2)

          const rows = await db.all(`
            SELECT meta_message_id, direction, sender_id, recipient_id, page_id, message_text, platform, media_url
            FROM meta_social_messages
            WHERE sender_id = ?
            ORDER BY message_timestamp ASC
          `, [senderId])
          assert.equal(rows.length, 3)
          assert.deepEqual(rows.map(row => row.meta_message_id), [
            'mid-history-inbound',
            'mid-history-inbound:attachment:1',
            'mid-history-outbound'
          ])
          assert.deepEqual(rows.map(row => row.direction), ['inbound', 'inbound', 'outbound'])
          assert.deepEqual(rows.slice(0, 2).map(row => row.media_url), [
            'https://assets.example.test/history-1.jpg',
            'https://assets.example.test/history-2.pdf'
          ])
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
          assert.equal(profile.profile_picture_url, null)

          assert.equal(calls.some(call => call.url.startsWith('/page-history-test/conversations')), true)
          assert.equal(calls.some(call => call.url.startsWith(`/${senderId}?`)), false)
          const messagesCall = calls.find(call => call.url.startsWith('/conversation-messenger-history/messages'))
          assert.equal(messagesCall?.authorization, 'Bearer page-token-history-test')
        } finally {
          await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('syncMetaSocialConversationHistory importa historial disponible de Instagram con Page token derivado', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
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

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_messaging_enabled'], async () => {
        try {
          await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
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
          assert.equal(profile.profile_picture_url, null)

          const conversationsCall = calls.find(call => call.url.startsWith('/ig-business-history-test/conversations'))
          assert.equal(conversationsCall?.authorization, 'Bearer page-token-history-test')
          assert.equal(calls.some(call => call.url.startsWith('/me/conversations')), false)
          assert.equal(calls.some(call => call.url.startsWith(`/${senderId}?`)), false)
          const messagesCall = calls.find(call => call.url.startsWith('/conversation-instagram-history/messages'))
          assert.equal(messagesCall?.authorization, 'Bearer page-token-history-test')
        } finally {
          await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_messages WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM meta_social_contacts WHERE sender_id = ?', [senderId]).catch(() => undefined)
          await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('processMetaSocialWebhook enriquece DMs de Instagram con Page token derivado', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-profile-test'
  const metaMessageId = 'mid-profile-test'
  const messageTimestamp = '2026-07-03T22:38:10.003Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
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
            signaturePreverified: true,
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
          assert.equal(profileCall.authorization, 'Bearer page-token-send-test')
          assert.match(profileCall.url, /fields=name%2Cusername%2Cprofile_pic/)
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('processMetaSocialWebhook enriquece comentarios de Instagram con perfil del autor', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-comment-test'
  const metaMessageId = 'ig-comment-profile-test'
  const messageTimestamp = '2026-07-03T23:00:00.000Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
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
            signaturePreverified: true,
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
          assert.equal(profileCall.authorization, 'Bearer page-token-send-test')
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
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
          signaturePreverified: true,
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
          signaturePreverified: true,
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
          signaturePreverified: true,
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
        signaturePreverified: true,
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

test('processMetaSocialWebhook usa conversaciones de Instagram como fallback de nombre con Page token', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const senderId = 'igsid-fallback-test'
  const metaMessageId = 'mid-fallback-test'
  const messageTimestamp = '2026-07-03T23:15:00.000Z'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
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
            signaturePreverified: true,
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

          const conversationCall = calls.find(call => call.method === 'GET' && call.url.startsWith('/ig-business-send-test/conversations?'))
          assert.ok(conversationCall)
          assert.equal(conversationCall.authorization, 'Bearer page-token-send-test')
          assert.match(conversationCall.url, /platform=instagram/)
          assert.match(conversationCall.url, /user_id=igsid-fallback-test/)
          assert.equal(calls.some(call => call.url.startsWith('/me/conversations')), false)
          assert.equal(calls.some(call => call.url.startsWith('/page-send-test/conversations')), false)
          assert.equal(calls.some(call => call.url.startsWith('/facebook/')), false)
        } finally {
          await cleanupSocialRows({ senderId, metaMessageId })
        }
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('sendMetaSocialTextMessage explica el bloqueo de capability de Instagram DM', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
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
              message: 'Forzar capability'
            }),
            (error) => {
              assert.equal(error.statusCode, 400)
              assert.match(error.message, /Meta bloqueó Instagram DM/)
              assert.match(error.message, /instagram_manage_messages/)
              assert.match(error.message, /Página/)
              assert.equal(error.meta?.actionRequired, 'meta_app_capability')
              assert.equal(error.meta?.graphError?.code, 3)
              assert.equal(error.meta?.graphError?.type, 'OAuthException')
              return true
            }
          )

          const sendCall = calls.find(call => call.method === 'POST' && call.url === '/page-send-test/messages')
          assert.ok(sendCall)
          assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(sendCall.body), {
            recipient: { id: 'igsid-send-test' },
            message: { text: 'Forzar capability' }
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

test('sendMetaSocialTextMessage manda Instagram con Page token derivado', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_send_instagram_page_token_contact'
  const metaContactId = 'meta_send_instagram_page_token_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
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

          const result = await sendMetaSocialTextMessage({
            contactId,
            platform: 'instagram',
            message: 'Hola por IG con Page token'
          })

          assert.equal(result.remoteMessageId, 'mid-instagram-page-send-test')
          assert.equal(result.platform, 'instagram')

          const sendCall = calls.find(call => call.method === 'POST' && call.url.startsWith('/page-send-test/messages'))
          assert.ok(sendCall)
          assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(sendCall.body), {
            recipient: { id: 'igsid-send-test' },
            message: { text: 'Hola por IG con Page token' }
          })
          assert.equal(calls.some(call => call.url.startsWith('/ig-business-send-test/messages')), false)
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

test('sendMetaSocialCommentReply manda privado Instagram con Page token derivado', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_comment_instagram_page_token_contact'
  const metaContactId = 'meta_comment_instagram_page_token_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_instagram_comments_enabled'], async () => {
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
          await setAppConfig('meta_instagram_comments_enabled', '1')
          await seedInstagramContact({ contactId, metaContactId })

          const result = await sendMetaSocialCommentReply({
            contactId,
            platform: 'instagram',
            message: 'Te escribo por DM',
            replyType: 'private',
            commentId: 'ig-comment-page-token-test',
            postId: 'ig-media-page-token-test'
          })

          assert.equal(result.remoteMessageId, 'mid-instagram-page-send-test')
          assert.equal(result.platform, 'instagram')

          const sendCall = calls.find(call => call.method === 'POST' && call.url.startsWith('/page-send-test/messages'))
          assert.ok(sendCall)
          assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(sendCall.body), {
            recipient: { comment_id: 'ig-comment-page-token-test' },
            message: { text: 'Te escribo por DM' }
          })
          assert.equal(calls.some(call => call.url.startsWith('/ig-business-send-test/messages')), false)
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

test('sendMetaSocialCommentReply rechaza adjuntos privados de Instagram antes de subir o llamar Graph', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'comment-private-text-only',
    enabledKey: 'meta_instagram_comments_enabled'
  }, async ({ calls, uploads, contactId }) => {
    const fixtures = [
      {
        type: 'image',
        url: ONE_PIXEL_PNG_DATA_URL,
        mimeType: 'image/png',
        filename: 'respuesta.png'
      },
      {
        type: 'audio',
        url: await getValidWebmAudioDataUrl(),
        mimeType: 'audio/webm',
        filename: 'respuesta.webm'
      },
      {
        type: 'file',
        url: PDF_DATA_URL,
        mimeType: 'application/pdf',
        filename: 'respuesta.pdf'
      }
    ]

    for (const [index, attachment] of fixtures.entries()) {
      await assert.rejects(
        sendMetaSocialCommentReply({
          contactId,
          platform: 'instagram',
          replyType: 'private',
          commentId: 'ig-comment-private-text-only',
          postId: 'ig-media-private-text-only',
          attachment,
          externalId: `ig-comment-private-media-${index}`
        }),
        (error) => {
          assert.equal(error.statusCode, 422)
          assert.match(error.message, /texto/i)
          return true
        }
      )
    }

    assert.equal(uploads.length, 0)
    assert.equal(getMetaMessagePosts(calls).length, 0)
  })
})

test('sendMetaSocialCommentReply restringe a texto los adjuntos privados de Messenger', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'comment-private-text-only',
    enabledKey: 'meta_facebook_comments_enabled'
  }, async ({ calls, uploads, contactId }) => {
    const fixtures = [
      { type: 'image', url: ONE_PIXEL_PNG_DATA_URL, mimeType: 'image/png', filename: 'respuesta.png' },
      { type: 'file', url: PDF_DATA_URL, mimeType: 'application/pdf', filename: 'respuesta.pdf' }
    ]

    for (const [index, attachment] of fixtures.entries()) {
      await assert.rejects(
        sendMetaSocialCommentReply({
          contactId,
          platform: 'messenger',
          replyType: 'private',
          commentId: 'fb-comment-private-text-only',
          postId: 'page-send-test_456',
          attachment,
          externalId: `fb-comment-private-media-${index}`
        }),
        (error) => {
          assert.equal(error.statusCode, 422)
          assert.match(error.message, /texto/i)
          return true
        }
      )
    }

    assert.equal(uploads.length, 0)
    assert.equal(getMetaMessagePosts(calls).length, 0)
  })
})

test('sendMetaSocialCommentReply deduplica dos respuestas privadas de texto concurrentes', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'comment-private-concurrent',
    enabledKey: 'meta_facebook_comments_enabled',
    beforeMessageResponse: async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }, async ({ calls, uploads, contactId }) => {
    const payload = {
      contactId,
      platform: 'messenger',
      message: 'Respuesta privada idempotente',
      replyType: 'private',
      commentId: 'fb-comment-private-concurrent',
      postId: 'page-send-test_789',
      externalId: 'fb-comment-private-concurrent-external-id'
    }

    const [first, second] = await Promise.all([
      sendMetaSocialCommentReply(payload),
      sendMetaSocialCommentReply(payload)
    ])

    assert.equal(first.remoteMessageId, second.remoteMessageId)
    assert.equal(getMetaMessagePosts(calls).length, 1)
    assert.equal(uploads.length, 0)

    const rows = await db.all(
      `SELECT id, raw_payload_json
       FROM meta_social_messages
       WHERE contact_id = ? AND direction = 'outbound'`,
      [contactId]
    )
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0].raw_payload_json).externalId, payload.externalId)
  })
})

test('timeout de respuesta privada a comentario queda send_unknown y no repite el POST', async () => {
  setMetaSocialGraphTimeoutForTest(30)
  try {
    await withMetaMediaSendHarness({
      platform: 'instagram',
      testId: 'comment-private-timeout',
      enabledKey: 'meta_instagram_comments_enabled',
      beforeMessageResponse: async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
      }
    }, async ({ calls, contactId }) => {
      const payload = {
        contactId,
        platform: 'instagram',
        message: 'Respuesta privada con timeout',
        replyType: 'private',
        commentId: 'ig-comment-private-timeout',
        postId: 'ig-media-private-timeout',
        externalId: 'ig-comment-private-timeout-external-id'
      }

      await assert.rejects(
        sendMetaSocialCommentReply(payload),
        error => error.statusCode === 504 && error.meta?.code === 'meta_graph_timeout'
      )

      const reservation = await db.get(
        "SELECT status FROM meta_social_messages WHERE contact_id = ? AND direction = 'outbound'",
        [contactId]
      )
      assert.equal(reservation.status, 'send_unknown')

      await assert.rejects(
        sendMetaSocialCommentReply(payload),
        error => error.statusCode === 409 && error.meta?.code === 'meta_send_delivery_unknown'
      )
      assert.equal(getMetaMessagePosts(calls).length, 1)
    })
  } finally {
    setMetaSocialGraphTimeoutForTest()
  }
})

test('sendMetaSocialCommentReply prepara imagen y usa attachment_url en comentario público Facebook', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'public-comment-image',
    enabledKey: 'meta_facebook_comments_enabled'
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialCommentReply({
      contactId,
      platform: 'messenger',
      message: 'Foto lista',
      replyType: 'public',
      commentId: 'fb-comment-success-test',
      postId: 'page-send-test_post-1',
      attachment: {
        type: 'image',
        dataUrl: ONE_PIXEL_PNG_DATA_URL,
        mimeType: 'image/png',
        filename: 'comentario.png'
      },
      externalId: 'public-comment-image-1',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.remoteMessageId, 'fb-comment-reply-success-test')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].mimeType, 'image/jpeg')
    assert.equal(uploads[0].filename, 'meta-image.jpg')

    const sendCall = calls.find(call => call.method === 'POST' && call.url === '/fb-comment-success-test/comments')
    assert.ok(sendCall)
    assert.deepEqual(JSON.parse(sendCall.body), {
      message: 'Foto lista',
      attachment_url: 'https://media.ristak.test/public-comment-image/1'
    })

    const row = await db.get(
      `SELECT status, message_type, media_url, media_mime_type
       FROM meta_social_messages
       WHERE contact_id = ? AND direction = 'outbound'
       ORDER BY message_timestamp DESC
       LIMIT 1`,
      [contactId]
    )
    assert.equal(row.status, 'sent')
    assert.equal(row.message_type, 'comment_reply_public')
    assert.equal(row.media_url, 'https://media.ristak.test/public-comment-image/1')
    assert.equal(row.media_mime_type, 'image/jpeg')
  })
})

test('sendMetaSocialCommentReply explica permiso faltante para comentario publico Facebook', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_comment_facebook_permission_contact'
  const metaContactId = 'meta_comment_facebook_permission_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(['meta_facebook_comments_enabled'], async () => {
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
            null,
            null,
            null,
            null
          ])
          await setAppConfig('meta_facebook_comments_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId })

          await assert.rejects(
            () => sendMetaSocialCommentReply({
              contactId,
              platform: 'messenger',
              message: 'Respuesta publica',
              replyType: 'public',
              commentId: 'fb-comment-permission-test',
              postId: 'page-send-test_123'
            }),
            (error) => {
              assert.equal(error.statusCode, 400)
              assert.match(error.message, /respuesta pública al comentario de Facebook/)
              assert.match(error.message, /pages_manage_engagement/)
              assert.doesNotMatch(error.message, /pages_messaging/)
              assert.equal(error.meta?.actionRequired, 'meta_permissions')
              assert.equal(error.meta?.graphError?.code, 200)
              return true
            }
          )

          const sendCall = calls.find(call => call.method === 'POST' && call.url === '/fb-comment-permission-test/comments')
          assert.ok(sendCall)
          assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(sendCall.body), { message: 'Respuesta publica' })
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
          const sendCall = calls.find(call => call.method === 'POST' && call.url === '/page-send-test/messages')
          assert.ok(sendCall)
          assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
          assert.deepEqual(JSON.parse(sendCall.body), {
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

test('sendMetaSocialAttachmentMessage manda una imagen de Messenger sin requerir texto', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'image-data-url'
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'messenger',
      attachmentType: 'image',
      attachmentDataUrl: ONE_PIXEL_PNG_DATA_URL,
      mimeType: 'image/png',
      filename: 'captura.png',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.remoteMessageId, 'mid-messenger-send-test')
    assert.equal(result.attachment.type, 'image')
    assert.equal(result.attachment.mimeType, 'image/jpeg')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].mimeType, 'image/jpeg')
    assert.equal(uploads[0].filename, 'meta-image.jpg')
    assert.ok(uploads[0].buffer.length > 100)

    const [sendCall] = getMetaMessagePosts(calls)
    assert.ok(sendCall)
    assert.deepEqual(JSON.parse(sendCall.body), {
      messaging_type: 'RESPONSE',
      recipient: { id: 'psid-send-test' },
      message: {
        attachment: {
          type: 'image',
          payload: {
            url: result.attachment.url,
            is_reusable: false
          }
        }
      }
    })

    const row = await db.get(
      `SELECT message_type, message_text, media_url, media_mime_type
       FROM meta_social_messages
       WHERE contact_id = ? AND direction = 'outbound'
       ORDER BY message_timestamp DESC
       LIMIT 1`,
      [contactId]
    )
    assert.equal(row.message_type, 'image')
    assert.equal(row.message_text, '')
    assert.equal(row.media_url, result.attachment.url)
    assert.equal(row.media_mime_type, 'image/jpeg')
  })
})

test('sendMetaSocialAudioMessage manda audio Messenger con URL pública y lo persiste como audio', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'audio-wav'
  }, async ({ calls, uploads, contactId }) => {
    const wav = createPcmWavBuffer()
    const result = await sendMetaSocialAudioMessage({
      contactId,
      platform: 'messenger',
      audioDataUrl: `data:audio/wav;base64,${wav.toString('base64')}`,
      audioMimeType: 'audio/wav',
      filename: 'nota.wav',
      durationMs: 1800,
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.remoteMessageId, 'mid-messenger-send-test')
    assert.equal(result.audio?.mimeType, 'audio/mp4')
    assert.equal(result.audio?.durationMs, 1800)
    assert.equal(result.audio?.voice, true)
    assert.equal(uploads.length, 1)
    assertPreparedMp4(uploads[0], 'audio')
    assert.equal(uploads[0].filename, 'meta-audio.m4a')

    const [sendCall] = getMetaMessagePosts(calls)
    assert.ok(sendCall)
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
    assert.equal(row.media_url, result.audio.url)
    assert.equal(row.media_mime_type, 'audio/mp4')
    assert.equal(JSON.parse(row.raw_payload_json).context.audio.durationMs, 1800)
    assert.equal(JSON.parse(row.raw_payload_json).context.audio.voice, true)
  })
})

test('sendMetaSocialAudioMessage convierte WAV, MP3 y WebM reales a audio/mp4 para Instagram', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'audio-wav-mp3'
  }, async ({ calls, uploads, contactId }) => {
    const wav = createPcmWavBuffer()
    const fixtures = [
      {
        dataUrl: `data:audio/wav;base64,${wav.toString('base64')}`,
        mimeType: 'audio/wav',
        filename: 'nota.wav',
        externalId: 'instagram-audio-wav'
      },
      {
        dataUrl: await getValidMp3DataUrl(),
        mimeType: 'audio/mpeg',
        filename: 'nota.mp3',
        externalId: 'instagram-audio-mp3'
      },
      {
        dataUrl: await getValidWebmAudioDataUrl(),
        mimeType: 'audio/webm',
        filename: 'nota.webm',
        externalId: 'instagram-audio-webm'
      }
    ]

    for (const fixture of fixtures) {
      const result = await sendMetaSocialAudioMessage({
        contactId,
        platform: 'instagram',
        audioDataUrl: fixture.dataUrl,
        audioMimeType: fixture.mimeType,
        filename: fixture.filename,
        durationMs: 2400,
        voice: false,
        externalId: fixture.externalId,
        publicBaseUrl: 'https://ristak.test'
      })

      assert.equal(result.remoteMessageId, 'mid-instagram-page-send-test')
      assert.equal(result.platform, 'instagram')
      assert.equal(result.audio?.mimeType, 'audio/mp4')
      assert.equal(result.audio?.durationMs, 2400)
      assert.equal(result.audio?.voice, false)
    }

    assert.equal(uploads.length, 3)
    for (const upload of uploads) {
      assertPreparedMp4(upload, 'audio')
      assert.equal(upload.filename, 'meta-audio.m4a')
    }

    const sendCalls = getMetaMessagePosts(calls)
    assert.equal(sendCalls.length, 3)
    for (let index = 0; index < sendCalls.length; index += 1) {
      const resultUrl = `https://media.ristak.test/audio-wav-mp3/${index + 1}`
      assert.equal(sendCalls[index].authorization, 'Bearer page-token-send-test')
      assert.deepEqual(JSON.parse(sendCalls[index].body), {
        recipient: { id: 'igsid-send-test' },
        message: {
          attachment: {
            type: 'audio',
            payload: { url: resultUrl }
          }
        }
      })
    }
    assert.equal(calls.some(call => call.url === '/ig-business-send-test/messages'), false)

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
    assert.match(row.media_url, /^https:\/\/media\.ristak\.test\/audio-wav-mp3\/[123]$/)
    assert.equal(row.media_mime_type, 'audio/mp4')
    assert.equal(JSON.parse(row.raw_payload_json).context.audio.durationMs, 2400)
    assert.equal(JSON.parse(row.raw_payload_json).context.audio.voice, false)
  })
})

test('sendMetaSocialAttachmentMessage prepara y manda video MP4 real por Messenger', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'video'
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'messenger',
      attachmentType: 'video',
      attachmentDataUrl: await getValidMp4VideoDataUrl(),
      mimeType: 'video/mp4',
      filename: 'demo.mp4',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.attachment.type, 'video')
    assert.equal(result.attachment.mimeType, 'video/mp4')
    assert.equal(uploads.length, 1)
    assertPreparedMp4(uploads[0], 'video')
    assert.equal(uploads[0].filename, 'meta-video.mp4')

    const [sendCall] = getMetaMessagePosts(calls)
    assert.deepEqual(JSON.parse(sendCall.body), {
      messaging_type: 'RESPONSE',
      recipient: { id: 'psid-send-test' },
      message: {
        attachment: {
          type: 'video',
          payload: {
            url: result.attachment.url,
            is_reusable: false
          }
        }
      }
    })
  })
})

test('sendMetaSocialAttachmentMessage manda PDF por Messenger y externalId evita un segundo POST', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'pdf-idempotent'
  }, async ({ calls, uploads, contactId }) => {
    const payload = {
      contactId,
      platform: 'messenger',
      attachmentType: 'file',
      attachmentDataUrl: PDF_DATA_URL,
      mimeType: 'application/pdf',
      filename: 'cotizacion.pdf',
      externalId: 'meta-pdf-idempotency-test',
      publicBaseUrl: 'https://ristak.test'
    }
    const first = await sendMetaSocialAttachmentMessage(payload)
    const repeated = await sendMetaSocialAttachmentMessage(payload)

    assert.equal(first.attachment.type, 'file')
    assert.equal(first.attachment.mimeType, 'application/pdf')
    assert.equal(first.attachment.filename, 'cotizacion.pdf')
    assert.equal(repeated.deduplicated, true)
    assert.equal(repeated.isNew, false)
    assert.equal(repeated.remoteMessageId, first.remoteMessageId)
    assert.equal(repeated.attachment.url, first.attachment.url)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].mimeType, 'application/pdf')
    assert.deepEqual(uploads[0].buffer, Buffer.from(PDF_DATA_URL.split(',')[1], 'base64'))

    const sendCalls = getMetaMessagePosts(calls)
    assert.equal(sendCalls.length, 1)
    assert.deepEqual(JSON.parse(sendCalls[0].body).message.attachment, {
      type: 'file',
      payload: {
        url: first.attachment.url,
        is_reusable: false
      }
    })

    const rows = await db.all(
      `SELECT id, meta_message_id, media_url, raw_payload_json
       FROM meta_social_messages
       WHERE contact_id = ? AND direction = 'outbound'`,
      [contactId]
    )
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(rows[0].raw_payload_json).externalId, payload.externalId)

    const webhookResult = await processMetaSocialWebhook({
      payload: {
        object: 'page',
        entry: [{
          id: 'page-send-test',
          time: 1783180860,
          messaging: [{
            sender: { id: 'page-send-test' },
            recipient: { id: 'psid-send-test' },
            timestamp: 1783180860000,
            message: {
              mid: first.remoteMessageId,
              is_echo: true,
              attachments: [{
                type: 'file',
                payload: {
                  url: first.attachment.url,
                  mime_type: 'application/pdf'
                }
              }]
            }
          }]
        }]
      }
    })
    assert.equal(webhookResult.messages, 1)

    const rowsAfterEcho = await db.all(
      `SELECT id, meta_message_id, media_url, media_mime_type, raw_payload_json
       FROM meta_social_messages
       WHERE meta_message_id = ? AND direction = 'outbound'`,
      [first.remoteMessageId]
    )
    assert.equal(rowsAfterEcho.length, 1)
    assert.equal(rowsAfterEcho[0].id, rows[0].id)
    assert.equal(rowsAfterEcho[0].media_url, first.attachment.url)
    assert.equal(rowsAfterEcho[0].media_mime_type, 'application/pdf')
    assert.equal(JSON.parse(rowsAfterEcho[0].raw_payload_json).externalId, payload.externalId)
  })
})

test('dos envíos concurrentes con el mismo externalId hacen un solo POST a Meta', async () => {
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'concurrent-idempotency'
  }, async ({ calls, uploads, contactId }) => {
    const payload = {
      contactId,
      platform: 'messenger',
      attachmentType: 'file',
      attachmentDataUrl: PDF_DATA_URL,
      mimeType: 'application/pdf',
      filename: 'concurrente.pdf',
      externalId: 'meta-concurrent-idempotency-test',
      publicBaseUrl: 'https://ristak.test'
    }

    const [first, second] = await Promise.all([
      sendMetaSocialAttachmentMessage(payload),
      sendMetaSocialAttachmentMessage(payload)
    ])

    assert.equal(first.remoteMessageId, second.remoteMessageId)
    assert.equal([first.deduplicated, second.deduplicated].filter(Boolean).length, 1)
    assert.equal(getMetaMessagePosts(calls).length, 1)
    assert.equal(uploads.length, 1)
    const rows = await db.all(
      "SELECT id FROM meta_social_messages WHERE contact_id = ? AND direction = 'outbound'",
      [contactId]
    )
    assert.equal(rows.length, 1)
  })
})

test('timeout de Graph termina en send_unknown y bloquea un duplicado ciego', async () => {
  setMetaSocialGraphTimeoutForTest(30)
  try {
    await withMetaMediaSendHarness({
      platform: 'messenger',
      testId: 'graph-timeout',
      beforeMessageResponse: async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
      }
    }, async ({ calls, contactId }) => {
      const payload = {
        contactId,
        platform: 'messenger',
        message: 'Prueba timeout Meta',
        externalId: 'meta-timeout-idempotency-test'
      }

      await assert.rejects(
        sendMetaSocialTextMessage(payload),
        error => error.statusCode === 504 && error.meta?.code === 'meta_graph_timeout'
      )
      const reservation = await db.get(
        "SELECT status FROM meta_social_messages WHERE contact_id = ? AND direction = 'outbound'",
        [contactId]
      )
      assert.equal(reservation.status, 'send_unknown')

      await assert.rejects(
        sendMetaSocialTextMessage(payload),
        error => error.statusCode === 409 && error.meta?.code === 'meta_send_delivery_unknown'
      )
      assert.equal(getMetaMessagePosts(calls).length, 1)
    })
  } finally {
    setMetaSocialGraphTimeoutForTest()
  }
})

test('un webhook echo que llega antes de guardar se fusiona con la reserva local', async () => {
  let echoProcessed = false
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'echo-before-save',
    beforeMessageResponse: async ({ parsedBody }) => {
      if (echoProcessed) return
      echoProcessed = true
      await processMetaSocialWebhook({
        payload: {
          object: 'page',
          entry: [{
            id: 'page-send-test',
            time: 1783180860,
            messaging: [{
              sender: { id: 'page-send-test' },
              recipient: { id: 'psid-send-test' },
              timestamp: 1783180860000,
              message: {
                mid: 'mid-messenger-send-test',
                is_echo: true,
                attachments: [{
                  type: 'image',
                  payload: {
                    url: parsedBody.message.attachment.payload.url,
                    mime_type: 'image/jpeg'
                  }
                }]
              }
            }]
          }]
        }
      })
    }
  }, async ({ contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'messenger',
      attachmentType: 'image',
      attachmentDataUrl: ONE_PIXEL_PNG_DATA_URL,
      mimeType: 'image/png',
      filename: 'echo.png',
      externalId: 'meta-echo-before-save-test',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(echoProcessed, true)
    const rows = await db.all(
      `SELECT id, media_url, media_mime_type, raw_payload_json
       FROM meta_social_messages
       WHERE contact_id = ? AND meta_message_id = ? AND direction = 'outbound'`,
      [contactId, result.remoteMessageId]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].media_url, result.attachment.url)
    assert.equal(rows[0].media_mime_type, 'image/jpeg')
    assert.equal(JSON.parse(rows[0].raw_payload_json).externalId, 'meta-echo-before-save-test')
    assert.equal(JSON.parse(rows[0].raw_payload_json).context.attachment.filename, 'meta-image.jpg')
  })
})

test('sendMetaSocialAttachmentMessage descarga URL externa con transporte inyectado antes de mandar a Meta', async () => {
  const downloads = []
  const png = Buffer.from(ONE_PIXEL_PNG_DATA_URL.split(',')[1], 'base64')
  await withMetaMediaSendHarness({
    platform: 'messenger',
    testId: 'external-url',
    downloader: async (url, options) => {
      downloads.push({ url, options })
      return { buffer: png, mimeType: 'image/png', filename: 'externa.png' }
    }
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'messenger',
      attachmentType: 'image',
      attachmentUrl: 'https://origin.example.test/media/campana.png',
      mimeType: 'image/png',
      filename: 'campana.png',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.deepEqual(downloads, [{
      url: 'https://origin.example.test/media/campana.png',
      options: { maxBytes: 25 * 1024 * 1024, timeoutMs: 60_000 }
    }])
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].mimeType, 'image/jpeg')
    assert.notEqual(result.attachment.url, 'https://origin.example.test/media/campana.png')
    assert.equal(JSON.parse(getMetaMessagePosts(calls)[0].body).message.attachment.payload.url, result.attachment.url)
  })
})

test('sendMetaSocialAudioMessage acepta WebM externo aunque el CDN lo declare video/webm', async () => {
  const webmDataUrl = await getValidWebmAudioDataUrl()
  const webmBytes = Buffer.from(webmDataUrl.split(',')[1], 'base64')
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'external-webm-audio',
    downloader: async () => ({
      buffer: webmBytes,
      mimeType: 'video/webm',
      filename: 'grabacion.webm'
    })
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAudioMessage({
      contactId,
      platform: 'instagram',
      audioUrl: 'https://cdn.example.test/grabacion.webm',
      filename: 'grabacion.webm',
      voice: true,
      externalId: 'instagram-external-webm'
    })

    assert.equal(result.audio.mimeType, 'audio/mp4')
    assert.equal(result.audio.voice, true)
    assert.equal(uploads.length, 1)
    assertPreparedMp4(uploads[0], 'audio')
    assert.equal(getMetaMessagePosts(calls).length, 1)
  })
})

test('sendMetaSocialAttachmentMessage prepara y manda imagen por Instagram', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'image'
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'instagram',
      attachmentType: 'image',
      attachmentDataUrl: ONE_PIXEL_PNG_DATA_URL,
      mimeType: 'image/png',
      filename: 'historia.png',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.remoteMessageId, 'mid-instagram-page-send-test')
    assert.equal(result.attachment.type, 'image')
    assert.equal(result.attachment.mimeType, 'image/jpeg')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].mimeType, 'image/jpeg')
    const [sendCall] = getMetaMessagePosts(calls)
    assert.equal(sendCall.authorization, 'Bearer page-token-send-test')
    assert.deepEqual(JSON.parse(sendCall.body), {
      recipient: { id: 'igsid-send-test' },
      message: {
        attachment: {
          type: 'image',
          payload: { url: result.attachment.url }
        }
      }
    })
  })
})

test('sendMetaSocialAttachmentMessage prepara y manda video MP4 real por Instagram', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'video'
  }, async ({ calls, uploads, contactId }) => {
    const result = await sendMetaSocialAttachmentMessage({
      contactId,
      platform: 'instagram',
      attachmentType: 'video',
      attachmentDataUrl: await getValidMp4VideoDataUrl(),
      mimeType: 'video/mp4',
      filename: 'reel.mp4',
      publicBaseUrl: 'https://ristak.test'
    })

    assert.equal(result.attachment.type, 'video')
    assert.equal(result.attachment.mimeType, 'video/mp4')
    assert.equal(uploads.length, 1)
    assertPreparedMp4(uploads[0], 'video')
    const [sendCall] = getMetaMessagePosts(calls)
    assert.deepEqual(JSON.parse(sendCall.body), {
      recipient: { id: 'igsid-send-test' },
      message: {
        attachment: {
          type: 'video',
          payload: { url: result.attachment.url }
        }
      }
    })
  })
})

test('sendMetaSocialAttachmentMessage rechaza PDF en Instagram antes de subirlo o llamar Graph', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'pdf'
  }, async ({ calls, uploads, contactId }) => {
    await assert.rejects(
      sendMetaSocialAttachmentMessage({
        contactId,
        platform: 'instagram',
        attachmentType: 'document',
        attachmentDataUrl: PDF_DATA_URL,
        mimeType: 'application/pdf',
        filename: 'catalogo.pdf',
        publicBaseUrl: 'https://ristak.test'
      }),
      error => {
        assert.equal(error.statusCode, 415)
        assert.equal(error.meta?.code, 'instagram_file_not_supported')
        assert.match(error.message, /Instagram no permite enviar documentos/)
        return true
      }
    )
    assert.equal(uploads.length, 0)
    assert.equal(getMetaMessagePosts(calls).length, 0)
  })
})

test('sendMetaSocialAttachmentMessage rechaza DOCX en Instagram antes de subirlo o llamar Graph', async () => {
  await withMetaMediaSendHarness({
    platform: 'instagram',
    testId: 'docx-rejected'
  }, async ({ calls, uploads, contactId }) => {
    const fakeDocxBytes = Buffer.from('PK\u0003\u0004document.xml', 'latin1')
    await assert.rejects(
      sendMetaSocialAttachmentMessage({
        contactId,
        platform: 'instagram',
        attachmentType: 'file',
        attachmentDataUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${fakeDocxBytes.toString('base64')}`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'propuesta.docx',
        publicBaseUrl: 'https://ristak.test'
      }),
      error => {
        assert.equal(error.statusCode, 415)
        assert.equal(error.meta?.code, 'instagram_file_not_supported')
        assert.match(error.message, /Instagram no permite enviar documentos/)
        return true
      }
    )
    assert.equal(uploads.length, 0)
    assert.equal(getMetaMessagePosts(calls).length, 0)
  })
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

test('resolveMetaPageAccessToken invalida el cache al reemplazar el System User token', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer

  try {
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${metaServer.address().port}`,
      configurable: true
    })

    const oldPageToken = await resolveMetaPageAccessToken({
      config: { page_id: 'page-refresh-test', access_token: 'user-token-refresh-old' }
    })
    const newPageToken = await resolveMetaPageAccessToken({
      config: { page_id: 'page-refresh-test', access_token: 'user-token-refresh-new' }
    })

    assert.equal(oldPageToken, 'page-token-refresh-old')
    assert.equal(newPageToken, 'page-token-refresh-new')
    assert.equal(calls.filter(call => call.method === 'GET' && /^\/page-refresh-test(?:\?|$)/.test(call.url)).length, 2)
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) {
      Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    }
  }
})

test('sendMetaSocialTextMessage rederiva el Page token tras un rechazo temporal de pages_messaging', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_permission_retry_messenger_contact'
  const metaContactId = 'meta_permission_retry_messenger_profile'

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
            'act-permission-retry-test',
            encrypt('user-token-permission-retry-test'),
            null,
            'page-permission-retry-test',
            null,
            null,
            null,
            null
          ])
          await setAppConfig('meta_messenger_messaging_enabled', '1')
          await seedMessengerContact({ contactId, metaContactId, pageId: 'page-permission-retry-test' })

          const result = await sendMetaSocialTextMessage({
            contactId,
            platform: 'messenger',
            message: 'Hola después de refrescar permisos'
          })

          assert.equal(result.remoteMessageId, 'mid-permission-retry-test')
          const sends = calls.filter(call => call.method === 'POST' && call.url === '/page-permission-retry-test/messages')
          assert.equal(sends.length, 2)
          assert.equal(sends[0].authorization, 'Bearer page-token-stale')
          assert.equal(sends[1].authorization, 'Bearer page-token-fresh')
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

test('sendMetaSocialTextMessage rederiva tambien el Page token de Instagram tras rechazo temporal', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const calls = []
  let metaServer
  const contactId = 'meta_permission_retry_instagram_contact'
  const metaContactId = 'meta_permission_retry_instagram_profile'

  try {
    await initializeMasterKey()
    metaServer = await startMetaSendServer(calls)
    Object.defineProperty(API_URLS, 'META_GRAPH', {
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
            'act-permission-retry-instagram-test',
            encrypt('user-token-permission-retry-instagram-test'),
            null,
            'page-permission-retry-test',
            'ig-business-send-test',
            null,
            null,
            null
          ])
          await setAppConfig('meta_instagram_messaging_enabled', '1')
          await seedInstagramContact({ contactId, metaContactId })

          const result = await sendMetaSocialTextMessage({
            contactId,
            platform: 'instagram',
            message: 'Instagram después de refrescar permisos'
          })

          assert.equal(result.remoteMessageId, 'mid-permission-retry-test')
          const sends = calls.filter(call => call.method === 'POST' && call.url === '/page-permission-retry-test/messages')
          assert.equal(sends.length, 2)
          assert.equal(sends[0].authorization, 'Bearer page-token-stale')
          assert.equal(sends[1].authorization, 'Bearer page-token-fresh')
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
