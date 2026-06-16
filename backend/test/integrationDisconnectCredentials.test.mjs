import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  connectWhatsAppApi,
  disconnectWhatsAppApi,
  getWhatsAppApiConfigKeys,
  getWhatsAppApiStatus,
  previewWhatsAppApiPhoneNumbers
} from '../src/services/whatsappApiService.js'
import {
  connectEmail,
  disconnectEmail,
  getEmailStatus
} from '../src/services/emailService.js'

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
