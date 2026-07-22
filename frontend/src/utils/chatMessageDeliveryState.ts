const CHAT_MESSAGE_SEND_IN_FLIGHT_STATUSES = new Set([
  'sending',
  'enviando',
  'enviando_por_qr'
])

function normalizeChatMessageDeliveryStatus(value?: string | null) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * El loader representa exclusivamente una petición local que todavía no
 * termina. `pending/queued/processing` ya son ACK del proveedor: pueden cambiar
 * después a delivered/read/failed, pero no deben parecer un POST atorado.
 */
export function isChatMessageSendInFlight(status?: string | null) {
  return CHAT_MESSAGE_SEND_IN_FLIGHT_STATUSES.has(normalizeChatMessageDeliveryStatus(status))
}
