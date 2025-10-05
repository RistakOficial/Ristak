import express from 'express'
import {
  getContacts,
  getContactById,
  searchContacts,
  getContactStats,
  syncContactsStats,
  updateContact,
  deleteContact
} from '../controllers/contactsController.js'

const router = express.Router()

// Rutas principales
router.get('/', getContacts)
router.get('/search', searchContacts)
router.get('/stats', getContactStats)
router.post('/sync-stats', syncContactsStats)
router.get('/:id', getContactById)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)

export default router