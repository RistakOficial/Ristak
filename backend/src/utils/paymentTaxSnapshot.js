// Plan installments already contain their final amount. Allocate the saved
// tax inside that amount without applying the account's current rate again.
export function paymentTaxSnapshotForTotal(tax, total) {
  if (tax?.enabled !== true) return { enabled: false }
  const round = (value) => Math.round(value * 100) / 100
  const totalAmount = round(Number(total))
  const rateValue = Number(tax.rateValue)
  const taxAmount = tax.rateType === 'fixed'
    ? round(totalAmount * Number(tax.taxAmount) / Number(tax.totalAmount))
    : round(totalAmount - totalAmount / (1 + rateValue / 100))
  if (!Number.isFinite(totalAmount) || !Number.isFinite(taxAmount) || taxAmount < 0 || taxAmount > totalAmount) {
    throw new Error('El desglose de impuesto guardado no coincide con el importe del pago.')
  }
  return { ...tax, subtotalAmount: round(totalAmount - taxAmount), taxAmount, totalAmount }
}
