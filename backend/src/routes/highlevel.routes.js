import express from 'express'
import {
  testConnection,
  saveConfig,
  getConfig,
  syncData,
  syncConversations,
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
  createProduct,
  createPrice,
  updateProduct,
  deleteProduct,
  syncProducts,
  createInvoice,
  createInvoiceSchedule,
  listInvoiceSchedules,
  getInvoiceSchedule,
  updateInvoiceSchedule,
  actionInvoiceSchedule,
  createInstallmentFlow,
  recordPayment,
  sendInvoice,
  syncInvoice,
  text2Pay,
  searchContacts,
  getContactById,
  sendConversationMessage,
  saveInvoiceConfig,
  getLocationUsers,
  getUsersByIds
} from '../controllers/highlevelController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

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

// Conversations
router.post('/conversations/messages', sendConversationMessage)
router.post('/conversations/sync', syncConversations)

// Users
router.get('/users', getLocationUsers)
router.post('/users/by-ids', getUsersByIds)

// Invoice/Payment Configuration
router.post('/invoice-config', saveInvoiceConfig)

// Products and Payments
router.get('/products', listProducts)
router.post('/products', createProduct)
router.post('/products/sync', syncProducts)
router.put('/products/:productId', updateProduct)
router.delete('/products/:productId', deleteProduct)
router.get('/products/:productId/prices', listPrices)
router.post('/products/:productId/prices', createPrice)
router.post('/invoices', createInvoice)
router.get('/invoices/schedules', listInvoiceSchedules)
router.post('/invoices/schedules', createInvoiceSchedule)
router.get('/invoices/schedules/:scheduleId', getInvoiceSchedule)
router.put('/invoices/schedules/:scheduleId', updateInvoiceSchedule)
router.post('/invoices/schedules/:scheduleId/action', actionInvoiceSchedule)
router.post('/payment-flows/installments', createInstallmentFlow)
router.post('/invoices/:invoiceId/send', sendInvoice)
router.post('/invoices/:invoiceId/record-payment', recordPayment)
router.post('/invoices/:invoiceId/sync', syncInvoice)
router.post('/text2pay', text2Pay)

export default router
