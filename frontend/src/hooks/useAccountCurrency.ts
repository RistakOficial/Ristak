import { useMemo } from 'react'
import { useAppConfig } from './useAppConfig'
import {
  ACCOUNT_CURRENCY_CONFIG_KEY,
  getDetectedAccountLocaleDefaults,
  normalizeCurrencyCode
} from '@/utils/accountLocale'

export function useAccountCurrency() {
  const detectedLocaleDefaults = useMemo(getDetectedAccountLocaleDefaults, [])
  const [currency, setCurrency, saving] = useAppConfig<string>(
    ACCOUNT_CURRENCY_CONFIG_KEY,
    detectedLocaleDefaults.currency
  )

  return [
    normalizeCurrencyCode(currency, detectedLocaleDefaults.currency),
    setCurrency,
    saving
  ] as const
}
