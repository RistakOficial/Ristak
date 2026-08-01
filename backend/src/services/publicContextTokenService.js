import crypto from 'node:crypto'
import { db } from '../config/database.js'

const PUBLIC_CONTEXT_SIGNING_KEY_CONFIG = 'public_context_signing_secret_v1'
const PUBLIC_CONTEXT_TOKEN_VERSION = 1
const MIN_SIGNING_KEY_BYTES = 32
const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60
const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60
const MAX_TOKEN_LENGTH = 4096
const SEALED_TOKEN_PREFIX = 'pce1'
const SEALED_TOKEN_IV_BYTES = 12
const SEALED_TOKEN_TAG_BYTES = 16
const PURPOSE_PATTERN = /^[a-z][a-z0-9_.:-]{2,95}$/i

let signingKeyPromise = null

function cleanString(value, maxLength = 500) {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, maxLength) : ''
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

function normalizePurpose(value) {
  const purpose = cleanString(value, 96)
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new PublicContextTokenError('Propósito de firma inválido', {
      code: 'invalid_public_context_purpose'
    })
  }
  return purpose
}

function normalizeTtlSeconds(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TOKEN_TTL_SECONDS
  return Math.max(60, Math.min(MAX_TOKEN_TTL_SECONDS, Math.floor(parsed)))
}

function normalizeNowMs(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function parseStoredSigningKey(value) {
  const raw = cleanString(value, 512)
  if (!raw) return null
  try {
    const key = Buffer.from(raw, 'base64url')
    return key.length >= MIN_SIGNING_KEY_BYTES ? key : null
  } catch {
    return null
  }
}

async function initializeSigningKey() {
  const candidate = crypto.randomBytes(MIN_SIGNING_KEY_BYTES).toString('base64url')
  await db.run(`
    INSERT INTO app_config (config_key, config_value, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(config_key) DO NOTHING
  `, [PUBLIC_CONTEXT_SIGNING_KEY_CONFIG, candidate])

  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    [PUBLIC_CONTEXT_SIGNING_KEY_CONFIG]
  )
  const key = parseStoredSigningKey(row?.config_value)
  if (!key) {
    throw new PublicContextTokenError('No se pudo inicializar la firma pública interna', {
      code: 'public_context_signing_key_unavailable',
      status: 503
    })
  }
  return key
}

async function getSigningKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = initializeSigningKey().catch(error => {
      signingKeyPromise = null
      throw error
    })
  }
  return signingKeyPromise
}

function signEncodedPayload(encodedPayload, key) {
  return crypto
    .createHmac('sha256', key)
    .update(encodedPayload)
    .digest('base64url')
}

function signaturesMatch(expected, received) {
  try {
    const expectedBuffer = Buffer.from(String(expected || ''), 'utf8')
    const receivedBuffer = Buffer.from(String(received || ''), 'utf8')
    return expectedBuffer.length === receivedBuffer.length &&
      expectedBuffer.length > 0 &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  } catch {
    return false
  }
}

function decodeBase64UrlSegment(value) {
  const segment = cleanString(value, MAX_TOKEN_LENGTH)
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return null
  try {
    return Buffer.from(segment, 'base64url')
  } catch {
    return null
  }
}

function deriveSealingKey(signingKey, purpose) {
  return crypto
    .createHmac('sha256', signingKey)
    .update(`${SEALED_TOKEN_PREFIX}:${purpose}`)
    .digest()
}

function stableCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableCanonicalValue(value[key])
      return result
    }, {})
}

export class PublicContextTokenError extends Error {
  constructor(message, { code = 'invalid_public_context_token', status = 400 } = {}) {
    super(message)
    this.name = 'PublicContextTokenError'
    this.code = code
    this.status = status
  }
}

export function normalizePublicContextHost(value) {
  let input = cleanString(value, 320).split(',')[0].trim().toLowerCase()
  if (!input) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `http://${input}`
  try {
    return new URL(input).hostname.replace(/\.$/, '').toLowerCase()
  } catch {
    return ''
  }
}

export async function signPublicContextClaims({
  purpose,
  claims = {},
  ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS,
  nowMs = Date.now()
} = {}) {
  const normalizedPurpose = normalizePurpose(purpose)
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new PublicContextTokenError('Claims de firma inválidos', {
      code: 'invalid_public_context_claims'
    })
  }

  const issuedAt = Math.floor(normalizeNowMs(nowMs) / 1000)
  const payload = {
    v: PUBLIC_CONTEXT_TOKEN_VERSION,
    p: normalizedPurpose,
    iat: issuedAt,
    exp: issuedAt + normalizeTtlSeconds(ttlSeconds),
    c: stableCanonicalValue(claims)
  }
  const encodedPayload = encodeJson(payload)
  const signature = signEncodedPayload(encodedPayload, await getSigningKey())
  return `pct1.${encodedPayload}.${signature}`
}

export async function verifyPublicContextToken(token, {
  purpose,
  nowMs = Date.now()
} = {}) {
  const normalizedPurpose = normalizePurpose(purpose)
  const rawToken = cleanString(token, MAX_TOKEN_LENGTH)
  const parts = rawToken.split('.')
  if (parts.length !== 3 || parts[0] !== 'pct1') {
    throw new PublicContextTokenError('Token público inválido')
  }

  const [, encodedPayload, signature] = parts
  const expected = signEncodedPayload(encodedPayload, await getSigningKey())
  if (!signaturesMatch(expected, signature)) {
    throw new PublicContextTokenError('Firma pública inválida')
  }

  const payload = decodeJson(encodedPayload)
  if (
    !payload ||
    payload.v !== PUBLIC_CONTEXT_TOKEN_VERSION ||
    payload.p !== normalizedPurpose ||
    !payload.c ||
    typeof payload.c !== 'object' ||
    Array.isArray(payload.c)
  ) {
    throw new PublicContextTokenError('Contrato de token público inválido')
  }

  const nowSeconds = Math.floor(normalizeNowMs(nowMs) / 1000)
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= payload.iat) {
    throw new PublicContextTokenError('Vigencia de token público inválida')
  }
  if (payload.iat > nowSeconds + 60) {
    throw new PublicContextTokenError('Token público emitido en el futuro', {
      code: 'public_context_token_not_active'
    })
  }
  if (payload.exp <= nowSeconds) {
    throw new PublicContextTokenError('Token público expirado', {
      code: 'public_context_token_expired'
    })
  }

  return {
    version: payload.v,
    purpose: payload.p,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    claims: payload.c
  }
}

// Contextos públicos de larga vida (por ejemplo, enlaces destinados a un
// contacto) no deben exponer sus claims en base64 ni exigir una fila por token.
// AES-GCM cifra y autentica el payload; el purpose funciona como AAD y separa
// criptográficamente cada consumidor aunque compartan la llave raíz interna.
export async function sealPublicContextClaims({ purpose, claims = {} } = {}) {
  const normalizedPurpose = normalizePurpose(purpose)
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new PublicContextTokenError('Claims de cifrado inválidos', {
      code: 'invalid_public_context_claims'
    })
  }

  const iv = crypto.randomBytes(SEALED_TOKEN_IV_BYTES)
  const key = deriveSealingKey(await getSigningKey(), normalizedPurpose)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${SEALED_TOKEN_PREFIX}:${normalizedPurpose}`, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify({
    v: PUBLIC_CONTEXT_TOKEN_VERSION,
    c: stableCanonicalValue(claims)
  }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${SEALED_TOKEN_PREFIX}_${Buffer.concat([iv, ciphertext, tag]).toString('base64url')}`
}

export async function openSealedPublicContextClaims(token, { purpose } = {}) {
  const normalizedPurpose = normalizePurpose(purpose)
  const rawToken = cleanString(token, MAX_TOKEN_LENGTH)
  const tokenPrefix = `${SEALED_TOKEN_PREFIX}_`
  if (!rawToken.startsWith(tokenPrefix)) {
    throw new PublicContextTokenError('Token público cifrado inválido')
  }

  const packed = decodeBase64UrlSegment(rawToken.slice(tokenPrefix.length))
  if (
    !packed ||
    packed.length <= SEALED_TOKEN_IV_BYTES + SEALED_TOKEN_TAG_BYTES
  ) {
    throw new PublicContextTokenError('Contrato de token público cifrado inválido')
  }
  const iv = packed.subarray(0, SEALED_TOKEN_IV_BYTES)
  const ciphertext = packed.subarray(SEALED_TOKEN_IV_BYTES, -SEALED_TOKEN_TAG_BYTES)
  const tag = packed.subarray(-SEALED_TOKEN_TAG_BYTES)

  try {
    const key = deriveSealingKey(await getSigningKey(), normalizedPurpose)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`${SEALED_TOKEN_PREFIX}:${normalizedPurpose}`, 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = JSON.parse(plaintext.toString('utf8'))
    if (
      payload?.v !== PUBLIC_CONTEXT_TOKEN_VERSION ||
      !payload.c ||
      typeof payload.c !== 'object' ||
      Array.isArray(payload.c)
    ) {
      throw new Error('invalid payload')
    }
    return {
      version: payload.v,
      purpose: normalizedPurpose,
      claims: payload.c
    }
  } catch {
    throw new PublicContextTokenError('Token público cifrado alterado o inválido')
  }
}

export async function derivePublicContextOpaqueId({
  purpose,
  claims = {},
  prefix = '',
  length = 43
} = {}) {
  const normalizedPurpose = normalizePurpose(purpose)
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new PublicContextTokenError('Claims de derivación inválidos', {
      code: 'invalid_public_context_claims'
    })
  }
  const safePrefix = cleanString(prefix, 24).replace(/[^A-Za-z0-9_-]/g, '')
  const safeLength = Math.max(16, Math.min(64, Math.floor(Number(length) || 43)))
  const canonical = JSON.stringify({
    v: PUBLIC_CONTEXT_TOKEN_VERSION,
    p: normalizedPurpose,
    c: stableCanonicalValue(claims)
  })
  const digest = crypto
    .createHmac('sha256', await getSigningKey())
    .update(canonical)
    .digest('base64url')
    .slice(0, safeLength)
  return `${safePrefix}${digest}`
}
