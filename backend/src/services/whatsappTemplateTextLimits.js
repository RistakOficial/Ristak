export const WHATSAPP_TEMPLATE_TEXT_HEADER_MAX_LENGTH = 60

const NUMERIC_VARIABLE_PATTERN = /{{\s*(\d+)\s*}}/g
const CLOCK_SUFFIX_PATTERN = /(\s+\d{1,2}:\d{2}(?:\s*(?:a|p)\.?\s*m\.?)?)\s*$/iu

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function countWhatsAppTemplateCharacters(value = '') {
  return Array.from(String(value ?? '')).length
}

function sliceCharacters(value, maxLength) {
  return Array.from(cleanString(value)).slice(0, Math.max(0, maxLength)).join('')
}

function truncateWithEllipsis(value, maxLength) {
  const cleaned = cleanString(value)
  if (countWhatsAppTemplateCharacters(cleaned) <= maxLength) return cleaned
  if (maxLength <= 0) return ''
  if (maxLength === 1) return '…'
  return `${sliceCharacters(cleaned, maxLength - 1).trimEnd()}…`
}

function compactCalendarYearBeforeClock(value) {
  const cleaned = cleanString(value)
  const withoutSpanishYear = cleaned.replace(
    /\s+de\s+(?:19|20)\d{2}(?=\s+\d{1,2}:\d{2}(?:\s*(?:a|p)\.?\s*m\.?)?\s*$)/iu,
    ''
  )
  if (withoutSpanishYear !== cleaned) return withoutSpanishYear

  return cleaned.replace(
    /,?\s+(?:19|20)\d{2}(?=\s+\d{1,2}:\d{2}(?:\s*(?:a|p)\.?\s*m\.?)?\s*$)/iu,
    ''
  )
}

function truncatePreservingClock(value, maxLength) {
  const cleaned = cleanString(value)
  if (countWhatsAppTemplateCharacters(cleaned) <= maxLength) return cleaned

  const clockMatch = cleaned.match(CLOCK_SUFFIX_PATTERN)
  const clock = cleanString(clockMatch?.[1])
  if (clock && Number.isInteger(clockMatch?.index)) {
    const clockLength = countWhatsAppTemplateCharacters(clock)
    const prefixBudget = maxLength - clockLength - 1
    if (prefixBudget > 0) {
      const prefix = truncateWithEllipsis(cleaned.slice(0, clockMatch.index), prefixBudget)
      if (prefix) return `${prefix} ${clock}`
    }
  }

  return truncateWithEllipsis(cleaned, maxLength)
}

function getVariableIndexes(templateText = '') {
  const indexes = []
  const seen = new Set()
  for (const match of cleanString(templateText).matchAll(NUMERIC_VARIABLE_PATTERN)) {
    const index = Number(match[1])
    if (!Number.isInteger(index) || index <= 0 || seen.has(index)) continue
    seen.add(index)
    indexes.push(index)
  }
  return indexes.sort((left, right) => left - right)
}

function getVariableOccurrences(templateText = '') {
  const occurrences = new Map()
  for (const match of cleanString(templateText).matchAll(NUMERIC_VARIABLE_PATTERN)) {
    const index = Number(match[1])
    if (!Number.isInteger(index) || index <= 0) continue
    occurrences.set(index, (occurrences.get(index) || 0) + 1)
  }
  return occurrences
}

function renderHeaderForLength(templateText, parameters, indexes) {
  const values = new Map(indexes.map((index, position) => [
    index,
    cleanString(parameters[position]?.text)
  ]))
  return cleanString(templateText).replace(NUMERIC_VARIABLE_PATTERN, (match, index) => (
    values.has(Number(index)) ? values.get(Number(index)) : match
  ))
}

function renderedHeaderLength(templateText, parameters, indexes) {
  return countWhatsAppTemplateCharacters(renderHeaderForLength(templateText, parameters, indexes))
}

/**
 * WhatsApp limita a 60 caracteres el encabezado de texto ya materializado:
 * copy fijo + valores dinámicos. Los ejemplos aprobados no garantizan que los
 * datos reales quepan, así que el payload se ajusta justo antes del envío.
 */
export function fitWhatsAppTemplateHeaderParameters({
  templateText,
  parameters = [],
  maxLength = WHATSAPP_TEMPLATE_TEXT_HEADER_MAX_LENGTH
} = {}) {
  const indexes = getVariableIndexes(templateText)
  if (!indexes.length || !Array.isArray(parameters) || !parameters.length) return parameters

  const fitted = parameters.map(parameter => ({ ...parameter }))
  if (renderedHeaderLength(templateText, fitted, indexes) <= maxLength) return fitted

  for (let position = 0; position < indexes.length; position += 1) {
    if (renderedHeaderLength(templateText, fitted, indexes) <= maxLength) break
    if (cleanString(fitted[position]?.type).toLowerCase() !== 'text') continue
    fitted[position].text = compactCalendarYearBeforeClock(fitted[position].text)
  }

  const occurrences = getVariableOccurrences(templateText)
  while (renderedHeaderLength(templateText, fitted, indexes) > maxLength) {
    const overflow = renderedHeaderLength(templateText, fitted, indexes) - maxLength
    let candidate = null

    for (let position = 0; position < indexes.length; position += 1) {
      if (cleanString(fitted[position]?.type).toLowerCase() !== 'text') continue
      const length = countWhatsAppTemplateCharacters(fitted[position].text)
      const count = occurrences.get(indexes[position]) || 1
      const reducible = Math.max(0, length - 1) * count
      if (reducible > (candidate?.reducible || 0)) {
        candidate = { position, length, count, reducible }
      }
    }

    if (!candidate?.reducible) {
      throw new Error(`El encabezado de la plantilla de WhatsApp no puede ajustarse al límite de ${maxLength} caracteres.`)
    }

    const reduction = Math.max(1, Math.ceil(overflow / candidate.count))
    const targetLength = Math.max(1, candidate.length - reduction)
    fitted[candidate.position].text = truncatePreservingClock(
      fitted[candidate.position].text,
      targetLength
    )
  }

  return fitted
}
