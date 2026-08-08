export type WhatsAppMessageButtonType =
  | 'quick_reply'
  | 'url'
  | 'phone'
  | 'copy_code'
  | 'voice_call'
  | 'flow'
  | 'catalog'
  | 'payment'
  | 'otp'
  | 'unknown'

export type WhatsAppMessageItemKind =
  | 'contact'
  | 'phone'
  | 'email'
  | 'address'
  | 'product'
  | 'option'
  | 'amount'
  | 'calendar'
  | 'link'
  | 'info'

export interface WhatsAppMessagePresentation {
  kind:
    | 'template'
    | 'interactive'
    | 'interactive_reply'
    | 'contacts'
    | 'order'
    | 'product'
    | 'poll'
    | 'event'
    | 'payment'
    | 'system'
    | 'unsupported'
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
  sections?: Array<{
    title?: string
    items: Array<{
      kind: WhatsAppMessageItemKind
      label: string
      value?: string
    }>
  }>
}

const PRESENTATION_KINDS = new Set<WhatsAppMessagePresentation['kind']>([
  'template', 'interactive', 'interactive_reply', 'contacts', 'order', 'product',
  'poll', 'event', 'payment', 'system', 'unsupported'
])
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
  'flow',
  'catalog',
  'payment',
  'otp',
  'unknown'
])
const ITEM_KINDS = new Set<WhatsAppMessageItemKind>([
  'contact', 'phone', 'email', 'address', 'product', 'option', 'amount', 'calendar', 'link', 'info'
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
  const sections = Array.isArray(source.sections)
    ? source.sections.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const section = entry as Record<string, unknown>
        const items = Array.isArray(section.items)
          ? section.items.flatMap((rawItem) => {
              if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return []
              const item = rawItem as Record<string, unknown>
              const label = cleanText(item.label, 500)
              const value = cleanText(item.value, 2_000)
              const itemKind = cleanText(item.kind, 40) as WhatsAppMessageItemKind
              if (!label) return []
              return [{
                kind: ITEM_KINDS.has(itemKind) ? itemKind : 'info' as const,
                label,
                ...(value ? { value } : {})
              }]
            }).slice(0, 30)
          : []
        if (!items.length) return []
        const title = cleanText(section.title, 240)
        return [{ ...(title ? { title } : {}), items }]
      }).slice(0, 20)
    : []

  if (!body && !footer && !header && !buttons.length && !sections.length) return undefined
  return {
    kind,
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons,
    ...(sections.length ? { sections } : {})
  }
}
