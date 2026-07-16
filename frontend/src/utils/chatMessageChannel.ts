export type ChatMessageChannelKind = 'whatsapp_api' | 'whatsapp_qr' | 'instagram' | 'messenger' | 'sms' | 'email' | 'unknown'

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

function normalizeSignal(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

function containsAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle))
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
  const commentPlatform = normalizeSignal(signals.commentPlatform)
  const messageType = normalizeSignal(signals.messageType)
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

export function getChatBubbleColorChannel(channel: ChatMessageChannelKind) {
  return channel === 'whatsapp_api' || channel === 'whatsapp_qr' || channel === 'instagram' || channel === 'messenger'
    ? channel
    : undefined
}
