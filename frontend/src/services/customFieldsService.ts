import apiClient from './apiClient'

export type CustomFieldDataType =
  | 'text'
  | 'textarea'
  | 'radio'
  | 'dropdown'
  | 'checkboxes'
  | 'number'
  | 'currency'
  | 'date'
  | 'email'
  | 'phone'
  | 'select'
  | 'multiselect'

export interface CustomFieldOption {
  label: string
  value: string
}

export interface CustomFieldFolder {
  id: string
  name: string
  description: string
  sortOrder: number
  archived: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomFieldDefinition {
  definitionId: string
  key: string
  fieldKey: string
  label: string
  name: string
  description: string
  dataType: CustomFieldDataType
  options: CustomFieldOption[]
  folderId: string
  folderName: string
  fieldGroup: string
  syncTarget: string
  sourceType: string
  system?: boolean
  systemManaged?: boolean
  locked?: boolean
  editable?: boolean
  deletable?: boolean
  archived: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomFieldsCatalog {
  folders: CustomFieldFolder[]
  fields: CustomFieldDefinition[]
}

export interface SaveCustomFieldInput {
  key?: string
  fieldKey?: string
  label: string
  description?: string
  dataType: CustomFieldDataType
  folderId?: string
  fieldGroup?: string
  options?: CustomFieldOption[]
  syncTarget?: string
}

const normalizeCustomFieldIdentity = (value?: string | null) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '')

const SYSTEM_CUSTOM_FIELD_IDENTITIES = new Set([
  'businessname',
  'nombredelnegocio',
  'nombredenegocio'
])

export const isSystemCustomFieldDefinition = (field?: Partial<CustomFieldDefinition> | null) => {
  const identities = [field?.key, field?.fieldKey, field?.label, field?.name]
    .map(normalizeCustomFieldIdentity)
    .filter(Boolean)

  return Boolean(
    field?.system ||
    field?.systemManaged ||
    field?.locked ||
    field?.editable === false ||
    field?.deletable === false ||
    field?.sourceType?.toLowerCase() === 'system' ||
    identities.some((identity) => SYSTEM_CUSTOM_FIELD_IDENTITIES.has(identity))
  )
}

export const customFieldsService = {
  listCatalog() {
    return apiClient.get<CustomFieldsCatalog>('/settings/custom-fields')
  },

  createField(input: SaveCustomFieldInput) {
    return apiClient.post<CustomFieldDefinition>('/settings/custom-fields', input)
  },

  updateField(definitionId: string, input: Partial<SaveCustomFieldInput> & { archived?: boolean }) {
    return apiClient.put<CustomFieldDefinition>(`/settings/custom-fields/${definitionId}`, input)
  },

  deleteField(definitionId: string) {
    return apiClient.delete<CustomFieldDefinition>(`/settings/custom-fields/${definitionId}`)
  },

  createFolder(input: { name: string; description?: string }) {
    return apiClient.post<CustomFieldFolder>('/settings/custom-field-folders', input)
  },

  updateFolder(folderId: string, input: Partial<Pick<CustomFieldFolder, 'name' | 'description' | 'sortOrder' | 'archived'>>) {
    return apiClient.put<CustomFieldFolder>(`/settings/custom-field-folders/${folderId}`, input)
  },

  archiveFolder(folderId: string) {
    return apiClient.delete<CustomFieldFolder>(`/settings/custom-field-folders/${folderId}`)
  }
}
