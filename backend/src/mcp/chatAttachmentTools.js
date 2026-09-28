import { ATTACHMENT_WIDGET_URI } from './attachmentConstants.js'
import { openMcpChatAttachment } from '../services/mcpChatAttachmentService.js'

const ID = { type: 'string', minLength: 1, maxLength: 180 }
export const chatAttachmentToolSpecs = [Object.freeze({
  name: 'chat_open_attachment', title: 'Abrir adjunto del chat',
  description: 'Abre imágenes, videos, audio, PDFs y documentos de un mensaje de WhatsApp, Messenger o Instagram. Primero lee chat_get_conversation: usa contactId y whatsapp_api_message_id (source=whatsapp) o meta_social_message_id (source=meta), nunca el ID del proveedor. Devuelve visor, descarga temporal del original y páginas PDF como imágenes y texto para leer incluso escaneos sin depender del navegador/CDN. PDF: hasta 3 páginas por llamada; usa page para continuar cuando hasMorePages=true. Una vista parcial, fallida o un reproductor no confirma el contenido completo. No inventes datos de archivos que no pudiste leer.',
  module: 'chat', additionalModules: ['contacts'], access: 'read', scope: 'ristak.read', risk: 'low',
  featureKeys: [], adminOnly: false, confirmRequired: false, idempotencyRequired: false,
  uiResourceUri: ATTACHMENT_WIDGET_URI,
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { contactId: ID, messageId: ID, source: { type: 'string', enum: ['whatsapp', 'meta'] },
      page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
      pageCount: { type: 'integer', minimum: 1, maximum: 3, default: 3 } },
    required: ['contactId', 'messageId', 'source'] },
  execute: openMcpChatAttachment
})]
