import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'
import {
  getAppointmentRemindersHandler,
  createAppointmentReminderHandler,
  updateAppointmentReminderHandler,
  deleteAppointmentReminderHandler
} from '../controllers/appointmentRemindersController.js'

const router = express.Router()

router.use(requireAuth)
// (ACL-001) Los recordatorios pertenecen al módulo de Citas; exigimos
// requireModuleAccess('appointments') para que la API directa respete el rol.
router.use(requireModuleAccess('appointments'))

router.get('/', getAppointmentRemindersHandler)
router.post('/', createAppointmentReminderHandler)
router.put('/:reminderId', updateAppointmentReminderHandler)
router.delete('/:reminderId', deleteAppointmentReminderHandler)

export default router
