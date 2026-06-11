import apiClient from './apiClient'

// ---------------------------------------------------------------------------
// Mensajes automáticos de citas (recordatorios y confirmaciones)
// ---------------------------------------------------------------------------

export type ReminderMessageType = 'reminder' | 'confirmation'
export type ReminderOffsetUnit = 'minutes' | 'hours' | 'days'
export type ReminderSenderMode = 'contact' | 'default' | 'specific'
export type ReminderSmartOverflow = 'before' | 'next_day'

export interface AppointmentReminder {
  id: string
  name: string
  enabled: boolean
  messageType: ReminderMessageType
  aiEnabled: boolean
  channel: string
  senderMode: ReminderSenderMode
  senderPhoneNumberId: string | null
  offsetValue: number
  offsetUnit: ReminderOffsetUnit
  messageText: string
  smartEnabled: boolean
  smartStart: string
  smartEnd: string
  smartOverflow: ReminderSmartOverflow
  position: number
  createdAt: string
  updatedAt: string
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

export type AppointmentReminderInput = Partial<Omit<AppointmentReminder, 'id' | 'position' | 'createdAt' | 'updatedAt'>>

export const formatReminderOffsetLabel = (offsetValue: number, offsetUnit: ReminderOffsetUnit): string => {
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
