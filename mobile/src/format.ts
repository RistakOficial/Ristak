import type { ChatAttachment, ChatContact, ChatLocation, JourneyEvent, ChatMessage } from './types';

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const CHAT_SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const CALENDAR_MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const CALENDAR_SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const BUSINESS_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// SQLite stores CRM instants in UTC and commonly returns them as
// `YYYY-MM-DD HH:mm:ss`. Hermes/Android does not interpret that format
// consistently: depending on the runtime it can be invalid or treated as the
// phone's local time. Normalize those server timestamps before sorting or
// formatting so every mobile surface sees the same instant as the backend.
export function parseSortableDateValue(value?: unknown): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const raw = String(value || '').trim();
  if (!raw) return 0;

  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T00:00:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(raw)) {
    const withDateSeparator = raw.replace(/\s+/, 'T');
    const withNormalizedOffset = withDateSeparator
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
      .replace(/([+-]\d{2})$/, '$1:00');
    normalized = /[zZ]$|[+-]\d{2}:\d{2}$/.test(withNormalizedOffset)
      ? withNormalizedOffset
      : `${withNormalizedOffset}Z`;
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseServerDate(value: string | Date) {
  if (value instanceof Date) return value;
  const timestamp = parseSortableDateValue(value);
  return timestamp ? new Date(timestamp) : new Date(Number.NaN);
}

export type BusinessDateParts = {
  date: Date;
  year: number;
  month: number;
  day: number;
  timezone: string;
};

export type CalendarMonthCell = {
  dateOnly: string;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
};

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

export function resolveAppMediaUrl(value: string, appBaseUrl = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^(data:|file:|blob:|https?:\/\/)/i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith('/')) return trimmed;
  const base = cleanBaseUrl(appBaseUrl);
  return base ? `${base}${trimmed}` : trimmed;
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
  const date = parseServerDate(value);
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
  const date = parseServerDate(value);
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

function getZonedDateTimeParts(value: string | Date, timezone?: string | null) {
  const date = parseServerDate(value);
  if (Number.isNaN(date.getTime())) return null;
  const resolvedTimezone = resolveBusinessTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const partValue = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const year = partValue('year');
  const month = partValue('month');
  const day = partValue('day');
  const hour = partValue('hour');
  const minute = partValue('minute');
  const second = partValue('second');
  if (!year || !month || !day || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return { date, year, month, day, hour, minute, second, timezone: resolvedTimezone };
}

function dateOnlyUtcDay(parts: { year: number; month: number; day: number }) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function padDatePart(value: number) {
  return String(value).padStart(2, '0');
}

export function formatDateOnlyParts(parts: { year: number; month: number; day: number }) {
  return `${parts.year}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`;
}

export function parseDateOnly(value?: string | null) {
  const match = String(value || '').match(BUSINESS_DATE_ONLY_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function getBusinessDateParts(value: string | Date, timezone?: string | null) {
  return getZonedDateParts(value, timezone);
}

export function getBusinessDateTimeParts(value: string | Date, timezone?: string | null) {
  return getZonedDateTimeParts(value, timezone);
}

export function getBusinessDateOnly(value: string | Date, timezone?: string | null) {
  const parts = getBusinessDateParts(value, timezone);
  return parts ? formatDateOnlyParts(parts) : '';
}

export function todayDateOnlyInBusinessTimezone(timezone?: string | null, referenceDate: Date = new Date()) {
  return getBusinessDateOnly(referenceDate, timezone);
}

export function dateOnlyToCalendarDate(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return null;
  return new Date(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0, 0);
}

export function dateOnlyFromCalendarDate(date: Date) {
  if (Number.isNaN(date.getTime())) return '';
  return formatDateOnlyParts({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

export function addBusinessDateOnlyDays(value: string, days: number) {
  const date = dateOnlyToCalendarDate(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return dateOnlyFromCalendarDate(date);
}

export function addBusinessDateOnlyMonths(value: string, months: number) {
  const date = dateOnlyToCalendarDate(value);
  if (!date) return value;
  date.setMonth(date.getMonth() + months, 1);
  return dateOnlyFromCalendarDate(date);
}

export function getBusinessMonthRange(value: string) {
  const date = dateOnlyToCalendarDate(value) || new Date();
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1, 12, 0, 0, 0);
  const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12, 0, 0, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - monthStart.getDay());
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()));

  return {
    monthStart: dateOnlyFromCalendarDate(monthStart),
    monthEnd: dateOnlyFromCalendarDate(monthEnd),
    gridStart: dateOnlyFromCalendarDate(gridStart),
    gridEnd: dateOnlyFromCalendarDate(gridEnd),
  };
}

export function buildBusinessMonthCells(monthDateOnly: string, todayDateOnly: string) {
  const date = dateOnlyToCalendarDate(monthDateOnly) || new Date();
  const monthIndex = date.getMonth();
  const range = getBusinessMonthRange(monthDateOnly);
  const cells: CalendarMonthCell[] = [];
  let cursor = range.gridStart;

  while (true) {
    const cursorDate = dateOnlyToCalendarDate(cursor);
    if (!cursorDate) break;
    cells.push({
      dateOnly: cursor,
      day: cursorDate.getDate(),
      isCurrentMonth: cursorDate.getMonth() === monthIndex,
      isToday: cursor === todayDateOnly,
    });
    if (cursor === range.gridEnd) break;
    cursor = addBusinessDateOnlyDays(cursor, 1);
  }

  return cells;
}

export function formatBusinessMonthTitle(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return 'Calendario';
  return CALENDAR_MONTHS[parsed.month - 1] || 'Calendario';
}

export function formatBusinessShortMonthTitle(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return '';
  return CALENDAR_SHORT_MONTHS[parsed.month - 1] || '';
}

export function formatBusinessYear(value: string) {
  const parsed = parseDateOnly(value);
  return parsed ? String(parsed.year) : '';
}

export function formatBusinessDayHeader(value: string) {
  const date = dateOnlyToCalendarDate(value);
  if (!date) return '';
  const weekday = new Intl.DateTimeFormat('es-MX', { weekday: 'long' }).format(date);
  const month = CALENDAR_MONTHS[date.getMonth()] || '';
  return `${weekday}, ${date.getDate()} de ${month}`;
}

export function formatCalendarEventTime(value?: string | null, timezone?: string | null) {
  if (!value) return '';
  const date = parseServerDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: resolveBusinessTimezone(timezone),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatCalendarEventTimeRange(
  startValue?: string | null,
  endValue?: string | null,
  timezone?: string | null,
) {
  const start = formatCalendarEventTime(startValue, timezone);
  const end = formatCalendarEventTime(endValue, timezone);
  if (start && end && start !== end) return `${start} - ${end}`;
  return start || end || '';
}

export function formatCompactBusinessDate(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return '';
  const month = CALENDAR_SHORT_MONTHS[parsed.month - 1] || '';
  return month ? `${String(parsed.day).padStart(2, '0')}-${month}` : '';
}

function parseTimeInput(value?: string | null) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function timezoneOffsetMs(utcDate: Date, timezone: string) {
  const parts = getBusinessDateTimeParts(utcDate, timezone);
  if (!parts) return 0;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcDate.getTime();
}

export function localBusinessDateTimeToUTCISOString(dateOnly: string, time: string, timezone?: string | null) {
  const dateParts = parseDateOnly(dateOnly);
  const timeParts = parseTimeInput(time);
  if (!dateParts || !timeParts) return '';

  const resolvedTimezone = resolveBusinessTimezone(timezone);
  const localAsUtcMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    0,
    0,
  );
  let utcMs = localAsUtcMs - timezoneOffsetMs(new Date(localAsUtcMs), resolvedTimezone);
  utcMs = localAsUtcMs - timezoneOffsetMs(new Date(utcMs), resolvedTimezone);
  const result = new Date(utcMs);
  return Number.isNaN(result.getTime()) ? '' : result.toISOString();
}

export function isoToBusinessDateTimeFields(value?: string | null, timezone?: string | null) {
  const parts = value ? getBusinessDateTimeParts(value, timezone) : null;
  if (!parts) return { dateOnly: '', time: '' };
  return {
    dateOnly: formatDateOnlyParts(parts),
    time: `${padDatePart(parts.hour)}:${padDatePart(parts.minute)}`,
  };
}

export function addMinutesToBusinessDateTime(dateOnly: string, time: string, minutes: number) {
  const dateParts = parseDateOnly(dateOnly);
  const timeParts = parseTimeInput(time);
  if (!dateParts || !timeParts) return { dateOnly, time };
  const next = new Date(Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    0,
    0,
  ) + Math.max(1, minutes) * 60000);
  return {
    dateOnly: formatDateOnlyParts({
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
    }),
    time: `${padDatePart(next.getUTCHours())}:${padDatePart(next.getUTCMinutes())}`,
  };
}

export function formatChatListDate(value?: string | null, timezone?: string | null, referenceDate: Date = new Date()) {
  if (!value) return '';
  const messageParts = getZonedDateParts(value, timezone);
  if (!messageParts) return '';
  const todayParts = getZonedDateParts(referenceDate, messageParts.timezone);
  if (!todayParts) return '';

  const diffDays = Math.round((dateOnlyUtcDay(todayParts) - dateOnlyUtcDay(messageParts)) / 86400000);
  if (diffDays === 0) return formatMessageTime(value, messageParts.timezone);
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
    hour: 'numeric',
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

export function formatNumber(value?: number) {
  return new Intl.NumberFormat('es-MX', {
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function formatRoas(value?: number) {
  return `${Number(value || 0).toFixed(2)}x`;
}

export function formatCompactNumber(value?: number) {
  return new Intl.NumberFormat('es-MX', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

export function formatCompactCurrency(value: number | undefined, currency: string) {
  return new Intl.NumberFormat('es-MX', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    style: 'currency',
    currency,
  }).format(Number(value || 0));
}

export function normalizeCurrencyCode(value?: string | null) {
  const currency = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return 'MXN';
  try {
    new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(0);
    return currency;
  } catch {
    return 'MXN';
  }
}

function dateOnlyFromParts(parts: { year: number; month: number; day: number }) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function todayDateOnlyInTimezone(timezone?: string | null, referenceDate: Date = new Date()) {
  const parts = getZonedDateParts(referenceDate, timezone);
  return parts ? dateOnlyFromParts(parts) : dateOnlyFromParts(getZonedDateParts(referenceDate, DEFAULT_BUSINESS_TIMEZONE)!);
}

function addDaysToDateOnly(dateOnly: string, offsetDays: number) {
  const [year, month, day] = dateOnly.split('-').map((part) => Number(part));
  if (!year || !month || !day) return dateOnly;
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function getTodayRange(days = 30, timezone?: string | null) {
  const endDate = todayDateOnlyInTimezone(resolveBusinessTimezone(timezone));
  const startDate = addDaysToDateOnly(endDate, -Math.max(0, days - 1));

  return {
    startDate,
    endDate,
  };
}

export function dateOnlyInTimezone(value: Date = new Date(), timezone?: string | null) {
  return getBusinessDateOnly(value, timezone);
}

export function addDateOnlyDays(dateOnly: string, days: number) {
  return addDaysToDateOnly(dateOnly, days);
}

export function addDateOnlyMonths(dateOnly: string, months: number) {
  const parsed = parseDateOnly(dateOnly);
  if (!parsed) return dateOnly;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1 + months, parsed.day));
  return formatDateOnlyParts({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

export function getBusinessDateRange(days: number, timezone?: string | null) {
  const endDate = dateOnlyInTimezone(new Date(), timezone);
  const safeDays = Math.max(0, Math.floor(days));
  const startDate = safeDays > 1 ? addDateOnlyDays(endDate, -(safeDays - 1)) : endDate;
  return { startDate, endDate };
}

export function formatPaymentDate(value?: string | null, timezone?: string | null) {
  if (!value) return 'Sin fecha';
  const parsedDateOnly = parseDateOnly(value);
  if (parsedDateOnly) {
    const month = CHAT_SHORT_MONTHS[parsedDateOnly.month - 1] || '';
    return month ? `${parsedDateOnly.day} ${month}` : value;
  }

  const parts = getBusinessDateTimeParts(value, timezone);
  if (!parts) return 'Sin fecha';
  const month = CHAT_SHORT_MONTHS[parts.month - 1] || '';
  const hour = parts.hour % 12 || 12;
  const suffix = parts.hour >= 12 ? 'p.m.' : 'a.m.';
  return `${parts.day} ${month} ${hour}:${String(parts.minute).padStart(2, '0')} ${suffix}`;
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

function readString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

// Los ids del backend pueden llegar como INTEGER (p. ej. attribution_record_id);
// readString los descartaría y el mensaje caería al id sintético.
function readIdString(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

// Huella corta y determinista para ids sintéticos: debe depender solo del
// contenido del evento, nunca de su posición en la página (los índices cambian
// con cada poll y rompen las keys del FlatList).
function hashConversationEventContent(value: string) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
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

function getJourneyAgentMessageMetadata(data: Record<string, unknown>) {
  const agentId = readString(data, ['agent_id', 'agentId']);
  return {
    sentByAgent: readBoolean(data.sent_by_agent || data.sentByAgent || data.answered_by_agent || data.answeredByAgent) || Boolean(agentId),
    agentId: agentId || undefined,
  };
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
  const timestamp = parseSortableDateValue(value);
  return timestamp ? new Date(timestamp).toISOString() : '';
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

function getJourneyMediaAttachment(data: Record<string, unknown>, appBaseUrl = ''): ChatAttachment | undefined {
  const nestedMedia = pickNestedRecord(data, ['media', 'attachment', 'file', 'document', 'image', 'video', 'audio']);
  const source = nestedMedia ? { ...data, ...nestedMedia } : data;
  const messageType = readString(source, ['message_type', 'messageType', 'type']);
  const mimeType = readString(source, ['media_mime_type', 'mediaMimeType', 'mimeType', 'mime_type', 'mimetype']);
  const name = readString(source, ['media_filename', 'mediaFilename', 'filename', 'fileName', 'name']);
  const mediaId = readString(source, ['media_id', 'mediaId', 'id']);
  const url = resolveAppMediaUrl(pickMediaUrl(source), appBaseUrl);
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

function cleanRedundantRoutingMessageText(text: string) {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (
    normalized === 'capturado desde la sesión de whatsapp web.' ||
    normalized === 'capturado desde la sesion de whatsapp web.' ||
    normalized === 'capturado desde la sesión api.' ||
    normalized === 'capturado desde la sesion api.' ||
    normalized === 'capturado desde la api.' ||
    normalized === 'capturado desde whatsapp api.'
  ) {
    return '';
  }
  return text;
}

function normalizeEmailBodyText(value = '') {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToPlainEmailText(html = '') {
  const value = String(html || '').trim();
  if (!value) return '';
  return normalizeEmailBodyText(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

function buildEmailMessageText(subject = '', body = '') {
  const cleanSubject = String(subject || '').replace(/\s+/g, ' ').trim();
  const cleanBody = normalizeEmailBodyText(body);
  if (cleanSubject && cleanBody) return `${cleanSubject}\n${cleanBody}`;
  return cleanSubject || cleanBody || 'Correo electrónico';
}

function buildJourneyEmailDetails(data: Record<string, unknown>, status = ''): ChatMessage['emailDetails'] | undefined {
  const bodyHtml = readString(data, ['html_body', 'htmlBody', 'html', 'body_html', 'bodyHtml']);
  const body = normalizeEmailBodyText(readString(data, [
    'message_text',
    'messageText',
    'message',
    'body',
    'text',
    'message_body',
    'messageBody',
    'content',
  ])) || htmlToPlainEmailText(bodyHtml);

  const details = {
    subject: readString(data, ['subject', 'asunto']),
    fromEmail: readString(data, ['from_email', 'fromEmail', 'from', 'sender', 'sender_email', 'senderEmail']),
    toEmail: readString(data, ['to_email', 'toEmail', 'to', 'recipient', 'recipients', 'recipient_email', 'recipientEmail']),
    ccEmail: readString(data, ['cc_email', 'ccEmail', 'cc']) || undefined,
    bccEmail: readString(data, ['bcc_email', 'bccEmail', 'bcc']) || undefined,
    replyTo: readString(data, ['reply_to', 'replyTo']),
    status: status || readString(data, ['status', 'message_status', 'messageStatus']),
    transport: readString(data, ['transport', 'channel', 'provider']) || 'email',
    body,
    bodyHtml: bodyHtml || undefined,
  };

  if (
    details.subject ||
    details.fromEmail ||
    details.toEmail ||
    details.ccEmail ||
    details.bccEmail ||
    details.replyTo ||
    details.body ||
    details.bodyHtml
  ) {
    return details;
  }

  return undefined;
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

function buildCommentPost(data: Record<string, unknown>, messageType = '', postDeleted = false): ChatMessage['commentPost'] | undefined {
  if (!isCommentMessageType(messageType)) return undefined;

  const message = readString(data, ['post_message', 'postMessage']);
  const imageUrl = readString(data, ['post_image_url', 'postImageUrl']);
  const permalink = readString(data, ['post_permalink', 'postPermalink', 'permalink']);
  if (!message && !imageUrl && !permalink && !postDeleted) return undefined;

  return {
    message: message || (postDeleted ? 'Publicación eliminada' : ''),
    imageUrl,
    permalink,
    deleted: postDeleted,
  };
}

function getMessageProviderId(message: ChatMessage) {
  return message.providerMessageId || message.id;
}

export function resolveChatMessageReactions(messages: ChatMessage[]) {
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
        const existingReaction = (target.reactions || []).find((reaction) => reaction.id === message.id);
        if (
          existingReaction?.emoji === message.reactionEmoji
          && existingReaction.direction === message.direction
        ) return;
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
    .sort((left, right) => parseSortableDateValue(left.date) - parseSortableDateValue(right.date));
}

export function buildMessagesFromJourney(contactId: string, events: JourneyEvent[], appBaseUrl = '') {
  const messages = events
    .filter((event) => event && typeof event === 'object' && event.date)
    .map((event, index): ChatMessage | null => {
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'appointment_confirmation') {
        return {
          id: readIdString(data, ['id', 'appointment_id'])
            || `appointment-confirmation-${event.date}-${hashConversationEventContent(readString(data, ['title']))}`,
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
      const emailDetails = event.type === 'email_message' ? buildJourneyEmailDetails(data, status) : undefined;
      const attachment = getJourneyMediaAttachment(data, appBaseUrl);
      const location = getJourneyLocation(data);
      const rawText = emailDetails
        ? buildEmailMessageText(emailDetails.subject, emailDetails.body)
        : readString(data, [
          'message_text',
          'message',
          'text',
          'body',
          'subject',
          'caption',
        ]);
      const postDeleted = readBoolean(data.post_deleted || data.postDeleted || data.post_removed || data.postRemoved || data.post_unavailable || data.postUnavailable);
      const text = cleanRedundantRoutingMessageText(
        cleanLocationMessageText(
          cleanAttachmentMessageText(rawText, attachment),
          location,
        ),
      ) || getCommentFallbackText(messageType, status, postDeleted) || (attachment || location ? '' : getMediaFallback(data));
      if (!text && !messageType && !attachment && !location && !emailDetails) return null;

      const direction = normalizeDirection(readString(data, ['direction']));
      const attributionRecordId = readIdString(data, ['attribution_record_id']);
      // El id debe ser estable entre polls y páginas: primero ids de proveedor,
      // luego el id de atribución (INTEGER en el backend, con prefijo para no
      // chocar con ids numéricos de Meta) y como último recurso una huella del
      // contenido — jamás el índice, que cambia con la ventana de 100 mensajes.
      const id = readIdString(data, [
        'whatsapp_api_message_id',
        'whatsapp_message_id',
        'meta_social_message_id',
        'meta_message_id',
        'email_message_id',
      ])
        || (attributionRecordId ? `attr-${attributionRecordId}` : '')
        || `${event.type}-${event.date}-${direction}-${hashConversationEventContent(`${text}|${attachment?.url || attachment?.name || ''}|${messageType}`)}`;
      const normalizedMessageType = messageType.trim().toLowerCase();
      const agentMetadata = getJourneyAgentMessageMetadata(data);

      return {
        id,
        contactId,
        date: event.date,
        direction,
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
        routingReason: cleanRedundantRoutingMessageText(readString(data, ['routing_reason', 'routingReason', 'fallbackReason'])),
        ...agentMetadata,
        messageType,
        replyToProviderMessageId: readString(data, ['reply_to_provider_message_id', 'replyToProviderMessageId']),
        reactionEmoji: readString(data, ['reaction_emoji', 'reactionEmoji']),
        reactionTargetProviderMessageId: readString(data, ['reaction_target_provider_message_id', 'reactionTargetProviderMessageId']),
        emailDetails,
        attachment,
        location,
        isComment: isCommentMessageType(messageType),
        commentReplyMode: normalizedMessageType === 'comment_reply_public'
          ? 'public'
          : normalizedMessageType === 'comment_reply_private'
            ? 'private'
            : undefined,
        commentId: readString(data, ['comment_id', 'commentId']),
        commentPlatform: readString(data, ['social_platform', 'platform']).toLowerCase() === 'instagram' ? 'instagram' : 'messenger',
        commentPost: buildCommentPost(data, messageType, postDeleted),
      };
    })
    .filter((message): message is ChatMessage => Boolean(message));

  return resolveChatMessageReactions(messages);
}
