import { apiUrl } from './apiBaseUrl'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import { refreshIntegrationsStatusAfter } from './integrationsService'
import { withRequestTimeout } from './requestTimeout'
import { abortAndClearSharedRequests, getOrCreateSharedRequest } from './sharedRequest'

export type AIAgentRole = 'user' | 'assistant'
export type AIAgentResponseStyle = 'direct' | 'balanced' | 'advisor'
export type AIAgentRecommendationMode = 'on_request' | 'when_useful' | 'proactive'
export type AIAgentAttachmentKind = 'image' | 'video' | 'pdf' | 'text' | 'file'
export type AIAgentBusinessContextField =
  | 'businessContext'
  | 'marketContext'
  | 'idealCustomer'
  | 'locationContext'
  | 'competitorsContext'
  | 'brandVoice'

export interface AIAgentAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: AIAgentAttachmentKind
  dataUrl?: string
  text?: string
  thumbnailDataUrl?: string
}

export interface AIAgentContactMemory {
  id: string
  name?: string
  email?: string
  phone?: string
  firstName?: string
  lastName?: string
  createdAt?: string | null
  totalPaid?: number
  storedCard?: unknown
}

export interface AIAgentProductMemory {
  id?: string
  name?: string
  description?: string
  currency?: string
  price?: {
    id?: string
    name?: string
    amount?: number
    currency?: string
  } | null
}

export interface AIAgentMessageMemory {
  version: number
  generatedAt?: string
  activeContact?: AIAgentContactMemory | null
  contacts?: AIAgentContactMemory[]
  activeProduct?: AIAgentProductMemory | null
  products?: AIAgentProductMemory[]
}

export interface AIAgentTraceSummary {
  traceId: string
  status: 'running' | 'completed' | 'waiting_user' | 'failed' | string
  detailUrl?: string
}

export interface AIAgentMessage {
  id?: string
  role: AIAgentRole
  content: string
  attachments?: AIAgentAttachment[]
  agentMemory?: AIAgentMessageMemory | null
  selectedClarificationOption?: AIAgentSelectedClarificationOption
  sources?: Array<{
    title: string
    url: string
  }>
  clarificationOptions?: AIAgentClarificationOption[]
  trace?: AIAgentTraceSummary | null
  createdAt?: string
}

export interface AIAgentSelectedClarificationOption {
  label: string
  value: string
  description?: string
  assistantMessageId?: string
}

export interface AIAgentClarificationOption {
  label: string
  value: string
  description?: string
}

export interface AIAgentConfigStatus {
  configured: boolean
  model: string
  tokenPreview: string | null
  credentialStatus?: 'missing' | 'ready' | 'reconnect_required'
  needsReconnect?: boolean
  connectionIssue?: string | null
  connectionIssueCode?: string | null
  businessContext: string
  businessProfile?: {
    configured?: boolean
    status?: string
    extractionStatus?: string
    extractionError?: string | null
    summary?: string | null
    businessName?: string | null
    industry?: string | null
    businessType?: string | null
    profile?: unknown
    promptParameters?: Record<string, string>
    updatedAt?: string | null
  }
  marketContext: string
  idealCustomer: string
  locationContext: string
  competitorsContext: string
  brandVoice: string
  actionCustomizations: string
  researchDomains: string
  responseStyle: AIAgentResponseStyle
  recommendationMode: AIAgentRecommendationMode
  webSearchEnabled: boolean
  updatedAt: string | null
}

export interface AIAgentConfigInput {
  apiKey?: string
  model: string
  businessContext: string
  marketContext: string
  idealCustomer: string
  locationContext: string
  competitorsContext: string
  brandVoice: string
  actionCustomizations: string
  researchDomains: string
  responseStyle: AIAgentResponseStyle
  recommendationMode: AIAgentRecommendationMode
  webSearchEnabled: boolean
}

export interface AIAgentViewContext {
  path: string
  title: string
  routeLabel: string
  visibleText: string
}

interface AIAgentChatResult {
  reply: string
  model: string
  category?: string
  sources?: Array<{
    title: string
    url: string
  }>
  clarificationOptions?: AIAgentClarificationOption[]
  usage?: unknown
  agentMemory?: AIAgentMessageMemory | null
  trace?: AIAgentTraceSummary | null
}

export interface AIAgentCategory {
  id: string
  label: string
  icon: string
  description: string
}

interface AIAgentTranscriptionResult {
  text: string
  model: string
}

export interface AIAgentRunTrace {
  id: string
  traceId: string
  status: string
  domain?: string | null
  action?: string | null
  sourceOfTruth?: string | null
  inputSummary?: string | null
  outputSummary?: string | null
  errorMessage?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  completedAt?: string | null
  steps: Array<{
    id: string
    index: number
    type: string
    toolName?: string | null
    status: string
    input?: unknown
    output?: unknown
    errorMessage?: string | null
    startedAt?: string | null
    completedAt?: string | null
  }>
}

interface AIAgentBusinessContextAnswerResult {
  field: AIAgentBusinessContextField
  text: string
  status: AIAgentConfigStatus
}

type AIAgentRequestOptions = {
  signal?: AbortSignal
  category?: string
}

export const AI_AGENT_RECONNECT_REQUIRED_CODE = 'OPENAI_CREDENTIAL_RECONNECT_REQUIRED'

const AI_AGENT_CONFIG_SNAPSHOT_TTL_MS = 60_000
const AI_AGENT_CONFIG_REQUEST_TIMEOUT_MS = 20_000
const aiAgentConfigInflight = new Map<number, Promise<AIAgentConfigStatus>>()
let aiAgentConfigSnapshot: {
  data: AIAgentConfigStatus
  fetchedAt: number
  principalRevision: number
} | null = null
let aiAgentConfigGeneration = 0

function invalidateAIAgentConfigRead(clearSnapshot = true) {
  aiAgentConfigGeneration += 1
  abortAndClearSharedRequests(aiAgentConfigInflight)
  if (clearSnapshot) aiAgentConfigSnapshot = null
}

function beginAIAgentConfigMutation() {
  syncAuthScopedCachePrincipal()
  invalidateAIAgentConfigRead(false)
  return [aiAgentConfigGeneration, getAuthScopedCacheRevision()] as const
}

function publishAIAgentConfigSnapshot(
  data: AIAgentConfigStatus,
  [generation, principalRevision]: readonly [number, number]
) {
  if (
    generation === aiAgentConfigGeneration &&
    principalRevision === getAuthScopedCacheRevision()
  ) {
    aiAgentConfigSnapshot = { data, fetchedAt: Date.now(), principalRevision }
  }
}

registerAuthScopedCacheInvalidator(invalidateAIAgentConfigRead)

function getAuthHeaders(includeContentType = true): HeadersInit {
  const token = localStorage.getItem('auth_token')

  return {
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/ai-agent${endpoint}`), {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options.headers
    }
  })

  let payload: any = null

  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw createAIAgentRequestError(payload, response.status, 'Error en asistente personal AI')
  }

  return (payload?.data ?? payload) as T
}

function getAIAgentConfig(
  options: { signal?: AbortSignal } = {}
): Promise<AIAgentConfigStatus> {
  syncAuthScopedCachePrincipal()
  const principalRevision = getAuthScopedCacheRevision()

  if (
    aiAgentConfigSnapshot &&
    aiAgentConfigSnapshot.principalRevision === principalRevision &&
    Date.now() - aiAgentConfigSnapshot.fetchedAt < AI_AGENT_CONFIG_SNAPSHOT_TTL_MS
  ) {
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason || new DOMException('La lectura del agente fue cancelada.', 'AbortError')
      )
    }
    return Promise.resolve(aiAgentConfigSnapshot.data)
  }

  const context = [aiAgentConfigGeneration, principalRevision] as const
  return getOrCreateSharedRequest({
    inflight: aiAgentConfigInflight,
    key: principalRevision,
    signal: options.signal,
    abortWhenUnused: true,
    createRequest: (sharedSignal) => withRequestTimeout({
      timeoutMs: AI_AGENT_CONFIG_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'La configuración del agente tardó demasiado. Reintenta la carga.',
      signal: sharedSignal,
      request: (requestSignal) => request<AIAgentConfigStatus>('/config', {
        signal: requestSignal
      })
    }).then((status) => {
      publishAIAgentConfigSnapshot(status, context)
      return status
    })
  })
}

export const aiAgentService = {
  getConfig(options: { signal?: AbortSignal } = {}): Promise<AIAgentConfigStatus> {
    return getAIAgentConfig(options)
  },

  async saveConfig(config: AIAgentConfigInput): Promise<AIAgentConfigStatus> {
    const context = beginAIAgentConfigMutation()
    const status = await request<AIAgentConfigStatus>('/config', {
      method: 'POST',
      body: JSON.stringify(config)
    })
    publishAIAgentConfigSnapshot(status, context)
    return refreshIntegrationsStatusAfter(Promise.resolve(status))
  },

  async deleteConfig(): Promise<void> {
    const context = beginAIAgentConfigMutation()
    await refreshIntegrationsStatusAfter(request('/config', {
      method: 'DELETE'
    }))
    if (
      context[0] === aiAgentConfigGeneration &&
      context[1] === getAuthScopedCacheRevision()
    ) {
      aiAgentConfigSnapshot = null
    }
  },

  async deleteToken(): Promise<AIAgentConfigStatus> {
    const context = beginAIAgentConfigMutation()
    const status = await request<AIAgentConfigStatus>('/config/token', {
      method: 'DELETE'
    })
    publishAIAgentConfigSnapshot(status, context)
    return refreshIntegrationsStatusAfter(Promise.resolve(status))
  },

  async saveBusinessContextAnswer(
    field: AIAgentBusinessContextField,
    answer: string
  ): Promise<AIAgentBusinessContextAnswerResult> {
    const context = beginAIAgentConfigMutation()
    const result = await request<AIAgentBusinessContextAnswerResult>('/business-context-answer', {
      method: 'POST',
      body: JSON.stringify({ field, answer })
    })
    publishAIAgentConfigSnapshot(result.status, context)
    return result
  },

  sendMessage(
    messages: AIAgentMessage[],
    viewContext: AIAgentViewContext,
    options: AIAgentRequestOptions = {}
  ): Promise<AIAgentChatResult> {
    return request<AIAgentChatResult>('/chat', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        messages,
        viewContext,
        ...(options.category ? { category: options.category } : {})
      })
    })
  },

  getAgents(): Promise<AIAgentCategory[]> {
    return request<AIAgentCategory[]>('/agents')
  },

  getRunTrace(traceId: string): Promise<AIAgentRunTrace> {
    return request<AIAgentRunTrace>(`/runs/${encodeURIComponent(traceId)}`)
  },

  async transcribeVoice(audioBlob: Blob): Promise<AIAgentTranscriptionResult> {
    const response = await fetch(apiUrl('/api/ai-agent/transcribe'), {
      method: 'POST',
      headers: {
        ...getAuthHeaders(false),
        'Content-Type': audioBlob.type || 'audio/webm'
      },
      body: audioBlob
    })

    let payload: any = null

    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      throw createAIAgentRequestError(payload, response.status, 'Error al transcribir el audio')
    }

    return (payload?.data ?? payload) as AIAgentTranscriptionResult
  }
}

function createAIAgentRequestError(payload: any, status: number, fallback: string) {
  const error = new Error(payload?.error || payload?.message || fallback) as Error & {
    status?: number
    code?: string
    needsReconnect?: boolean
    trace?: AIAgentTraceSummary | null
  }

  error.status = status
  error.code = payload?.code
  error.needsReconnect = Boolean(payload?.needsReconnect || payload?.code === AI_AGENT_RECONNECT_REQUIRED_CODE)
  error.trace = payload?.trace || null

  return error
}

export function isAIAgentReconnectError(error: unknown) {
  const candidate = error as { code?: string; needsReconnect?: boolean; status?: number } | null
  return Boolean(
    candidate?.needsReconnect ||
    candidate?.code === AI_AGENT_RECONNECT_REQUIRED_CODE ||
    candidate?.status === 409
  )
}
