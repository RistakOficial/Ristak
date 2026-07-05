import type { ChatContact, JourneyEvent, ChatMessage } from './types';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const CHAT_SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

export function normalizeCurrencyCode(value?: string | null) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
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

function getDateOnlyParts(value: string) {
  if (!DATE_ONLY_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function dateOnlyUtcDay(parts: { year: number; month: number; day: number }) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

export function dateOnlyInTimezone(value: Date = new Date(), timezone?: string | null) {
  const parts = getZonedDateParts(value, timezone);
  if (!parts) return '';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function addDateOnlyDays(dateOnly: string, days: number) {
  const parts = getDateOnlyParts(dateOnly);
  if (!parts) return dateOnly;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function addDateOnlyMonths(dateOnly: string, months: number) {
  const parts = getDateOnlyParts(dateOnly);
  if (!parts) return dateOnly;
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, parts.day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function getBusinessDateRange(days: number, timezone?: string | null) {
  const endDate = dateOnlyInTimezone(new Date(), timezone);
  const safeDays = Math.max(0, Math.floor(days));
  const startDate = safeDays > 1 ? addDateOnlyDays(endDate, -(safeDays - 1)) : endDate;
  return { startDate, endDate };
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

export function formatCurrency(value?: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

export function formatPaymentDate(value?: string | null, timezone?: string | null) {
  if (!value) return 'Sin fecha';
  const resolvedTimezone = resolveBusinessTimezone(timezone);

  if (DATE_ONLY_PATTERN.test(value)) {
    const parts = getDateOnlyParts(value);
    if (!parts) return 'Sin fecha';
    const month = CHAT_SHORT_MONTHS[parts.month - 1] || '';
    return month ? `${parts.day} ${month}` : value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';

  return new Intl.DateTimeFormat('es-MX', {
    timeZone: resolvedTimezone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function getPaymentMethodLabel(method?: string | null) {
  const normalized = String(method || '').toLowerCase();
  if (normalized === 'card') return 'Tarjeta';
  if (normalized === 'transfer' || normalized === 'bank_transfer') return 'Transferencia';
  if (normalized === 'cash') return 'Efectivo';
  if (normalized === 'check') return 'Cheque';
  if (normalized === 'paypal') return 'PayPal';
  if (normalized.includes('stripe')) return 'Stripe';
  if (normalized.includes('conekta')) return 'Conekta';
  if (normalized.includes('mercadopago')) return 'Mercado Pago';
  if (normalized.includes('clip')) return 'CLIP';
  if (normalized.includes('rebill')) return 'Rebill';
  if (normalized.includes('link')) return 'Link';
  return method || 'Otro';
}

export function getPaymentStatusLabel(status?: string | null) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid') return 'Pagado';
  if (normalized === 'partial') return 'Parcial';
  if (normalized === 'refunded') return 'Reembolsado';
  if (normalized === 'failed') return 'Fallido';
  if (normalized === 'pending') return 'Pendiente';
  if (normalized === 'sent') return 'Enviado';
  if (normalized === 'draft') return 'Borrador';
  return status || 'Sin estado';
}

export function getTodayRange(days = 30, timezone?: string | null) {
  return getBusinessDateRange(days, timezone);
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
