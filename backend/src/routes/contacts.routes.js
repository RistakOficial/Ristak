import express from 'express'
import {
  getContacts,
  getContactById,
  createContact,
  createContactCustomFieldDefinition,
  getContactCustomFieldDefinitions,
  getChatContacts,
  searchContacts,
  getContactStats,
  getContactsChart,
  syncContactsStats,
  getContactPaymentLinkDeliveryOptions,
  updateContact,
  bulkUpdateContactTags,
  cancelBulkContactAction,
  createBulkAutomationAction,
  createBulkWhatsAppTemplateAction,
  deleteBulkContactAction,
  getBulkContactAction,
  listBulkContactActions,
  pauseBulkContactAction,
  rescheduleBulkContactAction,
  resumeBulkContactAction,
  updateContactCustomFieldDefinitionHandler,
  deleteContact,
  getTrashedContacts,
  restoreContact,
  permanentDeleteContact,
  getContactJourney,
  getContactWhatsAppRoutingEvents,
  bulkUpdateContactCustomFields
} from '../controllers/contactsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('contacts'))

// Rutas principales
router.get('/', getContacts)
// (ACL-001) /chats es un endpoint de Chat, no de Contactos. Además del gate de
// 'contacts' a nivel de router, exigimos el módulo 'chat' para que un empleado con
// chat:'none' (aunque tenga contacts:'read') quede bloqueado también por API directa.
router.get('/chats', requireModuleAccess('chat'), getChatContacts)
router.get('/search', searchContacts)
router.get('/stats', getContactStats)
// (CNT-007) Papelera de contactos (debe ir ANTES de '/:id' para no capturarse como un id).
router.get('/trash', getTrashedContacts)
router.get('/chart', getContactsChart)
router.get('/custom-fields', getContactCustomFieldDefinitions)
router.post('/custom-fields', createContactCustomFieldDefinition)
router.put('/custom-fields/:definitionId', updateContactCustomFieldDefinitionHandler)
router.post('/', createContact)
router.post('/sync-stats', syncContactsStats)
router.post('/bulk/tags', bulkUpdateContactTags)
router.post('/bulk/custom-fields', bulkUpdateContactCustomFields)
router.get('/bulk-actions', listBulkContactActions)
router.post('/bulk-actions/whatsapp-template', createBulkWhatsAppTemplateAction)
router.post('/bulk-actions/automation', createBulkAutomationAction)
router.get('/bulk-actions/:actionId', getBulkContactAction)
router.post('/bulk-actions/:actionId/pause', pauseBulkContactAction)
router.post('/bulk-actions/:actionId/resume', resumeBulkContactAction)
router.post('/bulk-actions/:actionId/reschedule', rescheduleBulkContactAction)
router.post('/bulk-actions/:actionId/cancel', cancelBulkContactAction)
router.delete('/bulk-actions/:actionId', deleteBulkContactAction)
router.get('/:id/payment-link-delivery-options', getContactPaymentLinkDeliveryOptions)
router.get('/:id', getContactById)
router.get('/:id/journey', getContactJourney)
router.get('/:id/whatsapp-routing-events', getContactWhatsAppRoutingEvents)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)
// (CNT-007) Restaurar desde la papelera o borrar permanentemente (conservando pagos).
router.post('/:id/restore', restoreContact)
router.delete('/:id/permanent', permanentDeleteContact)

export default router
