import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  sendWhatsAppQrAudioMessage,
  sendWhatsAppQrDocumentMessage,
  sendWhatsAppQrImageMessage,
  sendWhatsAppQrVideoMessage,
  sendWhatsAppQrTextMessage,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'
import {
  WHATSAPP_QR_DRIP_CONFIG_KEY,
  resetWhatsAppQrDripRuntimeForTest,
  saveWhatsAppQrDripSettings,
  setWhatsAppQrDripSleepForTest
} from '../src/services/whatsappQrDripService.js'

const BUSINESS_PHONE = '+526561234567'
const CONNECTED_JID = '526561234567@s.whatsapp.net'
const CONTACT_PHONE = '+526569998888'
const VALID_OGG_OPUS_DATA_URL = 'data:audio/ogg;codecs=opus;base64,T2dnUwACAAAAAAAAAAC3bz5UAAAAAF9EXgkBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAALdvPlQBAAAAGaef4gE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMgEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAyIGxpYm9wdXNPZ2dTAAS4JgAAAAAAALdvPlQCAAAAC0SjeAtFNjQxMjcwMzUqF3iCAbdsfkDmAAAGS7TjumYR3p00RmwBHPB+I1m2zIXrmd7aBIGjduC2A1wWfuKopx7fzlrQS4bGLc+BnYqkIkXcxwldWXijP/esmIUDXCYJlv9nCL7fgGPAvjeM8OkgudL/caOCG6HJnKqN6vBOROgBGTLI+axxcdqjR3iboxJRRQCs0ky14jfRZlm92WkiUNr3DzWw4+Wx98jdsGxYSXK89+hYLRz8wpvjzDHFfgN4m6MSVs4iKkTY4B+i5MZKX7oD0oqS8sDjgb3P1kzpjChOdn4p8hKrIOo5iNWlBQ2HeJujX3Wc/EkNeFc8EJ8EQgTM6vBjyEl0VL8/GXoXtJgxBWlaTy5ZsndLX2+12lIG4vp4m6MXUV8mKyhiES+Om70HKUgcHjLILmQd5M+0sQ+XSDU8UWqsEkjj64ueAeySOq+RhfBzeZureJujX3Wc/EXtr4kI5+fJxq6G+cwFCZR6q7Kutp0WvvmBv231nX0Hb9Se/0S+7VGjeJujElFFANDLwZ1z7toAlP1FFw5GylCcHpCS4YWDdWoTkDdThgxrmgWllJqky5ujivwGeJujElbOIipFGIWoi9E7IdHXTfF6kHlqfNIV5rk86Mc/0dbzcR6fM4Wq/NQLtMYQ/eGxFdZImysfdZz8STOyk08i9Ec9uRIoArhlUWBwvWCPq76xEWvHCYXWbyTIJ0BIBbul8BHm3h2TRdVKljNtaNImd5UVgA=='

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function createPcmWavBuffer() {
  const sampleRate = 8_000
  const samples = 2_000
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function sqlFuture(offsetMs = 1500) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

function createFakeBaileysRuntime(sentMessages = [], { emitAck = true } = {}) {
  let messageIndex = 0

  return {
    DisconnectReason: {
      loggedOut: 401,
      badSession: 500,
      connectionReplaced: 440,
      restartRequired: 515
    },
    BufferJSON: {
      replacer: (_key, value) => value,
      reviver: (_key, value) => value
    },
    Browsers: {
      macOS: (name) => ['macOS', name, 'Ristak']
    },
    initAuthCreds: () => ({
      me: { id: CONNECTED_JID },
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
        user: { id: CONNECTED_JID },
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
        sendMessage: async (jid, payload) => {
          messageIndex += 1
          const id = `qr_protected_msg_${messageIndex}`
          sentMessages.push({ id, jid, payload })
          if (emitAck) {
            await emit('messages.update', [{
              key: { id, remoteJid: jid, fromMe: true },
              update: { status: 3 }
            }])
          }
          return {
            key: { id, remoteJid: jid, fromMe: true },
            message: payload
          }
        },
        emit
      }

      queueMicrotask(() => {
        emit('connection.update', { connection: 'open' }).catch(() => undefined)
      })

      return sock
    }
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
    resetWhatsAppQrDripRuntimeForTest()
  }
}

async function cleanupQrFixture(phoneNumberId) {
  resetWhatsAppQrServiceForTest()
  resetWhatsAppQrDripRuntimeForTest()
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`])
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId])
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId])
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
}

async function withQrFixture(callback) {
  const phoneNumberId = `phone_qr_protection_${randomUUID()}`
  await cleanupQrFixture(phoneNumberId)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', 'waba_qr_protection_test', ?, ?, 'QR Protection Test', 1, 0, 1, 'connected', 'CONNECTED')
    `, [phoneNumberId, BUSINESS_PHONE, BUSINESS_PHONE])

    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
      ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      `qr_${phoneNumberId}`,
      phoneNumberId,
      BUSINESS_PHONE,
      BUSINESS_PHONE,
      QR_CONSENT_TEXT
    ])

    await db.run(`
      INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
      VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
    `, [
      phoneNumberId,
      JSON.stringify({
        me: { id: CONNECTED_JID },
        registered: true
      })
    ])

    return await callback({ phoneNumberId })
  } finally {
    await cleanupQrFixture(phoneNumberId)
  }
}

test('WhatsApp QR responde al aceptar el mensaje sin esperar el ACK de entrega', async () => {
  const sentMessages = []

  await withQrFixture(async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sentMessages, { emitAck: false }))
    const startedAt = Date.now()

    const result = await sendWhatsAppQrImageMessage({
      phoneNumberId,
      to: CONTACT_PHONE,
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      caption: ''
    })

    assert.equal(result.status, 'sent')
    assert.equal(JSON.parse(result.raw).ackPending, true)
    assert.equal(sentMessages.length, 1)
    assert.ok(Date.now() - startedAt < 1_000, 'el request no debe quedarse esperando hasta 20 s por delivered/read')
  })
})

test('WhatsApp QR aplica pausas automáticas a todos los tipos de mensaje QR', async () => {
  await snapshotAppConfig([WHATSAPP_QR_DRIP_CONFIG_KEY], async () => {
    const sentMessages = []
    const sleeps = []

    await withQrFixture(async ({ phoneNumberId }) => {
      setBaileysRuntimeForTest(createFakeBaileysRuntime(sentMessages))
      setWhatsAppQrDripSleepForTest(async (delayMs) => {
        sleeps.push(delayMs)
      })
      await saveWhatsAppQrDripSettings({ enabled: true, delaySeconds: 15, delayUnit: 'seconds' })

      await sendWhatsAppQrTextMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        text: 'Mensaje de texto'
      })
      await sendWhatsAppQrImageMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        caption: 'Imagen'
      })
      await sendWhatsAppQrAudioMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        audioDataUrl: VALID_OGG_OPUS_DATA_URL,
        durationMs: 1000
      })
      await sendWhatsAppQrDocumentMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        documentDataUrl: 'data:application/pdf;base64,JVBERi0x',
        filename: 'contrato.pdf'
      })
      await sendWhatsAppQrVideoMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        videoDataUrl: 'data:video/mp4;base64,AAAAIGZ0eXBpc29t',
        caption: 'Video'
      })
    })

    assert.equal(sentMessages.length, 5)
    assert.equal(sentMessages[2].payload.audio instanceof Buffer, true)
    assert.equal(sentMessages[2].payload.mimetype, 'audio/ogg; codecs=opus')
    assert.equal(sentMessages[2].payload.ptt, true)
    assert.equal(sentMessages[4].payload.video instanceof Buffer, true)
    assert.equal(sentMessages[4].payload.mimetype, 'video/mp4')
    assert.equal(sentMessages[4].payload.caption, 'Video')
    assert.equal(sleeps.length, 4)
    assert.ok(sleeps[0] >= 14_000 && sleeps[0] <= 16_000)
    assert.ok(sleeps[1] >= 28_000 && sleeps[1] <= 31_000)
    assert.ok(sleeps[2] >= 42_000 && sleeps[2] <= 46_000)
    assert.ok(sleeps[3] >= 56_000 && sleeps[3] <= 61_000)
  })
})

test('WhatsApp QR distingue archivo de audio de nota de voz PTT', async () => {
  const sentMessages = []
  const mp3Bytes = Buffer.from('ID3-audio-normal-sin-transcodificar')
  const wavBytes = createPcmWavBuffer()

  await withQrFixture(async ({ phoneNumberId }) => {
    setBaileysRuntimeForTest(createFakeBaileysRuntime(sentMessages))

    const regularAudio = await sendWhatsAppQrAudioMessage({
      phoneNumberId,
      to: CONTACT_PHONE,
      audioDataUrl: `data:audio/mpeg;base64,${mp3Bytes.toString('base64')}`,
      voice: false,
      skipQrSendProtection: true
    })
    const voiceNote = await sendWhatsAppQrAudioMessage({
      phoneNumberId,
      to: CONTACT_PHONE,
      audioDataUrl: VALID_OGG_OPUS_DATA_URL,
      voice: true,
      skipQrSendProtection: true
    })
    const convertedRegularAudio = await sendWhatsAppQrAudioMessage({
      phoneNumberId,
      to: CONTACT_PHONE,
      audioDataUrl: `data:audio/wav;base64,${wavBytes.toString('base64')}`,
      voice: false,
      skipQrSendProtection: true
    })

    assert.equal(sentMessages.length, 3)
    assert.deepEqual(sentMessages[0].payload.audio, mp3Bytes)
    assert.equal(sentMessages[0].payload.mimetype, 'audio/mpeg')
    assert.equal(sentMessages[0].payload.ptt, false)
    assert.equal(regularAudio.audio.ptt, false)

    assert.equal(sentMessages[1].payload.mimetype, 'audio/ogg; codecs=opus')
    assert.equal(sentMessages[1].payload.ptt, true)
    assert.equal(voiceNote.audio.ptt, true)

    assert.equal(sentMessages[2].payload.mimetype, 'audio/mp4')
    assert.equal(sentMessages[2].payload.ptt, false)
    assert.equal(sentMessages[2].payload.audio.subarray(4, 8).toString('ascii'), 'ftyp')
    assert.equal(convertedRegularAudio.audio.mimeType, 'audio/mp4')
    assert.equal(convertedRegularAudio.audio.ptt, false)
  })
})

test('WhatsApp QR omite pausas automáticas para mensajes de chat manual', async () => {
  await snapshotAppConfig([WHATSAPP_QR_DRIP_CONFIG_KEY], async () => {
    const sentMessages = []
    const sleeps = []

    await withQrFixture(async ({ phoneNumberId }) => {
      setBaileysRuntimeForTest(createFakeBaileysRuntime(sentMessages))
      setWhatsAppQrDripSleepForTest(async (delayMs) => {
        sleeps.push(delayMs)
      })
      await saveWhatsAppQrDripSettings({ enabled: true, delaySeconds: 15, delayUnit: 'seconds' })

      await sendWhatsAppQrTextMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        text: 'Mensaje con pausa normal'
      })
      await sendWhatsAppQrTextMessage({
        phoneNumberId,
        to: CONTACT_PHONE,
        text: 'Mensaje manual inmediato',
        skipQrSendProtection: true
      })
    })

    assert.equal(sentMessages.length, 2)
    assert.deepEqual(sleeps, [])
  })
})

test('WhatsApp QR espera un lease temporal de otra instancia antes de enviar', async () => {
  const sentMessages = []

  await withQrFixture(async ({ phoneNumberId }) => {
    await db.run(`
      INSERT INTO distributed_locks (name, owner_id, locked_until, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `, [`whatsapp-qr-session:${phoneNumberId}`, 'other-render-instance', sqlFuture()])

    setBaileysRuntimeForTest(createFakeBaileysRuntime(sentMessages))

    await sendWhatsAppQrTextMessage({
      phoneNumberId,
      to: CONTACT_PHONE,
      text: 'Mensaje despues de esperar lease',
      skipQrSendProtection: true
    })

    const lock = await db.get(
      'SELECT owner_id FROM distributed_locks WHERE name = ?',
      [`whatsapp-qr-session:${phoneNumberId}`]
    )

    assert.equal(sentMessages.length, 1)
    assert.notEqual(lock.owner_id, 'other-render-instance')
  })
})
