import { logger } from '../utils/logger.js'
import { getVerifiedAppBaseUrl } from './sitesService.js'
import {
  getStoredCentralBrokerConfig,
  resolveCentralBrokerConfig
} from './centralBrokerService.js'

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

const DEFAULT_EXTERNAL_MODULES = {}

const DEFAULT_LIMITS = {
  conversational_agents: {
    max_agents: null
  }
}

const CALENDAR_PAYMENT_FEATURE_KEYS = [
  'calendar_payments',
  'calendar_payment',
  'calendar_booking_payments'
]

const PROFESSIONAL_PLAN_KEYS = new Set([
  'pro',
  'professional',
  'profesional',
  'premium'
])

// Todo cobro que depende de una pasarela es exclusivo de Profesional. La lista
// vive aquí también (además del Installer) para que una licencia vieja, parcial
// o con overrides heredados no reactive movimiento de dinero online.
const PROFESSIONAL_ONLY_PAYMENT_FEATURE_KEYS = new Set([
  'payment_checkout',
  'payment_automations',
  'payment_gateways',
  'highlevel_payments',
  'conekta',
  'mercadopago',
  'rebill',
  'payment_links',
  'saved_payment_methods',
  'payment_plans',
  'subscriptions',
  'payment_webhooks'
])

// (LIC-003) Features de pago que el backend bloquea con requireFeature(...). Si el
// portal responde enforced 'allowed' pero SIN un objeto features válido, NO se abren
// éstas (fail-closed): la base del CRM sigue, el premium queda apagado hasta que el
// servidor envíe features explícitas.
const PREMIUM_GATED_FEATURES = [
  'payments', 'reports', 'campaigns', 'sites', 'forms', 'whatsapp',
  'email', 'integrations', 'team_access', 'mobile_app', 'developers',
  'meta_ads', 'google_calendar', 'automations', 'advanced_reports',
  'app_assistant_ai', 'conversational_ai', 'ai', 'ai_agent',
  'premium_modules', 'payment_checkout', 'payment_automations',
  'payment_gateways', 'highlevel_payments', 'conekta', 'mercadopago',
  'rebill', 'payment_links', 'saved_payment_methods', 'payment_plans',
  'subscriptions', 'payment_webhooks', 'web_analytics'
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
  forms: [],
  ai_agent: ['app_assistant_ai', 'conversational_ai'],
  whatsapp: ['settings_whatsapp'],
  email: ['settings_email'],
  integrations: ['settings_integrations'],
  team_access: ['settings_users'],
  mobile_app: ['settings_mobile'],
  developers: ['settings_api_access']
}

const LICENSE_FEATURES_BY_MODULE = {
  dashboard: { primary: 'dashboard' },
  contacts: { primary: 'contacts' },
  chat: { primary: 'chat', legacy: ['whatsapp'] },
  appointments: { primary: 'appointments', legacy: ['google_calendar'] },
  payments: { primary: 'payments' },
  reports: { primary: 'reports', legacy: ['advanced_reports'] },
  analytics: { primary: 'analytics' },
  campaigns: { primary: 'campaigns', legacy: ['meta_ads'] },
  automations: { primary: 'automations' },
  sites: { primary: 'sites' },
  ai_agent: { primary: 'ai_agent', legacy: ['app_assistant_ai', 'conversational_ai', 'ai'] },
  settings_account: { primary: 'dashboard' },
  settings_mobile: { primary: 'mobile_app', legacy: ['settings_mobile'] },
  settings_calendars: { primary: 'appointments', legacy: ['google_calendar', 'settings_calendars'] },
  settings_payments: { primary: 'payments', legacy: ['settings_payments'] },
  settings_integrations: { primary: 'integrations', legacy: ['settings_integrations'] },
  settings_whatsapp: { primary: 'whatsapp', legacy: ['settings_whatsapp'] },
  settings_email: { primary: 'email', legacy: ['settings_email'] },
  settings_tracking: { primary: 'sites', legacy: ['settings_tracking'] },
  settings_domains: { primary: 'sites', legacy: ['settings_domains'] },
  settings_costs: { primary: 'reports', legacy: ['advanced_reports', 'settings_costs'] },
  settings_media: { primary: 'sites', legacy: ['settings_media'] },
  settings_api_access: { primary: 'developers', legacy: ['settings_api_access'] },
  settings_users: { primary: 'team_access', legacy: ['settings_users'] }
}

const LEGACY_FEATURE_ALIASES = {
  ai: 'ai_agent'
}

const FEATURE_FALLBACK_TO_PARENT = Object.entries(FEATURE_DEPENDENCIES)
  .reduce((result, [parent, dependencies]) => {
    for (const dependency of dependencies) {
      result[dependency] = parent
    }
    return result
  }, {})

const FEATURE_ALIAS_TO_CANONICAL = {
  ...LEGACY_FEATURE_ALIASES,
  ...FEATURE_FALLBACK_TO_PARENT
}

function normalizeFeatureKey(key) {
  return FEATURE_ALIAS_TO_CANONICAL[key] || key
}

const hasOwn = Object.prototype.hasOwnProperty

function readFeatureValue(features = {}, featureKey) {
  const key = String(featureKey || '').trim()
  if (!key) return false
  if (hasOwn.call(features, key)) return features[key] === true

  const fallbackKey = normalizeFeatureKey(key)
  if (fallbackKey !== key && hasOwn.call(features, fallbackKey)) {
    return features[fallbackKey] === true
  }

  return false
}

function readExplicitAnyFeatureValue(features = {}, featureKeys = []) {
  let sawExplicitFeature = false

  for (const featureKey of featureKeys) {
    const key = String(featureKey || '').trim()
    if (!key || !hasOwn.call(features, key)) continue
    sawExplicitFeature = true
    if (features[key] === true) return true
  }

  return sawExplicitFeature ? false : null
}

function readModuleFeatureValue(features = {}, moduleKey) {
  const key = String(moduleKey || '').trim()
  if (!key) return false

  const rule = LICENSE_FEATURES_BY_MODULE[key]
  if (!rule) return true

  if (hasOwn.call(features, key)) return features[key] === true
  if (hasOwn.call(features, rule.primary)) return features[rule.primary] === true

  return (rule.legacy || []).some((featureKey) => features[featureKey] === true)
}

export function getModuleFeatureKeys(moduleKey) {
  const key = String(moduleKey || '').trim()
  const rule = LICENSE_FEATURES_BY_MODULE[key]
  if (!rule) return []
  return [key, rule.primary, ...(rule.legacy || [])]
    .filter(Boolean)
    .filter((featureKey, index, all) => all.indexOf(featureKey) === index)
}

export function hasProfessionalPlan(plan = '') {
  const normalized = String(plan || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')

  if (!normalized) return false
  if (PROFESSIONAL_PLAN_KEYS.has(normalized)) return true
  return normalized.endsWith('_pro') ||
    normalized.endsWith('_professional') ||
    normalized.endsWith('_profesional') ||
    normalized.endsWith('_premium')
}

function applyPlanFeatureConstraints(features = {}, plan = '') {
  const constrained = { ...features }

  // Analítica web pertenece exclusivamente a Profesional. El plan manda incluso
  // si un portal viejo o un override heredado todavía envía web_analytics=true.
  if (!hasProfessionalPlan(plan)) constrained.web_analytics = false

  if (!hasProfessionalPlan(plan)) {
    for (const featureKey of PROFESSIONAL_ONLY_PAYMENT_FEATURE_KEYS) {
      constrained[featureKey] = false
    }
  }

  return constrained
}

function readPlanBoundFeatureValue(state = {}, featureKey = '') {
  if (featureKey === 'web_analytics' && !hasProfessionalPlan(state.plan)) return false
  if (PROFESSIONAL_ONLY_PAYMENT_FEATURE_KEYS.has(featureKey) && !hasProfessionalPlan(state.plan)) return false
  return readFeatureValue(state.features, featureKey)
}

// El runtime de fondo necesita un estado de instalación estable, mientras que
// cada request autenticado necesita el estado exacto de su principal. Mezclar
// ambos en "el último usuario verificado" permite que dos requests concurrentes
// se contaminen entre sí (por ejemplo, un empleado bloqueado cerrando features
// al dueño). Son caches deliberadamente separados.
let cachedInstallationState = null
const cachedStatesByPrincipal = new Map()
const verificationFlightsByPrincipal = new Map()
let licenseCacheGeneration = 0
let verifiedAppBaseUrlResolver = getVerifiedAppBaseUrl

const LICENSE_VERIFY_TIMEOUT_MS = 3000
const LICENSE_PORTAL_TIMEOUT_MS = 5000
const SETUP_TOKEN_MAX_ATTEMPTS = 3
const SETUP_TOKEN_RETRY_BASE_DELAY_MS = 200
const ACCOUNT_CANCELLATION_SNAPSHOT_KEY = 'license_account_cancellation_snapshot_v1'
const ACCOUNT_CANCELLATION_FRESH_MS = 60 * 1000
const ACCOUNT_CANCELLATION_STALE_MS = 24 * 60 * 60 * 1000
let accountCancellationSnapshot = null
let accountCancellationRefreshFlight = null

function normalizePrincipal(email = '') {
  return String(email || '').trim().toLowerCase()
}

function rememberPrincipalState(email, state) {
  const principal = normalizePrincipal(email)
  if (!principal) {
    cachedInstallationState = state
    return
  }

  // Una instalación puede tener muchos usuarios. El LRU acotado evita que alternar
  // entre empleados invalide el cache global y convierta cada request en una llamada
  // al portal, sin dejar crecer memoria indefinidamente.
  cachedStatesByPrincipal.delete(principal)
  cachedStatesByPrincipal.set(principal, state)
  if (cachedStatesByPrincipal.size > 1000) {
    cachedStatesByPrincipal.delete(cachedStatesByPrincipal.keys().next().value)
  }
}

function rememberInstallationStateFromPrincipal(email, state) {
  const principal = normalizePrincipal(email)
  const owner = normalizePrincipal(getConfig().ownerEmail)

  // OWNER_EMAIL es la autoridad del estado de instalación. En instalaciones
  // legacy sin owner configurado sólo aceptamos snapshots positivos de un
  // principal; un rechazo individual nunca puede apagar jobs ni rutas públicas.
  if (!principal || (owner && principal === owner) || (!owner && state?.allowed === true)) {
    cachedInstallationState = state
  }
}

function readPrincipalState(email) {
  const principal = normalizePrincipal(email)
  if (!principal) return cachedInstallationState
  const state = cachedStatesByPrincipal.get(principal) || null
  if (state) {
    cachedStatesByPrincipal.delete(principal)
    cachedStatesByPrincipal.set(principal, state)
  }
  return state
}

async function fetchWithTimeout(url, options = {}, timeoutMs = LICENSE_PORTAL_TIMEOUT_MS, consumeResponse = null) {
  const controller = new AbortController()
  let timer = null
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const timeoutError = new Error(`El portal central excedió ${timeoutMs} ms`)
      timeoutError.code = 'license_portal_timeout'
      reject(timeoutError)
    }, timeoutMs)
  })
  timer.unref?.()
  const requestPromise = Promise.resolve().then(async () => {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return typeof consumeResponse === 'function'
      ? consumeResponse(response)
      : response
  })
  try {
    return await Promise.race([requestPromise, timeoutPromise])
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'license_portal_timeout') {
      const timeoutError = new Error(`El portal central excedió ${timeoutMs} ms`)
      timeoutError.code = 'license_portal_timeout'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

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

async function buildInstalledAppPayload(extra = {}, config = getConfig()) {
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

/**
 * Identifica al dueño configurado por el Installer sin consultar la red. Sirve
 * para priorizar la validación global de soporte incluso cuando, por casualidad,
 * la contraseña del admin también coincide con el hash local del dueño.
 */
export function getManagedOwnerEmail() {
  return String(getConfig().ownerEmail || '').trim().toLowerCase()
}

export function isManagedOwnerEmail(email) {
  const ownerEmail = getManagedOwnerEmail()
  const candidate = String(email || '').trim().toLowerCase()
  return !!ownerEmail && !!candidate && ownerEmail === candidate
}

async function callLicenseServer(path, body = {}, {
  timeoutMs = LICENSE_PORTAL_TIMEOUT_MS,
  connectionMode = 'license',
  autoRegister = true
} = {}) {
  const commercialConfig = getConfig()
  let config = commercialConfig

  if (connectionMode === 'broker') {
    const requestedAppUrl = normalizeAppBaseUrl(body?.app_url) || await resolveManagedAppUrl(commercialConfig.appUrl)
    const brokerConfig = await resolveCentralBrokerConfig({ appUrl: requestedAppUrl, autoRegister })
    if (!brokerConfig) {
      throw new Error('Esta instalación todavía no tiene identidad técnica para usar el broker central.')
    }
    config = {
      licenseServerUrl: brokerConfig.brokerUrl,
      clientId: brokerConfig.clientId,
      licenseKey: brokerConfig.licenseKey,
      installationId: brokerConfig.installationId,
      appUrl: requestedAppUrl || brokerConfig.appUrl
    }
  } else if (!isLicenseEnforced()) {
    throw new Error('Esta instalación no está conectada al portal central.')
  }

  let response, data
  try {
    const result = await fetchWithTimeout(`${config.licenseServerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await buildInstalledAppPayload(body, config))
    }, timeoutMs, async portalResponse => {
      let portalData = {}
      try {
        portalData = await portalResponse.json()
      } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error
        if (portalResponse.ok) {
          const invalidResponseError = new Error('El portal central respondió con JSON inválido')
          invalidResponseError.code = 'license_portal_invalid_response'
          invalidResponseError.retryable = true
          invalidResponseError.cause = error
          throw invalidResponseError
        }
      }
      return { response: portalResponse, data: portalData }
    })
    response = result.response
    data = result.data
  } catch (error) {
    logger.error(`No se pudo contactar al portal central: ${error.message}`)
    const portalError = new Error('No se pudo contactar al portal central. Intenta de nuevo en unos minutos.')
    portalError.code = error?.code || 'license_portal_unavailable'
    portalError.retryable = true
    portalError.cause = error
    throw portalError
  }

  if (!response.ok || data?.success === false) {
    const message = data?.message || data?.error || 'El portal central rechazó la solicitud.'
    const error = new Error(message)
    error.code = data?.code || 'license_portal_rejected'
    error.status = response.status
    throw error
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
export async function requestPortalUserRefresh({ autoRegister = true } = {}) {
  if (!isLicenseEnforced() && !autoRegister && !(await getStoredCentralBrokerConfig())) return

  // (AUTH-009) Reintento acotado con backoff corto para fallos transitorios del portal.
  const maxAttempts = 3
  const baseBackoffMs = 300

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await callLicenseServer('/api/license/users/refresh', {}, {
        connectionMode: 'broker',
        autoRegister
      })
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

export async function getCentralBrokerHealthInfo() {
  const config = await getStoredCentralBrokerConfig()
  if (!config) return {}
  return {
    client_id: config.clientId || null,
    installation_id: config.installationId || null
  }
}

/** Solo para tests */
export function resetLicenseCache() {
  licenseCacheGeneration += 1
  cachedInstallationState = null
  cachedStatesByPrincipal.clear()
  verificationFlightsByPrincipal.clear()
  accountCancellationSnapshot = null
  accountCancellationRefreshFlight = null
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
    featuresSourceValid: true,
    limits: normalizeLicenseLimits(DEFAULT_LIMITS),
    externalModules: { ...DEFAULT_EXTERNAL_MODULES },
    expiresAt: null
  }
}

function normalizeExternalModules(externalModules = {}) {
  const source = externalModules && typeof externalModules === 'object' ? externalModules : {}
  const normalized = {}

  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue
    const sidebarPosition = Number(value.sidebar_position ?? value.sidebarPosition)
    normalized[key] = {
      key: value.key || key,
      label: value.label || key,
      menuLabel: value.menu_label || value.menuLabel || value.label || key,
      enabled: value.enabled === true,
      sidebarPosition: Number.isFinite(sidebarPosition) ? sidebarPosition : null
    }
  }

  return normalized
}

function normalizePositiveIntegerLimit(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.floor(number)
}

function normalizeLicenseLimits(limits = {}) {
  const source = limits && typeof limits === 'object' ? limits : {}
  const conversationalAgents = source.conversational_agents || source.conversationalAgents || {}

  return {
    ...DEFAULT_LIMITS,
    conversational_agents: {
      ...DEFAULT_LIMITS.conversational_agents,
      max_agents: normalizePositiveIntegerLimit(
        conversationalAgents.max_agents ?? conversationalAgents.maxAgents
      )
    }
  }
}

function normalizeLicenseFeatures(features = {}) {
  const source = features && typeof features === 'object' ? features : {}
  const normalized = {
    ...closedRemoteFeatures(),
    ...source
  }

  for (const [alias, canonical] of Object.entries(LEGACY_FEATURE_ALIASES)) {
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
      // (LIC-004) Una sub-feature enviada explícitamente por el portal SIEMPRE gana:
      // permite overrides finos como settings_media=true aunque sites=false.
      // Si el portal no mandó el hijo, entonces sí hereda el estado del padre.
      if (hasOwn.call(source, dependency)) {
        normalized[dependency] = source[dependency] === true
      } else {
        normalized[dependency] = normalized[featureKey] === true
      }
    }
  }

  normalized.ai = normalized.app_assistant_ai === true && normalized.conversational_ai === true

  return normalized
}

function cacheIsValid(state = cachedInstallationState) {
  return !!(state && state.allowed && state.expiresAt && new Date(state.expiresAt).getTime() > Date.now())
}

// (LIC-008) El cache positivo es "fresco" (reutilizable sin pegarle al portal) solo si
// además de tener un license_token vigente (cacheIsValid) no se venció su ventana corta
// de revalidación. Cuando la ventana vence, getLicenseState revalida contra el portal
// para reflejar cambios de plan en caliente. Si nunca se marcó revalidateAfter (estados
// viejos en cache), se trata como fresco para no romper el comportamiento previo.
function cacheIsFresh(state = cachedInstallationState) {
  if (!cacheIsValid(state)) return false
  if (!state.revalidateAfter) return true
  return state.revalidateAfter > Date.now()
}

// (LIC-006) Cache negativo: el estado bloqueado es válido mientras no expire su TTL
// corto. Así dejamos de martillar el portal en cada request cuando la licencia está
// bloqueada, sin volver el bloqueo permanente.
function blockedCacheIsValid(state = cachedInstallationState) {
  return !!(state && state.allowed === false && state.blockedUntil && state.blockedUntil > Date.now())
}

/**
 * Llama al license server central. Devuelve el estado de licencia y lo cachea.
 * @param {string} email - email del usuario que está iniciando sesión
 */
async function performLicenseVerification(targetEmail, generation) {
  const config = getConfig()
  const previousState = readPrincipalState(targetEmail)

  let response, data
  try {
    response = await fetchWithTimeout(`${config.licenseServerUrl}/api/license/verify`, {
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
    }, LICENSE_VERIFY_TIMEOUT_MS)
    data = await response.json()
  } catch (error) {
    logger.error(`No se pudo contactar al servidor de licencias: ${error.message}`)
    return handleServerUnreachable(previousState)
  }

  if (data && data.allowed) {
    // (LIC-003) Fail-closed: solo confiamos en un objeto features no vacío. Una
    // respuesta 'allowed' sin features es un error del portal y NO debe abrir premium.
    const hasValidFeatures = Boolean(data.features && typeof data.features === 'object' && Object.keys(data.features).length > 0)
    if (!hasValidFeatures) {
      logger.warn('[Licencia] El servidor respondió allowed sin un objeto "features" válido: se aplican features mínimas (premium apagado).')
    }
    const plan = data.plan || null
    const features = applyPlanFeatureConstraints(
      hasValidFeatures ? normalizeLicenseFeatures(data.features) : closedRemoteFeatures(),
      plan
    )
    const nextState = {
      allowed: true,
      enforced: true,
      plan,
      features,
      featuresSourceValid: hasValidFeatures,
      limits: normalizeLicenseLimits(data.limits),
      externalModules: normalizeExternalModules(data.external_modules),
      licenseToken: data.license_token || null,
      expiresAt: data.expires_at || null,
      verifiedAt: new Date().toISOString(),
      // (LIC-008) Marca hasta cuándo el cache positivo se considera "fresco". Aunque el
      // license_token siga vigente (expiresAt en horas), pasada esta ventana corta el
      // siguiente getLicenseState revalida contra el portal y aplica cambios de plan en
      // caliente, sin re-login.
      revalidateAfter: Date.now() + config.revalidateSeconds * 1000
    }
    if (generation === licenseCacheGeneration) {
      rememberPrincipalState(targetEmail, nextState)
      rememberInstallationStateFromPrincipal(targetEmail, nextState)
    }
    return nextState
  }

  // Respuesta válida del servidor pero bloqueada: invalidar cualquier cache positivo.
  // (LIC-006) Cacheamos el estado bloqueado por un TTL corto (blockedUntil) para no
  // re-verificar contra el portal en cada request mientras la licencia siga bloqueada.
  const nextState = {
    allowed: false,
    enforced: true,
    reason: data?.reason || 'license_blocked',
    message: data?.message || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.',
    expiresAt: null,
    verifiedAt: new Date().toISOString(),
    blockedUntil: Date.now() + config.blockedCacheSeconds * 1000
  }
  if (generation === licenseCacheGeneration) {
    rememberPrincipalState(targetEmail, nextState)
    rememberInstallationStateFromPrincipal(targetEmail, nextState)
  }
  return nextState
}

export async function verifyLicenseWithServer(email) {
  const config = getConfig()

  if (!isLicenseEnforced()) {
    return allowedWithoutEnforcement()
  }

  const targetEmail = normalizePrincipal(email || config.ownerEmail)
  const flightKey = targetEmail || '__installation__'
  const existingFlight = verificationFlightsByPrincipal.get(flightKey)
  if (existingFlight) return existingFlight

  const generation = licenseCacheGeneration
  const flight = performLicenseVerification(targetEmail, generation)
    .finally(() => {
      if (verificationFlightsByPrincipal.get(flightKey) === flight) {
        verificationFlightsByPrincipal.delete(flightKey)
      }
    })
  verificationFlightsByPrincipal.set(flightKey, flight)
  return flight
}

function handleServerUnreachable(previousState = cachedInstallationState) {
  const config = getConfig()

  // Si hay un token temporal vigente, se sigue permitiendo el acceso
  if (cacheIsValid(previousState)) {
    return previousState
  }

  if (config.offlinePolicy === 'grace' && previousState?.allowed && previousState.verifiedAt) {
    const graceLimit = new Date(previousState.verifiedAt).getTime() + config.graceHours * 60 * 60 * 1000
    if (Date.now() < graceLimit) {
      logger.warn('Servidor de licencias inaccesible: acceso permitido por política de gracia')
      return previousState
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

  const principalState = readPrincipalState(email)
  if (!forceRefresh) {
    if (cacheIsFresh(principalState)) return principalState

    // El token firmado sigue vigente aunque haya vencido la ventana corta de SWR.
    // Servimos el snapshot local inmediatamente y una sola verificación por principal
    // actualiza plan/features en segundo plano. Ninguna navegación queda rehén del portal.
    if (cacheIsValid(principalState)) {
      void verifyLicenseWithServer(email).catch((error) => {
        logger.warn(`No se pudo revalidar licencia en segundo plano: ${error.message}`)
      })
      return principalState
    }

    if (blockedCacheIsValid(principalState)) return principalState
  }

  return verifyLicenseWithServer(email)
}

export async function getConversationalAgentMaxAgents() {
  if (!isLicenseEnforced()) return null
  const state = await getLicenseState()
  return normalizePositiveIntegerLimit(state?.limits?.conversational_agents?.max_agents)
}

/**
 * Indica si una feature está habilitada según la última validación de licencia.
 */
export async function hasFeature(featureKey, { state: suppliedState = null, email = null } = {}) {
  const state = suppliedState || await getLicenseState({ email })
  if (!state.allowed) return false
  if (!state.enforced) return true
  return readPlanBoundFeatureValue(state, featureKey)
}

async function resolveModuleFeature(moduleKey, { state: suppliedState = null, email = null } = {}) {
  const state = suppliedState || await getLicenseState({ email })
  if (!state.allowed) return false
  if (!state.enforced) return true
  return readModuleFeatureValue(state.features, moduleKey)
}

export async function hasModuleFeature(moduleKey) {
  return resolveModuleFeature(moduleKey, arguments[1] || {})
}

export async function hasCalendarPaymentsFeature({ state: suppliedState = null, email = null } = {}) {
  const state = suppliedState || await getLicenseState({ email })
  if (!state.allowed) return false
  if (!state.enforced) return true

  const explicitCalendarPayment = readExplicitAnyFeatureValue(state.features, CALENDAR_PAYMENT_FEATURE_KEYS)
  if (explicitCalendarPayment !== null) return explicitCalendarPayment

  // Compatibilidad mientras el portal empieza a mandar calendar_payments:
  // Professional/pro o el feature legacy de Google Calendar mantienen el acceso.
  // Si el portal respondió allowed sin features válidos, LIC-003 sigue fail-closed.
  if (state.featuresSourceValid === false) return false

  return readFeatureValue(state.features, 'google_calendar') || hasProfessionalPlan(state.plan)
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

  return readPlanBoundFeatureValue(state, featureKey)
}

export async function createCentralGoogleCalendarConnectUrl({ returnPath = '/settings/calendars/google', appUrl = '' } = {}) {
  const payload = {
    return_path: returnPath
  }

  const normalizedAppUrl = normalizeAppBaseUrl(appUrl)
  if (normalizedAppUrl) {
    payload.app_url = normalizedAppUrl
  }

  const data = await callLicenseServer('/api/license/google-calendar/connect-url', payload, { connectionMode: 'broker' })
  return {
    url: data.url || '',
    mode: data.mode || 'calendar',
    redirectUri: data.redirect_uri || data.redirectUri || ''
  }
}

export async function createCentralGoogleLoginUrl({ returnPath = '/sso', appUrl = '' } = {}) {
  const payload = { return_path: returnPath }
  const normalizedAppUrl = normalizeAppBaseUrl(appUrl)
  if (normalizedAppUrl) payload.app_url = normalizedAppUrl
  const data = await callLicenseServer('/api/license/google-login/connect-url', payload, { connectionMode: 'broker' })
  return {
    url: data.url || '',
    mode: data.mode || 'login',
    redirectUri: data.redirect_uri || data.redirectUri || ''
  }
}

export async function disconnectCentralGoogleCalendar() {
  const data = await callLicenseServer('/api/license/google-calendar/disconnect', {}, { connectionMode: 'broker' })
  return data.calendar || {}
}

export async function claimCentralOAuthHandoff({ provider, handoffToken } = {}) {
  const data = await callLicenseServer('/api/license/oauth-handoff/claim', {
    provider,
    handoff_token: handoffToken
  }, { connectionMode: 'broker' })
  return data.handoff || {}
}

/**
 * La app/secret/configuration id de Facebook Login for Business viven en el
 * Installer. La instalación sólo recibe configuración pública y, al terminar,
 * reclama un handoff de un uso con el User Access Token vigente. Las
 * conexiones BISU anteriores siguen siendo compatibles durante la migración.
 */
export async function getCentralMetaOAuthStatus({ integrationKind = '' } = {}) {
  const data = await callLicenseServer('/api/license/meta/status', integrationKind
    ? { integration_kind: integrationKind }
    : {}, { connectionMode: 'broker' })
  return data.meta || data.connection || data || {}
}

export async function createCentralMetaOAuthConnectUrl({ returnPath = '/settings/meta-ads/cuenta', integrationKind = '' } = {}) {
  const data = await callLicenseServer('/api/license/meta/connect-url', {
    return_path: returnPath,
    ...(integrationKind ? { integration_kind: integrationKind } : {})
  }, { connectionMode: 'broker' })
  const meta = data.meta || data || {}
  return {
    ...meta,
    connectUrl: meta.connect_url || meta.connectUrl || data.connect_url || data.connectUrl || ''
  }
}

export async function connectCentralMetaOAuth({ code = '', configId = '', returnPath = '/settings/meta-ads/cuenta', integrationKind = '' } = {}) {
  const data = await callLicenseServer('/api/license/meta/connect', {
    code,
    config_id: configId,
    return_path: returnPath,
    ...(integrationKind ? { integration_kind: integrationKind } : {})
  }, { connectionMode: 'broker' })
  return {
    meta: data.meta || {},
    handoffToken: data.handoff_token || data.handoffToken || data.handoff?.token || '',
    handoffExpiresAt: data.handoff?.expires_at || data.handoff?.expiresAt || null
  }
}

export async function disconnectCentralWhatsAppMeta() {
  const data = await callLicenseServer('/api/license/whatsapp/meta/disconnect', {}, { connectionMode: 'broker' })
  return data.whatsapp || data || {}
}

export async function updateCentralMetaWebhookSubscription({
  action = 'register',
  integrationKind = '',
  connectionId = '',
  pageId = '',
  instagramAccountId = '',
  webhookUrl = ''
} = {}) {
  const data = await callLicenseServer('/api/license/meta/webhook-subscription', {
    action: action === 'unregister' ? 'unregister' : 'register',
    ...(integrationKind ? { integration_kind: integrationKind } : {}),
    connection_id: connectionId || null,
    page_id: pageId || null,
    instagram_account_id: instagramAccountId || null,
    webhook_url: webhookUrl || null
  }, { connectionMode: 'broker' })
  return data.meta || data.subscription || data || {}
}

export async function finalizeCentralMetaOAuth({
  integrationKind,
  connectionId,
  adAccountId,
  datasetId = ''
} = {}) {
  const data = await callLicenseServer('/api/license/meta/finalize', {
    integration_kind: integrationKind,
    connection_id: connectionId,
    ad_account_id: adAccountId,
    dataset_id: datasetId || null
  }, { connectionMode: 'broker' })
  return data.meta || data.connection || data || {}
}

export async function disconnectCentralMetaOAuth({ integrationKind = '' } = {}) {
  const data = await callLicenseServer('/api/license/meta/disconnect', integrationKind
    ? { integration_kind: integrationKind }
    : {}, { connectionMode: 'broker' })
  return {
    disconnected: data.disconnected === true,
    meta: data.meta || null
  }
}

export async function refreshCentralGoogleCalendarToken({ refreshToken } = {}) {
  const data = await callLicenseServer('/api/license/google-calendar/refresh-token', {
    refresh_token: refreshToken
  }, { connectionMode: 'broker' })
  return data.token || {}
}

export async function createCentralMercadoPagoConnectUrl({ mode = 'test', returnPath = '/settings/payments/mercadopago', appUrl = '' } = {}) {
  const payload = {
    mode: mode === 'live' ? 'live' : 'test',
    return_path: returnPath
  }

  if (appUrl) {
    payload.app_url = appUrl
  }

  const data = await callLicenseServer('/api/license/mercadopago/connect-url', payload, { connectionMode: 'broker' })
  return {
    url: data.url || '',
    mode: data.mode === 'live' ? 'live' : 'test',
    redirectUri: data.redirect_uri || data.redirectUri || '',
    webhookUrl: data.webhook_url || data.webhookUrl || '',
    managedByPortal: true
  }
}

export async function disconnectCentralMercadoPago() {
  const data = await callLicenseServer('/api/license/mercadopago/disconnect', {}, { connectionMode: 'broker' })
  return data.connection || {}
}

export async function refreshCentralMercadoPagoToken({ mode = 'test', refreshToken } = {}) {
  const data = await callLicenseServer('/api/license/mercadopago/refresh-token', {
    mode: mode === 'live' ? 'live' : 'test',
    refresh_token: refreshToken
  }, { connectionMode: 'broker' })
  return data.token || {}
}

export async function getCentralMobilePushStatus() {
  const data = await callLicenseServer('/api/license/mobile-push/status', {}, { connectionMode: 'broker' })
  return data.push || {
    configured: false,
    nativeConfigured: false,
    iosConfigured: false,
    androidConfigured: false
  }
}

export async function sendCentralMobilePushNotifications(
  { devices = [], payload = {} } = {},
  { timeoutMs = LICENSE_PORTAL_TIMEOUT_MS } = {}
) {
  return callLicenseServer('/api/license/mobile-push/send', {
    devices,
    payload
  }, { timeoutMs, connectionMode: 'broker' })
}

async function readAccountCancellationSnapshot() {
  if (accountCancellationSnapshot) return accountCancellationSnapshot
  try {
    const { db } = await import('../config/database.js')
    const row = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
      [ACCOUNT_CANCELLATION_SNAPSHOT_KEY]
    )
    const parsed = row?.config_value ? JSON.parse(row.config_value) : null
    if (parsed?.data && Number.isFinite(Number(parsed.fetchedAt))) {
      accountCancellationSnapshot = {
        data: parsed.data,
        fetchedAt: Number(parsed.fetchedAt)
      }
    }
  } catch (error) {
    logger.warn(`No se pudo leer snapshot local de cancelación: ${error.message}`)
  }
  return accountCancellationSnapshot
}

async function writeAccountCancellationSnapshot(data) {
  const snapshot = { data, fetchedAt: Date.now() }
  accountCancellationSnapshot = snapshot
  try {
    const { db } = await import('../config/database.js')
    await db.run(
      `INSERT INTO app_config (config_key, config_value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(config_key) DO UPDATE SET
         config_value = excluded.config_value,
         updated_at = CURRENT_TIMESTAMP`,
      [ACCOUNT_CANCELLATION_SNAPSHOT_KEY, JSON.stringify(snapshot)]
    )
  } catch (error) {
    // La memoria sigue sirviendo el snapshot; persistencia es una optimización y no
    // debe convertir un estado remoto válido en error para el usuario.
    logger.warn(`No se pudo persistir snapshot local de cancelación: ${error.message}`)
  }
  return data
}

async function invalidateAccountCancellationSnapshot() {
  accountCancellationSnapshot = null
  try {
    const { db } = await import('../config/database.js')
    await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_CANCELLATION_SNAPSHOT_KEY])
  } catch (error) {
    logger.warn(`No se pudo invalidar snapshot local de cancelación: ${error.message}`)
  }
}

function refreshAccountCancellationSnapshot() {
  if (accountCancellationRefreshFlight) return accountCancellationRefreshFlight
  const flight = callLicenseServer(
    '/api/license/account-cancellation/status',
    {},
    { timeoutMs: LICENSE_VERIFY_TIMEOUT_MS }
  )
    .then(writeAccountCancellationSnapshot)
    .finally(() => {
      if (accountCancellationRefreshFlight === flight) accountCancellationRefreshFlight = null
    })
  accountCancellationRefreshFlight = flight
  return flight
}

export async function getCentralAccountCancellationStatus() {
  const snapshot = await readAccountCancellationSnapshot()
  const ageMs = snapshot ? Date.now() - snapshot.fetchedAt : Number.POSITIVE_INFINITY

  if (snapshot && ageMs <= ACCOUNT_CANCELLATION_FRESH_MS) return snapshot.data
  if (snapshot && ageMs <= ACCOUNT_CANCELLATION_STALE_MS) {
    void refreshAccountCancellationSnapshot().catch((error) => {
      logger.warn(`No se pudo refrescar cancelación en segundo plano: ${error.message}`)
    })
    return snapshot.data
  }

  try {
    return await refreshAccountCancellationSnapshot()
  } catch (error) {
    if (snapshot) return snapshot.data
    throw error
  }
}

export async function acceptCentralAccountRetentionOffer() {
  const result = await callLicenseServer('/api/license/account-cancellation/retention')
  await invalidateAccountCancellationSnapshot()
  return result
}

export async function requestCentralAccountCancellation({ reasonKey, reasonDetails = '' } = {}) {
  const result = await callLicenseServer('/api/license/account-cancellation/cancel', {
    reason_key: reasonKey,
    reason_details: reasonDetails
  })
  await invalidateAccountCancellationSnapshot()
  return result
}

export async function getCentralDatabaseStorageStatus({ usedBytes = 0 } = {}) {
  return callLicenseServer('/api/license/database-storage/status', {
    used_bytes: Math.max(0, Number(usedBytes) || 0)
  })
}

export async function decideCentralDatabaseStorage({
  decision,
  currentDiskSizeGB,
  targetDiskSizeGB,
  usedBytes = 0,
  requestedByEmail = ''
} = {}) {
  return callLicenseServer('/api/license/database-storage/decision', {
    decision,
    current_disk_size_gb: currentDiskSizeGB,
    target_disk_size_gb: targetDiskSizeGB,
    used_bytes: Math.max(0, Number(usedBytes) || 0),
    requested_by_email: String(requestedByEmail || '').trim().toLowerCase()
  })
}

/**
 * Verifica credenciales contra el portal central. Puede devolver el hash vigente
 * del dueño para sincronizar la copia local o `support_access: true` cuando la
 * el correo y la contraseña corresponden a un administrador del Installer. El
 * hash del admin nunca se devuelve ni se guarda en esta instalación.
 */
export async function verifyOwnerCredentialsWithServer(email, password) {
  const config = getConfig()

  if (!isLicenseEnforced() || !email || !password) {
    return { valid: false }
  }

  try {
    const response = await fetchWithTimeout(`${config.licenseServerUrl}/api/owner-credentials/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        license_key: config.licenseKey,
        installation_id: config.installationId,
        email,
        password
      })
    }, LICENSE_PORTAL_TIMEOUT_MS)
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

  let lastError = null

  for (let attempt = 1; attempt <= SETUP_TOKEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await fetchWithTimeout(`${config.licenseServerUrl}/api/setup-token/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          installation_id: config.installationId
        })
      }, LICENSE_PORTAL_TIMEOUT_MS, async (response) => {
        let data = null
        try {
          data = await response.json()
        } catch {
          // Una respuesta incompleta durante un deploy es transitoria igual que un 5xx.
        }
        return { ok: response.ok, status: response.status, data }
      })

      const retryableStatus = result.status === 408
        || result.status === 425
        || result.status === 429
        || result.status >= 500
      const malformedSuccess = result.ok && !result.data

      if (!retryableStatus && !malformedSuccess) {
        return result.data || { valid: false }
      }

      lastError = new Error(`El portal central respondió ${result.status || 'sin datos'}`)
    } catch (error) {
      lastError = error
    }

    if (attempt < SETUP_TOKEN_MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, SETUP_TOKEN_RETRY_BASE_DELAY_MS * attempt))
    }
  }

  logger.error(`No se pudo validar el setup token después de ${SETUP_TOKEN_MAX_ATTEMPTS} intentos: ${lastError?.message || 'error desconocido'}`)
  return {
    valid: false,
    retryable: true,
    code: 'setup_temporarily_unavailable',
    message: 'El portal está terminando de preparar tu acceso. Intenta de nuevo en unos segundos.'
  }
}
