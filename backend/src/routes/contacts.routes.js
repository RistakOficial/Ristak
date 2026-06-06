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
  updateContactCustomFieldDefinitionHandler,
  deleteContact,
  getContactJourney
} from '../controllers/contactsController.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

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
router.get('/:id', getContactById)
router.get('/:id/journey', getContactJourney)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)

export default router
