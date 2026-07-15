import test from 'node:test'
import assert from 'node:assert/strict'
import GHLClient from '../src/services/ghlClient.js'

import {
  clearHighLevelPhoneNumberCacheForTests,
  getHighLevelPhoneNumbers,
  isHighLevelPhoneInventoryUnavailable,
  normalizeHighLevelActivePhoneNumbers
} from '../src/services/highlevelPhoneNumbersService.js'

test('consulta el inventario con el header Version documentado por HighLevel', async () => {
  let requestUrl = ''
  let requestHeaders = {}
  const client = new GHLClient('token-test', 'location-test', {
    fetchImpl: async (url, options) => {
      requestUrl = String(url)
      requestHeaders = options.headers
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ phoneNumbers: [] })
      }
    }
  })

  await client.listActivePhoneNumbers()

  assert.match(requestUrl, /\/phone-system\/numbers\/location\/location-test/)
  assert.match(requestUrl, /pageSize=1000/)
  assert.equal(requestHeaders.Version, '2021-07-28')
})

test('normaliza números SMS activos de respuestas HighLevel v3 y elimina duplicados', () => {
  const result = normalizeHighLevelActivePhoneNumbers({
    data: {
      numbers: [
        { id: 'one', phoneNumber: '+1 (915) 555-0100', friendlyName: 'Ventas', capabilities: { sms: true } },
        { id: 'duplicate', number: '+19155550100', label: 'Duplicado', smsEnabled: true },
        { id: 'voice-only', number: '+19155550101', capabilities: { sms: false, voice: true } },
        { id: 'voice-array-only', number: '+19155550103', capabilities: ['VOICE'] },
        { id: 'unknown-capability', number: '+19155550102', name: 'Soporte', isDefault: true }
      ]
    }
  })

  assert.deepEqual(result, [
    { id: 'one', phoneNumber: '+19155550100', label: 'Ventas', isDefault: false },
    { id: 'unknown-capability', phoneNumber: '+19155550102', label: 'Soporte', isDefault: true }
  ])
})

test('cachea el catálogo por location para no martillar HighLevel al abrir chats', async () => {
  clearHighLevelPhoneNumberCacheForTests()
  let calls = 0
  const client = {
    locationId: 'location-cache-test',
    async listActivePhoneNumbers() {
      calls += 1
      return { phoneNumbers: [{ id: 'sender', number: '+526561112233', label: 'Principal' }] }
    }
  }

  const first = await getHighLevelPhoneNumbers({ client, now: 1000 })
  const second = await getHighLevelPhoneNumbers({ client, now: 2000 })

  assert.equal(calls, 1)
  assert.deepEqual(second, first)
})

test('clasifica falta de scope/inventario como fallback seguro', () => {
  assert.equal(isHighLevelPhoneInventoryUnavailable({ status: 403 }), true)
  assert.equal(isHighLevelPhoneInventoryUnavailable({ statusCode: 404 }), true)
  assert.equal(isHighLevelPhoneInventoryUnavailable({ status: 503 }), false)
})
