export function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function stripInternationalPrefix(digits = '') {
  if (digits.startsWith('00')) return digits.slice(2)
  return digits
}

export function getPhoneNationalDigits(value = '') {
  const digits = stripInternationalPrefix(normalizePhoneDigits(value))
  if (digits.length < 7) return ''
  return digits.slice(-10)
}

export function normalizePhoneForStorage(value = '', { defaultCountryCode = '52' } = {}) {
  const digits = stripInternationalPrefix(normalizePhoneDigits(value))
  if (digits.length < 7) return ''

  const national = digits.slice(-10)

  // WhatsApp Mexico can expose mobile JIDs as 521 + 10 digits. Business/contact
  // storage must stay in E.164 for Mexico without that WhatsApp-only carrier digit.
  if (digits.startsWith('521') && digits.length >= 13 && national.length === 10) {
    return `+52${national}`
  }

  if (digits.startsWith('52') && digits.length >= 12 && national.length === 10) {
    return `+52${national}`
  }

  if (digits.length === 10 && defaultCountryCode) {
    return `+${defaultCountryCode}${digits}`
  }

  return `+${digits}`
}

export function buildPhoneMatchCandidates(value = '') {
  const raw = String(value || '').trim()
  const digits = stripInternationalPrefix(normalizePhoneDigits(raw))
  const national = getPhoneNationalDigits(raw)
  const canonical = normalizePhoneForStorage(raw)
  const candidates = new Set()

  for (const candidate of [raw, digits, digits ? `+${digits}` : '', canonical, national]) {
    if (candidate) candidates.add(candidate)
  }

  if (national && national.length === 10) {
    for (const prefix of ['52', '521', '1']) {
      candidates.add(`${prefix}${national}`)
      candidates.add(`+${prefix}${national}`)
    }
  }

  return [...candidates]
}
