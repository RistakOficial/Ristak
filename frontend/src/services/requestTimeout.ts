export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

function abortError(signal?: AbortSignal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('La operación fue cancelada', 'AbortError')
}

/**
 * Acota una lectura remota y propaga la cancelación del consumidor. El timeout
 * aborta el fetch real: no deja trabajo huérfano ni un loader esperando para
 * siempre cuando el servidor o la red dejan una promesa abierta.
 */
export async function withRequestTimeout<T>({
  request,
  timeoutMs,
  timeoutMessage,
  signal
}: {
  request: (signal: AbortSignal) => Promise<T>
  timeoutMs: number
  timeoutMessage: string
  signal?: AbortSignal
}): Promise<T> {
  if (signal?.aborted) throw abortError(signal)

  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(abortError(signal))
  signal?.addEventListener('abort', onAbort, { once: true })

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException(timeoutMessage, 'TimeoutError'))
  }, timeoutMs)

  try {
    return await request(controller.signal)
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(timeoutMessage)
    throw error
  } finally {
    globalThis.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onAbort)
  }
}
