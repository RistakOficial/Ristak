import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const desktopChatSource = await readFile(
  new URL('../src/pages/DesktopChat/DesktopChat.tsx', import.meta.url),
  'utf8'
)
const subscriptionPageSource = await readFile(
  new URL('../src/pages/Transactions/PaymentSubscriptions.tsx', import.meta.url),
  'utf8'
)
const subscriptionModalSource = await readFile(
  new URL('../src/components/common/CreateSubscriptionModal/CreateSubscriptionModal.tsx', import.meta.url),
  'utf8'
)
const paymentSelectorSource = await readFile(
  new URL('../src/components/common/PaymentFlowSelectorModal/PaymentFlowSelectorModal.tsx', import.meta.url),
  'utf8'
)

assert.match(
  desktopChatSource,
  /const canUsePaymentPlans = hasPaymentPlansAccess\(user\)/,
  'Chat debe ofrecer planes offline por licencia, sin exigir una pasarela conectada'
)
assert.match(
  desktopChatSource,
  /<PaymentFlowSelectorModal[\s\S]*canUseSubscriptions=\{paymentCapabilities\.canUseSubscriptions\}/,
  'Chat debe decidir suscripciones con licencia y pasarela compatible'
)
assert.match(
  desktopChatSource,
  /initialPaymentMode=\{paymentFlow === 'partial' \? 'partial' : 'single'\}/,
  'Chat debe reutilizar RecordPaymentModal en modo único o plan'
)
assert.doesNotMatch(
  desktopChatSource,
  /initialPaymentMode="single"/,
  'Chat no debe volver a forzar siempre el cobro único'
)
assert.match(
  desktopChatSource,
  /<CreateSubscriptionModal[\s\S]*providers=\{paymentCapabilities\.subscriptionProviders\}/,
  'Chat debe reutilizar el alta compartida de suscripciones con proveedores conectados'
)
assert.match(
  subscriptionPageSource,
  /<CreateSubscriptionModal[\s\S]*isOpen=\{formMode === 'create'\}/,
  'Pagos y Chat deben consumir el mismo modal de alta de suscripciones'
)
assert.match(
  subscriptionModalSource,
  /todayDateOnlyInTimezone\(timezone\)/,
  'el alta compartida debe usar la fecha del negocio'
)
assert.match(
  subscriptionModalSource,
  /currency: accountCurrency/,
  'el alta compartida debe guardar la moneda configurada en la cuenta'
)
assert.match(
  paymentSelectorSource,
  /hasOnlinePaymentPlanProvider[\s\S]*parcialidades offline/i,
  'el selector debe explicar el plan offline cuando no existe una pasarela'
)

console.log('Desktop chat payment flow contract OK')
