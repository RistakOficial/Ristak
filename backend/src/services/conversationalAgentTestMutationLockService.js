import { db } from '../config/database.js'

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max)
}

function lockError(message, code = 'test_mutation_lock_busy', statusCode = 409, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  error.status = statusCode
  error.statusCode = statusCode
  return error
}

/**
 * Serializa, entre todas las instancias, cambios de capabilities y efectos
 * externos del Modo test para un mismo agente.
 *
 * PostgreSQL sostiene un advisory lock de sesión en una conexión dedicada.
 * SQLite sostiene BEGIN IMMEDIATE durante el callback como fallback local
 * multiproceso. No hay TTL: el candado dura exactamente lo que dura la sesión
 * física y el motor lo libera si el proceso/conexión muere.
 */
export async function withConversationalAgentTestMutationLock({
  agentId,
  purpose
} = {}, operation) {
  const cleanAgentId = clean(agentId, 180)
  const cleanPurpose = clean(purpose, 240)
  if (!cleanAgentId || !cleanPurpose) {
    throw lockError('Falta la identidad del candado de prueba.', 'test_mutation_lock_identity', 400)
  }
  if (typeof operation !== 'function') {
    throw lockError('Falta la operación protegida por el candado de prueba.', 'test_mutation_lock_callback', 500)
  }

  try {
    return await db.withAdvisoryLock(
      `conversational-agent-test:${cleanAgentId}`,
      operation
    )
  } catch (error) {
    if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
      throw lockError(
        'Hay una acción de prueba terminando en este momento. Espera unos segundos y vuelve a guardar o probar.',
        'test_mutation_lock_busy',
        409,
        error
      )
    }
    throw error
  }
}
