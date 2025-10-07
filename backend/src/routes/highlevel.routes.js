import express from 'express'
import {
  testConnection,
  saveConfig,
  getConfig,
  syncData,
  getSyncProgressEndpoint,
  getIntegrationStatus,
  revealToken,
  syncCustomValues,
  syncContacts,
  deleteConfig,
  refreshLocationData,
  getCustomLabels,
  updateCustomLabels,
  listProducts,
  listPrices,
  createInvoice,
  recordPayment,
  searchContacts
} from '../controllers/highlevelController.js'

const router = express.Router()

router.post('/test-connection', testConnection)
router.post('/test', testConnection) // Alias para compatibilidad
router.post('/config', saveConfig)
router.get('/config', getConfig)
router.delete('/config', deleteConfig)
router.get('/config/reveal/api_token', revealToken)
router.get('/integration-status', getIntegrationStatus)
router.post('/refresh-location', refreshLocationData)
router.post('/sync', syncData)
router.get('/sync/progress', getSyncProgressEndpoint)
router.post('/sync-custom-values', syncCustomValues)
router.post('/sync-contacts', syncContacts)
router.get('/custom-labels', getCustomLabels)
router.post('/custom-labels', updateCustomLabels)

// Contacts
router.post('/contacts/search', searchContacts)

// Products and Payments
router.get('/products', listProducts)
router.get('/products/:productId/prices', listPrices)
router.post('/invoices', createInvoice)
router.post('/invoices/:invoiceId/record-payment', recordPayment)

export default router
