import express from 'express';
import { getStatus } from '../controllers/integrationsController.js';

const router = express.Router();

// GET /api/integrations/status - Obtener estado de integraciones
router.get('/status', getStatus);

export default router;
