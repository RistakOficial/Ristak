import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { sendMetaTestEvent } from '../src/controllers/metaController.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'

function createResponse() {
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
  return response
}

test('sendMetaTestEvent posts CAPI payload with test_event_code', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()
    await db.run('DELETE FROM meta_config')
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_test_event_code'])
    await db.run(`
      INSERT INTO meta_config (
        ad_account_id, access_token, pixel_id,
        page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      '123456',
      encrypt('meta-access-token'),
      'pixel-test-123',
      null,
      null,
      null,
      null,
      null
    ])
    await setAppConfig('meta_test_event_code', 'TEST98765')

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

    const response = createResponse()
    await sendMetaTestEvent({
      body: {
        testEventCode: ' TEST98765 ',
        eventName: 'Purchase',
        eventSourceUrl: 'https://app.test/settings/meta-ads',
        eventParameters: {
          value: '2,500',
          predictedLtv: '12000',
          currency: 'mxn',
          contentIds: 'SKU-001, SKU-002',
          contentType: 'product',
          numItems: '2',
          orderId: 'ORD-TEST-001',
          custom: [
            {
              key: 'ad_source',
              value: 'test'
            }
          ]
        }
      },
      headers: {
        host: 'app.test',
        'user-agent': 'node-test',
        'x-forwarded-for': '203.0.113.10'
      },
      protocol: 'https',
      get: (name) => name === 'host' ? 'app.test' : '',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.success, true)
    assert.equal(response.payload.eventName, 'Purchase')
    assert.match(response.payload.eventId, /^ristak_meta_test_/)
    assert.equal(metaCalls.length, 1)
    assert.match(decodeURIComponent(metaCalls[0].url), /access_token=meta-access-token/)

    const payload = JSON.parse(metaCalls[0].body)
    assert.equal(payload.test_event_code, 'TEST98765')
    assert.equal(payload.data[0].event_name, 'Purchase')
    assert.equal(payload.data[0].event_source_url, 'https://app.test/settings/meta-ads')
    assert.equal(payload.data[0].custom_data.value, 2500)
    assert.equal(payload.data[0].custom_data.currency, 'MXN')
    assert.deepEqual(payload.data[0].custom_data.content_ids, ['SKU-001', 'SKU-002'])
    assert.equal(payload.data[0].custom_data.num_items, 2)
    assert.equal(payload.data[0].custom_data.order_id, 'ORD-TEST-001')
    assert.equal(payload.data[0].custom_data.content_type, 'product')
    assert.equal(payload.data[0].custom_data.ad_source, 'test')
    assert.match(payload.data[0].user_data.client_ip_address, /^203\.0\.113\.10\.[A-Za-z0-9]{8}$/)
    assert.equal(payload.data[0].user_data.client_user_agent, 'node-test')
    assert.match(payload.data[0].user_data.external_id, /^[a-f0-9]{64}\.[A-Za-z0-9]{8}$/)
    assert.match(payload.data[0].user_data.fbp, /^fb\.\d+\.\d+\.\d+\.[A-Za-z0-9]{8}$/)
    assert.equal(payload.data[0].custom_data.conversion_type, 'settings_test_event')
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM meta_config').catch(() => undefined)
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_test_event_code']).catch(() => undefined)
  }
})

test('sendMetaTestEvent posts WhatsApp LeadSubmitted as business_messaging', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const metaCalls = []
  let metaServer

  try {
    await initializeMasterKey()
    await db.run('DELETE FROM meta_config')
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_test_event_code'])
    await db.run(`
      INSERT INTO meta_config (
        ad_account_id, access_token, pixel_id,
        page_id, instagram_account_id, timezone_id, timezone_name, timezone_offset_hours_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      '123456',
      encrypt('meta-access-token'),
      'pixel-test-123',
      '104840954631643',
      null,
      null,
      null,
      null
    ])

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

    const response = createResponse()
    await sendMetaTestEvent({
      body: {
        testEventCode: 'TEST98765',
        eventName: 'LeadSubmitted',
        eventSourceUrl: 'https://app.test/settings/meta-ads',
        eventParameters: {
          value: '100',
          currency: 'usd',
          ctwaClid: 'AfghPKzHPYknB7A_wzcLuy2YRb0_x89LmCfBkaFRDDqXe2AtJPwqOCkdzUutPbEzk09QAkEtfddmEN7c-P1gLEXv-_4Rv3igOnEPWww4P_cq8cQG'
        }
      },
      headers: {
        host: 'app.test',
        'user-agent': 'node-test',
        'x-forwarded-for': '203.0.113.10'
      },
      protocol: 'https',
      get: (name) => name === 'host' ? 'app.test' : '',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.payload.success, true)
    assert.equal(response.payload.eventName, 'LeadSubmitted')
    assert.equal(metaCalls.length, 1)

    const payload = JSON.parse(metaCalls[0].body)
    assert.equal(payload.test_event_code, 'TEST98765')
    assert.equal(payload.data[0].event_name, 'LeadSubmitted')
    assert.equal(payload.data[0].action_source, 'business_messaging')
    assert.equal(payload.data[0].messaging_channel, 'whatsapp')
    assert.equal(payload.data[0].event_source_url, undefined)
    assert.equal(payload.data[0].user_data.ctwa_clid, 'AfghPKzHPYknB7A_wzcLuy2YRb0_x89LmCfBkaFRDDqXe2AtJPwqOCkdzUutPbEzk09QAkEtfddmEN7c-P1gLEXv-_4Rv3igOnEPWww4P_cq8cQG')
    assert.equal(payload.data[0].user_data.page_id, '104840954631643')
    assert.equal(payload.data[0].custom_data.value, 100)
    assert.equal(payload.data[0].custom_data.currency, 'USD')
    assert.equal(payload.data[0].custom_data.content_name, undefined)
    assert.equal(payload.data[0].custom_data.conversion_type, 'settings_test_event')
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
    await db.run('DELETE FROM meta_config').catch(() => undefined)
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['meta_test_event_code']).catch(() => undefined)
  }
})
