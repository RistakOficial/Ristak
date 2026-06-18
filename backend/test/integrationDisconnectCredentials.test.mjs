import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  connectWhatsAppApi,
  disconnectMetaDirectConnection,
  disconnectWhatsAppApi,
  getWhatsAppApiConfigKeys,
  getWhatsAppApiStatus,
  previewWhatsAppApiPhoneNumbers,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
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
    await setAppConfig(keys.webhookUrl, 'https://example.test/webhook/whatsapp-api/ycloud')
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

test('WhatsApp API limpia llaves viejas marcadas como desconectadas', async () => {
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
    assert.equal(await countExistingAppConfig(deletedOnDisconnect), 0)
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
      wait(250).then(() => {
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
  })
})
