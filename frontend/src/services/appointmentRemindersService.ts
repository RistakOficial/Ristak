import apiClient, { type ApiRequestError } from './apiClient'

// ---------------------------------------------------------------------------
// Mensajes automáticos de citas (recordatorios, avisos y modo confirmación)
// ---------------------------------------------------------------------------

// Internamente 'confirmation' significa "usar este mensaje como confirmación de cita".
export type ReminderMessageType = 'reminder' | 'confirmation'
// 'before_appointment' = X antes del inicio de la cita; 'after_booking' = X después de agendar.
export type ReminderTimingAnchor = 'before_appointment' | 'after_booking'
export type ReminderOffsetUnit = 'seconds' | 'minutes' | 'hours' | 'days'
export type ReminderSenderMode = 'contact' | 'default' | 'specific'
export type ReminderSmartOverflow = 'before' | 'next_day'
export type ReminderContentMode = 'template' | 'direct'
export type ReminderNoConfirmAction = 'no_action' | 'cancel_appointment' | 'notify_push'
export type ReminderConfirmationSuccessAction = 'mark_confirmed' | 'chat_card' | 'notify_push' | 'chat_badge'
export type ReminderDeliveryHealthStatus = 'ready' | 'warning' | 'error' | 'paused'

export interface ReminderDeliveryHealth {
  status: ReminderDeliveryHealthStatus
  message: string
  details: string[]
}

export interface ReminderFailures {
  errorCount: number
  lastErrorAt: string | null
  lastErrorMessage: string | null
}

export interface AppointmentReminder {
  id: string
  name: string
  enabled: boolean
  messageType: ReminderMessageType
  aiEnabled: boolean
  channel: string
  senderMode: ReminderSenderMode
  senderPhoneNumberId: string | null
  templateId: string | null
  templateName: string | null
  templateLanguage: string
  contentMode: ReminderContentMode
  timingAnchor: ReminderTimingAnchor
  offsetValue: number
  offsetUnit: ReminderOffsetUnit
  messageText: string
  smartEnabled: boolean
  smartStart: string
  smartEnd: string
  smartOverflow: ReminderSmartOverflow
  noConfirmAction: ReminderNoConfirmAction
  confirmationSuccessAction: ReminderConfirmationSuccessAction
  bypassAutomations: boolean
  qrFallbackEnabled: boolean
  position: number
  createdAt: string
  updatedAt: string
  deliveryHealth?: ReminderDeliveryHealth
  failures?: ReminderFailures
}

export interface ReminderSenderOption {
  id: string
  phone: string
  name: string
  isDefault: boolean
  apiEnabled: boolean
  qrConnected: boolean
}

export interface ReminderChannelOption {
  id: string
  label: string
  connected: boolean
}

export interface AppointmentRemindersOverview {
  reminders: AppointmentReminder[]
  senders: ReminderSenderOption[]
  channels: ReminderChannelOption[]
}

export interface AppointmentReminderScheduleConflict {
  id: string
  name: string
  timingAnchor: ReminderTimingAnchor
  offsetValue: number
  offsetUnit: ReminderOffsetUnit
  label: string
}

const REMINDER_SCHEDULE_CONFLICT_CODE = 'appointment_reminder_schedule_conflict'

export function getAppointmentReminderScheduleConflict(error: unknown): {
  message: string
  conflict: AppointmentReminderScheduleConflict | null
} | null {
  const apiError = error as ApiRequestError | null
  if (apiError?.status !== 409 || !apiError.body || typeof apiError.body !== 'object') return null

  const body = apiError.body as {
    code?: unknown
    error?: unknown
    conflict?: AppointmentReminderScheduleConflict
  }
  if (body.code !== REMINDER_SCHEDULE_CONFLICT_CODE) return null

  return {
    message: typeof body.error === 'string'
      ? body.error
      : 'Ya existe un mensaje automático configurado para ese momento. Elige otro horario.',
    conflict: body.conflict || null
  }
}

export const isAppointmentReminderScheduleConflict = (error: unknown): boolean => (
  getAppointmentReminderScheduleConflict(error) !== null
)

export type AppointmentReminderInput = Partial<Omit<AppointmentReminder, 'id' | 'position' | 'createdAt' | 'updatedAt'>>

export const formatReminderOffsetLabel = (
  offsetValue: number,
  offsetUnit: ReminderOffsetUnit,
  timingAnchor: ReminderTimingAnchor = 'before_appointment'
): string => {
  if (timingAnchor === 'after_booking') {
    if (!offsetValue || offsetValue <= 0) return 'Al agendar'
    if (offsetUnit === 'seconds') return offsetValue === 1 ? '1 seg después de agendar' : `${offsetValue} seg después de agendar`
    if (offsetUnit === 'hours') return offsetValue === 1 ? '1 hora después de agendar' : `${offsetValue} horas después de agendar`
    return `${offsetValue} min después de agendar`
  }
  if (offsetUnit === 'minutes') return `${offsetValue} min antes`
  if (offsetUnit === 'hours') return offsetValue === 1 ? '1 hora antes' : `${offsetValue} horas antes`
  return offsetValue === 1 ? '1 día antes' : `${offsetValue} días antes`
}

export const appointmentRemindersService = {
  async getOverview(): Promise<AppointmentRemindersOverview> {
    return apiClient.get<AppointmentRemindersOverview>('/appointment-reminders')
  },

  async createReminder(input: AppointmentReminderInput = {}): Promise<AppointmentReminder> {
    return apiClient.post<AppointmentReminder>('/appointment-reminders', input)
  },

  async updateReminder(reminderId: string, input: AppointmentReminderInput): Promise<AppointmentReminder> {
    return apiClient.put<AppointmentReminder>(`/appointment-reminders/${reminderId}`, input)
  },

  async deleteReminder(reminderId: string): Promise<void> {
    await apiClient.delete(`/appointment-reminders/${reminderId}`)
  }
}

export default appointmentRemindersService
