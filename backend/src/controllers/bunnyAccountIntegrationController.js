import {
  getBunnyAccountIntegrationStatus,
  prepareBunnyAccountDisconnect,
  provisionBunnyAccount
} from '../services/bunnyAccountIntegrationService.js'
import {
  retryBunnyStorageMigration,
  scheduleBunnyStorageMigration
} from '../services/bunnyStorageMigrationService.js'
import {
  getManagedStorageRuntimeConfig,
  resetCentralStorageConfigCache
} from '../services/mediaStorageService.js'
import { db } from '../config/database.js'

const MUTATION_LOCK_NAME = 'bunny-account-integration-mutation'

async function withBunnyMutationLock(operation) {
  try {
    return await db.withAdvisoryLock(MUTATION_LOCK_NAME, operation)
  } catch (error) {
    if (error?.code !== 'DATABASE_ADVISORY_LOCK_BUSY') throw error
    throw Object.assign(
      new Error('Otra operación de Bunny.net sigue en curso. Espera unos segundos y vuelve a intentar.'),
      { status: 409, code: 'bunny_integration_busy' }
    )
  }
}

function sendError(res, error, fallback) {
  res.status(error?.status || 500).json({
    success: false,
    error: error?.message || fallback,
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.details ? { details: error.details } : {})
  })
}

export async function getBunnyAccountStatusHandler(_req, res) {
  try {
    const status = await getBunnyAccountIntegrationStatus()
    if (['pending', 'running'].includes(status.migration?.status)) {
      scheduleBunnyStorageMigration()
    }
    res.json({ success: true, data: status })
  } catch (error) {
    sendError(res, error, 'No se pudo leer la conexión de Bunny.net.')
  }
}

export async function connectBunnyAccountHandler(req, res) {
  try {
    const apiKey = req.body?.apiKey || req.body?.api_key || ''
    const integration = await withBunnyMutationLock(async () => {
      const currentConfig = await getManagedStorageRuntimeConfig()
      return provisionBunnyAccount(apiKey, currentConfig)
    })
    resetCentralStorageConfigCache()
    if (integration.migration?.status === 'pending') scheduleBunnyStorageMigration()
    res.status(201).json({
      success: true,
      data: await getBunnyAccountIntegrationStatus()
    })
  } catch (error) {
    sendError(res, error, 'No se pudo conectar la cuenta de Bunny.net.')
  }
}

export async function retryBunnyMigrationHandler(_req, res) {
  try {
    await withBunnyMutationLock(() => retryBunnyStorageMigration())
    res.status(202).json({
      success: true,
      data: await getBunnyAccountIntegrationStatus()
    })
  } catch (error) {
    sendError(res, error, 'No se pudo reintentar la migración de Bunny.net.')
  }
}

export async function disconnectBunnyAccountHandler(_req, res) {
  try {
    const result = await withBunnyMutationLock(async () => {
      const managedConfig = await getManagedStorageRuntimeConfig()
      return prepareBunnyAccountDisconnect(managedConfig)
    })
    resetCentralStorageConfigCache()
    if (result.migrationRequired) scheduleBunnyStorageMigration()
    res.status(result.migrationRequired ? 202 : 200).json({
      success: true,
      data: {
        ...result,
        status: await getBunnyAccountIntegrationStatus()
      }
    })
  } catch (error) {
    sendError(res, error, 'No se pudo desconectar la cuenta de Bunny.net.')
  }
}
