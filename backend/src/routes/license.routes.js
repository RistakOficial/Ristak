import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireAdmin, requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  acceptCentralAccountRetentionOffer,
  getCentralAccountCancellationStatus,
  getLicenseState,
  isLicenseEnforced,
  requestCentralAccountCancellation
} from '../services/licenseService.js'

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
      expires_at: state.expiresAt || null
    })
  } catch (error) {
    next(error)
  }
})

const requireAccountCancellationAccess = [requireAuth, requireAdmin, requireModuleAccess('settings_account')]

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
