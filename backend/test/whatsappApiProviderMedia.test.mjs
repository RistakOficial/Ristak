import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeFetch from 'node-fetch'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiAudioMessage,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiImageMessage,
  sendWhatsAppApiLocationMessage,
  sendWhatsAppApiVideoMessage,
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
    "fs.writeFileSync(outputPath, isOgg ? Buffer.from('OggS-fake-OpusHead-audio') : Buffer.from('converted-video-for-whatsapp'));",
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
          const file = options.body?.get?.('file')
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

test('envío API de audio sube nota de voz al proveedor y conserva preview interno reproducible', async () => {
  await withFakeFfmpeg(async () => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const suffix = randomUUID()
      const to = `+52158${Date.now().toString().slice(-8)}`
      const externalId = `provider-audio-${suffix}`
      let previewMediaAssetId = ''

      try {
        await captures.openReplyWindow(to)

        const response = await sendWhatsAppApiAudioMessage({
          to,
          audioDataUrl: MP4_AUDIO_DATA_URL,
          externalId,
          allowQrFallback: false,
          durationMs: 1200
        })

        assert.equal(captures.uploads.length, 1)
        assert.equal(captures.uploads[0].filename, 'whatsapp-audio.ogg')
        assert.equal(captures.uploads[0].mimeType, 'audio/ogg; codecs=opus')
        assert.ok(captures.uploads[0].size > 0)
        assert.equal(captures.uploads[0].bytes.subarray(0, 4).toString('latin1'), 'OggS')
        assert.ok(captures.uploads[0].bytes.includes(Buffer.from('OpusHead', 'ascii')))

        assert.equal(captures.messages.length, 1)
        assert.equal(captures.messages[0].type, 'audio')
        assert.equal(captures.messages[0].audio.id, 'provider_media_1')
        assert.equal(captures.messages[0].audio.link, undefined)
        assert.equal(captures.messages[0].audio.voice, true)
        assert.equal(response.audio.providerMediaId, 'provider_media_1')
        assert.equal(response.audio.providerMimeType, 'audio/ogg; codecs=opus')
        assert.equal(response.audio.mimeType, 'audio/mp4')
        assert.match(response.audio.link, /^\/media\/assets\/.+\/file$/)
        assert.equal(response.audio.durationMs, 1200)

        const row = await db.get(
          `SELECT media_url, media_mime_type, media_filename, media_duration_ms, raw_payload_json
           FROM whatsapp_api_messages
           WHERE ycloud_message_id = ?`,
          ['ycloud_provider_message_1']
        )
        assert.ok(row)
        assert.match(row.media_url, /^\/media\/assets\/.+\/file$/)
        assert.equal(row.media_mime_type, 'audio/mp4')
        assert.match(row.media_filename, /\.m4a$/)
        assert.equal(row.media_duration_ms, 1200)
        const raw = JSON.parse(row.raw_payload_json)
        assert.equal(raw.audio.id, 'provider_media_1')
        assert.equal(raw.audio.providerMediaId, 'provider_media_1')
        assert.equal(raw.audio.providerMimeType, 'audio/ogg; codecs=opus')
        assert.equal(raw.audio.storage, 'provider')
        assert.equal(raw.audio.storageProvider, 'ycloud')
        assert.equal(raw.audio.link, row.media_url)
        assert.equal(raw.audio.publicUrl, row.media_url)
        assert.match(raw.audio.previewMediaAssetId, /^rstk_media_[A-Za-z0-9]{20}$/)
        assert.equal(raw.audio.metadata.originalMimeType, 'audio/mp4')
        assert.equal(raw.audio.metadata.originalUploadMimeType, undefined)
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

test('el upload de nota de voz llega a YCloud como multipart binario OGG/Opus', async () => {
  await withFakeFfmpeg(async () => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const requests = []
      let to = ''
      let previewMediaAssetId = ''
      const server = createServer(async (request, response) => {
        const chunks = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        requests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body
        })

        if (/\/whatsapp\/media\/.+\/upload$/.test(request.url || '')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'provider_media_multipart' }))
          return
        }

        const outbound = JSON.parse(body.toString('utf8') || '{}')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'ycloud_provider_message_multipart',
          from: outbound.from,
          to: outbound.to,
          type: outbound.type,
          status: 'sent',
          audio: outbound.audio
        }))
      })

      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const { port } = server.address()

      try {
        // Pasamos el body que construye el servicio a node-fetch real. Si se
        // vuelve a usar el FormData global, node-fetch lo convierte en el texto
        // "[object FormData]" y esta prueba falla antes de tocar YCloud.
        setYCloudFetchForTest((url, options = {}) => {
          const upstream = new URL(String(url))
          return nodeFetch(`http://127.0.0.1:${port}${upstream.pathname}`, options)
        })

        to = `+52158${Date.now().toString().slice(-8)}`
        await captures.openReplyWindow(to)
        const sent = await sendWhatsAppApiAudioMessage({
          to,
          audioDataUrl: MP4_AUDIO_DATA_URL,
          externalId: `provider-audio-multipart-${randomUUID()}`,
          allowQrFallback: false,
          durationMs: 1200
        })
        previewMediaAssetId = sent.audio?.previewMediaAssetId || ''

        const upload = requests.find((request) => /\/whatsapp\/media\/.+\/upload$/.test(request.path || ''))
        assert.ok(upload)
        assert.match(String(upload.headers['content-type'] || ''), /^multipart\/form-data;\s*boundary=/i)
        assert.equal(Number(upload.headers['content-length']), upload.body.length)
        assert.ok(upload.body.includes(Buffer.from('Content-Disposition: form-data; name="file"; filename="whatsapp-audio.ogg"', 'utf8')))
        assert.ok(upload.body.includes(Buffer.from('Content-Type: audio/ogg; codecs=opus', 'utf8')))
        assert.ok(upload.body.includes(Buffer.from('OggS-fake-OpusHead-audio', 'utf8')))
      } finally {
        setYCloudFetchForTest(null)
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ? OR phone = ?', ['ycloud_provider_message_multipart', to, to]).catch(() => undefined)
        if (previewMediaAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [previewMediaAssetId]).catch(() => undefined)
        await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to]).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE phone = ?', [to]).catch(() => undefined)
      }
    })
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
