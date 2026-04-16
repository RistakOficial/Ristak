import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { KpiCard, Card, Button, PageContainer, AppointmentModal, BlockedSlotModal, TabList, Loading } from '@/components/common';
import { ChevronLeft, ChevronRight, Plus, ChevronDown, Check, Calendar as CalendarIcon, Search, X, Settings, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useNotification } from '@/contexts/NotificationContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useAppConfig } from '@/hooks';
import { calendarsService, type Calendar, type CalendarEvent, type AppointmentStats, type BlockedSlot } from '@/services/calendarsService';
import { formatTime12h } from '@/utils/format'
import { useTimezone } from '@/contexts/TimezoneContext';
import styles from './Appointments.module.css';

const LAST_SELECTED_CALENDAR_KEY = 'lastSelectedCalendarId';

const getStoredLastCalendarId = () => {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(LAST_SELECTED_CALENDAR_KEY);
};

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const DAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const viewTabs = [
  { value: 'month', label: 'Mes' },
  { value: 'week', label: 'Semana' },
  { value: 'day', label: 'Día' }
];

type ViewMode = 'month' | 'week' | 'day';

const STATUS_LABELS: Record<CalendarEvent['appointmentStatus'], string> = {
  confirmed: 'Confirmada',
  pending: 'Pendiente',
  cancelled: 'Cancelada',
  showed: 'Asistió',
  noshow: 'No asistió',
  rescheduled: 'Reprogramada'
};

const getStatusLabel = (status: CalendarEvent['appointmentStatus']): string =>
  STATUS_LABELS[status] ?? status;

const MIN_DAY_EVENT_MINUTES = 45;

interface DayCell {
  date: Date;
  isCurrentMonth: boolean;
  events: CalendarEvent[];
}

const getTimeZoneParts = (date: Date, timeZone?: string) => {
  if (!timeZone) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const result: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      result[part.type] = Number(part.value);
    }
  }
  return result;
};

const toDateInTimeZone = (value?: string | null, timeZone?: string): Date | null => {
  if (!value) return null;
  const base = new Date(value);
  if (Number.isNaN(base.getTime())) return null;
  if (!timeZone) return base;

  const parts = getTimeZoneParts(base, timeZone);
  if (!parts) return base;

  return new Date(
    parts.year ?? base.getFullYear(),
    (parts.month ?? base.getMonth() + 1) - 1,
    parts.day ?? base.getDate(),
    parts.hour ?? base.getHours(),
    parts.minute ?? base.getMinutes(),
    parts.second ?? base.getSeconds()
  );
};

const isSameDay = (a: Date, b: Date): boolean => {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
};

export const Appointments: React.FC = () => {
  const { locationId, accessToken } = useAuth();
  const { showToast } = useNotification();
  const { theme } = useTheme();
  const { formatLocalDateShort } = useTimezone();
  const navigate = useNavigate();

  // Estado del calendario
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // Datos
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [selectedCalendar, setSelectedCalendar] = useState<Calendar | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [blockedSlots, setBlockedSlots] = useState<BlockedSlot[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]); // Eventos próximos desde HOY
  const [stats, setStats] = useState<AppointmentStats>({
    pending: 0,
    cancelled: 0,
    confirmed: 0,
    rescheduled: 0,
    showed: 0,
    noshow: 0
  });
  const [loading, setLoading] = useState(false);

  // Modal de cita
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<{
    start: string;
    end: string;
    timeZone: string;
    title: string;
  }>({
    start: '',
    end: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    title: ''
  });
  const [createScheduleMode, setCreateScheduleMode] = useState<'default' | 'custom'>('default');

  // Modal de blocked slot
  const [selectedBlockedSlot, setSelectedBlockedSlot] = useState<(BlockedSlot & { id?: string }) | null>(null);
  const [isBlockedSlotModalOpen, setIsBlockedSlotModalOpen] = useState(false);
  const [isCreateBlockedSlotMode, setIsCreateBlockedSlotMode] = useState(true);
  const [blockedSlotDefaults, setBlockedSlotDefaults] = useState<{
    start: string;
    end: string;
    timeZone: string;
  }>({
    start: '',
    end: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  });

  // Dropdown de calendarios
  const [isCalendarDropdownOpen, setIsCalendarDropdownOpen] = useState(false);
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '');

  // Drag & Drop state
  const [draggedEvent, setDraggedEvent] = useState<CalendarEvent | null>(null);
  const [dragOverDate, setDragOverDate] = useState<Date | null>(null);

  // Time selection state (para vistas semana/día - seleccionar rango de horas)
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ date: Date; hour: number; minute: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ date: Date; hour: number; minute: number } | null>(null);

  const persistLastSelectedCalendar = useCallback((calendarId: string | null) => {
    if (typeof window === 'undefined') return;
    if (calendarId) {
      window.sessionStorage.setItem(LAST_SELECTED_CALENDAR_KEY, calendarId);
    } else {
      window.sessionStorage.removeItem(LAST_SELECTED_CALENDAR_KEY);
    }
  }, []);

  const selectCalendar = useCallback((calendar: Calendar | null) => {
    setSelectedCalendar(calendar);
    persistLastSelectedCalendar(calendar?.id ?? null);
  }, [persistLastSelectedCalendar]);

  // Dropdowns de navegación
  const [isMonthDropdownOpen, setIsMonthDropdownOpen] = useState(false);
  const [isYearDropdownOpen, setIsYearDropdownOpen] = useState(false);

  // Buscador de citas
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchDropdownOpen, setIsSearchDropdownOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Tooltip de eventos
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null);

  // Referencias para auto scroll
  const weekGridRef = useRef<HTMLDivElement | null>(null);
  const dayGridRef = useRef<HTMLDivElement | null>(null);

  // Función para calcular rango de fechas (necesita estar antes de loadEvents)
  const getDateRange = useCallback((): { startTime: number; endTime: number } => {
    let start: Date;
    let end: Date;

    if (viewMode === 'month') {
      // Para vista mensual, necesitamos incluir días del mes anterior/siguiente que se muestran en el grid
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth();

      // Primer día del mes
      const firstDay = new Date(year, month, 1);
      // Lunes de la semana del primer día
      start = new Date(firstDay);
      const dayOfWeek = (firstDay.getDay() + 6) % 7; // 0 = lunes
      start.setDate(firstDay.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);

      // Último día del mes
      const lastDay = new Date(year, month + 1, 0);
      // Domingo de la semana del último día
      end = new Date(lastDay);
      const lastDayOfWeek = (lastDay.getDay() + 6) % 7;
      const daysToAdd = 6 - lastDayOfWeek;
      end.setDate(lastDay.getDate() + daysToAdd);
      end.setHours(23, 59, 59, 999);
    } else if (viewMode === 'week') {
      // Lunes de la semana actual
      const dayOfWeek = (currentDate.getDay() + 6) % 7; // 0 = lunes
      start = new Date(currentDate);
      start.setDate(currentDate.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);

      // Domingo de la semana actual
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    } else {
      // Día actual
      start = new Date(currentDate);
      start.setHours(0, 0, 0, 0);

      end = new Date(currentDate);
      end.setHours(23, 59, 59, 999);
    }

    return {
      startTime: start.getTime(),
      endTime: end.getTime()
    };
  }, [currentDate, viewMode]);

  const loadCalendars = useCallback(async () => {
    if (!locationId || !accessToken) return;

    try {
      setLoading(true);
      const calendarsData = await calendarsService.getCalendars(locationId, accessToken);
      setCalendars(calendarsData);

      // Seleccionar calendario: último usado en esta sesión > predeterminado (configuración) > primer activo
      let calendarToSelect: Calendar | undefined;

      const lastSelectedId = getStoredLastCalendarId();
      if (lastSelectedId) {
        calendarToSelect = calendarsData.find((cal) => cal.id === lastSelectedId && cal.isActive);
      }

      if (!calendarToSelect && defaultCalendarId) {
        calendarToSelect = calendarsData.find((cal) => cal.id === defaultCalendarId && cal.isActive);
      }

      if (!calendarToSelect) {
        calendarToSelect = calendarsData.find((cal) => cal.isActive);
      }

      if (calendarToSelect) {
        selectCalendar(calendarToSelect);
      } else {
        selectCalendar(null);
      }
    } catch (error) {
      showToast('error', 'Error al cargar calendarios', 'No se pudieron obtener los calendarios.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, accessToken, defaultCalendarId, selectCalendar]);

  const loadEvents = useCallback(async () => {
    if (!locationId || !accessToken || !selectedCalendar) return;

    try {
      setLoading(true);

      // Calcular rango de fechas según la vista
      const { startTime, endTime } = getDateRange();

      const eventsData = await calendarsService.getEvents(
        locationId,
        startTime,
        endTime,
        accessToken,
        selectedCalendar.id
      );

      setEvents(eventsData);

      // Calcular estadísticas del mes visible
      const monthStart = new Date(currentDate);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);

      const monthlyData = await calendarsService.getEvents(
        locationId,
        monthStart.getTime(),
        monthEnd.getTime(),
        accessToken,
        selectedCalendar.id
      );

      setStats(calendarsService.calculateStats(monthlyData));
    } catch (error) {
      showToast('error', 'Error al cargar citas', 'No se pudieron obtener las citas del calendario.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, accessToken, selectedCalendar, currentDate, getDateRange]);

  // Cargar eventos próximos desde HOY (independiente del calendario visible)
  const loadUpcomingEvents = useCallback(async () => {
    if (!locationId || !accessToken || !selectedCalendar) return;

    try {
      const upcomingData = await calendarsService.getFutureAppointments(
        selectedCalendar.id,
        locationId,
        accessToken
      );

      setUpcomingEvents(upcomingData);
    } catch (error) {
      // Error silencioso - no afecta funcionalidad principal
    }
  }, [locationId, accessToken, selectedCalendar]);

  // Cargar horarios bloqueados del calendario
  const loadBlockedSlots = useCallback(async () => {
    if (!locationId || !accessToken || !selectedCalendar) return;

    try {
      // Usar el mismo rango de fechas que loadEvents
      const { startTime, endTime } = getDateRange();

      const blockedSlotsData = await calendarsService.getBlockedSlots(
        selectedCalendar.id,
        locationId,
        startTime,
        endTime,
        accessToken
      );

      setBlockedSlots(blockedSlotsData);
    } catch (error) {
      // Error silencioso - si falla, simplemente no se muestran blocked slots
      setBlockedSlots([]);
    }
  }, [locationId, accessToken, selectedCalendar, getDateRange]);

  // useEffects - ejecutar después de declarar las funciones
  // Cargar calendarios al montar (incluye defaultCalendarId para reaccionar a cambios de configuración)
  useEffect(() => {
    if (locationId && accessToken) {
      loadCalendars();
    }
  }, [locationId, accessToken, defaultCalendarId, loadCalendars]);

  // Cargar eventos cuando cambie el calendario o la fecha
  useEffect(() => {
    if (selectedCalendar && locationId && accessToken) {
      loadEvents();
      // DESACTIVADO TEMPORALMENTE - Blocked Slots
      // loadBlockedSlots();
    }
  }, [selectedCalendar, currentDate, viewMode, locationId, accessToken, loadEvents, loadBlockedSlots]);

  // Cargar próximas citas solo cuando cambie el calendario seleccionado
  useEffect(() => {
    if (selectedCalendar && locationId && accessToken) {
      loadUpcomingEvents();
    }
  }, [selectedCalendar, locationId, accessToken, loadUpcomingEvents]);

  // Cerrar dropdown al presionar Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCalendarDropdownOpen(false);
      }
    };

    if (isCalendarDropdownOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isCalendarDropdownOpen]);

  // Auto-scroll en vistas de semana y día
  useEffect(() => {
    if (!weekGridRef.current && !dayGridRef.current) return;

    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const target = Math.max(currentHour - 2, 0); // deja margen por encima
    const scrollPosition = target * 60; // 60px por cada hora

    if (viewMode === 'week' && weekGridRef.current) {
      weekGridRef.current.scrollTop = scrollPosition;
    }

    if (viewMode === 'day' && dayGridRef.current) {
      dayGridRef.current.scrollTop = scrollPosition;
    }
  }, [viewMode, currentDate]);

  // Eventos agrupados por fecha para reutilizar en todas las vistas
  const eventsByDate = useMemo(() => calendarsService.groupEventsByDate(events), [events]);

  // Agrupar blocked slots por fecha
  const blockedSlotsByDate = useMemo(() => {
    const grouped: Record<string, BlockedSlot[]> = {};
    blockedSlots.forEach(slot => {
      if (!grouped[slot.date]) {
        grouped[slot.date] = [];
      }
      grouped[slot.date].push(slot);
    });
    return grouped;
  }, [blockedSlots]);

  // Generar celdas del calendario mensual (SIEMPRE 4 semanas = 28 días)
  const monthCells = useMemo((): DayCell[] => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    // Primer día del mes
    const firstDay = new Date(year, month, 1);
    // Lunes de la semana del primer día
    const startDay = new Date(firstDay);
    const dayOfWeek = (firstDay.getDay() + 6) % 7; // 0 = lunes
    startDay.setDate(firstDay.getDate() - dayOfWeek);

    const cells: DayCell[] = [];

    // Generar EXACTAMENTE 28 celdas (4 semanas)
    for (let i = 0; i < 28; i++) {
      const date = new Date(startDay);
      date.setDate(startDay.getDate() + i);

      const dateKey = date.toISOString().split('T')[0];
      const dayEvents = eventsByDate[dateKey] || [];

      cells.push({
        date,
        isCurrentMonth: date.getMonth() === month,
        events: dayEvents
      });
    }

    return cells;
  }, [currentDate, eventsByDate]);

  // Próximas citas (siempre desde HOY, no del rango visible)
  const upcomingAppointments = useMemo(() => {
    return upcomingEvents.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
  }, [upcomingEvents]);

  // Navegación del calendario
  const handlePrev = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(newDate.getMonth() - 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() - 7);
    } else {
      newDate.setDate(newDate.getDate() - 1);
    }
    setCurrentDate(newDate);
  };

  const handleNext = () => {
    const newDate = new Date(currentDate);
    if (viewMode === 'month') {
      newDate.setMonth(newDate.getMonth() + 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + 7);
    } else {
      newDate.setDate(newDate.getDate() + 1);
    }
    setCurrentDate(newDate);
  };

  const handleToday = () => {
    setCurrentDate(new Date());
  };

  // Búsqueda de citas
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];

    const query = searchQuery.toLowerCase().trim();
    const allEvents = [...events, ...upcomingEvents];

    // Eliminar duplicados por ID
    const uniqueEvents = allEvents.filter((event, index, self) =>
      index === self.findIndex((e) => e.id === event.id)
    );

    return uniqueEvents
      .filter((event) => {
        // Buscar por título (nombre del contacto)
        if (event.title?.toLowerCase().includes(query)) return true;

        // Buscar por estado de cita
        if (event.appointmentStatus?.toLowerCase().includes(query)) return true;
        if (getStatusLabel(event.appointmentStatus).toLowerCase().includes(query)) return true;

        // Buscar por fecha (formato: "15 enero", "15/01", "enero 2025", etc)
        const eventDate = new Date(event.startTime);
        const dateStr = formatLocalDateShort(eventDate).toLowerCase();
        const monthName = MONTH_NAMES[eventDate.getMonth()].toLowerCase();
        const dayMonth = `${eventDate.getDate()} ${monthName}`;
        const yearStr = eventDate.getFullYear().toString();

        if (dateStr.includes(query)) return true;
        if (monthName.includes(query)) return true;
        if (dayMonth.includes(query)) return true;
        if (yearStr.includes(query)) return true;

        return false;
      })
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, 10); // Limitar a 10 resultados
  }, [searchQuery, events, upcomingEvents]);

  const handleSelectSearchResult = (event: CalendarEvent) => {
    // Navegar a la fecha de la cita
    const eventDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
    setCurrentDate(eventDate);

    // Cambiar a vista de día para mejor visualización
    setViewMode('day');

    // Cerrar dropdown y limpiar búsqueda
    setIsSearchDropdownOpen(false);
    setSearchQuery('');

    // Abrir modal de la cita
    setTimeout(() => {
      handleEventClick(event);
    }, 300);
  };

  const openCreateModal = () => {
    if (!selectedCalendar) {
      showToast('warning', 'Selecciona un calendario', 'Debes elegir un calendario activo antes de programar una cita.');
      return;
    }

    const baseDate = selectedDate ?? currentDate;
    const now = new Date();
    const reference = new Date(baseDate);
    if (isSameDay(reference, now)) {
      reference.setHours(now.getHours(), 0, 0, 0);
    } else {
      reference.setHours(9, 0, 0, 0);
    }

    const startISO = reference.toISOString();
    const endRef = new Date(reference.getTime() + 60 * 60 * 1000);
    const endISO = endRef.toISOString();

    setCreateDefaults({
      start: startISO,
      end: endISO,
      timeZone: selectedCalendar?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      title: selectedCalendar?.eventTitle || ''
    });
    setCreateScheduleMode('default'); // Botón normal usa modo por defecto
    setIsCreateModalOpen(true);
  };

  // Doble click en día para crear cita con esa fecha
  const handleDayDoubleClick = (date: Date) => {
    if (!selectedCalendar) {
      showToast('warning', 'Selecciona un calendario', 'Debes elegir un calendario activo antes de programar una cita.');
      return;
    }

    const now = new Date();
    const reference = new Date(date);

    // Si es hoy, usar la hora actual (redondeada a la siguiente hora)
    if (isSameDay(reference, now)) {
      reference.setHours(now.getHours() + 1, 0, 0, 0);
    } else {
      // Si es otro día, usar las 9:00 AM
      reference.setHours(9, 0, 0, 0);
    }

    const startISO = reference.toISOString();
    const endRef = new Date(reference.getTime() + 60 * 60 * 1000); // 1 hora de duración
    const endISO = endRef.toISOString();

    setCreateDefaults({
      start: startISO,
      end: endISO,
      timeZone: selectedCalendar?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      title: selectedCalendar?.eventTitle || ''
    });
    setCreateScheduleMode('custom'); // Doble click en día usa modo personalizado
    setIsCreateModalOpen(true);
  };

  const handleCreateAppointment = async (payload: {
    title: string;
    appointmentStatus: CalendarEvent['appointmentStatus'];
    startTime: string;
    endTime: string;
    notes: string;
    address: string;
    timeZone: string;
    contactId?: string;
  }) => {
    if (!selectedCalendar || !locationId || !accessToken) return;

    try {
      setLoading(true);
      await calendarsService.createAppointment(
        {
          calendarId: selectedCalendar.id,
          locationId,
          ...payload
        },
        accessToken
      );
      showToast('success', 'Cita programada', 'La nueva cita se creó correctamente.');
      setIsCreateModalOpen(false);
      await loadEvents();
      await loadUpcomingEvents();
    } catch (error) {
      showToast('error', 'No se pudo crear la cita', 'Intenta nuevamente más tarde.');
    } finally {
      setLoading(false);
    }
  };

  // Manejar apertura del modal de cita
  const handleEventClick = (event: CalendarEvent) => {
    setSelectedEvent(event);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedEvent(null);
  };

  // Actualizar cita
  const handleSaveAppointment = async (eventId: string, updates: Partial<CalendarEvent>) => {
    if (!accessToken) return;

    try {
      await calendarsService.updateAppointment(eventId, updates, accessToken);
      showToast('success', 'Cita actualizada', 'Los cambios se guardaron correctamente.');

      // Recargar eventos
      loadEvents();
    } catch (error) {
      showToast('error', 'Error al actualizar', 'No se pudo guardar la cita. Intenta nuevamente.');
      throw error;
    }
  };

  // Eliminar cita
  const handleDeleteAppointment = async (eventId: string) => {
    if (!accessToken) return;

    try {
      await calendarsService.deleteEvent(eventId, accessToken);
      showToast('success', 'Cita eliminada', 'La cita se eliminó correctamente.');

      // Recargar eventos
      loadEvents();
    } catch (error) {
      showToast('error', 'Error al eliminar', 'No se pudo eliminar la cita. Intenta nuevamente.');
      throw error;
    }
  };

  // === BLOCKED SLOTS HANDLERS ===

  // Abrir modal para crear blocked slot
  const handleOpenCreateBlockedSlot = () => {
    setIsCreateBlockedSlotMode(true);
    setSelectedBlockedSlot(null);
    setBlockedSlotDefaults({
      start: '',
      end: '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    });
    setIsBlockedSlotModalOpen(true);
  };

  // Crear nuevo blocked slot
  const handleCreateBlockedSlot = async (payload: any) => {
    if (!selectedCalendar || !locationId || !accessToken) return;

    try {
      setLoading(true);
      await calendarsService.createBlockedSlot(
        {
          calendarId: selectedCalendar.id,
          locationId,
          ...payload
        },
        accessToken
      );
      showToast('success', 'Horario bloqueado', 'El horario se bloqueó correctamente.');
      setIsBlockedSlotModalOpen(false);
      await loadBlockedSlots();
    } catch (error) {
      showToast('error', 'No se pudo bloquear el horario', 'Intenta nuevamente más tarde.');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  // Abrir modal para editar blocked slot
  const handleBlockedSlotClick = (slot: BlockedSlot & { id?: string }) => {
    setIsCreateBlockedSlotMode(false);
    setSelectedBlockedSlot(slot);
    setIsBlockedSlotModalOpen(true);
  };

  // Actualizar blocked slot
  const handleUpdateBlockedSlot = async (payload: any, eventId?: string) => {
    if (!accessToken || !eventId) return;

    try {
      await calendarsService.updateBlockedSlot(eventId, payload, accessToken);
      showToast('success', 'Horario actualizado', 'Los cambios se guardaron correctamente.');
      setIsBlockedSlotModalOpen(false);
      await loadBlockedSlots();
    } catch (error) {
      showToast('error', 'Error al actualizar', 'No se pudo guardar el horario. Intenta nuevamente.');
      throw error;
    }
  };

  // Eliminar blocked slot
  const handleDeleteBlockedSlot = async (blockedSlotId: string) => {
    if (!accessToken) return;

    try {
      await calendarsService.deleteBlockedSlot(blockedSlotId, accessToken);
      showToast('success', 'Bloqueo eliminado', 'El horario se desbloqueó correctamente.');
      setIsBlockedSlotModalOpen(false);
      await loadBlockedSlots();
    } catch (error) {
      showToast('error', 'Error al eliminar', 'No se pudo eliminar el bloqueo. Intenta nuevamente.');
      throw error;
    }
  };

  // Handler unificado para crear/actualizar blocked slot
  const handleSaveBlockedSlot = async (payload: any, eventId?: string) => {
    if (isCreateBlockedSlotMode) {
      await handleCreateBlockedSlot(payload);
    } else {
      await handleUpdateBlockedSlot(payload, eventId);
    }
  };

  // Renderizar label según vista
  const renderLabel = () => {
    if (viewMode === 'month') {
      return `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    } else if (viewMode === 'week') {
      return `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    } else {
      const dayName = DAYS_SHORT[(currentDate.getDay() + 6) % 7];
      return `${dayName} ${currentDate.getDate()} · ${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    }
  };

  // Drag & Drop Handlers
  const handleDragStart = (event: CalendarEvent) => (e: React.DragEvent) => {
    setDraggedEvent(event);
    e.dataTransfer.effectAllowed = 'move';
    // Agregar clase visual al elemento arrastrado
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  };

  const handleDragEnd = (e: React.DragEvent) => {
    // Restaurar opacidad
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1';
    }
    setDraggedEvent(null);
    setDragOverDate(null);
  };

  const handleDragOver = (date: Date) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverDate(date);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    setDragOverDate(null);
  };

  const handleDrop = (dropDate: Date) => async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverDate(null);

    if (!draggedEvent) return;

    // Calcular nueva fecha/hora manteniendo la hora original
    const originalStart = new Date(draggedEvent.startTime);
    const originalEnd = new Date(draggedEvent.endTime);

    // Nueva fecha con la hora original
    const newStart = new Date(dropDate);
    newStart.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);

    const duration = originalEnd.getTime() - originalStart.getTime();
    const newEnd = new Date(newStart.getTime() + duration);

    // Cerrar modal primero (si estaba abierto)
    setIsModalOpen(false);
    setDraggedEvent(null);

    // Esperar un tick para que el modal se cierre completamente
    await new Promise(resolve => setTimeout(resolve, 50));

    // Crear un objeto COMPLETAMENTE NUEVO (sin reusar referencia)
    const updatedEvent: CalendarEvent = {
      id: draggedEvent.id,
      title: draggedEvent.title,
      startTime: newStart.toISOString(),
      endTime: newEnd.toISOString(),
      appointmentStatus: draggedEvent.appointmentStatus,
      calendarId: draggedEvent.calendarId,
      contactId: draggedEvent.contactId,
      assignedUserId: draggedEvent.assignedUserId,
      address: draggedEvent.address,
      notes: draggedEvent.notes,
      timeZone: draggedEvent.timeZone
    };

    // Abrir modal con el evento actualizado
    setSelectedEvent(updatedEvent);
    setIsModalOpen(true);
  };

  // Time Selection Handlers (vistas semana/día)
  const calculateTimeFromPosition = (
    e: React.MouseEvent,
    dayColumn: HTMLElement,
    date: Date
  ): { hour: number; minute: number } => {
    const rect = dayColumn.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const totalMinutes = Math.floor((y / 60) * 60); // 60px por hora, convertir a minutos
    const hour = Math.floor(totalMinutes / 60);
    const minute = Math.floor((totalMinutes % 60) / 15) * 15; // Redondear a intervalos de 15 min

    return {
      hour: Math.max(0, Math.min(23, hour)),
      minute: Math.max(0, Math.min(45, minute))
    };
  };

  // Renderizar overlay de selección de tiempo
  const renderTimeSelectionOverlay = (columnDate: Date) => {
    if (!isSelecting || !selectionStart || !selectionEnd) return null;

    // Solo mostrar si estamos seleccionando en esta columna
    if (selectionStart.date.toDateString() !== columnDate.toDateString()) return null;

    // Calcular posición y altura del overlay
    const startMinutes = selectionStart.hour * 60 + selectionStart.minute;
    const endMinutes = selectionEnd.hour * 60 + selectionEnd.minute;
    const minMinutes = Math.min(startMinutes, endMinutes);
    const maxMinutes = Math.max(startMinutes, endMinutes);

    const totalMinutesInDay = 24 * 60;
    const top = (minMinutes / totalMinutesInDay) * 100;
    const height = ((maxMinutes - minMinutes) / totalMinutesInDay) * 100;

    return (
      <div
        className={styles.timeSelectionOverlay}
        style={{
          top: `${top}%`,
          height: `${Math.max(height, 1)}%`
        }}
      />
    );
  };

  const handleTimeSelectionStart = (date: Date) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedCalendar) return;
    if (e.button !== 0) return; // Solo click izquierdo

    const dayColumn = e.currentTarget;
    const { hour, minute } = calculateTimeFromPosition(e, dayColumn, date);

    setIsSelecting(true);
    setSelectionStart({ date, hour, minute });
    setSelectionEnd({ date, hour, minute });
  };

  const handleTimeSelectionMove = (date: Date) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isSelecting || !selectionStart) return;

    const dayColumn = e.currentTarget;
    const { hour, minute } = calculateTimeFromPosition(e, dayColumn, date);

    setSelectionEnd({ date, hour, minute });
  };

  const handleTimeSelectionEnd = useCallback(() => {
    if (!isSelecting || !selectionStart || !selectionEnd || !selectedCalendar) return;

    setIsSelecting(false);

    // Calcular inicio y fin (asegurar que start < end)
    const startTime = new Date(selectionStart.date);
    startTime.setHours(selectionStart.hour, selectionStart.minute, 0, 0);

    const endTime = new Date(selectionEnd.date);
    endTime.setHours(selectionEnd.hour, selectionEnd.minute + 15, 0, 0); // +15 min para tener duración

    // Si el usuario arrastró hacia arriba, invertir
    const actualStart = startTime < endTime ? startTime : endTime;
    const actualEnd = startTime < endTime ? endTime : startTime;

    // Asegurar duración mínima de 15 minutos
    if (actualEnd.getTime() - actualStart.getTime() < 15 * 60 * 1000) {
      actualEnd.setMinutes(actualStart.getMinutes() + 15);
    }

    // Limpiar selección
    setSelectionStart(null);
    setSelectionEnd(null);

    // Abrir modal de crear cita con esas horas
    setCreateDefaults({
      start: actualStart.toISOString(),
      end: actualEnd.toISOString(),
      timeZone: selectedCalendar.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      title: selectedCalendar.eventTitle || ''
    });
    setCreateScheduleMode('custom'); // Selección de tiempo usa modo personalizado
    setIsCreateModalOpen(true);
  }, [isSelecting, selectionStart, selectionEnd, selectedCalendar]);

  // useEffect para manejar mouseUp global (finalizar selección de tiempo)
  useEffect(() => {
    if (isSelecting) {
      const handleGlobalMouseUp = () => {
        handleTimeSelectionEnd();
      };

      window.addEventListener('mouseup', handleGlobalMouseUp);
      return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }
  }, [isSelecting, handleTimeSelectionEnd]);

  // Doble click en hora específica (vistas semana/día)
  const handleTimeDoubleClick = (date: Date) => (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectedCalendar) {
      showToast('warning', 'Selecciona un calendario', 'Debes elegir un calendario activo antes de programar una cita.');
      return;
    }

    const dayColumn = e.currentTarget;
    const { hour, minute } = calculateTimeFromPosition(e, dayColumn, date);

    const startTime = new Date(date);
    startTime.setHours(hour, minute, 0, 0);

    const endTime = new Date(startTime);
    endTime.setHours(hour, minute + 60, 0, 0); // 1 hora de duración

    setCreateDefaults({
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      timeZone: selectedCalendar?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      title: selectedCalendar?.eventTitle || ''
    });
    setCreateScheduleMode('custom'); // Doble click en hora usa modo personalizado
    setIsCreateModalOpen(true);
  };

  // Color del evento según estado (compatible con dark mode)
  const getEventColor = (status: string) => {
    const isDark = theme === 'dark';

    switch (status.toLowerCase()) {
      case 'confirmed':
        return isDark ? 'rgba(96, 165, 250, 0.3)' : 'rgba(59, 130, 246, 0.2)';
      case 'pending':
        return isDark ? 'rgba(251, 191, 36, 0.3)' : 'rgba(245, 158, 11, 0.2)';
      case 'cancelled':
        return isDark ? 'rgba(248, 113, 113, 0.3)' : 'rgba(239, 68, 68, 0.2)';
      case 'showed':
        return isDark ? 'rgba(52, 211, 153, 0.3)' : 'rgba(16, 185, 129, 0.2)';
      case 'noshow':
        return isDark ? 'rgba(156, 163, 175, 0.3)' : 'rgba(107, 114, 128, 0.2)';
      case 'rescheduled':
        return isDark ? 'rgba(167, 139, 250, 0.3)' : 'rgba(139, 92, 246, 0.2)';
      default:
        return isDark ? 'rgba(209, 213, 219, 0.3)' : 'rgba(156, 163, 175, 0.2)';
    }
  };

  if (!locationId || !accessToken) {
    return (
      <PageContainer>
        <div className={styles.emptyState}>
          <CalendarIcon size={48} className={styles.emptyIcon} />
          <h2>Configuración requerida</h2>
          <p>Debes configurar tu cuenta de HighLevel para ver los calendarios.</p>
        </div>
      </PageContainer>
    );
  }

  if (loading && calendars.length === 0) {
    return <Loading message="Cargando calendarios..." />
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>Calendarios</h1>

        <div className={styles.headerControls}>
          {/* Selector de calendarios */}
          <div className={styles.calendarSelector}>
            <button
              className={styles.calendarDropdownButton}
              onClick={() => setIsCalendarDropdownOpen(!isCalendarDropdownOpen)}
              disabled={loading || calendars.length === 0}
            >
              <span className={styles.dropdownButtonText}>
                {selectedCalendar?.name || 'Selecciona un calendario'}
              </span>
              <ChevronDown
                size={18}
                className={`${styles.dropdownIcon} ${isCalendarDropdownOpen ? styles.dropdownIconOpen : ''}`}
              />
            </button>

          {isCalendarDropdownOpen && (
            <>
              <div
                className={styles.dropdownOverlay}
                onClick={() => setIsCalendarDropdownOpen(false)}
              />
              <div className={styles.dropdownMenu}>
                {calendars.length === 0 ? (
                  <div className={styles.dropdownEmpty}>
                    No hay calendarios disponibles
                  </div>
                ) : (
                  calendars.map((calendar) => (
                    <button
                      key={calendar.id}
                      className={`${styles.dropdownItem} ${selectedCalendar?.id === calendar.id ? styles.dropdownItemActive : ''}`}
                      onClick={() => {
                        selectCalendar(calendar);
                        setIsCalendarDropdownOpen(false);
                      }}
                    >
                      <span className={styles.dropdownItemText}>{calendar.name}</span>
                      {selectedCalendar?.id === calendar.id && (
                        <Check size={16} className={styles.dropdownCheckIcon} />
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

          {/* Buscador de citas */}
          <div className={styles.searchContainer}>
            <div className={styles.searchInputWrapper}>
              <Search size={18} className={styles.searchIcon} />
              <input
                ref={searchInputRef}
                type="text"
                className={styles.searchInput}
                placeholder="Buscar citas..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setIsSearchDropdownOpen(e.target.value.trim().length > 0);
                }}
                onFocus={() => {
                  if (searchQuery.trim().length > 0) {
                    setIsSearchDropdownOpen(true);
                  }
                }}
              />
              {searchQuery && (
                <button
                  className={styles.searchClearButton}
                  onClick={() => {
                    setSearchQuery('');
                    setIsSearchDropdownOpen(false);
                  }}
                  aria-label="Limpiar búsqueda"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {/* Dropdown de resultados */}
            {isSearchDropdownOpen && searchResults.length > 0 && (
              <>
                <div
                  className={styles.searchOverlay}
                  onClick={() => setIsSearchDropdownOpen(false)}
                />
                <div className={styles.searchDropdown}>
                  {searchResults.map((event) => {
                    const eventDate = new Date(event.startTime);
                    return (
                      <button
                        key={event.id}
                        className={styles.searchResultItem}
                        onClick={() => handleSelectSearchResult(event)}
                      >
                        <div className={styles.searchResultInfo}>
                          <div className={styles.searchResultTitle}>
                            {event.title || '(Sin título)'}
                          </div>
                          <div className={styles.searchResultMeta}>
                            {formatLocalDateShort(eventDate)} · {formatTime12h(event.startTime)} · {getStatusLabel(event.appointmentStatus)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* Mensaje cuando no hay resultados */}
            {isSearchDropdownOpen && searchQuery.trim().length > 0 && searchResults.length === 0 && (
              <>
                <div
                  className={styles.searchOverlay}
                  onClick={() => setIsSearchDropdownOpen(false)}
                />
                <div className={styles.searchDropdown}>
                  <div className={styles.searchEmpty}>
                    No se encontraron citas
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Botón de Configuración */}
          <button
            className={styles.settingsButton}
            onClick={() => navigate('/settings/calendars')}
            title="Configurar calendarios"
          >
            <Settings size={18} />
            <span>Configuración</span>
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className={styles.statsGrid}>
        <KpiCard
          title="Citas pendientes · mes seleccionado"
          value={stats.pending}
        />
        <KpiCard
          title="Asistencias · mes seleccionado"
          value={stats.showed}
        />
        <KpiCard
          title="Citas canceladas · mes seleccionado"
          value={stats.cancelled}
        />
        <KpiCard
          title="Citas reprogramadas · mes seleccionado"
          value={stats.rescheduled}
        />
      </div>

      {/* Grid principal */}
      <div className={`${styles.mainGrid}${viewMode === 'month' ? ` ${styles.mainGridMonth}` : ''}`}>
        {/* Calendario */}
        <Card className={`${styles.calendarCard}${viewMode === 'month' ? ` ${styles.calendarCardMonth}` : ''}`}>
          <div className={`${styles.calendarCardContent}${viewMode === 'month' ? ` ${styles.calendarContentMonth}` : ''}`}>
          {/* Barra de vista */}
          <div className={styles.viewBar}>
            <div className={styles.viewBarActions}>
              <Button
                variant="primary"
                onClick={openCreateModal}
                size="sm"
              >
                <Plus size={16} />
                <span className={styles.buttonText}>Programar</span>
              </Button>
              {/* DESACTIVADO TEMPORALMENTE - Blocked Slots
              <Button
                variant="secondary"
                onClick={handleOpenCreateBlockedSlot}
                size="sm"
              >
                <Lock size={16} />
                <span className={styles.buttonText}>Bloquear</span>
              </Button>
              */}
            </div>

            <TabList
              tabs={viewTabs}
              activeTab={viewMode}
              onTabChange={(value) => setViewMode(value as ViewMode)}
              variant="compact"
            />

            <div className={styles.dateNav}>
              <Button variant="secondary" onClick={handleToday} size="sm">
                Hoy
              </Button>
              <button className={styles.navBtn} onClick={handlePrev} aria-label="Anterior">
                <ChevronLeft size={16} />
              </button>

              {/* Dropdowns de mes y año */}
              <div className={styles.dateSelectors}>
                {/* Dropdown de mes */}
                <div className={styles.dateSelectorWrapper}>
                  <button
                    className={styles.dateSelector}
                    onClick={() => setIsMonthDropdownOpen(!isMonthDropdownOpen)}
                  >
                    <span>{MONTH_NAMES[currentDate.getMonth()]}</span>
                    <ChevronDown size={14} className={`${styles.selectorIcon} ${isMonthDropdownOpen ? styles.selectorIconOpen : ''}`} />
                  </button>
                  {isMonthDropdownOpen && (
                    <>
                      <div className={styles.selectorOverlay} onClick={() => setIsMonthDropdownOpen(false)} />
                      <div className={styles.selectorMenu}>
                        {MONTH_NAMES.map((month, index) => (
                          <button
                            key={index}
                            className={`${styles.selectorItem} ${currentDate.getMonth() === index ? styles.selectorItemActive : ''}`}
                            onClick={() => {
                              const newDate = new Date(currentDate);
                              newDate.setMonth(index);
                              setCurrentDate(newDate);
                              setIsMonthDropdownOpen(false);
                            }}
                          >
                            {month}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Dropdown de año */}
                <div className={styles.dateSelectorWrapper}>
                  <button
                    className={styles.dateSelector}
                    onClick={() => setIsYearDropdownOpen(!isYearDropdownOpen)}
                  >
                    <span>{currentDate.getFullYear()}</span>
                    <ChevronDown size={14} className={`${styles.selectorIcon} ${isYearDropdownOpen ? styles.selectorIconOpen : ''}`} />
                  </button>
                  {isYearDropdownOpen && (
                    <>
                      <div className={styles.selectorOverlay} onClick={() => setIsYearDropdownOpen(false)} />
                      <div className={styles.selectorMenu}>
                        {Array.from({ length: 11 }, (_, i) => currentDate.getFullYear() - 5 + i).map((year) => (
                          <button
                            key={year}
                            className={`${styles.selectorItem} ${currentDate.getFullYear() === year ? styles.selectorItemActive : ''}`}
                            onClick={() => {
                              const newDate = new Date(currentDate);
                              newDate.setFullYear(year);
                              setCurrentDate(newDate);
                              setIsYearDropdownOpen(false);
                            }}
                          >
                            {year}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <button className={styles.navBtn} onClick={handleNext} aria-label="Siguiente">
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Vista del calendario */}
          {viewMode === 'month' && (
            <div className={styles.calendarView}>
              {/* Encabezados de días */}
              <div className={styles.daysHeader}>
                {DAYS_SHORT.map((day) => (
                  <div key={day} className={styles.dayName}>
                    {day}
                  </div>
                ))}
              </div>

              {/* Grid de días */}
              <div className={styles.monthGrid}>
                {(() => {
                  const todayString = new Date().toDateString();
                  return monthCells.map((cell, index) => {
                    const isToday = cell.date.toDateString() === todayString;
                    const cellClasses = [
                      styles.dayCell,
                      !cell.isCurrentMonth ? styles.dayCellOther : '',
                      isToday ? styles.dayCellToday : ''
                    ].filter(Boolean).join(' ');
                    const dayNumberClasses = [
                      styles.dayNumber,
                      isToday ? styles.dayNumberToday : ''
                    ].filter(Boolean).join(' ');

                    const isDragOver = dragOverDate && cell.date.toDateString() === dragOverDate.toDateString();
                    const finalCellClasses = isDragOver ? `${cellClasses} ${styles.dayCellDragOver}` : cellClasses;

                    return (
                      <div
                        key={index}
                        className={finalCellClasses}
                        onClick={() => setSelectedDate(cell.date)}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleDayDoubleClick(cell.date);
                        }}
                        onDragOver={handleDragOver(cell.date)}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop(cell.date)}
                      >
                        <div className={dayNumberClasses}>{cell.date.getDate()}</div>
                        <div className={styles.eventsContainer}>
                          {cell.events.slice(0, 3).map((event) => (
                            <div
                              key={event.id}
                              className={`${styles.eventChip} ${styles[`event${event.appointmentStatus.charAt(0).toUpperCase() + event.appointmentStatus.slice(1).toLowerCase()}`] || styles.eventDefault}`}
                              draggable
                              onDragStart={handleDragStart(event)}
                              onDragEnd={handleDragEnd}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEventClick(event);
                              }}
                              onMouseEnter={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoveredEventId(event.id);
                                setTooltipPosition({
                                  top: rect.top + window.scrollY - 20,
                                  left: rect.left + rect.width / 2
                                });
                              }}
                              onMouseLeave={() => {
                                setHoveredEventId(null);
                                setTooltipPosition(null);
                              }}
                            >
                              <span className={styles.eventTime}>
                                {formatTime12h(event.startTime)}
                              </span>{' '}
                              {event.title || '(Sin título)'}

                              {/* Tooltip */}
                              {hoveredEventId === event.id && tooltipPosition && createPortal(
                                <div
                                  className={styles.eventTooltip}
                                  style={{
                                    position: 'fixed',
                                    top: `${tooltipPosition.top}px`,
                                    left: `${tooltipPosition.left}px`,
                                    transform: 'translate(-50%, -100%)',
                                    zIndex: 2147483647
                                  }}
                                >
                                  <div className={styles.tooltipTitle}>
                                    {event.title || '(Sin título)'}
                                  </div>
                                  <div className={styles.tooltipTime}>
                                    {formatTime12h(event.startTime)} - {formatTime12h(event.endTime)}
                                  </div>
                                  <div className={styles.tooltipStatus}>
                                    Estado: {getStatusLabel(event.appointmentStatus)}
                                  </div>
                                  {event.address && (
                                    <div className={styles.tooltipAddress}>
                                      📍 {event.address}
                                    </div>
                                  )}
                                  {event.notes && (
                                    <div className={styles.tooltipNotes}>
                                      {event.notes}
                                    </div>
                                  )}
                                </div>,
                                document.body
                              )}
                            </div>
                          ))}
                          {cell.events.length > 3 && (
                            <div className={styles.eventMore}>+{cell.events.length - 3} más</div>
                          )}
                          {/* DESACTIVADO TEMPORALMENTE - Blocked Slots Indicator
                          {(() => {
                            const dateKey = cell.date.toISOString().split('T')[0];
                            const dayBlockedSlots = blockedSlotsByDate[dateKey] || [];
                            if (dayBlockedSlots.length > 0) {
                              // Generar tooltip con info detallada de cada blocked slot
                              // Formato: "10:00-11:30 (Título) | 14:00-15:00 (Título 2)"
                              const tooltipContent = dayBlockedSlots.map(slot => {
                                const title = slot.reason || 'Bloqueado';
                                const timeRange = `${slot.startTime}-${slot.endTime}`;
                                return `${timeRange} (${title})`;
                              }).join(' | ');

                              return (
                                <div
                                  className={styles.blockedSlotsIndicator}
                                  title={tooltipContent}
                                  data-tooltip="true"
                                >
                                  <Lock size={12} className={styles.blockedIcon} />
                                  <span>{dayBlockedSlots.length} bloqueado{dayBlockedSlots.length > 1 ? 's' : ''}</span>
                                </div>
                              );
                            }
                            return null;
                          })()}
                          */}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {viewMode === 'week' && (
            <div className={styles.weekView}>
              {/* Encabezados de días de la semana */}
              <div className={styles.weekHeader}>
                <div className={styles.timeColumn}></div>
                {(() => {
                  const startOfWeek = new Date(currentDate);
                  const dayOfWeek = (currentDate.getDay() + 6) % 7;
                  startOfWeek.setDate(currentDate.getDate() - dayOfWeek);

                  return Array.from({ length: 7 }).map((_, i) => {
                    const date = new Date(startOfWeek);
                    date.setDate(startOfWeek.getDate() + i);
                    const isToday = date.toDateString() === new Date().toDateString();

                    return (
                      <div key={i} className={`${styles.weekDayHeader} ${isToday ? styles.weekDayHeaderToday : ''}`}>
                        <div className={styles.weekDayName}>{DAYS_SHORT[i]}</div>
                        <div className={`${styles.weekDayNumber} ${isToday ? styles.weekDayToday : ''}`}>
                          {date.getDate()}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              {/* Grid de horarios */}
              <div className={styles.weekGrid} ref={weekGridRef}>
                <div className={styles.timeColumn}>
                  {Array.from({ length: 24 }).map((_, hour) => (
                    <div key={hour} className={styles.timeSlot}>
                      <span className={styles.timeLabel}>{formatTime12h(`2000-01-01T${String(hour).padStart(2, '0')}:00:00`)}</span>
                    </div>
                  ))}
                </div>

                {/* Columnas de días */}
                {(() => {
                  const startOfWeek = new Date(currentDate);
                  const dayOfWeek = (currentDate.getDay() + 6) % 7;
                  startOfWeek.setDate(currentDate.getDate() - dayOfWeek);

                  return Array.from({ length: 7 }).map((_, dayIndex) => {
                    const columnDate = new Date(startOfWeek);
                    columnDate.setDate(startOfWeek.getDate() + dayIndex);
                    const isToday = columnDate.toDateString() === new Date().toDateString();
                    const dayEvents = events.filter((event) => {
                      const eventDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
                      const eventColumnDate = toDateInTimeZone(columnDate.toISOString(), event.timeZone) ?? columnDate;
                      return eventDate ? isSameDay(eventDate, eventColumnDate) : false;
                    });

                    return (
                      <div
                        key={dayIndex}
                        className={`${styles.dayColumn} ${isToday ? styles.dayColumnToday : ''}`}
                        onMouseDown={handleTimeSelectionStart(columnDate)}
                        onMouseMove={handleTimeSelectionMove(columnDate)}
                        onDoubleClick={handleTimeDoubleClick(columnDate)}
                      >
                        {/* Líneas de hora */}
                        {Array.from({ length: 24 }).map((_, hour) => (
                          <div key={hour} className={styles.hourLine}></div>
                        ))}

                        {/* Overlay de selección de tiempo */}
                        {renderTimeSelectionOverlay(columnDate)}

                        {/* Eventos posicionados */}
                        {dayEvents.map((event) => {
                          const startDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
                          const endDate = toDateInTimeZone(event.endTime, event.timeZone) ?? new Date(event.endTime);
                          const startHour = startDate.getHours() + startDate.getMinutes() / 60;
                          const endHour = endDate.getHours() + endDate.getMinutes() / 60;
                          const top = (startHour / 24) * 100;
                          const height = ((endHour - startHour) / 24) * 100;
                          const statusClass =
                            styles[`event${event.appointmentStatus.charAt(0).toUpperCase() + event.appointmentStatus.slice(1).toLowerCase()}`] ||
                            styles.eventDefault;

                          return (
                            <div
                              key={event.id}
                              className={`${styles.weekEvent} ${styles.eventBlock} ${statusClass}`}
                              style={{
                                top: `${top}%`,
                                height: `${height}%`
                              }}
                              onClick={() => handleEventClick(event)}
                              onMouseEnter={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoveredEventId(event.id);
                                setTooltipPosition({
                                  top: rect.top + window.scrollY - 20,
                                  left: rect.left + rect.width / 2
                                });
                              }}
                              onMouseLeave={() => {
                                setHoveredEventId(null);
                                setTooltipPosition(null);
                              }}
                            >
                              <div className={styles.weekEventTime}>
                                {formatTime12h(event.startTime)}
                              </div>
                              <div className={styles.weekEventTitle}>{event.title}</div>

                              {/* Tooltip */}
                              {hoveredEventId === event.id && tooltipPosition && createPortal(
                                <div
                                  className={styles.eventTooltip}
                                  style={{
                                    position: 'fixed',
                                    top: `${tooltipPosition.top}px`,
                                    left: `${tooltipPosition.left}px`,
                                    transform: 'translate(-50%, -100%)',
                                    zIndex: 2147483647
                                  }}
                                >
                                  <div className={styles.tooltipTitle}>
                                    {event.title || '(Sin título)'}
                                  </div>
                                  <div className={styles.tooltipTime}>
                                    {formatTime12h(event.startTime)} - {formatTime12h(event.endTime)}
                                  </div>
                                  <div className={styles.tooltipStatus}>
                                    Estado: {getStatusLabel(event.appointmentStatus)}
                                  </div>
                                  {event.address && (
                                    <div className={styles.tooltipAddress}>
                                      📍 {event.address}
                                    </div>
                                  )}
                                  {event.notes && (
                                    <div className={styles.tooltipNotes}>
                                      {event.notes}
                                    </div>
                                  )}
                                </div>,
                                document.body
                              )}
                            </div>
                          );
                        })}

                        {/* Blocked slots posicionados */}
                        {(() => {
                          const dateKey = columnDate.toISOString().split('T')[0];
                          const dayBlockedSlots = blockedSlotsByDate[dateKey] || [];

                          return dayBlockedSlots.map((slot, idx) => {
                            // Parsear startTime y endTime (formato "HH:mm")
                            const [startHour, startMinute] = slot.startTime.split(':').map(Number);
                            const [endHour, endMinute] = slot.endTime.split(':').map(Number);
                            const startHourDecimal = startHour + startMinute / 60;
                            const endHourDecimal = endHour + endMinute / 60;
                            const top = (startHourDecimal / 24) * 100;
                            const height = ((endHourDecimal - startHourDecimal) / 24) * 100;

                            return (
                              <div
                                key={`blocked-${idx}`}
                                className={styles.blockedSlot}
                                style={{
                                  top: `${top}%`,
                                  height: `${height}%`
                                }}
                                title={`Bloqueado: ${slot.reason || 'No disponible'} - Click para editar`}
                                onClick={() => handleBlockedSlotClick(slot as any)}
                              >
                                <div className={styles.blockedSlotLabel}>
                                  🔒 {slot.startTime} - {slot.endTime}
                                </div>
                                {slot.reason && (
                                  <div className={styles.blockedSlotReason}>
                                    {slot.reason}
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}

                        {/* Indicador de hora actual */}
                        {(() => {
                          const now = new Date();
                          const isToday = columnDate.toDateString() === now.toDateString();
                          if (!isToday) return null;

                          const currentHour = now.getHours() + now.getMinutes() / 60;
                          const position = (currentHour / 24) * 100;

                          return (
                            <div className={styles.currentTimeLine} style={{ top: `${position}%` }}>
                              <div className={styles.currentTimeDot}></div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {viewMode === 'day' && (
            <div className={styles.dayView}>
              {/* Header del día */}
              <div className={styles.dayHeader}>
                <div className={styles.dayHeaderInfo}>
                  <div className={styles.dayHeaderWeekday}>
                    {currentDate.toLocaleDateString('es-MX', { weekday: 'short' }).toUpperCase()}
                  </div>
                  <div className={styles.dayHeaderDate}>
                    <span className={styles.dayHeaderDay}>{currentDate.getDate()}</span>
                    <div className={styles.dayHeaderMeta}>
                      <span>{currentDate.toLocaleDateString('es-MX', { month: 'long' })}</span>
                      <span>{currentDate.getFullYear()}</span>
                    </div>
                  </div>
                </div>
                {currentDate.toDateString() === new Date().toDateString() && (
                  <span className={styles.dayHeaderChip}>Hoy</span>
                )}
              </div>

              {/* Grid de horarios del día */}
              <div className={styles.dayGrid} ref={dayGridRef}>
                <div className={styles.timeColumn}>
                  {Array.from({ length: 24 }).map((_, hour) => (
                    <div key={hour} className={styles.timeSlot}>
                      <span className={styles.timeLabel}>{formatTime12h(`2000-01-01T${String(hour).padStart(2, '0')}:00:00`)}</span>
                    </div>
                  ))}
                </div>

                <div
                  className={styles.dayColumn}
                  onMouseDown={handleTimeSelectionStart(currentDate)}
                  onMouseMove={handleTimeSelectionMove(currentDate)}
                  onDoubleClick={handleTimeDoubleClick(currentDate)}
                >
                  {/* Líneas de hora */}
                  {Array.from({ length: 24 }).map((_, hour) => (
                    <div key={hour} className={styles.hourLine}></div>
                  ))}

                  {/* Overlay de selección de tiempo */}
                  {renderTimeSelectionOverlay(currentDate)}

                  {/* Eventos del día */}
                  {(() => {
                    const currentDateZonedBase = currentDate.toISOString();
                    const dayEvents = events.filter((event) => {
                      const eventDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
                      const currentDateZoned =
                        toDateInTimeZone(currentDateZonedBase, event.timeZone) ?? currentDate;
                      return eventDate ? isSameDay(eventDate, currentDateZoned) : false;
                    });

                    return dayEvents.map((event) => {
                      const startDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
                      const endDate = toDateInTimeZone(event.endTime, event.timeZone) ?? new Date(event.endTime);
                      const totalMinutesInDay = 24 * 60;
                      const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
                      const rawDurationMinutes = Math.max(
                        (endDate.getTime() - startDate.getTime()) / 60000,
                        15
                      );
                      let adjustedDuration = Math.max(rawDurationMinutes, MIN_DAY_EVENT_MINUTES);
                      if (startMinutes + adjustedDuration > totalMinutesInDay) {
                        const availableMinutes = Math.max(totalMinutesInDay - startMinutes, 0);
                        adjustedDuration = Math.max(rawDurationMinutes, availableMinutes || MIN_DAY_EVENT_MINUTES);
                      }
                      const top = (startMinutes / totalMinutesInDay) * 100;
                      const height = (adjustedDuration / totalMinutesInDay) * 100;
                      const statusClass =
                        styles[`event${event.appointmentStatus.charAt(0).toUpperCase() + event.appointmentStatus.slice(1).toLowerCase()}`] ||
                        styles.eventDefault;
                      const rawTitle = event.title?.trim();
                      const rawDescription = (event.description?.trim() || event.notes?.trim()) ?? '';
                      const displayTitle = rawTitle || rawDescription || '(Sin título)';
                      const displayDescription =
                        rawDescription && rawDescription !== displayTitle ? rawDescription : '';
                      const statusLabel = getStatusLabel(event.appointmentStatus);
                      const tooltipText = [
                        displayTitle,
                        `${formatTime12h(event.startTime)} - ${formatTime12h(event.endTime)}`,
                        displayDescription
                      ].filter(Boolean).join(' • ');

                      return (
                        <div
                          key={event.id}
                          className={`${styles.dayEvent} ${styles.eventBlock} ${statusClass}`}
                          style={{
                            top: `${top}%`,
                            height: `${height}%`
                          }}
                          title={tooltipText}
                          onClick={() => handleEventClick(event)}
                        >
                          <div className={styles.dayEventHeader}>
                            <span className={styles.dayEventTime}>
                              {formatTime12h(event.startTime)} - {formatTime12h(event.endTime)}
                            </span>
                            <span className={styles.dayEventStatus}>{statusLabel}</span>
                          </div>
                          <div className={styles.dayEventTitle}>{displayTitle}</div>
                          {displayDescription && (
                            <div className={styles.dayEventDescription}>{displayDescription}</div>
                          )}
                        </div>
                      );
                    });
                  })()}

                  {/* Blocked slots del día */}
                  {(() => {
                    const dateKey = currentDate.toISOString().split('T')[0];
                    const dayBlockedSlots = blockedSlotsByDate[dateKey] || [];

                    return dayBlockedSlots.map((slot, idx) => {
                      // Parsear startTime y endTime (formato "HH:mm")
                      const [startHour, startMinute] = slot.startTime.split(':').map(Number);
                      const [endHour, endMinute] = slot.endTime.split(':').map(Number);
                      const totalMinutesInDay = 24 * 60;
                      const startMinutes = startHour * 60 + startMinute;
                      const endMinutes = endHour * 60 + endMinute;
                      const durationMinutes = endMinutes - startMinutes;
                      const top = (startMinutes / totalMinutesInDay) * 100;
                      const height = (durationMinutes / totalMinutesInDay) * 100;

                      return (
                        <div
                          key={`blocked-${idx}`}
                          className={styles.blockedSlot}
                          style={{
                            top: `${top}%`,
                            height: `${height}%`
                          }}
                          onClick={() => handleBlockedSlotClick(slot as any)}
                          title={`Bloqueado: ${slot.reason || 'No disponible'} - Click para editar`}
                        >
                          <div className={styles.blockedSlotLabel}>
                            🔒 {slot.startTime} - {slot.endTime}
                          </div>
                          {slot.reason && (
                            <div className={styles.blockedSlotReason}>
                              {slot.reason}
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}

                  {/* Indicador de hora actual */}
                  {(() => {
                    const now = new Date();
                    const isToday = currentDate.toDateString() === now.toDateString();
                    if (!isToday) return null;

                    const currentHour = now.getHours() + now.getMinutes() / 60;
                    const position = (currentHour / 24) * 100;

                    return (
                      <div className={styles.currentTimeLine} style={{ top: `${position}%` }}>
                        <div className={styles.currentTimeDot}></div>
                        <div className={styles.currentTimeLabel}>{formatTime12h(now.toISOString())}</div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}
          </div>
        </Card>

        {/* Próximas citas */}
        <Card className={styles.upcomingCard}>
          <div className={styles.cardHeader}>
            <h3>Próximas citas</h3>
          </div>

          <div className={styles.upcomingList}>
            {upcomingAppointments.length === 0 ? (
              <p className={styles.emptyText}>No hay citas próximas</p>
            ) : (
              upcomingAppointments.map((event) => (
                <div
                  key={event.id}
                  className={styles.upcomingItem}
                  onClick={() => handleEventClick(event)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className={styles.upcomingInfo}>
                    <div className={styles.upcomingTitle}>{event.title}</div>
                    <div className={styles.upcomingDetails}>
                      {formatLocalDateShort(new Date(event.startTime))} · {getStatusLabel(event.appointmentStatus)}
                    </div>
                  </div>
                  <div
                    className={styles.upcomingTime}
                    style={{ backgroundColor: `${getEventColor(event.appointmentStatus)}20` }}
                  >
                    {formatTime12h(event.startTime)}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Modal de detalles/edición de cita */}
      <AppointmentModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        event={selectedEvent}
        calendar={selectedCalendar}
        mode="view"
        accessToken={accessToken}
        locationId={locationId}
        onSave={handleSaveAppointment}
        onDelete={handleDeleteAppointment}
      />

      {/* Modal de creación de cita */}
      <AppointmentModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        calendar={selectedCalendar}
        mode="create"
        defaultStart={createDefaults.start}
        defaultEnd={createDefaults.end}
        defaultTimeZone={createDefaults.timeZone}
        defaultTitle={createDefaults.title}
        defaultScheduleMode={createScheduleMode}
        accessToken={accessToken}
        locationId={locationId}
        onSave={handleCreateAppointment}
      />

      {/* Modal de horario bloqueado */}
      <BlockedSlotModal
        isOpen={isBlockedSlotModalOpen}
        onClose={() => {
          setIsBlockedSlotModalOpen(false);
          setSelectedBlockedSlot(null);
        }}
        calendar={selectedCalendar}
        blockedSlot={selectedBlockedSlot}
        mode={selectedBlockedSlot?.id ? 'edit' : 'create'}
        defaultStart={createDefaults.start}
        defaultEnd={createDefaults.end}
        accessToken={accessToken}
        locationId={locationId}
        onSave={handleSaveBlockedSlot}
        onDelete={handleDeleteBlockedSlot}
      />
    </PageContainer>
  );
};
