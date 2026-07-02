// Escenarios de la tabla del brief "Last Paid Touch Attribution + superficie
// real de conversión":
//
// | Historia                                        | Payload Meta                    | Atribución interna |
// |-------------------------------------------------|---------------------------------|--------------------|
// | WhatsApp orgánico → Web ad → Compra WhatsApp    | business_messaging / whatsapp   | Web ad             |
// | Web ad → Messenger ad → Compra Web              | website                         | Messenger ad       |
// | WhatsApp ad → Messenger orgánico → Compra Msngr | business_messaging / messenger  | WhatsApp ad        |
// | Web orgánico → Compra Web                       | website                         | ninguna (orgánico) |
// | Instagram ad → Compra WhatsApp                  | business_messaging / whatsapp   | Instagram ad       |
//
// La atribución la decide el último anuncio válido; el payload de Meta lo
// decide la superficie real donde ocurrió la conversión.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import {
  triggerMetaPaymentPurchaseEvent,
  triggerWhatsappAppointmentBookedEvent
} from '../src/services/metaConversionEventsService.js'
import {
  findLastPaidTouch,
  detectConversionSurface,
  resolveConversionAttribution
} from '../src/services/conversionAttributionService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

const APP_CONFIG_KEYS = [
  'account_country',
  'account_currency',
  'account_default_dial_code',
  'meta_payment_purchase_event_config',
  'meta_test_event_code',
  'meta_test_event_code_set_at'
]

// Timestamps futuros y ordenados para no chocar con datos reales.
const T1 = '2099-03-01T10:00:00.000Z'
const T2 = '2099-03-02T10:00:00.000Z'
const T3 = '2099-03-03T10:00:00.000Z'

function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function snapshotAppConfig(keys, callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = await db.all(
    `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
    uniqueKeys
  )
  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    return await callback()
  } finally {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    for (const row of previousRows) {
      await setAppConfig(row.config_key, row.config_value)
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
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
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

async function insertMetaPixelConfig({ pixelId = 'pixel-attribution-123', pageId = 'page-attribution-123' } = {}) {
  await db.run(`
    INSERT INTO meta_config (
      ad_account_id, access_token, pixel_id, page_id, instagram_account_id,
      timezone_id, timezone_name, timezone_offset_hours_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, ['123456', encrypt('meta-access-token'), pixelId, pageId, null, null, null, null])
}

async function cleanupContact(contactId) {
  for (const [table, column] of [
    ['meta_conversion_event_logs', 'contact_id'],
    ['whatsapp_attribution', 'contact_id'],
    ['whatsapp_api_messages', 'contact_id'],
    ['meta_social_messages', 'contact_id'],
    ['meta_social_contacts', 'contact_id'],
    ['sessions', 'contact_id'],
    ['payments', 'contact_id'],
    ['appointments', 'contact_id'],
    ['contacts', 'id']
  ]) {
    await db.run(`DELETE FROM ${table} WHERE ${column} = ?`, [contactId]).catch(() => undefined)
  }
}

async function insertContact({ contactId, phone = '', email = '' }) {
  await db.run(
    `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, email || null, `Contacto ${contactId}`, phone || null]
  )
}

async function insertWebSession({ contactId, startedAt, fbclid = '', fbc = '', fbp = '', adId = '', adName = '', campaignId = '', adsetId = '', pageUrl = 'https://site.example.test/landing' }) {
  await db.run(
    `INSERT INTO sessions (
       session_id, visitor_id, contact_id, event_name, started_at, created_at,
       page_url, fbclid, fbc, fbp, campaign_id, adset_id, ad_id, ad_name
     ) VALUES (?, ?, ?, 'page_view', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `session_${contactId}_${uniqueSuffix()}`,
      `visitor_${contactId}`,
      contactId,
      startedAt,
      startedAt,
      pageUrl,
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

async function insertWhatsappMessage({ contactId, phone, messageTimestamp, ctwaClid = '', sourceId = '', headline = '' }) {
  await db.run(
    `INSERT INTO whatsapp_api_messages (
       id, provider, contact_id, phone, from_phone, direction, message_type, message_text,
       message_timestamp, detected_ctwa_clid, detected_source_id, detected_headline, created_at, updated_at
     ) VALUES (?, 'ycloud', ?, ?, ?, 'inbound', 'text', 'hola', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `wa_msg_${contactId}_${uniqueSuffix()}`,
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

async function insertSocialIdentity({ contactId, platform, senderId, pageId = '', instagramAccountId = '' }) {
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

async function insertSocialDm({ contactId, platform, senderId, messageTimestamp, pageId = '', instagramAccountId = '', referral = null }) {
  await db.run(
    `INSERT INTO meta_social_messages (
       id, platform, contact_id, sender_id, recipient_id, page_id, instagram_account_id,
       direction, status, message_type, message_text, message_timestamp, referral_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', 'received', 'text', 'hola', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      `meta_social_msg_${contactId}_${uniqueSuffix()}`,
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

async function insertPayment({ paymentId, contactId, amount = 500, paymentUrl = '', publicPaymentId = '' }) {
  await db.run(
    `INSERT INTO payments (
       id, contact_id, amount, currency, status, payment_method, payment_mode, payment_provider,
       payment_url, public_payment_id, date, created_at, updated_at
     ) VALUES (?, ?, ?, 'MXN', 'paid', 'card', 'live', 'manual', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [paymentId, contactId, amount, paymentUrl || null, publicPaymentId || null]
  )
}

async function insertAppointment({ appointmentId, contactId, calendarId = 'calendar_attr_test' }) {
  await db.run(
    `INSERT INTO appointments (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
     VALUES (?, ?, ?, 'Cita test', 'booked', 'confirmed', ?, ?)`,
    [appointmentId, calendarId, contactId, T3, T3]
  )
}

async function getPaymentSnapshot(paymentId) {
  return db.get(
    `SELECT attribution_channel, attribution_source, attribution_touch_type, attribution_ad_id,
            attribution_ad_name, conversion_surface
     FROM payments WHERE id = ?`,
    [paymentId]
  )
}

async function withPurchaseScenario({ contactId, callback }) {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await cleanupContact(contactId)
        await insertMetaPixelConfig({})
        await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: true,
          channel: 'smart',
          eventName: 'Purchase',
          parameters: { sendValue: true, usePaymentPlanTotalValue: false, value: '', predictedLtv: '', custom: [] }
        }))
        metaServer = await startMetaCaptureServer(metaCalls)
        await callback({ metaCalls })
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await cleanupContact(contactId)
  }
}

test('escenario 1: WhatsApp orgánico → Web ad → compra WhatsApp = payload whatsapp, crédito web ad', async () => {
  const contactId = 'contact_attr_scenario_1'
  const phone = '+525599000001'
  const paymentId = `payment_attr_1_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async ({ metaCalls }) => {
      await insertContact({ contactId, phone, email: 'attr1@example.test' })
      // Nace por WhatsApp orgánico (sin ctwa)
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T1 })
      // Luego toca un anuncio web (paid touch más reciente)
      await insertWebSession({ contactId, startedAt: T2, fbclid: 'fbclid-attr-1', fbc: 'fb.1.111.fbclid-attr-1', fbp: 'fb.1.111.222', adId: 'ad-web-111', adName: 'Web Ad Uno', campaignId: 'camp-web-111', adsetId: 'adset-web-111' })
      // Y compra por WhatsApp (conversación más reciente, sin URL de checkout)
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T3 })
      await insertPayment({ paymentId, contactId, amount: 900 })

      const result = await triggerMetaPaymentPurchaseEvent(contactId, {
        id: paymentId,
        amount: 900,
        status: 'paid'
      })

      assert.equal(result.sent, true)
      assert.equal(metaCalls.length, 1)

      const payload = JSON.parse(metaCalls[0].body)
      // Superficie real: WhatsApp (aunque no haya ctwa, no se falsifica).
      assert.equal(payload.data[0].action_source, 'business_messaging')
      assert.equal(payload.data[0].messaging_channel, 'whatsapp')
      assert.equal(payload.data[0].user_data.ctwa_clid, undefined)
      assert.ok(payload.data[0].user_data.ph)
      // Crédito interno: el anuncio web (último paid touch).
      assert.equal(payload.data[0].custom_data.ad_id, 'ad-web-111')
      assert.equal(payload.data[0].custom_data.attribution_channel, 'website')
      assert.equal(payload.data[0].custom_data.campaign_id, 'camp-web-111')

      const snapshot = await getPaymentSnapshot(paymentId)
      assert.equal(snapshot.attribution_channel, 'website')
      assert.equal(snapshot.attribution_source, 'paid_ad')
      assert.equal(snapshot.attribution_touch_type, 'web')
      assert.equal(snapshot.attribution_ad_id, 'ad-web-111')
      assert.equal(snapshot.conversion_surface, 'whatsapp')
    }
  })
})

test('escenario 2: Web ad → Messenger ad → compra Web = payload website, crédito Messenger ad', async () => {
  const contactId = 'contact_attr_scenario_2'
  const paymentId = `payment_attr_2_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async ({ metaCalls }) => {
      await insertContact({ contactId, email: 'attr2@example.test' })
      // Primero anuncio web
      await insertWebSession({ contactId, startedAt: T1, fbclid: 'fbclid-attr-2', fbc: 'fb.1.222.fbclid-attr-2', fbp: 'fb.1.222.333', adId: 'ad-web-222' })
      // Después anuncio de Messenger (paid touch más reciente)
      await insertSocialIdentity({ contactId, platform: 'messenger', senderId: 'psid-attr-2', pageId: 'page-attr-2' })
      await insertSocialDm({
        contactId,
        platform: 'messenger',
        senderId: 'psid-attr-2',
        pageId: 'page-attr-2',
        messageTimestamp: T2,
        referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: 'ad-msgr-222', ads_context_data: { ad_title: 'Messenger Ad Dos' } }
      })
      // Compra en el checkout web
      const paymentUrl = `https://checkout.example.test/pay/${paymentId}`
      await insertPayment({ paymentId, contactId, amount: 1200, paymentUrl, publicPaymentId: `pub_${paymentId}` })

      const result = await triggerMetaPaymentPurchaseEvent(contactId, {
        id: paymentId,
        amount: 1200,
        status: 'paid',
        payment_url: paymentUrl,
        public_payment_id: `pub_${paymentId}`
      })

      assert.equal(result.sent, true)
      assert.equal(metaCalls.length, 1)

      const payload = JSON.parse(metaCalls[0].body)
      // Superficie real: website (aunque el último anuncio sea de Messenger).
      assert.equal(payload.data[0].action_source, 'website')
      assert.equal(payload.data[0].messaging_channel, undefined)
      assert.equal(payload.data[0].event_source_url, paymentUrl)
      // fbp/fbc de la última sesión web viajan server-side.
      assert.equal(payload.data[0].user_data.fbp, 'fb.1.222.333')
      assert.equal(payload.data[0].user_data.fbc, 'fb.1.222.fbclid-attr-2')
      // Crédito interno: el anuncio de Messenger.
      assert.equal(payload.data[0].custom_data.ad_id, 'ad-msgr-222')
      assert.equal(payload.data[0].custom_data.ad_name, 'Messenger Ad Dos')
      assert.equal(payload.data[0].custom_data.attribution_channel, 'messenger')

      const snapshot = await getPaymentSnapshot(paymentId)
      assert.equal(snapshot.attribution_channel, 'messenger')
      assert.equal(snapshot.attribution_source, 'paid_ad')
      assert.equal(snapshot.attribution_touch_type, 'social_ad')
      assert.equal(snapshot.attribution_ad_id, 'ad-msgr-222')
      assert.equal(snapshot.conversion_surface, 'website')
    }
  })
})

test('escenario 3: WhatsApp ad → Messenger orgánico → compra Messenger = payload messenger, crédito WhatsApp ad', async () => {
  const contactId = 'contact_attr_scenario_3'
  const phone = '+525599000003'
  const paymentId = `payment_attr_3_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async ({ metaCalls }) => {
      await insertContact({ contactId, phone, email: 'attr3@example.test' })
      // Llega por anuncio de WhatsApp (ctwa)
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T1, ctwaClid: 'ctwa-attr-3', sourceId: 'ad-wa-333', headline: 'WhatsApp Ad Tres' })
      // Luego conversación orgánica de Messenger (sin referral) y compra ahí
      await insertSocialIdentity({ contactId, platform: 'messenger', senderId: 'psid-attr-3', pageId: 'page-attr-3' })
      await insertSocialDm({ contactId, platform: 'messenger', senderId: 'psid-attr-3', pageId: 'page-attr-3', messageTimestamp: T3 })
      await insertPayment({ paymentId, contactId, amount: 750 })

      const result = await triggerMetaPaymentPurchaseEvent(contactId, {
        id: paymentId,
        amount: 750,
        status: 'paid'
      })

      assert.equal(result.sent, true)
      assert.equal(metaCalls.length, 1)

      const payload = JSON.parse(metaCalls[0].body)
      // Superficie real: Messenger.
      assert.equal(payload.data[0].action_source, 'business_messaging')
      assert.equal(payload.data[0].messaging_channel, 'messenger')
      assert.equal(payload.data[0].user_data.page_scoped_user_id, 'psid-attr-3')
      assert.equal(payload.data[0].user_data.page_id, 'page-attr-3')
      // Crédito interno: el anuncio de WhatsApp.
      assert.equal(payload.data[0].custom_data.ad_id, 'ad-wa-333')
      assert.equal(payload.data[0].custom_data.attribution_channel, 'whatsapp')

      const snapshot = await getPaymentSnapshot(paymentId)
      assert.equal(snapshot.attribution_channel, 'whatsapp')
      assert.equal(snapshot.attribution_source, 'paid_ad')
      assert.equal(snapshot.attribution_touch_type, 'whatsapp_ad')
      assert.equal(snapshot.attribution_ad_id, 'ad-wa-333')
      assert.equal(snapshot.conversion_surface, 'messenger')
    }
  })
})

test('escenario 4: Web orgánico → compra Web = payload website, atribución orgánica (fbp solo NO es paid)', async () => {
  const contactId = 'contact_attr_scenario_4'
  const paymentId = `payment_attr_4_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async ({ metaCalls }) => {
      await insertContact({ contactId, email: 'attr4@example.test' })
      // Visita orgánica: fbp presente (el pixel se lo pone a todos) pero sin
      // click-id ni campaña. NO debe contar como paid touch.
      await insertWebSession({ contactId, startedAt: T1, fbp: 'fb.1.444.555' })
      const paymentUrl = `https://checkout.example.test/pay/${paymentId}`
      await insertPayment({ paymentId, contactId, amount: 300, paymentUrl })

      const result = await triggerMetaPaymentPurchaseEvent(contactId, {
        id: paymentId,
        amount: 300,
        status: 'paid',
        payment_url: paymentUrl
      })

      assert.equal(result.sent, true)
      assert.equal(metaCalls.length, 1)

      const payload = JSON.parse(metaCalls[0].body)
      assert.equal(payload.data[0].action_source, 'website')
      assert.equal(payload.data[0].custom_data.ad_id, undefined)
      assert.equal(payload.data[0].custom_data.attribution_channel, undefined)

      const snapshot = await getPaymentSnapshot(paymentId)
      assert.equal(snapshot.attribution_source, 'organic')
      assert.equal(snapshot.attribution_channel, 'website')
      assert.equal(snapshot.attribution_touch_type, null)
      assert.equal(snapshot.conversion_surface, 'website')
    }
  })
})

test('escenario 5: Instagram ad → compra WhatsApp = payload whatsapp, crédito Instagram ad', async () => {
  const contactId = 'contact_attr_scenario_5'
  const phone = '+525599000005'
  const paymentId = `payment_attr_5_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async ({ metaCalls }) => {
      await insertContact({ contactId, phone, email: 'attr5@example.test' })
      // Anuncio de Instagram (CTI)
      await insertSocialIdentity({ contactId, platform: 'instagram', senderId: 'igsid-attr-5', instagramAccountId: 'ig-account-attr-5' })
      await insertSocialDm({
        contactId,
        platform: 'instagram',
        senderId: 'igsid-attr-5',
        instagramAccountId: 'ig-account-attr-5',
        messageTimestamp: T1,
        referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: 'ad-ig-555', ads_context_data: { ad_title: 'Instagram Ad Cinco' } }
      })
      // Compra por WhatsApp (conversación más reciente)
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T3 })
      await insertPayment({ paymentId, contactId, amount: 1500 })

      const result = await triggerMetaPaymentPurchaseEvent(contactId, {
        id: paymentId,
        amount: 1500,
        status: 'paid'
      })

      assert.equal(result.sent, true)
      assert.equal(metaCalls.length, 1)

      const payload = JSON.parse(metaCalls[0].body)
      // Superficie real: WhatsApp (sin ctwa: matching por teléfono, sin falsificar).
      assert.equal(payload.data[0].action_source, 'business_messaging')
      assert.equal(payload.data[0].messaging_channel, 'whatsapp')
      assert.equal(payload.data[0].user_data.ctwa_clid, undefined)
      assert.ok(payload.data[0].user_data.ph)
      // Crédito interno: el anuncio de Instagram.
      assert.equal(payload.data[0].custom_data.ad_id, 'ad-ig-555')
      assert.equal(payload.data[0].custom_data.attribution_channel, 'instagram')

      const snapshot = await getPaymentSnapshot(paymentId)
      assert.equal(snapshot.attribution_channel, 'instagram')
      assert.equal(snapshot.attribution_source, 'paid_ad')
      assert.equal(snapshot.attribution_touch_type, 'social_ad')
      assert.equal(snapshot.attribution_ad_id, 'ad-ig-555')
      assert.equal(snapshot.conversion_surface, 'whatsapp')
    }
  })
})

test('cita smart: conversación WhatsApp + crédito de anuncio web → payload whatsapp con snapshot en la cita', async () => {
  const contactId = 'contact_attr_cita_wa'
  const phone = '+525599000006'
  const appointmentId = `appointment_attr_wa_${uniqueSuffix()}`
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await cleanupContact(contactId)
        await insertContact({ contactId, phone, email: 'attr-cita@example.test' })
        await insertWhatsappMessage({ contactId, phone, messageTimestamp: T1 })
        await insertWebSession({ contactId, startedAt: T2, fbclid: 'fbclid-cita-1', adId: 'ad-web-cita-1', adName: 'Web Ad Cita' })
        await insertWhatsappMessage({ contactId, phone, messageTimestamp: T3 })
        await insertAppointment({ appointmentId, contactId })
        await insertMetaPixelConfig({})
        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: 'calendar_attr_test',
          calendarName: 'Calendario Attr',
          appointmentId,
          customEvents: { enabled: true, channel: 'smart', eventName: 'Schedule' }
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'LeadSubmitted')
        assert.equal(payload.data[0].action_source, 'business_messaging')
        assert.equal(payload.data[0].messaging_channel, 'whatsapp')
        assert.equal(payload.data[0].custom_data.ad_id, 'ad-web-cita-1')
        assert.equal(payload.data[0].custom_data.attribution_channel, 'website')

        const snapshot = await db.get(
          `SELECT attribution_channel, attribution_source, attribution_ad_id, conversion_surface
           FROM appointments WHERE id = ?`,
          [appointmentId]
        )
        assert.equal(snapshot.attribution_channel, 'website')
        assert.equal(snapshot.attribution_source, 'paid_ad')
        assert.equal(snapshot.attribution_ad_id, 'ad-web-cita-1')
        assert.equal(snapshot.conversion_surface, 'whatsapp')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await cleanupContact(contactId)
  }
})

test('cita smart sin mensajería: superficie website server-side con fbp/fbc de la última sesión', async () => {
  const contactId = 'contact_attr_cita_web'
  const appointmentId = `appointment_attr_web_${uniqueSuffix()}`
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()
    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await cleanupContact(contactId)
        await insertContact({ contactId, email: 'attr-cita-web@example.test' })
        await insertWebSession({
          contactId,
          startedAt: T1,
          fbclid: 'fbclid-cita-web',
          fbc: 'fb.1.666.fbclid-cita-web',
          fbp: 'fb.1.666.777',
          adId: 'ad-web-cita-2',
          pageUrl: 'https://site.example.test/agenda'
        })
        await insertAppointment({ appointmentId, contactId })
        await insertMetaPixelConfig({})
        metaServer = await startMetaCaptureServer(metaCalls)

        const result = await triggerWhatsappAppointmentBookedEvent(contactId, {
          calendarId: 'calendar_attr_test',
          calendarName: 'Calendario Attr Web',
          appointmentId,
          customEvents: { enabled: true, channel: 'smart', eventName: 'Schedule' }
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Schedule')
        assert.equal(payload.data[0].action_source, 'website')
        assert.equal(payload.data[0].event_source_url, 'https://site.example.test/agenda')
        assert.equal(payload.data[0].user_data.fbp, 'fb.1.666.777')
        assert.equal(payload.data[0].user_data.fbc, 'fb.1.666.fbclid-cita-web')

        const snapshot = await db.get(
          `SELECT attribution_channel, attribution_source, conversion_surface FROM appointments WHERE id = ?`,
          [appointmentId]
        )
        assert.equal(snapshot.attribution_channel, 'website')
        assert.equal(snapshot.attribution_source, 'paid_ad')
        assert.equal(snapshot.conversion_surface, 'website')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await cleanupContact(contactId)
  }
})

test('findLastPaidTouch: una cookie _fbc vieja re-enviada en visita orgánica no roba crédito', async () => {
  const contactId = 'contact_attr_unit_stale_fbc'
  const phone = '+525599000008'
  try {
    await cleanupContact(contactId)
    await insertContact({ contactId, phone, email: 'attr-fbc@example.test' })
    // Anuncio de WhatsApp (ctwa) en T1: el paid touch legítimo.
    await insertWhatsappMessage({ contactId, phone, messageTimestamp: T1, ctwaClid: 'ctwa-stale-fbc', sourceId: 'ad-wa-888', headline: 'WhatsApp Ad' })
    // Visita orgánica en T3 que re-manda una cookie _fbc creada MESES antes
    // (timestamp embebido viejo, sin fbclid en la URL). No debe contar paid.
    const staleCreationMs = Date.parse('2099-01-01T00:00:00.000Z')
    await insertWebSession({ contactId, startedAt: T3, fbc: `fb.1.${staleCreationMs}.fbclid-viejo`, fbp: 'fb.1.999.111' })

    const touch = await findLastPaidTouch({ contactId })
    assert.ok(touch)
    assert.equal(touch.type, 'whatsapp_ad')
    assert.equal(touch.adId, 'ad-wa-888')

    // En cambio, una sesión cuyo fbc nació con la sesión (mismo click) sí es paid.
    const freshCreationMs = Date.parse(T3)
    await insertWebSession({ contactId, startedAt: T3, fbc: `fb.1.${freshCreationMs}.fbclid-fresco` })
    const freshTouch = await findLastPaidTouch({ contactId })
    assert.equal(freshTouch.type, 'web')
  } finally {
    await cleanupContact(contactId)
  }
})

test('snapshot write-once: un re-disparo del trigger no sobreescribe la atribución original', async () => {
  const contactId = 'contact_attr_write_once'
  const phone = '+525599000009'
  const paymentId = `payment_attr_wo_${uniqueSuffix()}`

  await withPurchaseScenario({
    contactId,
    callback: async () => {
      await insertContact({ contactId, phone, email: 'attr-wo@example.test' })
      await insertWebSession({ contactId, startedAt: T1, fbclid: 'fbclid-wo', adId: 'ad-web-wo' })
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T2 })
      await insertPayment({ paymentId, contactId, amount: 100 })

      await triggerMetaPaymentPurchaseEvent(contactId, { id: paymentId, amount: 100, status: 'paid' })
      const first = await getPaymentSnapshot(paymentId)
      assert.equal(first.attribution_ad_id, 'ad-web-wo')

      // Aparece un touch pagado nuevo DESPUÉS y llega un echo del trigger:
      // el snapshot original no debe cambiar.
      await insertWhatsappMessage({ contactId, phone, messageTimestamp: T3, ctwaClid: 'ctwa-wo-later', sourceId: 'ad-wa-later' })
      await triggerMetaPaymentPurchaseEvent(contactId, { id: paymentId, amount: 100, status: 'paid' })
      const second = await getPaymentSnapshot(paymentId)
      assert.equal(second.attribution_ad_id, 'ad-web-wo')
      assert.equal(second.attribution_channel, first.attribution_channel)
      assert.equal(second.conversion_surface, first.conversion_surface)
    }
  })
})

test('findLastPaidTouch: un touch orgánico posterior no roba el crédito del paid anterior', async () => {
  const contactId = 'contact_attr_unit_last_paid'
  try {
    await cleanupContact(contactId)
    await insertContact({ contactId, phone: '+525599000007', email: 'attr-unit@example.test' })
    // Paid web touch en T1, visita orgánica en T2 y DM orgánico en T3.
    await insertWebSession({ contactId, startedAt: T1, fbclid: 'fbclid-unit', adId: 'ad-unit-1' })
    await insertWebSession({ contactId, startedAt: T2, fbp: 'fb.1.888.999' })
    await insertWhatsappMessage({ contactId, phone: '+525599000007', messageTimestamp: T3 })

    const touch = await findLastPaidTouch({ contactId })
    assert.ok(touch)
    assert.equal(touch.type, 'web')
    assert.equal(touch.adId, 'ad-unit-1')

    const surface = await detectConversionSurface({ contactId })
    assert.equal(surface, 'whatsapp')

    const resolution = await resolveConversionAttribution({ contactId, conversionType: 'purchase' })
    assert.equal(resolution.attributionChannel, 'website')
    assert.equal(resolution.attributionSource, 'paid_ad')
    assert.equal(resolution.conversionSurface, 'whatsapp')
    assert.equal(resolution.metaActionSource, 'business_messaging')
    assert.equal(resolution.metaMessagingChannel, 'whatsapp')
  } finally {
    await cleanupContact(contactId)
  }
})
