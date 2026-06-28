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
import { requireAdmin } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
// (GHL-007) Decisión del dueño: restringir a solo admin las rutas de ADMINISTRACIÓN de
// HighLevel (conectar/guardar/borrar config, disparar sincronizaciones, revelar token,
// etiquetas/config de facturación). NO se gatean a admin las rutas OPERATIVAS que usan
// los empleados desde chat/pagos/citas (getConfig, integration-status, enviar mensaje,
// buscar/ver contactos, productos/facturas/cobros), para no romper su trabajo diario.

router.post('/test-connection', requireAdmin, testConnection)
router.post('/test', requireAdmin, testConnection) // Alias para compatibilidad
router.post('/config', requireAdmin, saveConfig)
router.get('/config', getConfig)
router.delete('/config', requireAdmin, deleteConfig)
// (GHL-001) Revelar el token maestro de HighLevel queda restringido a admin
// (antes cualquier usuario autenticado podía obtenerlo) y se audita en el controlador.
router.get('/config/reveal/api_token', requireAdmin, revealToken)
router.get('/integration-status', getIntegrationStatus)
router.post('/refresh-location', requireAdmin, refreshLocationData)
router.post('/sync', requireAdmin, syncData)
router.get('/sync/progress', getSyncProgressEndpoint)
router.post('/sync-custom-values', requireAdmin, syncCustomValues)
router.post('/sync-contacts', requireAdmin, syncContacts)
router.get('/custom-labels', getCustomLabels)
router.post('/custom-labels', requireAdmin, updateCustomLabels)

// Contacts
router.post('/contacts/search', searchContacts)
router.get('/contacts/:id', getContactById)

// Conversations
router.post('/conversations/messages', sendConversationMessage)
router.post('/conversations/sync', requireAdmin, syncConversations)

// Users
router.get('/users', getLocationUsers)
router.post('/users/by-ids', getUsersByIds)

// Invoice/Payment Configuration (administración)
router.post('/invoice-config', requireAdmin, saveInvoiceConfig)

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
