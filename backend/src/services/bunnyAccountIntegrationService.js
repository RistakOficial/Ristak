import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { normalizeToUtcIso } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import { resolveMediaAccountPolicy } from './mediaAccountPolicyService.js'

const CONFIG_KEY = 'bunny_account_integration_encrypted'
const BUNNY_CORE_API_BASE_URL = 'https://api.bunny.net'
const DEFAULT_STORAGE_REGION = 'NY'
const STANDARD_STREAM_LIBRARY_NAME = 'Ristak Sites & Forms'
const CACHE_TTL_MS = 30_000
const GB = 1024 * 1024 * 1024

let integrationCache = {
  expiresAt: 0,
  value: null,
  loaded: false
}

function cleanString(value = '') {
  return String(value || '').trim()
}

function nowUtcIso() {
  return normalizeToUtcIso(new Date())
}

function integrationError(message, status = 400, code = 'bunny_integration_error', details = null) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details) error.details = details
  return error
}

function normalizeBaseUrl(value = '') {
  return cleanString(value).replace(/\/+$/, '')
}

function normalizeId(value) {
  const normalized = cleanString(value)
  return normalized || null
}

function normalizeStorageZone(row = {}) {
  const id = normalizeId(row.Id ?? row.id)
  const name = cleanString(row.Name ?? row.name)
  if (!id || !name) return null
  return {
    id,
    name,
    password: cleanString(row.Password ?? row.password),
    region: cleanString((row.Region ?? row.region) || DEFAULT_STORAGE_REGION).toUpperCase(),
    storageHostname: cleanString(row.StorageHostname ?? row.storageHostname),
    storageUsed: Number(row.StorageUsed ?? row.storageUsed) || 0,
    filesStored: Number(row.FilesStored ?? row.filesStored) || 0,
    pullZones: Array.isArray(row.PullZones ?? row.pullZones) ? (row.PullZones ?? row.pullZones) : []
  }
}

function normalizePullZone(row = {}) {
  const id = normalizeId(row.Id ?? row.id)
  const name = cleanString(row.Name ?? row.name)
  if (!id || !name) return null
  const hostnames = Array.isArray(row.Hostnames ?? row.hostnames)
    ? (row.Hostnames ?? row.hostnames)
      .map((hostname) => ({
        value: cleanString(hostname?.Value ?? hostname?.value),
        system: Boolean(hostname?.IsSystemHostname ?? hostname?.isSystemHostname)
      }))
      .filter((hostname) => hostname.value)
    : []
  return {
    id,
    name,
    storageZoneId: normalizeId(row.StorageZoneId ?? row.storageZoneId),
    enabled: row.Enabled === undefined && row.enabled === undefined
      ? true
      : Boolean(row.Enabled ?? row.enabled),
    suspended: Boolean(row.Suspended ?? row.suspended),
    hostnames
  }
}

function normalizeVideoLibrary(row = {}) {
  const id = normalizeId(row.Id ?? row.id)
  const name = cleanString(row.Name ?? row.name)
  if (!id || !name) return null
  return {
    id,
    name,
    apiKey: cleanString(row.ApiKey ?? row.apiKey),
    storageUsage: Number(row.StorageUsage ?? row.storageUsage) || 0,
    videoCount: Number(row.VideoCount ?? row.videoCount) || 0
  }
}

function normalizeCoreList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.Items)) return payload.Items
  if (Array.isArray(payload?.items)) return payload.items
  return []
}

function safeResourceName(value = '', fallback = 'ristak-media') {
  const normalized = cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (normalized || fallback).slice(0, 45).replace(/-$/g, '') || fallback
}

async function readAccountSlug() {
  const row = await db.get('SELECT account_slug FROM storage_settings WHERE id = 1').catch(() => null)
  return safeResourceName(row?.account_slug || 'ristak-media')
}

async function bunnyCoreRequest(apiKey, pathname, {
  method = 'GET',
  body,
  okStatuses = [200],
  coreEndpoint = BUNNY_CORE_API_BASE_URL
} = {}) {
  const response = await fetch(`${normalizeBaseUrl(coreEndpoint)}${pathname}`, {
    method,
    headers: {
      AccessKey: apiKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  const payload = await response.json().catch(async () => ({
    message: await response.text().catch(() => '')
  }))

  if (!okStatuses.includes(response.status)) {
    const detail = cleanString(payload?.Message || payload?.message || payload?.ErrorKey || response.statusText)
    const invalidCredential = response.status === 401 || response.status === 403
    throw integrationError(
      invalidCredential
        ? 'Bunny.net rechazó la API key. Copia la Account API Key completa desde tu cuenta.'
        : `Bunny.net rechazó la operación (${response.status}): ${detail.slice(0, 180) || response.statusText}`,
      invalidCredential ? 401 : 502,
      invalidCredential ? 'bunny_api_key_invalid' : 'bunny_core_request_failed'
    )
  }

  return payload
}

async function listStorageZones(apiKey, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/storagezone', options)
  return normalizeCoreList(payload).map(normalizeStorageZone).filter(Boolean)
}

async function createStorageZone(apiKey, name, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/storagezone', {
    ...options,
    method: 'POST',
    body: {
      Name: name,
      Region: DEFAULT_STORAGE_REGION,
      ZoneTier: 0,
      StorageZoneType: 0
    },
    okStatuses: [200, 201]
  })
  const zone = normalizeStorageZone(payload)
  if (!zone?.password) {
    throw integrationError(
      'Bunny.net creó la Storage Zone, pero no entregó una llave de escritura usable.',
      502,
      'bunny_storage_key_missing'
    )
  }
  return zone
}

async function listPullZones(apiKey, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/pullzone', options)
  return normalizeCoreList(payload).map(normalizePullZone).filter(Boolean)
}

async function createPullZone(apiKey, name, storageZoneId, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/pullzone', {
    ...options,
    method: 'POST',
    body: {
      Name: name,
      StorageZoneId: Number(storageZoneId) || storageZoneId,
      BlockPostRequests: true,
      DisableCookies: true,
      EnableCacheSlice: true,
      EnableSmartCache: true,
      EnableQueryStringOrdering: true
    },
    okStatuses: [200, 201]
  })
  const pullZone = normalizePullZone(payload)
  if (!pullZone) {
    throw integrationError('Bunny.net no regresó una Pull Zone usable.', 502, 'bunny_pull_zone_missing')
  }
  return pullZone
}

function pullZoneCdnBaseUrl(pullZone) {
  const hostname = pullZone?.hostnames?.find((item) => item.system)?.value
    || pullZone?.hostnames?.[0]?.value
    || `${pullZone?.name}.b-cdn.net`
  return hostname ? `https://${hostname}` : ''
}

async function listVideoLibraries(apiKey, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/videolibrary?page=1&perPage=1000', options)
  return normalizeCoreList(payload).map(normalizeVideoLibrary).filter(Boolean)
}

function premiumVideoLibrarySettings(name) {
  return {
    Name: name,
    PlayerVersion: 2,
    AllowEarlyPlay: false,
    EncodingTier: 1,
    JitEncodingEnabled: true,
    OutputCodecs: 'x264,av1',
    EnabledResolutions: '240p,360p,480p,720p,1080p,1440p,2160p',
    EnableMP4Fallback: false,
    KeepOriginalFiles: true,
    AllowDirectPlay: true,
    EnableMultiAudioTrackSupport: true
  }
}

async function createVideoLibrary(apiKey, name, { premium = false, ...options } = {}) {
  const payload = await bunnyCoreRequest(apiKey, '/videolibrary', {
    ...options,
    method: 'POST',
    body: premium
      ? premiumVideoLibrarySettings(name)
      : { Name: name, PlayerVersion: 2, AllowEarlyPlay: false },
    okStatuses: [200, 201]
  })
  const library = normalizeVideoLibrary(payload)
  if (!library?.apiKey) {
    throw integrationError(
      'Bunny.net creó la biblioteca de video, pero no entregó su llave limitada.',
      502,
      'bunny_stream_key_missing'
    )
  }
  return library
}

async function refreshVideoLibrary(apiKey, libraryId, options = {}) {
  const payload = await bunnyCoreRequest(apiKey, `/videolibrary/${encodeURIComponent(libraryId)}`, options)
  return normalizeVideoLibrary(payload)
}

function storageZoneBelongsToCurrentConfig(zone, currentConfig = {}) {
  return Boolean(
    zone?.name
    && cleanString(currentConfig?.bunnyStorageZone)
    && zone.name.toLowerCase() === cleanString(currentConfig.bunnyStorageZone).toLowerCase()
  )
}

function libraryBelongsToCurrentConfig(library, currentConfig = {}) {
  return Boolean(
    library?.id
    && cleanString(currentConfig?.bunnyStreamLibraryId)
    && library.id === cleanString(currentConfig.bunnyStreamLibraryId)
  )
}

function integrationPayloadFromProvisioned({
  apiKey,
  zone,
  pullZone,
  library,
  currentConfig,
  migration,
  previous = null
}) {
  const sameStorageAsManaged = storageZoneBelongsToCurrentConfig(zone, currentConfig)
  const sameStreamAsManaged = libraryBelongsToCurrentConfig(library, currentConfig)
  const connectedAt = previous?.connectedAt || nowUtcIso()
  return {
    version: 1,
    provider: 'bunny_account',
    active: true,
    disconnecting: false,
    accountApiKey: apiKey,
    storageApiKey: zone.password,
    storageZoneId: zone.id,
    storageZone: zone.name,
    storageRegion: zone.region || DEFAULT_STORAGE_REGION,
    pullZoneId: pullZone.id,
    pullZoneName: pullZone.name,
    cdnBaseUrl: pullZoneCdnBaseUrl(pullZone),
    streamLibraryId: library.id,
    streamLibraryName: library.name,
    streamApiKey: library.apiKey,
    sameStorageAsManaged,
    sameStreamAsManaged,
    connectedAt,
    updatedAt: nowUtcIso(),
    migration
  }
}

async function writeEncryptedIntegration(value) {
  const encrypted = encrypt(JSON.stringify(value))
  await db.run(
    `INSERT INTO app_config (config_key, config_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (config_key) DO UPDATE SET
       config_value = excluded.config_value,
       updated_at = CURRENT_TIMESTAMP`,
    [CONFIG_KEY, encrypted]
  )
  resetBunnyAccountIntegrationCache()
  return value
}

async function deleteEncryptedIntegration() {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [CONFIG_KEY])
  resetBunnyAccountIntegrationCache()
}

export function resetBunnyAccountIntegrationCache() {
  integrationCache = {
    expiresAt: 0,
    value: null,
    loaded: false
  }
}

export async function readBunnyAccountIntegration({ includeInactive = true } = {}) {
  if (integrationCache.loaded && integrationCache.expiresAt > Date.now()) {
    if (!includeInactive && !integrationCache.value?.active) return null
    return integrationCache.value
  }

  const row = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [CONFIG_KEY]).catch(() => null)
  let value = null
  if (row?.config_value) {
    try {
      value = JSON.parse(decrypt(row.config_value))
    } catch (error) {
      logger.error(`[BunnyAccount] No se pudo abrir la configuración cifrada: ${error.message}`)
    }
  }
  integrationCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
    loaded: true
  }
  if (!includeInactive && !value?.active) return null
  return value
}

export function bunnyIntegrationRuntimeConfig(integration) {
  if (!integration) return null
  return {
    provider: 'bunny',
    storageEnabled: true,
    bunnyStorageZone: cleanString(integration.storageZone),
    bunnyStorageRegion: cleanString(integration.storageRegion),
    bunnyStorageApiKey: cleanString(integration.storageApiKey),
    bunnyCdnBaseUrl: normalizeBaseUrl(integration.cdnBaseUrl),
    bunnyAccountApiKey: cleanString(integration.accountApiKey),
    bunnyCoreEndpoint: BUNNY_CORE_API_BASE_URL,
    bunnyStorageEndpoint: '',
    bunnyStreamEnabled: true,
    bunnyStreamLibraryId: cleanString(integration.streamLibraryId),
    bunnyStreamLibraryName: cleanString(integration.streamLibraryName),
    bunnyStreamApiKey: cleanString(integration.streamApiKey),
    bunnyStreamCollectionId: '',
    bunnyStreamCollectionName: STANDARD_STREAM_LIBRARY_NAME,
    bunnyStreamEndpoint: 'https://video.bunnycdn.com',
    bunnyConfigured: Boolean(integration.storageZone && integration.storageApiKey && integration.cdnBaseUrl),
    bunnyStreamConfigured: Boolean(integration.streamLibraryId && integration.streamApiKey),
    missingEnvironment: [],
    streamMissingEnvironment: [],
    storageStatus: 'configured',
    streamStatus: 'configured',
    requireBunny: true,
    customerOwnedStorage: true,
    storageConfigSource: 'bunny_account'
  }
}

export async function provisionBunnyAccount(apiKeyInput, currentConfig = {}, options = {}) {
  const apiKey = cleanString(apiKeyInput).replace(/[\r\n\t]/g, '')
  if (apiKey.length < 20 || apiKey.length > 500) {
    throw integrationError(
      'La Account API Key de Bunny.net no tiene un formato válido.',
      400,
      'bunny_api_key_invalid'
    )
  }

  const previous = await readBunnyAccountIntegration()
  if (previous?.disconnecting) {
    throw integrationError(
      'Bunny.net se está desconectando. Espera a que termine la migración antes de conectar otra cuenta.',
      409,
      'bunny_disconnect_in_progress'
    )
  }
  if (previous?.active && ['pending', 'running'].includes(cleanString(previous.migration?.status))) {
    throw integrationError(
      'La migración de Bunny.net sigue activa. Espera a que termine antes de rotar la API key.',
      409,
      'bunny_migration_in_progress'
    )
  }
  const accountSlug = await readAccountSlug()
  const storageZoneName = safeResourceName(`ristak-${accountSlug}`)
  const pullZoneName = safeResourceName(`ristak-${accountSlug}-cdn`)
  const mediaPolicy = await resolveMediaAccountPolicy()
  const libraryName = mediaPolicy?.premiumStream
    ? cleanString(mediaPolicy.streamLibraryName) || 'Ristak Sites Premium Adaptive'
    : STANDARD_STREAM_LIBRARY_NAME

  const requestOptions = options.coreEndpoint ? { coreEndpoint: options.coreEndpoint } : {}
  const zones = await listStorageZones(apiKey, requestOptions)
  const previousZone = previous?.active
    ? zones.find((candidate) => candidate.id === cleanString(previous.storageZoneId))
    : null
  if (previous?.active && !previousZone) {
    throw integrationError(
      'La nueva API key pertenece a otra cuenta Bunny.net. Desconecta la cuenta actual antes de cambiar de propietario.',
      409,
      'bunny_account_change_requires_disconnect'
    )
  }

  let zone = previousZone
    || zones.find((candidate) => storageZoneBelongsToCurrentConfig(candidate, currentConfig))
    || zones.find((candidate) => candidate.name.toLowerCase() === storageZoneName.toLowerCase())
    || null

  if (!zone) zone = await createStorageZone(apiKey, storageZoneName, requestOptions)
  if (!zone.password) {
    const refreshedZones = await listStorageZones(apiKey, requestOptions)
    zone = refreshedZones.find((candidate) => candidate.id === zone.id) || zone
  }
  if (!zone.password) {
    throw integrationError('Bunny.net no entregó la llave de escritura de la Storage Zone.', 502, 'bunny_storage_key_missing')
  }

  const embeddedPullZones = zone.pullZones.map(normalizePullZone).filter(Boolean)
  let pullZone = embeddedPullZones.find((candidate) => candidate.storageZoneId === zone.id)
    || embeddedPullZones[0]
    || null
  if (!pullZone) {
    const pullZones = await listPullZones(apiKey, requestOptions)
    pullZone = pullZones.find((candidate) => candidate.storageZoneId === zone.id)
      || null
  }
  if (!pullZone) pullZone = await createPullZone(apiKey, pullZoneName, zone.id, requestOptions)

  const libraries = await listVideoLibraries(apiKey, requestOptions)
  let library = (previous?.active
    ? libraries.find((candidate) => candidate.id === cleanString(previous.streamLibraryId))
    : null)
    || libraries.find((candidate) => libraryBelongsToCurrentConfig(candidate, currentConfig))
    || libraries.find((candidate) => candidate.name.toLowerCase() === libraryName.toLowerCase())
    || null
  if (!library) {
    library = await createVideoLibrary(apiKey, libraryName, {
      ...requestOptions,
      premium: Boolean(mediaPolicy?.premiumStream)
    })
  } else if (!library.apiKey) {
    library = await refreshVideoLibrary(apiKey, library.id, requestOptions) || library
  }
  if (!library?.apiKey) {
    throw integrationError('Bunny.net no entregó la llave limitada de la biblioteca de video.', 502, 'bunny_stream_key_missing')
  }

  const [assetCountRow, streamCountRow] = await Promise.all([
    db.get(
      `SELECT COUNT(*) AS total
       FROM media_assets
       WHERE deleted_at IS NULL AND status != 'deleted'
         AND (storage_provider != 'bunny' OR COALESCE(storage_zone, '') != ?)`,
      [zone.name]
    ),
    db.get(
      `SELECT COUNT(*) AS total
       FROM media_assets
       WHERE deleted_at IS NULL AND status != 'deleted'
         AND media_type = 'video' AND COALESCE(stream_video_id, '') != ''`
    )
  ])
  const totalAssets = Number(assetCountRow?.total) || 0
  const totalVideos = Number(streamCountRow?.total) || 0
  const sameStorageAsManaged = storageZoneBelongsToCurrentConfig(zone, currentConfig)
  const sameStreamAsManaged = libraryBelongsToCurrentConfig(library, currentConfig)
  const needsMigration = !sameStorageAsManaged && totalAssets > 0
  const needsStreamMigration = !sameStreamAsManaged && totalVideos > 0
  const migration = {
    direction: 'to_customer',
    status: needsMigration || needsStreamMigration ? 'pending' : 'completed',
    totalAssets,
    migratedAssets: needsMigration ? 0 : totalAssets,
    failedAssets: 0,
    totalVideos,
    migratedVideos: needsStreamMigration ? 0 : totalVideos,
    failedVideos: 0,
    warnings: [],
    startedAt: needsMigration || needsStreamMigration ? null : nowUtcIso(),
    completedAt: needsMigration || needsStreamMigration ? null : nowUtcIso(),
    updatedAt: nowUtcIso()
  }

  const integration = integrationPayloadFromProvisioned({
    apiKey,
    zone,
    pullZone,
    library,
    currentConfig,
    migration,
    previous
  })
  await writeEncryptedIntegration(integration)
  return integration
}

export async function updateBunnyAccountIntegration(updater) {
  const current = await readBunnyAccountIntegration()
  if (!current) throw integrationError('Bunny.net no está conectado.', 404, 'bunny_not_connected')
  const next = typeof updater === 'function' ? updater(structuredClone(current)) : { ...current, ...updater }
  next.updatedAt = nowUtcIso()
  return writeEncryptedIntegration(next)
}

export async function clearBunnyAccountIntegration() {
  await deleteEncryptedIntegration()
}

export async function getBunnyAccountIntegrationStatus() {
  const integration = await readBunnyAccountIntegration()
  if (!integration) {
    return {
      configured: false,
      connected: false,
      state: 'not_connected',
      storageOwnedByCustomer: false,
      migration: null
    }
  }

  const migrationStatus = cleanString(integration.migration?.status) || 'completed'
  return {
    configured: true,
    connected: Boolean(integration.active && !integration.disconnecting),
    state: integration.disconnecting ? 'disconnecting' : migrationStatus,
    storageOwnedByCustomer: Boolean(integration.active),
    sameAsManagedStorage: Boolean(integration.sameStorageAsManaged),
    sameAsManagedStream: Boolean(integration.sameStreamAsManaged),
    storageZone: integration.storageZone || null,
    storageRegion: integration.storageRegion || null,
    cdnHostname: (() => {
      try { return new URL(integration.cdnBaseUrl).hostname } catch { return null }
    })(),
    streamLibraryName: integration.streamLibraryName || null,
    apiKeyPreview: integration.accountApiKey
      ? `••••${cleanString(integration.accountApiKey).slice(-4)}`
      : null,
    connectedAt: integration.connectedAt || null,
    updatedAt: integration.updatedAt || null,
    migration: integration.migration || null
  }
}

export async function prepareBunnyAccountDisconnect(managedConfig = {}) {
  const integration = await readBunnyAccountIntegration()
  if (!integration) return { disconnected: true, migrationRequired: false }
  if (['pending', 'running'].includes(cleanString(integration.migration?.status))) {
    throw integrationError(
      'La migración de Bunny.net sigue activa. Espera a que termine antes de desconectar la cuenta.',
      409,
      'bunny_migration_in_progress'
    )
  }

  const customConfig = bunnyIntegrationRuntimeConfig(integration)
  const sameStorage = cleanString(customConfig.bunnyStorageZone).toLowerCase()
    === cleanString(managedConfig.bunnyStorageZone).toLowerCase()
  const sameStream = cleanString(customConfig.bunnyStreamLibraryId)
    === cleanString(managedConfig.bunnyStreamLibraryId)
  if (sameStorage && sameStream) {
    await clearBunnyAccountIntegration()
    return { disconnected: true, migrationRequired: false }
  }
  if (!managedConfig?.bunnyConfigured) {
    throw integrationError(
      'El almacenamiento administrado no está disponible para recibir los archivos de regreso.',
      503,
      'managed_bunny_not_configured'
    )
  }

  const usedRow = await db.get(
    `SELECT COALESCE(SUM(quota_size), 0) AS used_bytes
     FROM media_assets WHERE deleted_at IS NULL AND status != 'deleted'`
  )
  const usedBytes = Number(usedRow?.used_bytes) || 0
  const managedUnlimited = Boolean(managedConfig.mediaAccountPolicy?.unlimitedQuota)
  const managedQuotaBytes = GB
  if (!managedUnlimited && usedBytes > managedQuotaBytes) {
    throw integrationError(
      'Tus archivos ya superan la cuota administrada de Ristak. Libera espacio antes de desconectar Bunny.net.',
      409,
      'managed_storage_quota_exceeded',
      { usedBytes, managedQuotaBytes }
    )
  }

  const [assetCountRow, videoCountRow] = await Promise.all([
    db.get(
      `SELECT COUNT(*) AS total FROM media_assets
       WHERE deleted_at IS NULL AND status != 'deleted'
         AND storage_provider = 'bunny' AND COALESCE(storage_zone, '') = ?`,
      [customConfig.bunnyStorageZone]
    ),
    db.get(
      `SELECT COUNT(*) AS total FROM media_assets
       WHERE deleted_at IS NULL AND status != 'deleted'
         AND media_type = 'video' AND COALESCE(stream_video_id, '') != ''`
    )
  ])
  const totalAssets = Number(assetCountRow?.total) || 0
  const totalVideos = Number(videoCountRow?.total) || 0
  if (
    totalVideos > 0
    && !sameStream
    && !managedConfig?.bunnyStreamConfigured
  ) {
    throw integrationError(
      'Bunny Stream administrado no está disponible para recibir los videos de regreso.',
      503,
      'managed_bunny_stream_not_configured'
    )
  }
  const next = {
    ...integration,
    active: false,
    disconnecting: true,
    migration: {
      direction: 'to_managed',
      status: totalAssets || totalVideos ? 'pending' : 'completed',
      totalAssets,
      migratedAssets: 0,
      failedAssets: 0,
      totalVideos,
      migratedVideos: 0,
      failedVideos: 0,
      warnings: [],
      startedAt: null,
      completedAt: null,
      updatedAt: nowUtcIso()
    }
  }
  await writeEncryptedIntegration(next)
  if (!totalAssets && !totalVideos) {
    await clearBunnyAccountIntegration()
    return { disconnected: true, migrationRequired: false }
  }
  return { disconnected: false, migrationRequired: true }
}

export const bunnyAccountIntegrationConfigKey = CONFIG_KEY
