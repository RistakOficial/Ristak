import type { Transaction } from '../services/transactionsService'

const DELETABLE_UNPAID_STATUSES = new Set([
  'draft',
  'sent',
  'failed',
  'scheduled',
  'pending',
  'overdue',
  'inactive',
  'initiated',
  'created',
  'open',
  'requires_payment_method',
  'requires_confirmation',
  'cancelled',
  'canceled'
])

type DeletionState = Pick<Transaction, 'status' | 'paidAt' | 'hasProtectedPaymentActivity' | 'fiscalInvoice'>

export const canDeleteUnpaidTransaction = (transaction: DeletionState) => (
  DELETABLE_UNPAID_STATUSES.has(String(transaction.status || '').toLowerCase()) &&
  !transaction.paidAt &&
  !transaction.hasProtectedPaymentActivity &&
  !transaction.fiscalInvoice?.available
)
