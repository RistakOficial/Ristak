export interface PaymentTestCard {
  kind: string
  brand: string
  number: string
  cvc: string
  expiry: string
  result?: string
}

export interface PaymentTestScenario {
  holder: string
  result: string
}

export interface PaymentTestGuide {
  title: string
  description: string
  emailHint: string
  cards: PaymentTestCard[]
  scenarios?: PaymentTestScenario[]
}

export const PAYMENT_TEST_GUIDES: Record<string, PaymentTestGuide>
export function getPaymentTestGuide(provider?: string): PaymentTestGuide
