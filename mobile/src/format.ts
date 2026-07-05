import type { ChatContact, JourneyEvent, ChatMessage } from './types';

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

function getZonedDateTimeParts(value: string | Date, timezone?: string | null) {
  const date = value instanceof Date ? value : new Date(value);
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
  const date = new Date(value);
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
