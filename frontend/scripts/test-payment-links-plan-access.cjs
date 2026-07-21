const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: filename
  })
  module._compile(outputText, filename)
}

const {
  hasPaymentAutomationsAccess,
  hasPaymentCheckoutAccess,
  hasPaymentGatewaysAccess,
  hasPaymentLinksAccess,
  hasPaymentPlansAccess,
  hasSavedPaymentMethodsAccess,
  hasSubscriptionsAccess
} = require('../src/utils/accessControl.ts')

const licensedUser = (licensePlan, enabled = true) => ({
  licenseEnforced: true,
  licensePlan,
  licenseFeatures: {
    payment_automations: enabled,
    payment_checkout: enabled,
    payment_gateways: enabled,
    payment_links: enabled,
    payment_plans: enabled,
    saved_payment_methods: enabled,
    subscriptions: enabled
  }
})

test('la interfaz web reserva los cobros por pasarela para Profesional', () => {
  for (const accessCheck of [
    hasPaymentAutomationsAccess,
    hasPaymentCheckoutAccess,
    hasPaymentGatewaysAccess,
    hasPaymentLinksAccess,
    hasPaymentPlansAccess,
    hasSavedPaymentMethodsAccess,
    hasSubscriptionsAccess
  ]) {
    assert.equal(accessCheck(licensedUser('basic')), false)
    assert.equal(accessCheck(licensedUser('medium')), false)
    assert.equal(accessCheck(licensedUser('professional')), true)
    assert.equal(accessCheck(licensedUser('premium')), true)
    assert.equal(accessCheck(licensedUser('professional', false)), false)
    assert.equal(accessCheck({ licenseEnforced: false }), true)
  }
})

test('registro de pago y chatbot ocultan links aunque una licencia vieja los marque activos', () => {
  const modalSource = fs.readFileSync(path.join(__dirname, '../src/components/common/RecordPaymentModal/RecordPaymentModal.tsx'), 'utf8')
  const chatbotSource = fs.readFileSync(path.join(__dirname, '../src/pages/Settings/ConversationalAgentSettings.tsx'), 'utf8')
  const phoneChatSource = fs.readFileSync(path.join(__dirname, '../src/pages/PhoneChat/PhoneChat.tsx'), 'utf8')
  const gatewayHookSource = fs.readFileSync(path.join(__dirname, '../src/hooks/usePaymentGatewayCapabilities.ts'), 'utf8')

  assert.match(modalSource, /hasPaymentLinksAccess\(user\)/)
  assert.match(modalSource, /const paymentLinkGatewayLabels = canUsePaymentLinks \?/)
  assert.match(chatbotSource, /canUsePaymentLinks && <option value="payment_link">/)
  assert.match(chatbotSource, /collectionMethod: canUsePaymentLinks \? 'payment_link' : 'bank_transfer'/)
  assert.match(phoneChatSource, /paymentCapabilities\.canUsePaymentLinks \? \[\{ value: 'payment_link', label: 'Link de pago' \}\] : \[\]/)
  assert.match(phoneChatSource, /collectionMethod: paymentCapabilities\.canUsePaymentLinks \? 'payment_link' : 'bank_transfer'/)
  assert.match(gatewayHookSource, /useIntegrationsStatus\(\{ enabled: canUsePaymentGateways \}\)/)
  assert.match(gatewayHookSource, /canUsePaymentPlans: canUsePaymentPlans &&/)
  assert.match(gatewayHookSource, /canUseSubscriptions: canUseSubscriptions &&/)
})
