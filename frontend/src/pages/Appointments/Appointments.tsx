import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { KpiCard, Card, Button, PageContainer, AppointmentModal, TabList } from '@/components/common';
import { ChevronLeft, ChevronRight, Plus, ChevronDown, Check, Calendar as CalendarIcon, Search, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useNotification } from '@/contexts/NotificationContext';
import { useTheme } from '@/contexts/ThemeContext';
import { calendarsService, type Calendar, type CalendarEvent, type AppointmentStats } from '@/services/calendarsService';
import { formatTime12h, formatDate } from '@/utils/format';
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

  // Estado del calendario
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // Datos
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [selectedCalendar, setSelectedCalendar] = useState<Calendar | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
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

  // Dropdown de calendarios
  const [isCalendarDropdownOpen, setIsCalendarDropdownOpen] = useState(false);
  const [defaultCalendarId, setDefaultCalendarId] = useState<string | null>(
    localStorage.getItem('defaultCalendarId')
  );

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

      // Seleccionar calendario: último usado en esta sesión > predeterminado > primer activo
      let calendarToSelect: Calendar | undefined;

      const lastSelectedId = getStoredLastCalendarId();
      if (lastSelectedId) {
        calendarToSelect = calendarsData.find((cal) => cal.id === lastSelectedId && cal.isActive);
      }

      if (defaultCalendarId) {
        calendarToSelect = calendarToSelect ?? calendarsData.find((cal) => cal.id === defaultCalendarId && cal.isActive);
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

  // useEffects - ejecutar después de declarar las funciones
  // Cargar calendarios al montar
  useEffect(() => {
    if (locationId && accessToken) {
      loadCalendars();
    }
  }, [locationId, accessToken, loadCalendars]);

  // Cargar eventos cuando cambie el calendario o la fecha
  useEffect(() => {
    if (selectedCalendar && locationId && accessToken) {
      loadEvents();
    }
  }, [selectedCalendar, currentDate, viewMode, locationId, accessToken, loadEvents]);

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

  const handleSetDefaultCalendar = () => {
    if (!selectedCalendar) return;

    localStorage.setItem('defaultCalendarId', selectedCalendar.id);
    setDefaultCalendarId(selectedCalendar.id);
    showToast('success', 'Calendario predeterminado', `"${selectedCalendar.name}" se estableció como predeterminado.`);
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

        // Buscar por fecha (formato: "15 enero", "15/01", "enero 2025", etc)
        const eventDate = new Date(event.startTime);
        const dateStr = formatDate(eventDate).toLowerCase();
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

  return (
    <PageContainer>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>Calendarios</h1>

        <div className={styles.headerControls}>
          {/* Buscador de citas */}
          <div className={styles.searchContainer}>
            <div className={styles.searchInputWrapper}>
              <Search size={18} className={styles.searchIcon} />
              <input
                ref={searchInputRef}
                type="text"
                className={styles.searchInput}
                placeholder="Buscar citas por nombre, fecha o estado..."
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
                            {formatDate(eventDate)} · {formatTime12h(event.startTime)} · {event.appointmentStatus}
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

          <div className={styles.calendarSelector}>
          <div className={styles.calendarSelectorRow}>
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

            {selectedCalendar && (
              <button
                className={styles.setDefaultLink}
                onClick={handleSetDefaultCalendar}
                disabled={defaultCalendarId === selectedCalendar.id}
              >
                {defaultCalendarId === selectedCalendar.id ? 'Predeterminado' : 'Establecer predeterminado'}
              </button>
            )}
          </div>

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
        </div>
      </div>

      {/* KPIs */}
      <div className={styles.statsGrid}>
        <KpiCard
          title="Citas pendientes · mes seleccionado"
          value={stats.pending}
        />
        <KpiCard
          title="Citas canceladas · mes seleccionado"
          value={stats.cancelled}
        />
        <KpiCard
          title="Citas confirmadas · mes seleccionado"
          value={stats.confirmed}
        />
        <KpiCard
          title="Citas reprogramadas · mes seleccionado"
          value={stats.rescheduled}
        />
      </div>

      {/* Grid principal */}
      <div className={styles.mainGrid}>
        {/* Calendario */}
        <Card className={styles.calendarCard}>
          <div className={styles.calendarCardContent}>
          {/* Barra de vista */}
          <div className={styles.viewBar}>
            <Button
              variant="primary"
              onClick={openCreateModal}
            >
              <Plus size={18} />
              Programar cita
            </Button>

            <TabList
              tabs={viewTabs}
              activeTab={viewMode}
              onTabChange={(value) => setViewMode(value as ViewMode)}
              variant="compact"
            />

            <div className={styles.dateNav}>
              <Button variant="secondary" onClick={handleToday}>
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

                    return (
                      <div
                        key={index}
                        className={cellClasses}
                        onClick={() => setSelectedDate(cell.date)}
                      >
                        <div className={dayNumberClasses}>{cell.date.getDate()}</div>
                        <div className={styles.eventsContainer}>
                          {cell.events.slice(0, 3).map((event) => (
                            <div
                              key={event.id}
                              className={`${styles.eventChip} ${styles[`event${event.appointmentStatus.charAt(0).toUpperCase() + event.appointmentStatus.slice(1).toLowerCase()}`] || styles.eventDefault}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEventClick(event);
                              }}
                              onMouseEnter={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoveredEventId(event.id);
                                setTooltipPosition({
                                  top: rect.top - 10,
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
                              {hoveredEventId === event.id && tooltipPosition && (
                                <div
                                  className={styles.eventTooltip}
                                  style={{
                                    position: 'fixed',
                                    top: `${tooltipPosition.top}px`,
                                    left: `${tooltipPosition.left}px`,
                                    transform: 'translate(-50%, -100%)'
                                  }}
                                >
                                  <div className={styles.tooltipTitle}>
                                    {event.title || '(Sin título)'}
                                  </div>
                                  <div className={styles.tooltipTime}>
                                    {formatTime12h(event.startTime)} - {formatTime12h(event.endTime)}
                                  </div>
                                  <div className={styles.tooltipStatus}>
                                    Estado: {event.appointmentStatus}
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
                                </div>
                              )}
                            </div>
                          ))}
                          {cell.events.length > 3 && (
                            <div className={styles.eventMore}>+{cell.events.length - 3} más</div>
                          )}
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
                    const date = new Date(startOfWeek);
                    date.setDate(startOfWeek.getDate() + dayIndex);
                    const isToday = date.toDateString() === new Date().toDateString();
                    const dayEvents = events.filter((event) => {
                      const eventDate = toDateInTimeZone(event.startTime, event.timeZone) ?? new Date(event.startTime);
                      const columnDate = toDateInTimeZone(date.toISOString(), event.timeZone) ?? date;
                      return eventDate ? isSameDay(eventDate, columnDate) : false;
                    });

                    return (
                      <div key={dayIndex} className={`${styles.dayColumn} ${isToday ? styles.dayColumnToday : ''}`}>
                        {/* Líneas de hora */}
                        {Array.from({ length: 24 }).map((_, hour) => (
                          <div key={hour} className={styles.hourLine}></div>
                        ))}

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
                              title={`${event.title} - ${formatTime12h(event.startTime)} a ${formatTime12h(event.endTime)}`}
                              onClick={() => handleEventClick(event)}
                            >
                              <div className={styles.weekEventTime}>
                                {formatTime12h(event.startTime)}
                              </div>
                              <div className={styles.weekEventTitle}>{event.title}</div>
                            </div>
                          );
                        })}

                        {/* Indicador de hora actual */}
                        {(() => {
                          const now = new Date();
                          const isToday = date.toDateString() === now.toDateString();
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

                <div className={styles.dayColumn}>
                  {/* Líneas de hora */}
                  {Array.from({ length: 24 }).map((_, hour) => (
                    <div key={hour} className={styles.hourLine}></div>
                  ))}

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
                          className={`${styles.dayEvent} ${styles.eventBlock} ${statusClass}`}
                          style={{
                            top: `${top}%`,
                            height: `${height}%`
                          }}
                          title={`${event.title} - ${formatTime12h(event.startTime)} a ${formatTime12h(event.endTime)}`}
                          onClick={() => handleEventClick(event)}
                        >
                          <div className={styles.dayEventTime}>
                            {formatTime12h(event.startTime)} - {formatTime12h(event.endTime)}
                          </div>
                          <div className={styles.dayEventTitle}>{event.title}</div>
                          <div className={styles.dayEventStatus}>{event.appointmentStatus}</div>
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
                      {formatDate(new Date(event.startTime))} · {event.appointmentStatus}
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
        onSave={handleCreateAppointment}
      />
    </PageContainer>
  );
};
