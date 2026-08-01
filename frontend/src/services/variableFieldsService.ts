import apiClient from './apiClient'

export interface VariableField {
  id: string
  fieldKey: string
  key: string
  label: string
  name: string
  value: string
  description: string
  folderId: string
  folderName: string
  parameter: string
  archived: boolean
  createdByUserId: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface VariableFieldFolder {
  id: string
  name: string
  description: string
  sortOrder: number
  archived: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface SaveVariableFieldInput {
  label: string
  fieldKey: string
  value: string
  description?: string
  folderId?: string
}

export const variableFieldsService = {
  list(params: { includeArchived?: boolean } = {}) {
    return apiClient.get<VariableField[]>('/settings/variable-fields', {
      params: params.includeArchived ? { includeArchived: 'true' } : undefined
    })
  },

  listFolders(params: { includeArchived?: boolean } = {}) {
    return apiClient.get<VariableFieldFolder[]>('/settings/variable-field-folders', {
      params: params.includeArchived ? { includeArchived: 'true' } : undefined
    })
  },

  create(input: SaveVariableFieldInput) {
    return apiClient.post<VariableField>('/settings/variable-fields', input)
  },

  update(variableFieldId: string, input: Partial<SaveVariableFieldInput>) {
    return apiClient.put<VariableField>(`/settings/variable-fields/${variableFieldId}`, input)
  },

  delete(variableFieldId: string) {
    return apiClient.delete<VariableField>(`/settings/variable-fields/${variableFieldId}`)
  },

  createFolder(input: { name: string; description?: string }) {
    return apiClient.post<VariableFieldFolder>('/settings/variable-field-folders', input)
  },

  updateFolder(folderId: string, input: Partial<Pick<VariableFieldFolder, 'name' | 'description' | 'sortOrder' | 'archived'>>) {
    return apiClient.put<VariableFieldFolder>(`/settings/variable-field-folders/${folderId}`, input)
  },

  archiveFolder(folderId: string) {
    return apiClient.delete<VariableFieldFolder>(`/settings/variable-field-folders/${folderId}`)
  }
}
