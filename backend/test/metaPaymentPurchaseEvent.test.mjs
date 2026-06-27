import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { triggerMetaPaymentPurchaseEvent } from '../src/services/metaConversionEventsService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

const APP_CONFIG_KEYS = [
  'account_country',
  'account_currency',
  'account_default_dial_code',
  'meta_payment_purchase_event_config',
  'meta_test_event_code'
]

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
      ad_account_id, access_token, pixel_id, pixel_api_token,
      page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    '123456',
    encrypt('meta-access-token'),
    pixelId,
    encrypt('pixel-api-token'),
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
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('payment Purchase CAPI event uses real payment amount and account currency', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const contactId = 'contact_meta_purchase_currency'
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(APP_CONFIG_KEYS, async () => {
        await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId])
        await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
        await db.run(
          `INSERT INTO contacts (id, email, full_name, phone, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [contactId, 'buyer@example.test', 'Buyer Demo', '+525512345678', 'test']
        )

        await db.run(`
          INSERT INTO meta_config (
            ad_account_id, access_token, pixel_id, pixel_api_token,
            page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          '123456',
          encrypt('meta-access-token'),
          'pixel-payment-123',
          encrypt('pixel-api-token'),
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
            res.end(JSON.stringify({ events_received: 1 }))
          })
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        const result = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_purchase_1',
          amount: 123.45,
          currency: 'MXN',
          status: 'paid',
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_purchase_1'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].event_source_url, 'https://checkout.example.test/pay/payment_meta_purchase_1')
        assert.equal(payload.data[0].event_id, `purchase_contact_${contactId}`)
        assert.equal(payload.data[0].custom_data.value, 123.45)
        assert.equal(payload.data[0].custom_data.currency, 'USD')
        assert.equal(payload.data[0].custom_data.checkout_source, 'public_payment')
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_1')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.match(payload.data[0].user_data.em, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM meta_conversion_event_logs WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('payment smart default sends WhatsApp Business Messaging data when attribution exists', async () => {
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

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'LeadSubmitted')
        assert.equal(payload.data[0].action_source, 'business_messaging')
        assert.equal(payload.data[0].messaging_channel, 'whatsapp')
        assert.equal(payload.data[0].event_id, `purchase_contact_${contactId}`)
        assert.equal(payload.data[0].user_data.ctwa_clid, 'ctwa-smart-payment-123')
        assert.equal(payload.data[0].user_data.page_id, 'page-smart-123')
        assert.equal(payload.data[0].custom_data.value, 777.5)
        assert.equal(payload.data[0].custom_data.currency, 'MXN')
        assert.equal(payload.data[0].custom_data.predicted_ltv, 5400)
        assert.equal(payload.data[0].custom_data.payment_id, 'payment_meta_purchase_smart_wa')
        assert.equal(payload.data[0].custom_data.payment_status, 'paid')
        assert.equal(payload.data[0].custom_data.checkout_source, 'smart_default')
        assert.equal(payload.data[0].custom_data.ad_id, 'ad-smart-77')
        assert.equal(payload.data[0].custom_data.ad_name, 'Smart payment ad')
        assert.equal(payload.data[0].custom_data.referral_source_type, 'ad')
        assert.equal(payload.data[0].custom_data.referral_source_url, 'https://fb.example.test/ad/77')
        assert.equal(payload.data[0].custom_data.attribution_source, 'legacy')
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await deletePaymentMetaTestContact(contactId)
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
        assert.equal(payload.data[0].event_id, `purchase_contact_${contactId}`)
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
