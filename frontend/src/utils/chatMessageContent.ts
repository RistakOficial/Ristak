export interface ChatMessageContentStateInput {
  eventType?: unknown
  messageType?: unknown
  direction?: unknown
  errorCode?: unknown
  errorReason?: unknown
  contentUnavailable?: unknown
}

export interface ChatListMessagePreviewInput {
  messageText?: unknown
  messageType?: unknown
  isGif?: unknown
}

function cleanValue(value: unknown) {
  return String(value ?? '').trim()
}

function isTruthyFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return ['1', 'true', 'yes', 'si', 'sí'].includes(cleanValue(value).toLowerCase())
}

const GENERIC_GIF_PREVIEW_TEXTS = new Set([
  'gif',
  'image',
  'imagen',
  'message',
  'mensaje',
  'photo',
  'foto',
  'video'
])

export function getChatListMessageText({ messageText, messageType, isGif }: ChatListMessagePreviewInput) {
  const text = cleanValue(messageText)
  const type = cleanValue(messageType).toLowerCase()
  const gif = isTruthyFlag(isGif) || type.includes('gif')

  if (gif && (!text || GENERIC_GIF_PREVIEW_TEXTS.has(text.toLowerCase()))) return 'GIF'
  return text
}

function isProviderUnavailableError({ messageType, errorCode, errorReason, contentUnavailable }: ChatMessageContentStateInput) {
  const type = cleanValue(messageType).toLowerCase()
  const code = cleanValue(errorCode)
  const reason = cleanValue(errorReason).toLowerCase()

  if (isTruthyFlag(contentUnavailable)) return true
  if (['131051', '131060'].includes(code)) return true
  if (['unsupported', 'unknown', 'unavailable'].includes(type)) return true
  return /message type.*not supported|message is unavailable|message type unknown|currently not supported/.test(reason)
}

export function getChatMessageFallbackText(input: ChatMessageContentStateInput) {
  const eventType = cleanValue(input.eventType).toLowerCase()
  const type = cleanValue(input.messageType).toLowerCase()

  if (isProviderUnavailableError(input)) {
    if (eventType === 'whatsapp_message') {
      return 'Contenido no disponible en la API de WhatsApp. Ábrelo en WhatsApp para verlo.'
    }
    if (eventType === 'meta_message') {
      return 'Contenido no disponible en la API de Meta. Ábrelo en Instagram o Facebook para verlo.'
    }
    return 'Contenido no disponible en este canal.'
  }

  if (type.includes('gif')) return 'GIF'
  if (type.includes('sticker')) return 'Sticker'
  if (type.includes('image')) return 'Foto'
  if (type.includes('video')) return 'Video'
  if (type.includes('audio') || type.includes('voice')) return 'Mensaje de voz'
  if (type.includes('document') || type.includes('file')) return 'Documento'
  if (type.includes('location')) return 'Ubicación'
  if (type === 'contacts' || type === 'contact') return 'Contacto compartido'
  if (type === 'order') return 'Pedido compartido'
  if (type === 'system') return 'Actualización del sistema'
  if (type.includes('postback') || type === 'button' || type === 'interactive') return 'Respuesta rápida'
  if (type.includes('reaction')) return 'Reacción'
  if (type === 'template') return 'Plantilla de WhatsApp'
  if (type === 'email') return 'Correo'
  if (!type) return 'Mensaje'
  return 'Contenido no disponible en este canal.'
}

export function shouldHideEmptyChatControlMessage(messageType: unknown) {
  const type = cleanValue(messageType).toLowerCase()
  return type === 'status' || type === 'edit'
}

export function getVisibleChatMessageError(input: Pick<ChatMessageContentStateInput, 'direction' | 'errorReason'>) {
  return cleanValue(input.direction).toLowerCase() === 'outbound'
    ? cleanValue(input.errorReason)
    : ''
}

export function isOutboundChatMessageFailure({ direction, status, errorReason }: {
  direction?: unknown
  status?: unknown
  errorReason?: unknown
}) {
  if (cleanValue(direction).toLowerCase() !== 'outbound') return false
  const normalizedStatus = cleanValue(status).toLowerCase()
  return ['failed', 'error', 'undelivered', 'rejected', 'cancelled', 'canceled'].includes(normalizedStatus) || Boolean(cleanValue(errorReason))
}
