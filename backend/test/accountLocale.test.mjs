import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  COUNTRY_OPTIONS,
  resolveAccountLocaleInput
} from '../src/utils/accountLocale.js'

describe('account locale defaults', () => {
  it('uses the selected country defaults for currency and dial code', () => {
    assert.deepEqual(
      resolveAccountLocaleInput({ countryCode: 'CO' }),
      { countryCode: 'CO', currency: 'COP', dialCode: '57' }
    )
  })

  it('normalizes custom currency and dial code when provided', () => {
    assert.deepEqual(
      resolveAccountLocaleInput({ countryCode: 'mx', currency: 'usd', dialCode: '+1' }),
      { countryCode: 'MX', currency: 'USD', dialCode: '1' }
    )
  })

  it('falls back to Mexico defaults for invalid locale input', () => {
    assert.deepEqual(
      resolveAccountLocaleInput({ countryCode: 'XX', currency: 'peso', dialCode: 'abc' }),
      { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
    )
  })

  it('keeps Spanish country labels correctly accented', () => {
    const labels = Object.fromEntries(COUNTRY_OPTIONS.map((country) => [country.value, country.label]))

    assert.equal(labels.MX, 'México')
    assert.equal(labels.CA, 'Canadá')
    assert.equal(labels.ES, 'España')
    assert.equal(labels.DO, 'República Dominicana')
    assert.equal(labels.PA, 'Panamá')
    assert.equal(labels.PE, 'Perú')
  })
})
