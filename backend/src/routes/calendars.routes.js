import express from 'express';
import * as calendarsController from '../controllers/calendarsController.js';

const router = express.Router();

/**
 * Rutas para la gestión de Calendarios de HighLevel
 * Base: /api/calendars
 */

// Obtener todos los calendarios
router.get('/', calendarsController.getCalendars);

// Obtener eventos/citas
router.get('/events', calendarsController.getEvents);

// Crear nueva cita
router.post('/appointments', calendarsController.createAppointment);

// Actualizar cita existente
router.put('/appointments/:id', calendarsController.updateAppointment);

// Eliminar evento
router.delete('/events/:id', calendarsController.deleteEvent);

// Obtener slots disponibles de un calendario específico
router.get('/:id/free-slots', calendarsController.getFreeSlots);

// Obtener un calendario específico
router.get('/:id', calendarsController.getCalendar);

export default router;
