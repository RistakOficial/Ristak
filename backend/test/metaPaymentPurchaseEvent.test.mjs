import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { handleInvoiceWebhook, handlePaymentWebhook } from '../src/controllers/webhooksController.js'
import {
  buildMetaPublicPurchasePixelEvent,
  triggerWhatsappAppointmentBookedEvent,
  triggerMetaPaymentPurchaseEvent,
  triggerMetaPurchaseEventForPaymentRow
} from '../src/services/metaConversionEventsService.js'
import {
  QR_CONSENT_TEXT,
  resetWhatsAppQrServiceForTest,
  setBaileysRuntimeForTest
} from '../src/services/whatsappQrService.js'
import { createOfflinePaymentPlan } from '../src/services/offlinePaymentPlanService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

const APP_CONFIG_KEYS = [
  'account_country',
  'account_currency',
  'account_default_dial_code',
  'meta_payment_purchase_event_config',
  'meta_test_event_code',
  'meta_test_event_code_set_at',
  'meta_whatsapp_business_account_id',
  'whatsapp_meta_direct_waba_id',
  'whatsapp_api_provider'
]

const QR_LABEL_BUSINESS_PHONE = '+526561234567'
const QR_LABEL_CONNECTED_JID = '526561234567@s.whatsapp.net'
const QR_LABEL_PAID_ID = 'paid-label-real'

function normalizeDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function createFakeQrLabelRuntime(appliedLabels = [], {
  labels = [{ id: QR_LABEL_PAID_ID, name: 'Paid', color: 3, predefinedId: '3', deleted: false }]
} = {}) {
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
      me: { id: QR_LABEL_CONNECTED_JID },
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
        user: { id: QR_LABEL_CONNECTED_JID },
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
        addChatLabel: async (jid, labelId) => {
          appliedLabels.push({ jid, labelId })
          return { ok: true }
        },
        emit
      }

      queueMicrotask(async () => {
        for (const label of labels) {
          await emit('labels.edit', label)
        }
        await emit('connection.update', { connection: 'open' })
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
      await setAppConfig(row.config_key, row.config_value)
    }
  }
}

async function withNoMetaDatasetEnv(callback) {
  const keys = ['META_PIXEL_ID', 'META_DATASET_ID', 'DATASET_ID']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))

  try {
    for (const key of keys) {
      delete process.env[key]
    }
    return await callback()
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

async function snapshotMetaConfig(callback) {
  const previousRows = await db.all('SELECT * FROM meta_config')

  try {
    await db.run('DELETE FROM meta_config')
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_config')
    for (const row of previousRows) {
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${placeholders})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function startMetaCaptureServer(metaCalls) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      metaCalls.push({ url: req.url, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ events_received: 1 }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  Object.defineProperty(API_URLS, 'META_GRAPH', {
    value: `http://127.0.0.1:${server.address().port}`,
    configurable: true
  })
  return server
}

async function insertMetaPixelConfig({
  pixelId = 'pixel-payment-123',
  pageId = null
} = {}) {
  await db.run(`
    INSERT INTO meta_config (
      ad_account_id, access_token, pixel_id,
      page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    '123456',
    encrypt('meta-access-token'),
    pixelId,
    pageId,
    null,
    null,
    null,
    null
  ])
}

async function deletePaymentMetaTestContact(contactId) {
  await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_attribution WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM meta_social_contacts WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

async function insertMetaSocialDmMessage({
  contactId,
  platform = 'messenger',
  senderId = `sender_${contactId}`,
  pageId = `page_${contactId}`,
  instagramAccountId = '',
  referral = null,
  messageTimestamp = new Date().toISOString()
}) {
  await db.run(
    `INSERT INTO meta_social_messages (
       id, platform, contact_id, sender_id, recipient_id, page_id, instagram_account_id,
       direction, status, message_type, message_text, message_timestamp, referral_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', 'text', 'hola', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `meta_social_msg_${contactId}_${platform}_${Math.random().toString(16).slice(2)}`,
      platform,
      contactId,
      senderId,
      platform === 'instagram' ? instagramAccountId : pageId,
      pageId || null,
      instagramAccountId || null,
      messageTimestamp,
      referral ? JSON.stringify(referral) : null
    ]
  )
}

async function insertWhatsappInboundMessage({
  contactId,
  phone,
  ctwaClid = '',
  sourceId = '',
  headline = '',
  messageTimestamp = new Date().toISOString()
}) {
  await db.run(
    `INSERT INTO whatsapp_api_messages (
       id, provider, contact_id, phone, from_phone, direction, message_type, message_text,
       message_timestamp, detected_ctwa_clid, detected_source_id, detected_headline, created_at, updated_at
     ) VALUES (?, 'ycloud', ?, ?, ?, 'inbound', 'text', 'hola', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `wa_msg_${contactId}_${Math.random().toString(16).slice(2)}`,
      contactId,
      phone,
      phone,
      messageTimestamp,
      ctwaClid || null,
      sourceId || null,
      headline || null
    ]
  )
}

async function insertWebSession({
  contactId,
  email = '',
  fbclid = '',
  fbc = '',
  fbp = '',
  adId = '',
  campaignId = '',
  adsetId = '',
  adName = '',
  utmMedium = '',
  pageUrl = 'https://site.example.test/landing',
  startedAt = new Date().toISOString()
}) {
  await db.run(
    `INSERT INTO sessions (
       session_id, visitor_id, contact_id, email, event_name, started_at, created_at,
       page_url, utm_medium, fbclid, fbc, fbp, campaign_id, adset_id, ad_id, ad_name
     ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `session_${contactId}_${Math.random().toString(16).slice(2)}`,
      `visitor_${contactId}`,
      contactId,
      email || null,
      startedAt,
      startedAt,
      pageUrl,
      utmMedium || null,
      fbclid || null,
      fbc || null,
      fbp || null,
      campaignId || null,
      adsetId || null,
      adId || null,
      adName || null
    ]
  )
}

async function insertMetaSocialContact({
  contactId,
  platform = 'messenger',
  senderId = `sender_${contactId}`,
  pageId = `page_${contactId}`,
  instagramAccountId = ''
}) {
  await db.run(
    `INSERT INTO meta_social_contacts (
       id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id,
       first_seen_at, last_seen_at, message_count, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [
      `meta_social_${contactId}_${platform}`,
      contactId,
      platform,
      senderId,
      platform === 'instagram' ? instagramAccountId : pageId,
      pageId || null,
      instagramAccountId || null
    ]
  )
}

async function cleanupQrPaymentLabelFixture(phoneNumberId) {
  resetWhatsAppQrServiceForTest()
  await db.run('DELETE FROM distributed_locks WHERE name = ?', [`whatsapp-qr-session:${phoneNumberId}`]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_labels WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_auth_state WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_qr_sessions WHERE phone_number_id = ?', [phoneNumberId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
}

async function withQrPaymentLabelFixture(contactId, callback) {
  const phoneNumberId = `phone_qr_meta_purchase_label_${contactId}`
  await cleanupQrPaymentLabelFixture(phoneNumberId)

  try {
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'qr', 'waba_qr_meta_purchase_label_test', ?, ?, 'QR Purchase Label Test', 1, 0, 1, 'connected', 'CONNECTED')
    `, [phoneNumberId, QR_LABEL_BUSINESS_PHONE, QR_LABEL_BUSINESS_PHONE])

    await db.run(`
      INSERT INTO whatsapp_qr_sessions (
        id, phone_number_id, expected_phone, connected_phone, status,
        consent_accepted, consent_text, consent_accepted_at, last_connected_at, updated_at
      ) VALUES (?, ?, ?, ?, 'connected', 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      `qr_${phoneNumberId}`,
      phoneNumberId,
      QR_LABEL_BUSINESS_PHONE,
      QR_LABEL_BUSINESS_PHONE,
      QR_CONSENT_TEXT
    ])

    await db.run(`
      INSERT INTO whatsapp_qr_auth_state (phone_number_id, auth_key, value_json, updated_at)
      VALUES (?, 'creds', ?, CURRENT_TIMESTAMP)
    `, [
      phoneNumberId,
      JSON.stringify({
        me: { id: QR_LABEL_CONNECTED_JID },
        registered: true
      })
    ])

    return await callback({ phoneNumberId })
  } finally {
    await cleanupQrPaymentLabelFixture(phoneNumberId)
  }
}

test('payment Purchase CAPI event uses real payment amount and account currency', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const contactId = `contact_meta_purchase_currency_${suffix}`
  const contactEmail = `buyer-${suffix}@example.test`
  const contactPhone = `+525512${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`
  const contactPhoneQuery = contactPhone.replace(/^\+/, '')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId])
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, custom_fields, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            contactId,
            contactEmail,
            'Buyer Demo',
            contactPhone,
            'test',
            JSON.stringify({
              city: 'Ciudad Juarez',
              state: 'Chihuahua',
              postal_code: '32000',
              country: 'MX',
              date_of_birth: '1990-01-31',
              gender: 'f'
            })
          ]
        )

        await db.run(`
          INSERT INTO meta_config (
            ad_account_id, access_token, pixel_id,
            page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          '123456',
          encrypt('meta-access-token'),
          'pixel-payment-123',
          null,
          null,
          null,
          null,
          null
        ])
        await saveAccountLocaleSettings({ countryCode: 'US', currency: 'USD', dialCode: '1' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'site',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '9999',
            predictedLtv: '',
            custom: [{ key: 'checkout_source', value: 'public_payment' }]
          }
        }))

        metaServer = http.createServer((req, res) => {
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            metaCalls.push({ url: req.url, body })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ events_received: metaCalls.length === 1 ? 0 : 1 }))
          })
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        const paidAt = new Date(Date.now() - 86400000).toISOString()
        const payment = {
          paid_at: paidAt,
          id: 'payment_meta_purchase_1',
          amount: 123.45,
          currency: 'MXN',
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          public_payment_id: 'public_payment_1',
          reference: 'order-123',
          title: 'Consultoria Premium',
          metadata_json: JSON.stringify({
            lineItems: [
              {
                id: 'svc-001',
                name: 'Consultoria Premium',
                quantity: 2,
                unitPrice: 61.725
              }
            ],
            paymentPlan: {
              flowId: 'flow_123',
              installmentId: 'installment_1'
            }
          }),
          eventSourceUrl: `https://checkout.example.test/pay/payment_meta_purchase_1?email=${contactEmail}&phone=${contactPhoneQuery}&fbclid=fb.123`
        }
        const expired = { ...payment, paid_at: new Date(Date.now() - 8 * 86400000).toISOString() }
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, expired)).reason, 'payment_outside_meta_window')
        assert.equal(metaCalls.length, 0)
        const rejected = await triggerMetaPaymentPurchaseEvent(contactId, payment)
        assert.equal(rejected.reason, 'meta_error')
        const result = await triggerMetaPaymentPurchaseEvent(contactId, payment)
        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 2)
        assert.equal(JSON.parse(metaCalls[1].body).data[0].event_id, JSON.parse(metaCalls[0].body).data[0].event_id)
        assert.match(decodeURIComponent(metaCalls[0].url), /access_token=meta-access-token/)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].event_time, Math.floor(Date.parse(paidAt) / 1000))
        assert.equal(payload.data[0].action_source, 'website')
        assert.equal(payload.data[0].event_source_url, 'https://checkout.example.test/pay/payment_meta_purchase_1?fbclid=fb.123')
        assert.equal(payload.data[0].event_id, 'purchase_payment_payment_meta_purchase_1')
        assert.equal(payload.data[0].custom_data.value, 123.45)
        assert.equal(payload.data[0].custom_data.currency, 'USD')
        assert.equal(payload.data[0].custom_data.checkout_source, 'public_payment')
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_1')
        assert.equal(payload.data[0].custom_data.order_id, 'order-123')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.equal(payload.data[0].custom_data.payment_provider, 'stripe')
        assert.equal(payload.data[0].custom_data.payment_method, 'stripe')
        assert.equal(payload.data[0].custom_data.public_payment_id, 'public_payment_1')
        assert.equal(payload.data[0].custom_data.payment_plan_id, 'flow_123')
        assert.equal(payload.data[0].custom_data.installment_id, 'installment_1')
        assert.deepEqual(payload.data[0].custom_data.content_ids, ['svc-001'])
        assert.deepEqual(payload.data[0].custom_data.contents, [{ id: 'svc-001', quantity: 2, item_price: 61.73 }])
        assert.equal(payload.data[0].custom_data.content_type, 'product')
        assert.equal(payload.data[0].custom_data.content_name, 'Consultoria Premium')
        assert.equal(payload.data[0].custom_data.num_items, 2)
        assert.match(payload.data[0].user_data.em, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.ct, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.st, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.zp, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.country, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.db, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.match(payload.data[0].user_data.ge, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('payment Purchase CAPI skips test payments when Meta Test Events is not active', async () => {
  const contactId = 'contact_meta_purchase_test_blocked'

  await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
    await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
      enabled: true,
      channel: 'site',
      eventName: 'Purchase',
      parameters: {
        sendValue: true,
        usePaymentPlanTotalValue: false,
        value: '',
        predictedLtv: '',
        custom: []
      }
    }))

    const result = await triggerMetaPaymentPurchaseEvent(contactId, {
      id: 'payment_meta_test_blocked',
      amount: 111,
      status: 'paid',
      payment_provider: 'stripe',
      payment_mode: 'test'
    })

    assert.equal(result.sent, false)
    assert.equal(result.reason, 'test_payment')
  })
})

test('payment Purchase uses WhatsApp QR Paid label fallback when Meta dataset is not connected', async () => {
  const contactId = 'contact_meta_purchase_qr_label_fallback'
  const contactPhone = '+525512345690'
  const appliedLabels = []

  try {
    await withNoMetaDatasetEnv(async () => {
      await snapshotMetaConfig(async () => {
        await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
          await deletePaymentMetaTestContact(contactId)
          await withQrPaymentLabelFixture(contactId, async ({ phoneNumberId }) => {
            setBaileysRuntimeForTest(createFakeQrLabelRuntime(appliedLabels))

            await db.run(
              `INSERT INTO contacts (
                 id, email, full_name, phone, source, preferred_whatsapp_phone_number_id,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [
                contactId,
                'qr-label-buyer@example.test',
                'QR Label Buyer',
                contactPhone,
                'whatsapp',
                phoneNumberId
              ]
            )

            const result = await triggerMetaPaymentPurchaseEvent(contactId, {
              id: 'payment_meta_qr_label_fallback',
              amount: 120,
              currency: 'MXN',
              status: 'paid',
              payment_provider: 'stripe',
              payment_method: 'stripe',
              payment_mode: 'live',
              reference: 'qr-label-order-1'
            })

            assert.equal(result.sent, true)
            assert.equal(result.transport, 'whatsapp_qr_label')
            assert.equal(result.eventId, `purchase_contact_${contactId}`)
            assert.equal(result.labelResult.applied, true)
            assert.equal(result.labelResult.labelId, QR_LABEL_PAID_ID)
            assert.equal(result.labelResult.predefinedId, '3')
            assert.equal(result.labelResult.phoneNumberId, phoneNumberId)

            assert.equal(appliedLabels.length, 1)
            assert.deepEqual(appliedLabels[0], {
              jid: `${normalizeDigits(contactPhone)}@s.whatsapp.net`,
              labelId: QR_LABEL_PAID_ID
            })

            const contact = await db.get(
              `SELECT meta_purchase_event_sent, meta_purchase_event_id
               FROM contacts
               WHERE id = ?`,
              [contactId]
            )
            assert.equal(Number(contact.meta_purchase_event_sent), 1)
            assert.equal(contact.meta_purchase_event_id, `purchase_contact_${contactId}`)

            const storedLabel = await db.get(
              `SELECT label_id, name, predefined_id, deleted
               FROM whatsapp_qr_labels
               WHERE phone_number_id = ? AND label_id = ?`,
              [phoneNumberId, QR_LABEL_PAID_ID]
            )
            assert.equal(storedLabel.label_id, QR_LABEL_PAID_ID)
            assert.equal(storedLabel.name, 'Paid')
            assert.equal(storedLabel.predefined_id, '3')
            assert.equal(Number(storedLabel.deleted), 0)

            const logRow = await db.get(
              `SELECT status, request_payload, response_payload
               FROM meta_conversion_event_logs
               WHERE contact_id = ? AND event_id = ?
               ORDER BY created_at DESC
               LIMIT 1`,
              [contactId, `purchase_contact_${contactId}`]
            )
            assert.equal(logRow.status, 'success')
            const requestPayload = JSON.parse(logRow.request_payload)
            assert.equal(requestPayload.source, 'whatsapp_qr_label_fallback')
            assert.equal(requestPayload.label, 'Paid')
            assert.equal(requestPayload.custom_data.value, 120)
            assert.equal(requestPayload.custom_data.currency, 'MXN')
            const responsePayload = JSON.parse(logRow.response_payload)
            assert.equal(responsePayload.labelId, QR_LABEL_PAID_ID)
          })
        })
      })
    })
  } finally {
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment Purchase QR label fallback skips test payments without Meta dataset', async () => {
  const contactId = 'contact_meta_purchase_qr_label_test_blocked'

  await withNoMetaDatasetEnv(async () => {
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_qr_label_test_blocked',
          amount: 120,
          status: 'paid',
          payment_provider: 'stripe',
          payment_mode: 'test'
        })

        assert.equal(result.sent, false)
        assert.equal(result.reason, 'test_payment')
      })
    })
  })
})

test('payment Purchase does not apply WhatsApp QR label when Meta dataset is connected', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_dataset_no_qr_label'
  const contactPhone = '+525512345691'
  const appliedLabels = []
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await withQrPaymentLabelFixture(contactId, async ({ phoneNumberId }) => {
          setBaileysRuntimeForTest(createFakeQrLabelRuntime(appliedLabels))

          await db.run(
            `INSERT INTO contacts (
               id, email, full_name, phone, source, preferred_whatsapp_phone_number_id,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
              contactId,
              'dataset-buyer@example.test',
              'Dataset Buyer',
              contactPhone,
              'whatsapp',
              phoneNumberId
            ]
          )

          await insertMetaPixelConfig({ pixelId: 'pixel-dataset-no-qr-label' })
          await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
          await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
            enabled: true,
            channel: 'site',
            eventName: 'Purchase',
            parameters: {
              sendValue: true,
              usePaymentPlanTotalValue: false,
              value: '',
              predictedLtv: '',
              custom: []
            }
          }))

          metaServer = await startMetaCaptureServer(metaCalls)

          const result = await triggerMetaPaymentPurchaseEvent(contactId, {
            id: 'payment_meta_dataset_no_qr_label',
            amount: 150,
            currency: 'MXN',
            status: 'paid',
            payment_provider: 'stripe',
            payment_method: 'stripe',
            payment_mode: 'live',
            eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_dataset_no_qr_label'
          })

          assert.equal(result.sent, true)
          assert.notEqual(result.transport, 'whatsapp_qr_label')
          assert.equal(appliedLabels.length, 0)
          assert.equal(metaCalls.length, 1)

          const payload = JSON.parse(metaCalls[0].body)
          assert.equal(payload.data[0].event_name, 'Purchase')
          assert.equal(payload.data[0].event_id, 'purchase_payment_payment_meta_dataset_no_qr_label')
          assert.equal(payload.data[0].custom_data.value, 150)
        })
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment Purchase CAPI sends test payments only to Meta Test Events when active', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_test_allowed'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'test-buyer@example.test', 'Test Buyer', '+525512345684', 'test']
        )

        await insertMetaPixelConfig()
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_test_event_code', 'TESTPAY123')
        await setAppConfig('meta_test_event_code_set_at', String(Date.now()))
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'site',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '',
            predictedLtv: '',
            custom: []
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_test_allowed',
          amount: 222.5,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          payment_mode: 'test',
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_test_allowed'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.test_event_code, 'TESTPAY123')
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].event_id, 'purchase_payment_payment_meta_test_allowed')
        assert.equal(payload.data[0].custom_data.value, 222.5)
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_test_allowed')
        assert.equal(payload.data[0].custom_data.payment_provider, 'stripe')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment row Purchase trigger allows test rows while Meta Test Events is active', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_test_row'
  const paymentId = 'payment_meta_test_row'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'test-row-buyer@example.test', 'Test Row Buyer', '+525512345685', 'test']
        )
        await db.run(
          `INSERT INTO payments (
             id, contact_id, amount, currency, status, payment_method, payment_mode,
             payment_provider, title, date, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            paymentId,
            contactId,
            333,
            'MXN',
            'paid',
            'stripe',
            'test',
            'stripe',
            'Pago de prueba Meta'
          ]
        )

        await insertMetaPixelConfig()
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_test_event_code', 'TESTROW123')
        await setAppConfig('meta_test_event_code_set_at', String(Date.now()))
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'site',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '',
            predictedLtv: '',
            custom: []
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerMetaPurchaseEventForPaymentRow(paymentId)

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.test_event_code, 'TESTROW123')
        assert.equal(payload.data[0].custom_data.payment_id, paymentId)
        assert.equal(payload.data[0].custom_data.payment_provider, 'stripe')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment plan Purchase uses total plan value once by default', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_plan_total'
  const planId = 'flow_meta_purchase_total'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId])
        await db.run('DELETE FROM payment_plans WHERE id = ?', [planId]).catch(() => undefined)
        await db.run('DELETE FROM payment_flows WHERE id = ?', [planId]).catch(() => undefined)
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'plan-buyer@example.test', 'Plan Buyer', '+525512345681', 'test']
        )
        await db.run(
          `INSERT INTO payment_flows (
             id, contact_id, contact_name, contact_email, contact_phone,
             total_amount, currency, concept, payment_type, current_state, metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            planId,
            contactId,
            'Plan Buyer',
            'plan-buyer@example.test',
            '+525512345681',
            900,
            'MXN',
            'Plan premium',
            'partial',
            'installment_plan_active',
            JSON.stringify({ source: 'test' })
          ]
        )
        await db.run(
          `INSERT INTO payment_plans (
             id, contact_id, contact_name, email, phone, name, title, status,
             total, currency, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            planId,
            contactId,
            'Plan Buyer',
            'plan-buyer@example.test',
            '+525512345681',
            'Plan premium',
            'Plan premium',
            'active',
            900,
            'MXN',
            'stripe'
          ]
        )

        await insertMetaPixelConfig()
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'site',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            value: '',
            predictedLtv: '',
            custom: [{ key: 'checkout_source', value: 'payment_plan' }]
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        // Card verification can have a nonzero amount. It is not the first
        // installment and must never consume the plan-wide conversion.
        const setup = { id: 'plan_card_verification', contact_id: contactId, status: 'paid', amount: 25,
          metadata: { paymentPlan: { flowId: planId, trigger: 'card_setup' } } }
        const missingPlan = { ...setup, id: 'missing_plan', metadata: { paymentPlan: { flowId: 'missing_flow' } } }
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, missingPlan)).reason, 'payment_plan_total_unavailable')
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, setup)).reason, 'card_authorization')
        assert.equal(await buildMetaPublicPurchasePixelEvent(setup), null)
        await db.run('UPDATE payment_flows SET first_payment_invoice_id = ? WHERE id = ?', ['payment_meta_plan_1', planId])
        const firstResult = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_plan_1',
          amount: 300,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          metadata_json: JSON.stringify({
            total: 300,
            paymentPlan: {
              flowId: planId,
              installmentId: 'installment_1',
              sequence: 1
            }
          }),
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_plan_1'
        })

        assert.equal(firstResult.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_id, `purchase_plan_${planId}`)
        assert.equal(payload.data[0].custom_data.value, 900)
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_plan_1')
        assert.equal(payload.data[0].custom_data.payment_plan_id, planId)
        assert.equal(payload.data[0].custom_data.installment_id, 'installment_1')
        assert.equal(payload.data[0].custom_data.payment_plan_value_mode, 'payment_plan_total')
        assert.equal(payload.data[0].custom_data.payment_plan_total_value, 900)
        assert.equal(payload.data[0].custom_data.current_payment_value, 300)
        assert.equal(payload.data[0].custom_data.checkout_source, 'payment_plan')

        // A checkout that renders after its CAPI receipt must still provide
        // the matching Pixel event. Later installments must never do so.
        const firstPixel = await buildMetaPublicPurchasePixelEvent({
          id: 'payment_meta_plan_1', contact_id: contactId, status: 'paid', amount: 300
        })
        assert.equal(firstPixel.eventId, firstResult.eventId)
        assert.equal(firstPixel.customData.value, 900)
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true, channel: 'site', parameters: { usePaymentPlanTotalValue: false }
        }))
        const laterPixel = await buildMetaPublicPurchasePixelEvent({
          id: 'payment_meta_plan_2', contact_id: contactId, status: 'paid', amount: 300,
          metadata: { paymentPlan: { flowId: planId } }
        })
        assert.equal(laterPixel, null)

        const secondResult = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_plan_2',
          amount: 300,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          metadata_json: JSON.stringify({
            paymentPlan: {
              flowId: planId,
              installmentId: 'installment_2',
              sequence: 2
            }
          }),
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_plan_2'
        })

        assert.equal(secondResult.sent, false)
        assert.equal(secondResult.reason, 'payment_plan_purchase_already_sent')
        assert.equal(secondResult.eventId, `purchase_plan_${planId}`)
        assert.equal(metaCalls.length, 1)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM payment_plans WHERE id = ?', [planId]).catch(() => undefined)
    await db.run('DELETE FROM payment_flows WHERE id = ?', [planId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('each paid transaction has its own Purchase and only an accepted live receipt consumes it', async () => {
  const previousGraph = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'accepted_purchase_receipts'
  const planId = 'recurring_plan_%_1'
  const metaCalls = []
  let server
  const payment = (id, amount) => ({
    id, contact_id: contactId, status: 'paid', amount, payment_provider: 'stripe',
    payment_url: `https://checkout.example.test/pay/${id}`
  })

  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, meta_purchase_event_sent, meta_purchase_event_id)
           VALUES (?, ?, 1, ?)`, [contactId, 'receipts@example.test', `purchase_contact_${contactId}`]
        )
        await insertMetaPixelConfig()
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true, channel: 'site', parameters: { usePaymentPlanTotalValue: false }
        }))
        server = await startMetaCaptureServer(metaCalls)
        const legacyId = `purchase_contact_${contactId}`
        const saveHistory = async (paymentId, response, testCode = '') => {
          const request = {
            data: [{ event_id: legacyId, custom_data: { payment_id: paymentId } }],
            ...(testCode && { test_event_code: testCode })
          }
          await db.run(
            `INSERT INTO meta_conversion_event_logs (contact_id, event_type, meta_event_name, event_id,
               status, request_payload, response_payload) VALUES (?, 'first_purchase', 'Purchase', ?, 'success', ?, ?)`,
            [contactId, legacyId, JSON.stringify(request), JSON.stringify(response)]
          )
        }
        // A legacy contact flag is only evidence for the payment actually
        // identified in its live payload. Test Events and empty receipts are retryable.
        await saveHistory('old_purchase', { events_received: 1 })
        await saveHistory('new_purchase', { events_received: 1 }, 'TEST_1')
        await saveHistory('new_purchase', { events_received: 0 })
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, payment('old_purchase', 90))).reason, 'already_sent')
        assert.equal((await buildMetaPublicPurchasePixelEvent(payment('old_purchase', 90))).eventId, legacyId)
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, payment('no_charge', 0))).reason, 'payment_not_successful')
        assert.equal(await buildMetaPublicPurchasePixelEvent(payment('no_charge', 0)), null)
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, { ...payment('pending_charge', 100), status: 'pending' })).reason, 'payment_not_successful')
        assert.equal(await buildMetaPublicPurchasePixelEvent({ ...payment('cash_receipt', 200), payment_provider: 'offline' }), null)
        const staleReceipt = { ...payment('stale_receipt', 200), paid_at: new Date(Date.now() - 49 * 3600000).toISOString() }
        assert.equal(await buildMetaPublicPurchasePixelEvent(staleReceipt), null)
        const standalone = await triggerMetaPaymentPurchaseEvent(contactId, payment('new_purchase', 100))
        assert.equal(standalone.sent, true)
        assert.equal((await triggerMetaPaymentPurchaseEvent(contactId, payment('new_purchase', 100))).reason, 'already_sent')

        const installment = (id, amount) => ({ ...payment(id, amount), payment_plan_id: planId })
        const first = await triggerMetaPaymentPurchaseEvent(contactId, installment('installment_1', 120))
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true, channel: 'site', parameters: { usePaymentPlanTotalValue: true }
        }))
        const second = await triggerMetaPaymentPurchaseEvent(contactId, installment('installment_2', 130))
        assert.equal(first.sent, true)
        assert.equal(second.sent, true)
        assert.notEqual(first.eventId, second.eventId)
        const paired = await buildMetaPublicPurchasePixelEvent(installment('installment_2', 130))
        assert.equal(paired.eventId, second.eventId)
        assert.deepEqual(metaCalls.map(call => JSON.parse(call.body).data[0].custom_data.value), [100, 120, 130])
        await db.run(
          `UPDATE meta_conversion_event_logs SET created_at = ? WHERE contact_id = ? AND event_id = ?`,
          [new Date(Date.now() - 49 * 3600000).toISOString(), contactId, second.eventId]
        )
        assert.equal(await buildMetaPublicPurchasePixelEvent(installment('installment_2', 130)), null)

        const concurrent = payment('concurrent', 150)
        const before = metaCalls.length
        await Promise.all([triggerMetaPaymentPurchaseEvent(contactId, concurrent), triggerMetaPaymentPurchaseEvent(contactId, concurrent)])
        const ids = metaCalls.slice(before).map(call => JSON.parse(call.body).data[0].event_id)
        assert.deepEqual(ids, ['purchase_payment_concurrent'])
      })
    })
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (previousGraph) Object.defineProperty(API_URLS, 'META_GRAPH', previousGraph)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('HighLevel payment and invoice webhooks send the payment instant for an older issued invoice', async () => {
  const previousGraph = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_webhook_date'
  const ghlContactId = 'ghl_meta_webhook_date'
  const invoiceIds = ['meta_payment_hook', 'meta_invoice_hook']
  const issuedAt = new Date(Date.now() - 90 * 86400000).toISOString()
  const paidAt = new Date(Date.now() - 3600000).toISOString()
  const metaCalls = []
  let server
  const response = { status() { return this }, json() {} }
  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await db.run('INSERT INTO contacts (id, ghl_contact_id, email) VALUES (?, ?, ?)', [contactId, ghlContactId, 'invoice@example.test'])
        for (const invoiceId of invoiceIds) {
          await db.run(
            `INSERT INTO payments (id, ghl_invoice_id, contact_id, amount, status, date, created_at, payment_mode)
             VALUES (?, ?, ?, 100, 'sent', ?, ?, 'live')`, [invoiceId, invoiceId, contactId, issuedAt, issuedAt]
          )
        }
        await insertMetaPixelConfig()
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({ enabled: true, channel: 'site' }))
        server = await startMetaCaptureServer(metaCalls)
        await handlePaymentWebhook({ body: { payment: {
          id: 'ghl_transaction_1', invoiceId: invoiceIds[0], contactId: ghlContactId, amount: 100, currency: 'USD',
          status: 'succeeded', liveMode: true, createdAt: issuedAt, fulfilledAt: paidAt
        } } }, response)
        await handleInvoiceWebhook({ body: {
          type: 'InvoicePaid', invoice: { _id: invoiceIds[1], createdAt: issuedAt, updatedAt: paidAt, liveMode: true }
        } }, response)
        await handleInvoiceWebhook({ body: {
          type: 'InvoicePaid', invoice: { _id: invoiceIds[1], updatedAt: new Date().toISOString(), liveMode: true }
        } }, response)
        const events = metaCalls.map(call => JSON.parse(call.body).data[0])
        assert.deepEqual(events.map(event => event.custom_data.payment_id), invoiceIds)
        for (const event of events) assert.equal(event.event_time, Math.floor(Date.parse(paidAt) / 1000))
      })
    })
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (previousGraph) Object.defineProperty(API_URLS, 'META_GRAPH', previousGraph)
    await db.run('DELETE FROM payments WHERE id IN (?, ?)', invoiceIds)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment smart sends website Purchase for checkout payments even with WhatsApp ad attribution', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_smart_whatsapp'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'wa-buyer@example.test', 'WhatsApp Buyer', '+525512345679', 'whatsapp']
        )
        await db.run(
          `INSERT INTO whatsapp_attribution (
             contact_id, phone, referral_ctwa_clid, referral_source_id, referral_source_type,
             referral_source_url, referral_headline, ad_id_thru_message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            contactId,
            '+525512345679',
            'ctwa-smart-payment-123',
            'ad-smart-77',
            'ad',
            'https://fb.example.test/ad/77',
            'Smart payment ad',
            'ad-smart-77'
          ]
        )

        await insertMetaPixelConfig({ pageId: 'page-smart-123' })
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            value: '',
            predictedLtv: '5400',
            custom: [{ key: 'checkout_source', value: 'smart_default' }]
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_purchase_smart_wa',
          amount: 777.5,
          status: 'paid',
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_purchase_smart_wa'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        // La compra ocurrió en un checkout web: el payload es website aunque
        // la atribución interna venga del anuncio de WhatsApp (último paid touch).
        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].action_source, 'website')
        assert.equal(payload.data[0].messaging_channel, undefined)
        assert.equal(payload.data[0].event_source_url, 'https://checkout.example.test/pay/payment_meta_purchase_smart_wa')
        assert.equal(payload.data[0].event_id, 'purchase_payment_payment_meta_purchase_smart_wa')
        assert.equal(payload.data[0].custom_data.value, 777.5)
        assert.equal(payload.data[0].custom_data.currency, 'MXN')
        assert.equal(payload.data[0].custom_data.predicted_ltv, 5400)
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_smart_wa')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.equal(payload.data[0].custom_data.checkout_source, 'smart_default')
        // La atribución interna (crédito) sí viaja en custom_data desde el touch.
        assert.equal(payload.data[0].custom_data.ad_id, 'ad-smart-77')
        assert.equal(payload.data[0].custom_data.ad_name, 'Smart payment ad')
        assert.equal(payload.data[0].custom_data.attribution_channel, 'whatsapp')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('payment smart sends Messenger Business Messaging when the conversation lives in Messenger', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_smart_messenger'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'msg-buyer@example.test', 'Messenger Buyer', 'messenger']
        )
        await insertMetaSocialContact({
          contactId,
          platform: 'messenger',
          senderId: 'psid-purchase-123',
          pageId: 'page-purchase-msg-123'
        })
        // La conversación real vive en Messenger: hay actividad de DM previa.
        await insertMetaSocialDmMessage({
          contactId,
          platform: 'messenger',
          senderId: 'psid-purchase-123',
          pageId: 'page-purchase-msg-123'
        })

        await insertMetaPixelConfig({ pageId: 'page-meta-fallback-msg' })
        await saveAccountLocaleSettings({ countryCode: 'US', currency: 'USD', dialCode: '1' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'smart',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            value: '',
            predictedLtv: '',
            custom: [{ key: 'checkout_source', value: 'messenger_dm' }]
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        // Pago sin URL de checkout: la conversión se cerró en el DM.
        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_purchase_smart_msg',
          amount: 321.25,
          status: 'paid'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].action_source, 'business_messaging')
        assert.equal(payload.data[0].messaging_channel, 'messenger')
        assert.equal(payload.data[0].event_source_url, undefined)
        assert.equal(payload.data[0].user_data.page_id, 'page-purchase-msg-123')
        assert.equal(payload.data[0].user_data.page_scoped_user_id, 'psid-purchase-123')
        assert.equal(payload.data[0].custom_data.value, 321.25)
        assert.equal(payload.data[0].custom_data.currency, 'USD')
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_smart_msg')
        assert.equal(payload.data[0].custom_data.checkout_source, 'messenger_dm')

        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({ enabled: true, channel: 'messenger' }))
        const beforeDm = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_before_messenger_conversation', amount: 100, status: 'paid',
          paid_at: new Date(Date.now() - 86400000).toISOString()
        })
        assert.equal(beforeDm.reason, 'missing_messaging_identity')
        assert.equal(metaCalls.length, 1)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('calendar appointment Business Messaging events support Meta Direct, Messenger and Instagram identities', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const whatsappContactId = 'contact_meta_calendar_whatsapp_direct'
  const messengerContactId = 'contact_meta_calendar_messenger'
  const instagramContactId = 'contact_meta_calendar_instagram'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(whatsappContactId)
        await deletePaymentMetaTestContact(messengerContactId)
        await deletePaymentMetaTestContact(instagramContactId)
        await db.run(
          `INSERT INTO contacts (
             id, email, full_name, phone, source, attribution_ctwa_clid, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [whatsappContactId, 'appt-wa@example.test', 'WhatsApp Appointment', '+525512345688', 'whatsapp', 'ctwa-appointment-direct-789']
        )
        await db.run(
          `INSERT INTO contacts (id, email, full_name, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [messengerContactId, 'appt-msg@example.test', 'Messenger Appointment', 'messenger']
        )
        await db.run(
          `INSERT INTO contacts (id, email, full_name, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [instagramContactId, 'appt-ig@example.test', 'Instagram Appointment', 'instagram']
        )
        await insertMetaSocialContact({
          contactId: messengerContactId,
          platform: 'messenger',
          senderId: 'psid-appointment-123',
          pageId: 'page-appointment-msg-123'
        })
        await insertMetaSocialDmMessage({
          contactId: messengerContactId,
          platform: 'messenger',
          senderId: 'psid-appointment-123',
          pageId: 'page-appointment-msg-123'
        })
        await insertMetaSocialContact({
          contactId: instagramContactId,
          platform: 'instagram',
          senderId: 'igsid-appointment-456',
          instagramAccountId: 'ig-account-appointment-456'
        })
        await insertMetaSocialDmMessage({
          contactId: instagramContactId,
          platform: 'instagram',
          senderId: 'igsid-appointment-456',
          instagramAccountId: 'ig-account-appointment-456'
        })

        await insertMetaPixelConfig({ pageId: 'page-calendar-fallback' })
        await setAppConfig('whatsapp_api_provider', 'meta_direct')
        await setAppConfig('whatsapp_meta_direct_waba_id', 'direct-waba-calendar-789')
        metaServer = await startMetaCaptureServer(metaCalls)

        const whatsappResult = await triggerWhatsappAppointmentBookedEvent(whatsappContactId, {
          calendarId: 'calendar_wa',
          calendarName: 'Calendario WhatsApp',
          appointmentId: 'appointment_wa_789',
          customEvents: { enabled: true, channel: 'whatsapp', eventName: 'Schedule' }
        })
        const messengerResult = await triggerWhatsappAppointmentBookedEvent(messengerContactId, {
          calendarId: 'calendar_msg',
          calendarName: 'Calendario Messenger',
          appointmentId: 'appointment_msg_123',
          customEvents: { enabled: true, channel: 'messenger', eventName: 'Schedule' }
        })
        const instagramResult = await triggerWhatsappAppointmentBookedEvent(instagramContactId, {
          calendarId: 'calendar_ig',
          calendarName: 'Calendario Instagram',
          appointmentId: 'appointment_ig_456',
          customEvents: { enabled: true, channel: 'instagram', eventName: 'Schedule' }
        })

        assert.equal(whatsappResult.sent, true)
        assert.equal(messengerResult.sent, true)
        assert.equal(instagramResult.sent, true)
        assert.equal(metaCalls.length, 3)

        const whatsappPayload = JSON.parse(metaCalls[0].body)
        assert.equal(whatsappPayload.data[0].event_name, 'LeadSubmitted')
        assert.equal(whatsappPayload.data[0].action_source, 'business_messaging')
        assert.equal(whatsappPayload.data[0].messaging_channel, 'whatsapp')
        assert.equal(whatsappPayload.data[0].user_data.ctwa_clid, 'ctwa-appointment-direct-789')
        assert.equal(whatsappPayload.data[0].user_data.page_id, 'page-calendar-fallback')
        assert.equal(whatsappPayload.data[0].user_data.whatsapp_business_account_id, 'direct-waba-calendar-789')

        const messengerPayload = JSON.parse(metaCalls[1].body)
        assert.equal(messengerPayload.data[0].event_name, 'LeadSubmitted')
        assert.equal(messengerPayload.data[0].action_source, 'business_messaging')
        assert.equal(messengerPayload.data[0].messaging_channel, 'messenger')
        assert.equal(messengerPayload.data[0].user_data.page_id, 'page-appointment-msg-123')
        assert.equal(messengerPayload.data[0].user_data.page_scoped_user_id, 'psid-appointment-123')
        assert.equal(messengerPayload.data[0].custom_data.source, 'messenger')
        assert.equal(messengerPayload.data[0].custom_data.messaging_channel, 'messenger')
        assert.equal(messengerPayload.data[0].custom_data.appointment_id, 'appointment_msg_123')

        const instagramPayload = JSON.parse(metaCalls[2].body)
        assert.equal(instagramPayload.data[0].event_name, 'LeadSubmitted')
        assert.equal(instagramPayload.data[0].action_source, 'business_messaging')
        assert.equal(instagramPayload.data[0].messaging_channel, 'instagram')
        assert.equal(instagramPayload.data[0].user_data.ig_account_id, 'ig-account-appointment-456')
        assert.equal(instagramPayload.data[0].user_data.ig_sid, 'igsid-appointment-456')
        assert.equal(instagramPayload.data[0].user_data.ig_scoped_user_id, undefined)
        assert.equal(instagramPayload.data[0].custom_data.source, 'instagram')
        assert.equal(instagramPayload.data[0].custom_data.messaging_channel, 'instagram')
        assert.equal(instagramPayload.data[0].custom_data.appointment_id, 'appointment_ig_456')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(whatsappContactId)
    await deletePaymentMetaTestContact(messengerContactId)
    await deletePaymentMetaTestContact(instagramContactId)
  }
})

test('payment smart default falls back to website Purchase data without WhatsApp attribution', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_smart_site'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'site-buyer@example.test', 'Site Buyer', '+525512345680', 'site']
        )

        await insertMetaPixelConfig()
        await saveAccountLocaleSettings({ countryCode: 'US', currency: 'USD', dialCode: '1' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            value: '100',
            predictedLtv: '',
            custom: [{ key: 'checkout_source', value: 'site_fallback' }]
          }
        }))

        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_purchase_smart_site',
          amount: 321,
          status: 'paid',
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_purchase_smart_site'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].action_source, 'website')
        assert.equal(payload.data[0].event_source_url, 'https://checkout.example.test/pay/payment_meta_purchase_smart_site')
        assert.equal(payload.data[0].event_id, 'purchase_payment_payment_meta_purchase_smart_site')
        assert.equal(payload.data[0].custom_data.value, 321)
        assert.equal(payload.data[0].custom_data.currency, 'USD')
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_smart_site')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.equal(payload.data[0].custom_data.checkout_source, 'site_fallback')
        assert.match(payload.data[0].user_data.em, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
        assert.equal(payload.data[0].messaging_channel, undefined)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
  }
})

test('public payment pixel event is built for smart website Purchase without WhatsApp attribution', async () => {
  const contactId = 'contact_meta_public_pixel_site'

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'pixel-buyer@example.test', 'Pixel Buyer', '+525512345682', 'site']
        )

        await insertMetaPixelConfig({ pixelId: 'pixel-public-payment-123' })
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'smart',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '',
            predictedLtv: '',
            custom: [{ key: 'checkout_source', value: 'payment_block' }]
          }
        }))

        const event = await buildMetaPublicPurchasePixelEvent({
          id: 'payment_meta_public_pixel_1',
          contact_id: contactId,
          amount: 456.78,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          payment_mode: 'live',
          public_payment_id: 'public_pixel_1',
          payment_url: 'https://checkout.example.test/pay/public_pixel_1?email=pixel-buyer@example.test&fbclid=fb.pixel',
          title: 'Bloque de pago'
        })

        assert.equal(event.pixelId, 'pixel-public-payment-123')
        assert.equal(event.eventName, 'Purchase')
        assert.equal(event.eventId, 'purchase_payment_payment_meta_public_pixel_1')
        assert.equal(event.customData.value, 456.78)
        assert.equal(event.customData.currency, 'MXN')
        assert.equal(event.customData.payment_id, 'payment_meta_public_pixel_1')
        assert.equal(event.customData.payment_status, 'paid')
        assert.equal(event.customData.payment_provider, 'stripe')
        assert.equal(event.customData.public_payment_id, 'public_pixel_1')
        assert.equal(event.customData.order_id, 'public_pixel_1')
        assert.equal(event.customData.content_name, 'Bloque de pago')
        assert.equal(event.customData.checkout_source, 'payment_block')
      })
    })
  } finally {
    await deletePaymentMetaTestContact(contactId)
  }
})

test('public payment pixel event is built for smart WhatsApp-attributed checkout payments', async () => {
  const contactId = 'contact_meta_public_pixel_whatsapp'

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'pixel-wa-buyer@example.test', 'Pixel WA Buyer', '+525512345683', 'whatsapp']
        )
        await db.run(
          `INSERT INTO whatsapp_attribution (
             contact_id, phone, referral_ctwa_clid, referral_source_id, referral_source_type,
             referral_source_url, referral_headline, ad_id_thru_message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            contactId,
            '+525512345683',
            'ctwa-public-payment-123',
            'ad-public-payment-1',
            'ad',
            'https://fb.example.test/ad/public-payment',
            'Public payment ad',
            'ad-public-payment-1'
          ]
        )

        await insertMetaPixelConfig({ pixelId: 'pixel-public-payment-wa-123', pageId: 'page-public-payment-wa' })
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'smart',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '',
            predictedLtv: '',
            custom: []
          }
        }))

        // Un pago de checkout ES superficie website: el pixel del navegador
        // dispara siempre y comparte event_id con el evento server-side para
        // que Meta deduplique (antes se suprimía por atribución de WhatsApp).
        const event = await buildMetaPublicPurchasePixelEvent({
          id: 'payment_meta_public_pixel_wa',
          contact_id: contactId,
          amount: 650,
          status: 'paid',
          payment_provider: 'conekta',
          payment_method: 'conekta',
          payment_mode: 'live',
          public_payment_id: 'public_pixel_wa',
          payment_url: 'https://checkout.example.test/pay/public_pixel_wa'
        })

        assert.ok(event)
        assert.equal(event.pixelId, 'pixel-public-payment-wa-123')
        assert.equal(event.eventName, 'Purchase')
        assert.equal(event.eventId, 'purchase_payment_payment_meta_public_pixel_wa')
        assert.equal(event.customData.value, 650)
      })
    })
  } finally {
    await deletePaymentMetaTestContact(contactId)
  }
})

test('public payment pixel event is built for smart Meta social-attributed checkout payments', async () => {
  const contactId = 'contact_meta_public_pixel_messenger'

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await deletePaymentMetaTestContact(contactId)
        await db.run(
          `INSERT INTO contacts (id, email, full_name, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'pixel-msg-buyer@example.test', 'Pixel Messenger Buyer', 'messenger']
        )
        await insertMetaSocialContact({
          contactId,
          platform: 'messenger',
          senderId: 'psid-public-payment-123',
          pageId: 'page-public-payment-msg'
        })

        await insertMetaPixelConfig({ pixelId: 'pixel-public-payment-msg-123', pageId: 'page-public-payment-msg' })
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'smart',
          eventName: 'Purchase',
          parameters: {
            sendValue: true,
            usePaymentPlanTotalValue: false,
            value: '',
            predictedLtv: '',
            custom: []
          }
        }))

        const event = await buildMetaPublicPurchasePixelEvent({
          id: 'payment_meta_public_pixel_msg',
          contact_id: contactId,
          amount: 725,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          payment_mode: 'live',
          public_payment_id: 'public_pixel_msg',
          payment_url: 'https://checkout.example.test/pay/public_pixel_msg'
        })

        assert.ok(event)
        assert.equal(event.pixelId, 'pixel-public-payment-msg-123')
        assert.equal(event.eventName, 'Purchase')
        assert.equal(event.eventId, 'purchase_payment_payment_meta_public_pixel_msg')
        assert.equal(event.customData.value, 725)
      })
    })
  } finally {
    await deletePaymentMetaTestContact(contactId)
  }
})

test('crear un plan con anticipo pagado reporta ese cobro y deja pendientes las cuotas futuras', async () => {
  const contactId = 'contact_offline_first_meta'
  const metaCalls = []
  const originalGraph = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let server
  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig([...APP_CONFIG_KEYS, 'payments_settings'], async () => {
        await insertMetaPixelConfig()
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true, channel: 'smart', parameters: { sendValue: true, usePaymentPlanTotalValue: false }
        }))
        await savePaymentSettings({ paymentMode: 'live', automations: { remindersEnabled: true, reminderChannel: 'email' } })
        await db.run('INSERT INTO contacts (id, full_name, email) VALUES (?, ?, ?)', [contactId, 'Prueba Plan', 'plan@example.test'])
        server = await startMetaCaptureServer(metaCalls)
        const plan = await createOfflinePaymentPlan({
          contact: { id: contactId, email: 'plan@example.test' }, totalAmount: 400,
          firstPayment: { enabled: true, amount: 100, method: 'cash' },
          remainingPayments: [{ amount: 300, dueDate: '2099-09-01' }]
        }, { baseUrl: 'https://checkout.example.test' })
        assert.equal(metaCalls.length, 1)
        const [purchase] = JSON.parse(metaCalls[0].body).data
        assert.equal(purchase.custom_data.payment_id, plan.firstPaymentPaymentId)
        assert.equal(purchase.custom_data.value, 100)
        assert.equal(purchase.action_source, 'physical_store')
        assert.equal(purchase.event_source_url, undefined)
        const pending = await triggerMetaPurchaseEventForPaymentRow(plan.scheduledPayments[0].paymentId)
        assert.equal(pending.reason, 'payment_not_successful')
        assert.equal(metaCalls.length, 1)
      })
    })
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', originalGraph)
  }
})
