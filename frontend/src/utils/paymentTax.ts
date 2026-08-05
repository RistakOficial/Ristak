import type { PaymentTaxSettings } from '@/services/paymentSettingsService'

export const DEFAULT_CHARGE_TAX_CALCULATION_MODE: PaymentTaxSettings['calculationMode'] = 'exclusive'

const roundMoney = (value: number): number => Math.round(value * 100) / 100

export const getConfiguredTaxRate = (taxes: Pick<PaymentTaxSettings, 'rateValue'>) => {
  const rateValue = Number(taxes.rateValue)
  return Number.isFinite(rateValue) ? rateValue : 0
}

export const getConfiguredTaxName = (taxes: Pick<PaymentTaxSettings, 'taxName'>) => (
  taxes.taxName?.trim() || 'Impuesto'
)

export const calculateConfiguredTax = (
  amount: number,
  taxes: Pick<PaymentTaxSettings, 'enabled' | 'rateType' | 'rateValue'>,
  applyTax: boolean,
  calculationMode: PaymentTaxSettings['calculationMode']
) => {
  const rateValue = getConfiguredTaxRate(taxes)

  if (!taxes.enabled || !applyTax || amount <= 0 || rateValue <= 0) {
    return {
      subtotalAmount: amount,
      taxAmount: 0,
      totalAmount: amount,
      includesTax: false,
      calculationMode
    }
  }

  if (calculationMode === 'inclusive') {
    const taxAmount = taxes.rateType === 'fixed'
      ? Math.min(rateValue, amount)
      : roundMoney(amount - (amount / (1 + rateValue / 100)))
    return {
      subtotalAmount: roundMoney(amount - taxAmount),
      taxAmount: roundMoney(taxAmount),
      totalAmount: amount,
      includesTax: true,
      calculationMode
    }
  }

  const taxAmount = taxes.rateType === 'fixed'
    ? roundMoney(rateValue)
    : roundMoney(amount * (rateValue / 100))
  return {
    subtotalAmount: amount,
    taxAmount,
    totalAmount: roundMoney(amount + taxAmount),
    includesTax: true,
    calculationMode
  }
}
