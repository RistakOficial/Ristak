import test from 'node:test'
import assert from 'node:assert/strict'
import { applyResolvedAccountLocaleConfig } from '../src/controllers/configController.js'

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
