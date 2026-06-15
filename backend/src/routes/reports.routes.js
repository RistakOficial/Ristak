import express from 'express';
import {
  getContactsReport,
  getPaymentsReport,
  getCampaignsReport,
  getSummary,
  getMetrics,
  getManualBusinessExpenses,
  upsertManualBusinessExpense,
  getContactsList,
  getTransactionsList
} from '../controllers/reportsController.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js';

const router = express.Router();

router.use(requireAuth);
router.use(requireModuleAccess('reports'));

router.get('/metrics', getMetrics);
router.get('/manual-business-expenses', getManualBusinessExpenses);
router.put('/manual-business-expenses', upsertManualBusinessExpense);
router.get('/contacts/list', getContactsList);
router.get('/transactions', getTransactionsList);
router.get('/contacts', getContactsReport);
router.get('/payments', getPaymentsReport);
router.get('/campaigns', getCampaignsReport);
router.get('/summary', getSummary);

export default router;
