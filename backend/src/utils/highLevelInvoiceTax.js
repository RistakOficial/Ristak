function cleanString(value) {
  return String(value || '').trim()
}

/**
 * Traduce el objeto fiscal interno de Ristak al contrato de items de HighLevel.
 *
 * HighLevel ignora `tax` en la raíz del invoice y calcula el saldo únicamente
 * desde los conceptos. La metadata fiscal original se guarda por separado en
 * payments.metadata_json y no pasa por este helper.
 */
export function translateRistakTaxToHighLevelItems(invoice = {}) {
  const normalized = { ...invoice }
  const tax = normalized.tax && typeof normalized.tax === 'object'
    ? normalized.tax
    : null
  delete normalized.tax

  const taxAmount = Number(tax?.amount)
  if (!tax || !Number.isFinite(taxAmount) || taxAmount <= 0 || !Array.isArray(normalized.items)) {
    return normalized
  }

  const currency = cleanString(
    normalized.currency || normalized.items.find((item) => cleanString(item?.currency))?.currency
  ).toUpperCase()
  const taxName = cleanString(tax.name) || 'Impuesto'
  const taxRate = Number(tax.rate)
  const taxDescription = Number.isFinite(taxRate) && taxRate > 0
    ? `${taxName} ${taxRate}%`
    : taxName

  return {
    ...normalized,
    items: [
      ...normalized.items,
      {
        name: taxName,
        description: taxDescription,
        amount: taxAmount,
        qty: 1,
        currency
      }
    ]
  }
}
