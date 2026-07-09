import express from 'express';
import * as calendarsController from '../controllers/calendarsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireFeature } from '../middleware/licenseMiddleware.js';
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js';

const router = express.Router();
export const publicCalendarsRoutes = express.Router();
const requireGoogleCalendarFeature = requireFeature('google_calendar');

/**
 * Rutas para la gestión de calendarios de Ristak e integraciones opcionales.
 * Base: /api/calendars
 */

// Slots y reservas publicas para URLs compartibles de calendario
publicCalendarsRoutes.get('/public/:slug/free-slots', calendarsController.getPublicFreeSlots);
publicCalendarsRoutes.get('/public/:slug/contact-prefill', calendarsController.getPublicContactPrefill);
publicCalendarsRoutes.post('/public/:slug/appointments', calendarsController.createPublicAppointment);

router.use(requireAuth);
router.use(requireModuleAccess('appointments'));

// Obtener todos los calendarios
router.get('/', calendarsController.getCalendars);

// Crear calendario local de Ristak
router.post('/', calendarsController.createCalendar);

// Integración Google Calendar: OAuth por handoff desde el portal Ristak.
router.get('/google-integration', requireGoogleCalendarFeature, calendarsController.getGoogleCalendarIntegration);
router.post('/google-integration/connect-url', requireGoogleCalendarFeature, calendarsController.getGoogleCalendarConnectUrl);
router.post('/google-integration/connect/claim', requireGoogleCalendarFeature, calendarsController.claimGoogleCalendarOAuth);
router.get('/google-integration/calendars', requireGoogleCalendarFeature, calendarsController.listGoogleCalendarOptions);
router.post('/google-integration/test', requireGoogleCalendarFeature, calendarsController.testGoogleCalendarIntegration);
router.post('/google-integration/sync', requireGoogleCalendarFeature, calendarsController.syncGoogleCalendarIntegration);
router.get('/google-integration/merge-preview', requireGoogleCalendarFeature, calendarsController.getGoogleCalendarMergePreview);
router.post('/google-integration/merge', requireGoogleCalendarFeature, calendarsController.mergeGoogleCalendarAppointments);
router.delete('/google-integration', requireGoogleCalendarFeature, calendarsController.deleteGoogleCalendarIntegration);

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
router.put('/:id/google-sync', requireGoogleCalendarFeature, calendarsController.updateCalendarGoogleSync);
router.put('/:id', calendarsController.updateCalendar);

// Eliminar un calendario local de Ristak
router.delete('/:id', calendarsController.deleteCalendar);

export default router;
