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

/** Configuración global del flujo (zona horaria, horarios, reingreso…) */
export interface FlowSettings {
  description?: string
  /** Zona horaria global: los nodos (p. ej. Esperar) la heredan */
  timezone: string
  allowedSchedule: {
    enabled: boolean
    daysOfWeek: string[]
    startTime: string
    endTime: string
    outsideWindowBehavior: 'wait_until_next_window' | 'continue_immediately' | 'pause_until_next_allowed_day'
  }
  /** Permitir que el contacto vuelva a entrar al flujo (default: activado) */
  allowReentry: boolean
  preventDuplicateActiveEnrollment: boolean
  /** Sacar al contacto si responde por WhatsApp/Messenger/Instagram */
  stopOnContactResponse: boolean
  maxEnrollments?: number | null
  defaultSenders: {
    whatsappSenderId?: string
    messengerPageId?: string
    instagramAccountId?: string
  }
}

export function defaultFlowSettings(): FlowSettings {
  return {
    description: '',
    timezone: '',
    allowedSchedule: {
      enabled: false,
      daysOfWeek: [],
      startTime: '09:00',
      endTime: '18:00',
      outsideWindowBehavior: 'wait_until_next_window'
    },
    allowReentry: true,
    preventDuplicateActiveEnrollment: true,
    stopOnContactResponse: false,
    maxEnrollments: null,
    defaultSenders: {}
  }
}

export interface AutomationFlow {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
  viewport: AutomationViewport
  settings?: FlowSettings
}

export interface AutomationSummary {
  id: string
  folderId: string | null
  name: string
  description: string
  status: AutomationStatus
  hasUnpublishedChanges?: boolean
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export interface Automation extends AutomationSummary {
  flow: AutomationFlow
}

export interface EnrollmentLogEntry {
  nodeId: string
  label?: string
  status?: string
  at?: string
}

export interface AutomationEnrollment {
  id: string
  contactId: string | null
  contactName: string
  status: 'active' | 'completed' | 'exited' | 'goal_met' | string
  currentNodeId: string | null
  log: EnrollmentLogEntry[]
  enteredAt: string
  updatedAt: string
}

export interface ContactAutomationActivityItem {
  id: string
  kind: 'enrollment' | 'scheduled'
  automationId: string
  automationName: string
  status: string
  contactId?: string | null
  contactName?: string | null
  currentNodeId?: string | null
  log?: EnrollmentLogEntry[]
  enteredAt?: string | null
  scheduledAt?: string | null
  enrollmentId?: string | null
  error?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  executedAt?: string | null
}

export interface ContactAutomationActivity {
  active: ContactAutomationActivityItem[]
  past: ContactAutomationActivityItem[]
}

export interface ContactAutomationEnrollmentResult {
  mode: 'now' | 'scheduled'
  enrollment?: ContactAutomationActivityItem
  job?: ContactAutomationActivityItem
}

export interface EnrollmentStats {
  active: number
  total: number
  byNode: Record<string, number>
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

/**
 * Caché en memoria: la librería y el editor pintan al instante con lo último
 * conocido (sin parpadeo de carga) mientras se revalida en segundo plano.
 */
export const automationsCache = {
  overview: null as AutomationsOverview | null,
  automations: new Map<string, Automation>()
}

export const automationsService = {
  async getOverview(): Promise<AutomationsOverview> {
    const overview = await apiClient.get<AutomationsOverview>('/automations')
    automationsCache.overview = overview
    return overview
  },

  async getAutomation(automationId: string): Promise<Automation> {
    const automation = await apiClient.get<Automation>(`/automations/${automationId}`)
    automationsCache.automations.set(automation.id, automation)
    return automation
  },

  async createAutomation(input: { name: string; folderId?: string | null }): Promise<Automation> {
    const automation = await apiClient.post<Automation>('/automations', input)
    automationsCache.automations.set(automation.id, automation)
    return automation
  },

  async updateAutomation(automationId: string, input: AutomationUpdateInput): Promise<Automation> {
    const automation = await apiClient.put<Automation>(`/automations/${automationId}`, input)
    automationsCache.automations.set(automation.id, automation)
    return automation
  },

  async duplicateAutomation(automationId: string): Promise<Automation> {
    const automation = await apiClient.post<Automation>(`/automations/${automationId}/duplicate`)
    automationsCache.automations.set(automation.id, automation)
    return automation
  },

  async deleteAutomation(automationId: string): Promise<void> {
    await apiClient.delete(`/automations/${automationId}`)
    automationsCache.automations.delete(automationId)
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

  async getEnrollments(automationId: string): Promise<AutomationEnrollment[]> {
    return apiClient.get<AutomationEnrollment[]>(`/automations/${automationId}/enrollments`)
  },

  async getEnrollmentStats(automationId: string): Promise<EnrollmentStats> {
    return apiClient.get<EnrollmentStats>(`/automations/${automationId}/stats`)
  },

  async getContactActivity(contactId: string): Promise<ContactAutomationActivity> {
    return apiClient.get<ContactAutomationActivity>(`/automations/contacts/${contactId}/activity`)
  },

  async enrollContact(
    automationId: string,
    input: { contactId: string; mode: 'now' | 'scheduled'; scheduledAt?: string }
  ): Promise<ContactAutomationEnrollmentResult> {
    return apiClient.post<ContactAutomationEnrollmentResult>(`/automations/${automationId}/enroll-contact`, input)
  },

  async deleteFolder(folderId: string): Promise<void> {
    await apiClient.delete(`/automations/folders/${folderId}`)
  },

  /** Sube un archivo (data URL base64) y devuelve su URL pública en Ristak */
  async uploadAsset(fileBase64: string, filename: string): Promise<{ id: string; url: string; contentType: string }> {
    return apiClient.post<{ id: string; url: string; contentType: string }>('/automations/assets', {
      fileBase64,
      filename
    })
  }
}

export default automationsService
