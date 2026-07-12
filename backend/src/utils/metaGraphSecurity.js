const META_SECRET_QUERY_KEYS = [
  'access_token',
  'input_token',
  'appsecret_proof',
  'client_secret',
  'fb_exchange_token',
  'code'
]

const META_SECRET_QUERY_PATTERN = new RegExp(
  `([?&](?:${META_SECRET_QUERY_KEYS.join('|')})=)[^&#\\s]*`,
  'gi'
)

const META_SECRET_JSON_PATTERN = new RegExp(
  `(["'](?:${META_SECRET_QUERY_KEYS.join('|')})["']\\s*:\\s*["'])[^"']*`,
  'gi'
)

export function redactMetaGraphSecrets(value = '') {
  return String(value || '')
    .replace(META_SECRET_QUERY_PATTERN, '$1[REDACTED]')
    .replace(META_SECRET_JSON_PATTERN, '$1[REDACTED]')
}

export function safeMetaGraphTransportError(error, fallback = 'No se pudo contactar Meta Graph.') {
  const message = String(error?.message || '')
  if (!message) return fallback
  if (/\brequest to https?:\/\//i.test(message) || /\bfetch failed\b/i.test(message)) return fallback
  const redacted = redactMetaGraphSecrets(message)
  return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted
}

export function describeMetaCapiResponseError(payload = {}, status = 0) {
  const graphError = payload?.error || {}
  const message = safeMetaGraphTransportError(
    { message: graphError?.message || `Meta CAPI ${Number(status) || 'error'}` },
    `Meta CAPI ${Number(status) || 'error'}`
  )
  const permissionDenied = [10, 190, 200].includes(Number(graphError?.code)) ||
    [401, 403].includes(Number(status)) ||
    /permission|access|authorized|autoriz|dataset/i.test(message)
  return permissionDenied
    ? `Meta rechazó el envío. Amplía el acceso al Dataset seleccionado y vuelve a autorizar Meta Ads. (${message})`
    : message
}
