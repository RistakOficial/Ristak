import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { saveMetaConfig } from '../src/services/metaAdsService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

const EVENT_CONFIG_KEYS = [
  'meta_whatsapp_schedule_enabled',
  'meta_whatsapp_purchase_enabled',
  'meta_payment_purchase_event_config'
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

test('saving Meta token with pixel enables calendar and payment conversion events', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(EVENT_CONFIG_KEYS, async () => {
        await setAppConfig('meta_whatsapp_schedule_enabled', '0')
        await setAppConfig('meta_whatsapp_purchase_enabled', '0')
        await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({
          enabled: false,
          channel: 'smart',
          eventName: 'Lead',
          parameters: {
            sendValue: false,
            value: '99',
            predictedLtv: '250',
            custom: [{ id: 'keep-me', key: 'campaign', value: 'retargeting' }]
          }
        }))

        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          'pixel-123',
          'pixel-capi-token'
        )

        assert.equal(await getAppConfig('meta_whatsapp_schedule_enabled'), '1')
        assert.equal(await getAppConfig('meta_whatsapp_purchase_enabled'), '1')

        const paymentConfig = JSON.parse(await getAppConfig('meta_payment_purchase_event_config'))
        assert.equal(paymentConfig.enabled, true)
        assert.equal(paymentConfig.channel, 'smart')
        assert.equal(paymentConfig.eventName, 'Lead')
        assert.equal(paymentConfig.parameters.sendValue, false)
        assert.equal(paymentConfig.parameters.value, '99')
        assert.equal(paymentConfig.parameters.predictedLtv, '250')
        assert.deepEqual(paymentConfig.parameters.custom, [
          { id: 'keep-me', key: 'campaign', value: 'retargeting' }
        ])
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('saving Meta token creates smart payment conversion defaults when none exist', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  let metaServer

  try {
    await initializeMasterKey()

    await snapshotMetaConfig(async () => {
      await snapshotAppConfig(EVENT_CONFIG_KEYS, async () => {
        metaServer = http.createServer((req, res) => {
          if (req.method === 'GET' && req.url.startsWith('/act_123456')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              timezone_id: 90,
              timezone_name: 'America/Mexico_City',
              timezone_offset_hours_utc: -6
            }))
            return
          }

          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unexpected request' } }))
        })
        await new Promise(resolve => metaServer.listen(0, '127.0.0.1', resolve))
        Object.defineProperty(API_URLS, 'META_GRAPH', {
          value: `http://127.0.0.1:${metaServer.address().port}`,
          configurable: true
        })

        await saveMetaConfig(
          '123456',
          'meta-access-token',
          'pixel-123',
          'pixel-capi-token'
        )

        const paymentConfig = JSON.parse(await getAppConfig('meta_payment_purchase_event_config'))
        assert.equal(paymentConfig.enabled, true)
        assert.equal(paymentConfig.channel, 'smart')
        assert.equal(paymentConfig.eventName, 'Purchase')
        assert.equal(paymentConfig.parameters.sendValue, true)
        assert.equal(paymentConfig.parameters.value, '')
        assert.equal(paymentConfig.parameters.predictedLtv, '')
        assert.deepEqual(paymentConfig.parameters.custom, [])
      })
    })
  } finally {
    if (metaServer) await new Promise(resolve => metaServer.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})
