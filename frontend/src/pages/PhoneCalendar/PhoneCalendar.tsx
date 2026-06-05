import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bell,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Grid3X3,
  LayoutList,
  List,
  Loader2,
  MonitorX,
  Plus,
  Rows3,
  Search,
  Settings,
  X
} from 'lucide-react'
import { AppointmentModal } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
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
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]

const DAYS_COMPACT = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
const TIMELINE_START_HOUR = 8
const TIMELINE_END_HOUR = 20

const STATUS_LABELS: Record<CalendarEvent['appointmentStatus'], string> = {
  confirmed: 'Confirmada',
  pending: 'Pendiente',
  cancelled: 'Cancelada',
  showed: 'Asistió',
  noshow: 'No asistió',
  rescheduled: 'Reprogramada'
}

type AccessState = 'checking' | 'allowed' | 'blocked'
type SheetView = 'calendar' | 'search' | 'settings' | 'view' | null
type CalendarView = 'month' | 'week' | 'day'
type AgendaView = 'details' | 'stacked' | 'list'

interface DayCell {
  date: Date
  events: CalendarEvent[]
  isCurrentMonth: boolean
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

function getStatusLabel(status: CalendarEvent['appointmentStatus']) {
  return STATUS_LABELS[status] || status
}

function normalizeCalendarEvent(event: any, fallbackId: string): CalendarEvent {
  return {
    ...event,
    id: String(event?.id || fallbackId),
    title: event?.title || event?.name || '(Sin título)',
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
  const [refreshKey, setRefreshKey] = useState(0)
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const [calendarView, setCalendarView] = useState<CalendarView>('month')
  const [agendaView, setAgendaView] = useState<AgendaView>('details')
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
  const stripRef = useRef<HTMLDivElement | null>(null)
  const handledOpenAppointmentRef = useRef<string | null>(null)

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
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'short'
    }).format(date).replace('.', '')
  }, [])

  const getEventDate = useCallback((event: CalendarEvent, fallback = new Date()) => {
    return toDateInTimeZone(event.startTime, timezone) ?? new Date(event.startTime || fallback)
  }, [timezone])

  const getEventEndDate = useCallback((event: CalendarEvent, fallback = new Date()) => {
    return toDateInTimeZone(event.endTime, timezone) ?? new Date(event.endTime || event.startTime || fallback)
  }, [timezone])

  const getEventColor = useCallback((event: CalendarEvent) => {
    return calendars.find((calendar) => calendar.id === event.calendarId)?.eventColor ||
      selectedCalendar?.eventColor ||
      '#ef4444'
  }, [calendars, selectedCalendar])

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
      showToast('warning', 'Elige un calendario', 'Selecciona dónde quieres poner la cita.')
      return
    }

    const { start, end } = buildCreateDefaultTimes(baseDate, isSameDay(baseDate, new Date()) ? 1 : 0)
    setCreateDefaults({
      start,
      end,
      timeZone: timezone,
      title: selectedCalendar.eventTitle || ''
    })
    setIsCreateModalOpen(true)
  }, [buildCreateDefaultTimes, selectedCalendar, selectedDate, showToast, timezone])

  const loadCalendars = useCallback(async () => {
    const calendarsData = await calendarsService.getCalendars(locationId, accessToken)
    setCalendars(calendarsData)

    const lastSelectedId = getStoredLastCalendarId()
    const selected =
      calendarsData.find((calendar) => calendar.id === lastSelectedId && calendar.isActive) ||
      calendarsData.find((calendar) => calendar.id === defaultCalendarId && calendar.isActive) ||
      calendarsData.find((calendar) => calendar.isActive) ||
      null

    selectCalendar(selected)
  }, [accessToken, defaultCalendarId, locationId, selectCalendar])

  const loadEvents = useCallback(async () => {
    if (!selectedCalendar) {
      setEvents([])
      setFutureEvents([])
      return
    }

    const { start, end } = buildMonthRange(currentDate)
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

    setEvents(eventsData.map((event, index) => normalizeCalendarEvent(event, `event-${index}`)))
    setFutureEvents(futureData.map((event, index) => normalizeCalendarEvent(event, `future-${index}`)))
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
    const frameBackground = 'color-mix(in srgb, var(--color-background-primary) 94%, #ffffff 6%)'
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
          showToast('error', 'No se cargaron los calendarios', 'Intenta abrir la agenda otra vez.')
        }
      } finally {
        if (!cancelled) setLoading(false)
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
          showToast('error', 'No se cargaron las citas', 'Intenta actualizar la agenda.')
        }
      } finally {
        if (!cancelled) setLoading(false)
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
          showToast('error', 'No se pudo abrir la cita', 'La agenda abrió, pero el detalle no cargó.')
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

  const timelineHours = useMemo(() => {
    return Array.from({ length: TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1 }).map((_, index) => (
      TIMELINE_START_HOUR + index
    ))
  }, [])

  const timelineEvents = useMemo(() => {
    const totalMinutes = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60

    return selectedDayEvents
      .map((event) => {
        const start = getEventDate(event, selectedDate)
        const end = getEventEndDate(event, start)
        const startMinutes = start.getHours() * 60 + start.getMinutes()
        const endMinutes = Math.max(startMinutes + 30, end.getHours() * 60 + end.getMinutes())
        const isVisible = endMinutes >= TIMELINE_START_HOUR * 60 && startMinutes <= TIMELINE_END_HOUR * 60
        const visibleStart = Math.max(TIMELINE_START_HOUR * 60, startMinutes)
        const visibleEnd = Math.min(TIMELINE_END_HOUR * 60, endMinutes)
        const top = Math.max(0, ((visibleStart - TIMELINE_START_HOUR * 60) / totalMinutes) * 100)
        const height = Math.max(7, ((visibleEnd - visibleStart) / totalMinutes) * 100)

        return { event, top, height, isVisible }
      })
      .filter(({ top, isVisible }) => isVisible && top <= 100)
  }, [getEventDate, getEventEndDate, selectedDate, selectedDayEvents])

  const currentTimePercent = useMemo(() => {
    const now = toDateInTimeZone(new Date().toISOString(), timezone) ?? new Date()
    if (!isSameDay(now, selectedDate)) return null

    const totalMinutes = (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * 60
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    if (currentMinutes < TIMELINE_START_HOUR * 60 || currentMinutes > TIMELINE_END_HOUR * 60) return null

    return ((currentMinutes - TIMELINE_START_HOUR * 60) / totalMinutes) * 100
  }, [selectedDate, timezone])

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

    next.setDate(next.getDate() + (calendarView === 'week' ? direction * 7 : direction))
    setSelectedDate(next)
    setCurrentDate(next)
  }

  const handlePrevPeriod = () => {
    movePeriod(-1)
  }

  const handleNextPeriod = () => {
    movePeriod(1)
  }

  const handleToday = () => {
    const today = new Date()
    setSelectedDate(today)
    setCurrentDate(today)
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
      showToast('success', 'Cita programada', 'La cita quedó guardada en el calendario.')
      setIsCreateModalOpen(false)
      await loadEvents()
    } catch {
      showToast('error', 'No se pudo agendar', 'Intenta de nuevo en unos minutos.')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveAppointment = async (eventId: string, updates: Partial<CalendarEvent>) => {
    try {
      await calendarsService.updateAppointment(eventId, updates, accessToken || undefined)
      showToast('success', 'Cita actualizada', 'Los cambios quedaron guardados.')
      await loadEvents()
    } catch (error) {
      showToast('error', 'No se pudo guardar', 'Intenta nuevamente.')
      throw error
    }
  }

  const handleDeleteAppointment = async (eventId: string) => {
    try {
      await calendarsService.deleteEvent(eventId, accessToken || undefined)
      showToast('success', 'Cita eliminada', 'Ya no aparece en la agenda.')
      setIsEventModalOpen(false)
      setSelectedEvent(null)
      await loadEvents()
    } catch (error) {
      showToast('error', 'No se pudo eliminar', 'Intenta nuevamente.')
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
      showToast('error', 'No se guardó el ajuste', 'Intenta nuevamente.')
    }
  }

  const handleTogglePushEnabled = async () => {
    try {
      await setPushEnabled(!pushEnabled)
    } catch {
      showToast('error', 'No se guardó el ajuste', 'Intenta nuevamente.')
    }
  }

  const handleRequestPush = async () => {
    setRequestingPush(true)
    try {
      const calendarIds = pushCalendarIds.length ? pushCalendarIds : calendars.map((calendar) => calendar.id)
      const result = await pushNotificationsService.subscribeToCalendarNotifications(calendarIds)

      if (result.status === 'subscribed') {
        await setPushEnabled(true)
        showToast('success', 'Avisos activados', 'Este celular ya puede recibir avisos de nuevas citas.')
        return
      }

      showToast(
        result.status === 'denied' ? 'warning' : 'info',
        result.status === 'not_configured' ? 'Falta una llave de avisos' : 'Avisos no activados',
        result.reason
      )
    } catch {
      showToast('error', 'No se pudieron activar avisos', 'Intenta otra vez desde este celular.')
    } finally {
      setRequestingPush(false)
    }
  }

  const pushPermissionLabel = typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission === 'granted'
      ? 'Permiso concedido'
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
            <p className={styles.eyebrow}>Ruta phone</p>
            <h1 id="phone-calendar-blocked-title">Solo en móvil o tablet</h1>
            <p>Esta agenda está hecha para usarla desde un celular o tablet.</p>
          </div>
          <Link className={styles.dashboardLink} to="/appointments">
            Ir a calendarios
          </Link>
        </section>
      </main>
    )
  }

  const selectedMonthLabel = `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`
  const selectedDayLabel = new Intl.DateTimeFormat('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  }).format(selectedDate)
  const selectedDayShortLabel = formatShortDate(selectedDate)
  const weekStart = weekDays[0]?.date ?? selectedDate
  const weekEnd = weekDays[6]?.date ?? selectedDate
  const selectedViewLabel = calendarView === 'month'
    ? 'Mes'
    : calendarView === 'week'
      ? 'Semana'
      : 'Día'
  const agendaViewLabel = agendaView === 'details'
    ? 'Detalles'
    : agendaView === 'stacked'
      ? 'Apilada'
      : 'Lista'
  const viewTitle = calendarView === 'month'
    ? MONTH_NAMES[currentDate.getMonth()]
    : calendarView === 'week'
      ? `${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}`
      : selectedDayShortLabel
  const viewSubtitle = calendarView === 'month'
    ? String(currentDate.getFullYear())
    : `${MONTH_NAMES[selectedDate.getMonth()]} ${selectedDate.getFullYear()}`

  const renderEventItem = (event: CalendarEvent) => {
    const eventColor = getEventColor(event)
    const startLabel = formatEventTime(event.startTime)
    const endLabel = formatEventTime(event.endTime)

    return (
      <button
        key={event.id}
        type="button"
        className={`${styles.eventCard} ${styles[`eventCard_${agendaView}`]}`}
        style={{ '--event-color': eventColor } as React.CSSProperties}
        onClick={() => handleOpenEvent(event)}
      >
        <span className={styles.eventAccent} aria-hidden="true" />
        <span className={styles.eventMain}>
          <strong>{event.title || '(Sin título)'}</strong>
          <small>
            {agendaView === 'list'
              ? getStatusLabel(event.appointmentStatus)
              : `${getStatusLabel(event.appointmentStatus)}${event.address ? ` · ${event.address}` : ''}`}
          </small>
        </span>
        <span className={styles.eventTimeStack}>
          <strong>{startLabel}</strong>
          <small>{endLabel}</small>
        </span>
      </button>
    )
  }

  return (
    <main className={styles.phonePage} aria-label="Calendario móvil de Ristak">
      <div className={styles.phoneFrame}>
        <header className={styles.header}>
          <div className={styles.headerToolbar}>
            <button
              type="button"
              className={styles.periodChip}
              onClick={() => setSheetView('view')}
            >
              <CalendarRange size={18} />
              <span>{selectedViewLabel}</span>
              <ChevronDown size={16} />
            </button>

            <div className={styles.headerCapsule} aria-label="Acciones rápidas">
              <button type="button" onClick={() => setSheetView('view')} aria-label="Cambiar vista">
                <LayoutList size={22} />
              </button>
              <button type="button" onClick={() => setSheetView('search')} aria-label="Buscar citas">
                <Search size={23} />
              </button>
              <button type="button" onClick={() => openCreateModal()} aria-label="Crear cita">
                <Plus size={25} />
              </button>
            </div>
          </div>

          <div className={styles.titleRow}>
            <button type="button" className={styles.titleNavButton} onClick={handlePrevPeriod} aria-label="Anterior">
              <ChevronLeft size={24} />
            </button>
            <div>
              <h1>{viewTitle}</h1>
              <p>{viewSubtitle}</p>
            </div>
            <button type="button" className={styles.titleNavButton} onClick={handleNextPeriod} aria-label="Siguiente">
              <ChevronRight size={24} />
            </button>
          </div>

          <div className={styles.headerMeta}>
            <button
              type="button"
              className={styles.calendarButton}
              onClick={() => setSheetView('calendar')}
              disabled={loading || calendars.length === 0}
            >
              <span
                className={styles.calendarDot}
                style={{ backgroundColor: selectedCalendar?.eventColor || '#2563eb' }}
                aria-hidden="true"
              />
              <span>{selectedCalendar?.name || 'Calendario'}</span>
            </button>
            <button type="button" className={styles.iconButton} onClick={() => setSheetView('settings')} aria-label="Ajustes">
              <Settings size={18} />
            </button>
          </div>
        </header>

        <section className={styles.calendarSurface} aria-label={`Vista de ${selectedViewLabel.toLowerCase()}`}>
          {calendarView === 'month' && (
            <div className={styles.monthGridPanel}>
              <div className={styles.weekdayRow}>
                {DAYS_COMPACT.map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}
              </div>
              <div className={styles.monthGrid}>
                {monthCells.map((cell) => {
                  const isSelected = isSameDay(cell.date, selectedDate)
                  const isToday = isSameDay(cell.date, new Date())
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

          {calendarView !== 'month' && (
            <div className={styles.timelineWrap}>
              {calendarView === 'week' && (
                <section
                  ref={stripRef}
                  className={styles.weekStrip}
                  aria-label="Semana"
                  data-phone-nav-scrollable="true"
                >
                  {weekDays.map(({ date, events: dayEvents }) => {
                    const isSelected = isSameDay(date, selectedDate)
                    const isToday = isSameDay(date, new Date())
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

              <section className={styles.timelinePanel} aria-label="Horario del día">
                <div className={styles.timelineHourColumn}>
                  {timelineHours.map((hour) => (
                    <span key={hour}>{hour > 12 ? `${hour - 12} p.m.` : hour === 12 ? '12 p.m.' : `${hour} a.m.`}</span>
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
                        <strong>{event.title || '(Sin título)'}</strong>
                        <span>{formatEventTime(event.startTime)} - {formatEventTime(event.endTime)}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            </div>
          )}
        </section>

        <section className={styles.agendaHeader}>
          <div>
            <p>{selectedDayLabel}</p>
            <h1>{selectedDayEvents.length ? `${selectedDayEvents.length} cita${selectedDayEvents.length === 1 ? '' : 's'}` : 'Agenda libre'}</h1>
          </div>
          <button type="button" className={styles.agendaViewButton} onClick={() => setSheetView('view')}>
            {agendaViewLabel}
          </button>
          {loading && <Loader2 size={18} className={styles.spinIcon} />}
        </section>

        <section className={`${styles.agendaList} ${styles[`agendaList_${agendaView}`]}`} data-phone-scrollable="true" aria-label="Citas del día">
          {selectedDayEvents.length > 0 ? (
            selectedDayEvents.map(renderEventItem)
          ) : (
            <div className={styles.emptyAgenda}>
              <CalendarDays size={30} />
              <strong>No hay citas este día</strong>
              <span>Puedes programar una nueva cita en el horario que necesites.</span>
            </div>
          )}
        </section>

        <nav className={styles.bottomBar} aria-label="Acciones de calendario">
          <button type="button" className={styles.bottomButton} onClick={handleToday}>
            <CalendarDays size={18} />
            <span>Hoy</span>
          </button>
          <button type="button" className={styles.bottomButton} onClick={() => setSheetView('view')}>
            <Grid3X3 size={18} />
            <span>Vista</span>
          </button>
          <button type="button" className={styles.addButton} onClick={() => openCreateModal()}>
            <Plus size={24} />
            <span>Agendar</span>
          </button>
          <button type="button" className={styles.bottomButton} onClick={() => setSheetView('calendar')}>
            <ChevronDown size={18} />
            <span>Calendarios</span>
          </button>
          <button type="button" className={styles.bottomButton} onClick={() => setSheetView('settings')}>
            <Bell size={18} />
            <span>Avisos</span>
          </button>
        </nav>
      </div>

      {sheetView && (
        <div className={styles.sheetBackdrop} onClick={() => setSheetView(null)}>
          <section className={styles.sheet} onClick={(event) => event.stopPropagation()} aria-label="Panel de calendario">
            <div className={styles.sheetHandle} />
            <header className={styles.sheetHeader}>
              <h2>
                {sheetView === 'calendar' && 'Calendarios'}
                {sheetView === 'search' && 'Buscar cita'}
                {sheetView === 'settings' && 'Ajustes'}
                {sheetView === 'view' && 'Vista'}
              </h2>
              <button type="button" className={styles.closeSheetButton} onClick={() => setSheetView(null)} aria-label="Cerrar">
                <X size={18} />
              </button>
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

            {sheetView === 'view' && (
              <div className={styles.viewPanel} data-phone-scrollable="true">
                <section className={styles.settingBlock}>
                  <div className={styles.settingBlockHeader}>
                    <strong>Ver calendario</strong>
                    <span>{selectedMonthLabel}</span>
                  </div>
                  <div className={styles.viewChoiceGrid}>
                    {([
                      ['month', 'Mes', CalendarDays],
                      ['week', 'Semana', CalendarRange],
                      ['day', 'Día', CalendarClock]
                    ] as const).map(([value, label, Icon]) => (
                      <button
                        key={value}
                        type="button"
                        className={`${styles.viewChoice} ${calendarView === value ? styles.viewChoiceActive : ''}`}
                        onClick={() => {
                          setCalendarView(value)
                          setCurrentDate(selectedDate)
                          setSheetView(null)
                        }}
                      >
                        <Icon size={19} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className={styles.settingBlock}>
                  <div className={styles.settingBlockHeader}>
                    <strong>Lista de citas</strong>
                    <span>{agendaViewLabel}</span>
                  </div>
                  <div className={styles.viewChoiceGrid}>
                    {([
                      ['details', 'Detalles', LayoutList],
                      ['stacked', 'Apilada', Rows3],
                      ['list', 'Lista', List]
                    ] as const).map(([value, label, Icon]) => (
                      <button
                        key={value}
                        type="button"
                        className={`${styles.viewChoice} ${agendaView === value ? styles.viewChoiceActive : ''}`}
                        onClick={() => {
                          setAgendaView(value)
                          setSheetView(null)
                        }}
                      >
                        <Icon size={19} />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {sheetView === 'search' && (
              <div className={styles.searchPanel} data-phone-scrollable="true">
                <label className={styles.searchBox}>
                  <Search size={18} />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Nombre, día o estado"
                    autoFocus
                  />
                  {searchQuery && (
                    <button type="button" onClick={() => setSearchQuery('')} aria-label="Limpiar búsqueda">
                      <X size={16} />
                    </button>
                  )}
                </label>
                <div className={styles.searchResults}>
                  {searchQuery.trim() && searchResults.length === 0 && (
                    <div className={styles.emptySearch}>No encontré citas con esa búsqueda.</div>
                  )}
                  {searchResults.map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      className={styles.searchResult}
                      onClick={() => handleSearchResult(event)}
                    >
                      <strong>{event.title || '(Sin título)'}</strong>
                      <span>{formatLocalDateShort(event.startTime)} · {formatEventTime(event.startTime)} · {getStatusLabel(event.appointmentStatus)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {sheetView === 'settings' && (
              <div className={styles.settingsPanel} data-phone-scrollable="true">
                <section className={styles.settingRow}>
                  <span>
                    <strong>Avisos de nuevas citas</strong>
                    <small>{pushEnabled ? 'Encendidos para la app' : 'Apagados'}</small>
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
                    <strong>Calendarios con aviso</strong>
                    <span>{pushCalendarIds.length ? `${pushCalendarIds.length} elegido${pushCalendarIds.length === 1 ? '' : 's'}` : 'Todos'}</span>
                  </div>
                  <button
                    type="button"
                    className={`${styles.allCalendarsButton} ${pushCalendarIds.length === 0 ? styles.allCalendarsButtonActive : ''}`}
                    onClick={() => setPushCalendarIds([]).catch(() => showToast('error', 'No se guardó el ajuste', 'Intenta nuevamente.'))}
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
        onSave={handleCreateAppointment}
      />
    </main>
  )
}
