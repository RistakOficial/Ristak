import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  COUNTRY_OPTIONS,
  getCountryFlagEmoji,
  getPhoneCountryOptions
} from '../src/utils/accountLocale.js'

const repoFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('phone country options expose only flag and international code as their visible label', () => {
  const phoneOptions = getPhoneCountryOptions()

  assert.equal(phoneOptions.length, COUNTRY_OPTIONS.length)
  for (const option of phoneOptions) {
    assert.equal(option.countryLabel, COUNTRY_OPTIONS.find(country => country.value === option.value)?.label)
    assert.equal(option.label, `${getCountryFlagEmoji(option.value)} +${option.dialCode}`)
    assert.equal(option.label.includes(option.countryLabel), false)
  }
})

test('all known phone region selectors consume the shared compact presentation contract', async () => {
  const [contactsSource, sitesFrontendSource, sitesBackendSource, calendarBackendSource] = await Promise.all([
    repoFile('frontend/src/pages/Contacts/Contacts.tsx'),
    repoFile('frontend/src/pages/Sites/Sites.tsx'),
    repoFile('backend/src/services/sitesService.js'),
    repoFile('backend/src/services/localCalendarService.js')
  ])

  assert.match(contactsSource, /<PhoneCountryCodeSelect/)
  assert.doesNotMatch(contactsSource, /\+\{option\.dialCode\}\s+\{option\.label\}/)
  assert.match(sitesFrontendSource, /getPhoneCountryOptions\(\)\.map/)
  assert.match(sitesBackendSource, /return getPhoneCountryOptions\(\)\.map/)
  assert.match(calendarBackendSource, /return getPhoneCountryOptions\(\)\.map/)
})
