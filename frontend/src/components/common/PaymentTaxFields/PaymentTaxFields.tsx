import type { PaymentTaxSettings } from '@/services/paymentSettingsService'
import { formatCurrency } from '@/utils/format'
import { calculateConfiguredTax, getConfiguredTaxName, getConfiguredTaxRate } from '@/utils/paymentTax'
import { TabList } from '../TabList'

interface PaymentTaxFieldsProps {
  taxes: PaymentTaxSettings
  amount: number
  currency: string
  applyTax: boolean
  calculationMode: PaymentTaxSettings['calculationMode']
  onApplyTaxChange: (value: boolean) => void
  onCalculationModeChange: (value: PaymentTaxSettings['calculationMode']) => void
  className?: string
}

export function PaymentTaxFields({
  taxes, amount, currency, applyTax, calculationMode,
  onApplyTaxChange, onCalculationModeChange, className
}: PaymentTaxFieldsProps) {
  if (!taxes.enabled) return null

  const name = getConfiguredTaxName(taxes)
  const rate = getConfiguredTaxRate(taxes)
  const rateLabel = taxes.rateType === 'percentage' ? `${rate}%` : formatCurrency(rate, currency)
  const breakdown = calculateConfiguredTax(amount, taxes, applyTax, calculationMode)

  return (
    <div className={`grid min-w-0 gap-[14px] ${className || ''}`}>
      <div role="group" aria-label={name} className="flex min-w-0 flex-col gap-[7px]">
        <span className="text-xs font-medium text-[var(--text-dim)]">{name}</span>
        <TabList
          tabs={[
            { value: 'sin', label: `Sin ${name}` },
            { value: 'con', label: `Aplicar ${rateLabel}` }
          ]}
          activeTab={applyTax ? 'con' : 'sin'}
          onTabChange={(value) => onApplyTaxChange(value === 'con')}
          variant="compact"
          fullWidth
        />
      </div>
      {applyTax && (
        <div role="group" aria-label="Cálculo del impuesto" className="flex min-w-0 flex-col gap-[7px]">
          <span className="text-xs font-medium text-[var(--text-dim)]">Cálculo del impuesto</span>
          <TabList
            tabs={[
              { value: 'exclusive', label: 'Se suma al total' },
              { value: 'inclusive', label: 'Ya incluido' }
            ]}
            activeTab={calculationMode}
            onTabChange={(value) => onCalculationModeChange(value as PaymentTaxSettings['calculationMode'])}
            variant="compact"
            fullWidth
          />
          <p className="m-0 text-xs leading-[1.4] text-[var(--text-mute)]" aria-live="polite">
            {name}: {formatCurrency(breakdown.taxAmount, currency)} · Total recurrente: {formatCurrency(breakdown.totalAmount, currency)}
          </p>
        </div>
      )}
    </div>
  )
}
