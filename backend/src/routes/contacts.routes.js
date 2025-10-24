import express from 'express'
import {
  getContacts,
  getContactById,
  searchContacts,
  getContactStats,
  getContactsChart,
  syncContactsStats,
  updateContact,
  deleteContact,
  getContactJourney
} from '../controllers/contactsController.js'

const router = express.Router()

// Rutas principales
router.get('/', getContacts)
router.get('/search', searchContacts)
router.get('/stats', getContactStats)
router.get('/chart', getContactsChart)
router.post('/sync-stats', syncContactsStats)
router.get('/:id', getContactById)
router.get('/:id/journey', getContactJourney)
router.put('/:id', updateContact)
router.delete('/:id', deleteContact)

export default router