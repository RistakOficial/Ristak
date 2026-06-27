import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from '../src/config/database.js'
import {
  WHATSAPP_QR_DRIP_CONFIG_KEY,
  getWhatsAppQrDripSettings,
  normalizeWhatsAppQrDripSettings,
  reserveWhatsAppQrDripSlot,
  resetWhatsAppQrDripRuntimeForTest,
  saveWhatsAppQrDripSettings
} from '../src/services/whatsappQrDripService.js'

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

test('normalizes WhatsApp QR drip settings with safe defaults and limits', () => {
  assert.deepEqual(normalizeWhatsAppQrDripSettings({ enabled: 'off', delaySeconds: 4 }), {
    enabled: false,
    delaySeconds: 15,
    delayUnit: 'seconds',
    minDelaySeconds: 15,
    maxDelaySeconds: 600
  })

  assert.deepEqual(normalizeWhatsAppQrDripSettings({ enabled: 'yes', delaySeconds: 9999, delayUnit: 'minutes' }), {
    enabled: true,
    delaySeconds: 600,
    delayUnit: 'minutes',
    minDelaySeconds: 15,
    maxDelaySeconds: 600
  })

  assert.equal(normalizeWhatsAppQrDripSettings({ delayUnit: 'hours' }).delayUnit, 'seconds')
})

test('loads default-on drip settings and persists user updates', async () => {
  await snapshotAppConfig([WHATSAPP_QR_DRIP_CONFIG_KEY], async () => {
    assert.deepEqual(await getWhatsAppQrDripSettings(), {
      enabled: true,
      delaySeconds: 30,
      delayUnit: 'seconds',
      minDelaySeconds: 15,
      maxDelaySeconds: 600
    })

    assert.deepEqual(await saveWhatsAppQrDripSettings({ enabled: false, delaySeconds: 9, delayUnit: 'minutes' }), {
      enabled: false,
      delaySeconds: 15,
      delayUnit: 'minutes',
      minDelaySeconds: 15,
      maxDelaySeconds: 600
    })

    assert.deepEqual(await getWhatsAppQrDripSettings(), {
      enabled: false,
      delaySeconds: 15,
      delayUnit: 'minutes',
      minDelaySeconds: 15,
      maxDelaySeconds: 600
    })
  })
})

test('reserves QR drip send slots without delaying the first message', async () => {
  resetWhatsAppQrDripRuntimeForTest()
  let nowMs = Date.UTC(2026, 5, 20, 18, 0, 0)

  const first = await reserveWhatsAppQrDripSlot({
    phoneNumberId: 'qr-phone-1',
    settings: { enabled: true, delaySeconds: 30 },
    now: () => nowMs
  })
  const second = await reserveWhatsAppQrDripSlot({
    phoneNumberId: 'qr-phone-1',
    settings: { enabled: true, delaySeconds: 30 },
    now: () => nowMs
  })
  const otherPhoneFirst = await reserveWhatsAppQrDripSlot({
    phoneNumberId: 'qr-phone-2',
    settings: { enabled: true, delaySeconds: 30 },
    now: () => nowMs
  })

  nowMs += 10000
  const third = await reserveWhatsAppQrDripSlot({
    phoneNumberId: 'qr-phone-1',
    settings: { enabled: true, delaySeconds: 30 },
    now: () => nowMs
  })

  assert.equal(first.delayMs, 0)
  assert.equal(second.delayMs, 30000)
  assert.equal(otherPhoneFirst.delayMs, 0)
  assert.equal(third.delayMs, 50000)

  resetWhatsAppQrDripRuntimeForTest()
})
