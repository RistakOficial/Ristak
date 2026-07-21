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
import { requireAdmin, requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
import { listHighLevelPhoneNumbers } from '../controllers/highlevelPhoneNumbersController.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireFeature('highlevel_integration'))
// (GHL-007) Decisión del dueño: restringir a solo admin las rutas de ADMINISTRACIÓN de
// HighLevel (conectar/guardar/borrar config, disparar sincronizaciones, revelar token,
// etiquetas/config de facturación). NO se gatean a admin las rutas OPERATIVAS que usan
// los empleados desde chat/pagos/citas (getConfig, integration-status, enviar mensaje,
// buscar/ver contactos, productos/facturas/cobros), para no romper su trabajo diario.

router.post('/test-connection', requireAdmin, requireModuleAccess('settings_integrations'), testConnection)
router.post('/test', requireAdmin, requireModuleAccess('settings_integrations'), testConnection) // Alias para compatibilidad
router.post('/config', requireAdmin, requireModuleAccess('settings_integrations'), saveConfig)
router.get('/config', requireModuleAccess('settings_integrations'), getConfig)
router.delete('/config', requireAdmin, requireModuleAccess('settings_integrations'), deleteConfig)
// (GHL-001) Revelar el token maestro de HighLevel queda restringido a admin
// (antes cualquier usuario autenticado podía obtenerlo) y se audita en el controlador.
router.get('/config/reveal/api_token', requireAdmin, requireModuleAccess('settings_integrations'), revealToken)
router.get('/integration-status', requireModuleAccess('settings_integrations'), getIntegrationStatus)
router.post('/refresh-location', requireAdmin, requireModuleAccess('settings_integrations'), refreshLocationData)
router.post('/sync', requireAdmin, requireModuleAccess('settings_integrations'), syncData)
router.get('/sync/progress', requireModuleAccess('settings_integrations'), getSyncProgressEndpoint)
router.post('/sync-custom-values', requireAdmin, requireModuleAccess('settings_integrations'), syncCustomValues)
router.post('/sync-contacts', requireAdmin, requireModuleAccess('settings_integrations'), syncContacts)
router.get('/custom-labels', requireModuleAccess('settings_integrations'), getCustomLabels)
router.post('/custom-labels', requireAdmin, requireModuleAccess('settings_integrations'), updateCustomLabels)

// Contacts
router.post('/contacts/search', requireModuleAccess('contacts'), searchContacts)
router.get('/contacts/:id', requireModuleAccess('contacts'), getContactById)

// Conversations
router.get('/phone-numbers', requireModuleAccess('chat'), listHighLevelPhoneNumbers)
router.post('/conversations/messages', requireModuleAccess('chat'), sendConversationMessage)
router.post('/conversations/sync', requireAdmin, requireModuleAccess('chat'), syncConversations)

// Users
router.get('/users', requireModuleAccess('settings_users'), getLocationUsers)
router.post('/users/by-ids', requireModuleAccess('settings_users'), getUsersByIds)

// Invoice/Payment Configuration (administración)
router.post('/invoice-config', requireAdmin, requireModuleAccess('settings_payments'), saveInvoiceConfig)

// Products and Payments
router.get('/products', requireModuleAccess('payments'), listProducts)
router.post('/products', requireModuleAccess('payments'), createProduct)
router.post('/products/sync', requireModuleAccess('payments'), syncProducts)
router.put('/products/:productId', requireModuleAccess('payments'), updateProduct)
router.delete('/products/:productId', requireModuleAccess('payments'), deleteProduct)
router.get('/products/:productId/prices', requireModuleAccess('payments'), listPrices)
router.post('/products/:productId/prices', requireModuleAccess('payments'), createPrice)
router.post('/invoices', requireModuleAccess('payments'), createInvoice)
router.get('/invoices/schedules', requireModuleAccess('payments'), requireFeature('payment_plans'), listInvoiceSchedules)
router.post('/invoices/schedules', requireModuleAccess('payments'), requireFeature('payment_plans'), createInvoiceSchedule)
router.get('/invoices/schedules/:scheduleId', requireModuleAccess('payments'), requireFeature('payment_plans'), getInvoiceSchedule)
router.put('/invoices/schedules/:scheduleId', requireModuleAccess('payments'), requireFeature('payment_plans'), updateInvoiceSchedule)
router.post('/invoices/schedules/:scheduleId/action', requireModuleAccess('payments'), requireFeature('payment_plans'), actionInvoiceSchedule)
router.post('/payment-flows/installments', requireModuleAccess('payments'), requireFeature('payment_plans'), createInstallmentFlow)
router.post('/invoices/:invoiceId/send', requireModuleAccess('payments'), requireFeature('payment_links'), sendInvoice)
router.post('/invoices/:invoiceId/record-payment', requireModuleAccess('payments'), recordPayment)
router.post('/invoices/:invoiceId/sync', requireModuleAccess('payments'), syncInvoice)
router.post('/text2pay', requireModuleAccess('payments'), requireFeature('payment_links'), text2Pay)

export default router
