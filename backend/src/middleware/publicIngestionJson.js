import express from 'express'

const PUBLIC_INGESTION_ENDPOINTS = Object.freeze({
  '/api/sites/public/form-progress': {
    limit: '64kb',
    codePrefix: 'PUBLIC_FORM_PROGRESS',
    label: 'El avance del formulario'
  },
  '/collect': {
    limit: '50kb',
    codePrefix: 'PUBLIC_TRACKING_COLLECT',
    label: 'El evento de tracking'
  },
  '/api/tracking/collect': {
    limit: '50kb',
    codePrefix: 'PUBLIC_TRACKING_COLLECT',
    label: 'El evento de tracking'
  }
})

const parsers = new Map(
  Object.values(PUBLIC_INGESTION_ENDPOINTS).map(config => [
    config.limit,
    express.json({
      inflate: false,
      limit: config.limit,
      strict: true,
      type: 'application/json'
    })
  ])
)

function normalizedPath(req) {
  return String(req.path || req.url || '')
    .split('?', 1)[0]
    .replace(/\/+$/, '') || '/'
}

function sendJsonParserError(res, config, error) {
  if (
    error?.type === 'entity.too.large' ||
    error?.status === 413 ||
    error?.statusCode === 413
  ) {
    return res.status(413).json({
      success: false,
      code: `${config.codePrefix}_BODY_TOO_LARGE`,
      error: `${config.label} supera el límite permitido de ${config.limit.toUpperCase()}.`
    })
  }

  if (
    error?.type === 'encoding.unsupported' ||
    error?.status === 415 ||
    error?.statusCode === 415
  ) {
    return res.status(415).json({
      success: false,
      code: `${config.codePrefix}_ENCODING_UNSUPPORTED`,
      error: `${config.label} no acepta cuerpos comprimidos.`
    })
  }

  if (
    error instanceof SyntaxError ||
    error?.type === 'entity.parse.failed'
  ) {
    return res.status(400).json({
      success: false,
      code: `${config.codePrefix}_JSON_INVALID`,
      error: `${config.label} requiere un objeto JSON válido.`
    })
  }

  return null
}

/**
 * Parseo acotado para las dos ingestiones públicas de mayor tráfico. Se monta
 * antes del express.json global de 35 MB y deliberadamente no conserva rawBody:
 * ninguna de estas rutas verifica una firma sobre el cuerpo crudo.
 */
export function publicIngestionJsonMiddleware(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next()

  const config = PUBLIC_INGESTION_ENDPOINTS[normalizedPath(req)]
  if (!config) return next()

  if (!req.is('application/json')) {
    return res.status(415).json({
      success: false,
      code: `${config.codePrefix}_JSON_REQUIRED`,
      error: `${config.label} requiere Content-Type: application/json.`
    })
  }

  const parser = parsers.get(config.limit)
  return parser(req, res, (error) => {
    if (!error) return next()
    return sendJsonParserError(res, config, error) || next(error)
  })
}

export const PUBLIC_INGESTION_JSON_LIMITS = Object.freeze({
  formProgress: 64 * 1024,
  collect: 50 * 1024
})
