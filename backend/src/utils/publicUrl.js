function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value
  return cleanString(raw).split(',').map(item => item.trim()).filter(Boolean)[0] || ''
}

export function normalizeBaseUrl(value = '') {
  return cleanString(value).replace(/\/+$/, '')
}

export function normalizePublicHost(value = '') {
  const cleanValue = cleanString(value)
  if (!cleanValue) return ''

  try {
    return new URL(cleanValue.includes('://') ? cleanValue : `https://${cleanValue}`).host
  } catch {
    return cleanValue.replace(/^https?:\/\//i, '').split('/')[0].replace(/\/+$/, '')
  }
}

export function isLoopbackHost(value = '') {
  const host = normalizePublicHost(value).replace(/^\[/, '').replace(/\]$/, '').split(':')[0].toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')
}

export function getRequestBaseUrl(req) {
  const forwardedHost = firstHeaderValue(req?.headers?.['x-forwarded-host'] || req?.get?.('x-forwarded-host'))
  const host = normalizePublicHost(forwardedHost || req?.get?.('host') || req?.headers?.host)
  if (!host) return ''

  const forwardedProto = firstHeaderValue(req?.headers?.['x-forwarded-proto'] || req?.get?.('x-forwarded-proto'))
  const protocol = cleanString(forwardedProto || req?.protocol) || (isLoopbackHost(host) ? 'http' : 'https')
  return normalizeBaseUrl(`${protocol}://${host}`)
}

export function resolvePublicServiceBaseUrl(req, fallbackValues = []) {
  const requestBaseUrl = getRequestBaseUrl(req)
  if (requestBaseUrl && !isLoopbackHost(requestBaseUrl)) return requestBaseUrl

  for (const value of fallbackValues) {
    const normalized = normalizeBaseUrl(value)
    if (normalized) return normalized
  }

  return requestBaseUrl
}

export function resolvePublicServiceHost(req, fallbackValues = []) {
  return normalizePublicHost(resolvePublicServiceBaseUrl(req, fallbackValues))
}
