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
