import express from 'express'
import {
  getTransactions,
  getTransactionById,
  getTransactionStats,
  getTransactionSummary,
  deleteTransaction,
  voidTransaction,
  recordPayment,
  sendTransaction,
  getPaymentLink
} from '../controllers/transactionsController.js'

const router = express.Router()

// Rutas principales
router.get('/', getTransactions)
router.get('/stats', getTransactionStats)
router.get('/summary', getTransactionSummary)
router.get('/:id', getTransactionById)
router.delete('/:id', deleteTransaction)

// Acciones sobre transacciones
router.post('/:id/void', voidTransaction)
router.post('/:id/record-payment', recordPayment)
router.post('/:id/send', sendTransaction)
router.get('/:id/payment-link', getPaymentLink)

export default router