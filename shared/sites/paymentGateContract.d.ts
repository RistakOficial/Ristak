export const PAYMENT_GATEWAYS: Set<string>
export const PAYMENT_GATE_BILLING_TYPES: Set<string>
export const SUBSCRIPTION_GATEWAYS: Set<string>
export const SUBSCRIPTION_INTERVAL_TYPES: Set<string>
export const MSI_INSTALLMENT_CHOICES: number[]
export const MSI_LINK_GATEWAYS: Set<string>
export const STRIPE_MSI_MIN_AMOUNT: number
export const CLIP_MSI_MIN_AMOUNT: number

export interface NormalizedPaymentGateLike {
  enabled?: boolean
  amount?: number
  gateway?: string
  currency?: string
  msi?: { enabled?: boolean; maxInstallments?: number } | null
}

export function isNormalizedPaymentGateEnabled(config?: NormalizedPaymentGateLike): boolean

export function supportsSiteSubscriptionGateway(gateway?: string): boolean

export function conektaInstallmentMonths(input?: { maxInstallments?: number; amount?: number }): number[]

export interface MsiEligibility {
  enabled: boolean
  standaloneMonths: number[]
  insideElement: boolean
  insideBrick: boolean
  hostedRedirect: boolean
}

export function msiEligibility(input?: {
  gateway?: string
  currency?: string
  amount?: number
  msi?: { enabled?: boolean; maxInstallments?: number } | null
}): MsiEligibility

export interface StripeAppearance {
  theme: 'night' | 'stripe'
  variables: Record<string, string | undefined>
}

export function buildStripeAppearanceVariables(input?: {
  dark?: boolean
  accent?: string
  fieldText?: string
  muted?: string
  inputBg?: string
  radius?: string
}): StripeAppearance
