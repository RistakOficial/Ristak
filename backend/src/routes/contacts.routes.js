import express from 'express'
import {
  getContacts,
  getContactById,
  getContactAppointments,
  getContactPayments,
  createContact,
  createContactCustomFieldDefinition,
  getContactCustomFieldDefinitions,
  getChatContacts,
  markChatContactRead,
  markChatContactsRead,
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
  getContactConversation,
  getContactJourney,
  getContactWhatsAppRoutingEvents,
  getContactConversationalChannelPreference,
  updateContactConversationalChannelPreference,
  refreshContactExternalData,
  bulkUpdateContactCustomFields
} from '../controllers/contactsController.js'
import {
  getAssignableUsers,
  getContactAssignment,
  setContactAssignment
} from '../controllers/contactAssignmentController.js'
import { getContactLinkedSocial } from '../controllers/contactSocialProfileController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireFeature } from '../middleware/licenseMiddleware.js'
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
router.post('/chats/read', requireModuleAccess('chat'), markChatContactsRead)
router.post('/chats/:id/read', requireModuleAccess('chat'), markChatContactRead)
router.get('/search', searchContacts)
// Asignación de responsable (antes de /:id para no colisionar con el param).
router.get('/assignable-users', getAssignableUsers)
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
router.post('/bulk-actions/whatsapp-template', requireFeature('whatsapp_templates'), createBulkWhatsAppTemplateAction)
router.post('/bulk-actions/automation', requireFeature('automations'), createBulkAutomationAction)
router.get('/bulk-actions/:actionId', getBulkContactAction)
router.post('/bulk-actions/:actionId/pause', pauseBulkContactAction)
router.post('/bulk-actions/:actionId/resume', resumeBulkContactAction)
router.post('/bulk-actions/:actionId/reschedule', rescheduleBulkContactAction)
router.post('/bulk-actions/:actionId/cancel', cancelBulkContactAction)
router.delete('/bulk-actions/:actionId', deleteBulkContactAction)
router.get('/:id/payment-link-delivery-options', getContactPaymentLinkDeliveryOptions)
router.get('/:id/payments', getContactPayments)
router.get('/:id/appointments', getContactAppointments)
router.get('/:id/conversation', requireModuleAccess('chat'), getContactConversation)
router.get('/:id/chat-channel-preference', requireModuleAccess('chat'), getContactConversationalChannelPreference)
router.put('/:id/chat-channel-preference', requireModuleAccess('chat'), updateContactConversationalChannelPreference)
router.get('/:id', getContactById)
router.get('/:id/journey', getContactJourney)
router.post('/:id/refresh', refreshContactExternalData)
router.get('/:id/whatsapp-routing-events', getContactWhatsAppRoutingEvents)
router.get('/:id/assignment', getContactAssignment)
// (ACL-001) Datos de chat: el perfil social + enlace DM↔comentario solo los
// consume el panel del chat, así que exige acceso al módulo 'chat' (no basta
// con 'contacts'), igual que las rutas /chats*.
router.get('/:id/linked-social', requireModuleAccess('chat'), getContactLinkedSocial)
router.put('/:id/assignment', setContactAssignment)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)
// (CNT-007) Restaurar desde la papelera o borrar permanentemente (conservando pagos).
router.post('/:id/restore', restoreContact)
router.delete('/:id/permanent', permanentDeleteContact)

export default router
