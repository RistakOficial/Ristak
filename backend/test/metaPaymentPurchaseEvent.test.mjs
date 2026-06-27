import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { triggerWhatsappFirstPurchaseEvent } from '../src/services/metaWhatsappEventsService.js'
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

        const result = await triggerWhatsappFirstPurchaseEvent(contactId, {
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
