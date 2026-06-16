import apiClient from './apiClient'

export type ContactBulkActionType = 'whatsapp_template' | 'automation_enrollment'
export type ContactBulkActionStatus = 'scheduled' | 'processing' | 'paused' | 'completed' | 'error' | 'cancelled' | string
export type ContactBulkActionItemStatus = 'scheduled' | 'processing' | 'completed' | 'error' | 'cancelled' | string

export interface ContactBulkActionScheduleInput {
  mode: 'now' | 'scheduled'
  scheduledAt?: string
  drip?: {
    enabled: boolean
    intervalMinutes?: number
  }
}

export interface ContactBulkActionItem {
  id: string
  bulkActionId: string
  contactId: string
  contactName: string
  scheduledAt: string | null
  status: ContactBulkActionItemStatus
  result?: Record<string, any> | null
  error?: string | null
  externalId?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  processedAt?: string | null
}

export interface ContactBulkAction {
  id: string
  actionType: ContactBulkActionType
  title: string
  status: ContactBulkActionStatus
  totalCount: number
  processedCount: number
  successCount: number
  errorCount: number
  scheduledAt: string | null
  dripEnabled: boolean
  dripIntervalMinutes: number
  config?: Record<string, any>
  createdBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  pausedAt?: string | null
  cancelledAt?: string | null
  items?: ContactBulkActionItem[]
}

export interface CreateBulkWhatsAppTemplateInput {
  contactIds: string[]
  phoneNumberId?: string
  fromPhone?: string
  templateId?: string
  templateName?: string
  language?: string
  variables?: Record<string, string>
  schedule: ContactBulkActionScheduleInput
}

export interface CreateBulkAutomationInput {
  contactIds: string[]
  automationId: string
  schedule: ContactBulkActionScheduleInput
}

export const contactBulkActionsService = {
  list(limit = 50) {
    return apiClient.get<ContactBulkAction[]>('/contacts/bulk-actions', {
      params: { limit: String(limit) }
    })
  },

  get(actionId: string) {
    return apiClient.get<ContactBulkAction>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}`)
  },

  createWhatsAppTemplate(input: CreateBulkWhatsAppTemplateInput) {
    return apiClient.post<ContactBulkAction>('/contacts/bulk-actions/whatsapp-template', input)
  },

  createAutomation(input: CreateBulkAutomationInput) {
    return apiClient.post<ContactBulkAction>('/contacts/bulk-actions/automation', input)
  },

  pause(actionId: string) {
    return apiClient.post<ContactBulkAction>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}/pause`)
  },

  resume(actionId: string) {
    return apiClient.post<ContactBulkAction>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}/resume`)
  },

  reschedule(actionId: string, schedule: ContactBulkActionScheduleInput) {
    return apiClient.post<ContactBulkAction>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}/reschedule`, {
      schedule
    })
  },

  cancel(actionId: string) {
    return apiClient.post<ContactBulkAction>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}/cancel`)
  },

  delete(actionId: string) {
    return apiClient.delete<{ deleted: boolean; id: string }>(`/contacts/bulk-actions/${encodeURIComponent(actionId)}`)
  }
}
