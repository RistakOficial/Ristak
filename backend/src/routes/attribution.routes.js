import express from 'express';
import { previewFallback, executeFallback } from '../controllers/attributionController.js';

const router = express.Router();

// Preview fallback attribution (sin modificar BD)
router.get('/fallback/preview', previewFallback);

// Ejecutar fallback attribution (actualiza BD)
router.post('/fallback/execute', executeFallback);

export default router;
