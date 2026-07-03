export type WhatsAppInlineFormat = 'bold' | 'italic' | 'strikethrough' | 'inlineCode' | 'monospace'

export type WhatsAppInlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: WhatsAppInlineSegment[] }
  | { type: 'italic'; children: WhatsAppInlineSegment[] }
  | { type: 'strikethrough'; children: WhatsAppInlineSegment[] }
  | { type: 'inlineCode'; text: string }
  | { type: 'monospace'; text: string }

export type WhatsAppFormattedLineType = 'paragraph' | 'bullet' | 'numbered' | 'quote'

export interface WhatsAppFormattedLine {
  type: WhatsAppFormattedLineType
  marker?: string
  segments: WhatsAppInlineSegment[]
}

interface InlineFormatRule {
  type: WhatsAppInlineFormat
  delimiter: string
  literal: boolean
}

const INLINE_FORMAT_RULES: InlineFormatRule[] = [
  { type: 'monospace', delimiter: '```', literal: true },
  { type: 'inlineCode', delimiter: '`', literal: true },
  { type: 'bold', delimiter: '*', literal: false },
  { type: 'italic', delimiter: '_', literal: false },
  { type: 'strikethrough', delimiter: '~', literal: false }
]

function isWhitespace(value: string | undefined) {
  return Boolean(value && /\s/.test(value))
}

function isBoundaryCharacter(value: string | undefined) {
  if (!value) return true
  return /[\s()[\]{}'"“”‘’.,;:!?¿¡/\\|<>=+\-]/.test(value)
}

function canOpenDelimitedFormat(source: string, index: number, delimiter: string) {
  const next = source[index + delimiter.length]
  if (!next || isWhitespace(next)) return false
  return isBoundaryCharacter(source[index - 1])
}

function canCloseDelimitedFormat(source: string, index: number, delimiter: string) {
  const previous = source[index - 1]
  if (!previous || isWhitespace(previous)) return false
  return isBoundaryCharacter(source[index + delimiter.length])
}

function getOpeningRule(source: string, index: number) {
  return INLINE_FORMAT_RULES.find((rule) => {
    if (!source.startsWith(rule.delimiter, index)) return false
    if (rule.literal) return index + rule.delimiter.length < source.length
    return canOpenDelimitedFormat(source, index, rule.delimiter)
  }) || null
}

function getClosingIndex(source: string, startIndex: number, rule: InlineFormatRule) {
  let searchIndex = startIndex

  while (searchIndex < source.length) {
    const closingIndex = source.indexOf(rule.delimiter, searchIndex)
    if (closingIndex === -1) return -1

    const content = source.slice(startIndex, closingIndex)
    const hasContent = rule.literal ? content.length > 0 : content.trim().length > 0
    const canClose = rule.literal || canCloseDelimitedFormat(source, closingIndex, rule.delimiter)
    if (hasContent && canClose) return closingIndex

    searchIndex = closingIndex + rule.delimiter.length
  }

  return -1
}

function pushTextSegment(segments: WhatsAppInlineSegment[], text: string) {
  if (!text) return
  const previous = segments[segments.length - 1]
  if (previous?.type === 'text') {
    previous.text += text
    return
  }
  segments.push({ type: 'text', text })
}

export function parseWhatsAppInlineText(source: string): WhatsAppInlineSegment[] {
  const segments: WhatsAppInlineSegment[] = []
  let plainText = ''
  let index = 0

  while (index < source.length) {
    const rule = getOpeningRule(source, index)

    if (rule) {
      const contentStart = index + rule.delimiter.length
      const closingIndex = getClosingIndex(source, contentStart, rule)

      if (closingIndex !== -1) {
        pushTextSegment(segments, plainText)
        plainText = ''

        const content = source.slice(contentStart, closingIndex)
        if (rule.literal) {
          segments.push({ type: rule.type as 'inlineCode' | 'monospace', text: content })
        } else {
          segments.push({
            type: rule.type as 'bold' | 'italic' | 'strikethrough',
            children: parseWhatsAppInlineText(content)
          })
        }

        index = closingIndex + rule.delimiter.length
        continue
      }
    }

    plainText += source[index]
    index += 1
  }

  pushTextSegment(segments, plainText)
  return segments
}

export function parseWhatsAppFormattedText(source: string): WhatsAppFormattedLine[] {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((rawLine) => {
      const bulletMatch = rawLine.match(/^([*-])\s+(.*)$/)
      if (bulletMatch) {
        return {
          type: 'bullet',
          marker: bulletMatch[1],
          segments: parseWhatsAppInlineText(bulletMatch[2] || '')
        }
      }

      const numberedMatch = rawLine.match(/^(\d{1,3})\.\s+(.*)$/)
      if (numberedMatch) {
        return {
          type: 'numbered',
          marker: numberedMatch[1],
          segments: parseWhatsAppInlineText(numberedMatch[2] || '')
        }
      }

      const quoteMatch = rawLine.match(/^>\s+(.*)$/)
      if (quoteMatch) {
        return {
          type: 'quote',
          segments: parseWhatsAppInlineText(quoteMatch[1] || '')
        }
      }

      return {
        type: 'paragraph',
        segments: parseWhatsAppInlineText(rawLine)
      }
    })
}
