export function serializePaymentAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return null
  const parsed = Number(amount)
  return Number.isFinite(parsed) ? parsed : null
}

export function serializePaymentRowAmount(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  return {
    ...row,
    amount: serializePaymentAmount(row.amount)
  }
}
