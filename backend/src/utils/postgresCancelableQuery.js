export function createDatabaseAbortError() {
  return Object.assign(new Error('La consulta a la base de datos fue cancelada'), {
    name: 'AbortError',
    code: 'ABORT_ERR'
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
  onCancelError
}) {
  if (signal?.aborted) throw createDatabaseAbortError()

  let abortRequested = false
  let cancellation = null
  const requestCancellation = () => {
    abortRequested = true
    if (!cancellation) {
      cancellation = Promise.resolve()
        .then(() => cancelBackend(client.processID))
        .catch((error) => {
          onCancelError?.(error)
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
