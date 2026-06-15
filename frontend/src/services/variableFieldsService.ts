import apiClient from './apiClient'

export interface VariableField {
  id: string
  fieldKey: string
  key: string
  label: string
  name: string
  value: string
  description: string
  parameter: string
  archived: boolean
  createdByUserId: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface SaveVariableFieldInput {
  label: string
  fieldKey: string
  value: string
  description?: string
}

export const variableFieldsService = {
  list(params: { includeArchived?: boolean } = {}) {
    return apiClient.get<VariableField[]>('/settings/variable-fields', {
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
  }
}
