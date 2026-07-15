function cleanErrorField(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function isHighLevelConversationContactNotFoundError(error) {
  const probe = [
    error?.message,
    error?.code,
    error?.canonicalCode,
    error?.canonical_code,
    error?.details,
    error?.body,
    error?.responseBody,
    error?.response?.data
  ].map(cleanErrorField).filter(Boolean).join(' ').toLowerCase()

  return probe.includes('conversations_contact_not_found') ||
    /contact(?:o)?\s+(?:was\s+)?not\s+found/.test(probe) ||
    /contacto\s+no\s+encontrado/.test(probe)
}
