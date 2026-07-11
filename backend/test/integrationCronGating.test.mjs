import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  isConektaConnected,
  isEmailInboundConnected,
  isClipConnected,
  isGoogleCalendarConnected,
  isHighLevelConnected,
  isMercadoPagoConnected,
  isMetaConnected,
  isRebillConnected,
  isStripeConnected,
  isWhatsAppApiHistoryBackfillPending,
  isWhatsAppQrConnected
} from '../src/services/integrationConnectionStateService.js'
import {
  getIntegrationCronState,
  registerIntegrationCron,
  syncIntegrationCron
} from '../src/jobs/integrationCronRuntime.js'

const APP_CONFIG_WHERE = `
  WHERE config_key = 'payments_settings'
     OR config_key = 'google_calendar_service_account_config'
     OR config_key = 'meta_config_disconnected'
     OR config_key IN ('email_smtp_config', 'email_smtp_password')
     OR config_key LIKE 'stripe_%'
     OR config_key LIKE 'conekta_%'
     OR config_key LIKE 'clip_%'
     OR config_key LIKE 'mercadopago_%'
     OR config_key LIKE 'rebill_%'
     OR config_key IN ('whatsapp_api_enabled', 'whatsapp_api_ycloud_api_key_encrypted', 'whatsapp_api_provider', 'whatsapp_api_history_direction_repair_version')
`

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function snapshotRows(tableName, whereClause = '', params = []) {
  const rows = await db.all(`SELECT * FROM ${tableName} ${whereClause}`, params).catch(() => [])

  return {
    async restore() {
      await db.run(`DELETE FROM ${tableName} ${whereClause}`, params).catch(() => undefined)

      for (const row of rows) {
        const columns = Object.keys(row)
        if (!columns.length) continue
        const quotedColumns = columns.map((column) => `"${column}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        await db.run(
          `INSERT INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`,
          columns.map((column) => row[column])
        )
      }
    }
  }
}

async function withIsolatedIntegrationConfig(callback) {
  const appConfigSnapshot = await snapshotRows('app_config', APP_CONFIG_WHERE)
  const highLevelSnapshot = await snapshotRows('highlevel_config')
  const metaSnapshot = await snapshotRows('meta_config')
  const qrPhoneSnapshot = await db.all('SELECT id, qr_send_enabled FROM whatsapp_api_phone_numbers').catch(() => [])
  const qrSessionSnapshot = await db.all('SELECT id, consent_accepted FROM whatsapp_qr_sessions').catch(() => [])
  const phoneNumberId = uniqueId('phone_qr_cron_gate')

  try {
    await db.run(`DELETE FROM app_config ${APP_CONFIG_WHERE}`)
    await db.run('DELETE FROM highlevel_config')
    await db.run('DELETE FROM meta_config')
    await db.run('UPDATE whatsapp_api_phone_numbers SET qr_send_enabled = 0').catch(() => undefined)
    await db.run('UPDATE whatsapp_qr_sessions SET consent_accepted = 0').catch(() => undefined)
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

    return await callback({ phoneNumberId })
  } finally {
    await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)

    for (const row of qrPhoneSnapshot) {
      await db.run('UPDATE whatsapp_api_phone_numbers SET qr_send_enabled = ? WHERE id = ?', [
        row.qr_send_enabled,
        row.id
      ]).catch(() => undefined)
    }
    for (const row of qrSessionSnapshot) {
      await db.run('UPDATE whatsapp_qr_sessions SET consent_accepted = ? WHERE id = ?', [
        row.consent_accepted,
        row.id
      ]).catch(() => undefined)
    }

    await appConfigSnapshot.restore()
    await highLevelSnapshot.restore()
    await metaSnapshot.restore()
  }
}

test('detectores de crons de integración solo se activan con conexión local válida', async () => {
  await initializeMasterKey()

  await withIsolatedIntegrationConfig(async ({ phoneNumberId }) => {
    assert.equal(await isGoogleCalendarConnected(), false)
    assert.equal(await isHighLevelConnected(), false)
    assert.equal(await isMetaConnected(), false)
    assert.equal(await isStripeConnected(), false)
    assert.equal(await isConektaConnected(), false)
    assert.equal(await isClipConnected(), false)
    assert.equal(await isEmailInboundConnected(), false)
    assert.equal(await isMercadoPagoConnected(), false)
    assert.equal(await isRebillConnected(), false)
    assert.equal(await isWhatsAppApiHistoryBackfillPending(), false)
    assert.equal(await isWhatsAppQrConnected(), false)

    await setAppConfig('whatsapp_api_enabled', '1')
    await setAppConfig('whatsapp_api_ycloud_api_key_encrypted', 'encrypted_ycloud_cron_gate')
    await setAppConfig('whatsapp_api_provider', 'ycloud')
    assert.equal(await isWhatsAppApiHistoryBackfillPending(), true)
    await setAppConfig('whatsapp_api_provider', 'meta_direct')
    assert.equal(await isWhatsAppApiHistoryBackfillPending(), false)
    await setAppConfig('whatsapp_api_provider', 'ycloud')
    await setAppConfig('whatsapp_api_history_direction_repair_version', '2026-07-11-ycloud-smb-echoes-backfill')
    assert.equal(await isWhatsAppApiHistoryBackfillPending(), false)

    await setAppConfig('google_calendar_service_account_config', {
      connectionMode: 'oauth',
      refreshTokenEncrypted: 'encrypted_google_refresh_token'
    })
    assert.equal(await isGoogleCalendarConnected(), true)

    await setAppConfig('email_smtp_config', {
      connected: true,
      host: 'smtp.example.test',
      username: 'hola@example.test',
      inbound: {
        enabled: true,
        host: 'imap.example.test',
        username: 'hola@example.test'
      }
    })
    await setAppConfig('email_smtp_password', 'encrypted_email_password_cron_gate')
    assert.equal(await isEmailInboundConnected(), true)
    await setAppConfig('email_smtp_config', {
      connected: true,
      host: 'smtp.example.test',
      username: 'hola@example.test',
      inbound: {
        enabled: false,
        host: 'imap.example.test',
        username: 'hola@example.test'
      }
    })
    assert.equal(await isEmailInboundConnected(), false)

    await db.run(`
      INSERT INTO highlevel_config (location_id, api_token, location_data)
      VALUES ('loc_cron_gate', 'hl_token_cron_gate', '{}')
    `)
    assert.equal(await isHighLevelConnected(), true)

    await db.run(`
      INSERT INTO meta_config (ad_account_id, access_token)
      VALUES ('act_cron_gate', 'meta_token_cron_gate')
    `)
    await setAppConfig('meta_config_disconnected', '0')
    assert.equal(await isMetaConnected(), true)
    await setAppConfig('meta_config_disconnected', '1')
    assert.equal(await isMetaConnected(), false)

    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('stripe_enabled', '1')
    await setAppConfig('stripe_manual_mode_connections', {
      test: { publishableKey: 'pk_test_cron_gate', secretKey: 'sk_test_cron_gate' },
      live: {}
    })
    assert.equal(await isStripeConnected(), true)
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isStripeConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('stripe_enabled', '0')
    assert.equal(await isStripeConnected(), false)

    await setAppConfig('stripe_enabled', '1')
    await setAppConfig('stripe_manual_mode_connections', { test: {}, live: {} })
    await setAppConfig('stripe_mode', 'test')
    await setAppConfig('stripe_publishable_key', 'pk_test_legacy_cron_gate')
    await setAppConfig('stripe_secret_key_encrypted', 'encrypted_stripe_legacy_secret')
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isStripeConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    assert.equal(await isStripeConnected(), true)

    await setAppConfig('conekta_enabled', '1')
    await setAppConfig('conekta_mode_connections', {
      test: { publicKey: 'key_test_cron_gate', privateKey: 'key_test_private_cron_gate' },
      live: {}
    })
    assert.equal(await isConektaConnected(), true)
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isConektaConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('conekta_enabled', '0')
    assert.equal(await isConektaConnected(), false)

    await setAppConfig('conekta_enabled', '1')
    await setAppConfig('conekta_mode_connections', { test: {}, live: {} })
    await setAppConfig('conekta_mode', 'test')
    await setAppConfig('conekta_public_key', 'key_test_legacy_cron_gate')
    await setAppConfig('conekta_private_key_encrypted', 'encrypted_conekta_legacy_private')
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isConektaConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    assert.equal(await isConektaConnected(), true)

    await setAppConfig('clip_enabled', '1')
    await setAppConfig('clip_mode_connections', {
      test: { apiKey: 'clip_test_cron_gate' },
      live: {}
    })
    assert.equal(await isClipConnected(), true)
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isClipConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('clip_enabled', '0')
    assert.equal(await isClipConnected(), false)

    await setAppConfig('clip_enabled', '1')
    await setAppConfig('clip_mode_connections', { test: {}, live: {} })
    await setAppConfig('clip_mode', 'test')
    await setAppConfig('clip_api_key_encrypted', 'clip_legacy_cron_gate')
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isClipConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    assert.equal(await isClipConnected(), true)

    await setAppConfig('mercadopago_enabled', '1')
    await setAppConfig('mercadopago_mode_connections', {
      test: { userId: 'mp_user_cron_gate', accessToken: 'mp_access_cron_gate' },
      live: {}
    })
    assert.equal(await isMercadoPagoConnected(), true)
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isMercadoPagoConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('mercadopago_enabled', '0')
    assert.equal(await isMercadoPagoConnected(), false)

    await setAppConfig('rebill_enabled', '1')
    await setAppConfig('rebill_mode_connections', {
      test: { publicKey: 'pk_test_rebill_cron_gate_123456', secretKey: 'sk_test_rebill_cron_gate_123456' },
      live: {}
    })
    assert.equal(await isRebillConnected(), true)
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isRebillConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    await setAppConfig('rebill_enabled', '0')
    assert.equal(await isRebillConnected(), false)

    await setAppConfig('rebill_enabled', '1')
    await setAppConfig('rebill_mode_connections', { test: {}, live: {} })
    await setAppConfig('rebill_mode', 'test')
    await setAppConfig('rebill_public_key', 'pk_test_rebill_legacy_cron_gate_123456')
    await setAppConfig('rebill_secret_key_encrypted', 'encrypted_rebill_legacy_secret')
    await setAppConfig('payments_settings', { paymentMode: 'live' })
    assert.equal(await isRebillConnected(), false)
    await setAppConfig('payments_settings', { paymentMode: 'test' })
    assert.equal(await isRebillConnected(), true)

    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', '+525500000001', '+52 55 0000 0001', 'Cron Gate QR', 1, 0, 1, 'connected', 'CONNECTED')
    `, [phoneNumberId])
    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
      ) VALUES (?, ?, '+525500000001', '+525500000001', 'connected', 1, 'Acepto', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [`qr_${phoneNumberId}`, phoneNumberId])
    assert.equal(await isWhatsAppQrConnected(), true)

    await db.run('UPDATE whatsapp_api_phone_numbers SET qr_send_enabled = 0 WHERE id = ?', [phoneNumberId])
    assert.equal(await isWhatsAppQrConnected(), false)
  })
})

test('runtime de crons de integración enciende una vez, apaga y no revienta si un start falla', async () => {
  let enabled = false
  let starts = 0
  let stops = 0
  const name = uniqueId('runtime_cron_gate')

  registerIntegrationCron({
    name,
    label: 'Runtime Cron Gate',
    provider: 'test',
    isEnabled: () => enabled,
    start: () => { starts += 1 },
    stop: () => { stops += 1 }
  })

  assert.deepEqual(await syncIntegrationCron(name, { reason: 'initial-test' }), {
    name,
    label: 'Runtime Cron Gate',
    provider: 'test',
    active: false,
    enabled: false
  })

  enabled = true
  assert.equal((await syncIntegrationCron(name, { reason: 'enable-test' })).active, true)
  assert.equal((await syncIntegrationCron(name, { reason: 'enable-test-again' })).active, true)
  assert.equal(starts, 1)

  enabled = false
  assert.equal((await syncIntegrationCron(name, { reason: 'disable-test' })).active, false)
  assert.equal((await syncIntegrationCron(name, { reason: 'disable-test-again' })).active, false)
  assert.equal(stops, 1)

  const throwingName = uniqueId('runtime_cron_gate_throw')
  registerIntegrationCron({
    name: throwingName,
    label: 'Runtime Cron Gate Throw',
    provider: 'test',
    isEnabled: () => true,
    start: () => {
      throw new Error('boom')
    },
    stop: () => {}
  })

  const throwingResult = await syncIntegrationCron(throwingName, { reason: 'throw-test' })
  assert.equal(throwingResult.active, false)
  assert.equal(throwingResult.enabled, true)
  assert.equal(
    getIntegrationCronState().some((entry) => entry.name === name && entry.active === false),
    true
  )
})
