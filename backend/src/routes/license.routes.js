import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { getLicenseState, isLicenseEnforced } from '../services/licenseService.js'

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

export default router
