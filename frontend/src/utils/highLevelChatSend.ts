export type HighLevelChatSendChannel = 'whatsapp_api' | 'sms_qr' | 'messenger' | 'instagram' | 'email'

export interface HighLevelChatSendOutcome {
  accepted: boolean
  status: 'pending' | 'delivered' | 'read' | 'error'
  rawStatus: string
  requestedChannel: HighLevelChatSendChannel
  effectiveChannel: HighLevelChatSendChannel
  transport: string
  localMessageId: string
  providerMessageId: string
  routeChanged: boolean
  fallbackApplied: boolean
  fallbackReason: string
  replyWindowOpen: boolean | null
  errorReason: string
}

export interface HighLevelWhatsAppRouteMessage {
  id?: unknown
  direction?: unknown
  transport?: unknown
  businessPhone?: unknown
  date?: unknown
}

export interface HighLevelWhatsAppSenderEvidence {
  source: 'verified_inbound'
  fromNumber: string
  messageId: string
  receivedAt: string
}

export interface HighLevelChatFromNumberOptions {
  smsFromNumber?: unknown
  whatsappSender?: HighLevelWhatsAppSenderEvidence | null
}

const HIGHLEVEL_CHAT_CHANNELS = new Set<HighLevelChatSendChannel>([
  'whatsapp_api',
  'sms_qr',
  'messenger',
  'instagram',
  'email'
])

const HIGHLEVEL_FAILURE_STATUSES = new Set([
  'error',
  'failed',
  'failure',
  'undelivered',
  'bounced',
  'rejected'
])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanString(value: unknown) {
  return String(value || '').trim()
}

function normalizeStatus(value: unknown) {
  return cleanString(value).toLowerCase().replace(/[\s-]+/g, '_')
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value)
    if (cleaned) return cleaned
  }
  return ''
}

function normalizeChannel(value: unknown, fallback: HighLevelChatSendChannel): HighLevelChatSendChannel {
  const normalized = normalizeStatus(value) as HighLevelChatSendChannel
  return HIGHLEVEL_CHAT_CHANNELS.has(normalized) ? normalized : fallback
}

function getProviderMessageId(response: Record<string, unknown>, data: Record<string, unknown>) {
  return firstString(
    data.messageId,
    data.remoteMessageId,
    data.id,
    response.messageId,
    response.remoteMessageId,
    response.id
  )
}

function getSortableMessageTime(value: unknown) {
  const timestamp = Date.parse(cleanString(value))
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY
}

/**
 * HighLevel WhatsApp no comparte catálogo con LC Phone/SMS. La única identidad
 * de remitente segura disponible en el chat es `businessPhone` de un inbound
 * durable cuyo transporte ya fue clasificado como `ghl_whatsapp`.
 */
export function getLatestHighLevelWhatsAppInboundSender(
  messages: readonly HighLevelWhatsAppRouteMessage[]
): HighLevelWhatsAppSenderEvidence | null {
  let selected: { evidence: HighLevelWhatsAppSenderEvidence; time: number; index: number } | null = null

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (normalizeStatus(message.direction) !== 'inbound') continue
    const transport = normalizeStatus(message.transport)
    if (transport !== 'ghl_whatsapp' && transport !== 'ghl_whatsapp_api') continue

    const fromNumber = cleanString(message.businessPhone)
    if (!fromNumber) continue

    const evidence: HighLevelWhatsAppSenderEvidence = {
      source: 'verified_inbound',
      fromNumber,
      messageId: cleanString(message.id),
      receivedAt: cleanString(message.date)
    }
    const time = getSortableMessageTime(message.date)
    const shouldReplace = !selected || time > selected.time || (time === selected.time && index > selected.index)
    if (shouldReplace) selected = { evidence, time, index }
  }

  return selected ? selected.evidence : null
}

/**
 * Mantiene dos contratos independientes: SMS usa el remitente LC Phone elegido;
 * WhatsApp usa exclusivamente evidencia inbound de esa conversación.
 */
export function resolveHighLevelChatFromNumber(
  channel: HighLevelChatSendChannel | null | undefined,
  options: HighLevelChatFromNumberOptions = {}
) {
  if (channel === 'whatsapp_api') return cleanString(options.whatsappSender?.fromNumber)
  if (channel === 'sms_qr') return cleanString(options.smsFromNumber)
  return ''
}

export function getHighLevelWhatsAppRouteLabel(sender?: HighLevelWhatsAppSenderEvidence | null) {
  const fromNumber = cleanString(sender?.fromNumber)
  return fromNumber ? `WhatsApp · HighLevel · ${fromNumber}` : 'WhatsApp · HighLevel'
}

/**
 * Un HTTP 200 de HighLevel confirma que el proveedor aceptó la solicitud, no que
 * el teléfono ya recibió el mensaje. Por eso `sent/accepted/queued` permanecen
 * pendientes hasta que la copia durable local reciba delivered/read o failed.
 */
export function getHighLevelChatSendOutcome(
  value: unknown,
  requestedChannel: HighLevelChatSendChannel
): HighLevelChatSendOutcome {
  const response = asRecord(value)
  const nestedData = asRecord(response.data)
  const data = Object.keys(nestedData).length > 0 ? nestedData : response
  const rawStatus = normalizeStatus(firstString(
    data.status,
    data.messageStatus,
    data.message_status,
    data.deliveryStatus,
    data.delivery_status,
    response.status
  ))
  const effectiveChannel = normalizeChannel(
    firstString(data.channel, response.channel),
    requestedChannel
  )
  const explicitFailure = response.success === false || HIGHLEVEL_FAILURE_STATUSES.has(rawStatus)
  const errorReason = firstString(
    data.error,
    data.errorMessage,
    data.error_message,
    data.failureReason,
    data.failure_reason,
    response.error,
    response.errorMessage,
    response.error_message
  )
  const fallbackApplied = data.fallbackApplied === true || response.fallbackApplied === true
  const routeChanged = effectiveChannel !== requestedChannel

  return {
    accepted: !explicitFailure,
    status: explicitFailure
      ? 'error'
      : rawStatus === 'read' || rawStatus === 'seen' || rawStatus === 'opened'
        ? 'read'
        : rawStatus === 'delivered' || rawStatus === 'delivery_ack'
          ? 'delivered'
          : 'pending',
    rawStatus,
    requestedChannel,
    effectiveChannel,
    transport: firstString(data.transport, response.transport),
    localMessageId: firstString(data.localMessageId, response.localMessageId),
    providerMessageId: getProviderMessageId(response, data),
    routeChanged,
    fallbackApplied,
    fallbackReason: firstString(data.fallbackReason, response.fallbackReason),
    replyWindowOpen: typeof data.replyWindowOpen === 'boolean'
      ? data.replyWindowOpen
      : typeof response.replyWindowOpen === 'boolean'
        ? response.replyWindowOpen
        : null,
    errorReason: explicitFailure
      ? errorReason || 'HighLevel rechazó el mensaje después de recibir la solicitud.'
      : ''
  }
}

export function getHighLevelRouteChangeMessage(outcome: HighLevelChatSendOutcome) {
  if (!outcome.routeChanged && !outcome.fallbackApplied) return ''
  if (outcome.requestedChannel === 'whatsapp_api' && outcome.effectiveChannel === 'sms_qr') {
    return 'HighLevel cambió este envío de WhatsApp a SMS. Revisa el canal antes de continuar.'
  }
  return 'HighLevel respondió por un canal distinto al que elegiste. Revisa el envío antes de continuar.'
}
