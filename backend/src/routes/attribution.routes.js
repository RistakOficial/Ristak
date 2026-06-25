import express from 'express';
import { previewFallback, executeFallback } from '../controllers/attributionController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js';

const router = express.Router();

router.use(requireAuth);
// (ACL-001) La atribución pertenece al panel de analytics; protegemos la API
// directa con el módulo 'analytics' para que el rol no sea solo decorativo en UI.
router.use(requireModuleAccess('analytics'));

// Preview fallback attribution (sin modificar BD)
router.get('/fallback/preview', previewFallback);

// Ejecutar fallback attribution (actualiza BD)
router.post('/fallback/execute', executeFallback);

export default router;
