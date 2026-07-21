import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { signCentralBrokerRegistrationProof, normalizeCentralBrokerOrigin } from '../services/centralBrokerService.js'
import { getRequestBaseUrl } from '../utils/publicUrl.js'

const router = express.Router()

const proofRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === '1',
  keyGenerator: req => ipKeyGenerator(req.ip),
  handler: (_req, res) => res.status(429).json({
    success: false,
    code: 'central_broker_rate_limited',
    message: 'Demasiados intentos de registro técnico. Espera unos minutos.'
  })
})

router.post('/registration-proof', proofRateLimiter, async (req, res, next) => {
  try {
    const challenge = String(req.body?.challenge || '').trim()
    const version = String(req.body?.version || '').trim()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(challenge) || version !== 'ristak-broker-registration-v1') {
      return res.status(400).json({
        success: false,
        code: 'central_broker_challenge_invalid',
        message: 'La solicitud de registro técnico no es válida.'
      })
    }

    const requestOrigin = normalizeCentralBrokerOrigin(getRequestBaseUrl(req), { label: 'El origen de esta instalación' })
    const requestedOrigin = normalizeCentralBrokerOrigin(req.body?.app_url || req.body?.appUrl, { label: 'La URL solicitada' })
    if (requestOrigin !== requestedOrigin) {
      return res.status(403).json({
        success: false,
        code: 'central_broker_origin_mismatch',
        message: 'La prueba sólo puede firmarse para el origen público que recibió la solicitud.'
      })
    }

    const proof = await signCentralBrokerRegistrationProof({
      challenge,
      appUrl: requestedOrigin,
      publicKey: req.body?.public_key || req.body?.publicKey
    })
    res.json({ success: true, ...proof })
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({
        success: false,
        code: error.code || 'central_broker_proof_error',
        message: error.message
      })
    }
    next(error)
  }
})

export default router
