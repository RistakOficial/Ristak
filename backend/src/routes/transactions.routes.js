import express from 'express'
import {
  getTransactions,
  getTransactionById,
  getTransactionStats,
  getTransactionSummary
} from '../controllers/transactionsController.js'

const router = express.Router()

// Rutas principales
router.get('/', getTransactions)
router.get('/stats', getTransactionStats)
router.get('/summary', getTransactionSummary)
router.get('/:id', getTransactionById)

export default router