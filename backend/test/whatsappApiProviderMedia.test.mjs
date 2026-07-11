import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiAudioMessage,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiImageMessage,
  sendWhatsAppApiLocationMessage,
  sendWhatsAppApiVideoMessage,
  setMetaDirectFetchForTest,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlIC9QYWdlcyAvQ291bnQgMD4+CmVuZG9iago='
const MP4_AUDIO_DATA_URL = `data:audio/mp4;base64,${Buffer.from('mp4-provider-audio-test').toString('base64')}`
const WEBM_VIDEO_DATA_URL = `data:video/webm;base64,${Buffer.from('webm-provider-media-test').toString('base64')}`
const VALID_OGG_OPUS_BASE64 = 'T2dnUwACAAAAAAAAAAC3bz5UAAAAAF9EXgkBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAALdvPlQBAAAAGaef4gE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMgEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAyIGxpYm9wdXNPZ2dTAAS4JgAAAAAAALdvPlQCAAAAC0SjeAtFNjQxMjcwMzUqF3iCAbdsfkDmAAAGS7TjumYR3p00RmwBHPB+I1m2zIXrmd7aBIGjduC2A1wWfuKopx7fzlrQS4bGLc+BnYqkIkXcxwldWXijP/esmIUDXCYJlv9nCL7fgGPAvjeM8OkgudL/caOCG6HJnKqN6vBOROgBGTLI+axxcdqjR3iboxJRRQCs0ky14jfRZlm92WkiUNr3DzWw4+Wx98jdsGxYSXK89+hYLRz8wpvjzDHFfgN4m6MSVs4iKkTY4B+i5MZKX7oD0oqS8sDjgb3P1kzpjChOdn4p8hKrIOo5iNWlBQ2HeJujX3Wc/EkNeFc8EJ8EQgTM6vBjyEl0VL8/GXoXtJgxBWlaTy5ZsndLX2+12lIG4vp4m6MXUV8mKyhiES+Om70HKUgcHjLILmQd5M+0sQ+XSDU8UWqsEkjj64ueAeySOq+RhfBzeZureJujX3Wc/EXtr4kI5+fJxq6G+cwFCZR6q7Kutp0WvvmBv231nX0Hb9Se/0S+7VGjeJujElFFANDLwZ1z7toAlP1FFw5GylCcHpCS4YWDdWoTkDdThgxrmgWllJqky5ujivwGeJujElbOIipFGIWoi9E7IdHXTfF6kHlqfNIV5rk86Mc/0dbzcR6fM4Wq/NQLtMYQ/eGxFdZImysfdZz8STOyk08i9Ec9uRIoArhlUWBwvWCPq76xEWvHCYXWbyTIJ0BIBbul8BHm3h2TRdVKljNtaNImd5UVgA=='
const execFile = promisify(execFileCallback)
const MEDIA_STORAGE_ENV_KEYS = [
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL',
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'WHATSAPP_LOCAL_MEDIA_FALLBACK',
  'RENDER_EXTERNAL_URL',
  'PUBLIC_URL'
]

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

async function withFakeFfmpeg(callback) {
  const previousPath = process.env.FFMPEG_PATH
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-fake-ffmpeg-'))
  const scriptPath = join(folder, 'ffmpeg-fake.mjs')
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const outputPath = process.argv[process.argv.length - 1];',
    "const isOgg = outputPath.endsWith('.ogg');",
    `fs.writeFileSync(outputPath, isOgg ? Buffer.from('${VALID_OGG_OPUS_BASE64}', 'base64') : Buffer.from('converted-video-for-whatsapp'));`,
    ''
  ].join('\n'))
  await fs.chmod(scriptPath, 0o755)
  process.env.FFMPEG_PATH = scriptPath

  try {
    return await callback()
  } finally {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = previousPath
    await fs.rm(folder, { recursive: true, force: true })
  }
}

async function withRealMp3(callback) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-real-audio-'))
  const inputPath = join(folder, 'input.mp3')
  try {
    await execFile(ffmpegPath, [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1',
      '-ac', '1',
      '-ar', '44100',
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
      inputPath
    ])
    const input = await fs.readFile(inputPath)
    return await callback(`data:audio/mpeg;base64,${input.toString('base64')}`)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
}

async function readAndDecodeStoredOgg(mediaAssetId) {
  const asset = await db.get('SELECT metadata_json FROM media_assets WHERE id = ?', [mediaAssetId])
  assert.ok(asset)
  const metadata = JSON.parse(asset.metadata_json || '{}')
  assert.ok(metadata.localPath)
  const bytes = await fs.readFile(metadata.localPath)
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OggS')
  assert.ok(bytes.includes(Buffer.from('OpusHead', 'ascii')))
  assert.ok(bytes.includes(Buffer.from('OpusTags', 'ascii')))
  await execFile(ffmpegPath, ['-v', 'error', '-xerror', '-i', metadata.localPath, '-f', 'null', '-'])
  return bytes
}

function snapshotMediaStorageEnv() {
  return Object.fromEntries(MEDIA_STORAGE_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreMediaStorageEnv(snapshot) {
  for (const key of MEDIA_STORAGE_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
}

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function readMultipartUploadFile(options = {}) {
  const legacyFile = options.body?.get?.('file')
  if (legacyFile) return legacyFile

  const body = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body || '')
  const contentType = String(options.headers?.['content-type'] || options.headers?.['Content-Type'] || '')
  const boundary = /boundary=([^;\s]+)/i.exec(contentType)?.[1]
  if (!boundary || !body.length) return null

  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'))
  const closing = Buffer.from(`\r\n--${boundary}`)
  const contentStart = headerEnd + 4
  const contentEnd = body.indexOf(closing, contentStart)
  if (headerEnd < 0 || contentEnd < contentStart) return null

  const header = body.subarray(0, headerEnd).toString('utf8')
  const filename = /filename="([^"]*)"/i.exec(header)?.[1] || ''
  const mimeType = /(?:^|\r\n)Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1] || ''
  const bytes = body.subarray(contentStart, contentEnd)

  return {
    name: filename,
    type: mimeType,
    arrayBuffer: async () => bytes
  }
}

function createFakeQrRuntime(sentMessages = [], connectedJid) {
  let messageIndex = 0

  return {
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionReplaced: 440,
      restartRequired: 515
    },
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: { id: connectedJid },
      registered: true
    }),
    makeCacheableSignalKeyStore: (keys) => keys,
    proto: {
      Message: {
        AppStateSyncKeyData: {
          fromObject: (value) => value
        }
      }
    },
    makeWASocket: () => {
      const listeners = new Map()
      const emit = async (eventName, payload) => {
        for (const handler of listeners.get(eventName) || []) {
          await handler(payload)
        }
      }
      const sock = {
        user: { id: connectedJid },
        ev: {
          on: (eventName, handler) => {
            const eventListeners = listeners.get(eventName) || []
            eventListeners.push(handler)
            listeners.set(eventName, eventListeners)
          },
          removeAllListeners: (eventName) => {
            if (eventName) listeners.delete(eventName)
            else listeners.clear()
          }
        },
        ws: { close: () => {} },
        onWhatsApp: async (...candidates) => candidates.map(candidate => ({
          exists: true,
          jid: `${normalizeDigits(candidate)}@s.whatsapp.net`
        })),
        sendMessage: async (jid, payload) => {
          messageIndex += 1
          const id = `qr_provider_media_msg_${messageIndex}`
          sentMessages.push({ id, jid, payload })
          await emit('messages.update', [{
            key: { id, remoteJid: jid, fromMe: true },
            update: { status: 3 }
          }])
          return {
            key: { id, remoteJid: jid, fromMe: true },
            message: payload
          }
        }
      }

      queueMicrotask(() => {
        emit('connection.update', { connection: 'open' }).catch(() => undefined)
      })

      return sock
    }
  }
}

function forceLocalMediaStorageForProviderPreview() {
  process.env.MEDIA_STORAGE_PROVIDER = 'local'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'false'
  delete process.env.BUNNY_STORAGE_ZONE
  delete process.env.BUNNY_STORAGE_REGION
  delete process.env.BUNNY_STORAGE_ENDPOINT
  delete process.env.BUNNY_STORAGE_API_KEY
  delete process.env.BUNNY_CDN_BASE_URL
  delete process.env.LICENSE_SERVER_URL
  delete process.env.CLIENT_ID
  delete process.env.LICENSE_KEY
  delete process.env.INSTALLATION_ID
  delete process.env.WHATSAPP_LOCAL_MEDIA_FALLBACK
  delete process.env.RENDER_EXTERNAL_URL
  delete process.env.PUBLIC_URL
}

async function snapshotAppConfig(keys = [], callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = placeholders
    ? await db.all(
        `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
        uniqueKeys
      )
    : []

  try {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    return await callback()
  } finally {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

async function withYCloudProviderMediaCapture(callback) {
  await initializeMasterKey()
  const previousMediaStorageEnv = snapshotMediaStorageEnv()
  const keys = getWhatsAppApiConfigKeys()
  const businessPhone = '+526561234567'
  const phoneNumberId = 'phone_ycloud_provider_media_test'
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    keys.lastError
  ]
  const captures = {
    uploads: [],
    messages: [],
    openReplyWindow: async (phone) => {
      const now = new Date().toISOString()
      const digits = normalizeDigits(phone) || randomUUID().replace(/-/g, '')
      const contactId = `provider_media_contact_${digits}`
      const messageId = `provider_media_inbound_${digits}`

      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          phone = excluded.phone,
          updated_at = excluded.updated_at
      `, [
        contactId,
        phone,
        'Cliente Media Provider',
        'Cliente',
        'WhatsApp_API',
        now,
        now
      ])

      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', ?, 'received', ?, ?, ?)
      `, [
        messageId,
        messageId,
        contactId,
        phone,
        phone,
        businessPhone,
        businessPhone,
        phoneNumberId,
        'Respuesta reciente del cliente',
        now,
        now,
        now
      ])
    }
  }

  return snapshotAppConfig(configKeys, async () => {
    forceLocalMediaStorageForProviderPreview()
    try {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_provider_media_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_ycloud_provider_media_test')
      await setAppConfig(keys.provider, 'ycloud')
      await setAppConfig(keys.lastError, '')

      setYCloudFetchForTest(async (url, options = {}) => {
        const parsed = new URL(String(url))
        const path = parsed.pathname.replace(/^\/v2/, '')
        const method = String(options.method || 'GET').toUpperCase()

        if (method === 'POST' && /^\/whatsapp\/media\/.+\/upload$/.test(path)) {
          const file = readMultipartUploadFile(options)
          const bytes = file?.arrayBuffer ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0)
          const mediaId = `provider_media_${captures.uploads.length + 1}`
          captures.uploads.push({
            mediaId,
            phone: decodeURIComponent(path.match(/^\/whatsapp\/media\/(.+)\/upload$/)?.[1] || ''),
            apiKey: options.headers?.['X-API-Key'],
            filename: file?.name || '',
            mimeType: file?.type || '',
            size: bytes.length,
            bytes
          })
          return ycloudJsonResponse({ id: mediaId })
        }

        if (path === '/whatsapp/messages' && method === 'POST') {
          const body = JSON.parse(options.body || '{}')
          captures.messages.push(body)
          return ycloudJsonResponse({
            id: `ycloud_provider_message_${captures.messages.length}`,
            from: body.from,
            to: body.to,
            type: body.type,
            status: 'sent',
            [body.type]: body[body.type]
          })
        }

        return ycloudJsonResponse({ ok: true })
      })

      return await callback(captures)
    } finally {
      setYCloudFetchForTest(null)
      restoreMediaStorageEnv(previousMediaStorageEnv)
    }
  })
}

async function withMetaDirectAudioCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const businessPhone = '+526561234567'
  const phoneNumberId = 'phone_meta_direct_audio_test'
  const configKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastError
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, 'waba_meta_direct_audio_test')
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, businessPhone)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_audio_test_token'))
    await setAppConfig(keys.metaLastError, '')

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const method = String(options.method || 'GET').toUpperCase()
      if (parsed.pathname.endsWith(`/${phoneNumberId}/messages`) && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to, wa_id: normalizeDigits(body.to) }],
          messages: [{ id: `wamid.meta_audio_${captures.length}` }]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      return await callback({ captures, businessPhone, phoneNumberId })
    } finally {
      setMetaDirectFetchForTest(null)
    }
  })
}

test('envío QR de imagen con dataUrl conserva preview interno en historial', async () => {
  const previousMediaStorageEnv = snapshotMediaStorageEnv()
  const sentMessages = []
  const suffix = randomUUID()
  const phone = `+52155${Date.now().toString().slice(-8)}`
  const businessPhone = '+526561111111'
  const connectedJid = `${normalizeDigits(businessPhone)}@s.whatsapp.net`
  const phoneNumberId = `phone_qr_image_preview_${suffix}`
  const externalId = `qr-image-preview-${suffix}`
  let previewMediaAssetId = ''

  try {
    forceLocalMediaStorageForProviderPreview()
    const mediaStorageService = await import('../src/services/mediaStorageService.js')
    mediaStorageService.resetCentralStorageConfigCache()
    resetWhatsAppQrServiceForTest()

    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', 'waba_qr_image_preview_test', ?, ?, 'QR Image Preview Test', 1, 0, 1, 'connected', 'CONNECTED')
    `, [phoneNumberId, businessPhone, businessPhone])

    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
      ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      `qr_${phoneNumberId}`,
      phoneNumberId,
      businessPhone,
      businessPhone,
      QR_CONSENT_TEXT
    ])

    await db.run(`
      INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
      VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
    `, [
      phoneNumberId,
      JSON.stringify({
        me: { id: connectedJid },
        registered: true
      })
    ])

    setBaileysRuntimeForTest(createFakeQrRuntime(sentMessages, connectedJid))

    const response = await sendWhatsAppApiImageMessage({
      to: phone,
      from: businessPhone,
      phoneNumberId,
      imageDataUrl: ONE_PIXEL_PNG_DATA_URL,
      caption: 'Foto por QR',
      externalId,
      transport: 'qr',
      allowQrFallback: false,
      skipQrSendProtection: true
    })

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].payload.image instanceof Buffer, true)
    assert.ok(response.localMessageId)
    assert.match(response.image.link, /^\/media\/assets\/.+\/file$/)
    previewMediaAssetId = response.image.previewMediaAssetId
    assert.match(previewMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)

    const stored = await db.get(
      `SELECT media_url, media_mime_type, media_filename, raw_payload_json
       FROM whatsapp_api_messages
       WHERE id = ?`,
      [response.localMessageId]
    )

    assert.ok(stored)
    assert.match(stored.media_url, /^\/media\/assets\/.+\/file$/)
    assert.equal(stored.media_mime_type, 'image/jpeg')
    assert.equal(stored.media_filename, 'whatsapp-image.jpg')
    const raw = JSON.parse(stored.raw_payload_json)
    assert.equal(raw.image.link, stored.media_url)
    assert.equal(raw.image.publicUrl, stored.media_url)
    assert.equal(raw.image.previewMediaAssetId, previewMediaAssetId)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ? OR from_phone = ?', [phone, phone, businessPhone]).catch(() => undefined)
    if (previewMediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [previewMediaAssetId]).catch(() => undefined)
    }
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    resetWhatsAppQrServiceForTest()
    restoreMediaStorageEnv(previousMediaStorageEnv)
  }
})

test('envío API de imagen sube media al proveedor y conserva preview interno sin mandar link a yCloud', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52156${Date.now().toString().slice(-8)}`
    const externalId = `provider-image-${suffix}`
    let previewMediaAssetId = ''

    try {
      await captures.openReplyWindow(to)

      const response = await sendWhatsAppApiImageMessage({
        to,
        imageDataUrl: ONE_PIXEL_PNG_DATA_URL,
        caption: 'Foto por proveedor',
        externalId,
        allowQrFallback: false
      })

      assert.equal(captures.uploads.length, 1)
      assert.equal(captures.uploads[0].phone, '+526561234567')
      assert.equal(captures.uploads[0].apiKey, 'ycloud_provider_media_secret')
      assert.equal(captures.uploads[0].filename, 'whatsapp-image.jpg')
      assert.equal(captures.uploads[0].mimeType, 'image/jpeg')
      assert.ok(captures.uploads[0].size > 0)

      assert.equal(captures.messages.length, 1)
      assert.equal(captures.messages[0].type, 'image')
      assert.equal(captures.messages[0].image.id, 'provider_media_1')
      assert.equal(captures.messages[0].image.link, undefined)
      assert.equal(response.image.mediaId, 'provider_media_1')
      assert.equal(response.image.storage, 'provider')
      assert.equal(response.image.storageProvider, 'ycloud')
      assert.match(response.image.link, /^\/media\/assets\/.+\/file$/)

      const row = await db.get(
        `SELECT media_url, media_mime_type, media_filename, raw_payload_json
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        ['ycloud_provider_message_1']
      )
      assert.ok(row)
      assert.match(row.media_url, /^\/media\/assets\/.+\/file$/)
      assert.equal(row.media_mime_type, 'image/jpeg')
      assert.equal(row.media_filename, 'whatsapp-image.jpg')
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.image.id, 'provider_media_1')
      assert.equal(raw.image.providerMediaId, 'provider_media_1')
      assert.equal(raw.image.storageProvider, 'ycloud')
      assert.equal(raw.image.link, row.media_url)
      assert.equal(raw.image.publicUrl, row.media_url)
      assert.match(raw.image.previewMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)
      previewMediaAssetId = raw.image.previewMediaAssetId
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
      if (previewMediaAssetId) {
        await db.run('DELETE FROM media_assets WHERE id = ?', [previewMediaAssetId]).catch(() => undefined)
      }
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envío API de ubicación manda payload location y lo persiste en historial', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52155${Date.now().toString().slice(-8)}`
    const externalId = `provider-location-${suffix}`

    try {
      await captures.openReplyWindow(to)

      const response = await sendWhatsAppApiLocationMessage({
        to,
        latitude: 31.6904,
        longitude: -106.4245,
        name: 'Ubicación',
        address: 'Ciudad Juárez',
        externalId,
        allowQrFallback: false
      })

      assert.equal(captures.uploads.length, 0)
      assert.equal(captures.messages.length, 1)
      assert.equal(captures.messages[0].type, 'location')
      assert.deepEqual(captures.messages[0].location, {
        latitude: 31.6904,
        longitude: -106.4245,
        name: 'Ubicación',
        address: 'Ciudad Juárez'
      })
      assert.equal(response.location.latitude, 31.6904)
      assert.equal(response.location.longitude, -106.4245)

      const row = await db.get(
        `SELECT message_type, message_text, raw_payload_json
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        ['ycloud_provider_message_1']
      )
      assert.ok(row)
      assert.equal(row.message_type, 'location')
      assert.equal(row.message_text, 'Ubicación')
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.location.latitude, 31.6904)
      assert.equal(raw.location.longitude, -106.4245)
      assert.equal(raw.location.address, 'Ciudad Juárez')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envío API de documento conserva metadata del archivo sin guardar URL propia', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52157${Date.now().toString().slice(-8)}`
    const externalId = `provider-document-${suffix}`

    try {
      await captures.openReplyWindow(to)

      const response = await sendWhatsAppApiDocumentMessage({
        to,
        documentDataUrl: PDF_DATA_URL,
        filename: 'contrato.pdf',
        mimeType: 'application/pdf',
        caption: 'Documento por proveedor',
        externalId,
        allowQrFallback: false
      })

      assert.equal(captures.uploads.length, 1)
      assert.equal(captures.uploads[0].filename, 'contrato.pdf')
      assert.equal(captures.uploads[0].mimeType, 'application/pdf')
      assert.ok(captures.uploads[0].size > 0)

      assert.equal(captures.messages.length, 1)
      assert.equal(captures.messages[0].type, 'document')
      assert.equal(captures.messages[0].document.id, 'provider_media_1')
      assert.equal(captures.messages[0].document.link, undefined)
      assert.equal(captures.messages[0].document.filename, 'contrato.pdf')
      assert.equal(response.document.providerMediaId, 'provider_media_1')

      const row = await db.get(
        `SELECT media_url, media_mime_type, media_filename, raw_payload_json
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        ['ycloud_provider_message_1']
      )
      assert.ok(row)
      assert.equal(row.media_url, null)
      assert.equal(row.media_mime_type, 'application/pdf')
      assert.equal(row.media_filename, 'contrato.pdf')
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.document.id, 'provider_media_1')
      assert.equal(raw.document.filename, 'contrato.pdf')
      assert.equal(raw.document.storage, 'provider')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envío API convierte un MP3 real, publica OGG/Opus decodificable y lo manda por enlace', async () => {
  await withRealMp3(async (audioDataUrl) => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const suffix = randomUUID()
      const to = `+52158${Date.now().toString().slice(-8)}`
      const externalId = `provider-audio-${suffix}`
      let previewMediaAssetId = ''
      let deliveryMediaAssetId = ''

      try {
        await captures.openReplyWindow(to)

        const response = await sendWhatsAppApiAudioMessage({
          to,
          audioDataUrl,
          externalId,
          publicBaseUrl: 'https://ristak.test',
          allowQrFallback: false,
          durationMs: 1000
        })

        assert.equal(captures.uploads.length, 0)
        assert.equal(captures.messages.length, 1)
        assert.equal(captures.messages[0].type, 'audio')
        assert.equal(captures.messages[0].audio.id, undefined)
        assert.match(captures.messages[0].audio.link, /^https:\/\/ristak\.test\/media\/assets\/.+\/file$/)
        assert.equal(captures.messages[0].audio.voice, true)

        deliveryMediaAssetId = response.audio.deliveryMediaAssetId
        previewMediaAssetId = response.audio.previewMediaAssetId
        assert.match(deliveryMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)
        assert.match(previewMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)
        assert.equal(response.audio.deliveryUrl, captures.messages[0].audio.link)
        assert.equal(response.audio.deliveryMimeType, 'audio/ogg; codecs=opus')
        assert.equal(response.audio.mimeType, 'audio/mpeg')
        assert.equal(response.audio.durationMs, 1000)

        const storedBytes = await readAndDecodeStoredOgg(deliveryMediaAssetId)
        assert.ok(storedBytes.length > 100)

        const row = await db.get(
          `SELECT media_url, media_mime_type, media_filename, media_duration_ms, raw_payload_json
           FROM whatsapp_api_messages
           WHERE ycloud_message_id = ?`,
          ['ycloud_provider_message_1']
        )
        assert.ok(row)
        assert.match(row.media_url, /^\/media\/assets\/.+\/file$/)
        assert.equal(row.media_mime_type, 'audio/mpeg')
        assert.match(row.media_filename, /\.mp3$/)
        assert.equal(row.media_duration_ms, 1000)
        const raw = JSON.parse(row.raw_payload_json)
        assert.equal(raw.audio.id, undefined)
        assert.equal(raw.audio.deliveryUrl, captures.messages[0].audio.link)
        assert.equal(raw.audio.asyncQrFallbackAllowed, false)
        assert.equal(raw.audio.deliveryMediaAssetId, deliveryMediaAssetId)
        assert.equal(raw.audio.previewMediaAssetId, previewMediaAssetId)
      } finally {
        await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
        for (const mediaAssetId of [previewMediaAssetId, deliveryMediaAssetId]) {
          if (mediaAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
        }
        await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
        await db.run('DELETE FROM contacts WHERE phone = ?', [to])
      }
    })
  })
})

test('Meta Direct envía la nota de voz por Graph API con audio.link y voice', async () => {
  await withMetaDirectAudioCapture(async ({ captures, businessPhone, phoneNumberId }) => {
    const suffix = randomUUID()
    const to = `+52159${Date.now().toString().slice(-8)}`
    const contactId = `meta_audio_contact_${suffix}`
    const inboundId = `meta_audio_inbound_${suffix}`
    const audioUrl = 'https://cdn.example.test/chat/nota-validada.ogg'

    try {
      await db.run(`
        INSERT INTO contacts (id, phone, full_name, first_name, source, created_at, updated_at)
        VALUES (?, ?, 'Cliente Meta Audio', 'Cliente', 'WhatsApp_API', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [contactId, to])
      await db.run(`
        INSERT INTO whatsapp_api_messages (
          id, provider, meta_message_id, contact_id, phone, from_phone, to_phone,
          business_phone, business_phone_number_id, transport, direction, message_type,
          message_text, status, message_timestamp, created_at, updated_at
        ) VALUES (?, 'meta_direct', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text',
          'Ventana abierta', 'received', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [inboundId, inboundId, contactId, to, to, businessPhone, businessPhone, phoneNumberId])

      const response = await sendWhatsAppApiAudioMessage({
        to,
        from: businessPhone,
        contactId,
        phoneNumberId,
        audioUrl,
        voice: true,
        externalId: `meta-audio-${suffix}`,
        allowQrFallback: false
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].messaging_product, 'whatsapp')
      assert.equal(captures[0].type, 'audio')
      assert.deepEqual(captures[0].audio, { link: audioUrl, voice: true })
      assert.equal(response.provider, 'meta_direct')
      assert.equal(response.wamid, 'wamid.meta_audio_1')

      const row = await db.get(`
        SELECT provider, message_type, status, raw_payload_json
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, ['wamid.meta_audio_1'])
      assert.equal(row.provider, 'meta_direct')
      assert.equal(row.message_type, 'audio')
      assert.equal(row.status, 'sent')
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.audio.deliveryUrl, audioUrl)
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE id = ? OR wamid = ? OR phone = ? OR to_phone = ?', [inboundId, 'wamid.meta_audio_1', to, to]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, to]).catch(() => undefined)
    }
  })
})

test('un OGG falso con firmas de texto no pasa como nota de voz válida', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const to = `+52157${Date.now().toString().slice(-8)}`
    try {
      await captures.openReplyWindow(to)
      await assert.rejects(
        sendWhatsAppApiAudioMessage({
          to,
          audioDataUrl: `data:audio/ogg;base64,${Buffer.from('OggS-fake-OpusHead-audio').toString('base64')}`,
          externalId: `invalid-ogg-${randomUUID()}`,
          publicBaseUrl: 'https://ristak.test',
          allowQrFallback: false
        }),
        /No se pudo preparar el audio|formato de nota de voz/i
      )
      assert.equal(captures.uploads.length, 0)
      assert.equal(captures.messages.length, 0)
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE to_phone = ? OR phone = ?', [to, to]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE phone = ?', [to]).catch(() => undefined)
    }
  })
})

test('envío API de nota de voz usa el enlace HTTPS ya validado y no re-sube el OGG al proveedor', async () => {
  await withFakeFfmpeg(async () => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const suffix = randomUUID()
      const to = `+52154${Date.now().toString().slice(-8)}`
      const externalId = `provider-audio-link-${suffix}`
      let previewMediaAssetId = ''

      try {
        await captures.openReplyWindow(to)

        const response = await sendWhatsAppApiAudioMessage({
          to,
          audioDataUrl: MP4_AUDIO_DATA_URL,
          audioUrl: 'https://cdn.example.test/automations/nota-validada.ogg',
          voice: true,
          externalId,
          allowQrFallback: false,
          durationMs: 950
        })

        assert.equal(captures.uploads.length, 0)
        assert.equal(captures.messages.length, 1)
        assert.deepEqual(captures.messages[0].audio, {
          link: 'https://cdn.example.test/automations/nota-validada.ogg',
          voice: true
        })
        assert.equal(response.audio.link, 'https://cdn.example.test/automations/nota-validada.ogg')
        assert.equal(response.audio.voice, true)

        const row = await db.get(
          `SELECT raw_payload_json FROM whatsapp_api_messages WHERE ycloud_message_id = ?`,
          ['ycloud_provider_message_1']
        )
        assert.ok(row)
        const raw = JSON.parse(row.raw_payload_json)
        assert.equal(raw.audio.link, 'https://cdn.example.test/automations/nota-validada.ogg')
        assert.equal(raw.audio.voice, true)
        assert.match(raw.audio.previewMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)
        previewMediaAssetId = raw.audio.previewMediaAssetId
      } finally {
        await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
        if (previewMediaAssetId) {
          await db.run('DELETE FROM media_assets WHERE id = ?', [previewMediaAssetId]).catch(() => undefined)
        }
        await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
        await db.run('DELETE FROM contacts WHERE phone = ?', [to])
      }
    })
  })
})

test('envío API de video comprime a MP4 y manda media tipo video', async () => {
  await withFakeFfmpeg(async () => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const suffix = randomUUID()
      const to = `+52159${Date.now().toString().slice(-8)}`
      const externalId = `provider-video-${suffix}`

      try {
        await captures.openReplyWindow(to)

        const response = await sendWhatsAppApiVideoMessage({
          to,
          videoDataUrl: WEBM_VIDEO_DATA_URL,
          caption: 'Video por proveedor',
          externalId,
          allowQrFallback: false
        })

        assert.equal(captures.uploads.length, 1)
        assert.equal(captures.uploads[0].filename, 'whatsapp-video.mp4')
        assert.equal(captures.uploads[0].mimeType, 'video/mp4')
        assert.ok(captures.uploads[0].size > 0)

        assert.equal(captures.messages.length, 1)
        assert.equal(captures.messages[0].type, 'video')
        assert.equal(captures.messages[0].video.id, 'provider_media_1')
        assert.equal(captures.messages[0].video.link, undefined)
        assert.equal(captures.messages[0].video.caption, 'Video por proveedor')
        assert.equal(response.video.providerMediaId, 'provider_media_1')
        assert.equal(response.video.storage, 'provider')
        assert.equal(response.video.storageProvider, 'ycloud')
        assert.equal(response.video.mimeType, 'video/mp4')

        const row = await db.get(
          `SELECT media_url, media_mime_type, media_filename, raw_payload_json
           FROM whatsapp_api_messages
           WHERE ycloud_message_id = ?`,
          ['ycloud_provider_message_1']
        )
        assert.ok(row)
        assert.equal(row.media_url, null)
        assert.equal(row.media_mime_type, 'video/mp4')
        assert.equal(row.media_filename, 'whatsapp-video.mp4')
        const raw = JSON.parse(row.raw_payload_json)
        assert.equal(raw.video.id, 'provider_media_1')
        assert.equal(raw.video.storage, 'provider')
        assert.equal(raw.video.storageProvider, 'ycloud')
        assert.equal(raw.video.metadata.originalMimeType, 'video/webm')
      } finally {
        await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_1', to, to])
        await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
        await db.run('DELETE FROM contacts WHERE phone = ?', [to])
      }
    })
  })
})

test('URLs públicas ya hospedadas llegan al proveedor sin re-subir base64', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const to = `+52154${Date.now().toString().slice(-8)}`
    try {
      await captures.openReplyWindow(to)

      await sendWhatsAppApiImageMessage({
        to,
        imageUrl: 'https://cdn.example.test/chat/foto.jpg',
        externalId: `direct-url-image-${randomUUID()}`,
        allowQrFallback: false
      })
      await sendWhatsAppApiDocumentMessage({
        to,
        documentUrl: 'https://cdn.example.test/chat/contrato.pdf',
        filename: 'contrato.pdf',
        mimeType: 'application/pdf',
        externalId: `direct-url-document-${randomUUID()}`,
        allowQrFallback: false
      })
      await sendWhatsAppApiVideoMessage({
        to,
        videoUrl: 'https://cdn.example.test/chat/video.mp4',
        externalId: `direct-url-video-${randomUUID()}`,
        allowQrFallback: false
      })
      await sendWhatsAppApiAudioMessage({
        to,
        audioUrl: 'https://cdn.example.test/chat/nota.ogg',
        voice: true,
        durationMs: 1_200,
        externalId: `direct-url-audio-${randomUUID()}`,
        allowQrFallback: false
      })

      assert.equal(captures.uploads.length, 0)
      assert.equal(captures.messages.length, 4)
      assert.equal(captures.messages[0].image.link, 'https://cdn.example.test/chat/foto.jpg')
      assert.equal(captures.messages[1].document.link, 'https://cdn.example.test/chat/contrato.pdf')
      assert.equal(captures.messages[2].video.link, 'https://cdn.example.test/chat/video.mp4')
      assert.equal(captures.messages[3].audio.link, 'https://cdn.example.test/chat/nota.ogg')
      assert.equal(captures.messages[3].audio.voice, true)
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE to_phone = ? OR phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})
