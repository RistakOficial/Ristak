import { db } from '../config/database.js'
import { createPublicPaymentId } from '../utils/idGenerator.js'
import { isSuccessfulPaymentStatus } from './paymentRecordSafetyService.js'

export function isManualTransferPayment(payment = {}) {
  return String(payment.payment_provider || '').trim().toLowerCase() === 'manual' &&
    ['bank_transfer', 'transfer'].includes(String(payment.payment_method || '').trim().toLowerCase())
}

export function isPaidManualTransferPayment(payment = {}) {
  return isManualTransferPayment(payment) && isSuccessfulPaymentStatus(payment.status)
}

// Repair only the receipt identity of an existing paid transfer. No charge,
// invoice, payment reconciliation or outbound message is created here.
export async function ensureManualPaymentReceiptLink(paymentId, { baseUrl = '' } = {}) {
  const payment = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  if (!payment) {
    throw Object.assign(new Error('Pago no encontrado.'), { status: 404 })
  }
  if (!isPaidManualTransferPayment(payment)) {
    throw Object.assign(new Error('El recibo requiere una transferencia manual ya pagada.'), { status: 409 })
  }
  const origin = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(origin)) {
    throw Object.assign(new Error('No se pudo resolver la URL pública del recibo.'), { status: 503 })
  }
  if (!payment.public_payment_id || !payment.payment_url) {
    const publicId = payment.public_payment_id || createPublicPaymentId()
    // Both fields use the winning public ID in the same conditional update,
    // including concurrent repairs. Existing links and payment data stay intact.
    await db.run(
      `UPDATE payments
       SET public_payment_id = COALESCE(NULLIF(public_payment_id, ''), ?),
           payment_url = CASE WHEN COALESCE(payment_url, '') = ''
             THEN ? || '/pay/' || COALESCE(NULLIF(public_payment_id, ''), ?)
             ELSE payment_url END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND LOWER(payment_provider) = 'manual'
         AND LOWER(payment_method) IN ('bank_transfer', 'transfer')
         AND LOWER(status) IN ('paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success')
         AND (COALESCE(public_payment_id, '') = '' OR COALESCE(payment_url, '') = '')`,
      [publicId, origin, publicId, paymentId]
    )
  }
  const updated = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  if (!updated || !isPaidManualTransferPayment(updated) || !updated.public_payment_id) {
    throw Object.assign(new Error('El pago cambió; vuelve a comprobar su estado antes de emitir el recibo.'), { status: 409 })
  }
  return updated
}
