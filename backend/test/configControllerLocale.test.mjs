import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { applyResolvedAccountLocaleConfig } from '../src/controllers/configController.js'
import { setTimezone } from '../src/controllers/settingsController.js'

function mockResponse() {
  return {
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
}

test('api config publica el locale efectivo resuelto sin inventar defaults en el cliente', () => {
  const locale = { countryCode: 'US', currency: 'USD', dialCode: '1', timezone: 'America/Chicago' }

  assert.deepEqual(
    applyResolvedAccountLocaleConfig({ account_currency: null }, locale, ['account_currency']),
    { account_currency: 'USD' }
  )
  assert.deepEqual(
    applyResolvedAccountLocaleConfig({ theme: 'dark' }, locale),
    {
      theme: 'dark',
      account_country: 'US',
      account_currency: 'USD',
      account_default_dial_code: '1',
      account_timezone: 'America/Chicago'
    }
  )
})

test('limpiar la zona conserva y reutiliza el sentinel que serializa commits de citas', async () => {
  await db.run('DELETE FROM app_config WHERE config_key = ?', ['account_timezone'])

  const cleared = mockResponse()
  await setTimezone({ body: { timezone: null } }, cleared)
  assert.equal(cleared.statusCode, 200)
  assert.equal(cleared.payload?.success, true)
  const sentinel = await db.get(
    'SELECT id, config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  assert.ok(sentinel?.id)
  assert.equal(sentinel.config_value, null)

  const configured = mockResponse()
  await setTimezone({ body: { timezone: 'UTC' } }, configured)
  assert.equal(configured.statusCode, 200)
  assert.equal(configured.payload?.timezone, 'UTC')
  const reused = await db.get(
    'SELECT id, config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  assert.equal(reused.id, sentinel.id)
  assert.equal(reused.config_value, 'UTC')

  const reset = mockResponse()
  await setTimezone({ body: { timezone: null } }, reset)
  assert.equal(reset.statusCode, 200)
  const finalSentinel = await db.get(
    'SELECT id, config_value FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  assert.equal(finalSentinel.id, sentinel.id)
  assert.equal(finalSentinel.config_value, null)
})
