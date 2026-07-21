/**
 * Agrupa ejecuciones idénticas dentro del mismo proceso. Mientras una operación
 * sigue activa, todos los callers reciben la misma Promise y no arrancan otra.
 */
export function createSingleFlightRunner({ onDuplicate } = {}) {
  let activePromise = null

  const run = (operation) => {
    if (activePromise) {
      onDuplicate?.()
      return activePromise
    }
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('Single-flight requiere una función para ejecutar'))
    }

    const promise = Promise.resolve().then(operation)
    let wrappedPromise
    wrappedPromise = promise.finally(() => {
      if (activePromise === wrappedPromise) activePromise = null
    })
    activePromise = wrappedPromise
    return wrappedPromise
  }

  run.isRunning = () => activePromise !== null
  return run
}
