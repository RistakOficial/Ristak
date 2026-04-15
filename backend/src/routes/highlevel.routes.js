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
  sendInvoice,
  syncInvoice,
  text2Pay,
  getContactPaymentMethods,
  chargeSavedPaymentMethod,
  searchContacts,
  getContactById,
  saveStripeConfig,
  getStripeConfig,
  saveInvoiceConfig,
  getLocationUsers,
  getUsersByIds
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
router.get('/contacts/:id', getContactById)

// Users
router.get('/users', getLocationUsers)
router.post('/users/by-ids', getUsersByIds)

// Stripe Configuration
router.post('/stripe-config', saveStripeConfig)
router.get('/stripe-config', getStripeConfig)

// Invoice/Payment Configuration
router.post('/invoice-config', saveInvoiceConfig)

// Products and Payments
router.get('/products', listProducts)
router.get('/products/:productId/prices', listPrices)
router.post('/invoices', createInvoice)
router.post('/invoices/:invoiceId/send', sendInvoice)
router.post('/invoices/:invoiceId/record-payment', recordPayment)
router.post('/invoices/:invoiceId/sync', syncInvoice)
router.post('/text2pay', text2Pay)
router.get('/payment-methods/contact/:contactId', getContactPaymentMethods)
router.post('/payment-methods/charge', chargeSavedPaymentMethod)

export default router
