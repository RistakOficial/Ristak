import apiClient from './apiClient';
import { refreshIntegrationsStatusAfter } from './integrationsService';
import { parseSortableDateValue } from '@/utils/dateSort';
import { getStoredBusinessTimezone, localDateTimeInputToUTCISOString, todayDateOnlyInTimezone } from '@/utils/timezone';

/**
 * Tipos para calendarios y eventos de Ristak, Google y HighLevel opcional.
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

export type CalendarPaymentGateway = 'stripe' | 'conekta' | 'mercadopago' | 'clip';

export interface CalendarBookingPaymentConfig {
  enabled: boolean;
  gateway: CalendarPaymentGateway;
  amount: number;
  currency: string;
  productName: string;
  description: string;
  buttonText: string;
  pendingMessage: string;
  paidMessage: string;
}

export type CalendarCustomEventChannel = 'site' | 'whatsapp' | 'smart';

export interface CalendarCustomEventParameter {
  id: string;
  key: string;
  value: string;
}

export interface CalendarCustomEventParameters {
  value?: string;
  predictedLtv?: string;
  currency?: string;
  status?: string;
  contentName?: string;
  contentCategory?: string;
  contentIds?: string;
  contentType?: string;
  numItems?: string;
  orderId?: string;
  custom?: CalendarCustomEventParameter[];
}

export interface CalendarCustomEventsConfig {
  enabled: boolean;
  channel: CalendarCustomEventChannel;
  eventName: string;
  parameters: CalendarCustomEventParameters;
}

export type CalendarBookingLayout = 'classic' | 'compact' | 'stacked';
export type CalendarBookingFontFamily = 'system' | 'modern' | 'serif' | 'mono';
export type CalendarBookingWidgetTheme = 'ristak' | 'night' | 'agenda' | 'minimal';
export type CalendarBookingPaymentPosition = 'after_form' | 'before_form';

export interface CalendarBookingDisplayColors {
  accent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  controlBg: string;
  slotBg: string;
  slotText: string;
  selectedText: string;
  fieldBg: string;
  fieldText: string;
  fieldBorder: string;
  buttonText: string;
}

export interface CalendarBookingDisplayConfig {
  showSidebar: boolean;
  showIcon: boolean;
  showEventTitle: boolean;
  showCalendarName: boolean;
  showDescription: boolean;
  showDuration: boolean;
  showConfirmation: boolean;
  layout: CalendarBookingLayout;
  widgetTheme: CalendarBookingWidgetTheme;
  fontFamily: CalendarBookingFontFamily;
  allowTimezoneSelection: boolean;
  defaultTimezone: string;
  formPosition: CalendarBookingFormPosition;
  paymentPosition: CalendarBookingPaymentPosition;
  colors: CalendarBookingDisplayColors;
}

export type CalendarBookingFormPosition = 'before' | 'after';

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
  availabilityScheduleConfigured?: boolean;
  autoConfirm?: boolean;
  allowReschedule?: boolean;
  allowCancellation?: boolean;
  notes?: string;
  formId?: string;
  bookingForm?: CalendarBookingFormConfig;
  bookingCompletion?: CalendarBookingCompletionConfig;
  bookingPayment?: CalendarBookingPaymentConfig;
  bookingDisplay?: CalendarBookingDisplayConfig;
  customEvents?: CalendarCustomEventsConfig;
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
  publicUrlSource?: string;
  publicUrlLockedToPublicCalendar?: boolean;
  publicUrlUnavailableReason?: string;
  antiTrackingEnabled?: boolean;
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

export interface CreateAppointmentPayload extends Partial<CalendarEvent> {
  clientRequestId?: string;
  client_request_id?: string;
  strictAvailabilityCheck?: true;
  [key: string]: unknown;
}

export interface GoogleCalendarIntegrationStatus {
  connectionMode?: 'oauth';
  configured?: boolean;
  connected: boolean;
  calendarId: string;
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

export interface CalendarEventDayCount {
  date: string;
  total: number;
}

export interface CalendarEventDayPreview extends CalendarEventDayCount {
  items: CalendarEvent[];
}

export interface CalendarEventDayCountsResponse {
  timezone: string;
  total: number;
  days: CalendarEventDayCount[];
}

export interface CalendarMonthPreviewResponse extends CalendarEventDayCountsResponse {
  previewLimit: number;
  days: CalendarEventDayPreview[];
}

export interface CalendarEventsPage {
  timezone: string;
  items: CalendarEvent[];
  total?: number;
  days?: CalendarEventDayCount[];
  pagination: {
    limit: number;
    hasNext: boolean;
    nextCursor: string | null;
  };
}

export interface CalendarEventsOverview {
  stats: AppointmentStats;
  upcoming: CalendarEvent[];
  limit: number;
}

export interface UpcomingAppointmentsPage {
  items: CalendarEvent[];
  pagination: {
    limit: number;
    hasNext: boolean;
    nextCursor: string | null;
  };
}

export interface FreeSlot {
  date: string;
  slots: string[];
}

export interface BlockedSlot {
  id?: string;         // ID del blocked slot (para editar/eliminar)
  date: string;        // YYYY-MM-DD (día concreto donde se pinta el bloqueo)
  startTime: string;   // HH:mm (hora local de la cuenta dentro de ese día)
  endTime: string;     // HH:mm
  reason?: string;
  blockedBy?: string;
  startIso?: string;   // Instante ISO real del inicio del bloqueo completo (para editar)
  endIso?: string;     // Instante ISO real del fin del bloqueo completo (para editar)
}

// Forma CRUDA que devuelve el backend para los bloqueos nativos (Ristak/Google):
// instantes ISO en UTC + título. El front la normaliza a BlockedSlot[] para pintar.
export interface RawBlockedSlot {
  id?: string;
  calendarId?: string | null;
  startTime?: string;  // ISO UTC
  endTime?: string;    // ISO UTC
  title?: string | null;
  [key: string]: any;  // HighLevel puede traer campos extra
}

function isCalendarSettingsPath(pathname = '') {
  return pathname === '/settings/calendars' || pathname.startsWith('/settings/calendars/');
}

function getGoogleCalendarReturnPath(explicitReturnPath = '') {
  if (typeof window === 'undefined') return '/settings/calendars/google';
  if (explicitReturnPath.trim()) return explicitReturnPath.trim();

  const pathname = isCalendarSettingsPath(window.location.pathname)
    ? window.location.pathname
    : '/settings/calendars/google';
  return `${pathname}${window.location.search || ''}${window.location.hash || ''}`;
}

function getCurrentAppUrl() {
  if (typeof window === 'undefined') return '';
  return window.location.origin || '';
}

/**
 * Servicio para manejar calendarios de Ristak, Google y HighLevel opcional.
 */
export const calendarsService = {
  /**
   * Obtener todos los calendarios de la ubicación
   */
  async getCalendars(
    locationId?: string | null,
    accessToken?: string | null,
    sourcePreference?: 'combined' | 'ristak' | 'ghl' | 'google',
    options: { throwOnError?: boolean } = {}
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
      if (options.throwOnError) throw error;
      return [];
    }
  },

  async getGoogleIntegration(): Promise<GoogleCalendarIntegrationStatus> {
    return apiClient.get<GoogleCalendarIntegrationStatus>('/calendars/google-integration');
  },

  async getGoogleConnectUrl(returnPath = ''): Promise<GoogleCalendarConnectUrl> {
    return apiClient.post<GoogleCalendarConnectUrl>('/calendars/google-integration/connect-url', {
      returnPath: getGoogleCalendarReturnPath(returnPath),
      appUrl: getCurrentAppUrl()
    });
  },

  async claimGoogleOAuth(handoffToken: string): Promise<GoogleCalendarIntegrationStatus> {
    return refreshIntegrationsStatusAfter(apiClient.post<GoogleCalendarIntegrationStatus>('/calendars/google-integration/connect/claim', {
      handoffToken
    }));
  },

  async getGoogleCalendarOptions(): Promise<GoogleCalendarOption[]> {
    const data = await apiClient.get<GoogleCalendarOption[]>('/calendars/google-integration/calendars');
    return Array.isArray(data) ? data : [];
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
    return refreshIntegrationsStatusAfter(apiClient.delete<GoogleCalendarIntegrationStatus>('/calendars/google-integration'));
  },

  async updateCalendarGoogleSync(calendarId: string, googleCalendarId: string): Promise<Calendar | null> {
    return apiClient.put<Calendar>(`/calendars/${calendarId}/google-sync`, {
      googleCalendarId
    });
  },

  /**
   * Crear calendario local de Ristak. El backend sincroniza integraciones externas sólo si están conectadas.
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
    calendarId?: string,
    signal?: AbortSignal
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

      const data = await apiClient.get<CalendarEvent[]>('/calendars/events', { params, signal });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  },

  /** Vista mensual local: máximo previewLimit filas por día y conteos exactos. */
  async getMonthEventPreview({
    calendarId,
    startTime,
    endTime,
    previewLimit = 3,
    signal
  }: {
    calendarId: string;
    startTime: number;
    endTime: number;
    previewLimit?: number;
    signal?: AbortSignal;
  }): Promise<CalendarMonthPreviewResponse> {
    return apiClient.get<CalendarMonthPreviewResponse>('/calendars/events/month-preview', {
      params: {
        calendarId,
        startTime: String(startTime),
        endTime: String(endTime),
        previewLimit: String(previewLimit)
      },
      signal
    });
  },

  /** Página keyset local para día/semana; nunca usa offset ni límite silencioso. */
  async getEventsPage({
    calendarId,
    startTime,
    endTime,
    cursor,
    limit = 100,
    includeCounts = true,
    signal
  }: {
    calendarId: string;
    startTime: number;
    endTime: number;
    cursor?: string | null;
    limit?: number;
    includeCounts?: boolean;
    signal?: AbortSignal;
  }): Promise<CalendarEventsPage> {
    return apiClient.get<CalendarEventsPage>('/calendars/events/page', {
      params: {
        calendarId,
        startTime: String(startTime),
        endTime: String(endTime),
        limit: String(limit),
        includeCounts: includeCounts ? '1' : '0',
        ...(cursor ? { cursor } : {})
      },
      signal
    });
  },

  /** Conteos exactos por día sin descargar citas (vista anual/mini calendarios). */
  async getEventDayCounts({
    calendarId,
    startTime,
    endTime,
    signal
  }: {
    calendarId: string;
    startTime: number;
    endTime: number;
    signal?: AbortSignal;
  }): Promise<CalendarEventDayCountsResponse> {
    return apiClient.get<CalendarEventDayCountsResponse>('/calendars/events/day-counts', {
      params: {
        calendarId,
        startTime: String(startTime),
        endTime: String(endTime)
      },
      signal
    });
  },

  /** KPIs exactos multi-calendario y próximas filas acotadas para PhoneApp. */
  async getEventsOverview({
    startTime,
    endTime,
    limit = 5,
    signal
  }: {
    startTime: number;
    endTime: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<CalendarEventsOverview> {
    return apiClient.get<CalendarEventsOverview>('/calendars/events/overview', {
      params: {
        startTime: String(startTime),
        endTime: String(endTime),
        limit: String(limit)
      },
      signal
    });
  },

  /** Resumen local del rango para KPIs, sin descargar todas las citas. */
  async getAppointmentStats(
    calendarId: string,
    startTime: number,
    endTime: number,
    signal?: AbortSignal
  ): Promise<AppointmentStats> {
    return apiClient.get<AppointmentStats>('/calendars/events/summary', {
      params: {
        calendarId,
        startTime: String(startTime),
        endTime: String(endTime)
      },
      signal
    });
  },

  /** Próximas citas desde el espejo local, con página keyset acotada. */
  async getUpcomingAppointmentsPage({
    calendarId,
    cursor,
    limit = 20,
    signal
  }: {
    calendarId: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<UpcomingAppointmentsPage> {
    return apiClient.get<UpcomingAppointmentsPage>('/calendars/upcoming', {
      params: {
        calendarId,
        limit: String(limit),
        ...(cursor ? { cursor } : {})
      },
      signal
    });
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
    timezone?: string
  ): Promise<FreeSlot[]> {
    try {
      const data = await apiClient.get<FreeSlot[]>(`/calendars/${calendarId}/free-slots`, {
        params: {
          startDate,
          endDate,
          ...(timezone ? { timezone } : {}),
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
  ): Promise<RawBlockedSlot[]> {
    try {
      const data = await apiClient.get<RawBlockedSlot[]>(`/calendars/${calendarId}/blocked-slots`, {
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
   * Crear un nuevo blocked slot.
   * accessToken es opcional: sin él, el backend crea un bloqueo NATIVO local (Ristak/Google).
   */
  async createBlockedSlot(blockData: any, accessToken?: string): Promise<any> {
    try {
      const data = await apiClient.post('/calendars/block-slots', {
        ...blockData,
        ...(accessToken ? { accessToken } : {})
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Actualizar un blocked slot existente.
   * accessToken es opcional: sin él, actualiza el bloqueo NATIVO local.
   */
  async updateBlockedSlot(
    eventId: string,
    updateData: any,
    accessToken?: string
  ): Promise<any> {
    try {
      const data = await apiClient.put(`/calendars/block-slots/${eventId}`, {
        ...updateData,
        ...(accessToken ? { accessToken } : {})
      });
      return data;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Crear una nueva cita
   */
  async createAppointment(
    appointmentData: CreateAppointmentPayload,
    accessToken?: string
  ): Promise<CalendarEvent | null> {
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
  async deleteBlockedSlot(blockedSlotId: string, accessToken?: string): Promise<boolean> {
    try {
      await apiClient.delete(`/calendars/block-slots/${blockedSlotId}`, {
        params: accessToken ? { accessToken } : {}
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
      .sort((a, b) => parseSortableDateValue(a.startTime) - parseSortableDateValue(b.startTime))
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
    limit: number = 8,
    timezone: string = getStoredBusinessTimezone()
  ): Promise<CalendarEvent[]> {
    try {
      const today = todayDateOnlyInTimezone(timezone);
      const startIso = localDateTimeInputToUTCISOString(`${today}T00:00:00.000`, timezone);
      const endIso = localDateTimeInputToUTCISOString(`${today}T23:59:59.999`, timezone);
      const startTimestamp = parseSortableDateValue(startIso);
      const endTimestamp = parseSortableDateValue(endIso);
      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) return [];

      // Obtener eventos del día actual usando timestamps
      const events = await this.getEvents(
        locationId,
        startTimestamp,
        endTimestamp,
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
    _locationId: string,
    _accessToken?: string
  ): Promise<CalendarEvent[]> {
    try {
      const page = await this.getUpcomingAppointmentsPage({ calendarId, limit: 20 });
      return page.items;
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
