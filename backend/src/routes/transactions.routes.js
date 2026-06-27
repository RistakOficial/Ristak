import express from 'express'
import {
  createTransaction,
  getTransactions,
  getTransactionById,
  getTransactionStats,
  getTransactionSummary,
  updateTransaction,
  deleteTransaction,
  refundTransaction,
  voidTransaction,
  recordPayment,
  sendTransaction,
  getPaymentLink
} from '../controllers/transactionsController.js'
import {
  actionPaymentPlan,
  createPaymentInstallmentFlow,
  createPaymentPlan,
  getPaymentPlan,
  listPaymentPlans,
  updatePaymentPlan
} from '../controllers/paymentPlansController.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { requireModuleAccess } from '../middleware/userAccessMiddleware.js'

const router = express.Router()

router.use(requireAuth)
router.use(requireModuleAccess('payments'))

// Rutas principales
router.get('/', getTransactions)
router.post('/', createTransaction)
router.get('/stats', getTransactionStats)
router.get('/summary', getTransactionSummary)

// Planes y flujos de parcialidades propios de Ristak. Las rutas /highlevel se
// conservan como alias legacy para instalaciones antiguas.
router.get('/payment-plans', listPaymentPlans)
router.post('/payment-plans', createPaymentPlan)
router.get('/payment-plans/:scheduleId', getPaymentPlan)
router.put('/payment-plans/:scheduleId', updatePaymentPlan)
router.post('/payment-plans/:scheduleId/action', actionPaymentPlan)
router.post('/payment-flows/installments', createPaymentInstallmentFlow)

router.get('/:id', getTransactionById)
router.put('/:id', updateTransaction)
router.delete('/:id', deleteTransaction)

// Acciones sobre transacciones
router.post('/:id/refund', refundTransaction)
router.post('/:id/void', voidTransaction)
router.post('/:id/record-payment', recordPayment)
router.post('/:id/send', sendTransaction)
router.get('/:id/payment-link', getPaymentLink)

export default router
