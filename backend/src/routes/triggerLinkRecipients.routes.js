import express from 'express'
import { redirectTriggerLinkRecipientHandler } from '../controllers/triggerLinksController.js'

const router = express.Router()
const RECIPIENT_TOKEN_PATTERN = /^pce1_[A-Za-z0-9_-]+$/

router.get('/:recipientToken', (req, res, next) => {
  if (!RECIPIENT_TOKEN_PATTERN.test(String(req.params.recipientToken || ''))) return next()
  return redirectTriggerLinkRecipientHandler(req, res)
})

export default router
