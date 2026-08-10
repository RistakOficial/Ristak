export type ChatMessageChannelKind = 'whatsapp_api' | 'whatsapp_qr' | 'instagram' | 'messenger' | 'sms' | 'email' | 'webchat' | 'unknown'

export interface ChatMessageChannelSignals {
  eventType?: unknown
  channel?: unknown
  transport?: unknown
  provider?: unknown
  platform?: unknown
  commentPlatform?: unknown
  messageType?: unknown
  hasEmail?: boolean
}

export interface ChatMessageRoutingPresentationSignals {
  direction?: unknown
  transport?: unknown
  routingReason?: unknown
}

export interface ChatMessageRoutingPresentation {
  badgeLabel: string
  reason: string
}

export type ChatCommentPlatform = 'instagram' | 'messenger'

const COMMENT_MESSAGE_TYPES = new Set([
  'comment',
  'comment_reply_public',
  'comment_reply_private'
])

function normalizeSignal(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function containsAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle))
}

function isReplyWindowQrFallbackReason(reason: string) {
  const normalized = reason.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (!normalized.includes('respaldo qr')) return false

  return (
    normalized.includes('mas de 24 horas') ||
    (
      normalized.includes('no hay una respuesta reciente') &&
      normalized.includes('ventana de whatsapp api')
    )
  )
}

/**
 * Convierte el motivo técnico del fallback por ventana de respuesta en una
 * señal breve para el historial. Los demás motivos se conservan completos.
 */
export function getChatMessageRoutingPresentation(
  signals: ChatMessageRoutingPresentationSignals
): ChatMessageRoutingPresentation {
  if (normalizeSignal(signals.direction) !== 'outbound') return { badgeLabel: '', reason: '' }

  const reason = String(signals.routingReason || '').trim()
  if (isReplyWindowQrFallbackReason(reason)) {
    return { badgeLabel: '+24 h · Se usó QR', reason: '' }
  }

  if (normalizeSignal(signals.transport) === 'qr') return { badgeLabel: '', reason: '' }

  return {
    badgeLabel: '',
    reason: reason === 'Capturado desde la sesión de WhatsApp Web.' ? '' : reason
  }
}

function isHighLevelMessage(signals: ChatMessageChannelSignals) {
  const values = [signals.channel, signals.transport, signals.provider, signals.platform]
    .map(normalizeSignal)
    .filter(Boolean)

  return values.some((value) => (
    value === 'ghl' ||
    value.includes('highlevel') ||
    value.includes('go_high_level') ||
    value.includes('gohighlevel') ||
    value.startsWith('ghl_')
  ))
}

/**
 * `commentPlatform` sólo existe para comentarios y sus respuestas. Antes se
 * rellenaba como Messenger en cualquier mensaje que no dijera Instagram, lo
 * que convertía mensajes normales de WhatsApp en globos azules al hidratar.
 */
export function resolveChatCommentPlatform(
  messageType: unknown,
  platform: unknown
): ChatCommentPlatform | undefined {
  if (!COMMENT_MESSAGE_TYPES.has(normalizeSignal(messageType))) return undefined
  return normalizeSignal(platform).includes('instagram') ? 'instagram' : 'messenger'
}

/**
 * Resuelve el canal visible del mensaje, no solamente el transporte técnico.
 * `api`, `qr` y `smtp` describen cómo viajó; la burbuja necesita saber si fue
 * WhatsApp, Instagram, Messenger, SMS o correo.
 */
export function resolveChatMessageChannel(signals: ChatMessageChannelSignals): ChatMessageChannelKind {
  const eventType = normalizeSignal(signals.eventType)
  const channel = normalizeSignal(signals.channel)
  const transport = normalizeSignal(signals.transport)
  const provider = normalizeSignal(signals.provider)
  const platform = normalizeSignal(signals.platform)
  const messageType = normalizeSignal(signals.messageType)
  const commentPlatform = resolveChatCommentPlatform(messageType, signals.commentPlatform) || ''
  const explicitProbe = [commentPlatform, platform, channel, provider, transport].filter(Boolean).join(' ')

  if (
    signals.hasEmail ||
    eventType === 'email_message' ||
    messageType === 'email' ||
    containsAny(explicitProbe, ['email', 'e-mail', 'gmail', 'smtp', 'mailgun'])
  ) return 'email'

  if (containsAny(explicitProbe, ['instagram', 'instagram_comment']) || commentPlatform === 'instagram') {
    return 'instagram'
  }

  if (containsAny(explicitProbe, ['messenger', 'facebook', 'facebook_comment']) || commentPlatform === 'messenger') {
    return 'messenger'
  }

  if (containsAny(explicitProbe, ['webchat', 'web_chat', 'live_chat', 'website_chat', 'site_chat'])) {
    return 'webchat'
  }

  if (eventType === 'sms_message' || messageType === 'sms' || containsAny(explicitProbe, ['sms', 'text_message', 'lc_phone'])) {
    return 'sms'
  }

  const isWhatsApp = (
    eventType === 'whatsapp_message' ||
    containsAny(explicitProbe, ['whatsapp', 'waba', 'ycloud', 'baileys']) ||
    ['api', 'qr', 'native', 'whatsapp_api'].includes(channel) ||
    ['api', 'qr', 'baileys', 'web'].includes(transport)
  )
  if (isWhatsApp) {
    const usesQr = containsAny(`${channel} ${transport} ${provider}`, ['baileys', 'whatsapp_web', 'whatsapp_qr']) ||
      ['qr', 'web'].includes(channel) ||
      ['qr', 'web', 'baileys'].includes(transport) ||
      ['qr', 'baileys'].includes(provider)
    return usesQr ? 'whatsapp_qr' : 'whatsapp_api'
  }

  return 'unknown'
}

/**
 * Nombre corto y legible del origen real que se muestra junto a la hora de cada
 * mensaje. El canal visible no basta para HighLevel: WhatsApp y SMS comparten
 * tablas locales, pero el usuario necesita distinguirlos dentro del historial.
 */
export function getChatMessageSourceLabel(signals: ChatMessageChannelSignals) {
  const channel = resolveChatMessageChannel(signals)
  const highLevel = isHighLevelMessage(signals)
  const commentPlatform = resolveChatCommentPlatform(signals.messageType, signals.commentPlatform || signals.platform)

  if (highLevel) {
    if (channel === 'whatsapp_api') return 'GHL · WhatsApp'
    if (channel === 'whatsapp_qr') return 'GHL · WhatsApp QR'
    if (channel === 'instagram') return 'GHL · Instagram'
    if (channel === 'messenger') return commentPlatform === 'messenger' ? 'GHL · Facebook' : 'GHL · Messenger'
    if (channel === 'sms') return 'GHL · SMS'
    if (channel === 'email') return 'GHL · Email'
    if (channel === 'webchat') return 'GHL · Webchat'
  }

  if (channel === 'whatsapp_api') return 'WhatsApp API'
  if (channel === 'whatsapp_qr') return 'WhatsApp QR'
  if (channel === 'instagram') return 'Instagram'
  if (channel === 'messenger') return commentPlatform === 'messenger' ? 'Facebook' : 'Messenger'
  if (channel === 'sms') return 'SMS'
  if (channel === 'email') return 'Email'
  if (channel === 'webchat') return 'Webchat'
  return 'Sin canal'
}

export function getChatBubbleColorChannel(channel: ChatMessageChannelKind, direction: unknown) {
  return direction === 'outbound' && (channel === 'whatsapp_api' || channel === 'whatsapp_qr' || channel === 'instagram' || channel === 'messenger')
    ? channel
    : undefined
}
