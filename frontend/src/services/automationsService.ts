import apiClient from './apiClient'

// ---------------------------------------------------------------------------
// Tipos del modelo de automatizaciones
// ---------------------------------------------------------------------------

export type AutomationStatus = 'draft' | 'published' | 'paused' | 'archived'

export interface AutomationFolder {
  id: string
  name: string
  parentId: string | null
  position: number
  createdAt: string
  updatedAt: string
}

export interface AutomationNodePosition {
  x: number
  y: number
}

/** Disparador configurado dentro de la tarjeta inicial "Cuando..." */
export interface AutomationTriggerEntry {
  id: string
  type: string
  config: Record<string, unknown>
}

export interface AutomationNode {
  id: string
  type: string
  category?: string
  label?: string
  position: AutomationNodePosition
  config: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface AutomationEdge {
  id: string
  sourceNodeId: string
  sourceHandle?: string
  targetNodeId: string
  targetHandle?: string
  label?: string
  animated?: boolean
  metadata?: Record<string, unknown>
}

export interface AutomationViewport {
  x: number
  y: number
  zoom: number
}

export interface AutomationFlow {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
  viewport: AutomationViewport
}

export interface AutomationSummary {
  id: string
  folderId: string | null
  name: string
  description: string
  status: AutomationStatus
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export interface Automation extends AutomationSummary {
  flow: AutomationFlow
}

export interface AutomationsOverview {
  folders: AutomationFolder[]
  automations: AutomationSummary[]
}

export interface AutomationUpdateInput {
  name?: string
  description?: string
  folderId?: string | null
  status?: AutomationStatus
  flow?: AutomationFlow
}

export const AUTOMATION_STATUS_LABELS: Record<AutomationStatus, string> = {
  draft: 'Borrador',
  published: 'Publicada',
  paused: 'Pausada',
  archived: 'Archivada'
}

// ---------------------------------------------------------------------------
// Llamadas a la API
// ---------------------------------------------------------------------------

export const automationsService = {
  async getOverview(): Promise<AutomationsOverview> {
    return apiClient.get<AutomationsOverview>('/automations')
  },

  async getAutomation(automationId: string): Promise<Automation> {
    return apiClient.get<Automation>(`/automations/${automationId}`)
  },

  async createAutomation(input: { name: string; folderId?: string | null }): Promise<Automation> {
    return apiClient.post<Automation>('/automations', input)
  },

  async updateAutomation(automationId: string, input: AutomationUpdateInput): Promise<Automation> {
    return apiClient.put<Automation>(`/automations/${automationId}`, input)
  },

  async duplicateAutomation(automationId: string): Promise<Automation> {
    return apiClient.post<Automation>(`/automations/${automationId}/duplicate`)
  },

  async deleteAutomation(automationId: string): Promise<void> {
    await apiClient.delete(`/automations/${automationId}`)
  },

  async createFolder(input: { name: string }): Promise<AutomationFolder> {
    return apiClient.post<AutomationFolder>('/automations/folders', input)
  },

  async updateFolder(
    folderId: string,
    input: { name?: string; position?: number }
  ): Promise<AutomationFolder> {
    return apiClient.put<AutomationFolder>(`/automations/folders/${folderId}`, input)
  },

  async reorderFolders(orderedIds: string[]): Promise<AutomationFolder[]> {
    return apiClient.post<AutomationFolder[]>('/automations/folders/reorder', { orderedIds })
  },

  async deleteFolder(folderId: string): Promise<void> {
    await apiClient.delete(`/automations/folders/${folderId}`)
  }
}

export default automationsService
