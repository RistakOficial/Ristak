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
  getContactJourney,
  getContactWhatsAppRoutingEvents
} from '../controllers/contactsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('contacts'))

// Rutas principales
router.get('/', getContacts)
router.get('/chats', getChatContacts)
router.get('/search', searchContacts)
router.get('/stats', getContactStats)
router.get('/chart', getContactsChart)
router.get('/custom-fields', getContactCustomFieldDefinitions)
router.post('/custom-fields', createContactCustomFieldDefinition)
router.put('/custom-fields/:definitionId', updateContactCustomFieldDefinitionHandler)
router.post('/', createContact)
router.post('/sync-stats', syncContactsStats)
router.post('/bulk/tags', bulkUpdateContactTags)
router.get('/bulk-actions', listBulkContactActions)
router.post('/bulk-actions/whatsapp-template', createBulkWhatsAppTemplateAction)
router.post('/bulk-actions/automation', createBulkAutomationAction)
router.get('/bulk-actions/:actionId', getBulkContactAction)
router.post('/bulk-actions/:actionId/pause', pauseBulkContactAction)
router.post('/bulk-actions/:actionId/resume', resumeBulkContactAction)
router.post('/bulk-actions/:actionId/reschedule', rescheduleBulkContactAction)
router.post('/bulk-actions/:actionId/cancel', cancelBulkContactAction)
router.delete('/bulk-actions/:actionId', deleteBulkContactAction)
router.get('/:id', getContactById)
router.get('/:id/journey', getContactJourney)
router.get('/:id/whatsapp-routing-events', getContactWhatsAppRoutingEvents)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)

export default router
