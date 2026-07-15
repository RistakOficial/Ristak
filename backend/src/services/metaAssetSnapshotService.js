import crypto from 'crypto'
import { getAppConfig, setAppConfig } from '../config/database.js'
import { getMetaConfig, getMetaSocialConfig } from './metaAdsService.js'

const META_ASSET_SNAPSHOT_KEY = 'meta_asset_snapshot_v1'
const META_ASSET_SNAPSHOT_FRESH_MS = 15 * 60 * 1000

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function normalizeConnectionMode(value) {
  const mode = cleanString(value).toLowerCase()
  return ['oauth_user', 'oauth_bisu'].includes(mode) ? mode : 'manual_system_user'
}

function normalizeAdAccountId(value) {
  return cleanString(value).replace(/^act_/i, '')
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function normalizeAdAccount(account = {}) {
  const id = cleanString(account.id || account.account_id)
  if (!id) return null
  return {
    id: /^act_/i.test(id) ? id : `act_${id}`,
    account_id: cleanString(account.account_id) || normalizeAdAccountId(id),
    name: cleanString(account.name) || normalizeAdAccountId(id),
    currency: cleanString(account.currency),
    timezone_name: cleanString(account.timezone_name || account.timezoneName),
    account_status: Number(account.account_status ?? account.accountStatus ?? account.status ?? 0) || 0
  }
}

function normalizePixel(pixel = {}, fallbackAdAccountId = '') {
  const id = cleanString(pixel.id)
  if (!id) return null
  return {
    id,
    name: cleanString(pixel.name) || id,
    creation_time: cleanString(pixel.creation_time || pixel.creationTime),
    last_fired_time: cleanString(pixel.last_fired_time || pixel.lastFiredTime),
    adAccountId: normalizeAdAccountId(pixel.adAccountId || pixel.ad_account_id || fallbackAdAccountId)
  }
}

function normalizeInstagramAccount(account = {}, pageId = '') {
  const id = cleanString(account.id || account.sourceId)
  if (!id) return null
  return {
    id,
    username: cleanString(account.username),
    name: cleanString(account.name) || cleanString(account.username) || id,
    pageId: cleanString(account.pageId || pageId),
    avatarUrl: cleanString(account.avatarUrl || account.profile_picture_url),
    followers: Number.isFinite(Number(account.followers)) ? Number(account.followers) : null
  }
}

function normalizePage(page = {}) {
  const id = cleanString(page.id)
  if (!id) return null
  const instagramAccounts = Array.isArray(page.instagramAccounts)
    ? page.instagramAccounts.map(account => normalizeInstagramAccount(account, id)).filter(Boolean)
    : []
  return {
    id,
    name: cleanString(page.name) || id,
    category: cleanString(page.category) || null,
    pictureUrl: cleanString(page.pictureUrl || page.picture_url) || null,
    businessId: cleanString(page.businessId || page.business_id),
    followers: Number.isFinite(Number(page.followers)) ? Number(page.followers) : null,
    instagramAccounts
  }
}

function normalizeProfile(profile = {}, updatedAt = '') {
  const platform = cleanString(profile.platform).toLowerCase()
  const sourceId = cleanString(profile.sourceId || profile.source_id)
  if (!sourceId || !['facebook', 'instagram', 'threads', 'tiktok'].includes(platform)) return null
  return {
    id: cleanString(profile.id) || `${platform}:${sourceId}`,
    platform,
    sourceId,
    pageId: cleanString(profile.pageId || profile.page_id),
    pageName: cleanString(profile.pageName || profile.page_name),
    name: cleanString(profile.name) || sourceId,
    username: cleanString(profile.username),
    category: cleanString(profile.category) || null,
    avatarUrl: cleanString(profile.avatarUrl || profile.avatar_url) || null,
    followers: Number.isFinite(Number(profile.followers)) ? Number(profile.followers) : null,
    followersLabel: cleanString(profile.followersLabel || profile.followers_label),
    isConfiguredPage: profile.isConfiguredPage === true,
    isConfiguredInstagram: profile.isConfiguredInstagram === true,
    updatedAt: cleanString(profile.updatedAt) || updatedAt
  }
}

function normalizePixelsByAdAccount(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([accountId, pixels]) => {
    const normalizedAccountId = normalizeAdAccountId(accountId)
    if (!normalizedAccountId || !Array.isArray(pixels)) return []
    return [[normalizedAccountId, pixels
      .map(pixel => normalizePixel(pixel, normalizedAccountId))
      .filter(Boolean)]]
  }))
}

function normalizeSnapshot(value = {}) {
  const updatedAt = cleanString(value.updatedAt) || null
  return {
    version: 1,
    connectionSignature: cleanString(value.connectionSignature),
    updatedAt,
    adAccounts: Array.isArray(value.adAccounts)
      ? value.adAccounts.map(normalizeAdAccount).filter(Boolean)
      : [],
    pixelsByAdAccount: normalizePixelsByAdAccount(value.pixelsByAdAccount),
    pages: Array.isArray(value.pages) ? value.pages.map(normalizePage).filter(Boolean) : [],
    profiles: Array.isArray(value.profiles)
      ? value.profiles.map(profile => normalizeProfile(profile, updatedAt || '')).filter(Boolean)
      : []
  }
}

async function resolveConnectionSignature(explicitAccessToken = '') {
  const explicit = cleanString(explicitAccessToken)
  if (explicit) {
    const manual = {
      connectionMode: 'manual_system_user',
      connectionId: '',
      accessTokenHash: hash(explicit)
    }
    return hash(JSON.stringify({
      version: 1,
      ads: manual,
      social: manual
    }))
  }

  const [adsConfig, socialConfig] = await Promise.all([
    getMetaConfig({ migratePlaintext: false }).catch(() => null),
    getMetaSocialConfig({ migratePlaintext: false }).catch(() => null)
  ])
  const describe = config => ({
    connectionMode: normalizeConnectionMode(config?.connection_mode),
    connectionId: cleanString(config?.oauth_connection_id),
    accessTokenHash: config?.access_token ? hash(config.access_token) : ''
  })
  const ads = describe(adsConfig)
  const social = describe(socialConfig)
  if (!ads.accessTokenHash && !social.accessTokenHash) return ''
  return hash(JSON.stringify({ version: 1, ads, social }))
}

function emptySnapshot() {
  return {
    version: 1,
    updatedAt: null,
    stale: true,
    adAccounts: [],
    pixelsByAdAccount: {},
    pages: [],
    profiles: []
  }
}

export async function getMetaAssetSnapshot({ explicitAccessToken = '' } = {}) {
  const expectedSignature = await resolveConnectionSignature(explicitAccessToken)
  if (!expectedSignature) return emptySnapshot()

  const raw = await getAppConfig(META_ASSET_SNAPSHOT_KEY).catch(() => '')
  if (!raw) return emptySnapshot()
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return emptySnapshot()
  }
  const snapshot = normalizeSnapshot(parsed)
  if (!snapshot.connectionSignature || snapshot.connectionSignature !== expectedSignature) {
    return emptySnapshot()
  }
  const updatedAtMs = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : NaN
  return {
    ...snapshot,
    stale: !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > META_ASSET_SNAPSHOT_FRESH_MS
  }
}

export async function saveMetaAssetSnapshot(value = {}, { explicitAccessToken = '' } = {}) {
  const connectionSignature = await resolveConnectionSignature(explicitAccessToken)
  if (!connectionSignature) throw new Error('Meta no tiene una conexión local para guardar el inventario')

  const current = await getMetaAssetSnapshot({ explicitAccessToken })
  const sameConnection = current.connectionSignature === connectionSignature
  const incoming = value && typeof value === 'object' ? value : {}
  const merged = normalizeSnapshot({
    version: 1,
    connectionSignature,
    updatedAt: cleanString(incoming.updatedAt) || new Date().toISOString(),
    adAccounts: Object.prototype.hasOwnProperty.call(incoming, 'adAccounts')
      ? incoming.adAccounts
      : sameConnection ? current.adAccounts : [],
    pixelsByAdAccount: {
      ...(sameConnection ? current.pixelsByAdAccount : {}),
      ...normalizePixelsByAdAccount(incoming.pixelsByAdAccount)
    },
    pages: Object.prototype.hasOwnProperty.call(incoming, 'pages')
      ? incoming.pages
      : sameConnection ? current.pages : [],
    profiles: Object.prototype.hasOwnProperty.call(incoming, 'profiles')
      ? incoming.profiles
      : sameConnection ? current.profiles : []
  })
  await setAppConfig(META_ASSET_SNAPSHOT_KEY, JSON.stringify(merged))
  return { ...merged, stale: false }
}

export async function clearMetaAssetSnapshot() {
  await setAppConfig(META_ASSET_SNAPSHOT_KEY, '')
}

export const META_ASSET_SNAPSHOT_CONFIG_KEY = META_ASSET_SNAPSHOT_KEY
