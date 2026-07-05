import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  backfillWhatsAppContactProfilePictures,
  getWhatsAppApiConfigKeys,
  refreshInboundWhatsAppContactProfilePicture
} from '../src/services/whatsappApiService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'

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

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function createFakeBaileysRuntime({ connectedJid, profilePictureUrl, profilePictureError = null, calls }) {
  return {
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: { id: connectedJid },
      registered: true
    }),
    makeCacheableSignalKeyStore: (keys) => keys,
    proto: {
      Message: {
        AppStateSyncKeyData: {
          fromObject: (value) => value
        }
      }
    },
    makeWASocket: () => {
      const listeners = new Map()
      const emit = async (eventName, payload) => {
        for (const handler of listeners.get(eventName) || []) {
          await handler(payload)
        }
      }
      const sock = {
        user: { id: connectedJid },
        ev: {
          on: (eventName, handler) => {
            const eventListeners = listeners.get(eventName) || []
            eventListeners.push(handler)
            listeners.set(eventName, eventListeners)
          },
          removeAllListeners: (eventName) => {
            if (eventName) listeners.delete(eventName)
            else listeners.clear()
          }
        },
        ws: {
          close: () => {}
        },
        onWhatsApp: async (...candidates) => candidates.map(candidate => ({
          exists: true,
          jid: `${normalizeDigits(candidate)}@s.whatsapp.net`
        })),
        profilePictureUrl: async (jid, type) => {
          calls.push({ jid, type })
          if (profilePictureError) throw new Error(profilePictureError)
          return profilePictureUrl
        }
      }

      queueMicrotask(() => {
        emit('connection.update', { connection: 'open' }).catch(() => undefined)
      })

      return sock
    }
  }
}

async function cleanup({ contactId, phone, phoneNumberId }) {
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ? OR phone = ?', [contactId, phone]).catch(() => undefined)
}

async function seedQrAvatarFixture({
  contactId,
  phone,
  phoneNumberId,
  businessPhone,
  profileUpdatedAt,
  profilePictureUrl = 'https://old.example/avatar.jpg',
  source = 'WhatsApp_QR',
  seedApiContact = true
}) {
  await db.run(`
    INSERT INTO contacts (
      id, phone, full_name, first_name, source, created_at, updated_at
    ) VALUES (?, ?, 'Cliente Avatar', 'Cliente', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [contactId, phone, source])

  if (seedApiContact) {
    await db.run(`
      INSERT INTO whatsapp_api_contacts (
        id, contact_id, phone, profile_name, profile_picture_url,
        profile_picture_source, profile_picture_updated_at,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, 'Cliente Avatar', ?,
        'baileys_qr', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [`waapi_profile_${contactId}`, contactId, phone, profilePictureUrl, profileUpdatedAt])
  }

  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, waba_id, phone_number, display_phone_number, verified_name,
      is_default_sender, api_send_enabled, qr_send_enabled, qr_status, qr_connected_phone, status
    ) VALUES (?, 'qr', 'waba_qr_avatar_test', ?, ?, 'QR Avatar Test', 1, 0, 1, 'connected', ?, 'CONNECTED')
  `, [phoneNumberId, businessPhone, businessPhone, businessPhone])

  await db.run(`
    INSERT INTO whatsapp_qr_sessions (
      id, phone_number_id, expected_phone, connected_phone, status,
      consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
    ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [`qr_${phoneNumberId}`, phoneNumberId, businessPhone, businessPhone, QR_CONSENT_TEXT])

  await db.run(`
    INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
    VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
  `, [
    phoneNumberId,
    JSON.stringify({
      me: { id: `${normalizeDigits(businessPhone)}@s.whatsapp.net` },
      registered: true
    })
  ])
}

test('refresh inbound avatar: si la foto QR esta vencida, vuelve a pedirla y la guarda', async () => {
  const id = randomUUID()
  const phone = `+52991${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000020'
  const phoneNumberId = `phone_qr_avatar_${id}`
  const contactId = `rstk_contact_qr_avatar_${id}`
  const calls = []
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await seedQrAvatarFixture({
        contactId,
        phone,
        phoneNumberId,
        businessPhone,
        profileUpdatedAt: '2024-01-01T00:00:00.000Z'
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({
        connectedJid: `${normalizeDigits(businessPhone)}@s.whatsapp.net`,
        profilePictureUrl: 'https://wa.example/avatar-new.jpg',
        calls
      }))

      const result = await refreshInboundWhatsAppContactProfilePicture({
        contactId,
        phone,
        profileName: 'Cliente Avatar',
        direction: 'inbound',
        isNew: true
      })

      assert.equal(result.refreshed, true)
      assert.equal(result.source, 'qr')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].jid, `${normalizeDigits(phone)}@s.whatsapp.net`)
      assert.equal(calls[0].type, 'preview')

      const row = await db.get(`
        SELECT profile_picture_url, profile_picture_source, profile_picture_error
        FROM whatsapp_api_contacts
        WHERE phone = ?
      `, [phone])

      assert.equal(row.profile_picture_url, 'https://wa.example/avatar-new.jpg')
      assert.equal(row.profile_picture_source, 'baileys_qr')
      assert.equal(row.profile_picture_error, null)
    })
  } finally {
    resetWhatsAppQrServiceForTest()
    await cleanup({ contactId, phone, phoneNumberId })
  }
})

test('backfill avatars: refresca contactos WhatsApp existentes sin esperar mensaje inbound', async () => {
  const id = randomUUID()
  const phone = `+52994${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000023'
  const phoneNumberId = `phone_qr_avatar_backfill_${id}`
  const contactId = `rstk_contact_qr_avatar_backfill_${id}`
  const calls = []
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await seedQrAvatarFixture({
        contactId,
        phone,
        phoneNumberId,
        businessPhone,
        profileUpdatedAt: null,
        profilePictureUrl: null
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({
        connectedJid: `${normalizeDigits(businessPhone)}@s.whatsapp.net`,
        profilePictureUrl: 'https://wa.example/avatar-backfill.jpg',
        calls
      }))

      const result = await backfillWhatsAppContactProfilePictures({
        limit: 10,
        onlyMissing: true,
        contactIds: [contactId]
      })

      assert.equal(result.ok, true)
      assert.equal(result.scanned, 1)
      assert.equal(result.updated, 1)
      assert.equal(result.qrUpdated, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].jid, `${normalizeDigits(phone)}@s.whatsapp.net`)

      const row = await db.get(`
        SELECT profile_picture_url, profile_picture_source, profile_picture_error
        FROM whatsapp_api_contacts
        WHERE phone = ?
      `, [phone])

      assert.equal(row.profile_picture_url, 'https://wa.example/avatar-backfill.jpg')
      assert.equal(row.profile_picture_source, 'baileys_qr')
      assert.equal(row.profile_picture_error, null)
    })
  } finally {
    resetWhatsAppQrServiceForTest()
    await cleanup({ contactId, phone, phoneNumberId })
  }
})

test('backfill avatars: incluye contactos normales del CRM con telefono', async () => {
  const id = randomUUID()
  const phone = `+52995${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000024'
  const phoneNumberId = `phone_qr_avatar_all_crm_${id}`
  const contactId = `rstk_contact_qr_avatar_all_crm_${id}`
  const calls = []
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await seedQrAvatarFixture({
        contactId,
        phone,
        phoneNumberId,
        businessPhone,
        profileUpdatedAt: null,
        source: 'Manual',
        seedApiContact: false
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({
        connectedJid: `${normalizeDigits(businessPhone)}@s.whatsapp.net`,
        profilePictureUrl: 'https://wa.example/avatar-all-crm.jpg',
        calls
      }))

      const result = await backfillWhatsAppContactProfilePictures({
        limit: 10,
        onlyMissing: true,
        contactIds: [contactId]
      })

      assert.equal(result.ok, true)
      assert.equal(result.scope, 'all_crm')
      assert.equal(result.scanned, 1)
      assert.equal(result.updated, 1)
      assert.equal(result.qrUpdated, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].jid, `${normalizeDigits(phone)}@s.whatsapp.net`)

      const row = await db.get(`
        SELECT contact_id, profile_picture_url, profile_picture_source
        FROM whatsapp_api_contacts
        WHERE phone = ?
      `, [phone])

      assert.equal(row.contact_id, contactId)
      assert.equal(row.profile_picture_url, 'https://wa.example/avatar-all-crm.jpg')
      assert.equal(row.profile_picture_source, 'baileys_qr')
    })
  } finally {
    resetWhatsAppQrServiceForTest()
    await cleanup({ contactId, phone, phoneNumberId })
  }
})

test('refresh inbound avatar: si la foto tiene menos de 24h, no consulta WhatsApp QR', async () => {
  const id = randomUUID()
  const phone = `+52992${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000021'
  const phoneNumberId = `phone_qr_avatar_fresh_${id}`
  const contactId = `rstk_contact_qr_avatar_fresh_${id}`
  const calls = []
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await seedQrAvatarFixture({
        contactId,
        phone,
        phoneNumberId,
        businessPhone,
        profileUpdatedAt: new Date().toISOString()
      })

      setBaileysRuntimeForTest(createFakeBaileysRuntime({
        connectedJid: `${normalizeDigits(businessPhone)}@s.whatsapp.net`,
        profilePictureUrl: 'https://wa.example/avatar-new.jpg',
        calls
      }))

      const result = await refreshInboundWhatsAppContactProfilePicture({
        contactId,
        phone,
        profileName: 'Cliente Avatar',
        direction: 'inbound',
        isNew: true
      })

      assert.equal(result.refreshed, false)
      assert.equal(result.reason, 'not_available')
      assert.equal(calls.length, 0)

      const row = await db.get(`
        SELECT profile_picture_url
        FROM whatsapp_api_contacts
        WHERE phone = ?
      `, [phone])

      assert.equal(row.profile_picture_url, 'https://old.example/avatar.jpg')
    })
  } finally {
    resetWhatsAppQrServiceForTest()
    await cleanup({ contactId, phone, phoneNumberId })
  }
})

test('refresh inbound avatar: si QR falla, limpia URLs temporales de WhatsApp para no mostrar imagen rota', async () => {
  const id = randomUUID()
  const phone = `+52993${Date.now().toString().slice(-7)}`
  const businessPhone = '+526561000022'
  const phoneNumberId = `phone_qr_avatar_error_${id}`
  const contactId = `rstk_contact_qr_avatar_error_${id}`
  const calls = []
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.senderPhone, keys.phoneNumberId, keys.wabaId, keys.provider]

  await cleanup({ contactId, phone, phoneNumberId })

  try {
    await snapshotAppConfig(configKeys, async () => {
      await initializeMasterKey()
      await setAppConfig(keys.enabled, '0')
      await setAppConfig(keys.provider, 'ycloud')

      await seedQrAvatarFixture({
        contactId,
        phone,
        phoneNumberId,
        businessPhone,
        profileUpdatedAt: '2024-01-01T00:00:00.000Z'
      })

      await db.run(`
        UPDATE whatsapp_api_contacts
        SET profile_picture_url = ?,
            profile_picture_error = NULL
        WHERE phone = ?
      `, [
        'https://pps.whatsapp.net/v/t61.24694-24/avatar.jpg?oe=expired',
        phone
      ])

      setBaileysRuntimeForTest(createFakeBaileysRuntime({
        connectedJid: `${normalizeDigits(businessPhone)}@s.whatsapp.net`,
        profilePictureUrl: '',
        profilePictureError: 'Timed Out',
        calls
      }))

      const result = await refreshInboundWhatsAppContactProfilePicture({
        contactId,
        phone,
        profileName: 'Cliente Avatar',
        direction: 'inbound',
        isNew: true
      })

      assert.equal(result.refreshed, false)
      assert.equal(result.reason, 'not_available')
      assert.equal(calls.length, 1)

      const row = await db.get(`
        SELECT profile_picture_url, profile_picture_source, profile_picture_error
        FROM whatsapp_api_contacts
        WHERE phone = ?
      `, [phone])

      assert.equal(row.profile_picture_url, null)
      assert.equal(row.profile_picture_source, 'baileys_qr')
      assert.equal(row.profile_picture_error, 'Timed Out')
    })
  } finally {
    resetWhatsAppQrServiceForTest()
    await cleanup({ contactId, phone, phoneNumberId })
  }
})
