/**
 * Conserva una sola operación por llave sin prestar el AbortSignal de un
 * consumidor a los demás. Cada caller puede dejar de esperar por separado;
 * la operación compartida continúa y todavía puede poblar el cache.
 */
function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) return signal.reason
  return new DOMException('La operación fue cancelada', 'AbortError')
}

export function getOrCreateSharedRequest<K, T>({
  inflight,
  key,
  createRequest,
  signal
}: {
  inflight: Map<K, Promise<T>>;
  key: K;
  createRequest: () => Promise<T>;
  signal?: AbortSignal;
}): Promise<T> {
  let sharedRequest = inflight.get(key)

  if (!sharedRequest) {
    const request = createRequest()
    const trackedRequest = request.finally(() => {
      if (inflight.get(key) === trackedRequest) inflight.delete(key)
    })
    sharedRequest = trackedRequest
    inflight.set(key, trackedRequest)
  }

  if (!signal) return sharedRequest
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    // Cierra la carrera entre la comprobación previa y addEventListener().
    if (signal.aborted) {
      onAbort()
      return
    }
    sharedRequest.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}
