export function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D/g, '')
}

function stripInternationalPrefix(digits = '') {
  if (digits.startsWith('00')) return digits.slice(2)
  return digits
}

function normalizeDialCode(value = '') {
  return normalizePhoneDigits(value).slice(0, 4)
}

function normalizeMexicoPhoneDigits(digits = '') {
  const national = digits.slice(-10)
  if (national.length !== 10) return ''

  // WhatsApp Mexico can expose mobile JIDs as 521 + 10 digits. Business/contact
  // storage must stay in E.164 for Mexico without that WhatsApp-only carrier digit.
  if (digits.startsWith('521') && digits.length >= 13) return `52${national}`
  if (digits.startsWith('52') && digits.length >= 12) return `52${national}`
  return ''
}

export function getPhoneNationalDigits(value = '') {
  const digits = stripInternationalPrefix(normalizePhoneDigits(value))
  if (digits.length < 7) return ''
  return digits.slice(-10)
}

export function normalizePhoneForStorage(value = '', { defaultCountryCode = '52' } = {}) {
  const digits = stripInternationalPrefix(normalizePhoneDigits(value))
  if (digits.length < 7) return ''

  const countryCode = normalizeDialCode(defaultCountryCode)
  const mexicoPhone = normalizeMexicoPhoneDigits(digits)

  if (mexicoPhone) return `+${mexicoPhone}`

  if (digits.length === 10 && countryCode) {
    return `+${countryCode}${digits}`
  }

  return `+${digits}`
}

export function composePhoneWithDialCode(value = '', dialCode = '52') {
  const raw = String(value || '').trim()
  const digits = stripInternationalPrefix(normalizePhoneDigits(raw))
  const countryCode = normalizeDialCode(dialCode)

  if (digits.length < 7) return ''
  if (!countryCode) return normalizePhoneForStorage(raw)

  const mexicoPhone = countryCode === '52' ? normalizeMexicoPhoneDigits(digits) : ''
  if (mexicoPhone) return `+${mexicoPhone}`

  if (raw.startsWith('+') || raw.startsWith('00')) {
    return normalizePhoneForStorage(raw, { defaultCountryCode: countryCode })
  }

  if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) {
    return normalizePhoneForStorage(digits, { defaultCountryCode: countryCode })
  }

  return normalizePhoneForStorage(`${countryCode}${digits}`, { defaultCountryCode: countryCode })
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

/**
 * Detecta si un texto es en realidad un número telefónico
 * (solo dígitos y caracteres de formato: +, espacios, guiones, paréntesis, puntos).
 */
export function looksLikePhoneNumber(value = '') {
  const clean = String(value || '').trim()
  if (!clean) return false
  if (!/^[+()\s\-.\d]+$/.test(clean)) return false
  const digits = clean.replace(/\D/g, '')
  return digits.length >= 7
}

/**
 * Limpia un candidato a nombre de contacto: devuelve null si está vacío,
 * si es un número telefónico, o si coincide con alguno de los teléfonos dados.
 * Evita que el teléfono termine guardado como nombre del contacto.
 */
export function sanitizeContactName(value = '', ...phones) {
  const clean = String(value || '').trim()
  if (!clean) return null
  if (looksLikePhoneNumber(clean)) return null
  // Tampoco aceptar un email como nombre
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return null

  const nameDigits = clean.replace(/\D/g, '')
  if (nameDigits.length >= 7) {
    for (const phone of phones) {
      const phoneDigits = String(phone || '').replace(/\D/g, '')
      if (phoneDigits && (nameDigits === phoneDigits || nameDigits.endsWith(phoneDigits) || phoneDigits.endsWith(nameDigits))) {
        return null
      }
    }
  }

  return clean
}
