import { logger } from '../utils/logger.js'
import { getVerifiedAppBaseUrl } from './sitesService.js'

/**
 * Cliente del license server central (ristak-installer).
 *
 * Conceptos:
 *  - Login local = identidad (users en la DB local).
 *  - Licencia central = permiso comercial (validada contra LICENSE_SERVER_URL).
 *  - Feature flags = funciones disponibles según el plan del cliente.
 *
 * La validación remota se cachea con un token temporal (LICENSE_TOKEN_TTL_HOURS,
 * el servidor central define la expiración real). Cuando expira se vuelve a validar.
 *
 * Política offline (LICENSE_OFFLINE_POLICY):
 *  - strict (default): si no se puede validar y no hay token temporal válido, se bloquea.
 *  - grace: si no se puede validar, se respeta el último estado permitido durante
 *    LICENSE_OFFLINE_GRACE_HOURS horas (default 24).
 */

const DEFAULT_FEATURES = {
  dashboard: true,
  contacts: true,
  chat: true,
  appointments: true,
  payments: true,
  reports: true,
  analytics: true,
  campaigns: true,
  sites: true,
  forms: true,
  ai_agent: true,
  automations: true,
  whatsapp: true,
  email: true,
  integrations: true,
  team_access: true,
  mobile_app: true,
  developers: true,
  premium_modules: true,
  meta_ads: true,
  google_calendar: true,
  ai: true,
  app_assistant_ai: true,
  conversational_ai: true,
  advanced_reports: true
}

// (LIC-003) Features de pago que el backend candaduea con requireFeature(...). Si el
// portal responde enforced 'allowed' pero SIN un objeto features válido, NO se abren
// éstas (fail-closed): la base del CRM sigue, el premium queda apagado hasta que el
// servidor envíe features explícitas.
const PREMIUM_GATED_FEATURES = [
  'whatsapp', 'email', 'meta_ads', 'google_calendar', 'automations',
  'advanced_reports', 'app_assistant_ai', 'conversational_ai', 'ai',
  'ai_agent', 'premium_modules'
]

function closedRemoteFeatures() {
  const closed = { ...DEFAULT_FEATURES }
  for (const key of PREMIUM_GATED_FEATURES) closed[key] = false
  return closed
}

const FEATURE_DEPENDENCIES = {
  appointments: ['google_calendar', 'settings_calendars'],
  payments: ['settings_payments'],
  reports: ['advanced_reports', 'settings_costs'],
  campaigns: ['meta_ads'],
  sites: ['settings_domains', 'settings_tracking', 'settings_media'],
  forms: ['settings_custom_fields'],
  ai_agent: ['app_assistant_ai', 'conversational_ai'],
  whatsapp: ['settings_whatsapp'],
  email: ['settings_email'],
  integrations: ['settings_integrations'],
  team_access: ['settings_users'],
  mobile_app: ['settings_mobile'],
  developers: ['settings_api_access']
}

const FEATURE_ALIAS_TO_CANONICAL = {
  google_calendar: 'appointments',
  settings_calendars: 'appointments',
  advanced_reports: 'reports',
  settings_costs: 'reports',
  meta_ads: 'campaigns',
  settings_domains: 'sites',
  settings_tracking: 'sites',
  settings_media: 'sites',
  settings_custom_fields: 'forms',
  app_assistant_ai: 'ai_agent',
  conversational_ai: 'ai_agent',
  ai: 'ai_agent',
  settings_whatsapp: 'whatsapp',
  settings_email: 'email',
  settings_payments: 'payments',
  settings_integrations: 'integrations',
  settings_users: 'team_access',
  settings_mobile: 'mobile_app',
  settings_api_access: 'developers'
}

function normalizeFeatureKey(key) {
  return FEATURE_ALIAS_TO_CANONICAL[key] || key
}

const hasOwn = Object.prototype.hasOwnProperty

// Estado cacheado de la última validación (token temporal de licencia)
let cachedState = null
let lastVerifiedEmail = null
let verifiedAppBaseUrlResolver = getVerifiedAppBaseUrl

function firstEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim()
    }
  }
  return ''
}

function getConfig() {
  return {
    licenseServerUrl: normalizeBaseUrl(firstEnv('LICENSE_SERVER_URL', 'RISTAK_LICENSE_SERVER_URL')),
    clientId: firstEnv('CLIENT_ID', 'RISTAK_CLIENT_ID'),
    licenseKey: firstEnv('LICENSE_KEY', 'RISTAK_LICENSE_KEY'),
    installationId: firstEnv('INSTALLATION_ID', 'RISTAK_INSTALLATION_ID'),
    appUrl: process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '',
    appVersion: process.env.APP_VERSION || '0.0.0',
    ownerEmail: process.env.OWNER_EMAIL || '',
    offlinePolicy: process.env.LICENSE_OFFLINE_POLICY === 'grace' ? 'grace' : 'strict',
    graceHours: Number(process.env.LICENSE_OFFLINE_GRACE_HOURS) > 0
      ? Number(process.env.LICENSE_OFFLINE_GRACE_HOURS)
      : 24,
    // (LIC-006) TTL del cache negativo (estado bloqueado). Evita re-verificar contra
    // el portal en cada request mientras la licencia esté bloqueada. Corto a propósito
    // para que un upgrade/reactivación se note rápido. Default 60s.
    blockedCacheSeconds: Number(process.env.LICENSE_BLOCKED_CACHE_SECONDS) > 0
      ? Number(process.env.LICENSE_BLOCKED_CACHE_SECONDS)
      : 60,
    // (LIC-008) Revalidación EN CALIENTE del estado positivo. Antes las features del
    // plan solo se capturaban al login y vivían hasta que expiraba el license_token
    // (expiresAt, controlado por el portal, típicamente horas), así que un cambio de
    // plan no se reflejaba sin re-login. Ahora, además de respetar expiresAt, el cache
    // positivo se revalida contra el portal cada N segundos (default 300 = 5 min). El
    // primer request tras vencer la ventana fuerza una verificación fresca y aplica el
    // nuevo plan sin cerrar sesión. Si el portal está inaccesible, handleServerUnreachable
    // conserva el último estado permitido (no rompe la operación).
    revalidateSeconds: Number(process.env.LICENSE_REVALIDATE_SECONDS) > 0
      ? Number(process.env.LICENSE_REVALIDATE_SECONDS)
      : 300
  }
}

// AUTH-007: hosts donde se permite http:// (desarrollo local). Las credenciales
// del dueño y la license_key viajan a esta URL base (verify, owner-credentials,
// setup-token, callLicenseServer), así que fuera de estos hosts NO debe salir en claro.
function isLocalHost(hostname = '') {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

function normalizeBaseUrl(value = '') {
  const clean = String(value || '').trim().replace(/\/+$/, '')
  if (!clean) return ''

  // AUTH-007: validar/endurecer el protocolo de la URL del portal central.
  // Si no trae protocolo explícito, asumimos https:// (no degradar a http).
  // Si trae http:// hacia un host remoto en producción, lo UPGRADEAMOS a https://
  // para que las credenciales del dueño nunca viajen en claro. Solo se permite
  // http:// para localhost/127.0.0.1/::1 (desarrollo local).
  try {
    const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)
    const parsed = new URL(hasProtocol ? clean : `https://${clean}`)

    if (!['http:', 'https:'].includes(parsed.protocol)) return ''

    if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
      const isProd = process.env.NODE_ENV === 'production'
      if (isProd) {
        // En producción nunca dejamos salir http a host remoto: upgrade a https.
        parsed.protocol = 'https:'
      }
      // En no-producción se respeta http remoto (entornos de prueba internos).
    }

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function normalizeAppBaseUrl(value = '') {
  const clean = normalizeBaseUrl(value)
  if (!clean) return ''

  try {
    const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function resolveManagedAppUrl(fallbackUrl = '') {
  try {
    const appBaseUrl = await verifiedAppBaseUrlResolver()
    if (appBaseUrl) return appBaseUrl
  } catch (error) {
    logger.warn(`No se pudo resolver dominio de app verificado: ${error.message}`)
  }

  return normalizeBaseUrl(fallbackUrl)
}

async function buildInstalledAppPayload(extra = {}) {
  const config = getConfig()
  return {
    client_id: config.clientId,
    license_key: config.licenseKey,
    installation_id: config.installationId,
    app_url: await resolveManagedAppUrl(config.appUrl),
    ...extra
  }
}

/**
 * La licencia solo se exige cuando la app fue instalada por el portal central
 * (tiene servidor central + cliente + licencia). En desarrollo local o
 * instalaciones standalone la app funciona sin license server. El Installer
 * puede publicar esos datos como LICENSE_* o como RISTAK_*.
 */
export function isLicenseEnforced() {
  const config = getConfig()
  return !!(config.licenseServerUrl && config.clientId && config.licenseKey)
}

async function callLicenseServer(path, body = {}) {
  const config = getConfig()

  if (!isLicenseEnforced()) {
    throw new Error('Esta instalación no está conectada al portal central.')
  }

  let response, data
  try {
    response = await fetch(`${config.licenseServerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await buildInstalledAppPayload(body))
    })
    data = await response.json().catch(() => ({}))
  } catch (error) {
    logger.error(`No se pudo contactar al portal central: ${error.message}`)
    throw new Error('No se pudo contactar al portal central. Intenta de nuevo en unos minutos.')
  }

  if (!response.ok || data?.success === false) {
    const message = data?.message || data?.error || 'El portal central rechazó la solicitud.'
    throw new Error(message)
  }

  return data || {}
}

/**
 * Avisa al portal central que los usuarios de esta instalación cambiaron, para
 * que vuelva a leerlos y el login móvil pueda enrutar a cualquier usuario
 * (dueño o empleado) por su correo.
 *
 * (AUTH-009) Antes era best-effort de un solo intento: si el portal fallaba con un
 * error transitorio, el empleado recién creado NO podía loguear en la app móvil
 * hasta el siguiente ciclo de refresh. Ahora el refresh se completa con await y
 * reintenta de forma acotada (hasta 3 intentos con backoff corto) ante fallos
 * transitorios, de modo que el portal queda actualizado de inmediato. Sigue sin
 * lanzar: si tras agotar los reintentos no se logra, se loguea como error pero no
 * rompe la operación que lo disparó (creación de empleado, etc.).
 */
export async function requestPortalUserRefresh() {
  if (!isLicenseEnforced()) return

  // (AUTH-009) Reintento acotado con backoff corto para fallos transitorios del portal.
  const maxAttempts = 3
  const baseBackoffMs = 300

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await callLicenseServer('/api/license/users/refresh', {})
      return
    } catch (error) {
      // (AUTH-009) Si aún quedan intentos, esperamos un backoff creciente y reintentamos.
      if (attempt < maxAttempts) {
        logger.warn(`No se pudo refrescar el directorio de usuarios en el portal (intento ${attempt}/${maxAttempts}): ${error.message}. Reintentando...`)
        const delayMs = baseBackoffMs * attempt
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      // (AUTH-009) Agotados los reintentos: registramos como error (no como warn) pero no
      // lanzamos, para no romper la operación que disparó el refresh.
      logger.error(`No se pudo refrescar el directorio de usuarios en el portal tras ${maxAttempts} intentos: ${error.message}`)
    }
  }
}

export function getHealthInfo() {
  const config = getConfig()
  return {
    ok: true,
    app: 'ristak',
    version: config.appVersion,
    client_id: config.clientId || null,
    installation_id: config.installationId || null
  }
}

/** Solo para tests */
export function resetLicenseCache() {
  cachedState = null
  lastVerifiedEmail = null
}

export function setVerifiedAppBaseUrlResolverForTests(resolver = getVerifiedAppBaseUrl) {
  verifiedAppBaseUrlResolver = typeof resolver === 'function' ? resolver : getVerifiedAppBaseUrl
}

function allowedWithoutEnforcement() {
  return {
    allowed: true,
    enforced: false,
    plan: null,
    features: { ...DEFAULT_FEATURES },
    expiresAt: null
  }
}

function normalizeLicenseFeatures(features = {}) {
  const source = features && typeof features === 'object' ? features : {}
  const normalized = {
    ...DEFAULT_FEATURES,
    ...source
  }

  for (const [alias, canonical] of Object.entries(FEATURE_ALIAS_TO_CANONICAL)) {
    if (source[canonical] !== undefined || source[alias] === undefined) continue
    normalized[canonical] = !!source[alias]
  }

  for (const [featureKey, dependencies] of Object.entries(FEATURE_DEPENDENCIES)) {
    if (normalized[featureKey] === undefined) continue
    const hasExplicitFeature = hasOwn.call(source, featureKey)
    const explicitDependencies = dependencies.filter((dependency) => hasOwn.call(source, dependency))
    if (!hasExplicitFeature && explicitDependencies.length) {
      normalized[featureKey] = explicitDependencies.every((dependency) => source[dependency] === true)
    }
    for (const dependency of dependencies) {
      // (LIC-004) Una sub-feature enviada explícitamente por el portal SIEMPRE gana,
      // aunque el padre esté en true. Antes el padre pisaba la sub-feature, así que un
      // downgrade parcial ({reports:true, advanced_reports:false}) dejaba la sub-feature
      // encendida. Solo cuando el padre es false la apagamos (no puede haber hijo activo
      // sin su padre); y solo derivamos del padre cuando la sub-feature NO vino explícita.
      if (hasOwn.call(source, dependency)) {
        normalized[dependency] = source[dependency] === true && normalized[featureKey] === true
      } else {
        normalized[dependency] = normalized[featureKey] === true
      }
    }
  }

  normalized.ai = normalized.ai_agent === true

  return normalized
}

function cacheIsValid() {
  return !!(cachedState && cachedState.allowed && cachedState.expiresAt && new Date(cachedState.expiresAt).getTime() > Date.now())
}

// (LIC-008) El cache positivo es "fresco" (reutilizable sin pegarle al portal) solo si
// además de tener un license_token vigente (cacheIsValid) no se venció su ventana corta
// de revalidación. Cuando la ventana vence, getLicenseState revalida contra el portal
// para reflejar cambios de plan en caliente. Si nunca se marcó revalidateAfter (estados
// viejos en cache), se trata como fresco para no romper el comportamiento previo.
function cacheIsFresh() {
  if (!cacheIsValid()) return false
  if (!cachedState.revalidateAfter) return true
  return cachedState.revalidateAfter > Date.now()
}

// (LIC-006) Cache negativo: el estado bloqueado es válido mientras no expire su TTL
// corto. Así dejamos de martillar el portal en cada request cuando la licencia está
// bloqueada, sin volver el bloqueo permanente.
function blockedCacheIsValid() {
  return !!(cachedState && cachedState.allowed === false && cachedState.blockedUntil && cachedState.blockedUntil > Date.now())
}

// (LIC-007) El cache es un singleton por proceso compartido entre usuarios. Para no
// servir un veredicto calculado contra otro email, solo reutilizamos el cache cuando
// la verificación corresponde al mismo email solicitado (o no se pidió uno explícito).
function cacheMatchesEmail(email) {
  if (!email) return true
  return lastVerifiedEmail === email
}

/**
 * Llama al license server central. Devuelve el estado de licencia y lo cachea.
 * @param {string} email - email del usuario que está iniciando sesión
 */
export async function verifyLicenseWithServer(email) {
  const config = getConfig()

  if (!isLicenseEnforced()) {
    return allowedWithoutEnforcement()
  }

  const targetEmail = email || lastVerifiedEmail || config.ownerEmail

  let response, data
  try {
    response = await fetch(`${config.licenseServerUrl}/api/license/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        license_key: config.licenseKey,
        installation_id: config.installationId,
        email: targetEmail,
        app_url: await resolveManagedAppUrl(config.appUrl),
        version: config.appVersion
      })
    })
    data = await response.json()
  } catch (error) {
    logger.error(`No se pudo contactar al servidor de licencias: ${error.message}`)
    return handleServerUnreachable()
  }

  if (data && data.allowed) {
    // (LIC-003) Fail-closed: solo confiamos en un objeto features no vacío. Una
    // respuesta 'allowed' sin features es un error del portal y NO debe abrir premium.
    const hasValidFeatures = data.features && typeof data.features === 'object' && Object.keys(data.features).length > 0
    if (!hasValidFeatures) {
      logger.warn('[Licencia] El servidor respondió allowed sin un objeto "features" válido: se aplican features mínimas (premium apagado).')
    }
    cachedState = {
      allowed: true,
      enforced: true,
      plan: data.plan || null,
      features: hasValidFeatures ? normalizeLicenseFeatures(data.features) : closedRemoteFeatures(),
      licenseToken: data.license_token || null,
      expiresAt: data.expires_at || null,
      verifiedAt: new Date().toISOString(),
      // (LIC-008) Marca hasta cuándo el cache positivo se considera "fresco". Aunque el
      // license_token siga vigente (expiresAt en horas), pasada esta ventana corta el
      // siguiente getLicenseState revalida contra el portal y aplica cambios de plan en
      // caliente, sin re-login.
      revalidateAfter: Date.now() + config.revalidateSeconds * 1000
    }
    lastVerifiedEmail = targetEmail
    return cachedState
  }

  // Respuesta válida del servidor pero bloqueada: invalidar cualquier cache positivo.
  // (LIC-006) Cacheamos el estado bloqueado por un TTL corto (blockedUntil) para no
  // re-verificar contra el portal en cada request mientras la licencia siga bloqueada.
  cachedState = {
    allowed: false,
    enforced: true,
    reason: data?.reason || 'license_blocked',
    message: data?.message || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.',
    expiresAt: null,
    verifiedAt: new Date().toISOString(),
    blockedUntil: Date.now() + config.blockedCacheSeconds * 1000
  }
  lastVerifiedEmail = targetEmail
  return cachedState
}

function handleServerUnreachable() {
  const config = getConfig()

  // Si hay un token temporal vigente, se sigue permitiendo el acceso
  if (cacheIsValid()) {
    return cachedState
  }

  if (config.offlinePolicy === 'grace' && cachedState?.allowed && cachedState.verifiedAt) {
    const graceLimit = new Date(cachedState.verifiedAt).getTime() + config.graceHours * 60 * 60 * 1000
    if (Date.now() < graceLimit) {
      logger.warn('Servidor de licencias inaccesible: acceso permitido por política de gracia')
      return cachedState
    }
  }

  // Modo estricto: sin validación posible y sin token vigente, se bloquea
  return {
    allowed: false,
    enforced: true,
    reason: 'license_server_unreachable',
    message: 'No se pudo validar tu licencia de Ristak. Intenta de nuevo en unos minutos o contacta al administrador.',
    expiresAt: null
  }
}

/**
 * Estado de licencia para proteger requests. Usa el token temporal cacheado
 * y solo consulta al servidor central cuando expiró.
 */
export async function getLicenseState({ email = null, forceRefresh = false } = {}) {
  if (!isLicenseEnforced()) {
    return allowedWithoutEnforcement()
  }

  // (LIC-007) Solo reutilizamos el cache (positivo o negativo) cuando corresponde al
  // mismo email solicitado; un email distinto fuerza re-verificación para no servir el
  // veredicto de otro usuario desde este singleton compartido.
  if (!forceRefresh && cacheMatchesEmail(email)) {
    // (LIC-008) Reutilizamos el cache positivo solo mientras siga "fresco": con
    // license_token vigente Y dentro de su ventana corta de revalidación. Al vencer la
    // ventana caemos a verifyLicenseWithServer para reflejar cambios de plan en caliente
    // (si el portal está caído, handleServerUnreachable conserva el último estado).
    if (cacheIsFresh()) {
      return cachedState
    }
    // (LIC-006) Reutiliza el bloqueo cacheado por su TTL corto en vez de re-verificar
    // en cada request mientras la licencia siga bloqueada.
    if (blockedCacheIsValid()) {
      return cachedState
    }
  }

  return verifyLicenseWithServer(email)
}

/**
 * Indica si una feature está habilitada según la última validación de licencia.
 */
export async function hasFeature(featureKey) {
  const state = await getLicenseState()
  if (!state.allowed) return false
  if (!state.enforced) return true
  return !!state.features?.[featureKey] || !!state.features?.[normalizeFeatureKey(featureKey)]
}

/**
 * (LIC-009) Gate de licencia/feature pensado para el runtime de fondo (crons,
 * workers) que no pasa por los middlewares HTTP. Devuelve true cuando la app puede
 * ejecutar el trabajo: o no hay enforcement, o la licencia está activa y —si se pide
 * una feature— está incluida en el plan. Usa el cache temporal (incluido el cache
 * negativo de LIC-006) para no martillar al portal en cada tick del cron.
 *
 * Uso sugerido en un cron:
 *   if (!(await canRunBackgroundJob('meta_ads'))) return
 */
export async function canRunBackgroundJob(featureKey = null) {
  if (!isLicenseEnforced()) return true

  const state = await getLicenseState()
  if (!state.allowed) return false
  if (!state.enforced) return true
  if (!featureKey) return true

  return !!state.features?.[featureKey] || !!state.features?.[normalizeFeatureKey(featureKey)]
}

export async function createCentralGoogleCalendarConnectUrl({ returnPath = '/settings/calendars/google', appUrl = '' } = {}) {
  const payload = {
    return_path: returnPath
  }

  const normalizedAppUrl = normalizeAppBaseUrl(appUrl)
  if (normalizedAppUrl) {
    payload.app_url = normalizedAppUrl
  }

  const data = await callLicenseServer('/api/license/google-calendar/connect-url', payload)
  return {
    url: data.url || '',
    mode: data.mode || 'calendar',
    redirectUri: data.redirect_uri || data.redirectUri || ''
  }
}

export async function createCentralGoogleLoginUrl({ returnPath = '/dashboard' } = {}) {
  const data = await callLicenseServer('/api/auth/google/start', {
    mode: 'login',
    return_path: returnPath
  })
  return {
    url: data.url || '',
    mode: data.mode || 'login',
    redirectUri: data.redirect_uri || data.redirectUri || ''
  }
}

export async function disconnectCentralGoogleCalendar() {
  const data = await callLicenseServer('/api/license/google-calendar/disconnect')
  return data.calendar || {}
}

export async function claimCentralOAuthHandoff({ provider, handoffToken } = {}) {
  const data = await callLicenseServer('/api/license/oauth-handoff/claim', {
    provider,
    handoff_token: handoffToken
  })
  return data.handoff || {}
}

export async function refreshCentralGoogleCalendarToken({ refreshToken } = {}) {
  const data = await callLicenseServer('/api/license/google-calendar/refresh-token', {
    refresh_token: refreshToken
  })
  return data.token || {}
}

export async function createCentralStripeConnectUrl({ mode = 'test', returnPath = '/settings/payments/stripe', appUrl = '' } = {}) {
  const payload = {
    mode: mode === 'live' ? 'live' : 'test',
    return_path: returnPath
  }

  if (appUrl) {
    payload.app_url = appUrl
  }

  const data = await callLicenseServer('/api/license/stripe-connect/connect-url', payload)
  return {
    url: data.url || '',
    mode: data.mode === 'live' ? 'live' : 'test',
    redirectUri: data.redirect_uri || data.redirectUri || '',
    webhookUrl: data.webhook_url || data.webhookUrl || '',
    scope: data.scope || 'read_write',
    managedByPortal: true
  }
}

export async function disconnectCentralStripeConnect() {
  const data = await callLicenseServer('/api/license/stripe-connect/disconnect')
  return data.connection || {}
}

export async function createCentralMercadoPagoConnectUrl({ mode = 'test', returnPath = '/settings/payments/mercadopago', appUrl = '' } = {}) {
  const payload = {
    mode: mode === 'live' ? 'live' : 'test',
    return_path: returnPath
  }

  if (appUrl) {
    payload.app_url = appUrl
  }

  const data = await callLicenseServer('/api/license/mercadopago/connect-url', payload)
  return {
    url: data.url || '',
    mode: data.mode === 'live' ? 'live' : 'test',
    redirectUri: data.redirect_uri || data.redirectUri || '',
    webhookUrl: data.webhook_url || data.webhookUrl || '',
    managedByPortal: true
  }
}

export async function disconnectCentralMercadoPago() {
  const data = await callLicenseServer('/api/license/mercadopago/disconnect')
  return data.connection || {}
}

export async function refreshCentralMercadoPagoToken({ mode = 'test', refreshToken } = {}) {
  const data = await callLicenseServer('/api/license/mercadopago/refresh-token', {
    mode: mode === 'live' ? 'live' : 'test',
    refresh_token: refreshToken
  })
  return data.token || {}
}

/**
 * Verifica las credenciales del dueño contra el portal central. El portal es la
 * fuente de verdad: si el admin asignó una nueva contraseña allá, la app la
 * acepta y devuelve el hash vigente para actualizar la copia local.
 */
export async function verifyOwnerCredentialsWithServer(email, password) {
  const config = getConfig()

  if (!isLicenseEnforced() || !email || !password) {
    return { valid: false }
  }

  try {
    const response = await fetch(`${config.licenseServerUrl}/api/owner-credentials/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        license_key: config.licenseKey,
        installation_id: config.installationId,
        email,
        password
      })
    })
    const data = await response.json()
    return data || { valid: false }
  } catch (error) {
    logger.error(`No se pudo verificar credenciales con el servidor central: ${error.message}`)
    return { valid: false }
  }
}

/**
 * Valida un setup token contra el servidor central sin consumirlo.
 */
export async function verifySetupToken(token) {
  return callSetupTokenEndpoint('verify', token)
}

/**
 * Consume un setup token (un solo uso) contra el servidor central.
 */
export async function consumeSetupToken(token) {
  return callSetupTokenEndpoint('consume', token)
}

async function callSetupTokenEndpoint(action, token) {
  const config = getConfig()

  if (!config.licenseServerUrl) {
    return { valid: false, message: 'Esta instalación no tiene servidor central configurado.' }
  }

  try {
    const response = await fetch(`${config.licenseServerUrl}/api/setup-token/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        installation_id: config.installationId
      })
    })
    const data = await response.json()
    return data || { valid: false }
  } catch (error) {
    logger.error(`No se pudo validar el setup token: ${error.message}`)
    return { valid: false, message: 'No se pudo validar el enlace de configuración. Intenta de nuevo.' }
  }
}
