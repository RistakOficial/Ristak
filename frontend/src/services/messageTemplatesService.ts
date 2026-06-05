import apiClient from './apiClient'

export type MessageTemplateCategory = 'utility' | 'marketing' | 'authentication' | 'service'
export type MessageTemplateStatus = 'draft' | 'active' | 'archived'
export type MessageTemplateHeaderType = 'none' | 'text' | 'image' | 'video' | 'document' | 'location'
export type MessageTemplateButtonType = 'quick_reply' | 'website' | 'phone' | 'whatsapp_call'

export interface MessageTemplateFolder {
  id: string
  name: string
  parentId?: string | null
  sortOrder: number
  createdAt?: string | null
  updatedAt?: string | null
}

export interface MessageTemplateCustomField {
  id: string
  name: string
  fieldKey: string
  mergeField: string
  example?: string
  dataType?: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface MessageTemplateVariable {
  key: string
  label: string
  mergeField: string
  example: string
  group: string
  source: 'system' | 'custom' | string
  fieldKey?: string
}

export interface MessageTemplateButton {
  id?: string
  type: MessageTemplateButtonType
  label: string
  value?: string
}

export interface MessageTemplateLocation {
  latitude: string
  longitude: string
  name: string
  address: string
}

export interface MessageTemplate {
  id: string
  folderId?: string | null
  name: string
  description?: string
  category: MessageTemplateCategory
  language: string
  status: MessageTemplateStatus
  headerEnabled: boolean
  headerType: MessageTemplateHeaderType
  headerText?: string
  headerMediaUrl?: string
  headerLocation: MessageTemplateLocation
  bodyText: string
  footerText?: string
  buttons: MessageTemplateButton[]
  variables: string[]
  variableExamples: Record<string, string>
  ycloudTemplateId?: string | null
  ycloudStatus?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type MessageTemplatePayload = Omit<
  MessageTemplate,
  'id' | 'variables' | 'createdAt' | 'updatedAt'
>

export interface MessageTemplateBundle {
  folders: MessageTemplateFolder[]
  templates: MessageTemplate[]
  customFields: MessageTemplateCustomField[]
  variables: MessageTemplateVariable[]
}

export interface MessageTemplatePreview {
  header: string
  body: string
  footer: string
  buttons: MessageTemplateButton[]
  variablesUsed: string[]
}

export interface CreateFolderPayload {
  name: string
  parentId?: string | null
  sortOrder?: number
}

export interface CreateCustomFieldPayload {
  name: string
  fieldKey?: string
  example?: string
  dataType?: string
}

export const messageTemplatesService = {
  getBundle: () => apiClient.get<MessageTemplateBundle>('/settings/message-templates'),
  getVariables: () => apiClient.get<MessageTemplateVariable[]>('/settings/message-templates/variables'),
  preview: (payload: Partial<MessageTemplatePayload>) => (
    apiClient.post<MessageTemplatePreview>('/settings/message-templates/preview', payload)
  ),
  createTemplate: (payload: MessageTemplatePayload) => (
    apiClient.post<MessageTemplate>('/settings/message-templates', payload)
  ),
  updateTemplate: (id: string, payload: MessageTemplatePayload) => (
    apiClient.put<MessageTemplate>(`/settings/message-templates/${id}`, payload)
  ),
  deleteTemplate: (id: string) => apiClient.delete<{ deleted: boolean }>(`/settings/message-templates/${id}`),
  createFolder: (payload: CreateFolderPayload) => (
    apiClient.post<MessageTemplateFolder>('/settings/message-templates/folders', payload)
  ),
  updateFolder: (id: string, payload: CreateFolderPayload) => (
    apiClient.put<MessageTemplateFolder>(`/settings/message-templates/folders/${id}`, payload)
  ),
  deleteFolder: (id: string) => (
    apiClient.delete<{ deleted: boolean; releasedTemplates: number }>(`/settings/message-templates/folders/${id}`)
  ),
  createCustomField: (payload: CreateCustomFieldPayload) => (
    apiClient.post<MessageTemplateCustomField>('/settings/message-templates/custom-fields', payload)
  ),
  deleteCustomField: (id: string) => (
    apiClient.delete<{ deleted: boolean }>(`/settings/message-templates/custom-fields/${id}`)
  )
}
