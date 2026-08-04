export type WhatsAppMessageButtonType =
  | 'quick_reply'
  | 'url'
  | 'phone'
  | 'copy_code'
  | 'voice_call'
  | 'unknown'

export interface WhatsAppMessagePresentation {
  kind: 'template' | 'interactive'
  header?: {
    kind: 'text' | 'image' | 'video' | 'document' | 'location'
    text?: string
    mediaUrl?: string
    fileName?: string
  }
  body: string
  footer?: string
  buttons: Array<{
    type: WhatsAppMessageButtonType
    label: string
  }>
}

const PRESENTATION_KINDS = new Set<WhatsAppMessagePresentation['kind']>(['template', 'interactive'])
const HEADER_KINDS = new Set<NonNullable<WhatsAppMessagePresentation['header']>['kind']>([
  'text',
  'image',
  'video',
  'document',
  'location'
])
const BUTTON_TYPES = new Set<WhatsAppMessageButtonType>([
  'quick_reply',
  'url',
  'phone',
  'copy_code',
  'voice_call',
  'unknown'
])

function cleanText(value: unknown, maxLength = 50_000) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

export function normalizeWhatsAppMessagePresentation(value: unknown): WhatsAppMessagePresentation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const kind = cleanText(source.kind, 40) as WhatsAppMessagePresentation['kind']
  if (!PRESENTATION_KINDS.has(kind)) return undefined

  const rawHeader = source.header && typeof source.header === 'object' && !Array.isArray(source.header)
    ? source.header as Record<string, unknown>
    : null
  const headerKind = cleanText(rawHeader?.kind, 40) as NonNullable<WhatsAppMessagePresentation['header']>['kind']
  const header = rawHeader && HEADER_KINDS.has(headerKind)
    ? {
        kind: headerKind,
        text: cleanText(rawHeader.text) || undefined,
        mediaUrl: /^https?:\/\//i.test(cleanText(rawHeader.mediaUrl, 4096))
          ? cleanText(rawHeader.mediaUrl, 4096)
          : undefined,
        fileName: cleanText(rawHeader.fileName, 500) || undefined
      }
    : undefined
  const buttons = Array.isArray(source.buttons)
    ? source.buttons.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const button = entry as Record<string, unknown>
        const label = cleanText(button.label, 120)
        const type = cleanText(button.type, 40) as WhatsAppMessageButtonType
        if (!label) return []
        return [{ type: BUTTON_TYPES.has(type) ? type : 'unknown', label }]
      }).slice(0, 10)
    : []
  const body = cleanText(source.body)
  const footer = cleanText(source.footer, 500)

  if (!body && !footer && !header && !buttons.length) return undefined
  return {
    kind,
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons
  }
}
