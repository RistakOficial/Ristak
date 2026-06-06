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
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

router.use(requireAuth)

// Rutas principales
router.get('/', getTransactions)
router.post('/', createTransaction)
router.get('/stats', getTransactionStats)
router.get('/summary', getTransactionSummary)
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
