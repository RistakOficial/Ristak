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

export interface CalendarBookingFieldSetting {
  enabled: boolean;
  required: boolean;
}

export interface CalendarBookingDefaultFields {
  name: CalendarBookingFieldSetting;
  phone: CalendarBookingFieldSetting;
  email: CalendarBookingFieldSetting;
  notes: CalendarBookingFieldSetting;
}

export interface CalendarBookingFormConfig {
  useCustomForm: boolean;
  customFormId: string;
  defaultFields: CalendarBookingDefaultFields;
}

export type CalendarBookingCompletionAction = 'message' | 'redirect';

export interface CalendarBookingCompletionConfig {
  action: CalendarBookingCompletionAction;
  message: string;
  redirectUrl: string;
}

export interface Calendar {
  id: string;
  ghlCalendarId?: string | null;
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
  timeZone?: string;
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
  bookingForm?: CalendarBookingFormConfig;
  bookingCompletion?: CalendarBookingCompletionConfig;
  stickyContact?: boolean;
  isLivePaymentMode?: boolean;
  alertEmail?: string;
  availabilityType?: number;
  guestType?: string;
  consentLabel?: string;
  calendarCoverImage?: string;
  lookBusyConfig?: {
    enabled: boolean;
    LookBusyPercentage: number;
  };
  source?: 'ristak' | 'ghl' | 'google';
  googleCalendarId?: string;
  googleAccessRole?: string;
  googleCalendarSummary?: string;
  googleCalendarTimeZone?: string;
  googleSyncEnabled?: boolean;
  syncStatus?: 'pending' | 'synced' | 'error';
  syncError?: string | null;
  publicBookingPath?: string;
  publicBaseDomain?: string;
  publicUrlEnabled?: boolean;
  publicUrl?: string;
  publicUrlUnavailableReason?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  calendarId: string;
  googleEventId?: string | null;
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

export interface GoogleCalendarIntegrationStatus {
  connectionMode?: 'service_account' | 'oauth';
  configured?: boolean;
  connected: boolean;
  calendarId: string;
  serviceAccountEmail: string;
  projectId: string;
  privateKeyId: string;
  calendarSummary: string;
  calendarTimeZone: string;
  lastTestAt: string | null;
  lastTestStatus: 'success' | 'error' | null;
  lastTestMessage: string;
  lastSyncAt: string | null;
  lastSyncStatus: 'success' | 'error' | null;
  lastSyncMessage: string;
  syncedCalendarsCount: number;
  syncedEventsCount: number;
  connectedAt: string | null;
  updatedAt: string | null;
  googleAccountEmail?: string;
  googleAccountName?: string;
  googleAccountPictureUrl?: string;
  scopes?: string[];
  canManageEvents?: boolean;
  canListCalendars?: boolean;
}

export interface GoogleCalendarServiceAccountReveal {
  serviceAccountJson: string;
}

export interface GoogleCalendarConnectUrl {
  url: string;
  mode?: 'calendar';
  redirectUri?: string;
}

export interface GoogleCalendarOption {
  id: string;
  summary: string;
  name: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
  selected?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
}

export interface GoogleCalendarMergeCalendar extends Calendar {
  appointmentsCount?: number;
}

export interface GoogleCalendarMergePreview {
  connected: boolean;
  mergeAvailable: boolean;
  googleCalendar: Calendar | null;
  sourceCalendars: GoogleCalendarMergeCalendar[];
  totalAppointments: number;
}

export interface GoogleCalendarMergeResult extends GoogleCalendarMergePreview {
  moved: number;
  removedSourceCalendars?: number;
  synced: number;
  failed: number;
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

export interface BlockedSlot {
  id?: string;         // ID del blocked slot (para editar/eliminar)
  date: string;        // YYYY-MM-DD
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm
  reason?: string;
  blockedBy?: string;
}

/**
 * Servicio para manejar Calendarios de HighLevel
 */
export const calendarsService = {
  /**
   * Obtener todos los calendarios de la ubicación
   */
  async getCalendars(
    locationId?: string | null,
    accessToken?: string | null,
    sourcePreference?: 'combined' | 'ristak' | 'ghl' | 'google'
  ): Promise<Calendar[]> {
    try {
      const data = await apiClient.get<Calendar[]>('/calendars', {
        params: {
          ...(locationId ? { locationId } : {}),
          ...(accessToken ? { accessToken } : {}),
          ...(sourcePreference ? { sourcePreference } : {})
        }
      });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  async getGoogleIntegration(): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.get<GoogleCalendarIntegrationStatus>('/calendars/google-integration');
  },

  async getGoogleConnectUrl(): Promise<GoogleCalendarConnectUrl> {
    const returnPath = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search || ''}`
      : '/settings/calendars/google';

    return apiClient.post<GoogleCalendarConnectUrl>('/calendars/google-integration/connect-url', {
      returnPath
    });
  },

  async claimGoogleOAuth(handoffToken: string): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.post<GoogleCalendarIntegrationStatus>('/calendars/google-integration/connect/claim', {
      handoffToken
    });
  },

  async revealGoogleServiceAccount(): Promise<GoogleCalendarServiceAccountReveal> {
    return apiClient.get<GoogleCalendarServiceAccountReveal>('/calendars/google-integration/reveal/service-account');
  },

  async getGoogleCalendarOptions(): Promise<GoogleCalendarOption[]> {
    const data = await apiClient.get<GoogleCalendarOption[]>('/calendars/google-integration/calendars');
    return Array.isArray(data) ? data : [];
  },

  async saveGoogleIntegration(payload: {
    calendarId?: string;
    serviceAccountJson: string;
  }): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.put<GoogleCalendarIntegrationStatus>('/calendars/google-integration', payload);
  },

  async testGoogleIntegration(): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.post<GoogleCalendarIntegrationStatus>('/calendars/google-integration/test');
  },

  async syncGoogleIntegration(): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.post<GoogleCalendarIntegrationStatus>('/calendars/google-integration/sync');
  },

  async getGoogleMergePreview(): Promise<GoogleCalendarMergePreview> {
    return apiClient.get<GoogleCalendarMergePreview>('/calendars/google-integration/merge-preview');
  },

  async mergeGoogleAppointments(sourceCalendarIds?: string[]): Promise<GoogleCalendarMergeResult> {
    return apiClient.post<GoogleCalendarMergeResult>('/calendars/google-integration/merge', {
      ...(sourceCalendarIds?.length ? { sourceCalendarIds } : {})
    });
  },

  async deleteGoogleIntegration(): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.delete<GoogleCalendarIntegrationStatus>('/calendars/google-integration');
  },

  async updateCalendarGoogleSync(calendarId: string, googleCalendarId: string): Promise<Calendar | null> {
    return apiClient.put<Calendar>(`/calendars/${calendarId}/google-sync`, {
      googleCalendarId
    });
  },

  /**
   * Crear calendario local de Ristak. Si HighLevel está conectado, backend lo sincroniza.
   */
  async createCalendar(calendarData: Partial<Calendar>, accessToken?: string): Promise<Calendar | null> {
    try {
      const data = await apiClient.post<Calendar>('/calendars', {
        ...calendarData,
        ...(accessToken ? { accessToken } : {})
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Obtener un calendario específico
   */
  async getCalendar(calendarId: string, accessToken?: string): Promise<Calendar | null> {
    try {
      const data = await apiClient.get<Calendar>(`/calendars/${calendarId}`, {
        params: accessToken ? { accessToken } : {}
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
    accessToken?: string,
    calendarId?: string
  ): Promise<CalendarEvent[]> {
    try {
      const params: any = {
        startTime: startTime.toString(),
        endTime: endTime.toString()
      };

      if (locationId) params.locationId = locationId;
      if (accessToken) params.accessToken = accessToken;

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
    accessToken?: string,
    timezone: string = 'America/Mexico_City'
  ): Promise<FreeSlot[]> {
    try {
      const data = await apiClient.get<FreeSlot[]>(`/calendars/${calendarId}/free-slots`, {
        params: {
          startDate,
          endDate,
          timezone,
          ...(accessToken ? { accessToken } : {})
        }
      });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  /**
   * Obtener horarios bloqueados de un calendario
   */
  async getBlockedSlots(
    calendarId: string,
    locationId: string,
    startTime: number,
    endTime: number,
    accessToken?: string
  ): Promise<BlockedSlot[]> {
    try {
      const data = await apiClient.get<BlockedSlot[]>(`/calendars/${calendarId}/blocked-slots`, {
        params: {
          locationId,
          startTime: startTime.toString(),
          endTime: endTime.toString(),
          ...(accessToken ? { accessToken } : {})
        }
      });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      return [];
    }
  },

  /**
   * Crear un nuevo blocked slot
   */
  async createBlockedSlot(blockData: any, accessToken: string): Promise<any> {
    try {
      const data = await apiClient.post('/calendars/block-slots', {
        ...blockData,
        accessToken
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Actualizar un blocked slot existente
   */
  async updateBlockedSlot(
    eventId: string,
    updateData: any,
    accessToken: string
  ): Promise<any> {
    try {
      const data = await apiClient.put(`/calendars/block-slots/${eventId}`, {
        ...updateData,
        accessToken
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Crear una nueva cita
   */
  async createAppointment(appointmentData: any, accessToken?: string): Promise<CalendarEvent | null> {
    try {
      const data = await apiClient.post<CalendarEvent>('/calendars/appointments', {
        ...appointmentData,
        ...(accessToken ? { accessToken } : {})
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
    accessToken?: string
  ): Promise<CalendarEvent | null> {
    try {
      const data = await apiClient.put<CalendarEvent>(`/calendars/appointments/${eventId}`, {
        ...updateData,
        ...(accessToken ? { accessToken } : {})
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Eliminar un evento del calendario
   */
  async deleteEvent(eventId: string, accessToken?: string): Promise<boolean> {
    try {
      await apiClient.delete(`/calendars/events/${eventId}`, {
        params: accessToken ? { accessToken } : {}
      });
      return true;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Eliminar un blocked slot (horario bloqueado)
   */
  async deleteBlockedSlot(blockedSlotId: string, accessToken: string): Promise<boolean> {
    try {
      await apiClient.delete(`/calendars/block-slots/${blockedSlotId}`, {
        params: { accessToken }
      });
      return true;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Actualizar configuración de un calendario
   */
  async updateCalendar(
    calendarId: string,
    updateData: Partial<Calendar>,
    accessToken?: string
  ): Promise<Calendar | null> {
    try {
      const data = await apiClient.put<Calendar>(`/calendars/${calendarId}`, {
        ...updateData,
        ...(accessToken ? { accessToken } : {})
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Eliminar calendario local de Ristak.
   */
  async deleteCalendar(calendarId: string, accessToken?: string): Promise<boolean> {
    try {
      await apiClient.delete(`/calendars/${calendarId}`, undefined, {
        params: accessToken ? { accessToken } : {}
      });
      return true;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Calcular estadísticas de citas
   * Nota: "pending" cuenta citas confirmadas que están próximas (futuras)
   */
  calculateStats(events: CalendarEvent[]): AppointmentStats {
    const now = new Date();
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
      const eventDate = new Date(event.startTime);

      // "pending" = citas confirmadas que están en el futuro
      if (status === 'confirmed' && eventDate >= now) {
        stats.pending++;
      }
      // El resto de stats se mantiene igual
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
    accessToken?: string,
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
    accessToken?: string
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
