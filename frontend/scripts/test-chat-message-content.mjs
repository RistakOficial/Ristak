import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getChatListMessageText,
  getChatMessageFallbackText,
  getVisibleChatMessageError,
  isOutboundChatMessageFailure,
  shouldHideEmptyChatControlMessage
} from '../src/utils/chatMessageContent.ts'

test('la bandeja identifica GIF aunque el proveedor mande un placeholder genérico', () => {
  assert.equal(getChatListMessageText({ messageText: 'Mensaje', messageType: 'video', isGif: true }), 'GIF')
  assert.equal(getChatListMessageText({ messageText: 'Video', messageType: 'gif' }), 'GIF')
  assert.equal(getChatListMessageText({ messageText: 'Mira esto', messageType: 'gif', isGif: true }), 'Mira esto')
  assert.equal(getChatListMessageText({ messageText: 'Mensaje', messageType: 'text' }), 'Mensaje')
})

test('da nombres legibles a los formatos soportados sin texto', () => {
  assert.equal(getChatMessageFallbackText({ messageType: 'sticker' }), 'Sticker')
  assert.equal(getChatMessageFallbackText({ messageType: 'contacts' }), 'Contacto compartido')
  assert.equal(getChatMessageFallbackText({ messageType: 'order' }), 'Pedido compartido')
  assert.equal(getChatMessageFallbackText({ messageType: 'video' }), 'Video')
})

test('explica el contenido que la API del canal no entregó', () => {
  assert.equal(
    getChatMessageFallbackText({
      eventType: 'whatsapp_message',
      messageType: 'unsupported',
      errorCode: '131051'
    }),
    'Contenido no disponible en la API de WhatsApp. Ábrelo en WhatsApp para verlo.'
  )
  assert.equal(
    getChatMessageFallbackText({
      eventType: 'meta_message',
      messageType: 'unknown',
      contentUnavailable: true
    }),
    'Contenido no disponible en la API de Meta. Ábrelo en Instagram o Facebook para verlo.'
  )
})

test('los errores entrantes no se presentan como fallos de envío', () => {
  assert.equal(getVisibleChatMessageError({ direction: 'inbound', errorReason: 'Message type unknown' }), '')
  assert.equal(getVisibleChatMessageError({ direction: 'outbound', errorReason: 'Rejected by provider' }), 'Rejected by provider')
  assert.equal(isOutboundChatMessageFailure({ direction: 'inbound', status: 'failed', errorReason: 'Message type unknown' }), false)
  assert.equal(isOutboundChatMessageFailure({ direction: 'outbound', status: 'failed' }), true)
})

test('oculta recibos y ediciones vacías, pero conserva contenido desconocido', () => {
  assert.equal(shouldHideEmptyChatControlMessage('status'), true)
  assert.equal(shouldHideEmptyChatControlMessage('edit'), true)
  assert.equal(shouldHideEmptyChatControlMessage('unsupported'), false)
})
