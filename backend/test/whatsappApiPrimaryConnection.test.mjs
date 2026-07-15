import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  completeMetaDirectConnection,
  connectWhatsAppApi,
  getWhatsAppApiConfigKeys,
  promoteConnectedWhatsAppApiPhoneNumber,
  setMetaDirectFetchForTest,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import { getWhatsAppProviderDefinitions } from '../src/services/whatsapp/providers/providerRegistry.js'

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
    if (placeholders) await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    return await callback()
  } finally {
    if (placeholders) await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    for (const row of previousRows) await setAppConfig(row.config_key, row.config_value)
  }
}

function jsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
    json: async () => body
  }
}

function signedMetaConnection({ payload, secret, installationId, nonce }) {
  const rawBody = JSON.stringify(payload)
  const timestamp = String(Date.now())
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest('hex')
  return {
    rawBody,
    headers: {
      'x-ristak-signature': signature,
      'x-ristak-timestamp': timestamp,
      'x-ristak-nonce': nonce,
      'x-ristak-installation-id': installationId
    }
  }
}

function signedState({ secret, installationId }) {
  const body = Buffer.from(JSON.stringify({
    installation_id: installationId,
    exp: Date.now() + 60_000
  })).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
  return `${body}.${signature}`
}

async function insertQrFirst({ id, phone }) {
  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, phone_number, display_phone_number, verified_name,
      is_default_sender, api_send_enabled, qr_send_enabled, qr_status,
      qr_connected_phone, status
    ) VALUES (?, 'qr', ?, ?, 'QR conectado primero', 1, 0, 1, 'connected', ?, 'QR_ONLY')
  `, [id, phone, phone, phone])
}

async function readPhoneRows(ids = []) {
  const placeholders = ids.map(() => '?').join(', ')
  return db.all(`
    SELECT id, provider, is_default_sender, api_send_enabled,
      qr_send_enabled, qr_status, qr_connected_phone
    FROM whatsapp_api_phone_numbers
    WHERE id IN (${placeholders})
    ORDER BY id
  `, ids)
}

test('todo proveedor de API oficial registrado puede desplazar un QR previo sin apagar su respaldo', async () => {
  const keys = getWhatsAppApiConfigKeys()
  const officialProviders = getWhatsAppProviderDefinitions().filter(definition => definition.officialApi)

  await snapshotAppConfig([keys.provider, keys.senderPhone, keys.phoneNumberId, keys.wabaId], async () => {
    for (const [index, definition] of officialProviders.entries()) {
      const phone = `+52656090${String(index).padStart(4, '0')}`
      const qrId = `qr_first_generic_${definition.id}`
      const apiId = `api_after_qr_generic_${definition.id}`
      try {
        await insertQrFirst({ id: qrId, phone })
        await db.run(`
          INSERT INTO whatsapp_api_phone_numbers (
            id, provider, waba_id, phone_number, display_phone_number, verified_name,
            is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
          ) VALUES (?, ?, ?, ?, ?, 'API conectada después', 0, 1, 0, 'disconnected', 'CONNECTED')
        `, [apiId, definition.id, `waba_${definition.id}`, phone, phone])

        const result = await promoteConnectedWhatsAppApiPhoneNumber({
          phoneNumberId: apiId,
          provider: definition.id
        })
        const rows = await readPhoneRows([apiId, qrId])
        const apiRow = rows.find(row => row.id === apiId)
        const qrRow = rows.find(row => row.id === qrId)

        assert.equal(apiRow?.is_default_sender, 1)
        assert.equal(qrRow?.is_default_sender, 0)
        assert.equal(qrRow?.qr_send_enabled, 1)
        assert.equal(qrRow?.qr_status, 'connected')
        assert.equal(result.provider, definition.id)
        assert.deepEqual(result.siblingQrPhoneNumberIds, [qrId])
        assert.equal(await getAppConfig(keys.provider), definition.id)
        assert.equal(await getAppConfig(keys.phoneNumberId), apiId)
        assert.equal(await getAppConfig(keys.senderPhone), phone)
        assert.equal(await getAppConfig(keys.wabaId), `waba_${definition.id}`)
      } finally {
        await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [apiId, qrId])
      }
    }
  })
})

test('conectar YCloud después de QR deja YCloud principal y conserva el QR como respaldo', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const allConfigKeys = Object.values(keys)
  const phone = '+526561111101'
  const qrId = 'qr_first_then_ycloud'
  const apiId = 'ycloud_after_qr'
  const wabaId = 'waba_ycloud_after_qr'

  setYCloudFetchForTest(async (input, options = {}) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/v2/, '')
    const method = String(options.method || 'GET').toUpperCase()
    if (path === '/whatsapp/phoneNumbers') {
      return jsonResponse({
        items: [{
          id: apiId,
          wabaId,
          phoneNumber: phone,
          displayPhoneNumber: phone,
          verifiedName: 'YCloud después de QR',
          status: 'CONNECTED'
        }],
        total: 1
      })
    }
    if (path === '/balance') return jsonResponse({}, { status: 503, statusText: 'Unavailable' })
    if (path === '/whatsapp/templates') return jsonResponse({ items: [], total: 0 })
    if (/^\/whatsapp\/phoneNumbers\/.+\/.+\/profile$/.test(path)) {
      return jsonResponse({ verifiedName: 'YCloud después de QR' })
    }
    if (path === '/webhookEndpoints' && method === 'GET') return jsonResponse({ items: [], total: 0 })
    if (path === '/webhookEndpoints' && method === 'POST') {
      return jsonResponse({ id: 'webhook_ycloud_after_qr', status: 'active', url: 'https://example.test/webhook' })
    }
    return jsonResponse({ items: [], total: 0 })
  })

  try {
    await snapshotAppConfig(allConfigKeys, async () => {
      await insertQrFirst({ id: qrId, phone })
      const status = await connectWhatsAppApi({
        apiKey: 'ycloud_primary_connection_test',
        senderPhone: phone,
        webhookUrl: 'https://example.test/webhook'
      })
      const rows = await readPhoneRows([apiId, qrId])
      const apiRow = rows.find(row => row.id === apiId)
      const qrRow = rows.find(row => row.id === qrId)

      assert.equal(status.connected, true)
      assert.equal(apiRow?.is_default_sender, 1)
      assert.equal(qrRow?.is_default_sender, 0)
      assert.equal(qrRow?.qr_send_enabled, 1)
      assert.equal(qrRow?.qr_status, 'connected')
      assert.equal(await getAppConfig(keys.provider), 'ycloud')
      assert.equal(await getAppConfig(keys.phoneNumberId), apiId)
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [apiId, qrId])
  }
})

test('conectar Meta Direct después de QR deja Meta principal y conserva el QR como respaldo', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const secret = 'meta_primary_connection_license'
  const installationId = 'meta-primary-connection-installation'
  const phone = '+526561111102'
  const qrId = 'qr_first_then_meta_direct'
  const phoneNumberId = 'meta_direct_after_qr'
  const wabaId = 'waba_meta_after_qr'
  const nonce = `meta-primary-${crypto.randomUUID()}`
  const configKeys = [
    ...Object.values(keys),
    'license_key',
    'license_client_id',
    'installation_id',
    'public_app_url'
  ]

  setMetaDirectFetchForTest(async (input, options = {}) => {
    const url = new URL(String(input))
    const method = String(options.method || 'GET').toUpperCase()
    if (url.pathname.endsWith(`/${wabaId}/phone_numbers`) && method === 'GET') {
      return jsonResponse({
        data: [{
          id: phoneNumberId,
          display_phone_number: phone,
          verified_name: 'Meta después de QR',
          quality_rating: 'GREEN'
        }]
      })
    }
    if (url.pathname.endsWith(`/${wabaId}/subscribed_apps`) && method === 'POST') {
      return jsonResponse({ success: true })
    }
    return jsonResponse({ error: { message: `Ruta inesperada ${method} ${url.pathname}` } }, { status: 404, statusText: 'Not Found' })
  })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await setAppConfig('license_key', secret)
      await setAppConfig('license_client_id', 'meta-primary-client')
      await setAppConfig('installation_id', installationId)
      await setAppConfig('public_app_url', 'https://tenant-meta-primary.test')
      await insertQrFirst({ id: qrId, phone })

      const payload = {
        state: signedState({ secret, installationId }),
        systemUserToken: 'meta_primary_system_user_token',
        appId: 'meta-primary-app',
        businessId: 'meta-primary-business',
        wabaId,
        phoneNumberId,
        displayPhoneNumber: phone,
        coexistenceEnabled: true
      }
      const signed = signedMetaConnection({ payload, secret, installationId, nonce })
      const status = await completeMetaDirectConnection({
        payload,
        rawBody: signed.rawBody,
        headers: signed.headers
      })
      const rows = await readPhoneRows([phoneNumberId, qrId])
      const apiRow = rows.find(row => row.id === phoneNumberId)
      const qrRow = rows.find(row => row.id === qrId)

      assert.equal(status.metaDirect.connected, true)
      assert.equal(apiRow?.provider, 'meta_direct')
      assert.equal(apiRow?.is_default_sender, 1)
      assert.equal(qrRow?.is_default_sender, 0)
      assert.equal(qrRow?.qr_send_enabled, 1)
      assert.equal(qrRow?.qr_status, 'connected')
      assert.equal(await getAppConfig(keys.provider), 'meta_direct')
      assert.equal(await getAppConfig(keys.phoneNumberId), phoneNumberId)
      assert.equal(await getAppConfig(keys.senderPhone), phone)
      assert.equal(await getAppConfig(keys.wabaId), wabaId)
    })
  } finally {
    setMetaDirectFetchForTest(null)
    await db.run('DELETE FROM whatsapp_meta_direct_nonces WHERE nonce = ?', [nonce]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [phoneNumberId, qrId])
  }
})
