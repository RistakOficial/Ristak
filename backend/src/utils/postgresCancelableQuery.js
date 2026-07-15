export function createDatabaseAbortError() {
  return Object.assign(new Error('La consulta a la base de datos fue cancelada'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  })
}

/**
 * Espera una conexion del pool sin ignorar que el request ya fue abandonado.
 * `pg.Pool` no permite retirar un waiter de su cola; si la conexion llega tarde,
 * se libera de inmediato para no filtrarla ni ejecutar trabajo huérfano.
 */
export function acquireAbortablePostgresClient({ pool, signal, onLateReleaseError }) {
  if (signal?.aborted) return Promise.reject(createDatabaseAbortError())

  let pendingClient
  try {
    pendingClient = pool.connect()
  } catch (error) {
    return Promise.reject(error)
  }
  if (!signal) return pendingClient

  return new Promise((resolve, reject) => {
    let finished = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (finished) return
      finished = true
      cleanup()
      reject(createDatabaseAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    Promise.resolve(pendingClient).then(
      client => {
        if (finished) {
          try {
            client.release()
          } catch (error) {
            onLateReleaseError?.(error)
          }
          return
        }
        finished = true
        cleanup()
        resolve(client)
      },
      error => {
        if (finished) return
        finished = true
        cleanup()
        reject(error)
      }
    )
  })
}

export function waitForDatabaseRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(createDatabaseAbortError())
  if (!signal) return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))

  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer)
      cleanup()
      reject(createDatabaseAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      timer = null
      cleanup()
      resolve()
    }, Math.max(0, ms))
  })
}

/**
 * Ejecuta una consulta y, si el consumidor desaparece, cancela el backend de
 * PostgreSQL antes de permitir que la conexion vuelva al pool.
 *
 * `cancelBackend` debe usar un canal separado del pool de trabajo. Esperar su
 * resultado evita dos fallas bajo carga: deadlock cuando todo el pool esta
 * ocupado y cancelar por accidente la siguiente consulta que reutilice el PID.
 */
export async function runCancelablePostgresQuery({
  client,
  sql,
  params = [],
  signal,
  cancelBackend,
  onCancelError,
  destroyClient
}) {
  if (signal?.aborted) throw createDatabaseAbortError()

  let abortRequested = false
  let cancellation = null
  const requestCancellation = () => {
    abortRequested = true
    if (!cancellation) {
      cancellation = Promise.resolve()
        .then(() => cancelBackend(client.processID))
        .catch(async (error) => {
          onCancelError?.(error)
          // Si el canal reservado también falló, esperar `client.query()` deja
          // vivo exactamente el scan que el deadline debía cortar. Destruir la
          // conexión de trabajo es el último recurso seguro: el pool la
          // reemplaza y el query pendiente rechaza en vez de quedar huérfano.
          try {
            await destroyClient?.(error)
          } catch (destroyError) {
            onCancelError?.(destroyError)
          }
          return null
        })
    }
  }
  signal?.addEventListener('abort', requestCancellation, { once: true })

  try {
    const result = await client.query(sql, params)
    if (abortRequested || signal?.aborted) throw createDatabaseAbortError()
    return result
  } catch (error) {
    if (abortRequested || signal?.aborted) throw createDatabaseAbortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', requestCancellation)
    // No se libera/reutiliza el client hasta saber que el paquete de
    // cancelacion ya fue procesado por PostgreSQL.
    if (cancellation) await cancellation
  }
}
