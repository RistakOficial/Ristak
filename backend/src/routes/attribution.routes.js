import express from 'express';
import { previewFallback, executeFallback } from '../controllers/attributionController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(requireAuth);

// Preview fallback attribution (sin modificar BD)
router.get('/fallback/preview', previewFallback);

// Ejecutar fallback attribution (actualiza BD)
router.post('/fallback/execute', executeFallback);

export default router;
