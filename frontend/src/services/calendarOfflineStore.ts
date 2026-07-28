import type {
  AppointmentStats,
  Calendar,
  CalendarEvent,
  CreateAppointmentPayload
} from './calendarsService'
import type { ApiRequestError } from './apiClient'
import { createAuthScopedLocalStorageNamespace } from './authScopedLocalStorage'

const STORAGE_PREFIX = 'ristak.calendar.offline'
const STORAGE_MAX_RANGE_SNAPSHOTS = 12
const STORAGE_MAX_EVENTS_PER_SNAPSHOT = 180
const STORAGE_MAX_UPCOMING_EVENTS = 80
const RECENTLY_SYNCED_TTL_MS = 15 * 60 * 1000
const LOCAL_EVENT_PREFIX = 'offline-appointment:'
const CHANGE_EVENT = 'ristak:calendar-offline-store-changed'

const storageNamespace = createAuthScopedLocalStorageNamespace([STORAGE_PREFIX])

export type CalendarOfflineSyncStatus = 'pending' | 'failed'

export interface CalendarOfflineAppointment {
  id: string
  clientRequestId: string
  payload: CreateAppointmentPayload
  status: CalendarOfflineSyncStatus
  createdAt: string
  updatedAt: string
  attempts: number
  lastError?: string
}

export interface CalendarRangeSnapshot {
  key: string
  calendarId: string
  events: CalendarEvent[]
  countsByDate: Record<string, number>
  total: number
  updatedAt: string
}

interface CalendarUpcomingSnapshot {
  calendarId: string
  events: CalendarEvent[]
  updatedAt: string
}

interface CalendarRecentlySynced {
  event: CalendarEvent
  syncedAt: string
}

interface CalendarOfflineState {
  version: 1
  calendars: Calendar[]
  calendarsUpdatedAt?: string
  rangeSnapshots: CalendarRangeSnapshot[]
  upcomingSnapshots: CalendarUpcomingSnapshot[]
  statsByCalendar: Record<string, AppointmentStats>
  outbox: CalendarOfflineAppointment[]
  recentlySynced: CalendarRecentlySynced[]
}

export interface CalendarOfflineFlushResult {
  synced: CalendarEvent[]
  pending: CalendarOfflineAppointment[]
  failed: CalendarOfflineAppointment[]
}

const emptyState = (): CalendarOfflineState => ({
  version: 1,
  calendars: [],
  rangeSnapshots: [],
  upcomingSnapshots: [],
  statsByCalendar: {},
  outbox: [],
  recentlySynced: []
})

const getStorage = () => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const stateKey = () => storageNamespace.getKey(STORAGE_PREFIX)

const validRecentlySynced = (items: unknown): CalendarRecentlySynced[] => {
  if (!Array.isArray(items)) return []
  const cutoff = Date.now() - RECENTLY_SYNCED_TTL_MS
  return items.filter((item): item is CalendarRecentlySynced => {
    if (!item || typeof item !== 'object') return false
    const candidate = item as Partial<CalendarRecentlySynced>
    return Boolean(candidate.event?.id)
      && typeof candidate.syncedAt === 'string'
      && Date.parse(candidate.syncedAt) >= cutoff
  })
}

const readState = (): CalendarOfflineState => {
  const storage = getStorage()
  if (!storage) return emptyState()

  try {
    const parsed = JSON.parse(storage.getItem(stateKey()) || '') as Partial<CalendarOfflineState>
    if (parsed.version !== 1) return emptyState()
    return {
      version: 1,
      calendars: Array.isArray(parsed.calendars) ? parsed.calendars : [],
      calendarsUpdatedAt: parsed.calendarsUpdatedAt,
      rangeSnapshots: Array.isArray(parsed.rangeSnapshots) ? parsed.rangeSnapshots : [],
      upcomingSnapshots: Array.isArray(parsed.upcomingSnapshots) ? parsed.upcomingSnapshots : [],
      statsByCalendar: parsed.statsByCalendar && typeof parsed.statsByCalendar === 'object'
        ? parsed.statsByCalendar
        : {},
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      recentlySynced: validRecentlySynced(parsed.recentlySynced)
    }
  } catch {
    return emptyState()
  }
}

const emitChange = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

const writeState = (state: CalendarOfflineState) => {
  const storage = getStorage()
  if (!storage) return
  try {
    storage.setItem(stateKey(), JSON.stringify(state))
    emitChange()
  } catch {
    // La red sigue siendo la fuente canónica si el dispositivo no permite storage.
  }
}

const withoutCredentials = (payload: CreateAppointmentPayload): CreateAppointmentPayload => {
  const {
    accessToken: _accessToken,
    access_token: _accessTokenLegacy,
    ...safePayload
  } = payload
  return safePayload
}

export const createCalendarAppointmentRequestId = (surface = 'desktop') => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
  return `${surface}-appointment:${random}`
}

export const calendarRangeSnapshotKey = ({
  calendarId,
  viewMode,
  startTime,
  endTime
}: {
  calendarId: string
  viewMode: string
  startTime: number
  endTime: number
}) => [calendarId, viewMode, startTime, endTime].join('|')

export const readCachedCalendars = () => readState().calendars

export const writeCachedCalendars = (calendars: Calendar[]) => {
  const state = readState()
  writeState({
    ...state,
    calendars,
    calendarsUpdatedAt: new Date().toISOString()
  })
}

export const readCalendarRangeSnapshot = (key: string) => (
  readState().rangeSnapshots.find(snapshot => snapshot.key === key) ?? null
)

export const writeCalendarRangeSnapshot = (
  snapshot: Omit<CalendarRangeSnapshot, 'updatedAt'>
) => {
  const state = readState()
  const canonicalIDs = new Set(snapshot.events.map(event => event.id))
  const next: CalendarRangeSnapshot = {
    ...snapshot,
    events: snapshot.events.slice(0, STORAGE_MAX_EVENTS_PER_SNAPSHOT),
    updatedAt: new Date().toISOString()
  }
  writeState({
    ...state,
    rangeSnapshots: [
      next,
      ...state.rangeSnapshots.filter(item => item.key !== snapshot.key)
    ].slice(0, STORAGE_MAX_RANGE_SNAPSHOTS),
    recentlySynced: state.recentlySynced.filter(
      item => !canonicalIDs.has(item.event.id)
    )
  })
}

export const readCalendarUpcomingSnapshot = (calendarId: string) => (
  readState().upcomingSnapshots.find(snapshot => snapshot.calendarId === calendarId)?.events ?? []
)

export const writeCalendarUpcomingSnapshot = (calendarId: string, events: CalendarEvent[]) => {
  const state = readState()
  const canonicalIDs = new Set(events.map(event => event.id))
  const next: CalendarUpcomingSnapshot = {
    calendarId,
    events: events.slice(0, STORAGE_MAX_UPCOMING_EVENTS),
    updatedAt: new Date().toISOString()
  }
  writeState({
    ...state,
    upcomingSnapshots: [
      next,
      ...state.upcomingSnapshots.filter(item => item.calendarId !== calendarId)
    ].slice(0, 12),
    recentlySynced: state.recentlySynced.filter(
      item => !canonicalIDs.has(item.event.id)
    )
  })
}

export const readCalendarStatsSnapshot = (calendarId: string) => (
  readState().statsByCalendar[calendarId] ?? null
)

export const writeCalendarStatsSnapshot = (calendarId: string, stats: AppointmentStats) => {
  const state = readState()
  writeState({
    ...state,
    statsByCalendar: {
      ...state.statsByCalendar,
      [calendarId]: stats
    }
  })
}

const syntheticEvent = (entry: CalendarOfflineAppointment): CalendarEvent => ({
  id: `${LOCAL_EVENT_PREFIX}${entry.clientRequestId}`,
  title: String(entry.payload.title || 'Cita'),
  calendarId: entry.payload.calendarId,
  locationId: String(entry.payload.locationId || ''),
  contactId: typeof entry.payload.contactId === 'string' ? entry.payload.contactId : undefined,
  appointmentStatus: (entry.payload.appointmentStatus || 'confirmed') as CalendarEvent['appointmentStatus'],
  assignedUserId: typeof entry.payload.assignedUserId === 'string'
    ? entry.payload.assignedUserId
    : undefined,
  address: String(entry.payload.address || ''),
  notes: String(entry.payload.notes || ''),
  description: String(entry.payload.description || ''),
  startTime: String(entry.payload.startTime || ''),
  endTime: String(entry.payload.endTime || entry.payload.startTime || ''),
  dateAdded: entry.createdAt,
  dateUpdated: entry.updatedAt,
  timeZone: typeof entry.payload.timeZone === 'string' ? entry.payload.timeZone : undefined,
  source: 'ristak',
  syncStatus: entry.status === 'failed' ? 'local_failed' : 'local_pending',
  syncError: entry.lastError || null
})

export const isOfflineCalendarEvent = (event?: CalendarEvent | null) => (
  Boolean(event?.id?.startsWith(LOCAL_EVENT_PREFIX))
)

export const readCalendarAppointmentOutbox = () => readState().outbox

export const readOfflineCalendarEvents = (
  calendarId?: string,
  range?: { startTime: number; endTime: number }
) => (
  readState().outbox
    .filter(entry => !calendarId || entry.payload.calendarId === calendarId)
    .map(syntheticEvent)
    .filter(event => {
      if (!range) return true
      const start = Date.parse(event.startTime)
      return Number.isFinite(start) && start >= range.startTime && start <= range.endTime
    })
)

export const mergeOfflineCalendarEvents = (
  events: CalendarEvent[],
  calendarId?: string,
  range?: { startTime: number; endTime: number }
) => {
  const offline = readOfflineCalendarEvents(calendarId, range)
  const offlineRequestIds = new Set(offline.map(event => event.id.replace(LOCAL_EVENT_PREFIX, '')))
  const recent = readState().recentlySynced.map(item => item.event).filter(event => {
    if (calendarId && event.calendarId !== calendarId) return false
    if (!range) return true
    const start = Date.parse(event.startTime)
    return Number.isFinite(start) && start >= range.startTime && start <= range.endTime
  })
  const canonicalById = new Map(
    [...recent, ...events]
      .filter(event => !isOfflineCalendarEvent(event))
      .map(event => [event.id, event])
  )
  const canonical = Array.from(canonicalById.values()).filter(event => {
    if (isOfflineCalendarEvent(event)) return false
    const requestId = String((event as CalendarEvent & { clientRequestId?: string }).clientRequestId || '')
    return !requestId || !offlineRequestIds.has(requestId)
  })
  return [...offline, ...canonical]
}

export const enqueueCalendarAppointment = (
  payload: CreateAppointmentPayload,
  clientRequestId: string
) => {
  const state = readState()
  const existing = state.outbox.find(entry => entry.clientRequestId === clientRequestId)
  if (existing) return syntheticEvent(existing)

  const now = new Date().toISOString()
  const entry: CalendarOfflineAppointment = {
    id: clientRequestId,
    clientRequestId,
    payload: {
      ...withoutCredentials(payload),
      clientRequestId
    },
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    attempts: 0
  }
  writeState({
    ...state,
    outbox: [...state.outbox, entry]
  })
  return syntheticEvent(entry)
}

export const removeOfflineCalendarAppointment = (eventId: string) => {
  if (!eventId.startsWith(LOCAL_EVENT_PREFIX)) return false
  const clientRequestId = eventId.slice(LOCAL_EVENT_PREFIX.length)
  const state = readState()
  const next = state.outbox.filter(entry => entry.clientRequestId !== clientRequestId)
  if (next.length === state.outbox.length) return false
  writeState({ ...state, outbox: next })
  return true
}

export const retryFailedCalendarAppointments = () => {
  const state = readState()
  const now = new Date().toISOString()
  writeState({
    ...state,
    outbox: state.outbox.map(entry => (
      entry.status === 'failed'
        ? {
            ...entry,
            status: 'pending' as const,
            updatedAt: now,
            lastError: undefined
          }
        : entry
    ))
  })
}

export const isRetryableCalendarSyncError = (error: unknown) => {
  const requestError = error as ApiRequestError & { code?: string }
  const status = Number(requestError?.status || 0)
  if (!status) return true
  return status === 408 || status === 425 || status === 429 || status >= 500
}

let flushPromise: Promise<CalendarOfflineFlushResult> | null = null

export const flushCalendarAppointmentOutbox = (
  createAppointment: (payload: CreateAppointmentPayload) => Promise<CalendarEvent | null>
): Promise<CalendarOfflineFlushResult> => {
  if (flushPromise) return flushPromise

  flushPromise = (async () => {
    const synced: CalendarEvent[] = []
    let state = readState()

    for (const entry of state.outbox) {
      if (entry.status === 'failed') continue
      try {
        const created = await createAppointment({
          ...entry.payload,
          clientRequestId: entry.clientRequestId
        })
        if (!created) throw new Error('El servidor no devolvió la cita creada.')
        synced.push(created)
        const latest = readState()
        state = {
          ...latest,
          recentlySynced: [
            {
              event: created,
              syncedAt: new Date().toISOString()
            },
            ...latest.recentlySynced.filter(item => item.event.id !== created.id)
          ].slice(0, 50),
          outbox: latest.outbox.filter(
            candidate => candidate.clientRequestId !== entry.clientRequestId
          )
        }
        writeState(state)
      } catch (error) {
        const current = readState()
        const now = new Date().toISOString()
        const retryable = isRetryableCalendarSyncError(error)
        const lastError = error instanceof Error
          ? error.message
          : 'No se pudo sincronizar la cita.'
        state = {
          ...current,
          outbox: current.outbox.map(candidate => (
            candidate.clientRequestId === entry.clientRequestId
              ? {
                  ...candidate,
                  status: retryable ? 'pending' : 'failed',
                  attempts: candidate.attempts + 1,
                  updatedAt: now,
                  lastError
                }
              : candidate
          ))
        }
        writeState(state)
        if (retryable) break
      }
    }

    const outbox = readState().outbox
    return {
      synced,
      pending: outbox.filter(entry => entry.status === 'pending'),
      failed: outbox.filter(entry => entry.status === 'failed')
    }
  })().finally(() => {
    flushPromise = null
  })

  return flushPromise
}

export const subscribeCalendarOfflineStore = (listener: () => void) => {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(CHANGE_EVENT, listener)
  return () => window.removeEventListener(CHANGE_EVENT, listener)
}
