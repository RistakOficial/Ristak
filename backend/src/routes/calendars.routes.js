import express from 'express';
import * as calendarsController from '../controllers/calendarsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

/**
 * Rutas para la gestión de Calendarios de HighLevel
 * Base: /api/calendars
 */

// Slots y reservas publicas para URLs compartibles de calendario
router.get('/public/:slug/free-slots', calendarsController.getPublicFreeSlots);
router.post('/public/:slug/appointments', calendarsController.createPublicAppointment);

router.use(requireAuth);

// Obtener todos los calendarios
router.get('/', calendarsController.getCalendars);

// Crear calendario local de Ristak
router.post('/', calendarsController.createCalendar);

// Integración Google Calendar por Service Account
router.get('/google-integration', calendarsController.getGoogleCalendarIntegration);
router.get('/google-integration/reveal/service-account', calendarsController.revealGoogleCalendarServiceAccount);
router.put('/google-integration', calendarsController.saveGoogleCalendarIntegration);
router.post('/google-integration/test', calendarsController.testGoogleCalendarIntegration);
router.post('/google-integration/sync', calendarsController.syncGoogleCalendarIntegration);
router.get('/google-integration/merge-preview', calendarsController.getGoogleCalendarMergePreview);
router.post('/google-integration/merge', calendarsController.mergeGoogleCalendarAppointments);
router.delete('/google-integration', calendarsController.deleteGoogleCalendarIntegration);

// Obtener eventos/citas
router.get('/events', calendarsController.getEvents);

// Obtener detalles completos de una cita individual (con contactId y assignedUserId)
router.get('/events/:eventId', calendarsController.getAppointment);

// Crear nueva cita
router.post('/appointments', calendarsController.createAppointment);

// Actualizar cita existente
router.put('/appointments/:id', calendarsController.updateAppointment);

// Eliminar evento
router.delete('/events/:id', calendarsController.deleteEvent);

// Obtener slots disponibles de un calendario específico
router.get('/:id/free-slots', calendarsController.getFreeSlots);

// Obtener horarios bloqueados de un calendario
router.get('/:calendarId/blocked-slots', calendarsController.getBlockedSlots);

// Crear nuevo blocked slot
router.post('/block-slots', calendarsController.createBlockedSlot);

// Actualizar blocked slot existente
router.put('/block-slots/:id', calendarsController.updateBlockedSlot);

// Eliminar blocked slot
router.delete('/block-slots/:id', calendarsController.deleteBlockedSlot);

// Obtener un calendario específico
router.get('/:id', calendarsController.getCalendar);

// Actualizar configuración de un calendario
router.put('/:id', calendarsController.updateCalendar);

export default router;
