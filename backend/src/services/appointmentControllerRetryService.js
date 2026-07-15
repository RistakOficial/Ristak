const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])

export function classifyAppointmentControllerFailure({ result = null, error = null } = {}) {
  const statusCodeValue = Number(result?.statusCode ?? error?.statusCode ?? error?.status ?? 0)
  const statusCode = Number.isInteger(statusCodeValue) && statusCodeValue >= 100 && statusCodeValue <= 599
    ? statusCodeValue
    : null
  const rawCode = String(
    result?.payload?.code ||
    error?.code ||
    error?.cause?.code ||
    ''
  ).trim()
  const networkCode = rawCode.toUpperCase()
  const code = (rawCode || (statusCode ? `HTTP_${statusCode}` : 'controller_failure'))
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 120)
  const responseFailed = Boolean(
    error ||
    (statusCode && statusCode >= 400) ||
    result?.payload?.success === false
  )
  const retryableHttpStatus = RETRYABLE_STATUS_CODES.has(statusCode)
  const retryableNetworkFailure = statusCode === null && RETRYABLE_NETWORK_CODES.has(networkCode)
  return {
    responseFailed,
    statusCode,
    code,
    retryable: responseFailed && (retryableHttpStatus || retryableNetworkFailure)
  }
}

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)))
}

/**
 * Retry acotado para el mismo request idempotente. Nunca abandona una promesa
 * en vuelo: el siguiente intento empieza sólo cuando el anterior respondió o
 * rechazó, evitando dos creaciones concurrentes por un timeout cosmético.
 */
export async function runBoundedAppointmentControllerRequest({
  invoke,
  maxAttempts = 2,
  delayMs = 200,
  onRetry = null,
  wait = waitForRetry
} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('invoke debe ser una función')
  const boundedAttempts = Math.max(1, Math.min(2, Math.trunc(Number(maxAttempts) || 2)))
  let firstFailure = null

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      const result = await invoke(attempt)
      const failure = classifyAppointmentControllerFailure({ result })
      if (!firstFailure && failure.responseFailed) firstFailure = failure
      if (attempt < boundedAttempts && failure.retryable) {
        if (typeof onRetry === 'function') {
          await onRetry({ failure, attempt, nextAttempt: attempt + 1 })
        }
        await wait(delayMs)
        continue
      }
      return {
        result,
        attempts: attempt,
        retried: attempt > 1,
        firstFailure
      }
    } catch (error) {
      const failure = classifyAppointmentControllerFailure({ error })
      if (!firstFailure) firstFailure = failure
      if (attempt < boundedAttempts && failure.retryable) {
        if (typeof onRetry === 'function') {
          await onRetry({ failure, attempt, nextAttempt: attempt + 1 })
        }
        await wait(delayMs)
        continue
      }
      error.appointmentControllerAttempts = attempt
      error.appointmentControllerRetried = attempt > 1
      error.appointmentControllerFirstFailure = firstFailure
      throw error
    }
  }

  throw new Error('No se pudo completar el request acotado de cita')
}
