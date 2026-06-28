import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiAudioMessage,
  sendWhatsAppApiDocumentMessage,
  sendWhatsAppApiImageMessage,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

const ONE_PIXEL_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC'
const PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlIC9QYWdlcyAvQ291bnQgMD4+CmVuZG9iago='
const OGG_OPUS_DATA_URL = `data:audio/ogg;codecs=opus;base64,${Buffer.from('OggSprovider-media-test').toString('base64')}`

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
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

    try {
      return await callback(captures)
    } finally {
      setYCloudFetchForTest(null)
    }
  })
}

test('envío API de imagen sube media al proveedor y manda por media id sin Bunny', async () => {
  await withYCloudProviderMediaCapture(async (captures) => {
    const suffix = randomUUID()
    const to = `+52156${Date.now().toString().slice(-8)}`
    const externalId = `provider-image-${suffix}`

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

      const row = await db.get(
        `SELECT media_url, media_mime_type, media_filename, raw_payload_json
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?`,
        ['ycloud_provider_message_1']
      )
      assert.ok(row)
      assert.equal(row.media_url, null)
      assert.equal(row.media_mime_type, 'image/jpeg')
      assert.equal(row.media_filename, 'whatsapp-image.jpg')
      const raw = JSON.parse(row.raw_payload_json)
      assert.equal(raw.image.id, 'provider_media_1')
      assert.equal(raw.image.providerMediaId, 'provider_media_1')
      assert.equal(raw.image.storageProvider, 'ycloud')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR to_phone = ?', ['ycloud_provider_message_1', to])
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
