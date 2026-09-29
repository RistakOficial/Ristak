// Campos de identidad que siguen siendo útiles después de anular un mensaje.
// Una lista permitida evita revivir media desde plantillas, atribución o payloads legacy.
const IDENTITY_FIELDS = [
  'source', 'social_platform', 'sender_id', 'recipient_id', 'page_id', 'instagram_account_id',
  'phone', 'from_phone', 'to_phone', 'business_phone', 'business_phone_number_id',
  'transport', 'provider', 'source_adapter', 'direction',
  'whatsapp_api_message_id', 'whatsapp_message_id', 'meta_social_message_id',
  'meta_message_id', 'provider_message_id'
]

export function redactRemovedChatMessage(data = {}) {
  if (!['removed', 'deleted'].includes(String(data.status || '').toLowerCase())) return data
  if (String(data.message_type || '').startsWith('comment')) return data
  return {
    ...Object.fromEntries(IDENTITY_FIELDS.filter(key => key in data).map(key => [key, data[key]])),
    status: 'removed', message_type: 'text', message_text: 'Mensaje eliminado'
  }
}
