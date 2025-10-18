import express from 'express'
import {
  saveConfig,
  getConfig,
  syncAds,
  getSyncProgressEndpoint,
  updateRecent,
  getCampaigns,
  getSpendOverTime,
  getSyncStatus,
  getContactsByType,
  verifyToken,
  getOAuthUrl,
  oauthCallback,
  getOAuthAdAccounts,
  saveOAuthAccount
} from '../controllers/metaController.js'

const router = express.Router()

// Configuración manual (legacy)
router.post('/config', saveConfig)
router.get('/config', getConfig)
router.get('/verify-token', verifyToken)

// OAuth (nuevo flujo recomendado)
router.get('/oauth/url', getOAuthUrl)                    // Generar URL de OAuth
router.get('/oauth/callback', oauthCallback)             // Callback de Meta
router.post('/oauth/ad-accounts', getOAuthAdAccounts)    // Listar cuentas
router.post('/oauth/save', saveOAuthAccount)             // Guardar cuenta seleccionada

// Sincronización
router.post('/sync', syncAds)
router.get('/sync/progress', getSyncProgressEndpoint)
router.get('/sync/status', getSyncStatus)
router.post('/update-recent', updateRecent)

// Datos
router.get('/campaigns', getCampaigns)
router.get('/spend-over-time', getSpendOverTime)
router.get('/contacts', getContactsByType)

export default router
