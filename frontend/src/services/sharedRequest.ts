/**
 * Conserva una sola operación por llave sin prestar el AbortSignal de un
 * consumidor a los demás. Por default cada caller puede dejar de esperar por
 * separado y la operación compartida continúa para poblar cache. Las lecturas
 * analíticas costosas pueden activar `abortWhenUnused`: al irse el último
 * consumidor se cancela el fetch real para que un rango viejo no compita con
 * el nuevo.
 */
function abortReason(signal: AbortSignal) {
  if (signal.reason !== undefined) return signal.reason
  return new DOMException('La operación fue cancelada', 'AbortError')
}

type AbortableSharedRequestLifecycle = {
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

const abortableSharedRequestLifecycles = new WeakMap<Promise<unknown>, AbortableSharedRequestLifecycle>()

/**
 * Desregistra las operaciones actuales sin cancelarlas. Los consumidores que ya
 * recibieron la promesa conservan su resultado, pero una lectura posterior no
 * puede reutilizar trabajo iniciado antes de una invalidación suave.
 */
export function detachSharedRequests<K, T>(inflight: Map<K, Promise<T>>) {
  inflight.clear()
}

export function abortAndClearSharedRequests<K, T>(
  inflight: Map<K, Promise<T>>,
  reason = new DOMException('La lectura compartida fue invalidada', 'AbortError')
) {
  for (const request of inflight.values()) {
    abortableSharedRequestLifecycles.get(request)?.controller.abort(reason)
  }
  detachSharedRequests(inflight)
}

export function getOrCreateSharedRequest<K, T>({
  inflight,
  key,
  createRequest,
  signal,
  abortWhenUnused = false
}: {
  inflight: Map<K, Promise<T>>;
  key: K;
  createRequest: (sharedSignal?: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  abortWhenUnused?: boolean;
}): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  let sharedRequest = inflight.get(key)
  let lifecycle = sharedRequest
    ? abortableSharedRequestLifecycles.get(sharedRequest)
    : undefined

  if (!sharedRequest) {
    const controller = abortWhenUnused ? new AbortController() : null
    const request = createRequest(controller?.signal)
    const trackedRequest = request.finally(() => {
      if (inflight.get(key) === trackedRequest) inflight.delete(key)
      if (lifecycle) lifecycle.settled = true
    })
    sharedRequest = trackedRequest
    inflight.set(key, trackedRequest)
    if (controller) {
      lifecycle = { controller, consumers: 0, settled: false }
      abortableSharedRequestLifecycles.set(trackedRequest, lifecycle)
    }
  }

  const releaseConsumer = () => {
    if (!lifecycle) return
    lifecycle.consumers = Math.max(0, lifecycle.consumers - 1)
    if (lifecycle.consumers === 0 && !lifecycle.settled) {
      lifecycle.controller.abort(new DOMException('La consulta quedó sin consumidores', 'AbortError'))
      if (inflight.get(key) === sharedRequest) inflight.delete(key)
    }
  }

  if (!signal) {
    if (!lifecycle) return sharedRequest
    lifecycle.consumers += 1
    return sharedRequest.finally(releaseConsumer)
  }
  if (lifecycle) lifecycle.consumers += 1

  return new Promise<T>((resolve, reject) => {
    let consumerFinished = false
    const finish = (callback: () => void) => {
      if (consumerFinished) return
      consumerFinished = true
      cleanup()
      releaseConsumer()
      callback()
    }
    const onAbort = () => finish(() => reject(abortReason(signal)))
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    // Cierra la carrera entre la comprobación previa y addEventListener().
    if (signal.aborted) {
      onAbort()
      return
    }
    sharedRequest.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    )
  })
}
