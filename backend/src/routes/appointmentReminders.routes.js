import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import {
  getAppointmentRemindersHandler,
  createAppointmentReminderHandler,
  updateAppointmentReminderHandler,
  deleteAppointmentReminderHandler
} from '../controllers/appointmentRemindersController.js'

const router = express.Router()

router.use(requireAuth)

router.get('/', getAppointmentRemindersHandler)
router.post('/', createAppointmentReminderHandler)
router.put('/:reminderId', updateAppointmentReminderHandler)
router.delete('/:reminderId', deleteAppointmentReminderHandler)

export default router
