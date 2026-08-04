import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { logger } from '../utils/logger.js'
import {
  getInstallerSignatureHeaders,
  verifyInstallerSignedRequest
} from '../services/installerSignatureService.js'
import { handleInstallerCustomerOperationsMessage } from '../services/installerCustomerOperationsService.js'

const router = express.Router()

router.post('/mcp', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === '1'
}), async (req, res) => {
  try {
    const verified = await verifyInstallerSignedRequest({
      rawBody: req.rawBody || '',
      headers: getInstallerSignatureHeaders(req),
      purpose: 'customer_operations_mcp'
    })
    req.installerCustomerOperations = {
      installationId: verified.installationId
    }
    const response = await handleInstallerCustomerOperationsMessage(req, req.body)
    res.set('Cache-Control', 'no-store')
    res.json(response)
  } catch (error) {
    const status = Number(error?.statusCode) || 500
    if (status >= 500) logger.error(`[Installer Customer Operations] ${error?.message || 'Error desconocido'}`)
    res.status(status).json({
      success: false,
      code: error?.code || 'installer_customer_operations_failed',
      message: status >= 500 ? 'No se pudo ejecutar la operación delegada.' : error.message
    })
  }
})

export default router
