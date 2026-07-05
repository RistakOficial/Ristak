import type { ChatAttachment, ChatContact, ChatLocation, JourneyEvent, ChatMessage } from './types';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const CHAT_SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function cleanBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function getContactName(contact?: ChatContact | null) {
  if (!contact) return 'Contacto';
  const directName = [
    contact.name,
    contact.contactName,
    contact.displayName,
    contact.fullName,
    contact.full_name,
    contact.profileName,
    contact.socialName,
  ].map((value) => String(value || '').trim()).find(Boolean);
  if (directName) return directName;

  const first = String(contact.firstName || contact.first_name || '').trim();
  const last = String(contact.lastName || contact.last_name || '').trim();
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || contact.phone || contact.email || 'Contacto';
}

export function getContactAvatar(contact?: ChatContact | null) {
  return contact?.profilePhotoUrl || contact?.avatarUrl || contact?.photoUrl || contact?.pictureUrl || '';
}

export function formatShortDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
  });
}

export function resolveBusinessTimezone(value?: string | null) {
  const timezone = String(value || '').trim() || DEFAULT_BUSINESS_TIMEZONE;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_BUSINESS_TIMEZONE;
  }
}

function getZonedDateParts(value: string | Date, timezone?: string | null) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const resolvedTimezone = resolveBusinessTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const partValue = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = partValue('year');
  const month = partValue('month');
  const day = partValue('day');
  if (!year || !month || !day) return null;
  return { date, year, month, day, timezone: resolvedTimezone };
}

function dateOnlyUtcDay(parts: { year: number; month: number; day: number }) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

export function formatChatListDate(value?: string | null, timezone?: string | null, referenceDate: Date = new Date()) {
  if (!value) return '';
  const messageParts = getZonedDateParts(value, timezone);
  if (!messageParts) return '';
  const todayParts = getZonedDateParts(referenceDate, messageParts.timezone);
  if (!todayParts) return '';

  const diffDays = Math.round((dateOnlyUtcDay(todayParts) - dateOnlyUtcDay(messageParts)) / 86400000);
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: messageParts.timezone,
      weekday: 'long',
    }).format(messageParts.date);
  }

  const month = CHAT_SHORT_MONTHS[messageParts.month - 1] || '';
  if (!month) return '';
  return `${String(messageParts.day).padStart(2, '0')}-${month}`;
}

export function formatMessageTime(value?: string | null, timezone?: string | null) {
  if (!value) return '';
  const parts = getZonedDateParts(value, timezone);
  if (!parts) return '';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: parts.timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(parts.date);
}

export function formatConversationDayLabel(value?: string | null, timezone?: string | null, referenceDate: Date = new Date()) {
  if (!value) return '';
  const messageParts = getZonedDateParts(value, timezone);
  if (!messageParts) return '';
  const todayParts = getZonedDateParts(referenceDate, messageParts.timezone);
  if (!todayParts) return '';

  const diffDays = Math.round((dateOnlyUtcDay(todayParts) - dateOnlyUtcDay(messageParts)) / 86400000);
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: messageParts.timezone,
      weekday: 'long',
    }).format(messageParts.date);
  }

  return new Intl.DateTimeFormat('es-MX', {
    timeZone: messageParts.timezone,
    day: '2-digit',
    month: 'short',
    year: todayParts.year === messageParts.year ? undefined : 'numeric',
  }).format(messageParts.date).replace('.', '');
}

export function getConversationDayKey(value?: string | null, timezone?: string | null) {
  const parts = value ? getZonedDateParts(value, timezone) : null;
  if (!parts) return 'sin-fecha';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function formatCurrency(value?: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

export function getTodayRange(days = 30) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - Math.max(0, days - 1));

  const toDateOnly = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  return {
    startDate: toDateOnly(start),
    endDate: toDateOnly(end),
  };
}

function readString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNumber(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (value === null || value === undefined || value === '') continue;
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function readBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'si', 'sí'].includes(normalized);
}

function pickNestedRecord(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  }
  return null;
}

function pickMessageTimestamp(data: Record<string, unknown>, keys: string[]) {
  const value = readString(data, keys);
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function pickMediaUrl(data: Record<string, unknown>) {
  return readString(data, [
    'media_url',
    'mediaUrl',
    'media_link',
    'mediaLink',
    'image_url',
    'imageUrl',
    'video_url',
    'videoUrl',
    'audio_url',
    'audioUrl',
    'document_url',
    'documentUrl',
    'file_url',
    'fileUrl',
    'url',
    'link',
    'publicUrl',
    'public_url',
  ]);
}

function getAttachmentFallbackName(type: ChatAttachment['type'], name = '', mediaId = '') {
  if (name) return name;
  if (mediaId) return mediaId;
  if (type === 'image') return 'Foto';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  return 'Documento';
}

function getMediaAttachmentType(messageType = '', mimeType = '', filename = '', mediaUrl = ''): ChatAttachment['type'] | '' {
  const probe = [messageType, mimeType, filename, mediaUrl].filter(Boolean).join(' ').toLowerCase();
  if (!probe) return '';
  if (probe.includes('image') || probe.includes('photo') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(probe)) return 'image';
  if (probe.includes('video') || /\.(mp4|mov|m4v|webm)(\?|$)/i.test(probe)) return 'video';
  if (probe.includes('audio') || probe.includes('voice') || /\.(mp3|m4a|ogg|wav|aac)(\?|$)/i.test(probe)) return 'audio';
  if (probe.includes('document') || probe.includes('file') || /\.(pdf|docx?|xlsx?|pptx?|csv|txt)(\?|$)/i.test(probe)) return 'document';
  return '';
}

function getJourneyMediaAttachment(data: Record<string, unknown>): ChatAttachment | undefined {
  const nestedMedia = pickNestedRecord(data, ['media', 'attachment', 'file', 'document', 'image', 'video', 'audio']);
  const source = nestedMedia ? { ...data, ...nestedMedia } : data;
  const messageType = readString(source, ['message_type', 'messageType', 'type']);
  const mimeType = readString(source, ['media_mime_type', 'mediaMimeType', 'mimeType', 'mime_type', 'mimetype']);
  const name = readString(source, ['media_filename', 'mediaFilename', 'filename', 'fileName', 'name']);
  const mediaId = readString(source, ['media_id', 'mediaId', 'id']);
  const url = pickMediaUrl(source);
  const attachmentType = getMediaAttachmentType(messageType, mimeType, name, url);
  if (!attachmentType || (!url && !mediaId)) return undefined;

  return {
    type: attachmentType,
    url,
    name: getAttachmentFallbackName(attachmentType, name, mediaId),
    mimeType,
    isGif: attachmentType === 'image' && [messageType, mimeType, name, url].join(' ').toLowerCase().includes('gif'),
    durationMs: readNumber(source, ['durationMs', 'duration_ms', 'audio_duration_ms']) || undefined,
  };
}

function buildLocationUrl(location: Pick<ChatLocation, 'latitude' | 'longitude'>) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
}

function normalizeLocationValue(value: unknown): ChatLocation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const location = value as Record<string, unknown>;
  const latitude = readNumber(location, ['latitude', 'lat', 'degreesLatitude', 'degrees_latitude']);
  const longitude = readNumber(location, ['longitude', 'lng', 'lon', 'degreesLongitude', 'degrees_longitude']);
  if (latitude === null || longitude === null) return undefined;
  const normalized = {
    latitude,
    longitude,
    name: readString(location, ['name', 'title']) || undefined,
    address: readString(location, ['address', 'description']) || undefined,
    url: readString(location, ['url', 'href']) || undefined,
  };
  return {
    ...normalized,
    url: normalized.url || buildLocationUrl(normalized),
  };
}

function getJourneyLocation(data: Record<string, unknown>) {
  const direct = normalizeLocationValue({
    latitude: data.location_latitude ?? data.locationLatitude ?? data.latitude ?? data.lat,
    longitude: data.location_longitude ?? data.locationLongitude ?? data.longitude ?? data.lng ?? data.lon,
    name: data.location_name || data.locationName || data.name,
    address: data.location_address || data.locationAddress || data.address,
    url: data.location_url || data.locationUrl || data.url,
  });
  if (direct) return direct;

  const candidates = [
    data.location,
    data.locationMessage,
    data.whatsappMessage && typeof data.whatsappMessage === 'object' ? (data.whatsappMessage as Record<string, unknown>).location : null,
    data.whatsappInboundMessage && typeof data.whatsappInboundMessage === 'object' ? (data.whatsappInboundMessage as Record<string, unknown>).location : null,
    data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>).location : null,
    data.response && typeof data.response === 'object' ? (data.response as Record<string, unknown>).location : null,
    data.request && typeof data.request === 'object' ? (data.request as Record<string, unknown>).location : null,
  ];
  for (const candidate of candidates) {
    const location = normalizeLocationValue(candidate);
    if (location) return location;
  }
  return undefined;
}

function getMediaFallback(data: Record<string, unknown>) {
  const type = readString(data, ['message_type', 'type']).toLowerCase();
  const filename = readString(data, ['media_filename', 'filename', 'fileName']);
  if (filename) return filename;
  if (type.includes('image') || type.includes('photo')) return 'Foto';
  if (type.includes('video')) return 'Video';
  if (type.includes('audio') || type.includes('voice')) return 'Audio';
  if (type.includes('document') || type.includes('file')) return 'Documento';
  return 'Mensaje';
}

function cleanAttachmentMessageText(text: string, attachment?: ChatAttachment) {
  if (!attachment) return text;
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return '';
  const fallback = getAttachmentFallbackName(attachment.type, attachment.name || '').toLowerCase();
  return normalized === fallback || ['foto', 'video', 'audio', 'documento', 'archivo'].includes(normalized) ? '' : text;
}

function cleanLocationMessageText(text: string, location?: ChatLocation) {
  if (!location) return text;
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || ['ubicacion', 'ubicación', 'location'].includes(normalized)) return '';
  return text;
}

function normalizeDirection(value?: string) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'outbound' || normalized === 'sent') return 'outbound';
  if (normalized === 'system') return 'system';
  return 'inbound';
}

function isCommentMessageType(messageType = '') {
  return ['comment', 'comment_reply_public', 'comment_reply_private'].includes(String(messageType || '').trim().toLowerCase());
}

function getCommentFallbackText(messageType = '', status: string | undefined = '', postDeleted = false) {
  const normalizedType = String(messageType || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!isCommentMessageType(normalizedType)) return '';
  if (postDeleted || ['removed', 'deleted', 'delete', 'remove', 'hide', 'hidden'].includes(normalizedStatus)) return 'Comentario eliminado';
  if (normalizedType === 'comment_reply_public') return 'Respuesta pública al comentario';
  if (normalizedType === 'comment_reply_private') return 'Respuesta por privado al comentario';
  return 'Comentario sin texto';
}

function getMessageProviderId(message: ChatMessage) {
  return message.providerMessageId || message.id;
}

function mergeChatMessagesById(messages: ChatMessage[]) {
  const merged = new Map<string, ChatMessage>();
  messages.forEach((message) => {
    if (message.id) merged.set(message.id, message);
  });

  const mergedMessages = Array.from(merged.values());
  const byLocalId = new Map(mergedMessages.map((message) => [message.id, message]));
  const byProviderId = new Map(
    mergedMessages
      .map((message) => [getMessageProviderId(message), message] as const)
      .filter(([providerId]) => Boolean(providerId)),
  );
  const visibleMessages: ChatMessage[] = [];

  mergedMessages.forEach((message) => {
    if (String(message.messageType || '').toLowerCase() === 'reaction' && message.reactionEmoji) {
      const target = (message.reactionTargetMessageId ? byLocalId.get(message.reactionTargetMessageId) : null)
        || (message.reactionTargetProviderMessageId ? byProviderId.get(message.reactionTargetProviderMessageId) : null);
      if (target) {
        const updatedTarget = {
          ...target,
          reactions: [
            ...(target.reactions || []).filter((reaction) => reaction.id !== message.id),
            { id: message.id, emoji: message.reactionEmoji, direction: message.direction },
          ],
        };
        byLocalId.set(updatedTarget.id, updatedTarget);
        byProviderId.set(getMessageProviderId(updatedTarget), updatedTarget);
        return;
      }
    }
    visibleMessages.push(message);
  });

  return visibleMessages
    .map((message) => byLocalId.get(message.id) || message)
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
}

export function buildMessagesFromJourney(contactId: string, events: JourneyEvent[]) {
  const messages = events
    .filter((event) => event && typeof event === 'object' && event.date)
    .map((event, index): ChatMessage | null => {
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'appointment_confirmation') {
        return {
          id: readString(data, ['id', 'appointment_id']) || `appointment-confirmation-${index}`,
          contactId,
          date: event.date,
          direction: 'system',
          text: `Cita confirmada${readString(data, ['title']) ? `: ${readString(data, ['title'])}` : ''}`,
          channel: event.type,
          status: 'confirmed',
        };
      }

      const isSupportedMessage = ['whatsapp_message', 'meta_message', 'email_message'].includes(event.type);
      if (!isSupportedMessage) return null;

      const messageType = readString(data, ['message_type', 'messageType', 'type']);
      const status = readString(data, ['status']);
      const attachment = getJourneyMediaAttachment(data);
      const location = getJourneyLocation(data);
      const rawText = readString(data, [
        'message_text',
        'message',
        'text',
        'body',
        'subject',
        'caption',
      ]);
      const postDeleted = readBoolean(data.post_deleted || data.postDeleted || data.post_removed || data.postRemoved || data.post_unavailable || data.postUnavailable);
      const text = cleanLocationMessageText(
        cleanAttachmentMessageText(rawText, attachment),
        location,
      ) || getCommentFallbackText(messageType, status, postDeleted) || (attachment || location ? '' : getMediaFallback(data));
      if (!text && !messageType && !attachment && !location) return null;

      const id = readString(data, [
        'whatsapp_api_message_id',
        'whatsapp_message_id',
        'meta_social_message_id',
        'meta_message_id',
        'email_message_id',
        'attribution_record_id',
      ]) || `${event.type}-${event.date}-${index}`;
      const normalizedMessageType = messageType.trim().toLowerCase();

      return {
        id,
        contactId,
        date: event.date,
        direction: normalizeDirection(readString(data, ['direction'])),
        text,
        channel: readString(data, ['transport', 'social_platform', 'source']) || event.type,
        transport: readString(data, ['transport', 'social_platform', 'source']) || event.type,
        status: readString(data, ['status']),
        errorReason: readString(data, ['error_reason', 'errorReason', 'error', 'message_error']),
        providerMessageId: readString(data, ['provider_message_id', 'providerMessageId', 'whatsapp_message_id', 'meta_message_id']),
        sentAt: pickMessageTimestamp(data, ['sent_at', 'sentAt', 'message_sent_at', 'messageSentAt', 'created_at', 'createdAt', 'timestamp']) || event.date,
        deliveredAt: pickMessageTimestamp(data, ['delivered_at', 'deliveredAt', 'delivery_at', 'deliveryAt', 'message_delivered_at', 'messageDeliveredAt']),
        readAt: pickMessageTimestamp(data, ['read_at', 'readAt', 'seen_at', 'seenAt', 'message_read_at', 'messageReadAt', 'played_at', 'playedAt']),
        businessPhone: readString(data, ['business_phone', 'businessPhone']),
        businessPhoneNumberId: readString(data, ['business_phone_number_id', 'businessPhoneNumberId']),
        routingReason: readString(data, ['routing_reason', 'routingReason', 'fallbackReason']),
        messageType,
        replyToProviderMessageId: readString(data, ['reply_to_provider_message_id', 'replyToProviderMessageId']),
        reactionEmoji: readString(data, ['reaction_emoji', 'reactionEmoji']),
        reactionTargetProviderMessageId: readString(data, ['reaction_target_provider_message_id', 'reactionTargetProviderMessageId']),
        attachment,
        location,
        isComment: isCommentMessageType(messageType),
        commentReplyMode: normalizedMessageType === 'comment_reply_public'
          ? 'public'
          : normalizedMessageType === 'comment_reply_private'
            ? 'private'
            : undefined,
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));

  return mergeChatMessagesById(messages);
}
