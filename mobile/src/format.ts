import type { ChatContact, JourneyEvent, ChatMessage } from './types';

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
  const fullName = String(contact.fullName || contact.full_name || '').trim();
  if (fullName) return fullName;

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

export function buildMessagesFromJourney(contactId: string, events: JourneyEvent[]) {
  return events
    .filter((event) => event && typeof event === 'object' && event.date)
    .map((event, index): ChatMessage => {
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const directionRaw = readString(data, ['direction']).toLowerCase();
      const direction = directionRaw === 'outbound' || directionRaw === 'sent' ? 'outbound' : 'inbound';
      const text = readString(data, [
        'message_text',
        'text',
        'body',
        'subject',
        'caption',
      ]) || getMediaFallback(data);
      const id = readString(data, [
        'whatsapp_api_message_id',
        'whatsapp_message_id',
        'meta_social_message_id',
        'meta_message_id',
        'email_message_id',
      ]) || `${event.type}-${event.date}-${index}`;

      return {
        id,
        contactId,
        date: event.date,
        direction,
        text,
        channel: readString(data, ['transport', 'social_platform', 'source']) || event.type,
        status: readString(data, ['status']),
      };
    });
}
