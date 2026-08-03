import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  decideMcpActionConfirmation,
  getMcpActionConfirmationForUser
} from '../services/mcpActionConfirmationService.js'
import { getMcpToolMetadata } from '../mcp/toolRegistry.js'

const router = express.Router()

router.use(requireAuth, requireFeature('developers'), requireModuleAccess('settings_api_access'))
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  res.set('Pragma', 'no-cache')
  res.set('Referrer-Policy', 'no-referrer')
  next()
})

function sendError(res, error) {
  res.status(error?.status || 500).json({
    success: false,
    code: error?.code || 'mcp_confirmation_error',
    message: String(error?.message || 'No se pudo procesar la aprobación.').slice(0, 500)
  })
}

router.post('/context', async (req, res) => {
  try {
    const ticket = String(req.body?.ticket || '')
    const preliminary = await getMcpActionConfirmationForUser(req.user.userId, ticket)
    const metadata = getMcpToolMetadata(preliminary.toolName)
    const confirmation = metadata
      ? await getMcpActionConfirmationForUser(req.user.userId, ticket, metadata)
      : preliminary
    res.json({ success: true, confirmation })
  } catch (error) {
    sendError(res, error)
  }
})

router.post('/decision', async (req, res) => {
  try {
    const ticket = String(req.body?.ticket || '')
    const decision = String(req.body?.decision || '')
    const preliminary = await getMcpActionConfirmationForUser(req.user.userId, ticket)
    const metadata = getMcpToolMetadata(preliminary.toolName) || {}
    const confirmation = await decideMcpActionConfirmation(
      req.user.userId,
      ticket,
      decision,
      metadata
    )
    res.json({ success: true, confirmation })
  } catch (error) {
    sendError(res, error)
  }
})

export default router
