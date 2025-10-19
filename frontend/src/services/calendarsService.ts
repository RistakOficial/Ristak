import apiClient from './apiClient';

/**
 * Tipos para Calendarios y Eventos de HighLevel
 */

export interface CalendarTeamMember {
  userId: string;
  priority: number;
  isPrimary: boolean;
  locationConfigurations?: LocationConfiguration[];
}

export interface LocationConfiguration {
  kind: string;
  location: string;
  meetingId?: string;
}

export interface OpenHours {
  daysOfTheWeek: number[];
  hours: {
    openHour: number;
    openMinute: number;
    closeHour: number;
    closeMinute: number;
  }[];
}

export interface Calendar {
  id: string;
  locationId: string;
  groupId?: string;
  name: string;
  description?: string;
  slug: string;
  widgetSlug?: string;
  calendarType: string;
  widgetType?: string;
  eventTitle?: string;
  eventColor: string;
  isActive: boolean;
  teamMembers?: CalendarTeamMember[];
  locationConfigurations?: LocationConfiguration[];
  slotDuration: number;
  slotDurationUnit: string;
  slotInterval: number;
  slotIntervalUnit: string;
  slotBuffer?: number;
  slotBufferUnit?: string;
  preBuffer?: number;
  preBufferUnit?: string;
  appoinmentPerSlot: number;
  appoinmentPerDay: number;
  allowBookingAfter?: number;
  allowBookingAfterUnit?: string;
  allowBookingFor?: number;
  allowBookingForUnit?: string;
  openHours?: OpenHours[];
  autoConfirm?: boolean;
  allowReschedule?: boolean;
  allowCancellation?: boolean;
  notes?: string;
  formId?: string;
  stickyContact?: boolean;
  isLivePaymentMode?: boolean;
  alertEmail?: string;
  availabilityType?: number;
  guestType?: string;
  consentLabel?: string;
  calendarCoverImage?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  calendarId: string;
  locationId: string;
  contactId?: string;
  groupId?: string;
  appointmentStatus: 'confirmed' | 'pending' | 'cancelled' | 'showed' | 'noshow' | 'rescheduled';
  assignedUserId?: string;
  users?: string[];
  address?: string;
  notes?: string;
  description?: string;
  startTime: string;
  endTime: string;
  dateAdded: string;
  dateUpdated?: string;
  timeZone?: string;
  isRecurring?: boolean;
  rrule?: string;
  assignedResources?: string[];
  createdBy?: {
    userId: string;
    source: string;
  };
  masterEventId?: string;
}

export interface AppointmentStats {
  pending: number;
  cancelled: number;
  confirmed: number;
  rescheduled: number;
  showed: number;
  noshow: number;
}

export interface FreeSlot {
  date: string;
  slots: string[];
}

/**
 * Servicio para manejar Calendarios de HighLevel
 */
export const calendarsService = {
  /**
   * Obtener todos los calendarios de la ubicación
   */
  async getCalendars(locationId: string, accessToken: string): Promise<Calendar[]> {
    try {
      const data = await apiClient.get<Calendar[]>('/calendars', {
        params: { locationId, accessToken }
      });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  /**
   * Obtener un calendario específico
   */
  async getCalendar(calendarId: string, accessToken: string): Promise<Calendar | null> {
    try {
      const data = await apiClient.get<Calendar>(`/calendars/${calendarId}`, {
        params: { accessToken }
      });
      return data;
    } catch (error) {
      return null;
    }
  },

  /**
   * Obtener eventos de un rango de fechas
   */
  async getEvents(
    locationId: string,
    startTime: number,
    endTime: number,
    accessToken: string,
    calendarId?: string
  ): Promise<CalendarEvent[]> {
    try {
      const params: any = {
        locationId,
        startTime: startTime.toString(),
        endTime: endTime.toString(),
        accessToken
      };

      if (calendarId) {
        params.calendarId = calendarId;
      }

      const data = await apiClient.get<CalendarEvent[]>('/calendars/events', { params });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  /**
   * Obtener detalles completos de una cita individual
   * Este endpoint devuelve información completa incluyendo contactId y assignedUserId
   * NO requiere accessToken - el backend lo obtiene automáticamente
   */
  async getAppointment(eventId: string): Promise<CalendarEvent | null> {
    try {
      const data = await apiClient.get<CalendarEvent>(`/calendars/events/${eventId}`);
      return data;
    } catch (error) {
      return null;
    }
  },

  /**
   * Obtener slots disponibles de un calendario
   */
  async getFreeSlots(
    calendarId: string,
    startDate: string,
    endDate: string,
    accessToken: string,
    timezone: string = 'America/Mexico_City'
  ): Promise<FreeSlot[]> {
    try {
      const data = await apiClient.get<FreeSlot[]>(`/calendars/${calendarId}/free-slots`, {
        params: { startDate, endDate, timezone, accessToken }
      });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  /**
   * Crear una nueva cita
   */
  async createAppointment(appointmentData: any, accessToken: string): Promise<CalendarEvent | null> {
    try {
      const data = await apiClient.post<CalendarEvent>('/calendars/appointments', {
        ...appointmentData,
        accessToken
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Actualizar una cita existente
   */
  async updateAppointment(
    eventId: string,
    updateData: Partial<CalendarEvent>,
    accessToken: string
  ): Promise<CalendarEvent | null> {
    try {
      const data = await apiClient.put<CalendarEvent>(`/calendars/appointments/${eventId}`, {
        ...updateData,
        accessToken
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Eliminar un evento del calendario
   */
  async deleteEvent(eventId: string, accessToken: string): Promise<boolean> {
    try {
      await apiClient.delete(`/calendars/events/${eventId}`, {
        params: { accessToken }
      });
      return true;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Calcular estadísticas de citas
   */
  calculateStats(events: CalendarEvent[]): AppointmentStats {
    const stats: AppointmentStats = {
      pending: 0,
      cancelled: 0,
      confirmed: 0,
      rescheduled: 0,
      showed: 0,
      noshow: 0
    };

    events.forEach((event) => {
      const status = event.appointmentStatus?.toLowerCase();
      if (status === 'pending') stats.pending++;
      else if (status === 'cancelled') stats.cancelled++;
      else if (status === 'confirmed') stats.confirmed++;
      else if (status === 'rescheduled') stats.rescheduled++;
      else if (status === 'showed') stats.showed++;
      else if (status === 'noshow') stats.noshow++;
    });

    return stats;
  },

  /**
   * Formatear eventos por fecha (para el calendario)
   */
  groupEventsByDate(events: CalendarEvent[]): Record<string, CalendarEvent[]> {
    const grouped: Record<string, CalendarEvent[]> = {};

    events.forEach((event) => {
      const date = event.startTime.split('T')[0];
      if (!grouped[date]) {
        grouped[date] = [];
      }
      grouped[date].push(event);
    });

    // Ordenar eventos de cada día por hora
    Object.keys(grouped).forEach((date) => {
      grouped[date].sort((a, b) => a.startTime.localeCompare(b.startTime));
    });

    return grouped;
  },

  /**
   * Obtener próximas citas (ordenadas por fecha)
   */
  getUpcomingAppointments(events: CalendarEvent[], limit: number = 10): CalendarEvent[] {
    const now = new Date();
    return events
      .filter((event) => new Date(event.startTime) >= now)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, limit);
  },

  /**
   * Obtener citas próximas del día actual (independiente de la vista del calendario)
   * SIEMPRE consulta eventos del día de HOY, sin importar qué vista esté activa
   */
  async getTodayUpcomingAppointments(
    calendarId: string,
    locationId: string,
    accessToken: string,
    limit: number = 8
  ): Promise<CalendarEvent[]> {
    try {
      // Fecha de hoy 00:00:00
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Fecha de hoy 23:59:59
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      // Obtener eventos del día actual usando timestamps
      const events = await this.getEvents(
        locationId,
        today.getTime(),
        endOfDay.getTime(),
        accessToken,
        calendarId
      );

      // Filtrar solo eventos futuros (desde ahora) y ordenar
      const now = new Date();
      return events
        .filter((event: CalendarEvent) => new Date(event.startTime) >= now)
        .sort((a: CalendarEvent, b: CalendarEvent) => a.startTime.localeCompare(b.startTime))
        .slice(0, limit);
    } catch (error) {
      return [];
    }
  },

  async getFutureAppointments(
    calendarId: string,
    locationId: string,
    accessToken: string
  ): Promise<CalendarEvent[]> {
    try {
      const now = new Date();
      const startTimestamp = now.getTime();

      const endDate = new Date(now);
      endDate.setFullYear(endDate.getFullYear() + 1);
      const endTimestamp = endDate.getTime();

      const events = await this.getEvents(
        locationId,
        startTimestamp,
        endTimestamp,
        accessToken,
        calendarId
      );

      return events
        .filter((event: CalendarEvent) => new Date(event.startTime) >= now)
        .sort((a: CalendarEvent, b: CalendarEvent) => a.startTime.localeCompare(b.startTime));
    } catch (error) {
      return [];
    }
  },

  /**
   * Convertir horarios de OpenHours a formato más legible
   */
  parseOpenHours(openHours?: OpenHours[]): Record<number, { start: string; end: string }[]> {
    const parsed: Record<number, { start: string; end: string }[]> = {};

    if (!openHours) return parsed;

    openHours.forEach((schedule) => {
      schedule.daysOfTheWeek.forEach((day) => {
        if (!parsed[day]) {
          parsed[day] = [];
        }
        schedule.hours.forEach((hour) => {
          const start = `${String(hour.openHour).padStart(2, '0')}:${String(hour.openMinute).padStart(2, '0')}`;
          const end = `${String(hour.closeHour).padStart(2, '0')}:${String(hour.closeMinute).padStart(2, '0')}`;
          parsed[day].push({ start, end });
        });
      });
    });

    return parsed;
  }
};

export default calendarsService;
