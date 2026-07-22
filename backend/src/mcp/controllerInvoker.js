import { EventEmitter } from 'node:events'

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value])
  )
}

/**
 * Ejecuta un controller HTTP existente sin abrir una segunda petición interna.
 *
 * El MCP comparte así las mismas validaciones y orquestación de dominio que la
 * interfaz, pero la autenticación/licencia/permisos se resuelve antes en el
 * registro central de herramientas. Este adaptador sólo modela req/res.
 */
export async function invokeController(handler, context = {}, request = {}) {
  if (typeof handler !== 'function') throw new Error('Controller MCP inválido')

  const baseUrl = String(context.baseUrl || '').replace(/\/$/, '')
  const parsedBaseUrl = baseUrl ? new URL(baseUrl) : null
  const headers = normalizeHeaders({
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': context.userAgent || 'Ristak-MCP',
    host: parsedBaseUrl?.host || '',
    ...(request.headers || {})
  })
  const response = new EventEmitter()
  let statusCode = 200
  let body
  let completed = false
  const responseHeaders = {}

  const finish = (payload) => {
    body = payload
    completed = true
    response.writableEnded = true
    response.headersSent = true
    return response
  }

  Object.assign(response, {
    statusCode,
    writableEnded: false,
    headersSent: false,
    status(code) {
      statusCode = Number(code) || 500
      this.statusCode = statusCode
      return this
    },
    json(payload) {
      return finish(payload)
    },
    send(payload) {
      return finish(payload)
    },
    end(payload) {
      return finish(payload)
    },
    set(name, value) {
      responseHeaders[String(name).toLowerCase()] = value
      return this
    },
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = value
    },
    getHeader(name) {
      return responseHeaders[String(name).toLowerCase()]
    },
    type(value) {
      responseHeaders['content-type'] = value
      return this
    },
    redirect(location) {
      this.status(302)
      responseHeaders.location = location
      return finish({ location })
    }
  })

  const req = {
    body: request.body || {},
    params: request.params || {},
    query: request.query || {},
    headers,
    user: context.user,
    license: context.license || null,
    mcpUser: context.mcpUser || null,
    method: request.method || 'GET',
    protocol: parsedBaseUrl?.protocol?.replace(':', '') || 'https',
    hostname: parsedBaseUrl?.hostname || '',
    originalUrl: request.originalUrl || '/api/mcp',
    baseUrl: request.baseUrl || '/api',
    ip: context.ip || '',
    app: context.app || null,
    get(name) {
      return headers[String(name || '').toLowerCase()]
    }
  }

  const returned = await handler(req, response)
  if (!completed && returned !== undefined && returned !== response) {
    finish(returned)
  }

  if (!completed) {
    throw new Error('La acción de Ristak no produjo una respuesta')
  }

  if (statusCode >= 400) {
    const error = new Error(
      body?.error || body?.message || `La acción de Ristak falló con estado ${statusCode}`
    )
    error.status = statusCode
    error.code = body?.code || 'ristak_action_failed'
    error.details = body
    throw error
  }

  return body
}
