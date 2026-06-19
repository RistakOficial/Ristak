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
  whatsapp: true,
  meta_ads: true,
  google_calendar: true,
  ai: true,
  app_assistant_ai: true,
  conversational_ai: true,
  automations: true,
  advanced_reports: true,
  premium_modules: true
}

// Estado cacheado de la última validación (token temporal de licencia)
let cachedState = null
let lastVerifiedEmail = null
let verifiedAppBaseUrlResolver = getVerifiedAppBaseUrl

function getConfig() {
  return {
    licenseServerUrl: (process.env.LICENSE_SERVER_URL || '').replace(/\/+$/, ''),
    clientId: process.env.CLIENT_ID || '',
    licenseKey: process.env.LICENSE_KEY || '',
    installationId: process.env.INSTALLATION_ID || '',
    appUrl: process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '',
    appVersion: process.env.APP_VERSION || '0.0.0',
    ownerEmail: process.env.OWNER_EMAIL || '',
    offlinePolicy: process.env.LICENSE_OFFLINE_POLICY === 'grace' ? 'grace' : 'strict',
    graceHours: Number(process.env.LICENSE_OFFLINE_GRACE_HOURS) > 0
      ? Number(process.env.LICENSE_OFFLINE_GRACE_HOURS)
      : 24
  }
}

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '')
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
 * (tiene LICENSE_SERVER_URL + CLIENT_ID + LICENSE_KEY). En desarrollo local o
 * instalaciones standalone la app funciona sin license server.
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

  if (source.ai !== undefined) {
    if (source.app_assistant_ai === undefined) {
      normalized.app_assistant_ai = !!source.ai
    }
    if (source.conversational_ai === undefined) {
      normalized.conversational_ai = !!source.ai
    }
  }

  if (source.ai === undefined) {
    normalized.ai = normalized.app_assistant_ai === true && normalized.conversational_ai === true
  }

  return normalized
}

function cacheIsValid() {
  return !!(cachedState && cachedState.allowed && cachedState.expiresAt && new Date(cachedState.expiresAt).getTime() > Date.now())
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
    cachedState = {
      allowed: true,
      enforced: true,
      plan: data.plan || null,
      features: normalizeLicenseFeatures(data.features),
      licenseToken: data.license_token || null,
      expiresAt: data.expires_at || null,
      verifiedAt: new Date().toISOString()
    }
    lastVerifiedEmail = targetEmail
    return cachedState
  }

  // Respuesta válida del servidor pero bloqueada: invalidar cualquier cache
  cachedState = {
    allowed: false,
    enforced: true,
    reason: data?.reason || 'license_blocked',
    message: data?.message || 'Tu licencia de Ristak no está activa. Contacta al administrador o actualiza tu suscripción para continuar.',
    expiresAt: null,
    verifiedAt: new Date().toISOString()
  }
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

  if (!forceRefresh && cacheIsValid()) {
    return cachedState
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
  return !!state.features?.[featureKey]
}

export async function getCentralGoogleCalendarStatus() {
  const data = await callLicenseServer('/api/license/google-calendar/status')
  return data.calendar || {}
}

export async function createCentralGoogleCalendarConnectUrl({ returnPath = '/settings/calendars/google' } = {}) {
  const data = await callLicenseServer('/api/license/google-calendar/connect-url', {
    return_path: returnPath
  })
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

export async function listCentralGoogleCalendars() {
  const data = await callLicenseServer('/api/license/google-calendar/calendars')
  return Array.isArray(data.calendars) ? data.calendars : []
}

export async function upsertCentralGoogleCalendarEvent({ googleCalendarId, googleEventId = '', event = {} } = {}) {
  const data = await callLicenseServer('/api/license/google-calendar/events/upsert', {
    google_calendar_id: googleCalendarId,
    google_event_id: googleEventId,
    event
  })
  return data.event || {}
}

export async function listCentralGoogleCalendarEvents({ googleCalendarId, timeMin = '', timeMax = '', showDeleted = false } = {}) {
  const data = await callLicenseServer('/api/license/google-calendar/events/list', {
    google_calendar_id: googleCalendarId,
    time_min: timeMin,
    time_max: timeMax,
    show_deleted: Boolean(showDeleted)
  })
  return Array.isArray(data.events) ? data.events : []
}

export async function deleteCentralGoogleCalendarEvent({ googleCalendarId, googleEventId } = {}) {
  return callLicenseServer('/api/license/google-calendar/events/delete', {
    google_calendar_id: googleCalendarId,
    google_event_id: googleEventId
  })
}

export async function disconnectCentralGoogleCalendar() {
  const data = await callLicenseServer('/api/license/google-calendar/disconnect')
  return data.calendar || {}
}

export async function getCentralStripeConnectStatus() {
  const data = await callLicenseServer('/api/license/stripe-connect/status')
  return data.connection || {}
}

export async function createCentralStripeConnectUrl({ mode = 'test', returnPath = '/settings/payments/stripe' } = {}) {
  const data = await callLicenseServer('/api/license/stripe-connect/connect-url', {
    mode: mode === 'live' ? 'live' : 'test',
    return_path: returnPath
  })
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
