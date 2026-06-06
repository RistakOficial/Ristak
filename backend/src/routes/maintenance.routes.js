import express from 'express';
import { fixVisitorIds } from '../controllers/maintenanceController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(requireAuth);

// Endpoint de mantenimiento para actualizar visitor_ids
router.post('/fix-visitor-ids', fixVisitorIds);

export default router;
