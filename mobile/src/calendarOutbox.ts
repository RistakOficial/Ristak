import type { RistakApiClient } from './api';
import {
  readCache,
  readCacheForNamespace,
  resolveCacheNamespace,
  writeCacheNow,
} from './cache';
import { getBusinessDateOnly } from './format';
import type { CalendarEventItem } from './types';

export const CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY = 'ristak.native.calendar.appointmentOutbox.v1';
export const CALENDAR_EVENTS_CACHE_KEY = 'ristak.native.calendar.eventsCache.v1';
const LOCAL_EVENT_PREFIX = 'offline-appointment:';

export type CalendarOutboxStatus = 'pending' | 'failed';

export type CalendarAppointmentPayload = Record<string, unknown> & {
  calendarId: string;
  startTime: string;
  endTime: string;
  timeZone?: string;
};

export type CalendarAppointmentOutboxEntry = {
  clientRequestId: string;
  payload: CalendarAppointmentPayload;
  status: CalendarOutboxStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError?: string;
};

export type CalendarOutboxSyncResult = {
  synced: CalendarEventItem[];
  pending: CalendarAppointmentOutboxEntry[];
  failed: CalendarAppointmentOutboxEntry[];
};

type ApiError = Error & {
  status?: number;
  code?: string;
};

function withoutCredentials(payload: CalendarAppointmentPayload): CalendarAppointmentPayload {
  const {
    accessToken: _accessToken,
    access_token: _legacyAccessToken,
    ...safePayload
  } = payload;
  return safePayload as CalendarAppointmentPayload;
}

function localEventId(clientRequestId: string) {
  return `${LOCAL_EVENT_PREFIX}${clientRequestId}`;
}

export function isOfflineCalendarEvent(event?: CalendarEventItem | null) {
  return Boolean(String(event?.id || event?._id || '').startsWith(LOCAL_EVENT_PREFIX));
}

export function calendarOutboxEntryToEvent(
  entry: CalendarAppointmentOutboxEntry,
): CalendarEventItem {
  return {
    id: localEventId(entry.clientRequestId),
    title: String(entry.payload.title || 'Cita'),
    calendarId: entry.payload.calendarId,
    contactId: typeof entry.payload.contactId === 'string' ? entry.payload.contactId : undefined,
    assignedUserId: typeof entry.payload.assignedUserId === 'string'
      ? entry.payload.assignedUserId
      : undefined,
    appointmentStatus: String(entry.payload.appointmentStatus || 'confirmed'),
    startTime: entry.payload.startTime,
    endTime: entry.payload.endTime,
    timeZone: typeof entry.payload.timeZone === 'string' ? entry.payload.timeZone : undefined,
    address: String(entry.payload.address || ''),
    notes: String(entry.payload.notes || ''),
    source: 'ristak',
    syncStatus: entry.status === 'failed' ? 'local_failed' : 'local_pending',
    syncError: entry.lastError || null,
  };
}

async function readOutbox(expectedNamespace = '') {
  return expectedNamespace
    ? readCacheForNamespace<CalendarAppointmentOutboxEntry[]>(
        CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY,
        [],
        expectedNamespace,
      )
    : readCache<CalendarAppointmentOutboxEntry[]>(
        CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY,
        [],
      );
}

export async function getCalendarAppointmentOutbox(expectedNamespace = '') {
  return readOutbox(expectedNamespace);
}

export function mergeCalendarEventsWithOutbox(
  events: CalendarEventItem[],
  outbox: CalendarAppointmentOutboxEntry[],
  calendarId?: string,
  range?: { startDate: string; endDate: string; timeZone: string },
) {
  const pendingEvents = outbox
    .filter((entry) => !calendarId || entry.payload.calendarId === calendarId)
    .filter((entry) => {
      if (!range) return true;
      const dateOnly = getBusinessDateOnly(entry.payload.startTime, range.timeZone);
      return Boolean(
        dateOnly
        && dateOnly >= range.startDate
        && dateOnly <= range.endDate,
      );
    })
    .map(calendarOutboxEntryToEvent);
  const canonical = events.filter((event) => !isOfflineCalendarEvent(event));
  return [...pendingEvents, ...canonical];
}

async function updateCachedEventRanges(
  entry: CalendarAppointmentOutboxEntry,
  replacement: CalendarEventItem | null,
  expectedNamespace = '',
) {
  const cache = expectedNamespace
    ? await readCacheForNamespace<Record<string, CalendarEventItem[]>>(
        CALENDAR_EVENTS_CACHE_KEY,
        {},
        expectedNamespace,
      )
    : await readCache<Record<string, CalendarEventItem[]>>(
        CALENDAR_EVENTS_CACHE_KEY,
        {},
      );
  const dateOnly = getBusinessDateOnly(
    entry.payload.startTime,
    String(entry.payload.timeZone || ''),
  );
  if (!dateOnly) return;

  let changed = false;
  const next = { ...cache };
  Object.entries(cache).forEach(([key, value]) => {
    const [calendarId, , rangeStart, rangeEnd] = key.split('|');
    if (
      calendarId !== entry.payload.calendarId
      || !rangeStart
      || !rangeEnd
      || dateOnly < rangeStart
      || dateOnly > rangeEnd
    ) return;

    const localId = localEventId(entry.clientRequestId);
    const replacementId = String(replacement?.id || replacement?._id || '');
    const filtered = (Array.isArray(value) ? value : []).filter((event) => {
      const eventId = String(event.id || event._id || '');
      return eventId !== localId && (!replacementId || eventId !== replacementId);
    });
    next[key] = replacement ? [replacement, ...filtered] : filtered;
    changed = true;
  });

  if (changed) {
    await writeCacheNow(CALENDAR_EVENTS_CACHE_KEY, next, expectedNamespace);
  }
}

export async function enqueueCalendarAppointment(
  payload: CalendarAppointmentPayload,
  clientRequestId: string,
) {
  const current = await readOutbox();
  const existing = current.find((entry) => entry.clientRequestId === clientRequestId);
  if (existing) return calendarOutboxEntryToEvent(existing);

  const now = new Date().toISOString();
  const entry: CalendarAppointmentOutboxEntry = {
    clientRequestId,
    payload: {
      ...withoutCredentials(payload),
      clientRequestId,
    },
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };
  await writeCacheNow(CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY, [...current, entry]);
  const event = calendarOutboxEntryToEvent(entry);
  await updateCachedEventRanges(entry, event);
  return event;
}

export async function removeQueuedCalendarAppointment(eventId: string) {
  if (!eventId.startsWith(LOCAL_EVENT_PREFIX)) return false;
  const clientRequestId = eventId.slice(LOCAL_EVENT_PREFIX.length);
  const current = await readOutbox();
  const entry = current.find((candidate) => candidate.clientRequestId === clientRequestId);
  if (!entry) return false;
  await writeCacheNow(
    CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY,
    current.filter((candidate) => candidate.clientRequestId !== clientRequestId),
  );
  await updateCachedEventRanges(entry, null);
  return true;
}

export async function retryFailedCalendarAppointments() {
  const current = await readOutbox();
  const now = new Date().toISOString();
  const next = current.map((entry) => (
    entry.status === 'failed'
      ? {
          ...entry,
          status: 'pending' as const,
          updatedAt: now,
          lastError: undefined,
        }
      : entry
  ));
  await writeCacheNow(CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY, next);
  await Promise.all(next.map((entry) => updateCachedEventRanges(
    entry,
    calendarOutboxEntryToEvent(entry),
  )));
  return next;
}

export function isRetryableCalendarOutboxError(error: unknown) {
  const apiError = error as ApiError;
  const status = Number(apiError?.status || 0);
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const activeFlushes = new Map<string, Promise<CalendarOutboxSyncResult>>();

export function syncCalendarAppointmentOutbox(
  api: RistakApiClient,
  expectedNamespace = '',
): Promise<CalendarOutboxSyncResult> {
  const cacheNamespace = resolveCacheNamespace(expectedNamespace);
  const activeFlush = activeFlushes.get(cacheNamespace);
  if (activeFlush) return activeFlush;

  const operation = (async () => {
    let outbox = await readOutbox(expectedNamespace);
    const synced: CalendarEventItem[] = [];

    for (const entry of outbox) {
      if (entry.status === 'failed') continue;
      try {
        const created = await api.createAppointment(
          entry.payload,
          entry.clientRequestId,
        );
        synced.push(created);
        outbox = outbox.filter(
          (candidate) => candidate.clientRequestId !== entry.clientRequestId,
        );
        await writeCacheNow(
          CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY,
          outbox,
          expectedNamespace,
        );
        await updateCachedEventRanges(entry, created, expectedNamespace);
      } catch (error) {
        const retryable = isRetryableCalendarOutboxError(error);
        const now = new Date().toISOString();
        outbox = outbox.map((candidate) => (
          candidate.clientRequestId === entry.clientRequestId
            ? {
                ...candidate,
                status: retryable ? 'pending' : 'failed',
                attempts: candidate.attempts + 1,
                updatedAt: now,
                lastError: error instanceof Error
                  ? error.message
                  : 'No se pudo sincronizar la cita.',
              }
            : candidate
        ));
        await writeCacheNow(
          CALENDAR_APPOINTMENT_OUTBOX_CACHE_KEY,
          outbox,
          expectedNamespace,
        );
        const updated = outbox.find(
          (candidate) => candidate.clientRequestId === entry.clientRequestId,
        );
        if (updated) {
          await updateCachedEventRanges(
            updated,
            calendarOutboxEntryToEvent(updated),
            expectedNamespace,
          );
        }
        if (retryable) break;
      }
    }

    return {
      synced,
      pending: outbox.filter((entry) => entry.status === 'pending'),
      failed: outbox.filter((entry) => entry.status === 'failed'),
    };
  })();

  const trackedOperation = operation.finally(() => {
    activeFlushes.delete(cacheNamespace);
  });
  activeFlushes.set(cacheNamespace, trackedOperation);
  return trackedOperation;
}
