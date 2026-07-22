function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim()
}

function configuredOrigin() {
  for (const configured of [process.env.APP_URL, process.env.RENDER_EXTERNAL_URL]) {
    if (!configured) continue
    try {
      const url = new URL(String(configured).trim())
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
    } catch {
      // Se intenta la siguiente fuente; nunca se publica una URL malformada.
    }
  }
  return ''
}

export function resolveOAuthOrigin(req) {
  const canonical = configuredOrigin()
  if (canonical) return canonical

  if (process.env.NODE_ENV === 'production') {
    const error = new Error('OAuth MCP requiere APP_URL o RENDER_EXTERNAL_URL en producción.')
    error.code = 'oauth_origin_not_configured'
    throw error
  }

  const proto = firstForwardedValue(req?.get?.('x-forwarded-proto')) || req?.protocol || 'https'
  const host = firstForwardedValue(req?.get?.('x-forwarded-host')) || req?.get?.('host')
  if (!host) return ''
  try {
    const url = new URL(`${proto}://${host}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.origin
  } catch {
    return ''
  }
}

export function resolveMcpResource(req) {
  const origin = resolveOAuthOrigin(req)
  return origin ? `${origin}/api/mcp` : ''
}
