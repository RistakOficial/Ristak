import express from 'express'
import { getMdpProgramNavigationForUser } from '../services/mdpProgramBridgeService.js'

const router = express.Router()

router.get('/navigation', async (req, res, next) => {
  try {
    const navigation = await getMdpProgramNavigationForUser(req.user || {})
    res.json({ success: true, ...navigation })
  } catch (error) {
    next(error)
  }
})

export default router
