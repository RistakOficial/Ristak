import crypto from 'crypto'
import { db } from '../config/database.js'
import { logger } from './logger.js'

export const API_TOKEN_PREFIX = 'ristak_live_'
export const API_APP_ID_PREFIX = 'app_'
const API_TOKEN_RANDOM_BYTES = 32
const API_APP_ID_RANDOM_BYTES = 16
const API_APP_ID_CONFIG_KEY = 'external_api_app_id'

export function generateApiToken() {
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(API_TOKEN_RANDOM_BYTES).toString('base64url')}`
}

export function hashApiToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export async function getExternalApiAppId() {
  const existing = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [API_APP_ID_CONFIG_KEY]
  )

  if (existing?.config_value) {
    return existing.config_value
  }

  const appId = `${API_APP_ID_PREFIX}${crypto.randomBytes(API_APP_ID_RANDOM_BYTES).toString('base64url')}`

  await db.run(
    `INSERT INTO app_config (config_key, config_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(config_key) DO UPDATE SET
       config_value = COALESCE(app_config.config_value, excluded.config_value),
       updated_at = CURRENT_TIMESTAMP`,
    [API_APP_ID_CONFIG_KEY, appId]
  )

  const stored = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    [API_APP_ID_CONFIG_KEY]
  )

  return stored?.config_value || appId
}

function buildMetadata(row) {
  const hasToken = Boolean(row?.api_token_hash && !row?.api_token_revoked_at)
  return {
    hasToken,
    prefix: hasToken ? row.api_token_prefix : null,
    lastFour: hasToken ? row.api_token_last_four : null,
    preview: hasToken && row.api_token_prefix && row.api_token_last_four
      ? `${row.api_token_prefix}...${row.api_token_last_four}`
      : null,
    createdAt: hasToken ? row.api_token_created_at : null,
    lastUsedAt: hasToken ? row.api_token_last_used_at : null,
    revokedAt: row?.api_token_revoked_at || null
  }
}

export async function getApiTokenMetadataForUser(userId) {
  const row = await db.get(
    `SELECT api_token_hash, api_token_prefix, api_token_last_four,
            api_token_created_at, api_token_last_used_at, api_token_revoked_at
     FROM users
     WHERE id = ?`,
    [userId]
  )

  return buildMetadata(row)
}

export async function rotateApiTokenForUser(userId) {
  const token = generateApiToken()
  const tokenHash = hashApiToken(token)
  const lastFour = token.slice(-4)

  await db.run(
    `UPDATE users
     SET api_token_hash = ?,
         api_token_prefix = ?,
         api_token_last_four = ?,
         api_token_created_at = CURRENT_TIMESTAMP,
         api_token_last_used_at = NULL,
         api_token_revoked_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [tokenHash, API_TOKEN_PREFIX, lastFour, userId]
  )

  return {
    token,
    metadata: await getApiTokenMetadataForUser(userId)
  }
}

export async function revokeApiTokenForUser(userId) {
  await db.run(
    `UPDATE users
     SET api_token_hash = NULL,
         api_token_prefix = NULL,
         api_token_last_four = NULL,
         api_token_last_used_at = NULL,
         api_token_revoked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [userId]
  )

  return getApiTokenMetadataForUser(userId)
}

export async function authenticateApiToken(rawToken) {
  const token = String(rawToken || '').trim()

  if (!token || !token.startsWith(API_TOKEN_PREFIX)) {
    return null
  }

  const tokenHash = hashApiToken(token)

  const user = await db.get(
    `SELECT id, username, email, full_name, role, is_active, api_token_hash,
            api_token_prefix, api_token_last_four, api_token_created_at,
            api_token_last_used_at
     FROM users
     WHERE api_token_hash = ?
       AND api_token_revoked_at IS NULL
     LIMIT 1`,
    [tokenHash]
  )

  if (!user || !user.is_active || !user.api_token_hash) {
    return null
  }

  try {
    const expected = Buffer.from(user.api_token_hash, 'hex')
    const received = Buffer.from(tokenHash, 'hex')
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return null
    }
  } catch (error) {
    logger.warn(`API token hash inválido en DB para usuario ${user.id}: ${error.message}`)
    return null
  }

  await db.run(
    'UPDATE users SET api_token_last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
    [user.id]
  )

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.full_name,
    role: user.role
  }
}
