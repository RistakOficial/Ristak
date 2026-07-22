import express from 'express'
import {
  getApiToken,
  revokeApiToken,
  rotateApiToken
} from '../controllers/authController.js'
import {
  getMcpAccessStatus,
  listMcpAudit,
  listMcpConnections,
  revokeMcpConnection
} from '../controllers/oauthConnectionsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireFeature('developers'))
router.use(requireModuleAccess('settings_api_access'))

router.get('/', getApiToken)
router.post('/token/rotate', rotateApiToken)
router.delete('/token', revokeApiToken)
router.get('/mcp/status', getMcpAccessStatus)
router.get('/mcp/connections', listMcpConnections)
router.get('/mcp/audit', listMcpAudit)
router.delete('/mcp/connections/:id', revokeMcpConnection)

export default router
