import express from 'express'
import { redirectTriggerLinkHandler } from '../controllers/triggerLinksController.js'

const router = express.Router()

router.get('/:publicId', redirectTriggerLinkHandler)

export default router
