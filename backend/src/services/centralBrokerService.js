import crypto from 'node:crypto'
import { getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'

const IDENTITY_CONFIG_KEY = 'central_broker_identity_v1'
const REGISTRATION_CONFIG_KEY = 'central_broker_registration_v1'
const REGISTRATION_VERSION = 'ristak-broker-registration-v1'
const DEFAULT_BROKER_URL = 'https://www.ristak.com'
const REQUEST_TIMEOUT_MS = 10_000

let identityFlight = null
let registrationFlight = null

function brokerError(message, code = 'central_broker_error', status = 500) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function cleanString(value) {
  return String(value ?? '').trim()
}

function firstEnv(...keys) {
  for (const key of keys) {
    const value = cleanString(process.env[key])
    if (value) return value
  }
  return ''
}

function isLocalHost(hostname = '') {
  const normalized = cleanString(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function normalizeCentralBrokerOrigin(value = '', { label = 'URL' } = {}) {
  let parsed
  try {
    parsed = new URL(cleanString(value))
  } catch {
    throw brokerError(`${label} no es válida.`, 'central_broker_url_invalid', 400)
  }

  const allowLocalHttp = process.env.NODE_ENV !== 'production' && isLocalHost(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(allowLocalHttp && parsed.protocol === 'http:')) {
    throw brokerError(`${label} debe usar HTTPS.`, 'central_broker_url_insecure', 400)
  }
  if (parsed.username || parsed.password) {
    throw brokerError(`${label} no puede incluir credenciales.`, 'central_broker_url_credentials', 400)
  }
  return parsed.origin
}

function normalizePublicKey(value = '') {
  try {
    const key = crypto.createPublicKey(cleanString(value))
    if (key.asymmetricKeyType !== 'ed25519') {
      throw brokerError('La identidad técnica debe usar Ed25519.', 'central_broker_key_type_invalid', 400)
    }
    return key.export({ type: 'spki', format: 'pem' }).toString().trim()
  } catch (error) {
    if (error?.code === 'central_broker_key_type_invalid') throw error
    throw brokerError('La identidad técnica no es válida.', 'central_broker_key_invalid', 400)
  }
}

function publicKeyFingerprint(publicKey = '') {
  return crypto.createHash('sha256').update(normalizePublicKey(publicKey)).digest('hex')
}

export function buildCentralBrokerProofManifest({ challenge = '', appUrl = '', publicKey = '' } = {}) {
  return [
    REGISTRATION_VERSION,
    cleanString(challenge),
    normalizeCentralBrokerOrigin(appUrl, { label: 'La URL pública de la instalación' }),
    publicKeyFingerprint(publicKey)
  ].join('\n')
}

function readEncryptedJson(value, configKey) {
  if (!value) return null
  try {
    return JSON.parse(decrypt(value))
  } catch (error) {
    throw brokerError(`No se pudo leer ${configKey}: ${error.message}`, 'central_broker_config_unreadable')
  }
}

async function readIdentity() {
  const stored = readEncryptedJson(await getAppConfig(IDENTITY_CONFIG_KEY), IDENTITY_CONFIG_KEY)
  if (!stored?.publicKey || !stored?.privateKey) return null
  return {
    publicKey: normalizePublicKey(stored.publicKey),
    privateKey: cleanString(stored.privateKey)
  }
}

async function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const identity = {
    publicKey: normalizePublicKey(publicKey),
    privateKey: cleanString(privateKey)
  }
  await setAppConfig(IDENTITY_CONFIG_KEY, encrypt(JSON.stringify(identity)))
  return identity
}

export async function getOrCreateCentralBrokerIdentity() {
  if (identityFlight) return identityFlight
  identityFlight = (async () => (await readIdentity()) || createIdentity())()
    .finally(() => { identityFlight = null })
  return identityFlight
}

function managedEnvironmentConfig() {
  const brokerUrl = firstEnv('LICENSE_SERVER_URL', 'RISTAK_LICENSE_SERVER_URL')
  const clientId = firstEnv('CLIENT_ID', 'RISTAK_CLIENT_ID')
  const licenseKey = firstEnv('LICENSE_KEY', 'RISTAK_LICENSE_KEY')
  const installationId = firstEnv('INSTALLATION_ID', 'RISTAK_INSTALLATION_ID')
  if (!brokerUrl || !clientId || !licenseKey || !installationId) return null
  return {
    brokerUrl: normalizeCentralBrokerOrigin(brokerUrl, { label: 'La URL del portal central' }),
    clientId,
    licenseKey,
    installationId,
    appUrl: cleanString(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL),
    mode: 'managed'
  }
}

export async function getStoredCentralBrokerConfig() {
  const managed = managedEnvironmentConfig()
  if (managed) return managed

  const stored = readEncryptedJson(await getAppConfig(REGISTRATION_CONFIG_KEY), REGISTRATION_CONFIG_KEY)
  if (!stored?.brokerUrl || !stored?.clientId || !stored?.licenseKey || !stored?.installationId) return null
  return {
    brokerUrl: normalizeCentralBrokerOrigin(stored.brokerUrl, { label: 'La URL del broker central' }),
    clientId: cleanString(stored.clientId),
    licenseKey: cleanString(stored.licenseKey),
    installationId: cleanString(stored.installationId),
    appUrl: cleanString(stored.appUrl),
    mode: 'standalone_broker'
  }
}

function configuredBrokerUrl() {
  return normalizeCentralBrokerOrigin(
    firstEnv('CENTRAL_BROKER_URL', 'RISTAK_INTEGRATION_BROKER_URL') || DEFAULT_BROKER_URL,
    { label: 'La URL del broker central' }
  )
}

async function requestRegistration({ brokerUrl, appUrl, publicKey }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  let response
  try {
    response = await fetch(`${brokerUrl}/api/broker/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_url: appUrl, public_key: publicKey }),
      signal: controller.signal
    })
  } catch (error) {
    const wrapped = brokerError(
      error?.name === 'AbortError'
        ? 'El broker central tardó demasiado en registrar esta instalación.'
        : 'No se pudo contactar al broker central de integraciones.',
      error?.name === 'AbortError' ? 'central_broker_timeout' : 'central_broker_unavailable',
      503
    )
    wrapped.retryable = true
    wrapped.cause = error
    throw wrapped
  } finally {
    clearTimeout(timer)
  }

  let body = {}
  try {
    body = await response.json()
  } catch {
    throw brokerError('El broker central respondió con datos inválidos.', 'central_broker_invalid_response', 502)
  }
  if (!response.ok || body?.success === false) {
    throw brokerError(
      cleanString(body?.message || body?.error) || 'El broker central rechazó el registro.',
      cleanString(body?.code) || 'central_broker_registration_rejected',
      response.status
    )
  }
  return body?.registration || {}
}

export async function ensureCentralBrokerRegistration({ appUrl: rawAppUrl = '' } = {}) {
  const managed = managedEnvironmentConfig()
  if (managed) return managed

  const appUrl = normalizeCentralBrokerOrigin(
    rawAppUrl || process.env.RENDER_EXTERNAL_URL || process.env.APP_URL,
    { label: 'La URL pública de la instalación' }
  )
  const existing = await getStoredCentralBrokerConfig()
  if (existing && normalizeCentralBrokerOrigin(existing.appUrl, { label: 'La URL registrada' }) === appUrl) {
    return existing
  }
  if (registrationFlight) return registrationFlight

  registrationFlight = (async () => {
    const brokerUrl = configuredBrokerUrl()
    const identity = await getOrCreateCentralBrokerIdentity()
    const registration = await requestRegistration({ brokerUrl, appUrl, publicKey: identity.publicKey })
    const config = {
      brokerUrl,
      clientId: cleanString(registration.client_id || registration.clientId),
      licenseKey: cleanString(registration.license_key || registration.licenseKey),
      installationId: cleanString(registration.installation_id || registration.installationId),
      appUrl,
      mode: 'standalone_broker'
    }
    if (!config.clientId || !config.licenseKey || !config.installationId) {
      throw brokerError('El broker central no entregó credenciales completas.', 'central_broker_credentials_missing', 502)
    }
    await setAppConfig(REGISTRATION_CONFIG_KEY, encrypt(JSON.stringify(config)))
    return config
  })().finally(() => { registrationFlight = null })

  return registrationFlight
}

export async function resolveCentralBrokerConfig({ appUrl = '', autoRegister = true } = {}) {
  const existing = await getStoredCentralBrokerConfig()
  if (existing) {
    if (
      autoRegister &&
      existing.mode === 'standalone_broker' &&
      appUrl &&
      normalizeCentralBrokerOrigin(existing.appUrl, { label: 'La URL registrada' }) !==
        normalizeCentralBrokerOrigin(appUrl, { label: 'La URL pública de la instalación' })
    ) {
      return ensureCentralBrokerRegistration({ appUrl })
    }
    return existing
  }
  if (!autoRegister) return null
  return ensureCentralBrokerRegistration({ appUrl })
}

export async function signCentralBrokerRegistrationProof({ challenge = '', appUrl = '', publicKey = '' } = {}) {
  const identity = await getOrCreateCentralBrokerIdentity()
  const normalizedPublicKey = normalizePublicKey(publicKey)
  if (normalizedPublicKey !== identity.publicKey) {
    throw brokerError('La prueba solicitada no corresponde a esta instalación.', 'central_broker_identity_mismatch', 403)
  }
  const normalizedAppUrl = normalizeCentralBrokerOrigin(appUrl, { label: 'La URL pública de la instalación' })
  const signature = crypto.sign(
    null,
    Buffer.from(buildCentralBrokerProofManifest({ challenge, appUrl: normalizedAppUrl, publicKey: identity.publicKey })),
    crypto.createPrivateKey(identity.privateKey)
  ).toString('base64url')
  return {
    version: REGISTRATION_VERSION,
    public_key: identity.publicKey,
    app_url: normalizedAppUrl,
    signature
  }
}

export function resetCentralBrokerStateForTests() {
  identityFlight = null
  registrationFlight = null
}

export const CENTRAL_BROKER_CONFIG_KEYS = Object.freeze({
  identity: IDENTITY_CONFIG_KEY,
  registration: REGISTRATION_CONFIG_KEY
})
