import { getApiBaseUrl } from './apiBaseUrl'

export type MediaStorageQuotaDecision = 'continue' | 'connect' | 'cancel'

export interface MediaStorageQuotaPrompt {
  allowed: boolean
  warningRequired: boolean
  warningThresholdPercent: number
  quotaBytes: number | null
  usedBytes: number
  reservedBytes: number
  requestedBytes: number
  projectedBytes: number
  availableBytes: number | null
  usagePercent: number | null
  projectedUsagePercent: number | null
  connectPath: string
}

type MediaStorageQuotaPromptHandler = (
  prompt: MediaStorageQuotaPrompt
) => Promise<MediaStorageQuotaDecision>

type ApiQuotaPayload = {
  allowed?: boolean
  warning_required?: boolean
  warning_threshold_percent?: number
  quota_bytes?: number | null
  used_bytes?: number
  reserved_bytes?: number
  requested_bytes?: number
  projected_bytes?: number
  available_bytes?: number | null
  usage_percent?: number | null
  projected_usage_percent?: number | null
  connect_path?: string
}

let promptHandler: MediaStorageQuotaPromptHandler | null = null
let promptQueue: Promise<unknown> = Promise.resolve()

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizePrompt(payload: ApiQuotaPayload = {}): MediaStorageQuotaPrompt {
  return {
    allowed: payload.allowed !== false,
    warningRequired: payload.warning_required === true,
    warningThresholdPercent: numberValue(payload.warning_threshold_percent, 90),
    quotaBytes: payload.quota_bytes === null ? null : numberValue(payload.quota_bytes, 1024 ** 3),
    usedBytes: Math.max(0, numberValue(payload.used_bytes)),
    reservedBytes: Math.max(0, numberValue(payload.reserved_bytes)),
    requestedBytes: Math.max(0, numberValue(payload.requested_bytes)),
    projectedBytes: Math.max(0, numberValue(payload.projected_bytes)),
    availableBytes: payload.available_bytes === null ? null : Math.max(0, numberValue(payload.available_bytes)),
    usagePercent: payload.usage_percent === null ? null : numberValue(payload.usage_percent),
    projectedUsagePercent: payload.projected_usage_percent === null
      ? null
      : numberValue(payload.projected_usage_percent),
    connectPath: String(payload.connect_path || '/settings/bunny')
  }
}

export function registerMediaStorageQuotaPromptHandler(handler: MediaStorageQuotaPromptHandler) {
  promptHandler = handler
  return () => {
    if (promptHandler === handler) promptHandler = null
  }
}

export function showMediaStorageQuotaPrompt(prompt: MediaStorageQuotaPrompt) {
  const queued = promptQueue.then(
    () => promptHandler?.(prompt) ?? Promise.resolve<MediaStorageQuotaDecision>('cancel'),
    () => promptHandler?.(prompt) ?? Promise.resolve<MediaStorageQuotaDecision>('cancel')
  ) as Promise<MediaStorageQuotaDecision>
  promptQueue = queued.catch(() => undefined)
  return queued
}

function dataUrlByteLength(value: string) {
  const match = /^data:[^,]*;base64,([a-z0-9+/=\s]+)$/i.exec(value.trim())
  if (!match) return 0
  const payload = match[1].replace(/\s/g, '')
  if (!payload) return 0
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

export function estimateMediaUploadBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === 'string') return dataUrlByteLength(value)
  if (!value || typeof value !== 'object') return 0

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return Math.max(0, value.size)
  }
  if (seen.has(value)) return 0
  seen.add(value)

  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    let total = 0
    value.forEach(entry => { total += estimateMediaUploadBytes(entry, seen) })
    return total
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + estimateMediaUploadBytes(entry, seen), 0)
  }

  return Object.values(value as Record<string, unknown>)
    .reduce<number>((total, entry) => total + estimateMediaUploadBytes(entry, seen), 0)
}

function createQuotaGuardError(message: string, code: string, status = 0) {
  const error = new Error(message) as Error & { code?: string; status?: number }
  error.name = code === 'media_upload_cancelled' ? 'AbortError' : 'MediaStorageQuotaError'
  error.code = code
  error.status = status
  return error
}

async function fetchUploadPreflight(requestedBytes: number): Promise<MediaStorageQuotaPrompt> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  try {
    const token = localStorage.getItem('auth_token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } catch {
    // La petición seguirá y el backend aplicará la autenticación normal.
  }

  const response = await fetch(`${getApiBaseUrl()}/api/media/upload-preflight`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestedBytes })
  })
  const payload = await response.json().catch(() => null) as {
    data?: ApiQuotaPayload
    error?: string
    message?: string
  } | null

  if (!response.ok) {
    throw createQuotaGuardError(
      String(payload?.error || payload?.message || 'No se pudo revisar el espacio disponible.'),
      'media_storage_preflight_failed',
      response.status
    )
  }
  return normalizePrompt(payload?.data || {})
}

export async function requestMediaStorageUploadPermission(requestedBytes: number) {
  const bytes = Math.max(0, Math.round(numberValue(requestedBytes)))
  if (!bytes) return

  const prompt = await fetchUploadPreflight(bytes)
  if (prompt.allowed && !prompt.warningRequired) return

  const decision = await showMediaStorageQuotaPrompt(prompt)
  if (prompt.allowed && decision === 'continue') return
  if (decision === 'connect') {
    throw createQuotaGuardError(
      'La subida se pausó para que conectes tu cuenta de Bunny.net.',
      'media_storage_connection_requested'
    )
  }
  if (!prompt.allowed) {
    throw createQuotaGuardError(
      'Ya no hay espacio en el GB incluido. Conecta tu cuenta de Bunny.net para seguir subiendo.',
      'storage_quota_exceeded',
      413
    )
  }
  throw createQuotaGuardError('Subida cancelada.', 'media_upload_cancelled')
}

export async function showMediaStorageQuotaExceeded(payload: unknown) {
  const body = payload && typeof payload === 'object'
    ? payload as { details?: ApiQuotaPayload }
    : {}
  const prompt = normalizePrompt({
    ...(body.details || {}),
    allowed: false,
    warning_required: true
  })
  await showMediaStorageQuotaPrompt(prompt)
}
