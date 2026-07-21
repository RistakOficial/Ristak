import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const backendRoot = join(repoRoot, 'backend')
const frontendRoot = join(repoRoot, 'frontend')

test('payments sidebar hides premium payment sections when license features are disabled', async () => {
  const sidebarSource = await readFile(join(frontendRoot, 'src/components/layout/Sidebar/Sidebar.tsx'), 'utf8')

  assert.match(sidebarSource, /to: '\/transactions\/payment-plans', label: 'Planes de pago', featureKeys: \['payment_plans'\]/)
  assert.match(sidebarSource, /to: '\/transactions\/subscriptions', label: 'Suscripciones', featureKeys: \['subscriptions'\]/)
  assert.match(sidebarSource, /PAYMENTS_NAV_ITEMS\.filter\(\(item\) => !item\.featureKeys \|\| hasLicenseFeature\(user, item\.featureKeys\)\)/)
})

test('premium payment pages require their own license features, not only the payments module', async () => {
  const appSource = await readFile(join(frontendRoot, 'src/App.tsx'), 'utf8')

  assert.match(appSource, /featureKeys\?: readonly string\[\]/)
  assert.match(appSource, /!hasLicenseFeature\(user, featureKeys\)/)
  assert.match(appSource, /path="transactions\/payment-plans\/\*" element=\{<AccessRoute moduleKey="payments" featureKeys=\{\['payment_plans'\]\}>/)
  assert.match(appSource, /path="transactions\/subscriptions\/\*" element=\{<AccessRoute moduleKey="payments" featureKeys=\{\['subscriptions'\]\}>/)
})

test('premium payment APIs require payment plan and subscription features', async () => {
  const transactionsRoutes = await readFile(join(backendRoot, 'src/routes/transactions.routes.js'), 'utf8')
  const subscriptionsRoutes = await readFile(join(backendRoot, 'src/routes/subscriptions.routes.js'), 'utf8')
  const stripeRoutes = await readFile(join(backendRoot, 'src/routes/stripe.routes.js'), 'utf8')
  const conektaRoutes = await readFile(join(backendRoot, 'src/routes/conekta.routes.js'), 'utf8')
  const mercadoPagoRoutes = await readFile(join(backendRoot, 'src/routes/mercadopago.routes.js'), 'utf8')

  assert.match(transactionsRoutes, /const requirePaymentPlansFeature = requireFeature\('payment_plans'\)/)
  for (const route of [
    "router.get('/payment-plans', requirePaymentPlansFeature, listPaymentPlans)",
    "router.post('/payment-plans', requirePaymentPlansFeature, createPaymentPlan)",
    "router.get('/payment-plans/:scheduleId', requirePaymentPlansFeature, getPaymentPlan)",
    "router.put('/payment-plans/:scheduleId', requirePaymentPlansFeature, updatePaymentPlan)",
    "router.post('/payment-plans/:scheduleId/action', requirePaymentPlansFeature, actionPaymentPlan)",
    "router.post('/payment-flows/installments', requirePaymentPlansFeature, createPaymentInstallmentFlow)"
  ]) {
    assert.ok(transactionsRoutes.includes(route), `transactions route missing feature gate: ${route}`)
  }

  assert.match(subscriptionsRoutes, /router\.use\(requireFeature\('subscriptions'\)\)/)
  assert.match(stripeRoutes, /router\.post\('\/payment-plans', requireModuleAccess\('payments'\), requirePaymentPlansFeature, createStripePaymentPlanView\)/)
  assert.match(stripeRoutes, /router\.post\('\/public\/payments\/:publicPaymentId\/subscription-checkout', requireSubscriptionsFeature, createPublicStripeSubscriptionCheckoutView\)/)
  assert.match(conektaRoutes, /router\.post\('\/payment-plans', requireModuleAccess\('payments'\), requirePaymentPlansFeature, createConektaPaymentPlanView\)/)
  assert.match(conektaRoutes, /router\.post\('\/public\/payments\/:publicPaymentId\/subscription', requireSubscriptionsFeature, createPublicConektaSubscriptionView\)/)
  assert.match(mercadoPagoRoutes, /router\.post\('\/payment-plans', requireModuleAccess\('payments'\), requirePaymentPlansFeature, createMercadoPagoPaymentPlanView\)/)
})

test('gateway configuration and payment-link creation require Professional features', async () => {
  for (const fileName of ['stripe.routes.js', 'conekta.routes.js', 'mercadopago.routes.js', 'clip.routes.js', 'rebill.routes.js']) {
    const source = await readFile(join(backendRoot, 'src/routes', fileName), 'utf8')
    assert.match(source, /const requirePaymentGatewaysFeature = requireFeature\('payment_gateways'\)/, `${fileName} does not protect gateway configuration`)
    assert.match(source, /const requirePaymentLinksFeature = requireFeature\('payment_links'\)/, `${fileName} does not protect payment links`)
    assert.match(source, /router\.post\('\/payment-links', requireModuleAccess\('payments'\), requirePaymentLinksFeature,/, `${fileName} payment-link route is not protected`)
  }

  const highLevelRoutes = await readFile(join(backendRoot, 'src/routes/highlevel.routes.js'), 'utf8')
  const mcpRoutes = await readFile(join(backendRoot, 'src/routes/mcp.routes.js'), 'utf8')
  assert.match(highLevelRoutes, /router\.post\('\/invoices\/:invoiceId\/send', requireModuleAccess\('payments'\), requireFeature\('payment_links'\), sendInvoice\)/)
  assert.match(highLevelRoutes, /router\.post\('\/text2pay', requireModuleAccess\('payments'\), requireFeature\('payment_links'\), text2Pay\)/)
  assert.match(mcpRoutes, /ghl_create_payment_link: \['integrations', 'payments', 'payment_links'\]/)
})

test('AI payment entry points fail closed when online-payment features are unavailable', async () => {
  const appAssistantTools = await readFile(join(backendRoot, 'src/agents/tools/paymentFlowTools.js'), 'utf8')
  const conversationalTools = await readFile(join(backendRoot, 'src/agents/conversational/tools.js'), 'utf8')
  const aiAgentService = await readFile(join(backendRoot, 'src/services/aiAgentService.js'), 'utf8')
  const testPaymentService = await readFile(join(backendRoot, 'src/services/conversationalAgentTestPaymentService.js'), 'utf8')

  assert.match(appAssistantTools, /unavailablePaymentFeature\('payment_links'\)/)
  assert.match(appAssistantTools, /unavailablePaymentFeature\('payment_gateways'\)/)
  assert.match(appAssistantTools, /unavailablePaymentFeature\('saved_payment_methods'\)/)
  assert.match(conversationalTools, /hasFeature\('payment_links'\)/)
  assert.match(aiAgentService, /hasFeature\('payment_links'\)/)
  assert.match(testPaymentService, /hasFeature\('payment_links'\)/)
})
