import express from 'express'
import { backfillUserEmailsFromLegacyUsernames } from '../config/database.js'
import {
  internalStorageDiagnosticsHandler,
  internalStorageUsageHandler
} from '../controllers/mediaController.js'
import {
  deleteUser,
  listUsers,
  updateUser
} from '../controllers/userAccessController.js'

const router = express.Router()

function readBearerToken(header = '') {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requireInternalInstallerToken(req, res, next) {
  const expected = String(process.env.INTERNAL_INSTALLER_TOKEN || '').trim()
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: 'INTERNAL_INSTALLER_TOKEN no está configurado en esta app.'
    })
  }

  const received = String(req.headers['x-internal-installer-token'] || '').trim() ||
    readBearerToken(req.headers.authorization)

  if (!received || received !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Token interno inválido.'
    })
  }

  next()
}

router.use(requireInternalInstallerToken)

router.get('/storage/usage', internalStorageUsageHandler)
router.get('/storage/diagnostics', internalStorageDiagnosticsHandler)
router.get('/users', listUsers)
router.post('/users/email-backfill', async (req, res, next) => {
  try {
    const stats = await backfillUserEmailsFromLegacyUsernames({ source: 'internal-installer' })
    res.json({ success: true, stats })
  } catch (error) {
    next(error)
  }
})
router.patch('/users/:userId', updateUser)
router.delete('/users/:userId', deleteUser)

export default router
