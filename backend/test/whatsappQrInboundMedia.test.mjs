import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  captureQrChatMessage,
  getWhatsAppApiConfigKeys
} from '../src/services/whatsappApiService.js'

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

async function cleanup({ contactId, phone, phoneNumberId }) {
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
}

test('QR sin WhatsApp API: rehospeda la media entrante y la persiste en el mensaje', async () => {
  const id = randomUUID()
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000010'
  const phoneNumberId = `phone_qr_media_${id}`
  const contactId = `rstk_contact_qr_media_${id}`
  const messageAt = new Date().toISOString()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  let resolveCalls = 0

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      // Número SOLO por QR: la API oficial está deshabilitada, así que el guard de
      // captureQrChatMessage no la considera operativa y sí resolvemos la media.
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_qr_media_test', ?, ?, 'QR Media Test', 1, 0, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      const result = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'inbound',
        wamid: `qr_media_${id}`,
        messageType: 'image',
        text: 'Mira mi comprobante',
        profileName: 'Cliente Media QR',
        contactPhone: phone,
        timestamp: messageAt,
        resolveInboundMedia: async () => {
          resolveCalls += 1
          return {
            mediaUrl: 'https://cdn.example.com/accounts/acme/chat/qr-image-abc123.jpg',
            mediaMimeType: 'image/jpeg',
            mediaFilename: 'qr-image-abc123.jpg',
            mediaDurationMs: null,
            mediaAssetId: 'media_qr_test_asset'
          }
        }
      })

      assert.equal(result.skipped, false, 'el mensaje QR debe capturarse')
      assert.equal(resolveCalls, 1, 'la media debe resolverse exactamente una vez')

      const message = await db.get(`
        SELECT message_type, media_url, media_mime_type, media_filename, transport, direction
        FROM whatsapp_api_messages
        WHERE wamid = ?
      `, [`qr_media_${id}`])

      assert.ok(message, 'el mensaje debe existir')
      assert.equal(message.transport, 'qr')
      assert.equal(message.direction, 'inbound')
      assert.equal(message.message_type, 'image')
      assert.equal(message.media_url, 'https://cdn.example.com/accounts/acme/chat/qr-image-abc123.jpg')
      assert.equal(message.media_mime_type, 'image/jpeg')
      assert.equal(message.media_filename, 'qr-image-abc123.jpg')
    })
  } finally {
    await cleanup({ contactId, phone, phoneNumberId })
  }
})

test('QR con WhatsApp API operativa: NO descarga media (no gasta storage propio)', async () => {
  const id = randomUUID()
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000011'
  const phoneNumberId = `phone_qr_media_api_${id}`
  const contactId = `rstk_contact_qr_media_api_${id}`
  const messageAt = new Date().toISOString()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  let resolveCalls = 0

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      // Número CON WhatsApp API operativa: el proveedor hospeda la media, así que el
      // guard debe cortar antes de resolver/descargar cualquier archivo.
      await setAppConfig(keys.enabled, '1')
      await setAppConfig(keys.apiKey, encrypt('ycloud_qr_media_api_secret'))
      await setAppConfig(keys.senderPhone, businessPhone)
      await setAppConfig(keys.phoneNumberId, phoneNumberId)
      await setAppConfig(keys.wabaId, 'waba_qr_media_api_test')
      await setAppConfig(keys.provider, 'ycloud')

      await db.run(`
        INSERT INTO whatsapp_api_phone_numbers (
          id, provider, waba_id, phone_number, display_phone_number, verified_name,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
        ) VALUES (?, 'ycloud', 'waba_qr_media_api_test', ?, ?, 'QR Media API Test', 1, 1, 1, 'connected', ?, 'CONNECTED')
      `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

      const result = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'inbound',
        wamid: `qr_media_api_${id}`,
        messageType: 'image',
        text: 'Comprobante por API',
        contactPhone: phone,
        timestamp: messageAt,
        resolveInboundMedia: async () => {
          resolveCalls += 1
          return { mediaUrl: 'https://cdn.example.com/should-not-happen.jpg', mediaMimeType: 'image/jpeg' }
        }
      })

      assert.equal(result.skipped, true, 'con API operativa el QR debe descartarse')
      assert.equal(result.reason, 'official_api_active')
      assert.equal(resolveCalls, 0, 'NO debe descargarse ni rehospedarse media')
    })
  } finally {
    await cleanup({ contactId, phone, phoneNumberId })
  }
})
