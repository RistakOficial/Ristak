import express from 'express';
import { getStatus } from '../controllers/integrationsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireAdmin, requireModuleAccess } from '../middleware/userAccessMiddleware.js';
import {
  connectBunnyAccountHandler,
  disconnectBunnyAccountHandler,
  getBunnyAccountStatusHandler,
  retryBunnyMigrationHandler
} from '../controllers/bunnyAccountIntegrationController.js';

const router = express.Router();

router.use(requireAuth);

// GET /api/integrations/status - Obtener estado de integraciones
router.get('/status', getStatus);
router.get('/bunny', requireAdmin, requireModuleAccess('settings_integrations'), getBunnyAccountStatusHandler);
router.post('/bunny/connect', requireAdmin, requireModuleAccess('settings_integrations'), connectBunnyAccountHandler);
router.post('/bunny/migration/retry', requireAdmin, requireModuleAccess('settings_integrations'), retryBunnyMigrationHandler);
router.delete('/bunny', requireAdmin, requireModuleAccess('settings_integrations'), disconnectBunnyAccountHandler);

export default router;
