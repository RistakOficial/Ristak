import { apiUrl } from './apiBaseUrl'
import {
  getAuthScopedCacheRevision,
  registerAuthScopedCacheInvalidator,
  syncAuthScopedCachePrincipal
} from './authPrincipalCache'
import { withRequestTimeout } from './requestTimeout'
import { abortAndClearSharedRequests, getOrCreateSharedRequest } from './sharedRequest'

export interface AIRuntimeConfigStatus {
  configured: boolean
  needsReconnect?: boolean
  connectionIssue?: string | null
  connectionIssueCode?: string | null
  businessContext?: string
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
    sourceContext?: string | null
    updatedAt?: string | null
  }
  updatedAt?: string | null
}

export interface AITranscriptionResult {
  text: string
  model: string
}

export const AI_RUNTIME_CONFIG_CHANGED_EVENT = 'ai-runtime-config-changed'
export const AI_RUNTIME_RECONNECT_REQUIRED_CODE = 'OPENAI_CREDENTIAL_RECONNECT_REQUIRED'

const CONFIG_SNAPSHOT_TTL_MS = 60_000
const CONFIG_REQUEST_TIMEOUT_MS = 20_000
const configInflight = new Map<number, Promise<AIRuntimeConfigStatus>>()
let configSnapshot: {
  data: AIRuntimeConfigStatus
  fetchedAt: number
  principalRevision: number
} | null = null
let configGeneration = 0

function invalidateConfigRead() {
  configGeneration += 1
  abortAndClearSharedRequests(configInflight)
  configSnapshot = null
}

function beginConfigMutation() {
  syncAuthScopedCachePrincipal()
  invalidateConfigRead()
  return [configGeneration, getAuthScopedCacheRevision()] as const
}

function publishConfigSnapshot(
  data: AIRuntimeConfigStatus,
  [generation, principalRevision]: readonly [number, number]
) {
  if (
    generation === configGeneration &&
    principalRevision === getAuthScopedCacheRevision()
  ) {
    configSnapshot = { data, fetchedAt: Date.now(), principalRevision }
  }
}

function emitConfigChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AI_RUNTIME_CONFIG_CHANGED_EVENT))
  }
}

registerAuthScopedCacheInvalidator(invalidateConfigRead)

function getAuthHeaders(includeContentType = true): HeadersInit {
  const token = localStorage.getItem('auth_token')
  return {
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

function createRuntimeRequestError(payload: any, status: number, fallback: string) {
  const error = new Error(payload?.error || payload?.message || fallback) as Error & {
    status?: number
    code?: string
    needsReconnect?: boolean
  }
  error.status = status
  error.code = payload?.code
  error.needsReconnect = Boolean(
    payload?.needsReconnect || payload?.code === AI_RUNTIME_RECONNECT_REQUIRED_CODE
  )
  return error
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/ai-runtime${endpoint}`), {
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
    throw createRuntimeRequestError(payload, response.status, 'No se pudo consultar la configuración de IA')
  }

  return (payload?.data ?? payload) as T
}

function getConfig(options: { signal?: AbortSignal } = {}): Promise<AIRuntimeConfigStatus> {
  syncAuthScopedCachePrincipal()
  const principalRevision = getAuthScopedCacheRevision()

  if (
    configSnapshot &&
    configSnapshot.principalRevision === principalRevision &&
    Date.now() - configSnapshot.fetchedAt < CONFIG_SNAPSHOT_TTL_MS
  ) {
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason || new DOMException('La lectura de IA fue cancelada.', 'AbortError')
      )
    }
    return Promise.resolve(configSnapshot.data)
  }

  const generation = configGeneration
  return getOrCreateSharedRequest({
    inflight: configInflight,
    key: principalRevision,
    signal: options.signal,
    abortWhenUnused: true,
    createRequest: (sharedSignal) => withRequestTimeout({
      timeoutMs: CONFIG_REQUEST_TIMEOUT_MS,
      timeoutMessage: 'La configuración de IA tardó demasiado. Reintenta la carga.',
      signal: sharedSignal,
      request: (requestSignal) => request<AIRuntimeConfigStatus>('/config', {
        signal: requestSignal
      })
    }).then((status) => {
      if (
        generation === configGeneration &&
        principalRevision === getAuthScopedCacheRevision()
      ) {
        configSnapshot = { data: status, fetchedAt: Date.now(), principalRevision }
      }
      return status
    })
  })
}

export const aiRuntimeService = {
  getConfig,

  async saveBusinessProfile(businessContext: string): Promise<AIRuntimeConfigStatus> {
    const context = beginConfigMutation()
    const status = await request<AIRuntimeConfigStatus>('/business-profile', {
      method: 'PUT',
      body: JSON.stringify({ businessContext })
    })
    publishConfigSnapshot(status, context)
    emitConfigChange()
    return status
  },

  async transcribeVoice(audioBlob: Blob): Promise<AITranscriptionResult> {
    const response = await fetch(apiUrl('/api/ai-runtime/transcribe'), {
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
      throw createRuntimeRequestError(payload, response.status, 'Error al transcribir el audio')
    }

    return (payload?.data ?? payload) as AITranscriptionResult
  },

  invalidateConfig() {
    invalidateConfigRead()
    emitConfigChange()
  }
}

export function isAIRuntimeReconnectError(error: unknown) {
  const candidate = error as { code?: string; needsReconnect?: boolean; status?: number } | null
  return Boolean(
    candidate?.needsReconnect ||
    candidate?.code === AI_RUNTIME_RECONNECT_REQUIRED_CODE ||
    candidate?.status === 409
  )
}
