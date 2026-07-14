import apiClient from './apiClient'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'

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
  pageInfo: {
    limit: number
    hasMore: boolean
    nextCursor: string | null
  }
}

export interface AutomationsListOptions {
  suppressFeatureNotAvailableToast?: boolean
  limit?: number
  cursor?: string | null
  search?: string
  folderId?: string | null
  status?: AutomationStatus
  includeReview?: boolean
  force?: boolean
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
const overviewListeners = new Set<(overview: AutomationsOverview) => void>()
const overviewPageCache = new Map<string, { overview: AutomationsOverview; expiresAt: number }>()
const overviewPageRequests = new Map<string, Promise<AutomationsOverview>>()
const OVERVIEW_PAGE_CACHE_TTL_MS = 15_000
const OVERVIEW_PAGE_CACHE_MAX_ENTRIES = 40
let overviewRequestVersion = 0
let overviewRevision = 0

function invalidateAutomationsPrincipalCache() {
  overviewRequestVersion += 1
  overviewRevision = 0
  automationsCache.overview = null
  automationsCache.automations.clear()
  automationRequests.clear()
  overviewPageCache.clear()
  overviewPageRequests.clear()
  deletedAutomationIds.clear()
}

registerAuthScopedCacheInvalidator(invalidateAutomationsPrincipalCache)

function startAuthScopedCacheOperation() {
  syncAuthScopedCachePrincipal()
  return getAuthScopedCacheRevision()
}

function canPublishAuthScopedResult(requestPrincipalRevision: number) {
  return requestPrincipalRevision === getAuthScopedCacheRevision()
}

function invalidateAutomationListPages() {
  overviewRevision += 1
  overviewPageCache.clear()
  overviewPageRequests.clear()
}

function normalizeListOptions(options: AutomationsListOptions) {
  return {
    limit: Math.min(100, Math.max(1, Math.trunc(options.limit || 50))),
    cursor: String(options.cursor || '').trim(),
    search: String(options.search || '').trim().slice(0, 200),
    folderId: options.folderId === undefined || options.folderId === null
      ? null
      : (String(options.folderId).trim() || 'root'),
    status: options.status || '',
    includeReview: options.includeReview === true
  }
}

function overviewPageKey(options: ReturnType<typeof normalizeListOptions>) {
  return JSON.stringify(options)
}

function cacheOverviewPage(key: string, overview: AutomationsOverview) {
  overviewPageCache.delete(key)
  overviewPageCache.set(key, {
    overview,
    expiresAt: Date.now() + OVERVIEW_PAGE_CACHE_TTL_MS
  })
  while (overviewPageCache.size > OVERVIEW_PAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = overviewPageCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    overviewPageCache.delete(oldestKey)
  }
}

function publishOverview(overview: AutomationsOverview, localMutation = false) {
  if (localMutation) overviewRevision += 1
  automationsCache.overview = {
    folders: [...overview.folders],
    automations: overview.automations.filter(automation => !deletedAutomationIds.has(automation.id)),
    pageInfo: { ...overview.pageInfo }
  }
  overviewListeners.forEach(listener => listener(automationsCache.overview as AutomationsOverview))
}

function mutateOverview(update: (overview: AutomationsOverview) => AutomationsOverview) {
  if (!automationsCache.overview) return
  publishOverview(update(automationsCache.overview), true)
}

export function subscribeAutomationsOverview(
  listener: (overview: AutomationsOverview) => void
): () => void {
  syncAuthScopedCachePrincipal()
  overviewListeners.add(listener)
  return () => overviewListeners.delete(listener)
}

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
  publishOverview({
    ...automationsCache.overview,
    automations: exists
      ? automationsCache.overview.automations.map((item) =>
          item.id === automation.id ? { ...item, ...summary } : item
        )
      : [summary, ...automationsCache.overview.automations]
  }, true)
}

function fetchAutomation(automationId: string): Promise<Automation> {
  syncAuthScopedCachePrincipal()
  const requestPrincipalRevision = getAuthScopedCacheRevision()
  const inFlight = automationRequests.get(automationId)
  if (inFlight) return inFlight

  const request = apiClient
    .get<Automation>(`/automations/${automationId}`)
    .then((automation) => {
      if (requestPrincipalRevision === getAuthScopedCacheRevision()) {
        cacheAutomation(automation)
      }
      return automation
    })
    .finally(() => {
      if (automationRequests.get(automationId) === request) {
        automationRequests.delete(automationId)
      }
    })

  automationRequests.set(automationId, request)
  return request
}

export const automationsService = {
  async getOverview(options: AutomationsListOptions = {}): Promise<AutomationsOverview> {
    syncAuthScopedCachePrincipal()
    const requestPrincipalRevision = getAuthScopedCacheRevision()
    const normalizedOptions = normalizeListOptions(options)
    const cacheKey = overviewPageKey(normalizedOptions)
    const cached = overviewPageCache.get(cacheKey)
    if (!options.force && cached && cached.expiresAt > Date.now()) {
      overviewPageCache.delete(cacheKey)
      overviewPageCache.set(cacheKey, cached)
      return cached.overview
    }

    if (!options.force) {
      const inFlight = overviewPageRequests.get(cacheKey)
      if (inFlight) return inFlight
    }

    const requestVersion = overviewRequestVersion
    const startingRevision = overviewRevision
    const params: Record<string, string> = {
      limit: String(normalizedOptions.limit),
      includeReview: String(normalizedOptions.includeReview)
    }
    if (normalizedOptions.cursor) params.cursor = normalizedOptions.cursor
    if (normalizedOptions.search) params.search = normalizedOptions.search
    if (normalizedOptions.folderId !== null) {
      params.folderId = normalizedOptions.folderId
    }
    if (normalizedOptions.status) params.status = normalizedOptions.status

    const request = apiClient.get<AutomationsOverview>('/automations', {
      params,
      suppressFeatureNotAvailableToast: options.suppressFeatureNotAvailableToast
    }).then((overview) => {
      const normalized: AutomationsOverview = {
        folders: Array.isArray(overview.folders) ? overview.folders : [],
        automations: (Array.isArray(overview.automations) ? overview.automations : [])
          .filter(automation => !deletedAutomationIds.has(automation.id)),
        pageInfo: overview.pageInfo || {
          limit: normalizedOptions.limit,
          hasMore: false,
          nextCursor: null
        }
      }

      if (
        requestPrincipalRevision === getAuthScopedCacheRevision() &&
        requestVersion === overviewRequestVersion &&
        startingRevision === overviewRevision
      ) {
        cacheOverviewPage(cacheKey, normalized)
        if (!normalizedOptions.cursor && !normalizedOptions.search && options.folderId === undefined) {
          publishOverview(normalized)
        }
      }

      return normalized
    }).finally(() => {
      if (overviewPageRequests.get(cacheKey) === request) {
        overviewPageRequests.delete(cacheKey)
      }
    })

    overviewPageRequests.set(cacheKey, request)
    return request
  },

  async getAutomation(automationId: string): Promise<Automation> {
    return fetchAutomation(automationId)
  },

  async prefetchAutomation(automationId: string): Promise<void> {
    syncAuthScopedCachePrincipal()
    if (automationsCache.automations.has(automationId)) return
    await fetchAutomation(automationId).catch(() => undefined)
  },

  async createAutomation(input: { name: string; folderId?: string | null }): Promise<Automation> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const automation = await apiClient.post<Automation>('/automations', input)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      deletedAutomationIds.delete(automation.id)
      cacheAutomation(automation)
    }
    return automation
  },

  async updateAutomation(automationId: string, input: AutomationUpdateInput): Promise<Automation> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const automation = await apiClient.put<Automation>(`/automations/${automationId}`, input)
    if (
      canPublishAuthScopedResult(requestPrincipalRevision)
      && !deletedAutomationIds.has(automation.id)
    ) {
      invalidateAutomationListPages()
      cacheAutomation(automation)
    }
    return automation
  },

  async duplicateAutomation(automationId: string): Promise<Automation> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const automation = await apiClient.post<Automation>(`/automations/${automationId}/duplicate`)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      deletedAutomationIds.delete(automation.id)
      cacheAutomation(automation)
    }
    return automation
  },

  async deleteAutomation(automationId: string): Promise<void> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const previousIndex = automationsCache.overview?.automations.findIndex(automation => automation.id === automationId) ?? -1
    const previousSummary = previousIndex >= 0
      ? automationsCache.overview?.automations[previousIndex] || null
      : null
    invalidateAutomationListPages()
    deletedAutomationIds.add(automationId)
    mutateOverview(overview => ({
      ...overview,
      automations: overview.automations.filter(automation => automation.id !== automationId)
    }))

    try {
      await apiClient.delete(`/automations/${automationId}`)
      if (canPublishAuthScopedResult(requestPrincipalRevision)) {
        automationRequests.delete(automationId)
        automationsCache.automations.delete(automationId)
      }
    } catch (error) {
      if (canPublishAuthScopedResult(requestPrincipalRevision)) {
        deletedAutomationIds.delete(automationId)
        if (previousSummary) {
          mutateOverview(overview => {
            if (overview.automations.some(automation => automation.id === automationId)) return overview
            const automations = [...overview.automations]
            automations.splice(Math.min(previousIndex, automations.length), 0, previousSummary)
            return { ...overview, automations }
          })
        }
      }
      throw error
    }
  },

  async createFolder(input: { name: string }): Promise<AutomationFolder> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const folder = await apiClient.post<AutomationFolder>('/automations/folders', input)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      mutateOverview(overview => ({
        ...overview,
        folders: [...overview.folders.filter(item => item.id !== folder.id), folder]
          .sort((a, b) => a.position - b.position)
      }))
    }
    return folder
  },

  async updateFolder(
    folderId: string,
    input: { name?: string; position?: number }
  ): Promise<AutomationFolder> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const folder = await apiClient.put<AutomationFolder>(`/automations/folders/${folderId}`, input)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      mutateOverview(overview => ({
        ...overview,
        folders: overview.folders.map(item => item.id === folder.id ? folder : item)
          .sort((a, b) => a.position - b.position)
      }))
    }
    return folder
  },

  async reorderFolders(orderedIds: string[]): Promise<AutomationFolder[]> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const folders = await apiClient.post<AutomationFolder[]>('/automations/folders/reorder', { orderedIds })
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      mutateOverview(overview => ({ ...overview, folders }))
    }
    return folders
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
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const result = await apiClient.post<ContactAutomationEnrollmentResult>(`/automations/${automationId}/enroll-contact`, input)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      notifyAutomationEnrollmentChanged(automationId, result.enrollment)
    }
    return result
  },

  async controlEnrollment(
    automationId: string,
    enrollmentId: string,
    input: AutomationEnrollmentControlInput
  ): Promise<AutomationEnrollment> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const enrollment = await apiClient.post<AutomationEnrollment>(
      `/automations/${automationId}/enrollments/${enrollmentId}/control`,
      input
    )
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      notifyAutomationEnrollmentChanged(automationId, enrollment)
    }
    return enrollment
  },

  async testAutomation(
    automationId: string,
    input: { contactId?: string; contact?: AutomationTestContactInput }
  ): Promise<AutomationTestRunResult> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    const result = await apiClient.post<AutomationTestRunResult>(`/automations/${automationId}/test-run`, input)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      notifyAutomationEnrollmentChanged(automationId, result.enrollment)
    }
    return result
  },

  async testWebhookAction(input: AutomationWebhookActionTestInput): Promise<AutomationWebhookActionTestResult> {
    return apiClient.post<AutomationWebhookActionTestResult>('/automations/test-webhook-action', input)
  },

  async deleteFolder(folderId: string): Promise<void> {
    const requestPrincipalRevision = startAuthScopedCacheOperation()
    await apiClient.delete(`/automations/folders/${folderId}`)
    if (canPublishAuthScopedResult(requestPrincipalRevision)) {
      invalidateAutomationListPages()
      mutateOverview(overview => ({
        ...overview,
        folders: overview.folders.filter(folder => folder.id !== folderId),
        automations: overview.automations.map(automation => (
          automation.folderId === folderId ? { ...automation, folderId: null } : automation
        ))
      }))
    }
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
