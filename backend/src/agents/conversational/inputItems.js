import { assistant } from '@openai/agents'

const DEFAULT_MESSAGE_HISTORY_LIMIT = 12
const MAX_MESSAGE_HISTORY_LIMIT = 200
const MAX_CHAT_ATTACHMENTS = 8
const MAX_ATTACHMENT_TEXT_CHARS = 18000

function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,')
}

function attachmentToContentParts(attachment) {
  if (!attachment || typeof attachment !== 'object') return []

  const name = String(attachment.name || 'archivo').slice(0, 180)
  const kind = String(attachment.kind || '').toLowerCase()
  const summary = `Adjunto: ${name} (tipo=${attachment.mimeType || kind || 'desconocido'})`

  if (kind === 'image' && isDataUrl(attachment.dataUrl)) {
    return [{ type: 'input_image', image: attachment.dataUrl }]
  }
  if (kind === 'video' && isDataUrl(attachment.thumbnailDataUrl)) {
    return [
      {
        type: 'input_text',
        text: `${summary}\nEste video se envió con una miniatura visual para analizar el encuadre/contenido visible.`
      },
      { type: 'input_image', image: attachment.thumbnailDataUrl }
    ]
  }
  if (typeof attachment.text === 'string' && attachment.text.trim()) {
    return [{
      type: 'input_text',
      text: `${summary}\nContenido del archivo ${name}:\n${attachment.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}`
    }]
  }
  if (isDataUrl(attachment.dataUrl)) {
    return [{ type: 'input_file', filename: name, file: attachment.dataUrl }]
  }
  return [{ type: 'input_text', text: `${summary} (sin contenido legible adjunto)` }]
}

export function buildConversationalInputItems(messages, options = {}) {
  const requestedLimit = typeof options === 'number' ? options : options?.limit
  const preserveAll = typeof options === 'object' && options?.preserveAll === true
  const historyLimit = Number.isFinite(Number(requestedLimit))
    ? Math.max(1, Math.min(MAX_MESSAGE_HISTORY_LIMIT, Math.trunc(Number(requestedLimit))))
    : DEFAULT_MESSAGE_HISTORY_LIMIT
  const eligible = (Array.isArray(messages) ? messages : []).filter((message) => {
    if (!message) return false
    const hasText = typeof message.content === 'string' && message.content.trim()
    const hasAttachments = Array.isArray(message.attachments) && message.attachments.length
    return hasText || hasAttachments
  })
  const recent = preserveAll ? eligible : eligible.slice(-historyLimit)

  return recent.map((message) => {
    let text = typeof message.content === 'string' ? message.content.trim() : ''
    if (message.role === 'user' && message.selectedClarificationOption?.value) {
      text = `${text}\n[Opción seleccionada: ${message.selectedClarificationOption.value}]`
    }

    if (message.role === 'assistant') {
      return assistant(text)
    }

    const attachmentParts = (Array.isArray(message.attachments) ? message.attachments : [])
      .slice(0, MAX_CHAT_ATTACHMENTS)
      .flatMap(attachmentToContentParts)
    const content = [
      ...(text ? [{ type: 'input_text', text }] : []),
      ...attachmentParts
    ]

    return {
      role: 'user',
      content: content.length ? content : [{ type: 'input_text', text: '(mensaje vacío)' }]
    }
  })
}
