import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiAudioMessage,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiImageMessage,
  sendWhatsAppApiVideoMessage,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlIC9QYWdlcyAvQ291bnQgMD4+CmVuZG9iago='
const OGG_OPUS_DATA_URL = `data:audio/ogg;codecs=opus;base64,${Buffer.from('OggSprovider-media-test').toString('base64')}`
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
    "fs.writeFileSync(outputPath, Buffer.from('converted-video-for-whatsapp'));",
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
    messages: []
  }

  return snapshotAppConfig(configKeys, async () => {
    forceLocalMediaStorageForProviderPreview()
    try {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_provider_media_secret'))
      await setAppConfig(keys.senderPhone, '+526561234567')
      await setAppConfig(keys.phoneNumberId, 'phone_ycloud_provider_media_test')
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
            size: bytes.length
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

test('envío API de imagen sube media al proveedor y conserva preview interno sin mandar link a yCloud', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52156${Date.now().toString().slice(-8)}`
    const externalId = `provider-image-${suffix}`
    let previewMediaAssetId = ''

    try {
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
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ?', ['ycloud_provider_message_1', to])
      if (previewMediaAssetId) {
        await db.run('DELETE FROM media_assets WHERE id = ?', [previewMediaAssetId]).catch(() => undefined)
      }
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
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ?', ['ycloud_provider_message_1', to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envío API de audio sube nota de voz al proveedor sin usar URL propia', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52158${Date.now().toString().slice(-8)}`
    const externalId = `provider-audio-${suffix}`

    try {
      const response = await sendWhatsAppApiAudioMessage({
        to,
        audioDataUrl: OGG_OPUS_DATA_URL,
        externalId,
        allowQrFallback: false,
        durationMs: 1200
      })

      assert.equal(captures.uploads.length, 1)
      assert.equal(captures.uploads[0].filename, 'whatsapp-audio.ogg')
      assert.equal(captures.uploads[0].mimeType, 'audio/ogg')
      assert.ok(captures.uploads[0].size > 0)

      assert.equal(captures.messages.length, 1)
      assert.equal(captures.messages[0].type, 'audio')
      assert.equal(captures.messages[0].audio.id, 'provider_media_1')
      assert.equal(captures.messages[0].audio.link, undefined)
      assert.equal(captures.messages[0].audio.voice, true)
      assert.equal(response.audio.providerMediaId, 'provider_media_1')
      assert.equal(response.audio.durationMs, 1200)

      const row = await db.get(
        `SELECT media_url, media_mime_type, media_filename, media_duration_ms, raw_payload_json
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        ['ycloud_provider_message_1']
      )
      assert.ok(row)
      assert.equal(row.media_url, null)
      assert.equal(row.media_mime_type, 'audio/ogg; codecs=opus')
      assert.equal(row.media_filename, 'whatsapp-audio.ogg')
      assert.equal(row.media_duration_ms, 1200)
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.audio.id, 'provider_media_1')
      assert.equal(raw.audio.storage, 'provider')
      assert.equal(raw.audio.storageProvider, 'ycloud')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ?', ['ycloud_provider_message_1', to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envío API de video comprime a MP4 y manda media tipo video', async () => {
  await withFakeFfmpeg(async () => {
    await withYCloudProviderMediaCapture(async (captures) => {
      const suffix = randomUUID()
      const to = `+52159${Date.now().toString().slice(-8)}`
      const externalId = `provider-video-${suffix}`

      try {
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
        await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ?', ['ycloud_provider_message_1', to])
        await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
        await db.run('DELETE FROM contacts WHERE phone = ?', [to])
      }
    })
  })
})
