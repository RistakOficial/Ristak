import apiClient from './apiClient'

// ---------------------------------------------------------------------------
// Tipos del modelo de automatizaciones
// ---------------------------------------------------------------------------

export type AutomationStatus = 'draft' | 'published' | 'paused' | 'archived'
export type AutomationReviewState = 'ok' | 'requires_review'

export interface AutomationReviewIssue {
  id: string
  nodeId: string | null
  triggerId?: string | null
  catalog: string
  fieldPath: string
  value: string
  label: string
  message: string
}

export interface AutomationReviewStatus {
  state: AutomationReviewState
  issueCount: number
  summary: string
  issues: AutomationReviewIssue[]
}

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
  reviewStatus?: AutomationReviewStatus
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export interface Automation extends AutomationSummary {
  flow: AutomationFlow
}

export type AutomationLogOutcome = 'success' | 'error' | 'waiting' | 'skipped' | 'info'
export type AutomationExecutionOutcome = 'pending' | 'success' | 'error' | 'stopped'

export interface EnrollmentLogEntry {
  id?: string
  nodeId: string
  label?: string
  status?: string
  outcome?: AutomationLogOutcome
  detail?: string
  errorMessage?: string | null
  errorDetail?: string | null
  errorCode?: string | number | null
  retryable?: boolean
  retryAttempt?: number
  resolved?: boolean
  resolvedAt?: string | null
  at?: string
}

export interface AutomationEnrollment {
  id: string
  contactId: string | null
  contactName: string
  status: 'active' | 'waiting' | 'paused' | 'completed' | 'exited' | 'goal_met' | string
  currentNodeId: string | null
  log: EnrollmentLogEntry[]
  executionOutcome?: AutomationExecutionOutcome
  lastError?: string | null
  resumeAt?: string | null
  waitKind?: string | null
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
  executionOutcome?: AutomationExecutionOutcome
  lastError?: string | null
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

export type AutomationEnrollmentControlAction =
  | 'exit'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'advance'
  | 'move_to_node'

export interface AutomationEnrollmentControlInput {
  action: AutomationEnrollmentControlAction
  targetNodeId?: string
}

export interface AutomationTestRunResult {
  mode: 'test'
  testedAt: string
  automationId: string
  automationName: string
  contactId: string
  contactName: string
  enrollment: ContactAutomationActivityItem
}

export interface AutomationTestContactInput {
  name?: string
  email?: string
  phone?: string
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

export interface AutomationWebhookActionTestInput {
  nodeId: string
  config: Record<string, unknown>
  flow: AutomationFlow
}

export interface AutomationWebhookActionTestResult {
  ok: boolean
  detail: string
  handle: string
  stop: boolean
  output: Record<string, unknown>
  testedAt: string
}

export const AUTOMATION_ENROLLMENT_CHANGED_EVENT = 'ristak-automation-enrollment-changed'

function notifyAutomationEnrollmentChanged(automationId: string, enrollment?: { id?: string | null; currentNodeId?: string | null }) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(AUTOMATION_ENROLLMENT_CHANGED_EVENT, {
      detail: {
        automationId,
        enrollmentId: enrollment?.id || null,
        nodeId: enrollment?.currentNodeId || null
      }
    })
  )
}

export const AUTOMATION_STATUS_LABELS: Record<AutomationStatus, string> = {
  draft: 'Borrador',
  published: 'Publicada',
  paused: 'Pausada',
  archived: 'Archivada'
}

export const AUTOMATION_REVIEW_LABEL = 'Requiere revisión'

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

const automationRequests = new Map<string, Promise<Automation>>()
const deletedAutomationIds = new Set<string>()

export function automationToSummary(automation: Automation): AutomationSummary {
  return {
    id: automation.id,
    folderId: automation.folderId,
    name: automation.name,
    description: automation.description,
    status: automation.status,
    hasUnpublishedChanges: automation.hasUnpublishedChanges,
    reviewStatus: automation.reviewStatus,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    publishedAt: automation.publishedAt
  }
}

function cacheAutomation(automation: Automation) {
  if (deletedAutomationIds.has(automation.id)) return
  automationsCache.automations.set(automation.id, automation)
  if (!automationsCache.overview) return

  const summary = automationToSummary(automation)
  const exists = automationsCache.overview.automations.some((item) => item.id === automation.id)
  automationsCache.overview = {
    ...automationsCache.overview,
    automations: exists
      ? automationsCache.overview.automations.map((item) =>
          item.id === automation.id ? { ...item, ...summary } : item
        )
      : [summary, ...automationsCache.overview.automations]
  }
}

function fetchAutomation(automationId: string): Promise<Automation> {
  const inFlight = automationRequests.get(automationId)
  if (inFlight) return inFlight

  const request = apiClient
    .get<Automation>(`/automations/${automationId}`)
    .then((automation) => {
      cacheAutomation(automation)
      return automation
    })
    .finally(() => {
      automationRequests.delete(automationId)
    })

  automationRequests.set(automationId, request)
  return request
}

export const automationsService = {
  async getOverview(options: { suppressFeatureNotAvailableToast?: boolean } = {}): Promise<AutomationsOverview> {
    const overview = await apiClient.get<AutomationsOverview>('/automations', options)
    automationsCache.overview = overview
    return overview
  },

  async getAutomation(automationId: string): Promise<Automation> {
    return fetchAutomation(automationId)
  },

  async prefetchAutomation(automationId: string): Promise<void> {
    if (automationsCache.automations.has(automationId)) return
    await fetchAutomation(automationId).catch(() => undefined)
  },

  async createAutomation(input: { name: string; folderId?: string | null }): Promise<Automation> {
    const automation = await apiClient.post<Automation>('/automations', input)
    deletedAutomationIds.delete(automation.id)
    cacheAutomation(automation)
    return automation
  },

  async updateAutomation(automationId: string, input: AutomationUpdateInput): Promise<Automation> {
    const automation = await apiClient.put<Automation>(`/automations/${automationId}`, input)
    if (deletedAutomationIds.has(automation.id)) return automation
    cacheAutomation(automation)
    return automation
  },

  async duplicateAutomation(automationId: string): Promise<Automation> {
    const automation = await apiClient.post<Automation>(`/automations/${automationId}/duplicate`)
    deletedAutomationIds.delete(automation.id)
    cacheAutomation(automation)
    return automation
  },

  async deleteAutomation(automationId: string): Promise<void> {
    deletedAutomationIds.add(automationId)
    try {
      await apiClient.delete(`/automations/${automationId}`)
      automationRequests.delete(automationId)
      automationsCache.automations.delete(automationId)
      if (automationsCache.overview) {
        automationsCache.overview = {
          ...automationsCache.overview,
          automations: automationsCache.overview.automations.filter((automation) => automation.id !== automationId)
        }
      }
    } catch (error) {
      deletedAutomationIds.delete(automationId)
      throw error
    }
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
    const result = await apiClient.post<ContactAutomationEnrollmentResult>(`/automations/${automationId}/enroll-contact`, input)
    notifyAutomationEnrollmentChanged(automationId, result.enrollment)
    return result
  },

  async controlEnrollment(
    automationId: string,
    enrollmentId: string,
    input: AutomationEnrollmentControlInput
  ): Promise<AutomationEnrollment> {
    const enrollment = await apiClient.post<AutomationEnrollment>(
      `/automations/${automationId}/enrollments/${enrollmentId}/control`,
      input
    )
    notifyAutomationEnrollmentChanged(automationId, enrollment)
    return enrollment
  },

  async testAutomation(
    automationId: string,
    input: { contactId?: string; contact?: AutomationTestContactInput }
  ): Promise<AutomationTestRunResult> {
    const result = await apiClient.post<AutomationTestRunResult>(`/automations/${automationId}/test-run`, input)
    notifyAutomationEnrollmentChanged(automationId, result.enrollment)
    return result
  },

  async testWebhookAction(input: AutomationWebhookActionTestInput): Promise<AutomationWebhookActionTestResult> {
    return apiClient.post<AutomationWebhookActionTestResult>('/automations/test-webhook-action', input)
  },

  async deleteFolder(folderId: string): Promise<void> {
    await apiClient.delete(`/automations/folders/${folderId}`)
  },

  /** Sube un archivo (data URL base64) y devuelve su URL pública en Ristak */
  async uploadAsset(fileBase64: string, filename: string, deliveryMode?: 'audio' | 'voice'): Promise<{ id: string; url: string; contentType: string }> {
    return apiClient.post<{ id: string; url: string; contentType: string }>('/automations/assets', {
      fileBase64,
      filename,
      ...(deliveryMode ? { deliveryMode } : {})
    })
  }
}

export default automationsService
