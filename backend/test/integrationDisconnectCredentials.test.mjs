import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  connectWhatsAppApi,
  disconnectMetaDirectConnection,
  disconnectWhatsAppPhoneNumber,
  disconnectWhatsAppApi,
  getYCloudWebhookIngressDecision,
  getWhatsAppApiConfigKeys,
  getWhatsAppApiStatus,
  previewWhatsAppApiPhoneNumbers,
  repairDisconnectedYCloudPhoneRows,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import { handleYCloudWhatsAppApiWebhook } from '../src/controllers/whatsappApiController.js'
import {
  connectEmail,
  disconnectEmail,
  getEmailStatus
} from '../src/services/emailService.js'
import { getIntegrationAppConfigKeys } from '../src/services/integrationCredentialsCleanupService.js'

const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'

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

function whatsappConnectionKeys() {
  const keys = getWhatsAppApiConfigKeys()
  return {
    keys,
    all: [
      keys.enabled,
      keys.apiKey,
      keys.senderPhone,
      keys.phoneNumberId,
      keys.wabaId,
      keys.provider,
      keys.webhookEndpointId,
      keys.webhookSecret,
      keys.webhookUrl,
      keys.webhookStatus,
      keys.connectedAt,
      keys.disconnectedAt,
      keys.lastSyncedAt,
      keys.lastError
    ],
    deletedOnDisconnect: [
      keys.apiKey,
      keys.senderPhone,
      keys.phoneNumberId,
      keys.wabaId,
      keys.webhookEndpointId,
      keys.webhookSecret,
      keys.webhookUrl,
      keys.webhookStatus,
      keys.connectedAt,
      keys.lastSyncedAt
    ]
  }
}

async function countExistingAppConfig(keys = []) {
  const placeholders = keys.map(() => '?').join(', ')
  const row = await db.get(
    `SELECT COUNT(*) AS total FROM app_config WHERE config_key IN (${placeholders})`,
    keys
  )
  return Number(row?.total || 0)
}

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body)
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil(predicate, { timeoutMs = 500, intervalMs = 10, label = 'condition' } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await wait(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('desconectar WhatsApp API borra credenciales locales y evita reconectar sin API key', async () => {
  await initializeMasterKey()
  const { keys, all, deletedOnDisconnect } = whatsappConnectionKeys()

  await snapshotAppConfig(all, async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_test_secret'))
    await setAppConfig(keys.webhookSecret, encrypt('webhook_secret'))
    await setAppConfig(keys.senderPhone, '+526561234567')
    await setAppConfig(keys.phoneNumberId, 'phone_number_123')
    await setAppConfig(keys.wabaId, 'waba_123')
    await setAppConfig(keys.webhookEndpointId, '')
    await setAppConfig(keys.webhookUrl, '')
    await setAppConfig(keys.webhookStatus, 'active')
    await setAppConfig(keys.connectedAt, '2026-06-15T20:00:00.000Z')
    await setAppConfig(keys.lastSyncedAt, '2026-06-15T20:00:00.000Z')

    const disconnected = await disconnectWhatsAppApi()

    assert.equal(disconnected.connected, false)
    assert.equal(disconnected.configured, false)
    assert.equal(disconnected.credentials.hasApiKey, false)
    assert.equal(await getAppConfig(keys.enabled), '0')
    assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)

    await assert.rejects(
      () => connectWhatsAppApi({}),
      /Pega la llave de WhatsApp API/
    )
  })
})

test('desconectar YCloud confirma el webhook remoto antes de borrar sus credenciales', async () => {
  await initializeMasterKey()
  const { keys, all, deletedOnDisconnect } = whatsappConnectionKeys()
  const phoneId = 'test_ycloud_verified_disconnect'
  const requests = []

  setYCloudFetchForTest(async (url, options = {}) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace(/^\/v2/, '')
    const method = String(options.method || 'GET').toUpperCase()
    requests.push({ path, method, body: JSON.parse(options.body || '{}') })
    assert.equal(path, '/webhookEndpoints/webhook_verified_disconnect')
    assert.equal(method, 'PATCH')
    return ycloudJsonResponse({ id: 'webhook_verified_disconnect', status: 'disabled' })
  })

  try {
    await snapshotAppConfig(all, async () => {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_verified_disconnect_secret'))
      await setAppConfig(keys.provider, 'ycloud')
      await setAppConfig(keys.webhookEndpointId, 'webhook_verified_disconnect')
      await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')
      await setAppConfig(keys.webhookStatus, 'active')
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          status, api_send_enabled, is_default_sender
        ) VALUES (?, 'ycloud', '+526561234568', '+52 656 123 4568', 'YCloud desconexion', 'CONNECTED', 1, 1)
      `, [phoneId])

      const disconnected = await disconnectWhatsAppApi()
      const localPhone = await db.get(
        'SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?',
        [phoneId]
      )

      assert.equal(requests.length, 1)
      assert.deepEqual(requests[0].body, { status: 'disabled' })
      assert.equal(localPhone, null)
      assert.equal(disconnected.connected, false)
      assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)
      assert.equal((await getYCloudWebhookIngressDecision({ endpointId: 'webhook_verified_disconnect' })).allowed, false)
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('si YCloud falla al apagar el webhook, Ristak bloquea la entrada y conserva datos para reintentar', async () => {
  await initializeMasterKey()
  const { keys, all } = whatsappConnectionKeys()
  const phoneId = 'test_ycloud_pending_disconnect'

  setYCloudFetchForTest(async () => ycloudJsonResponse(
    { message: 'provider unavailable' },
    { status: 503, statusText: 'Unavailable' }
  ))

  try {
    await snapshotAppConfig(all, async () => {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_pending_disconnect_secret'))
      await setAppConfig(keys.provider, 'ycloud')
      await setAppConfig(keys.webhookEndpointId, 'webhook_pending_disconnect')
      await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')
      await setAppConfig(keys.webhookStatus, 'active')
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          status, api_send_enabled, is_default_sender
        ) VALUES (?, 'ycloud', '+526561234569', '+52 656 123 4569', 'YCloud pendiente', 'CONNECTED', 1, 1)
      `, [phoneId])

      await assert.rejects(
        () => disconnectWhatsAppApi(),
        error => error?.code === 'YCLOUD_WEBHOOK_DISCONNECT_PENDING' && error?.statusCode === 502
      )

      const localPhone = await db.get(
        'SELECT api_send_enabled, is_default_sender FROM whatsapp_api_phone_numbers WHERE id = ?',
        [phoneId]
      )
      assert.equal(await getAppConfig(keys.enabled), '0')
      assert.equal(Number(localPhone.api_send_enabled), 0)
      assert.equal(Number(localPhone.is_default_sender), 0)
      assert.ok(await getAppConfig(keys.apiKey))
      assert.equal(await getAppConfig(keys.webhookEndpointId), 'webhook_pending_disconnect')
      assert.equal(await getAppConfig(keys.webhookStatus), 'disconnect_pending')
      assert.match(await getAppConfig(keys.lastError), /bloqueado localmente/)
      assert.deepEqual(
        await getYCloudWebhookIngressDecision({ endpointId: 'webhook_pending_disconnect' }),
        { allowed: false, reason: 'integration_disabled' }
      )
    })
  } finally {
    setYCloudFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('un webhook YCloud ya eliminado permite completar la limpieza local', async () => {
  await initializeMasterKey()
  const { keys, all, deletedOnDisconnect } = whatsappConnectionKeys()

  setYCloudFetchForTest(async () => ycloudJsonResponse(
    { message: 'webhook not found' },
    { status: 404, statusText: 'Not Found' }
  ))

  try {
    await snapshotAppConfig(all, async () => {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_deleted_webhook_secret'))
      await setAppConfig(keys.webhookEndpointId, 'webhook_already_deleted')
      await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')

      const disconnected = await disconnectWhatsAppApi()

      assert.equal(disconnected.connected, false)
      assert.equal(disconnected.configured, false)
      assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)
    })
  } finally {
    setYCloudFetchForTest(null)
  }
})

test('el receptor YCloud exige conexion local, endpoint configurado y al menos un numero activo', async () => {
  await initializeMasterKey()
  const { keys, all } = whatsappConnectionKeys()
  const phoneId = 'test_ycloud_ingress_guard'
  const eventId = 'event_ycloud_ingress_guard'

  try {
    await snapshotAppConfig(all, async () => {
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_ingress_guard_secret'))
      await setAppConfig(keys.webhookEndpointId, 'webhook_ingress_guard')

      assert.deepEqual(
        await getYCloudWebhookIngressDecision({ endpointId: 'otro_endpoint' }),
        { allowed: false, reason: 'endpoint_mismatch' }
      )

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, phone_number, display_phone_number, verified_name,
          status, api_send_enabled, is_default_sender
        ) VALUES (?, 'ycloud', '+526561234570', '+52 656 123 4570', 'YCloud ingreso', 'CONNECTED', 0, 0)
      `, [phoneId])

      assert.deepEqual(
        await getYCloudWebhookIngressDecision({ endpointId: 'webhook_ingress_guard' }),
        { allowed: false, reason: 'no_active_ycloud_phone' }
      )

      await db.run('UPDATE whatsapp_api_phone_numbers SET api_send_enabled = 1 WHERE id = ?', [phoneId])
      assert.deepEqual(
        await getYCloudWebhookIngressDecision(),
        { allowed: true, reason: 'active_connection' }
      )
      assert.deepEqual(
        await getYCloudWebhookIngressDecision({ endpointId: 'webhook_ingress_guard' }),
        { allowed: true, reason: 'active_connection' }
      )

      await setAppConfig(keys.enabled, '0')
      let responseStatus = 0
      let responsePayload = null
      const req = {
        body: { id: eventId, type: 'whatsapp.inbound_message.received' },
        rawBody: JSON.stringify({ id: eventId, type: 'whatsapp.inbound_message.received' }),
        get: header => header === 'X-Webhook-Endpoint-ID' ? 'webhook_ingress_guard' : ''
      }
      const res = {
        status(value) {
          responseStatus = value
          return this
        },
        json(value) {
          responsePayload = value
          return this
        }
      }

      await handleYCloudWhatsAppApiWebhook(req, res)
      assert.equal(responseStatus, 200)
      assert.deepEqual(responsePayload, { success: true })
      assert.equal(
        Number((await db.get('SELECT COUNT(*) AS total FROM whatsapp_api_webhook_events WHERE event_id = ?', [eventId]))?.total || 0),
        0
      )
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE event_id = ?', [eventId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('WhatsApp API limpia llaves viejas sólo en comandos y mantiene GET status read-only', async () => {
  await initializeMasterKey()
  const { keys, all, deletedOnDisconnect } = whatsappConnectionKeys()

  await snapshotAppConfig(all, async () => {
    await setAppConfig(keys.enabled, '0')
    await setAppConfig(keys.apiKey, encrypt('ycloud_stale_secret'))
    await setAppConfig(keys.senderPhone, '+526560000000')
    await setAppConfig(keys.phoneNumberId, 'old_phone_number')

    await assert.rejects(
      () => connectWhatsAppApi({}),
      /Pega la llave de WhatsApp API/
    )
    assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)

    await setAppConfig(keys.enabled, '0')
    await setAppConfig(keys.apiKey, encrypt('ycloud_stale_secret'))

    await assert.rejects(
      () => previewWhatsAppApiPhoneNumbers({}),
      /Pega la llave de WhatsApp API/
    )
    assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)

    await setAppConfig(keys.enabled, '0')
    await setAppConfig(keys.apiKey, encrypt('ycloud_stale_secret'))

    const status = await getWhatsAppApiStatus()
    assert.equal(status.configured, false)
    assert.equal(status.credentials.hasApiKey, false)
    assert.equal(await countExistingAppConfig(deletedOnDisconnect), 1)
  })
})

test('conectar WhatsApp API responde sin esperar la sincronización pesada de YCloud', async () => {
  await initializeMasterKey()
  const { keys, all } = whatsappConnectionKeys()
  const phoneId = 'phone_fast_connect_test'
  let contactRequested = false
  let releaseContacts = () => {}
  const contactsGate = new Promise(resolve => {
    releaseContacts = resolve
  })
  let connectPromise = null
  let transactionOpen = false

  setYCloudFetchForTest(async (url, options = {}) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname.replace(/^\/v2/, '')
    const method = String(options.method || 'GET').toUpperCase()

    if (path === '/whatsapp/phoneNumbers') {
      return ycloudJsonResponse({
        items: [{
          id: phoneId,
          wabaId: 'waba_fast_connect_test',
          phoneNumber: '+526561234567',
          displayPhoneNumber: '+52 656 123 4567',
          verifiedName: 'Ristak Test',
          qualityRating: 'GREEN',
          status: 'CONNECTED'
        }],
        total: 1
      })
    }

    if (path === '/balance') {
      return ycloudJsonResponse({ message: 'balance skipped in test' }, { status: 503, statusText: 'Unavailable' })
    }

    if (path === '/whatsapp/templates') {
      return ycloudJsonResponse({ items: [], total: 0 })
    }

    if (/^\/whatsapp\/phoneNumbers\/.+\/.+\/profile$/.test(path)) {
      return ycloudJsonResponse({ verifiedName: 'Ristak Test', businessName: 'Ristak' })
    }

    if (path === '/webhookEndpoints' && method === 'GET') {
      return ycloudJsonResponse({ items: [], total: 0 })
    }

    if (path === '/webhookEndpoints' && method === 'POST') {
      const body = JSON.parse(options.body || '{}')
      return ycloudJsonResponse({
        id: 'webhook_fast_connect_test',
        url: body.url,
        status: 'active',
        secret: 'webhook_secret_test'
      })
    }

    if (path === '/contact/contacts') {
      contactRequested = true
      await contactsGate
      return ycloudJsonResponse({ items: [], total: 0 })
    }

    if (path === '/whatsapp/messages') {
      return ycloudJsonResponse({ items: [], total: 0 })
    }

    throw new Error(`Unexpected YCloud test request ${method} ${path}`)
  })

  try {
    await db.run('BEGIN IMMEDIATE')
    transactionOpen = true
    const placeholders = all.map(() => '?').join(', ')
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, all)

    connectPromise = connectWhatsAppApi({
      apiKey: 'ycloud_fast_connect_secret',
      webhookUrl: 'https://example.test/api/webhooks/whatsapp-api/ycloud'
    })

    const status = await Promise.race([
      connectPromise,
      wait(2000).then(() => {
        throw new Error('La conexión esperó la sincronización pesada de YCloud')
      })
    ])

    assert.equal(status.connected, true)
    assert.equal(status.phoneNumbers.some(phone => phone.id === phoneId), true)

    await waitUntil(() => contactRequested, { label: 'background YCloud contacts sync' })
    await setAppConfig(keys.enabled, '0')
    releaseContacts()
    await wait(25)
  } finally {
    releaseContacts()
    if (connectPromise) await connectPromise.catch(() => null)
    setYCloudFetchForTest(null)
    if (transactionOpen) {
      await db.run('ROLLBACK').catch(() => undefined)
    }
  }
})

test('desconectar correo borra datos SMTP y password local', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY], async () => {
    await setAppConfig(EMAIL_CONFIG_KEY, {
      host: 'smtp.example.test',
      port: 587,
      username: 'ventas@example.test',
      fromEmail: 'ventas@example.test',
      connected: true,
      connectedAt: '2026-06-15T20:00:00.000Z'
    })
    await setAppConfig(EMAIL_PASSWORD_KEY, encrypt('smtp_secret'))

    const connected = await getEmailStatus()
    assert.equal(connected.connected, true)
    assert.equal(connected.configured, true)
    assert.equal(connected.smtp.hasPassword, true)

    const disconnected = await disconnectEmail()
    assert.equal(disconnected.connected, false)
    assert.equal(disconnected.configured, false)
    assert.equal(disconnected.smtp.hasPassword, false)
    assert.equal(await countExistingAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY]), 0)
  })
})

test('correo no reutiliza password SMTP viejo cuando estaba desconectado', async () => {
  await initializeMasterKey()

  await snapshotAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY], async () => {
    await setAppConfig(EMAIL_CONFIG_KEY, {
      host: 'smtp.example.test',
      port: 587,
      username: 'ventas@example.test',
      fromEmail: 'ventas@example.test',
      connected: false,
      disconnectedAt: '2026-06-15T21:00:00.000Z'
    })
    await setAppConfig(EMAIL_PASSWORD_KEY, encrypt('smtp_stale_secret'))

    await assert.rejects(
      () => connectEmail({
        host: 'smtp.example.test',
        port: 587,
        username: 'ventas@example.test',
        fromEmail: 'ventas@example.test'
      }),
      /password/
    )
    assert.equal(await countExistingAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY]), 0)

    await setAppConfig(EMAIL_CONFIG_KEY, {
      host: 'smtp.example.test',
      port: 587,
      username: 'ventas@example.test',
      fromEmail: 'ventas@example.test',
      connected: false
    })
    await setAppConfig(EMAIL_PASSWORD_KEY, encrypt('smtp_stale_secret'))

    const status = await getEmailStatus()
    assert.equal(status.connected, false)
    assert.equal(status.configured, false)
    assert.equal(status.smtp.hasPassword, false)
    assert.equal(await countExistingAppConfig([EMAIL_CONFIG_KEY, EMAIL_PASSWORD_KEY]), 0)
  })
})

test('desconectar WhatsApp Meta directo borra token e identificadores reutilizables', async () => {
  await initializeMasterKey()
  const metaDirectKeys = getIntegrationAppConfigKeys('whatsappMetaDirect')
  const snapshotKeys = [
    ...metaDirectKeys,
    'whatsapp_api_provider',
    'whatsapp_meta_direct_disconnected_at'
  ]

  await snapshotAppConfig(snapshotKeys, async () => {
    for (const key of metaDirectKeys) {
      await setAppConfig(key, key.includes('token') ? encrypt('meta_direct_secret') : `value_${key}`)
    }
    await setAppConfig('whatsapp_api_provider', 'meta_direct')
    const metaPhoneNumberId = 'value_whatsapp_meta_direct_phone_number_id'
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, qr_send_enabled, qr_status
      ) VALUES (?, 'meta_direct', 'waba_meta_disconnect', '+526568619478', '+52 656 861 9478', 'Meta directo', 'CONNECTED', 1, 0, 'disconnected')
      ON CONFLICT(id) DO UPDATE SET provider = 'meta_direct', api_send_enabled = 1
    `, [metaPhoneNumberId])

    try {
      const disconnected = await disconnectMetaDirectConnection()

      assert.equal(disconnected.metaDirect.connected, false)
      assert.equal(disconnected.metaDirect.configured, false)
      assert.equal(disconnected.metaDirect.hasSystemUserToken, false)
      assert.equal(await getAppConfig('whatsapp_meta_direct_status'), 'disconnected')
      assert.equal(await getAppConfig('whatsapp_api_provider'), 'ycloud')
      assert.ok(await getAppConfig('whatsapp_meta_direct_disconnected_at'))
      assert.equal(await countExistingAppConfig(metaDirectKeys), 1)
      assert.equal(await getAppConfig('whatsapp_meta_direct_system_user_token_encrypted'), null)
      assert.equal(await getAppConfig('whatsapp_meta_direct_waba_id'), null)
      assert.equal(await getAppConfig('whatsapp_meta_direct_phone_number_id'), null)
      assert.equal(await getAppConfig('whatsapp_meta_direct_installer_webhook_url'), null)
      const localPhone = await db.get('SELECT api_send_enabled FROM whatsapp_api_phone_numbers WHERE id = ?', [metaPhoneNumberId])
      assert.equal(Number(localPhone.api_send_enabled), 0)
      assert.equal(disconnected.phoneNumbers.some(phone => phone.id === metaPhoneNumberId), false)
    } finally {
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [metaPhoneNumberId])
    }
  })
})

test('desconectar una fila YCloud solo retira ese número de Ristak', async () => {
  const firstId = 'test_ycloud_row_disconnect_first'
  const secondId = 'test_ycloud_row_disconnect_second'
  const metaId = 'test_meta_fallback_after_ycloud_disconnect'
  const previousDefaults = await db.all('SELECT id FROM whatsapp_api_phone_numbers WHERE is_default_sender = 1')

  try {
    await initializeMasterKey()
    await snapshotAppConfig([
      'whatsapp_api_phone_number_id',
      'whatsapp_api_sender_phone',
      'whatsapp_api_waba_id',
      'whatsapp_api_provider',
      'whatsapp_api_last_synced_at',
      'whatsapp_api_last_error',
      ...getIntegrationAppConfigKeys('whatsappMetaDirect')
    ], async () => {
      try {
        await db.run(`
          INSERT INTO whatsapp_api_phone_numbers (
            id, provider, waba_id, phone_number, display_phone_number, verified_name,
            status, api_send_enabled, qr_send_enabled, qr_status, is_default_sender
          ) VALUES
            (?, 'ycloud', 'waba_row_disconnect', '+526561110001', '+52 656 111 0001', 'YCloud uno', 'CONNECTED', 1, 0, 'disconnected', 1),
            (?, 'ycloud', 'waba_row_disconnect', '+526561110002', '+52 656 111 0002', 'YCloud dos', 'CONNECTED', 1, 0, 'disconnected', 0)
          ON CONFLICT(id) DO UPDATE SET api_send_enabled = 1, qr_send_enabled = 0, qr_status = 'disconnected'
        `, [firstId, secondId])
        await setAppConfig('whatsapp_api_phone_number_id', firstId)
        await setAppConfig('whatsapp_api_sender_phone', '+526561110001')

        const status = await disconnectWhatsAppPhoneNumber({ phoneNumberId: firstId, connection: 'api' })
        const [first, second] = await Promise.all([
          db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [firstId]),
          db.get('SELECT api_send_enabled, is_default_sender FROM whatsapp_api_phone_numbers WHERE id = ?', [secondId])
        ])

        assert.equal(first, null)
        assert.equal(Number(second.api_send_enabled), 1)
        assert.equal(Number(second.is_default_sender), 1)
        assert.equal(status.phoneNumbers.some(phone => phone.id === firstId), false)
        assert.equal(status.phoneNumbers.some(phone => phone.id === secondId), true)
        assert.equal(await getAppConfig('whatsapp_api_phone_number_id'), secondId)

        await db.run(`
          INSERT INTO whatsapp_api_phone_numbers (
            id, provider, waba_id, phone_number, display_phone_number, verified_name,
            status, api_send_enabled, qr_send_enabled, qr_status, is_default_sender
          ) VALUES (?, 'meta_direct', 'waba_meta_fallback', '+526561110003', '+52 656 111 0003', 'Meta fallback', 'CONNECTED', 1, 0, 'disconnected', 0)
        `, [metaId])
        await setAppConfig('whatsapp_meta_direct_status', 'connected')
        await setAppConfig('whatsapp_meta_direct_waba_id', 'waba_meta_fallback')
        await setAppConfig('whatsapp_meta_direct_phone_number_id', metaId)
        await setAppConfig('whatsapp_meta_direct_system_user_token_encrypted', encrypt('meta_fallback_secret'))
        await setAppConfig('whatsapp_api_provider', 'ycloud')

        const fallbackStatus = await disconnectWhatsAppPhoneNumber({ phoneNumberId: secondId, connection: 'api' })
        assert.equal(await getAppConfig('whatsapp_api_provider'), 'meta_direct')
        assert.equal(fallbackStatus.activeProvider, 'meta_direct')
        assert.equal(fallbackStatus.phoneNumbers.some(phone => phone.id === metaId), true)
      } finally {
        await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?, ?)', [firstId, secondId, metaId])
      }
    })
  } finally {
    await db.run('UPDATE whatsapp_api_phone_numbers SET is_default_sender = 0 WHERE is_default_sender != 0')
    for (const row of previousDefaults) {
      await db.run('UPDATE whatsapp_api_phone_numbers SET is_default_sender = 1 WHERE id = ?', [row.id])
    }
  }
})

test('reparación de desconexión elimina filas YCloud muertas y conserva respaldos QR sin identidad YCloud', async () => {
  const deadId = 'test_ycloud_stale_dead_row'
  const qrId = 'test_ycloud_stale_qr_row'
  const replacementId = 'test_meta_replacement_row'
  const contactId = 'test_ycloud_stale_contact'
  const cleanupKey = 'whatsapp_ycloud_disconnected_phone_cleanup_version'

  await initializeMasterKey()
  await snapshotAppConfig([
    'whatsapp_api_enabled',
    'whatsapp_api_ycloud_api_key_encrypted',
    'whatsapp_api_provider',
    'whatsapp_api_phone_number_id',
    'whatsapp_api_sender_phone',
    'whatsapp_api_waba_id',
    cleanupKey
  ], async () => {
    try {
      await setAppConfig('whatsapp_api_enabled', '0')
      await setAppConfig('whatsapp_api_provider', 'meta_direct')
      await setAppConfig(cleanupKey, 'v1')
      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          status, api_send_enabled, qr_send_enabled, qr_status, is_default_sender
        ) VALUES
          (?, 'ycloud', 'waba_dead', '+526561119901', '+52 656 111 9901', 'YCloud muerto', 'CONNECTED', 0, 1, 'disconnected_428', 0),
          (?, 'ycloud', 'waba_qr', '+526561119902', '+52 656 111 9902', 'YCloud con QR', 'CONNECTED', 0, 1, 'qr_repair_required', 0),
          (?, 'meta_direct', 'waba_meta', '+526561119901', '+52 656 111 9901', 'Meta sano', 'CONNECTED', 1, 0, 'disconnected', 1)
      `, [deadId, qrId, replacementId])
      await db.run(`
        INSERT INTO whatsapp_qr_sessions (
          id, phone_number_id, expected_phone, status, consent_accepted, last_error
        ) VALUES
          (?, ?, '+526561119901', 'disconnected_428', 1, 'Connection Terminated by Server'),
          (?, ?, '+526561119902', 'qr_repair_required', 1, 'Vuelve a vincular')
      `, [`session_${deadId}`, deadId, `session_${qrId}`, qrId])
      await db.run(
        'INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json) VALUES (?, ?, ?)',
        [qrId, 'creds', '{"registered":true}']
      )
      await db.run(
        'INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json) VALUES (?, ?, ?)',
        [deadId, 'creds', '{"registered":true}']
      )
      await db.run(`
        INSERT INTO contacts (id, phone, full_name, source, preferred_whatsapp_phone_number_id)
        VALUES (?, '+526561110099', 'Contacto reparación YCloud', 'test', ?)
      `, [contactId, deadId])

      const result = await repairDisconnectedYCloudPhoneRows()
      const [dead, qr, contact] = await Promise.all([
        db.get('SELECT id FROM whatsapp_api_phone_numbers WHERE id = ?', [deadId]),
        db.get(`
          SELECT provider, waba_id, status, api_send_enabled, qr_send_enabled, raw_payload_json
          FROM whatsapp_api_phone_numbers WHERE id = ?
        `, [qrId]),
        db.get('SELECT preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?', [contactId])
      ])

      assert.equal(result.removed, 1)
      assert.equal(result.convertedToQr, 1)
      assert.equal(dead, null)
      assert.equal(qr.provider, 'qr')
      assert.equal(qr.waba_id, null)
      assert.equal(qr.status, 'QR_ONLY')
      assert.equal(Number(qr.api_send_enabled), 0)
      assert.equal(Number(qr.qr_send_enabled), 1)
      assert.match(qr.raw_payload_json, /qr_only_after_ycloud_disconnect/)
      assert.equal(contact.preferred_whatsapp_phone_number_id, replacementId)
    } finally {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?, ?)', [deadId, qrId, replacementId]).catch(() => undefined)
    }
  })
})
