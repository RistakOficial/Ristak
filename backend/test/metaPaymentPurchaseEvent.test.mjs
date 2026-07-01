import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import {
  buildMetaPublicPurchasePixelEvent,
  triggerMetaPaymentPurchaseEvent,
  triggerMetaPurchaseEventForPaymentRow
} from '../src/services/metaConversionEventsService.js'
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
    encrypt('legacy-pixel-api-token'),
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
          `INSERT INTO contacts (id, email, full_name, phone, source, custom_fields, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [
            contactId,
            'buyer@example.test',
            'Buyer Demo',
            '+525512345678',
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
            ad_account_id, access_token, pixel_id, pixel_api_token,
            page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          '123456',
          encrypt('meta-access-token'),
          'pixel-payment-123',
          encrypt('legacy-pixel-api-token'),
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
          eventSourceUrl: 'https://checkout.example.test/pay/payment_meta_purchase_1?email=buyer@example.test&phone=525512345678&fbclid=fb.123'
        })

        assert.equal(result.sent, true)
        assert.equal(metaCalls.length, 1)
        assert.match(decodeURIComponent(metaCalls[0].url), /access_token=meta-access-token/)
        assert.doesNotMatch(decodeURIComponent(metaCalls[0].url), /legacy-pixel-api-token/)

        const payload = JSON.parse(metaCalls[0].body)
        assert.equal(payload.data[0].event_name, 'Purchase')
        assert.equal(payload.data[0].action_source, 'website')
        assert.equal(payload.data[0].event_source_url, 'https://checkout.example.test/pay/payment_meta_purchase_1?fbclid=fb.123')
        assert.equal(payload.data[0].event_id, `purchase_contact_${contactId}`)
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
        assert.equal(payload.data[0].event_id, `purchase_contact_${contactId}`)
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

        const firstResult = await triggerMetaPaymentPurchaseEvent(contactId, {
          id: 'payment_meta_plan_1',
          amount: 300,
          status: 'paid',
          payment_provider: 'stripe',
          payment_method: 'stripe',
          metadata_json: JSON.stringify({
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
        assert.equal(payload.data[0].event_name, 'Purchase')
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
        assert.equal(event.eventId, `purchase_contact_${contactId}`)
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

test('public payment pixel event is skipped for smart WhatsApp-attributed payments', async () => {
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

        assert.equal(event, null)
      })
    })
  } finally {
    await deletePaymentMetaTestContact(contactId)
  }
})
