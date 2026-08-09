import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  repairStoredYCloudInboundMediaBatch,
  setYCloudFetchForTest,
  syncYCloudMessageRecords
} from '../src/services/whatsappApiService.js'
import { resetCentralStorageConfigCache } from '../src/services/mediaStorageService.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64'
)

const ENV_KEYS = [
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
  'INSTALLATION_ID'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key]
    else process.env[key] = snapshot[key]
  }
}

async function snapshotAppConfig(keys) {
  const placeholders = keys.map(() => '?').join(', ')
  return db.all(
    `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
    keys
  )
}

async function restoreAppConfig(keys, rows) {
  const placeholders = keys.map(() => '?').join(', ')
  await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, keys)
  for (const row of rows) {
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `, [row.config_key, row.config_value])
  }
}

test('YCloud descarga media entrante con API key y guarda una copia permanente en Bunny', async () => {
  await initializeMasterKey()
  const suffix = randomUUID()
  const phone = `+52155${Date.now().toString().slice(-8)}`
  const businessPhone = '+526561230099'
  const phoneNumberId = `phone_ycloud_media_bunny_${suffix}`
  const liveMessageId = `ycloud_media_live_${suffix}`
  const legacyMessageId = `ycloud_media_legacy_${suffix}`
  const liveMediaId = `media_live_${suffix}`
  const legacyMediaId = `media_legacy_${suffix}`
  const contactId = `contact_ycloud_media_${suffix}`
  const stateKey = 'whatsapp_api_ycloud_media_rehost_state'
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    stateKey
  ]
  const previousConfig = await snapshotAppConfig(configKeys)
  const previousEnv = snapshotEnv()
  const storedObjects = new Map()
  const providerDownloads = []
  let endpoint = ''
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', endpoint).pathname)
    if (req.method === 'PUT' && pathname.startsWith('/storage/ycloud-media-zone/')) {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      storedObjects.set(pathname.replace('/storage/ycloud-media-zone/', ''), Buffer.concat(chunks))
      res.statusCode = 201
      res.end('ok')
      return
    }
    if (req.method === 'GET' && pathname.startsWith('/cdn/')) {
      const body = storedObjects.get(pathname.replace('/cdn/', ''))
      if (!body) {
        res.statusCode = 404
        res.end('missing')
        return
      }
      res.setHeader('Content-Type', 'image/png')
      res.end(body)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${server.address().port}`

  try {
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
    process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
    process.env.BUNNY_STORAGE_ZONE = 'ycloud-media-zone'
    process.env.BUNNY_STORAGE_REGION = 'NY'
    process.env.BUNNY_STORAGE_ENDPOINT = `${endpoint}/storage`
    process.env.BUNNY_STORAGE_API_KEY = 'storage-test-key'
    process.env.BUNNY_CDN_BASE_URL = `${endpoint}/cdn`
    delete process.env.LICENSE_SERVER_URL
    delete process.env.CLIENT_ID
    delete process.env.LICENSE_KEY
    delete process.env.INSTALLATION_ID
    resetCentralStorageConfigCache()

    await restoreAppConfig(configKeys, [])
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud-media-test-api-key'))
    await setAppConfig(keys.senderPhone, businessPhone)
    await setAppConfig(keys.phoneNumberId, phoneNumberId)
    await setAppConfig(keys.wabaId, 'waba_ycloud_media_bunny')
    await setAppConfig(keys.provider, 'ycloud')

    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'ycloud', 'waba_ycloud_media_bunny', ?, ?, 'YCloud Media Bunny', 1, 1, 0, 'disconnected', 'CONNECTED')
    `, [phoneNumberId, businessPhone, businessPhone])

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.includes('/whatsapp/media/download/')) {
        providerDownloads.push({
          url: parsed.toString(),
          apiKey: options.headers?.['X-API-Key']
        })
        return new Response(PNG_BYTES, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(PNG_BYTES.length)
          }
        })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })

    const liveProviderUrl = `https://api.ycloud.com/v2/whatsapp/media/download/${liveMediaId}?sig=temporary-live`
    const liveStats = await syncYCloudMessageRecords([{
      id: liveMessageId,
      wamid: `wamid.${liveMessageId}`,
      wabaId: 'waba_ycloud_media_bunny',
      from: phone,
      to: businessPhone,
      sendTime: '2026-08-09T15:00:00.000Z',
      type: 'image',
      image: {
        id: liveMediaId,
        link: liveProviderUrl,
        mime_type: 'image/png',
        caption: 'Comprobante'
      }
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.inbound_message.received',
      source: 'ycloud_media_bunny_test'
    })

    assert.equal(liveStats.created, 1)
    assert.equal(providerDownloads[0]?.apiKey, 'ycloud-media-test-api-key')
    const liveRow = await db.get(
      'SELECT id, contact_id, media_url, raw_payload_json FROM whatsapp_api_messages WHERE ycloud_message_id = ?',
      [liveMessageId]
    )
    assert.ok(liveRow)
    assert.match(liveRow.media_url, new RegExp(`^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cdn/`))
    assert.equal(liveRow.media_url.includes('api.ycloud.com'), false)
    assert.equal(JSON.parse(liveRow.raw_payload_json).image.link, liveRow.media_url)
    assert.deepEqual(Buffer.from(await (await fetch(liveRow.media_url)).arrayBuffer()), PNG_BYTES)

    const legacyProviderUrl = `https://api.ycloud.com/v2/whatsapp/media/download/${legacyMediaId}?sig=temporary-legacy`
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, source_adapter, origin, provider_message_id, ycloud_message_id,
        wamid, contact_id, phone, from_phone, to_phone, business_phone,
        business_phone_number_id, transport, direction, message_type, message_text,
        media_url, media_mime_type, media_filename, status, message_timestamp,
        raw_payload_json, created_at, updated_at
      ) VALUES (?, 'ycloud', 'ycloud', 'whatsapp.inbound_message.received', ?, ?, ?, ?, ?, ?, ?, ?,
        ?, 'api', 'inbound', 'image', 'Foto', ?, 'image/png', 'foto.png', 'received', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      legacyMessageId,
      legacyMessageId,
      legacyMessageId,
      `wamid.${legacyMessageId}`,
      liveRow.contact_id,
      phone,
      phone,
      businessPhone,
      businessPhone,
      phoneNumberId,
      legacyProviderUrl,
      '2026-08-09T14:00:00.000Z',
      JSON.stringify({
        id: legacyMessageId,
        type: 'image',
        image: { id: legacyMediaId, link: legacyProviderUrl, mime_type: 'image/png' }
      })
    ])

    const repair = await repairStoredYCloudInboundMediaBatch({
      apiKey: 'ycloud-media-test-api-key',
      limit: 25
    })
    assert.equal(repair.repaired, 1)
    assert.equal(repair.failed, 0)
    const legacyRow = await db.get(
      'SELECT media_url, raw_payload_json FROM whatsapp_api_messages WHERE id = ?',
      [legacyMessageId]
    )
    assert.match(legacyRow.media_url, new RegExp(`^${endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cdn/`))
    assert.equal(JSON.parse(legacyRow.raw_payload_json).image.link, legacyRow.media_url)
    assert.equal(providerDownloads.at(-1)?.apiKey, 'ycloud-media-test-api-key')
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id IN (?, ?)', [liveMessageId, legacyMessageId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [phone]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run(`DELETE FROM media_assets WHERE metadata_json LIKE '%ycloud_inbound_media%'`).catch(() => undefined)
    await restoreAppConfig(configKeys, previousConfig)
    restoreEnv(previousEnv)
    resetCentralStorageConfigCache()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
})
