const POSTGRES_CONNECT_RETRY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  '08001',
  '08006',
  '53300',
  '57P03'
])

const POSTGRES_TRANSIENT_CONNECTION_MESSAGES = [
  'connection terminated unexpectedly',
  'connection terminated',
  'connection ended unexpectedly',
  'connection closed unexpectedly',
  'client has encountered a connection error',
  'connection is not queryable',
  'terminating connection',
  // pg-pool no adjunta un code cuando vence connectionTimeoutMillis mientras
  // espera o abre un cliente. Sin este texto, connectWithRetry no reintenta.
  'timeout exceeded when trying to connect'
]

export function isTransientPostgresConnectionError(error) {
  const code = String(error?.code || '').trim()
  if (POSTGRES_CONNECT_RETRY_CODES.has(code)) return true

  const message = String(error?.message || '').toLowerCase()
  return POSTGRES_TRANSIENT_CONNECTION_MESSAGES.some(pattern => message.includes(pattern))
}
