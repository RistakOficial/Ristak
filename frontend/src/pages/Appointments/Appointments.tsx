import React, { useState, useEffect, useMemo } from 'react';
import { KpiCard, Card, Button, PageContainer, AppointmentModal } from '@/components/common';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Plus, ChevronDown, Check } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useNotification } from '@/contexts/NotificationContext';
import { calendarsService, type Calendar, type CalendarEvent, type AppointmentStats } from '@/services/calendarsService';
import { formatTime12h, formatDate } from '@/utils/format';
import styles from './Appointments.module.css';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

const DAYS_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

type ViewMode = 'month' | 'week' | 'day';

interface DayCell {
  date: Date;
  isCurrentMonth: boolean;
  events: CalendarEvent[];
}

export const Appointments: React.FC = () => {
  const { locationId, accessToken } = useAuth();
  const { showToast } = useNotification();

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

  // Dropdown de calendarios
  const [isCalendarDropdownOpen, setIsCalendarDropdownOpen] = useState(false);
  const [defaultCalendarId, setDefaultCalendarId] = useState<string | null>(
    localStorage.getItem('defaultCalendarId')
  );

  // Cargar calendarios al montar
  useEffect(() => {
    if (locationId && accessToken) {
      loadCalendars();
    }
  }, [locationId, accessToken]);

  // Cargar eventos cuando cambie el calendario o la fecha
  useEffect(() => {
    if (selectedCalendar && locationId && accessToken) {
      loadEvents();
    }
  }, [selectedCalendar, currentDate, viewMode, locationId, accessToken]);

  // Cargar próximas citas solo cuando cambie el calendario seleccionado
  useEffect(() => {
    if (selectedCalendar && locationId && accessToken) {
      loadUpcomingEvents();
    }
  }, [selectedCalendar, locationId, accessToken]);

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

  const loadCalendars = async () => {
    if (!locationId || !accessToken) return;

    try {
      setLoading(true);
      const calendarsData = await calendarsService.getCalendars(locationId, accessToken);
      setCalendars(calendarsData);

      // Seleccionar calendario: predeterminado guardado > primer activo
      let calendarToSelect: Calendar | undefined;

      if (defaultCalendarId) {
        calendarToSelect = calendarsData.find((cal) => cal.id === defaultCalendarId && cal.isActive);
      }

      if (!calendarToSelect) {
        calendarToSelect = calendarsData.find((cal) => cal.isActive);
      }

      if (calendarToSelect) {
        setSelectedCalendar(calendarToSelect);
      }
    } catch (error) {
      showToast('error', 'Error al cargar calendarios', 'No se pudieron obtener los calendarios.');
    } finally {
      setLoading(false);
    }
  };

  const loadEvents = async () => {
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
      setStats(calendarsService.calculateStats(eventsData));
    } catch (error) {
      showToast('error', 'Error al cargar citas', 'No se pudieron obtener las citas del calendario.');
    } finally {
      setLoading(false);
    }
  };

  // Cargar eventos próximos desde HOY (independiente del calendario visible)
  const loadUpcomingEvents = async () => {
    if (!locationId || !accessToken || !selectedCalendar) return;

    try {
      const now = new Date();
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 3); // Próximos 3 meses

      const upcomingData = await calendarsService.getEvents(
        locationId,
        now.getTime(),
        futureDate.getTime(),
        accessToken,
        selectedCalendar.id
      );

      setUpcomingEvents(upcomingData);
    } catch (error) {
      console.error('Error al cargar próximas citas:', error);
    }
  };

  const getDateRange = (): { startTime: number; endTime: number } => {
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
  };

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
    const eventsByDate = calendarsService.groupEventsByDate(events);

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
  }, [currentDate, events]);

  // Próximas citas (siempre desde HOY, no del rango visible)
  const upcomingAppointments = useMemo(() => {
    return calendarsService.getUpcomingAppointments(events, 8);
  }, [events]);

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

  // Color del evento según estado
  const getEventColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'confirmed':
        return '#3b82f6'; // Azul para confirmadas
      case 'pending':
        return 'var(--color-warning-500)'; // Amarillo para pendientes
      case 'cancelled':
        return 'var(--color-error-500)'; // Rojo para canceladas
      case 'showed':
        return '#10b981'; // Verde para asistió
      case 'noshow':
        return 'var(--color-gray-500)'; // Gris para no asistió
      case 'rescheduled':
        return '#8b5cf6'; // Morado para reprogramadas
      default:
        return 'var(--color-gray-500)';
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
      {/* Header: Selector de calendario */}
      <div className={styles.header}>
        <div className={styles.calendarNav}>
          <h1 className={styles.title}>Calendarios</h1>

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

            {selectedCalendar && (
              <button
                className={styles.setDefaultLink}
                onClick={handleSetDefaultCalendar}
                disabled={defaultCalendarId === selectedCalendar.id}
              >
                {defaultCalendarId === selectedCalendar.id ? 'Predeterminado' : 'Establecer predeterminado'}
              </button>
            )}

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
                          setSelectedCalendar(calendar);
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
          title="Citas pendientes"
          value={stats.pending}
          icon={<CalendarIcon className="w-6 h-6" />}
        />
        <KpiCard
          title="Citas canceladas"
          value={stats.cancelled}
          icon={<CalendarIcon className="w-6 h-6" />}
          iconColorClassName="text-[var(--color-error-500)]"
        />
        <KpiCard
          title="Citas confirmadas"
          value={stats.confirmed}
          icon={<CalendarIcon className="w-6 h-6" />}
          iconColorClassName="text-[var(--color-success-500)]"
        />
        <KpiCard
          title="Reprogramadas"
          value={stats.rescheduled}
          icon={<CalendarIcon className="w-6 h-6" />}
          iconColorClassName="text-[var(--color-warning-500)]"
        />
      </div>

      {/* Grid principal */}
      <div className={styles.mainGrid}>
        {/* Calendario */}
        <Card className={styles.calendarCard}>
          {/* Barra de vista */}
          <div className={styles.viewBar}>
            <Button
              variant="primary"
              onClick={() => showToast('info', 'Próximamente', 'Esta función estará disponible pronto.')}
            >
              <Plus size={18} />
              Programar cita
            </Button>

            <div className={styles.viewTabs}>
              <button
                className={viewMode === 'month' ? styles.viewTabActive : styles.viewTab}
                onClick={() => setViewMode('month')}
              >
                Mes
              </button>
              <button
                className={viewMode === 'week' ? styles.viewTabActive : styles.viewTab}
                onClick={() => setViewMode('week')}
              >
                Semana
              </button>
              <button
                className={viewMode === 'day' ? styles.viewTabActive : styles.viewTab}
                onClick={() => setViewMode('day')}
              >
                Día
              </button>
            </div>

            <div className={styles.dateNav}>
              <Button variant="secondary" onClick={handleToday}>
                Hoy
              </Button>
              <button className={styles.navBtn} onClick={handlePrev} aria-label="Anterior">
                <ChevronLeft size={16} />
              </button>
              <span className={styles.dateLabel}>{renderLabel()}</span>
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
                {monthCells.map((cell, index) => (
                  <div
                    key={index}
                    className={`${styles.dayCell} ${!cell.isCurrentMonth ? styles.dayCellOther : ''}`}
                    onClick={() => setSelectedDate(cell.date)}
                  >
                    <div className={styles.dayNumber}>{cell.date.getDate()}</div>
                    <div className={styles.eventsContainer}>
                      {cell.events.slice(0, 3).map((event) => (
                        <div
                          key={event.id}
                          className={`${styles.eventChip} ${styles[`event${event.appointmentStatus.charAt(0).toUpperCase() + event.appointmentStatus.slice(1).toLowerCase()}`] || styles.eventDefault}`}
                          title={`${event.title || '(Sin título)'} - ${event.appointmentStatus}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEventClick(event);
                          }}
                        >
                          <span className={styles.eventTime}>
                            {formatTime12h(event.startTime)}
                          </span>{' '}
                          {event.title || '(Sin título)'}
                        </div>
                      ))}
                      {cell.events.length > 3 && (
                        <div className={styles.eventMore}>+{cell.events.length - 3} más</div>
                      )}
                    </div>
                  </div>
                ))}
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
              <div className={styles.weekGrid}>
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
                    const dateStr = date.toISOString().split('T')[0];
                    const dayEvents = calendarsService.groupEventsByDate(events)[dateStr] || [];

                    return (
                      <div key={dayIndex} className={styles.dayColumn}>
                        {/* Líneas de hora */}
                        {Array.from({ length: 24 }).map((_, hour) => (
                          <div key={hour} className={styles.hourLine}></div>
                        ))}

                        {/* Eventos posicionados */}
                        {dayEvents.map((event) => {
                          const startDate = new Date(event.startTime);
                          const endDate = new Date(event.endTime);
                          const startHour = startDate.getHours() + startDate.getMinutes() / 60;
                          const endHour = endDate.getHours() + endDate.getMinutes() / 60;
                          const top = (startHour / 24) * 100;
                          const height = ((endHour - startHour) / 24) * 100;

                          return (
                            <div
                              key={event.id}
                              className={styles.weekEvent}
                              style={{
                                top: `${top}%`,
                                height: `${height}%`,
                                backgroundColor: getEventColor(event.appointmentStatus),
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
                <div className={styles.dayHeaderTitle}>
                  {(() => {
                    const dayName = DAYS_SHORT[(currentDate.getDay() + 6) % 7];
                    const isToday = currentDate.toDateString() === new Date().toDateString();
                    const monthYear = currentDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
                    return (
                      <>
                        <span className={styles.dayHeaderName}>
                          {dayName} {currentDate.getDate()} · {monthYear}
                        </span>
                        <span className={`${styles.dayHeaderNumber} ${isToday ? styles.dayHeaderToday : ''}`}>
                          {currentDate.getDate()}
                        </span>
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* Grid de horarios del día */}
              <div className={styles.dayGrid}>
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
                    const dateStr = currentDate.toISOString().split('T')[0];
                    const dayEvents = calendarsService.groupEventsByDate(events)[dateStr] || [];

                    return dayEvents.map((event) => {
                      const startDate = new Date(event.startTime);
                      const endDate = new Date(event.endTime);
                      const startHour = startDate.getHours() + startDate.getMinutes() / 60;
                      const endHour = endDate.getHours() + endDate.getMinutes() / 60;
                      const top = (startHour / 24) * 100;
                      const height = ((endHour - startHour) / 24) * 100;

                      return (
                        <div
                          key={event.id}
                          className={styles.dayEvent}
                          style={{
                            top: `${top}%`,
                            height: `${height}%`,
                            backgroundColor: getEventColor(event.appointmentStatus),
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
        onSave={handleSaveAppointment}
        onDelete={handleDeleteAppointment}
      />
    </PageContainer>
  );
};
