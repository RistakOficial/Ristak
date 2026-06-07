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
  sources?: Array<{
    title: string
    url: string
  }>
  clarificationOptions?: AIAgentClarificationOption[]
  usage?: unknown
  agentMemory?: AIAgentMessageMemory | null
  trace?: AIAgentTraceSummary | null
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
}

export const AI_AGENT_RECONNECT_REQUIRED_CODE = 'OPENAI_CREDENTIAL_RECONNECT_REQUIRED'

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

function getAuthHeaders(includeContentType = true): HeadersInit {
  const token = localStorage.getItem('auth_token')

  return {
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/ai-agent${endpoint}`, {
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
    throw createAIAgentRequestError(payload, response.status, 'Error en el agente AI')
  }

  return (payload?.data ?? payload) as T
}

export const aiAgentService = {
  getConfig(): Promise<AIAgentConfigStatus> {
    return request<AIAgentConfigStatus>('/config')
  },

  saveConfig(config: AIAgentConfigInput): Promise<AIAgentConfigStatus> {
    return request<AIAgentConfigStatus>('/config', {
      method: 'POST',
      body: JSON.stringify(config)
    })
  },

  async deleteConfig(): Promise<void> {
    await request('/config', {
      method: 'DELETE'
    })
  },

  saveBusinessContextAnswer(
    field: AIAgentBusinessContextField,
    answer: string
  ): Promise<AIAgentBusinessContextAnswerResult> {
    return request<AIAgentBusinessContextAnswerResult>('/business-context-answer', {
      method: 'POST',
      body: JSON.stringify({ field, answer })
    })
  },

  sendMessage(
    messages: AIAgentMessage[],
    viewContext: AIAgentViewContext,
    options: AIAgentRequestOptions = {}
  ): Promise<AIAgentChatResult> {
    return request<AIAgentChatResult>('/chat', {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({ messages, viewContext })
    })
  },

  getRunTrace(traceId: string): Promise<AIAgentRunTrace> {
    return request<AIAgentRunTrace>(`/runs/${encodeURIComponent(traceId)}`)
  },

  async transcribeVoice(audioBlob: Blob): Promise<AIAgentTranscriptionResult> {
    const response = await fetch(`${API_BASE_URL}/api/ai-agent/transcribe`, {
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
