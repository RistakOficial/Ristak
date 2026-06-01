const SECTION_LABELS = [
  'Notas?',
  'Observaciones?',
  'T[eé]rminos(?:\\s+y\\s+condiciones)?',
  'Condiciones',
  'Referencia',
  'M[eé]todo',
  'Fecha',
  'Vencimiento',
  'Monto',
  'Total',
  'Plan',
  'Cliente',
  'Concepto',
  'Descripci[oó]n',
  'Pago',
  'Notes?',
  'Terms(?:\\s+and\\s+Conditions)?',
  'Conditions',
  'Reference',
  'Method',
  'Date',
  'Due\\s+Date',
  'Amount',
  'Customer',
  'Concept',
  'Description',
  'Payment'
]

const SECTION_LABEL_PATTERN = new RegExp(`(?<!\\by)(?<!\\band)(?<!\\bdue)\\s+(?=(${SECTION_LABELS.join('|')})\\s*:)`, 'gi')
const BULLET_PATTERN = /\s+(?=([-*•]\s+))/g
const NUMBERED_ITEM_PATTERN = /\s+(?=(\d{1,2}[.)]\s+))/g
const MULTILINE_TEXT_KEYS = new Set([
  'description',
  'termsNotes',
  'terms_notes',
  'invoice_terms_notes',
  'terms',
  'termsAndConditions',
  'termsConditions',
  'terms_conditions',
  'conditions',
  'paymentTerms',
  'notes',
  'additionalNotes',
  'note',
  'memo',
  'message',
  'footer',
  'invoiceNotes',
  'itemDescription'
])
const SINGLE_LINE_TEXT_KEYS = new Set([
  'name',
  'title',
  'invoiceTitle',
  'invoiceNumberPrefix'
])
const INVOICE_ITEM_KEYS = ['items', 'invoiceItems', 'lineItems']

function stringifyText(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeTextBreaks(value) {
  return stringifyText(value)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
}

export function formatInvoiceSingleLineText(value) {
  return normalizeTextBreaks(value)
    .replace(/\n+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function formatInvoiceMultilineText(value) {
  let text = normalizeTextBreaks(value)
    .replace(SECTION_LABEL_PATTERN, '\n')
    .replace(BULLET_PATTERN, '\n')
    .replace(NUMBERED_ITEM_PATTERN, '\n')

  text = text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}

export function combineInvoiceTextSections(...sections) {
  return sections
    .map(formatInvoiceMultilineText)
    .filter(Boolean)
    .join('\n\n')
}

function formatInvoiceItemText(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item

  const formatted = { ...item }

  for (const key of Object.keys(formatted)) {
    if (formatted[key] === undefined || formatted[key] === null) continue

    if (MULTILINE_TEXT_KEYS.has(key)) {
      formatted[key] = formatInvoiceMultilineText(formatted[key])
    } else if (SINGLE_LINE_TEXT_KEYS.has(key)) {
      formatted[key] = formatInvoiceSingleLineText(formatted[key])
    }
  }

  return formatted
}

export function formatInvoicePayloadText(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload

  const formatted = { ...payload }

  for (const key of Object.keys(formatted)) {
    if (formatted[key] === undefined || formatted[key] === null) continue

    if (MULTILINE_TEXT_KEYS.has(key)) {
      formatted[key] = formatInvoiceMultilineText(formatted[key])
    } else if (SINGLE_LINE_TEXT_KEYS.has(key)) {
      formatted[key] = formatInvoiceSingleLineText(formatted[key])
    }
  }

  for (const key of INVOICE_ITEM_KEYS) {
    if (Array.isArray(formatted[key])) {
      formatted[key] = formatted[key].map(formatInvoiceItemText)
    }
  }

  return formatted
}
