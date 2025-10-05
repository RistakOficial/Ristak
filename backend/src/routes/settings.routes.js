import express from 'express';
import { getTimezone } from '../controllers/settingsController.js';

const router = express.Router();

// GET /api/settings/timezone
router.get('/timezone', getTimezone);

export default router;
