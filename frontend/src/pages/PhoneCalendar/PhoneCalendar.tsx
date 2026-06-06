import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  Loader2,
  MonitorX,
  Plus
} from 'lucide-react'
import { AppointmentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { getPhoneDailyCacheKey, readPhoneDailyCache, writePhoneDailyCache } from '@/services/phoneDailyCache'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import { convertLocalToUTC } from '@/utils/timezone'
import styles from './PhoneCalendar.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_PHONE_SELECTOR = '[data-phone-scrollable="true"], textarea, input, select'
const SCROLLABLE_PHONE_NAV_SELECTOR = '[data-phone-nav-scrollable="true"]'
const LAST_SELECTED_CALENDAR_KEY = 'lastSelectedCalendarId'

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
]

const MONTH_NAMES_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'
]

const DAYS_COMPACT = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
const TIMELINE_START_HOUR = 0
const TIMELINE_END_HOUR = 23
const TIMELINE_TOTAL_MINUTES = (TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1) * 60
const YEAR_GRID_SIZE = 12

const STATUS_LABELS: Record<CalendarEvent['appointmentStatus'], string> = {
  confirmed: 'Confirmada',
  pending: 'Pendiente',
  cancelled: 'Cancelada',
  showed: 'Asistió',
  noshow: 'No asistió',
  rescheduled: 'Reprogramada'
}

type AccessState = 'checking' | 'allowed' | 'blocked'
type SheetView = 'calendar' | 'settings' | null
type CalendarView = 'month' | 'week' | 'day' | 'year' | 'years'

interface DayCell {
  date: Date
  events: CalendarEvent[]
  isCurrentMonth: boolean
}

interface MiniMonthDayCell {
  key: string
  date: Date | null
  events: CalendarEvent[]
}

const getStoredLastCalendarId = () => {
  if (typeof window === 'undefined') return null
  return window.sessionStorage.getItem(LAST_SELECTED_CALENDAR_KEY)
}

function hasPortableAccess() {
  if (typeof window === 'undefined') return false

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const phoneViewport = window.matchMedia(PHONE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return phoneViewport || (portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer))
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

function getTimeZoneParts(date: Date, timeZone?: string) {
  if (!timeZone) return null
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  const parts = formatter.formatToParts(date)
  const result: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = Number(part.value)
    }
  }
  return result
}

function toDateInTimeZone(value?: string | null, timeZone?: string): Date | null {
  if (!value) return null
  const base = new Date(value)
  if (Number.isNaN(base.getTime())) return null
  if (!timeZone) return base

  const parts = getTimeZoneParts(base, timeZone)
  if (!parts) return base

  return new Date(
    parts.year ?? base.getFullYear(),
    (parts.month ?? base.getMonth() + 1) - 1,
    parts.day ?? base.getDate(),
    parts.hour ?? base.getHours(),
    parts.minute ?? base.getMinutes(),
    parts.second ?? base.getSeconds()
  )
}

function formatDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function startOfWeek(date: Date) {
  const next = new Date(date)
  const dayOfWeek = next.getDay()
  next.setDate(next.getDate() - dayOfWeek)
  next.setHours(0, 0, 0, 0)
  return next
}

function startOfMonthGrid(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1)
  return startOfWeek(first)
}

function buildMonthRange(date: Date) {
  const start = startOfMonthGrid(date)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  const lastDayOfWeek = end.getDay()
  end.setDate(end.getDate() + (6 - lastDayOfWeek))
  end.setHours(23, 59, 59, 999)

  return { start, end }
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getStatusLabel(status: CalendarEvent['appointmentStatus']) {
  return STATUS_LABELS[status] || status
}

function capitalizeFirst(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value
}

function normalizeCalendarEvent(event: any, fallbackId: string): CalendarEvent {
  return {
    ...event,
    id: String(event?.id || fallbackId),
    title: event?.title || event?.name || 'Sin título',
    calendarId: event?.calendarId || event?.calendar_id || '',
    locationId: event?.locationId || event?.location_id || '',
    contactId: event?.contactId || event?.contact_id,
    groupId: event?.groupId || event?.group_id,
    appointmentStatus: (event?.appointmentStatus || event?.appointment_status || event?.status || 'confirmed') as CalendarEvent['appointmentStatus'],
    assignedUserId: event?.assignedUserId || event?.assigned_user_id,
    address: event?.address || '',
    notes: event?.notes || '',
    description: event?.description || '',
    startTime: event?.startTime || event?.start_time || event?.start || '',
    endTime: event?.endTime || event?.end_time || event?.end || event?.startTime || event?.start_time || '',
    dateAdded: event?.dateAdded || event?.date_added || '',
    dateUpdated: event?.dateUpdated || event?.date_updated,
    timeZone: event?.timeZone || event?.timezone || event?.time_zone
  }
}

export const PhoneCalendar: React.FC = () => {
  const { locationId, accessToken } = useAuth()
  const { showToast } = useNotification()
  const { timezone, formatLocalDateShort } = useTimezone()
  const [searchParams, setSearchParams] = useSearchParams()
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [pushEnabled, setPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [pushCalendarIds, setPushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])

  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [selectedCalendar, setSelectedCalendar] = useState<Calendar | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [futureEvents, setFutureEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [cacheRefreshing, setCacheRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [calendarView, setCalendarView] = useState<CalendarView>('month')
  const [sheetView, setSheetView] = useState<SheetView>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [isEventModalOpen, setIsEventModalOpen] = useState(false)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [createDefaults, setCreateDefaults] = useState({
    start: '',
    end: '',
    timeZone: timezone,
    title: ''
  })
  const [requestingPush, setRequestingPush] = useState(false)
  const stripRef = useRef<HTMLElement | null>(null)
  const timelineScrollRef = useRef<HTMLElement | null>(null)
  const handledOpenAppointmentRef = useRef<string | null>(null)
  const calendarTouchStartRef = useRef<{ x: number; y: number } | null>(null)

  const formatEventTime = useCallback((value?: string | null) => {
    const date = toDateInTimeZone(value, timezone)
    if (!date) return '—'
    return new Intl.DateTimeFormat('es-MX', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(date)
  }, [timezone])

  const formatShortDate = useCallback((date: Date) => {
    return `${date.getDate()} ${MONTH_NAMES_SHORT[date.getMonth()]}`
  }, [])

  const getEventDate = useCallback((event: CalendarEvent, fallback = new Date()) => {
    return toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime || fallback)
  }, [timezone])

  const getEventEndDate = useCallback((event: CalendarEvent, fallback = new Date()) => {
    return toDateInTimeZone(event.endTime, timezone) ?? new Date(event.endTime || event.startTime || fallback)
  }, [timezone])

  const getEventColor = useCallback(() => {
    return '#25d366'
  }, [])

  const persistLastSelectedCalendar = useCallback((calendarId: string | null) => {
    if (typeof window === 'undefined') return
    if (calendarId) {
      window.sessionStorage.setItem(LAST_SELECTED_CALENDAR_KEY, calendarId)
    } else {
      window.sessionStorage.removeItem(LAST_SELECTED_CALENDAR_KEY)
    }
  }, [])

  const selectCalendar = useCallback((calendar: Calendar | null) => {
    setSelectedCalendar(calendar)
    persistLastSelectedCalendar(calendar?.id ?? null)
  }, [persistLastSelectedCalendar])

  const applyCalendars = useCallback((calendarsData: Calendar[]) => {
    setCalendars(calendarsData)

    const lastSelectedId = getStoredLastCalendarId()
    const selected =
      calendarsData.find((calendar) => calendar.id === lastSelectedId && calendar.isActive) ||
      calendarsData.find((calendar) => calendar.id === defaultCalendarId && calendar.isActive) ||
      calendarsData.find((calendar) => calendar.isActive) ||
      null

    selectCalendar(selected)
  }, [defaultCalendarId, selectCalendar])

  const buildCreateDefaultTimes = useCallback((baseDate: Date, hourOffset = 0) => {
    const zonedNow = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()
    const isToday = isSameDay(baseDate, zonedNow)
    const hour = isToday ? Math.min(23, zonedNow.getHours() + hourOffset) : 9
    const localWall = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), hour, 0, 0, 0)
    const startUTC = convertLocalToUTC(localWall, timezone)
    return {
      start: startUTC.toISOString(),
      end: new Date(startUTC.getTime() + 60 * 60 * 1000).toISOString()
    }
  }, [timezone])

  const openCreateModal = useCallback((baseDate = selectedDate) => {
    if (!selectedCalendar) {
      showToast('warning', 'Elige un calendario', 'Selecciona dónde quieres guardar la cita.')
      return
    }

    const zonedNow = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()
    const { start, end } = buildCreateDefaultTimes(baseDate, isSameDay(baseDate, zonedNow) ? 1 : 0)
    setCreateDefaults({
      start,
      end,
      timeZone: timezone,
      title: selectedCalendar.eventTitle || ''
    })
    setIsCreateModalOpen(true)
  }, [buildCreateDefaultTimes, selectedCalendar, selectedDate, showToast, timezone])

  const loadCalendars = useCallback(async () => {
    const cacheKey = getPhoneDailyCacheKey('phone-calendar', 'calendars', locationId || 'default')
    const cachedCalendars = readPhoneDailyCache<Calendar[]>(cacheKey)

    if (cachedCalendars) {
      applyCalendars(Array.isArray(cachedCalendars.data) ? cachedCalendars.data : [])
      setCacheRefreshing(true)
    }

    const calendarsData = await calendarsService.getCalendars(locationId, accessToken)
    applyCalendars(calendarsData)
    writePhoneDailyCache(cacheKey, calendarsData, { maxEntryChars: 180_000 })
    setCacheRefreshing(false)
  }, [accessToken, applyCalendars, locationId])

  const loadEvents = useCallback(async () => {
    if (!selectedCalendar) {
      setEvents([])
      setFutureEvents([])
      return
    }

    const { start, end } = buildMonthRange(currentDate)
    const cacheKey = getPhoneDailyCacheKey(
      'phone-calendar',
      'events',
      locationId || 'default',
      selectedCalendar.id,
      start.getTime(),
      end.getTime()
    )
    const cachedEvents = readPhoneDailyCache<{ events: CalendarEvent[]; futureEvents: CalendarEvent[] }>(cacheKey)

    if (cachedEvents) {
      setEvents(Array.isArray(cachedEvents.data.events) ? cachedEvents.data.events : [])
      setFutureEvents(Array.isArray(cachedEvents.data.futureEvents) ? cachedEvents.data.futureEvents : [])
      setCacheRefreshing(true)
    }

    const eventsData = await calendarsService.getEvents(
      locationId || '',
      start.getTime(),
      end.getTime(),
      accessToken || undefined,
      selectedCalendar.id
    )
    const futureData = await calendarsService.getFutureAppointments(
      selectedCalendar.id,
      locationId || '',
      accessToken || undefined
    )

    const nextEvents = eventsData.map((event, index) => normalizeCalendarEvent(event, `event-${index}`))
    const nextFutureEvents = futureData.map((event, index) => normalizeCalendarEvent(event, `future-${index}`))
    setEvents(nextEvents)
    setFutureEvents(nextFutureEvents)
    writePhoneDailyCache(cacheKey, { events: nextEvents, futureEvents: nextFutureEvents }, { maxEntryChars: 360_000 })
    setCacheRefreshing(false)
  }, [accessToken, currentDate, locationId, selectedCalendar])

  useEffect(() => {
    document.title = 'Calendario móvil | Ristak'
  }, [])

  useEffect(() => {
    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const phoneMedia = window.matchMedia(PHONE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    phoneMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      phoneMedia.removeEventListener('change', updateAccess)
      pointerMedia.removeEventListener('change', updateAccess)
      window.removeEventListener('resize', updateAccess)
      window.removeEventListener('orientationchange', updateAccess)
      window.visualViewport?.removeEventListener('resize', updateAccess)
    }
  }, [])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const html = document.documentElement
    const body = document.body
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const previousViewportContent = viewportMeta?.getAttribute('content') || ''
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousHtmlBackground = html.style.background
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousBodyBackground = body.style.background
    const frameBackground = 'var(--phone-chat-bg, color-mix(in srgb, var(--color-background-primary) 94%, #ffffff 6%))'
    let startX = 0
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.background = frameBackground
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.background = frameBackground

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const getScrollableNav = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_NAV_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const handleTouchStart = (event: TouchEvent) => {
      startX = event.touches[0]?.clientX || 0
      startY = event.touches[0]?.clientY || 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      const currentX = event.touches[0]?.clientX || startX
      const currentY = event.touches[0]?.clientY || startY
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const horizontalIntent = Math.abs(deltaX) > Math.abs(deltaY)
      const nav = getScrollableNav(event.target)

      if (nav) {
        const canScrollX = nav.scrollWidth > nav.clientWidth + 1
        const atLeft = nav.scrollLeft <= 0
        const atRight = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1

        if (horizontalIntent && canScrollX && !((atLeft && deltaX > 0) || (atRight && deltaX < 0))) {
          return
        }

        event.preventDefault()
        return
      }

      const scrollable = getScrollableElement(event.target)
      if (!scrollable) {
        event.preventDefault()
        return
      }

      const canScroll = scrollable.scrollHeight > scrollable.clientHeight + 1
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

      if (!canScroll || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        event.preventDefault()
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)

      if (viewportMeta) {
        viewportMeta.setAttribute('content', previousViewportContent)
      }

      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      html.style.background = previousHtmlBackground
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
      body.style.background = previousBodyBackground
    }
  }, [accessState])

  useEffect(() => {
    if (accessState !== 'allowed') return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        await loadCalendars()
      } catch {
        if (!cancelled) {
          showToast('error', 'No cargaron los calendarios', 'Vuelve a abrir el calendario e intenta de nuevo.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setCacheRefreshing(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [accessState, loadCalendars, refreshKey, showToast])

  useEffect(() => {
    if (accessState !== 'allowed') return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      try {
        await loadEvents()
      } catch {
        if (!cancelled) {
          showToast('error', 'No cargaron las citas', 'Actualiza el calendario e intenta otra vez.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          setCacheRefreshing(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [accessState, loadEvents, refreshKey, showToast])

  useEffect(() => {
    const selectedButton = stripRef.current?.querySelector<HTMLButtonElement>('[data-selected-day="true"]')
    selectedButton?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [selectedDate])

  useEffect(() => {
    const openType = searchParams.get('open')
    const appointmentId = searchParams.get('id')

    if (openType !== 'appointment' || !appointmentId) {
      handledOpenAppointmentRef.current = null
      return
    }

    if (handledOpenAppointmentRef.current === appointmentId || calendars.length === 0) return

    handledOpenAppointmentRef.current = appointmentId
    let isMounted = true

    const openAppointmentFromLink = async () => {
      try {
        const appointment = await calendarsService.getAppointment(appointmentId)
        if (!appointment || !isMounted) return

        const event = normalizeCalendarEvent(appointment, appointmentId)
        const eventDate = toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime)
        const matchingCalendar = calendars.find((calendar) => calendar.id === event.calendarId)

        if (matchingCalendar) {
          selectCalendar(matchingCalendar)
        }

        if (!Number.isNaN(eventDate.getTime())) {
          setSelectedDate(eventDate)
          setCurrentDate(eventDate)
        }

        setSelectedEvent(event)
        setIsEventModalOpen(true)
      } catch {
        if (isMounted) {
        showToast('error', 'No se abrió la cita', 'El calendario abrió, pero los detalles no cargaron.')
        }
      } finally {
        if (isMounted) {
          const nextParams = new URLSearchParams(searchParams)
          nextParams.delete('open')
          nextParams.delete('id')
          setSearchParams(nextParams, { replace: true })
        }
      }
    }

    openAppointmentFromLink()

    return () => {
      isMounted = false
    }
  }, [calendars, searchParams, selectCalendar, setSearchParams, showToast, timezone])

  const eventsByDate = useMemo(() => {
    const grouped: Record<string, CalendarEvent[]> = {}
    events.forEach((event) => {
      const zoned = toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime)
      const key = formatDateKey(zoned)
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(event)
    })
    Object.keys(grouped).forEach((key) => {
      grouped[key].sort((a, b) => a.startTime.localeCompare(b.startTime))
    })
    return grouped
  }, [events, timezone])

  const selectedDayEvents = useMemo(() => {
    return eventsByDate[formatDateKey(selectedDate)] || []
  }, [eventsByDate, selectedDate])

  const weekDays = useMemo(() => {
    const base = startOfWeek(selectedDate)
    return Array.from({ length: 7 }).map((_, index) => {
      const date = new Date(base)
      date.setDate(base.getDate() + index)
      return {
        date,
        events: eventsByDate[formatDateKey(date)] || []
      }
    })
  }, [eventsByDate, selectedDate])

  const monthCells = useMemo((): DayCell[] => {
    const { start, end } = buildMonthRange(currentDate)
    const dayCount = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
    return Array.from({ length: dayCount }).map((_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      return {
        date,
        isCurrentMonth: date.getMonth() === currentDate.getMonth(),
        events: eventsByDate[formatDateKey(date)] || []
      }
    })
  }, [currentDate, eventsByDate])

  const yearMonths = useMemo(() => {
    const year = currentDate.getFullYear()

    return MONTH_NAMES.map((name, monthIndex) => {
      const firstDay = new Date(year, monthIndex, 1)
      const leadingBlanks = firstDay.getDay()
      const daysInMonth = getDaysInMonth(year, monthIndex)
      const cells: MiniMonthDayCell[] = [
        ...Array.from({ length: leadingBlanks }).map((_, index) => ({
          key: `${monthIndex}-blank-${index}`,
          date: null,
          events: []
        })),
        ...Array.from({ length: daysInMonth }).map((_, index) => {
          const date = new Date(year, monthIndex, index + 1)
          return {
            key: formatDateKey(date),
            date,
            events: eventsByDate[formatDateKey(date)] || []
          }
        })
      ]

      return {
        name,
        monthIndex,
        daysInMonth,
        cells
      }
    })
  }, [currentDate, eventsByDate])

  const yearsGrid = useMemo(() => {
    const selectedYear = currentDate.getFullYear()
    const startYear = Math.floor(selectedYear / YEAR_GRID_SIZE) * YEAR_GRID_SIZE
    return Array.from({ length: YEAR_GRID_SIZE }).map((_, index) => startYear + index)
  }, [currentDate])

  const timelineHours = useMemo(() => {
    return Array.from({ length: TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1 }).map((_, index) => (
      TIMELINE_START_HOUR + index
    ))
  }, [])

  const timelineEvents = useMemo(() => {
    const totalMinutes = TIMELINE_TOTAL_MINUTES

    return selectedDayEvents
      .map((event) => {
        const start = getEventDate(event, selectedDate)
        const end = getEventEndDate(event, start)
        const startMinutes = start.getHours() * 60 + start.getMinutes()
        const endMinutes = Math.max(startMinutes + 30, end.getHours() * 60 + end.getMinutes())
        const timelineEndMinutes = (TIMELINE_END_HOUR + 1) * 60
        const isVisible = endMinutes >= TIMELINE_START_HOUR * 60 && startMinutes <= timelineEndMinutes
        const visibleStart = Math.max(TIMELINE_START_HOUR * 60, startMinutes)
        const visibleEnd = Math.min(timelineEndMinutes, endMinutes)
        const top = Math.max(0, ((visibleStart - TIMELINE_START_HOUR * 60) / totalMinutes) * 100)
        const height = Math.max(7, ((visibleEnd - visibleStart) / totalMinutes) * 100)

        return { event, top, height, isVisible }
      })
      .filter(({ top, isVisible }) => isVisible && top <= 100)
  }, [getEventDate, getEventEndDate, selectedDate, selectedDayEvents])

  const currentTimePercent = useMemo(() => {
    const now = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()
    if (!isSameDay(now, selectedDate)) return null

    const totalMinutes = TIMELINE_TOTAL_MINUTES
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    if (currentMinutes < TIMELINE_START_HOUR * 60 || currentMinutes > (TIMELINE_END_HOUR + 1) * 60) return null

    return ((currentMinutes - TIMELINE_START_HOUR * 60) / totalMinutes) * 100
  }, [selectedDate, timezone])

  useEffect(() => {
    if (calendarView !== 'day' && calendarView !== 'week') return
    if (currentTimePercent === null) return

    const scrollElement = timelineScrollRef.current
    if (!scrollElement) return

    const frame = window.requestAnimationFrame(() => {
      const target = (scrollElement.scrollHeight * currentTimePercent) / 100 - scrollElement.clientHeight * 0.38
      scrollElement.scrollTo({
        top: Math.max(0, target),
        behavior: 'smooth'
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [calendarView, currentTimePercent, selectedDate])

  const preparedSearch = useMemo(() => prepareSearchQuery(searchQuery), [searchQuery])

  const searchResults = useMemo(() => {
    if (!preparedSearch.normalized) return []

    const uniqueEvents = [...events, ...futureEvents].filter((event, index, source) => (
      index === source.findIndex((item) => item.id === event.id)
    ))

    return uniqueEvents
      .map((event) => {
        const eventDate = toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime)
        return {
          event,
          searchIndex: buildSearchIndex([
            event.title,
            getStatusLabel(event.appointmentStatus),
            formatLocalDateShort(event.startTime),
            MONTH_NAMES[eventDate.getMonth()],
            String(eventDate.getDate())
          ])
        }
      })
      .filter(({ searchIndex }) => searchIndexIncludes(searchIndex, preparedSearch))
      .map(({ event }) => event)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 12)
  }, [events, formatLocalDateShort, futureEvents, preparedSearch, timezone])

  const handleSelectDate = (date: Date) => {
    setSelectedDate(date)
    setCurrentDate(date)
    if (calendarView === 'year' || calendarView === 'years') {
      setCalendarView('month')
    }
    setSheetView(null)
  }

  const movePeriod = (direction: -1 | 1) => {
    const next = new Date(calendarView === 'month' ? currentDate : selectedDate)

    if (calendarView === 'month') {
      next.setMonth(next.getMonth() + direction)
      const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
      const adjustedSelection = new Date(
        next.getFullYear(),
        next.getMonth(),
        Math.min(selectedDate.getDate(), daysInMonth)
      )
      setCurrentDate(next)
      setSelectedDate(adjustedSelection)
      return
    }

    if (calendarView === 'year') {
      const selectedDay = selectedDate.getDate()
      next.setFullYear(currentDate.getFullYear() + direction)
      const daysInTargetMonth = getDaysInMonth(next.getFullYear(), selectedDate.getMonth())
      const adjustedSelection = new Date(
        next.getFullYear(),
        selectedDate.getMonth(),
        Math.min(selectedDay, daysInTargetMonth)
      )
      setCurrentDate(next)
      setSelectedDate(adjustedSelection)
      return
    }

    if (calendarView === 'years') {
      next.setFullYear(currentDate.getFullYear() + direction * YEAR_GRID_SIZE)
      setCurrentDate(next)
      setSelectedDate(next)
      return
    }

    next.setDate(next.getDate() + (calendarView === 'week' ? direction * 7 : direction))
    setSelectedDate(next)
    setCurrentDate(next)
  }

  const handleToday = () => {
    const today = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()
    setSelectedDate(today)
    setCurrentDate(today)
    setCalendarView('day')
  }

  const handleNavigateUp = () => {
    if (calendarView === 'month') {
      setCalendarView('year')
      return
    }

    if (calendarView === 'year') {
      setCalendarView('years')
      return
    }

    if (calendarView === 'years') {
      setCalendarView('year')
      return
    }

    setCurrentDate(selectedDate)
    setCalendarView('month')
  }

  const handleSelectMonthFromYear = (monthIndex: number) => {
    const year = currentDate.getFullYear()
    const daysInMonth = getDaysInMonth(year, monthIndex)
    const nextDate = new Date(year, monthIndex, Math.min(selectedDate.getDate(), daysInMonth))
    setCurrentDate(nextDate)
    setSelectedDate(nextDate)
    setCalendarView('month')
  }

  const handleSelectYear = (year: number) => {
    const daysInMonth = getDaysInMonth(year, selectedDate.getMonth())
    const nextDate = new Date(year, selectedDate.getMonth(), Math.min(selectedDate.getDate(), daysInMonth))
    setCurrentDate(nextDate)
    setSelectedDate(nextDate)
    setCalendarView('year')
  }

  const handleCalendarTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0]
    if (!touch) return
    calendarTouchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  const handleCalendarTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const start = calendarTouchStartRef.current
    const touch = event.changedTouches[0]
    calendarTouchStartRef.current = null
    if (!start || !touch) return

    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return

    movePeriod(deltaX < 0 ? 1 : -1)
  }

  const handleCreateAppointment = async (payload: {
    title: string
    appointmentStatus: CalendarEvent['appointmentStatus']
    startTime: string
    endTime: string
    notes: string
    address: string
    timeZone: string
    contactId?: string
  }) => {
    if (!selectedCalendar) return

    setLoading(true)
    try {
      await calendarsService.createAppointment({
        calendarId: selectedCalendar.id,
        ...(locationId ? { locationId } : {}),
        ...payload
      }, accessToken || undefined)
      showToast('success', 'Cita agendada', 'La cita se guardó en el calendario.')
      setIsCreateModalOpen(false)
      await loadEvents()
    } catch {
      showToast('error', 'No se pudo agendar', 'Intenta otra vez en unos minutos.')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveAppointment = async (eventId: string, updates: Partial<CalendarEvent>) => {
    try {
      await calendarsService.updateAppointment(eventId, updates, accessToken || undefined)
      showToast('success', 'Cita actualizada', 'Tus cambios se guardaron.')
      await loadEvents()
    } catch (error) {
      showToast('error', 'No se pudo guardar', 'Intenta otra vez.')
      throw error
    }
  }

  const handleDeleteAppointment = async (eventId: string) => {
    try {
      await calendarsService.deleteEvent(eventId, accessToken || undefined)
      showToast('success', 'Cita eliminada', 'Ya no aparece en el calendario.')
      setIsEventModalOpen(false)
      setSelectedEvent(null)
      await loadEvents()
    } catch (error) {
      showToast('error', 'No se pudo eliminar', 'Intenta otra vez.')
      throw error
    }
  }

  const handleOpenEvent = (event: CalendarEvent) => {
    setSelectedEvent(event)
    setIsEventModalOpen(true)
  }

  const handleSearchResult = (event: CalendarEvent) => {
    const eventDate = toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime)
    setSelectedDate(eventDate)
    setCurrentDate(eventDate)
    setSheetView(null)
    setSearchQuery('')
    handleOpenEvent(event)
  }

  const togglePushCalendar = async (calendarId: string) => {
    const next = pushCalendarIds.includes(calendarId)
      ? pushCalendarIds.filter((id) => id !== calendarId)
      : [...pushCalendarIds, calendarId]

    try {
      await setPushCalendarIds(next)
    } catch {
      showToast('error', 'No se guardó el ajuste', 'Intenta otra vez.')
    }
  }

  const handleTogglePushEnabled = async () => {
    try {
      await setPushEnabled(!pushEnabled)
    } catch {
      showToast('error', 'No se guardó el ajuste', 'Intenta otra vez.')
    }
  }

  const handleRequestPush = async () => {
    setRequestingPush(true)
    try {
      const calendarIds = pushCalendarIds.length ? pushCalendarIds : calendars.map((calendar) => calendar.id)
      const result = await pushNotificationsService.subscribeToCalendarNotifications(calendarIds)

      if (result.status === 'subscribed') {
        await setPushEnabled(true)
        showToast('success', 'Notificaciones activadas', 'Este celular ya puede recibir notificaciones de citas nuevas.')
        return
      }

      showToast(
        result.status === 'denied' ? 'warning' : 'info',
        result.status === 'not_configured' ? 'Falta la llave de alertas' : 'Alertas no activadas',
        result.reason
      )
    } catch {
      showToast('error', 'No se pudieron activar las alertas', 'Intenta otra vez desde este celular.')
    } finally {
      setRequestingPush(false)
    }
  }

  const pushPermissionLabel = typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission === 'granted'
      ? 'Permiso aprobado'
      : Notification.permission === 'denied'
        ? 'Permiso bloqueado'
        : 'Permiso pendiente'
    : 'No disponible'

  if (accessState === 'checking') {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.loadingDot} />
      </main>
    )
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-calendar-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Vista móvil</p>
            <h1 id="phone-calendar-blocked-title">Solo celular o tablet</h1>
            <p>Este calendario está hecho para usarse desde un celular o una tablet.</p>
          </div>
          <Link className={styles.dashboardLink} to="/appointments">
            Ir a calendarios
          </Link>
        </section>
      </main>
    )
  }

  const selectedDayLabel = capitalizeFirst(new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(selectedDate))
  const selectedDayShortLabel = formatShortDate(selectedDate)
  const weekStart = weekDays[0]?.date ?? selectedDate
  const weekEnd = weekDays[6]?.date ?? selectedDate
  const selectedViewLabel = calendarView === 'month'
    ? 'Vista mensual'
    : calendarView === 'week'
      ? 'Vista semanal'
      : calendarView === 'day'
        ? 'Vista de hoy'
        : calendarView === 'year'
          ? 'Vista anual'
          : 'Vista de años'
  const yearRangeLabel = `${yearsGrid[0]} - ${yearsGrid[yearsGrid.length - 1]}`
  const viewTitle = calendarView === 'month'
    ? capitalizeFirst(MONTH_NAMES[currentDate.getMonth()])
    : calendarView === 'week'
      ? `${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}`
      : calendarView === 'day'
        ? selectedDayShortLabel
        : calendarView === 'year'
          ? String(currentDate.getFullYear())
          : yearRangeLabel
  const viewSubtitle = calendarView === 'week'
    ? `${capitalizeFirst(MONTH_NAMES[selectedDate.getMonth()])} ${selectedDate.getFullYear()}`
    : ''
  const periodChipLabel = calendarView === 'month'
    ? String(currentDate.getFullYear())
    : calendarView === 'year'
      ? 'Años'
      : calendarView === 'years'
        ? 'Año'
        : capitalizeFirst(MONTH_NAMES[selectedDate.getMonth()])
  const periodChipAriaLabel = calendarView === 'month'
    ? 'Ver año'
    : calendarView === 'year'
      ? 'Ver años'
      : calendarView === 'years'
        ? 'Volver al año'
        : 'Volver a vista mensual'
  const showCalendarSurface = calendarView !== 'day'
  const showAgenda = calendarView === 'month'
  const nowInCalendar = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()

  const renderEventItem = (event: CalendarEvent) => {
    const eventColor = getEventColor(event)
    const startLabel = formatEventTime(event.startTime)
    const endLabel = formatEventTime(event.endTime)

    return (
      <button
        key={event.id}
        type="button"
        className={`${styles.eventCard} ${styles.eventCard_list}`}
        style={{ '--event-color': eventColor } as React.CSSProperties}
        onClick={() => handleOpenEvent(event)}
      >
        <span className={styles.eventAccent} aria-hidden="true" />
        <span className={styles.eventMain}>
          <strong>{event.title || 'Sin título'}</strong>
          <small>{getStatusLabel(event.appointmentStatus)}</small>
        </span>
        <span className={styles.eventTimeStack}>
          <strong>{startLabel}</strong>
          <small>{endLabel}</small>
        </span>
      </button>
    )
  }

  const formatTimelineHour = (hour: number) => {
    if (hour === 0) return '12 a.m.'
    if (hour === 12) return '12 p.m.'
    return hour > 12 ? `${hour - 12} p.m.` : `${hour} a.m.`
  }

  return (
    <main className={styles.phonePage} aria-label="Calendario móvil de Ristak">
      <div className={styles.phoneFrame}>
	        <header className={styles.header}>
	          <div className={styles.headerToolbar}>
	            <button
	              type="button"
	              className={styles.periodChip}
	              onClick={handleNavigateUp}
	              aria-label={periodChipAriaLabel}
	            >
	              {calendarView !== 'years' && <ChevronLeft size={21} />}
	              <span>{periodChipLabel}</span>
	            </button>

	            <div className={styles.headerCapsule} aria-label="Acciones rápidas">
	              <button type="button" className={styles.todayTopButton} onClick={handleToday} aria-label="Hoy">
	                Hoy
	              </button>
	              <button type="button" onClick={() => setSheetView('calendar')} aria-label="Calendarios">
	                <CalendarDays size={22} />
	              </button>
	              <button type="button" onClick={() => setSheetView('settings')} aria-label="Alertas y ajustes">
	                <Bell size={22} />
	              </button>
	              <button type="button" onClick={() => openCreateModal()} aria-label="Crear cita">
	                <Plus size={25} />
	              </button>
	            </div>
	          </div>

	          <div className={styles.titleRow} data-calendar-view={calendarView}>
	            <button type="button" className={styles.titleButton} onClick={handleNavigateUp}>
	              <h1>{viewTitle}</h1>
	              {viewSubtitle && <p>{viewSubtitle}</p>}
	            </button>
	          </div>
	        </header>

	        {showCalendarSurface && (
	          <section
	            className={styles.calendarSurface}
	            aria-label={selectedViewLabel}
	            onTouchStart={handleCalendarTouchStart}
	            onTouchEnd={handleCalendarTouchEnd}
	          >
	            {calendarView === 'month' && (
	              <div className={styles.monthGridPanel}>
	                <div className={styles.weekdayRow}>
	                  {DAYS_COMPACT.map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
	                </div>
	                <div className={styles.monthGrid}>
	                  {monthCells.map((cell) => {
	                    const isSelected = isSameDay(cell.date, selectedDate)
	                    const isToday = isSameDay(cell.date, nowInCalendar)
	                    return (
	                      <button
	                        key={formatDateKey(cell.date)}
	                        type="button"
	                        className={`${styles.monthDay} ${!cell.isCurrentMonth ? styles.monthDayMuted : ''} ${isSelected ? styles.monthDaySelected : ''} ${isToday ? styles.monthDayToday : ''}`}
	                        onClick={() => handleSelectDate(cell.date)}
	                      >
	                        <span>{cell.date.getDate()}</span>
	                        {cell.events.length > 0 && (
	                          <i className={styles.monthMarkers}>
	                            {cell.events.slice(0, 3).map((event) => (
	                              <b key={event.id} style={{ backgroundColor: getEventColor(event) }} />
	                            ))}
	                          </i>
	                        )}
	                      </button>
	                    )
	                  })}
	                </div>
	              </div>
	            )}

	            {calendarView === 'year' && (
	              <div className={styles.yearPanel}>
	                <div className={styles.yearGrid}>
	                  {yearMonths.map((month) => {
	                    const isSelectedMonth =
	                      currentDate.getFullYear() === selectedDate.getFullYear() &&
	                      month.monthIndex === selectedDate.getMonth()

	                    return (
	                      <button
	                        key={month.name}
	                        type="button"
	                        className={`${styles.yearMonth} ${isSelectedMonth ? styles.yearMonthSelected : ''}`}
	                        onClick={() => handleSelectMonthFromYear(month.monthIndex)}
	                      >
	                        <strong>{MONTH_NAMES_SHORT[month.monthIndex]}</strong>
	                        <span className={styles.miniMonthGrid} aria-hidden="true">
	                          {month.cells.map((cell) => {
	                            if (!cell.date) {
	                              return <span key={cell.key} />
	                            }

	                            const isSelected = isSameDay(cell.date, selectedDate)
	                            const isToday = isSameDay(cell.date, nowInCalendar)

	                            return (
	                              <span
	                                key={cell.key}
	                                className={`${styles.miniDay} ${isSelected ? styles.miniDaySelected : ''} ${isToday ? styles.miniDayToday : ''}`}
	                              >
	                                <span>{cell.date.getDate()}</span>
	                                {cell.events.length > 0 && <i />}
	                              </span>
	                            )
	                          })}
	                        </span>
	                      </button>
	                    )
	                  })}
	                </div>
	              </div>
	            )}

	            {calendarView === 'years' && (
	              <div className={styles.yearsPanel}>
	                <div className={styles.yearsGrid}>
	                  {yearsGrid.map((year) => {
	                    const isSelectedYear = year === selectedDate.getFullYear()
	                    const isCurrentYear = year === nowInCalendar.getFullYear()
	                    return (
	                      <button
	                        key={year}
	                        type="button"
	                        className={`${styles.yearButton} ${isSelectedYear ? styles.yearButtonSelected : ''} ${isCurrentYear ? styles.yearButtonToday : ''}`}
	                        onClick={() => handleSelectYear(year)}
	                      >
	                        {year}
	                      </button>
	                    )
	                  })}
	                </div>
	              </div>
	            )}

	            {calendarView === 'week' && (
	              <section
	                ref={stripRef}
	                className={styles.weekStrip}
	                aria-label="Semana"
	                data-phone-nav-scrollable="true"
	              >
	                {weekDays.map(({ date, events: dayEvents }) => {
	                  const isSelected = isSameDay(date, selectedDate)
	                  const isToday = isSameDay(date, nowInCalendar)
	                  return (
	                    <button
	                      key={formatDateKey(date)}
	                      type="button"
	                      data-selected-day={isSelected || undefined}
	                      className={`${styles.weekDay} ${isSelected ? styles.weekDaySelected : ''} ${isToday ? styles.weekDayToday : ''}`}
	                      onClick={() => handleSelectDate(date)}
	                    >
	                      <span>{DAYS_COMPACT[date.getDay()]}</span>
	                      <strong>{date.getDate()}</strong>
	                      {dayEvents.length > 0 && <i>{dayEvents.length}</i>}
	                    </button>
	                  )
	                })}
	              </section>
	            )}
	          </section>
	        )}

	        {(calendarView === 'week' || calendarView === 'day') && (
	          <section
	            ref={timelineScrollRef}
	            className={styles.timelineScroller}
	            data-phone-scrollable="true"
	            aria-label="Horario del día"
	            onTouchStart={handleCalendarTouchStart}
	            onTouchEnd={handleCalendarTouchEnd}
	          >
	            <div className={styles.timelineWrap}>
	              <section className={styles.timelinePanel} aria-label="Horario del día">
	                <div className={styles.timelineHourColumn}>
	                  {timelineHours.map((hour) => (
	                    <span key={hour}>{formatTimelineHour(hour)}</span>
	                  ))}
	                </div>
	                <div className={styles.timelineGrid}>
	                  {timelineHours.map((hour) => <span key={hour} />)}
	                  {currentTimePercent !== null && (
	                    <div className={styles.nowLine} style={{ top: `${currentTimePercent}%` }}>
	                      <strong>{formatEventTime(new Date().toISOString())}</strong>
	                    </div>
	                  )}
	                  {timelineEvents.map(({ event, top, height }) => {
	                    const eventColor = getEventColor(event)
	                    return (
	                      <button
	                        key={event.id}
	                        type="button"
	                        className={styles.timelineEvent}
	                        style={{
	                          top: `${top}%`,
	                          height: `${height}%`,
	                          '--event-color': eventColor
	                        } as React.CSSProperties}
	                        onClick={() => handleOpenEvent(event)}
	                      >
	                        <strong>{event.title || 'Sin título'}</strong>
	                        <span>{formatEventTime(event.startTime)} - {formatEventTime(event.endTime)}</span>
	                      </button>
	                    )
	                  })}
	                </div>
	              </section>
	            </div>
	          </section>
	        )}

	        {showAgenda && (
	          <section className={styles.agendaScroller} data-phone-scrollable="true" aria-label="Citas del día">
	            <section className={styles.agendaHeader}>
	              <div>
	                <p>{selectedDayLabel}</p>
	                <h1>{selectedDayEvents.length ? `${selectedDayEvents.length} cita${selectedDayEvents.length === 1 ? '' : 's'}` : 'Sin citas'}</h1>
	              </div>
	              {cacheRefreshing ? (
	                <span className={styles.cacheRefreshPill} role="status">
	                  <Loader2 size={14} className={styles.spinIcon} />
	                  Actualizando
	                </span>
	              ) : (
	                loading && <Loader2 size={18} className={styles.spinIcon} />
	              )}
	            </section>

	            <section className={`${styles.agendaList} ${styles.agendaList_list}`} aria-label="Citas del día">
	              {selectedDayEvents.length > 0 ? (
	                selectedDayEvents.map(renderEventItem)
	              ) : (
	                <div className={styles.emptyAgenda}>
	                  <CalendarDays size={30} />
	                  <strong>No hay citas este día</strong>
	                  <span>Puedes agendar una cita nueva a la hora que necesites.</span>
	                </div>
	              )}
	            </section>
	          </section>
	        )}
      </div>

      <PhoneEcosystemNav active="calendar" />

      {sheetView && (
        <div className={styles.sheetBackdrop} onClick={() => setSheetView(null)}>
          <section className={styles.sheet} onClick={(event) => event.stopPropagation()} aria-label="Panel del calendario">
            <div className={styles.sheetHandle} />
            <header className={styles.sheetHeader}>
              <button type="button" className={styles.closeSheetButton} onClick={() => setSheetView(null)} aria-label="Volver al calendario">
                <ChevronLeft size={24} />
              </button>
              <h2>
                {sheetView === 'calendar' && 'Calendarios'}
                {sheetView === 'settings' && 'Alertas'}
              </h2>
              <span className={styles.sheetHeaderSpacer} aria-hidden="true" />
            </header>

            {sheetView === 'calendar' && (
              <div className={styles.sheetList} data-phone-scrollable="true">
                {calendars.map((calendar) => (
                  <button
                    key={calendar.id}
                    type="button"
                    className={`${styles.calendarOption} ${selectedCalendar?.id === calendar.id ? styles.calendarOptionActive : ''}`}
                    onClick={() => {
                      selectCalendar(calendar)
                      setSheetView(null)
                    }}
                  >
                    <span className={styles.calendarOptionDot} style={{ backgroundColor: calendar.eventColor || '#2563eb' }} />
                    <span>
                      <strong>{calendar.name}</strong>
                      <small>{calendar.isActive ? 'Activo' : 'Inactivo'} · {calendar.source === 'google' ? 'Google' : calendar.source === 'ghl' ? 'HighLevel' : 'Ristak'}</small>
                    </span>
                    {selectedCalendar?.id === calendar.id && <Check size={18} />}
                  </button>
                ))}
              </div>
            )}

            {sheetView === 'settings' && (
              <div className={styles.settingsPanel} data-phone-scrollable="true">
                <section className={styles.settingRow}>
                  <span>
                    <strong>Alertas de citas nuevas</strong>
                    <small>{pushEnabled ? 'Activas en esta app' : 'Apagadas'}</small>
                  </span>
                  <button
                    type="button"
                    className={`${styles.switchButton} ${pushEnabled ? styles.switchButtonActive : ''}`}
                    onClick={handleTogglePushEnabled}
                    aria-pressed={pushEnabled}
                  >
                    <i />
                  </button>
                </section>

                <section className={styles.settingBlock}>
                  <div className={styles.settingBlockHeader}>
                    <strong>Calendarios con alertas</strong>
                    <span>{pushCalendarIds.length ? `${pushCalendarIds.length} seleccionados` : 'Todos'}</span>
                  </div>
                  <button
                    type="button"
                    className={`${styles.allCalendarsButton} ${pushCalendarIds.length === 0 ? styles.allCalendarsButtonActive : ''}`}
                    onClick={() => setPushCalendarIds([]).catch(() => showToast('error', 'No se guardó el ajuste', 'Intenta otra vez.'))}
                  >
                    Todos los calendarios
                  </button>
                  <div className={styles.calendarChipGrid}>
                    {calendars.map((calendar) => {
                      const active = pushCalendarIds.includes(calendar.id)
                      return (
                        <button
                          key={calendar.id}
                          type="button"
                          className={`${styles.calendarChip} ${active ? styles.calendarChipActive : ''}`}
                          onClick={() => togglePushCalendar(calendar.id)}
                        >
                          <span style={{ backgroundColor: calendar.eventColor || '#2563eb' }} />
                          {calendar.name}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className={styles.permissionBox}>
                  <div>
                    <strong>Este celular</strong>
                    <span>{pushPermissionLabel}</span>
                  </div>
                  <button type="button" onClick={handleRequestPush} disabled={requestingPush}>
                    {requestingPush ? <Loader2 size={16} className={styles.spinIcon} /> : <Bell size={16} />}
                    Activar
                  </button>
                </section>

                <Link className={styles.desktopSettingsLink} to="/settings/calendars">
                  Abrir configuración completa
                </Link>
              </div>
            )}
          </section>
        </div>
      )}

      <AppointmentModal
        isOpen={isEventModalOpen}
        onClose={() => {
          setIsEventModalOpen(false)
          setSelectedEvent(null)
        }}
        event={selectedEvent}
        calendar={selectedCalendar}
        accessToken={accessToken || undefined}
        locationId={locationId || undefined}
        presentation="mobileSheet"
        onSave={handleSaveAppointment}
        onDelete={handleDeleteAppointment}
      />

      <AppointmentModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        mode="create"
        calendar={selectedCalendar}
        defaultStart={createDefaults.start}
        defaultEnd={createDefaults.end}
        defaultTimeZone={createDefaults.timeZone}
        defaultTitle={createDefaults.title}
        defaultScheduleMode="custom"
        accessToken={accessToken || undefined}
        locationId={locationId || undefined}
        presentation="mobileSheet"
        onSave={handleCreateAppointment}
      />
    </main>
  )
}
