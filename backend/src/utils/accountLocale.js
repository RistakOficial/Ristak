import { getAppConfig, setAppConfig } from '../config/database.js'
import { getAccountTimezone } from './dateUtils.js'
import { normalizePhoneForStorage } from './phoneUtils.js'

export const ACCOUNT_COUNTRY_CONFIG_KEY = 'account_country'
export const ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency'
export const ACCOUNT_DIAL_CODE_CONFIG_KEY = 'account_default_dial_code'

export const DEFAULT_ACCOUNT_LOCALE = {
  countryCode: 'MX',
  currency: 'MXN',
  dialCode: '52'
}

export const COUNTRY_OPTIONS = [
  { value: 'MX', label: 'México', currency: 'MXN', dialCode: '52', timezones: ['America/Mexico_City', 'America/Ciudad_Juarez', 'America/Monterrey', 'America/Tijuana'] },
  { value: 'US', label: 'Estados Unidos', currency: 'USD', dialCode: '1', timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  { value: 'CA', label: 'Canadá', currency: 'CAD', dialCode: '1', timezones: ['America/Toronto', 'America/Vancouver'] },
  { value: 'ES', label: 'España', currency: 'EUR', dialCode: '34', timezones: ['Europe/Madrid'] },
  { value: 'AR', label: 'Argentina', currency: 'ARS', dialCode: '54', timezones: ['America/Argentina/Buenos_Aires'] },
  { value: 'BO', label: 'Bolivia', currency: 'BOB', dialCode: '591', timezones: ['America/La_Paz'] },
  { value: 'BR', label: 'Brasil', currency: 'BRL', dialCode: '55', timezones: ['America/Sao_Paulo'] },
  { value: 'BZ', label: 'Belice', currency: 'BZD', dialCode: '501', timezones: ['America/Belize'] },
  { value: 'CL', label: 'Chile', currency: 'CLP', dialCode: '56', timezones: ['America/Santiago'] },
  { value: 'CO', label: 'Colombia', currency: 'COP', dialCode: '57', timezones: ['America/Bogota'] },
  { value: 'CR', label: 'Costa Rica', currency: 'CRC', dialCode: '506', timezones: ['America/Costa_Rica'] },
  { value: 'DO', label: 'República Dominicana', currency: 'DOP', dialCode: '1', timezones: ['America/Santo_Domingo'] },
  { value: 'EC', label: 'Ecuador', currency: 'USD', dialCode: '593', timezones: ['America/Guayaquil'] },
  { value: 'GT', label: 'Guatemala', currency: 'GTQ', dialCode: '502', timezones: ['America/Guatemala'] },
  { value: 'HN', label: 'Honduras', currency: 'HNL', dialCode: '504', timezones: ['America/Tegucigalpa'] },
  { value: 'NI', label: 'Nicaragua', currency: 'NIO', dialCode: '505', timezones: ['America/Managua'] },
  { value: 'PA', label: 'Panamá', currency: 'PAB', dialCode: '507', timezones: ['America/Panama'] },
  { value: 'PE', label: 'Perú', currency: 'PEN', dialCode: '51', timezones: ['America/Lima'] },
  { value: 'PR', label: 'Puerto Rico', currency: 'USD', dialCode: '1', timezones: ['America/Puerto_Rico'] },
  { value: 'PY', label: 'Paraguay', currency: 'PYG', dialCode: '595', timezones: ['America/Asuncion'] },
  { value: 'SV', label: 'El Salvador', currency: 'USD', dialCode: '503', timezones: ['America/El_Salvador'] },
  { value: 'UY', label: 'Uruguay', currency: 'UYU', dialCode: '598', timezones: ['America/Montevideo'] },
  { value: 'VE', label: 'Venezuela', currency: 'VES', dialCode: '58', timezones: ['America/Caracas'] },
  { value: 'GB', label: 'Reino Unido', currency: 'GBP', dialCode: '44', timezones: ['Europe/London'] },
  { value: 'FR', label: 'Francia', currency: 'EUR', dialCode: '33', timezones: ['Europe/Paris'] },
  { value: 'DE', label: 'Alemania', currency: 'EUR', dialCode: '49', timezones: ['Europe/Berlin'] },
  { value: 'IT', label: 'Italia', currency: 'EUR', dialCode: '39', timezones: ['Europe/Rome'] },
  { value: 'PT', label: 'Portugal', currency: 'EUR', dialCode: '351', timezones: ['Europe/Lisbon'] }
]

const COUNTRY_DEFAULTS = COUNTRY_OPTIONS.reduce((defaults, country) => {
  defaults[country.value] = {
    currency: country.currency,
    dialCode: country.dialCode,
    timezones: country.timezones || []
  }
  return defaults
}, {})

const TIMEZONE_COUNTRY_FALLBACKS = Object.entries(COUNTRY_DEFAULTS).reduce((fallbacks, [countryCode, defaults]) => {
  for (const timezone of defaults.timezones || []) {
    fallbacks[timezone] = countryCode
  }
  return fallbacks
}, {})

function normalizeCountryCode(value) {
  const countryCode = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(countryCode) ? countryCode : ''
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : ''
}

function normalizeDialCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 4)
}

function getDefaultsForCountry(countryCode) {
  return COUNTRY_DEFAULTS[countryCode] || DEFAULT_ACCOUNT_LOCALE
}

export function resolveAccountLocaleInput(input = {}) {
  const requestedCountryCode = normalizeCountryCode(
    input.countryCode ||
    input.country_code ||
    input.country ||
    input.pais
  )
  const countryCode = COUNTRY_DEFAULTS[requestedCountryCode]
    ? requestedCountryCode
    : DEFAULT_ACCOUNT_LOCALE.countryCode
  const countryDefaults = getDefaultsForCountry(countryCode)
  const currency = normalizeCurrency(input.currency || input.currencyCode || input.currency_code)
  const dialCode = normalizeDialCode(
    input.dialCode ||
    input.dial_code ||
    input.defaultDialCode ||
    input.default_dial_code ||
    input.phoneDialCode ||
    input.phone_dial_code
  )

  return {
    countryCode,
    currency: currency || countryDefaults.currency || DEFAULT_ACCOUNT_LOCALE.currency,
    dialCode: dialCode || countryDefaults.dialCode || DEFAULT_ACCOUNT_LOCALE.dialCode
  }
}

export async function saveAccountLocaleSettings(input = {}) {
  const locale = resolveAccountLocaleInput(input)

  await Promise.all([
    setAppConfig(ACCOUNT_COUNTRY_CONFIG_KEY, locale.countryCode),
    setAppConfig(ACCOUNT_CURRENCY_CONFIG_KEY, locale.currency),
    setAppConfig(ACCOUNT_DIAL_CODE_CONFIG_KEY, locale.dialCode)
  ])

  return locale
}

export function getCountryDefaults(countryCode) {
  return COUNTRY_OPTIONS.find(country => country.value === normalizeCountryCode(countryCode)) || COUNTRY_OPTIONS[0]
}

export function getCountryFlagEmoji(countryCode) {
  const country = normalizeCountryCode(countryCode)
  if (!country) return '🌐'
  return [...country].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('')
}

export function getPhoneCountryOptions() {
  return COUNTRY_OPTIONS.map(country => ({
    ...country,
    flag: getCountryFlagEmoji(country.value)
  }))
}

async function getCountryFromTimezone() {
  try {
    const timezone = await getAccountTimezone()
    return TIMEZONE_COUNTRY_FALLBACKS[timezone] || ''
  } catch {
    return ''
  }
}

export async function getAccountLocaleSettings() {
  const storedCountry = normalizeCountryCode(await getAppConfig(ACCOUNT_COUNTRY_CONFIG_KEY))
  const fallbackCountry = storedCountry || await getCountryFromTimezone() || DEFAULT_ACCOUNT_LOCALE.countryCode
  const countryDefaults = getDefaultsForCountry(fallbackCountry)
  const storedCurrency = normalizeCurrency(await getAppConfig(ACCOUNT_CURRENCY_CONFIG_KEY))
  const storedDialCode = normalizeDialCode(await getAppConfig(ACCOUNT_DIAL_CODE_CONFIG_KEY))

  return {
    countryCode: fallbackCountry,
    currency: storedCurrency || countryDefaults.currency || DEFAULT_ACCOUNT_LOCALE.currency,
    dialCode: storedDialCode || countryDefaults.dialCode || DEFAULT_ACCOUNT_LOCALE.dialCode
  }
}

export async function getAccountCurrency() {
  const settings = await getAccountLocaleSettings()
  return settings.currency
}

export async function normalizePhoneForAccount(value) {
  const settings = await getAccountLocaleSettings()
  return normalizePhoneForStorage(value, { defaultCountryCode: settings.dialCode })
}
