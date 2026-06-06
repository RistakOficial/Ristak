import express from 'express';
import { getStatus } from '../controllers/integrationsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(requireAuth);

// GET /api/integrations/status - Obtener estado de integraciones
router.get('/status', getStatus);

export default router;
