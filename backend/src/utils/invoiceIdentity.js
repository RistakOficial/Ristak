const KNOWN_INVOICE_PREFIX_RE = /^(?:INVOICE|INV|FACTURA|FACT|FAC)[-\s#]*/i
const INVOICE_LABEL_RE = /(?:invoice|factura|fact|fac)\s*#?\s*([A-Za-z0-9][A-Za-z0-9\s#-]*)/i
const PREFIXED_NUMBER_RE = /\b((?:INV|FACTURA|FACT|FAC)[-\s#]*[A-Za-z0-9][A-Za-z0-9\s#-]*)\b/i
const PLAIN_NUMBER_RE = /\b(\d[A-Za-z0-9-]*)\b/i

function cleanIdentityText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCandidate(value) {
  let normalized = cleanIdentityText(value)
    .replace(/#/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase()

  while (KNOWN_INVOICE_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(KNOWN_INVOICE_PREFIX_RE, '')
  }

  return normalized || null
}

export function normalizeInvoiceNumber(value) {
  const text = cleanIdentityText(value)
  if (!text) return null

  const labelMatch = text.match(INVOICE_LABEL_RE)
  if (labelMatch?.[1]) return normalizeCandidate(labelMatch[1])

  const prefixedMatch = text.match(PREFIXED_NUMBER_RE)
  if (prefixedMatch?.[1]) return normalizeCandidate(prefixedMatch[1])

  return normalizeCandidate(text)
}

export function normalizeInvoiceReference(value) {
  const text = cleanIdentityText(value)
  if (!text) return null

  const labelMatch = text.match(INVOICE_LABEL_RE)
  if (labelMatch?.[1]) return normalizeCandidate(labelMatch[1])

  const prefixedMatch = text.match(PREFIXED_NUMBER_RE)
  if (prefixedMatch?.[1]) return normalizeCandidate(prefixedMatch[1])

  const plainMatch = text.match(PLAIN_NUMBER_RE)
  if (plainMatch?.[1]) return normalizeCandidate(plainMatch[1])

  return null
}

export function firstInvoiceIdentity(...values) {
  for (const value of values) {
    const normalized = normalizeInvoiceReference(value)
    if (normalized) return normalized
  }

  return null
}

export function buildInvoiceReferenceCandidates(invoiceNumber) {
  const normalized = normalizeInvoiceNumber(invoiceNumber)
  if (!normalized) return []

  return Array.from(new Set([
    normalized,
    `INV-${normalized}`,
    `Invoice #${normalized}`,
    `Invoice #INV-${normalized}`
  ]))
}
