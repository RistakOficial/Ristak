import { db } from '../config/database.js'
import { normalizeToUtcIso } from '../utils/dateUtils.js'
import { logger } from '../utils/logger.js'
import {
  bunnyIntegrationRuntimeConfig,
  clearBunnyAccountIntegration,
  readBunnyAccountIntegration,
  updateBunnyAccountIntegration
} from './bunnyAccountIntegrationService.js'
import {
  getManagedStorageRuntimeConfig,
  migrateMediaAssetBunnyStream,
  migrateMediaAssetToBunnyStorage,
  resetCentralStorageConfigCache,
  retryMediaAssetSourceCleanup,
  retryMediaAssetStreamSourceCleanup
} from './mediaStorageService.js'

const MIGRATION_BATCH_SIZE = 10
const MIGRATION_LOCK_NAME = 'bunny-account-storage-migration'
let migrationPromise = null

function cleanString(value = '') {
  return String(value || '').trim()
}

function nowUtcIso() {
  return normalizeToUtcIso(new Date())
}

function migrationWarning(error, assetId = '') {
  return {
    assetId: cleanString(assetId) || null,
    code: cleanString(error?.code) || 'bunny_migration_failed',
    message: cleanString(error?.message).slice(0, 240) || 'No se pudo migrar el archivo.'
  }
}

async function patchMigration(patch) {
  return updateBunnyAccountIntegration((integration) => ({
    ...integration,
    migration: {
      ...(integration.migration || {}),
      ...patch,
      updatedAt: nowUtcIso()
    }
  }))
}

async function storageMigrationRows(targetStorageZone, ignoredIds = []) {
  const clauses = [
    'deleted_at IS NULL',
    "status != 'deleted'",
    "(storage_provider != 'bunny' OR COALESCE(storage_zone, '') != ?)"
  ]
  const params = [targetStorageZone]
  if (ignoredIds.length) {
    clauses.push(`id NOT IN (${ignoredIds.map(() => '?').join(', ')})`)
    params.push(...ignoredIds)
  }
  return db.all(
    `SELECT id, storage_provider, storage_zone, media_type
     FROM media_assets
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [...params, MIGRATION_BATCH_SIZE]
  )
}

async function countStorageRows(targetStorageZone) {
  const row = await db.get(
    `SELECT COUNT(*) AS total
     FROM media_assets
     WHERE deleted_at IS NULL AND status != 'deleted'
       AND (storage_provider != 'bunny' OR COALESCE(storage_zone, '') != ?)`,
    [targetStorageZone]
  )
  return Number(row?.total) || 0
}

async function sourceCleanupRows() {
  const rows = await db.all(
    `SELECT id, metadata_json
     FROM media_assets
     WHERE deleted_at IS NULL AND status != 'deleted'
       AND metadata_json LIKE '%"storageMigration":%'
       AND metadata_json LIKE '%"sourceDeleted":false%'
     ORDER BY updated_at ASC, id ASC`
  )
  return rows.filter((row) => {
    try {
      return JSON.parse(row.metadata_json || '{}')?.storageMigration?.sourceDeleted === false
    } catch {
      return false
    }
  }).slice(0, MIGRATION_BATCH_SIZE)
}

async function runSourceCleanupPhase({ sourceConfig, warnings }) {
  let failedCleanups = 0
  while (true) {
    const rows = await sourceCleanupRows()
    if (!rows.length) break
    let cleanedThisBatch = 0
    for (const row of rows) {
      try {
        const result = await retryMediaAssetSourceCleanup(row.id, { sourceConfig })
        if (result.cleaned) cleanedThisBatch += 1
      } catch (error) {
        failedCleanups += 1
        warnings.push(migrationWarning(error, row.id))
        logger.warn(`[BunnyMigration] No se pudo limpiar el origen de ${row.id}: ${error.message}`)
      }
    }
    if (!cleanedThisBatch) break
  }
  return {
    failedCleanups,
    remainingCleanups: (await sourceCleanupRows()).length,
    warnings: warnings.slice(-25)
  }
}

async function streamMigrationRows(targetLibraryId) {
  const rows = await db.all(
    `SELECT id, metadata_json
     FROM media_assets
     WHERE deleted_at IS NULL AND status != 'deleted'
       AND media_type = 'video'
     ORDER BY created_at ASC, id ASC`
  )
  return rows.filter((row) => {
    try {
      const metadata = JSON.parse(row.metadata_json || '{}')
      const stream = metadata?.stream || {}
      const migrationSource = stream.migrationSource || null
      const currentLibraryId = cleanString(stream.libraryId)
      const currentVideoId = cleanString(stream.videoId)
      return Boolean(
        (currentVideoId && currentLibraryId !== cleanString(targetLibraryId))
        || (migrationSource && currentLibraryId === cleanString(targetLibraryId) && !currentVideoId)
      )
    } catch {
      return true
    }
  })
}

async function streamSourceCleanupRows() {
  const rows = await db.all(
    `SELECT id, metadata_json
     FROM media_assets
     WHERE deleted_at IS NULL AND status != 'deleted'
       AND media_type = 'video'
       AND metadata_json LIKE '%"migrationSource":%'
       AND metadata_json LIKE '%"sourceDeleted":false%'
     ORDER BY updated_at ASC, id ASC`
  )
  return rows.filter((row) => {
    try {
      return JSON.parse(row.metadata_json || '{}')?.stream?.migrationSource?.sourceDeleted === false
    } catch {
      return false
    }
  }).slice(0, MIGRATION_BATCH_SIZE)
}

async function runStreamSourceCleanupPhase({ sourceConfig, warnings }) {
  let failedCleanups = 0
  while (true) {
    const rows = await streamSourceCleanupRows()
    if (!rows.length) break
    let cleanedThisBatch = 0
    for (const row of rows) {
      try {
        const result = await retryMediaAssetStreamSourceCleanup(row.id, { sourceConfig })
        if (result.cleaned) cleanedThisBatch += 1
      } catch (error) {
        failedCleanups += 1
        warnings.push(migrationWarning(error, row.id))
        logger.warn(`[BunnyMigration] No se pudo limpiar Stream anterior de ${row.id}: ${error.message}`)
      }
    }
    if (!cleanedThisBatch) break
  }
  return {
    failedCleanups,
    remainingCleanups: (await streamSourceCleanupRows()).length,
    warnings: warnings.slice(-25)
  }
}

async function runStoragePhase({ sourceConfig, targetConfig, migration }) {
  const ignoredIds = []
  let migratedAssets = Number(migration.migratedAssets) || 0
  let failedAssets = 0
  const warnings = Array.isArray(migration.warnings) ? [...migration.warnings].slice(-20) : []

  while (true) {
    const rows = await storageMigrationRows(targetConfig.bunnyStorageZone, ignoredIds)
    if (!rows.length) break

    for (const row of rows) {
      try {
        const result = await migrateMediaAssetToBunnyStorage(row.id, {
          sourceConfig,
          targetConfig,
          deleteSource: true
        })
        if (result.migrated) migratedAssets += 1
        if (result.sourceDeleteError) warnings.push(migrationWarning({
          code: 'bunny_source_cleanup_failed',
          message: result.sourceDeleteError
        }, row.id))
      } catch (error) {
        ignoredIds.push(row.id)
        failedAssets += 1
        warnings.push(migrationWarning(error, row.id))
        logger.warn(`[BunnyMigration] No se pudo migrar Storage ${row.id}: ${error.message}`)
      }
    }

    await patchMigration({
      phase: 'storage',
      migratedAssets,
      failedAssets,
      warnings: warnings.slice(-25)
    })
    if (ignoredIds.length >= MIGRATION_BATCH_SIZE * 5) break
  }

  return {
    migratedAssets,
    failedAssets,
    warnings: warnings.slice(-25),
    remainingAssets: await countStorageRows(targetConfig.bunnyStorageZone)
  }
}

async function runStreamPhase({ sourceConfig, targetConfig, migration, warnings }) {
  const rows = await streamMigrationRows(targetConfig.bunnyStreamLibraryId)
  let migratedVideos = Number(migration.migratedVideos) || 0
  let failedVideos = 0

  for (const row of rows) {
    try {
      const result = await migrateMediaAssetBunnyStream(row.id, {
        sourceConfig,
        targetConfig
      })
      if (result.migrated) migratedVideos += 1
      if (result.pending) {
        failedVideos += 1
        warnings.push({
          assetId: row.id,
          code: 'bunny_stream_migration_pending',
          message: 'Bunny Stream aceptó el video, pero todavía no publica su nueva identidad.'
        })
      }
      if (result.sourceDeleteError) warnings.push(migrationWarning({
        code: 'bunny_stream_source_cleanup_failed',
        message: result.sourceDeleteError
      }, row.id))
    } catch (error) {
      failedVideos += 1
      warnings.push(migrationWarning(error, row.id))
      logger.warn(`[BunnyMigration] No se pudo migrar Stream ${row.id}: ${error.message}`)
    }

    await patchMigration({
      phase: 'stream',
      migratedVideos,
      failedVideos,
      warnings: warnings.slice(-25)
    })
  }

  return {
    migratedVideos,
    failedVideos,
    warnings: warnings.slice(-25),
    remainingVideos: (await streamMigrationRows(targetConfig.bunnyStreamLibraryId)).length
  }
}

async function runMigration() {
  const integration = await readBunnyAccountIntegration()
  if (!integration?.migration || integration.migration.status === 'completed') return null

  const direction = integration.migration.direction === 'to_managed' ? 'to_managed' : 'to_customer'
  const managedConfig = await getManagedStorageRuntimeConfig()
  const customerConfig = bunnyIntegrationRuntimeConfig(integration)
  const sourceConfig = direction === 'to_customer' ? managedConfig : customerConfig
  const targetConfig = direction === 'to_customer' ? customerConfig : managedConfig
  if (!sourceConfig?.bunnyConfigured || !targetConfig?.bunnyConfigured) {
    throw Object.assign(new Error('El origen o destino Bunny.net no está disponible.'), {
      code: 'bunny_migration_config_missing'
    })
  }

  await patchMigration({
    status: 'running',
    phase: 'storage',
    startedAt: integration.migration.startedAt || nowUtcIso(),
    lastError: null
  })

  const storage = await runStoragePhase({
    sourceConfig,
    targetConfig,
    migration: integration.migration
  })
  const cleanup = storage.remainingAssets === 0
    ? await runSourceCleanupPhase({ sourceConfig, warnings: storage.warnings })
    : { failedCleanups: 0, remainingCleanups: 0, warnings: storage.warnings }
  const stream = storage.remainingAssets === 0 && cleanup.remainingCleanups === 0
    ? await runStreamPhase({
        sourceConfig,
        targetConfig,
        migration: integration.migration,
        warnings: cleanup.warnings
      })
    : {
        migratedVideos: Number(integration.migration.migratedVideos) || 0,
        failedVideos: 0,
        remainingVideos: await streamMigrationRows(targetConfig.bunnyStreamLibraryId).then((rows) => rows.length),
        warnings: cleanup.warnings
      }
  const streamCleanup = stream.remainingVideos === 0
    ? await runStreamSourceCleanupPhase({ sourceConfig, warnings: stream.warnings })
    : { failedCleanups: 0, remainingCleanups: 0, warnings: stream.warnings }

  const hasBlockingFailures = storage.remainingAssets > 0
    || cleanup.remainingCleanups > 0
    || stream.remainingVideos > 0
    || streamCleanup.remainingCleanups > 0
  if (hasBlockingFailures) {
    await patchMigration({
      status: 'needs_attention',
      phase: storage.remainingAssets > 0 ? 'storage' : 'stream',
      migratedAssets: storage.migratedAssets,
      failedAssets: storage.remainingAssets + cleanup.remainingCleanups,
      migratedVideos: stream.migratedVideos,
      failedVideos: stream.remainingVideos + streamCleanup.remainingCleanups,
      warnings: streamCleanup.warnings,
      lastError: 'Algunos archivos todavía no pudieron completar la migración.'
    })
    return { completed: false, storage, cleanup, stream, streamCleanup }
  }

  await patchMigration({
    status: 'completed',
    phase: 'completed',
    migratedAssets: Math.max(storage.migratedAssets, Number(integration.migration.totalAssets) || 0),
    failedAssets: 0,
    migratedVideos: Math.max(stream.migratedVideos, Number(integration.migration.totalVideos) || 0),
    failedVideos: 0,
    warnings: streamCleanup.warnings,
    completedAt: nowUtcIso(),
    lastError: null
  })

  if (direction === 'to_managed') {
    await clearBunnyAccountIntegration()
  }
  resetCentralStorageConfigCache()
  return { completed: true, storage, cleanup, stream, streamCleanup }
}

export function scheduleBunnyStorageMigration() {
  if (migrationPromise) return migrationPromise
  migrationPromise = new Promise((resolve) => {
    setImmediate(() => {
      db.withAdvisoryLock(MIGRATION_LOCK_NAME, () => runMigration())
        .then(resolve)
        .catch(async (error) => {
          if (error?.code === 'DATABASE_ADVISORY_LOCK_BUSY') {
            resolve({ completed: false, busy: true })
            return
          }
          logger.error(`[BunnyMigration] La migración se detuvo: ${error.message}`)
          await patchMigration({
            status: 'needs_attention',
            lastError: cleanString(error.message).slice(0, 240),
            warnings: [migrationWarning(error)]
          }).catch(() => undefined)
          resolve({ completed: false, error: error.message })
        })
        .finally(() => {
          migrationPromise = null
        })
    })
  })
  return migrationPromise
}

export async function retryBunnyStorageMigration() {
  const integration = await readBunnyAccountIntegration()
  if (!integration?.migration || integration.migration.status !== 'needs_attention') {
    throw Object.assign(new Error('Bunny.net no tiene una migración pendiente.'), {
      status: 409,
      code: 'bunny_migration_not_pending'
    })
  }
  await patchMigration({
    status: 'pending',
    failedAssets: 0,
    failedVideos: 0,
    lastError: null,
    warnings: []
  })
  scheduleBunnyStorageMigration()
  return { scheduled: true }
}

export function bunnyStorageMigrationRunning() {
  return Boolean(migrationPromise)
}
