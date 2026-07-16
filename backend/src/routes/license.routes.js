import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireAdmin, requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  acceptCentralAccountRetentionOffer,
  decideCentralDatabaseStorage,
  getCentralDatabaseStorageStatus,
  getCentralAccountCancellationStatus,
  getLicenseState,
  isLicenseEnforced,
  requestCentralAccountCancellation
} from '../services/licenseService.js'
import { getStorageStatus as getDatabaseStorageStatus } from '../services/notificationsService.js'

const router = express.Router()

/**
 * GET /api/license/status - Estado de licencia y features para el frontend.
 * Si el usuario llegó aquí, requireAuth ya validó que la licencia está activa.
 */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const state = await getLicenseState({ email: req.user?.email || null })

    res.json({
      success: true,
      enforced: isLicenseEnforced(),
      allowed: state.allowed,
      plan: state.plan || null,
      features: state.features || {},
      limits: state.limits || {},
      expires_at: state.expiresAt || null
    })
  } catch (error) {
    next(error)
  }
})

const requireAccountCancellationAccess = [requireAuth, requireAdmin, requireModuleAccess('settings_account')]
const requireDatabaseStorageAccess = [requireAuth, requireAdmin, requireModuleAccess('settings_account')]

function localStorageFallback(storage, message = '') {
  const percentUsed = Number(storage.percentUsed || 0)
  return {
    success: true,
    managed: false,
    managementAvailable: false,
    sizeGB: Number(storage.sizeGB.toFixed(2)),
    sizePretty: storage.sizePretty,
    usedBytes: Number(storage.sizeBytes || 0),
    limitGB: storage.limitGB,
    currentDiskSizeGB: storage.limitGB,
    targetDiskSizeGB: null,
    percentUsed: Math.round(percentUsed * 10) / 10,
    warningThreshold: 80,
    autoscaleThreshold: 90,
    needsAttention: percentUsed >= 80,
    needsDecision: false,
    decision: 'unavailable',
    autoscalingEnabled: false,
    managementMessage: message
  }
}

function managedStorageResponse(storage, central) {
  return {
    success: true,
    managed: central.managed === true,
    managementAvailable: true,
    sizeGB: Number(storage.sizeGB.toFixed(2)),
    sizePretty: storage.sizePretty,
    usedBytes: Number(storage.sizeBytes || 0),
    limitGB: Number(central.current_disk_size_gb),
    currentDiskSizeGB: Number(central.current_disk_size_gb),
    targetDiskSizeGB: Number(central.target_disk_size_gb),
    percentUsed: Number(central.usage_percent),
    warningThreshold: Number(central.warning_threshold_percent),
    autoscaleThreshold: Number(central.autoscale_threshold_percent),
    needsAttention: central.needs_attention === true,
    needsDecision: central.needs_decision === true,
    decision: central.decision,
    decidedAt: central.decided_at || null,
    autoscalingEnabled: central.autoscaling_enabled === true,
    autoscalingPausedForDecision: central.autoscaling_paused_for_decision === true,
    renderPricing: central.render_pricing || null
  }
}

// Es POST porque consultar una oferta pendiente puede pausar el autoscaling en
// Render. No debe ejecutarse por cache, prefetch ni semántica de lectura pura.
router.post('/database-storage/status', ...requireDatabaseStorageAccess, async (_req, res, next) => {
  try {
    const storage = await getDatabaseStorageStatus()
    if (!isLicenseEnforced()) {
      return res.json(localStorageFallback(storage, 'Esta instalación no está administrada por Ristak Installer.'))
    }

    try {
      const central = await getCentralDatabaseStorageStatus({ usedBytes: storage.sizeBytes })
      return res.json(managedStorageResponse(storage, central))
    } catch (error) {
      return res.json(localStorageFallback(storage, error.message))
    }
  } catch (error) {
    next(error)
  }
})

router.post('/database-storage/decision', ...requireDatabaseStorageAccess, async (req, res, next) => {
  try {
    const storage = await getDatabaseStorageStatus()
    const central = await decideCentralDatabaseStorage({
      decision: req.body?.decision,
      currentDiskSizeGB: req.body?.current_disk_size_gb,
      targetDiskSizeGB: req.body?.target_disk_size_gb,
      usedBytes: storage.sizeBytes,
      requestedByEmail: req.user?.email || req.user?.username || ''
    })
    res.json(managedStorageResponse(storage, central))
  } catch (error) {
    if (error?.status || error?.code) {
      return res.status(Number(error.status || 400)).json({
        success: false,
        code: error.code || 'database_storage_decision_failed',
        message: error.message
      })
    }
    next(error)
  }
})

router.get('/account-cancellation/status', ...requireAccountCancellationAccess, async (_req, res, next) => {
  try {
    const data = await getCentralAccountCancellationStatus()
    res.json(data)
  } catch (error) {
    next(error)
  }
})

router.post('/account-cancellation/retention', ...requireAccountCancellationAccess, async (_req, res, next) => {
  try {
    const data = await acceptCentralAccountRetentionOffer()
    res.json(data)
  } catch (error) {
    next(error)
  }
})

router.post('/account-cancellation/cancel', ...requireAccountCancellationAccess, async (req, res, next) => {
  try {
    const data = await requestCentralAccountCancellation({
      reasonKey: req.body?.reason_key || req.body?.reasonKey,
      reasonDetails: req.body?.reason_details || req.body?.reasonDetails
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

export default router
