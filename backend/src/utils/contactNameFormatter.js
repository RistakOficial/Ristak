const NAME_CONNECTORS = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'da',
  'do',
  'dos',
  'das',
  'van',
  'von',
  'al'
])

const cleanNameString = (value) => String(value || '').replace(/\s+/g, ' ').trim()

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const looksLikePhone = (value) => {
  if (!/^[+()\s\-.\d]+$/.test(value)) return false
  return value.replace(/\D/g, '').length >= 7
}

const capitalizeSegment = (segment) => {
  if (!segment) return ''
  return segment.charAt(0).toLocaleUpperCase('es-MX') + segment.slice(1)
}

const formatCompoundWord = (word) => word
  .split(/([-'\u2019])/)
  .map(segment => {
    if (segment === '-' || segment === '\'' || segment === '\u2019') return segment
    return capitalizeSegment(segment)
  })
  .join('')

export function formatContactName(value = '', { allowLeadingConnectorLowercase = false } = {}) {
  const trimmed = cleanNameString(value)
  if (!trimmed) return ''
  if (trimmed.startsWith('@') || looksLikeEmail(trimmed) || looksLikePhone(trimmed)) return trimmed

  const lowercase = trimmed.toLocaleLowerCase('es-MX')
  return lowercase
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if ((index > 0 || allowLeadingConnectorLowercase) && NAME_CONNECTORS.has(word)) return word
      return formatCompoundWord(word)
    })
    .join(' ')
}

export function splitContactName(value = '') {
  const formattedName = formatContactName(value)
  const parts = formattedName.split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ')
  }
}

export function normalizeContactNameFields({
  fullName,
  name,
  firstName,
  lastName,
  fallback = ''
} = {}) {
  const formattedFirstName = formatContactName(firstName)
  const formattedLastName = formatContactName(lastName, { allowLeadingConnectorLowercase: true })
  const composedName = [formattedFirstName, formattedLastName].filter(Boolean).join(' ')
  const formattedFullName = formatContactName(fullName || name || composedName || fallback)
  const splitName = splitContactName(formattedFullName)

  return {
    fullName: formattedFullName,
    firstName: formattedFirstName || splitName.firstName,
    lastName: formattedLastName || splitName.lastName
  }
}
