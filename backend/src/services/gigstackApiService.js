import { decodeGigstackTokenMetadata } from './paymentSettingsService.js'

const GIGSTACK_API_BASE_URL = (process.env.GIGSTACK_API_BASE_URL || 'https://api.gigstack.io/v2').replace(/\/+$/, '')
export const GIGSTACK_REQUEST_TIMEOUT_MS = 15_000
function cleanString(value, maxLength = 500) { return String(value || '').trim().slice(0, maxLength) }
function gigstackModeTitle(mode) { return mode === 'live' ? 'Live' : 'Test' }

export function createGigstackError(message, { status = 0, code = 'gigstack_error', retryable = false } = {}) {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.retryable = retryable
  return error
}

export function gigstackErrorDetail(value, depth = 0) {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return cleanString(value, 1000)
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => gigstackErrorDetail(item, depth + 1)).filter(Boolean).join('; ')
  }
  if (typeof value !== 'object') return ''

  // Read diagnostic fields, not echoed requests, credentials or provider config.
  const diagnosticKeys = ['code', 'field', 'path', 'message', 'detail', 'description', 'error', 'errors', 'details']
  const keys = diagnosticKeys.some((key) => value[key] != null)
    ? diagnosticKeys
    : Object.keys(value).filter((key) => !/token|secret|password|authorization|api.?key|headers|request|response|config|stack|metadata/i.test(key))
  return keys.slice(0, 20).map((key) => {
    const detail = gigstackErrorDetail(value[key], depth + 1)
    return detail && !diagnosticKeys.includes(key) ? `${key}: ${detail}` : detail
  }).filter(Boolean).join('; ')
}

export function normalizeGigstackPaymentMode(value) {
  const normalized = cleanString(value, 24).toLowerCase()
  if (['test', 'sandbox'].includes(normalized)) return 'test'
  if (['live', 'production'].includes(normalized)) return 'live'
  return null
}

export function getGigstackTokenForMode(taxes = {}, mode) {
  return mode === 'live'
    ? cleanString(taxes.gigstackLiveApiToken, 5000)
    : cleanString(taxes.gigstackTestApiToken, 5000)
}

export function assertGigstackTokenMode(token, mode) {
  if (!token) {
    throw createGigstackError(`Falta la API key ${gigstackModeTitle(mode)} de Gigstack.`, {
      code: `missing_${mode}_token`
    })
  }

  const metadata = decodeGigstackTokenMetadata(token)
  if (!metadata.valid) {
    throw createGigstackError(`La API key ${gigstackModeTitle(mode)} de Gigstack no tiene un formato verificable.`, {
      code: `invalid_${mode}_token`
    })
  }
  if (metadata.mode !== mode) {
    throw createGigstackError(
      `La API key configurada para ${gigstackModeTitle(mode)} pertenece al ambiente ${gigstackModeTitle(metadata.mode)}.`,
      { code: 'gigstack_token_mode_mismatch' }
    )
  }
  return metadata
}

export async function gigstackRequest(path, { token, method = 'GET', body, timeoutMs = GIGSTACK_REQUEST_TIMEOUT_MS, responseType = 'json', maxResponseBytes = 25 * 1024 * 1024 } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(Number(timeoutMs) || GIGSTACK_REQUEST_TIMEOUT_MS, 30_000)))
  timeout.unref?.()
  try {
    const response = await fetch(`${GIGSTACK_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    })
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase()
    let data
    if (response.ok && responseType === 'file' && !contentType.includes('json') && typeof response.arrayBuffer === 'function') {
      const declaredSize = Number(response.headers?.get?.('content-length') || 0)
      if (declaredSize > maxResponseBytes) throw createGigstackError('El archivo fiscal excede el tamaño permitido.', { status: 413, code: 'gigstack_file_too_large' })
      const fileBuffer = Buffer.from(await response.arrayBuffer())
      if (fileBuffer.length > maxResponseBytes) throw createGigstackError('El archivo fiscal excede el tamaño permitido.', { status: 413, code: 'gigstack_file_too_large' })
      data = { fileBuffer, contentType }
    } else data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const details = [data?.message, data?.error, data?.errors, data?.details]
        .map((value) => gigstackErrorDetail(value)).filter(Boolean)
      const detail = [...new Set(details)].join('; ')
      const message = cleanString(token ? detail.split(token).join('[REDACTED]') : detail, 1000) || `Gigstack respondió ${response.status}`
      throw createGigstackError(message, {
        status: response.status,
        code: `gigstack_http_${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      })
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createGigstackError('Gigstack tardó demasiado en responder.', {
        code: 'gigstack_timeout',
        retryable: true
      })
    }
    if (error?.code) throw error
    throw createGigstackError(cleanString(error?.message, 1000) || 'No se pudo conectar con Gigstack.', {
      code: 'gigstack_network_error',
      retryable: true
    })
  } finally {
    clearTimeout(timeout)
  }
}
