export const ACCOUNT_COUNTRY_CONFIG_KEY = 'account_country'
export const ACCOUNT_CURRENCY_CONFIG_KEY = 'account_currency'
export const ACCOUNT_DIAL_CODE_CONFIG_KEY = 'account_default_dial_code'

export interface CountryOption {
  value: string
  label: string
  dialCode: string
  currency: string
  timezones?: string[]
}

export interface AccountLocaleDefaults {
  countryCode: string
  currency: string
  dialCode: string
}

export const COUNTRY_OPTIONS: CountryOption[] = [
  { value: 'MX', label: 'México', dialCode: '52', currency: 'MXN', timezones: ['America/Mexico_City', 'America/Ciudad_Juarez', 'America/Monterrey', 'America/Tijuana'] },
  { value: 'US', label: 'Estados Unidos', dialCode: '1', currency: 'USD', timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  { value: 'CA', label: 'Canadá', dialCode: '1', currency: 'CAD', timezones: ['America/Toronto', 'America/Vancouver'] },
  { value: 'ES', label: 'España', dialCode: '34', currency: 'EUR', timezones: ['Europe/Madrid'] },
  { value: 'AR', label: 'Argentina', dialCode: '54', currency: 'ARS', timezones: ['America/Argentina/Buenos_Aires'] },
  { value: 'BO', label: 'Bolivia', dialCode: '591', currency: 'BOB', timezones: ['America/La_Paz'] },
  { value: 'BR', label: 'Brasil', dialCode: '55', currency: 'BRL', timezones: ['America/Sao_Paulo'] },
  { value: 'BZ', label: 'Belice', dialCode: '501', currency: 'BZD', timezones: ['America/Belize'] },
  { value: 'CL', label: 'Chile', dialCode: '56', currency: 'CLP', timezones: ['America/Santiago'] },
  { value: 'CO', label: 'Colombia', dialCode: '57', currency: 'COP', timezones: ['America/Bogota'] },
  { value: 'CR', label: 'Costa Rica', dialCode: '506', currency: 'CRC', timezones: ['America/Costa_Rica'] },
  { value: 'DO', label: 'República Dominicana', dialCode: '1', currency: 'DOP', timezones: ['America/Santo_Domingo'] },
  { value: 'EC', label: 'Ecuador', dialCode: '593', currency: 'USD', timezones: ['America/Guayaquil'] },
  { value: 'GT', label: 'Guatemala', dialCode: '502', currency: 'GTQ', timezones: ['America/Guatemala'] },
  { value: 'HN', label: 'Honduras', dialCode: '504', currency: 'HNL', timezones: ['America/Tegucigalpa'] },
  { value: 'NI', label: 'Nicaragua', dialCode: '505', currency: 'NIO', timezones: ['America/Managua'] },
  { value: 'PA', label: 'Panamá', dialCode: '507', currency: 'PAB', timezones: ['America/Panama'] },
  { value: 'PE', label: 'Perú', dialCode: '51', currency: 'PEN', timezones: ['America/Lima'] },
  { value: 'PR', label: 'Puerto Rico', dialCode: '1', currency: 'USD', timezones: ['America/Puerto_Rico'] },
  { value: 'PY', label: 'Paraguay', dialCode: '595', currency: 'PYG', timezones: ['America/Asuncion'] },
  { value: 'SV', label: 'El Salvador', dialCode: '503', currency: 'USD', timezones: ['America/El_Salvador'] },
  { value: 'UY', label: 'Uruguay', dialCode: '598', currency: 'UYU', timezones: ['America/Montevideo'] },
  { value: 'VE', label: 'Venezuela', dialCode: '58', currency: 'VES', timezones: ['America/Caracas'] },
  { value: 'GB', label: 'Reino Unido', dialCode: '44', currency: 'GBP', timezones: ['Europe/London'] },
  { value: 'FR', label: 'Francia', dialCode: '33', currency: 'EUR', timezones: ['Europe/Paris'] },
  { value: 'DE', label: 'Alemania', dialCode: '49', currency: 'EUR', timezones: ['Europe/Berlin'] },
  { value: 'IT', label: 'Italia', dialCode: '39', currency: 'EUR', timezones: ['Europe/Rome'] },
  { value: 'PT', label: 'Portugal', dialCode: '351', currency: 'EUR', timezones: ['Europe/Lisbon'] }
]

export const CURRENCY_OPTIONS = [
  { value: 'MXN', label: 'MXN - Peso mexicano' },
  { value: 'USD', label: 'USD - Dólar estadounidense' },
  { value: 'CAD', label: 'CAD - Dólar canadiense' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - Libra esterlina' },
  { value: 'ARS', label: 'ARS - Peso argentino' },
  { value: 'BOB', label: 'BOB - Boliviano' },
  { value: 'BRL', label: 'BRL - Real brasileño' },
  { value: 'BZD', label: 'BZD - Dólar beliceño' },
  { value: 'CLP', label: 'CLP - Peso chileno' },
  { value: 'COP', label: 'COP - Peso colombiano' },
  { value: 'CRC', label: 'CRC - Colón costarricense' },
  { value: 'DOP', label: 'DOP - Peso dominicano' },
  { value: 'GTQ', label: 'GTQ - Quetzal' },
  { value: 'HNL', label: 'HNL - Lempira' },
  { value: 'NIO', label: 'NIO - Córdoba' },
  { value: 'PAB', label: 'PAB - Balboa' },
  { value: 'PEN', label: 'PEN - Sol peruano' },
  { value: 'PYG', label: 'PYG - Guaraní' },
  { value: 'UYU', label: 'UYU - Peso uruguayo' },
  { value: 'VES', label: 'VES - Bolívar' }
]

export function normalizeCurrencyCode(value?: string | null, fallback = 'MXN') {
  const normalized = String(value || '').trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(normalized)) return normalized

  const fallbackNormalized = String(fallback || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(fallbackNormalized) ? fallbackNormalized : 'MXN'
}

export function getCurrencyOptionLabel(value?: string | null) {
  const currency = normalizeCurrencyCode(value)
  return CURRENCY_OPTIONS.find((option) => option.value === currency)?.label || currency
}

const DEFAULT_COUNTRY = COUNTRY_OPTIONS[0]

function getCountryFromLocale() {
  if (typeof navigator === 'undefined') return ''

  const locales = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const locale of locales) {
    try {
      const parsed = new Intl.Locale(locale)
      if (parsed.region) return parsed.region.toUpperCase()
    } catch {
      const match = String(locale || '').match(/[-_]([A-Za-z]{2})\b/)
      if (match?.[1]) return match[1].toUpperCase()
    }
  }

  return ''
}

function getCountryFromTimezone() {
  if (typeof Intl === 'undefined') return ''
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return COUNTRY_OPTIONS.find((country) => country.timezones?.includes(timezone))?.value || ''
}

export function getCountryDefaults(countryCode?: string | null) {
  return COUNTRY_OPTIONS.find((country) => country.value === String(countryCode || '').toUpperCase()) || DEFAULT_COUNTRY
}

export function getCountryFlagEmoji(countryCode?: string | null) {
  const code = String(countryCode || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return '🌐'
  return Array.from(code).map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('')
}

export function getPhoneCountryOptions() {
  return COUNTRY_OPTIONS.map((country) => {
    const flag = getCountryFlagEmoji(country.value)
    return {
      ...country,
      countryLabel: country.label,
      label: `${flag} +${country.dialCode}`,
      flag
    }
  })
}

export function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function stripInternationalPrefix(digits = '') {
  return digits.startsWith('00') ? digits.slice(2) : digits
}

function normalizeMexicoPhoneDigits(digits = '') {
  const national = digits.slice(-10)
  if (national.length !== 10) return ''
  if (digits.startsWith('521') && digits.length >= 13) return `52${national}`
  if (digits.startsWith('52') && digits.length >= 12) return `52${national}`
  return ''
}

export function composePhoneWithDialCode(value = '', dialCode = '52') {
  const raw = String(value || '').trim()
  const digits = stripInternationalPrefix(normalizePhoneDigits(raw))
  const countryCode = normalizePhoneDigits(dialCode).slice(0, 4)

  if (digits.length < 7) return ''
  if (!countryCode) return raw.startsWith('+') ? `+${digits}` : `+${digits}`

  const mexicoPhone = countryCode === '52' ? normalizeMexicoPhoneDigits(digits) : ''
  if (mexicoPhone) return `+${mexicoPhone}`
  if (raw.startsWith('+') || raw.startsWith('00')) return `+${digits}`
  if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) return `+${digits}`
  return `+${countryCode}${digits}`
}

export function getPhoneInputParts(value?: string | null, fallbackCountryCode?: string | null) {
  const raw = String(value || '').trim()
  const digits = stripInternationalPrefix(normalizePhoneDigits(raw))
  const detectedDefaults = getCountryDefaults(fallbackCountryCode || getDetectedAccountLocaleDefaults().countryCode)

  if (!digits) {
    return { countryCode: detectedDefaults.value, nationalNumber: '' }
  }

  const mexicoPhone = normalizeMexicoPhoneDigits(digits)
  if (mexicoPhone) {
    return { countryCode: 'MX', nationalNumber: mexicoPhone.slice(2) }
  }

  const sortedCountries = [...COUNTRY_OPTIONS].sort((left, right) => right.dialCode.length - left.dialCode.length)
  const country = sortedCountries.find((item) => digits.startsWith(item.dialCode) && digits.length > item.dialCode.length + 5)
  if (country) {
    return { countryCode: country.value, nationalNumber: digits.slice(country.dialCode.length) }
  }

  return { countryCode: detectedDefaults.value, nationalNumber: raw }
}

export function getDetectedAccountLocaleDefaults() {
  const countryCode = getCountryFromTimezone() || getCountryFromLocale() || DEFAULT_COUNTRY.value
  const country = getCountryDefaults(countryCode)

  return {
    countryCode: country.value,
    currency: country.currency,
    dialCode: country.dialCode
  }
}
