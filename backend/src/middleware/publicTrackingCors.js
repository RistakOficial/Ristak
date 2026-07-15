import cors from 'cors'

const PUBLIC_TRACKING_METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS']
const PUBLIC_TRACKING_ALLOWED_HEADERS = ['Content-Type']
const PUBLIC_TRACKING_PATHS = new Set([
  '/snip.js',
  '/meta-param-builder.js',
  '/meta-param-builder-ip',
  '/collect',
  '/video-event',
  '/sync-visitor',
  '/link-visitor'
])

export function isPublicTrackingBrowserOrigin(origin) {
  if (!origin) return true

  try {
    const parsed = new URL(String(origin).trim())
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

// El pixel se ejecuta en la pagina del negocio, no en el host que sirve snip.js.
// Por eso www.ejemplo.com -> track.ejemplo.com siempre es cross-origin aunque
// ambos compartan dominio raiz. Estas rutas son publicas por contrato y no usan
// cookies/sesion de Ristak; el CORS privado global de la app permanece intacto.
export const publicTrackingCors = cors({
  origin: (origin, callback) => {
    callback(null, isPublicTrackingBrowserOrigin(origin))
  },
  credentials: false,
  methods: PUBLIC_TRACKING_METHODS,
  allowedHeaders: PUBLIC_TRACKING_ALLOWED_HEADERS,
  maxAge: 24 * 60 * 60,
  optionsSuccessStatus: 204
})

export function isPublicTrackingCorsPath(pathname) {
  const normalized = String(pathname || '').trim().replace(/\/+$/, '') || '/'
  return PUBLIC_TRACKING_PATHS.has(normalized)
}

// publicTrackingRoutes también se monta bajo /api/tracking antes de sus rutas
// privadas. Acotamos por path exacto para que /sessions, /analytics, etc. nunca
// hereden el CORS público al continuar hacia el router autenticado.
export function publicTrackingCorsMiddleware(req, res, next) {
  if (!isPublicTrackingCorsPath(req.path)) return next()
  return publicTrackingCors(req, res, next)
}

export default publicTrackingCorsMiddleware
