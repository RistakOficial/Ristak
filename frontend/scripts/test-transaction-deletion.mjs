import test from 'node:test'
import assert from 'node:assert/strict'
import { canDeleteUnpaidTransaction } from '../src/utils/transactionDeletion.ts'

test('acciones de transacciones: permite eliminar fallidos y enviados sin cobro', () => {
  for (const status of ['failed', 'sent', 'draft', 'pending', 'overdue']) {
    assert.equal(canDeleteUnpaidTransaction({ status, hasProtectedPaymentActivity: false }), true, status)
  }
})

test('acciones de transacciones: conserva cobros aunque el estado diga fallido o enviado', () => {
  for (const status of ['failed', 'sent']) {
    assert.equal(canDeleteUnpaidTransaction({ status, paidAt: '2026-10-07T16:00:00Z' }), false)
    assert.equal(canDeleteUnpaidTransaction({ status, hasProtectedPaymentActivity: true }), false)
    assert.equal(canDeleteUnpaidTransaction({ status, fiscalInvoice: { available: true } }), false)
  }
})

test('acciones de transacciones: no ofrece eliminar pagos cobrados ni comprobantes protegidos', () => {
  for (const status of ['paid', 'partial', 'refunded', 'void', 'pending_review', 'rejected', 'deleted', 'unknown']) {
    assert.equal(canDeleteUnpaidTransaction({ status, hasProtectedPaymentActivity: false }), false, status)
  }
})
