import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PAYMENT_GATEWAYS,
  MSI_INSTALLMENT_CHOICES,
  MSI_LINK_GATEWAYS,
  STRIPE_MSI_MIN_AMOUNT,
  isNormalizedPaymentGateEnabled,
  conektaInstallmentMonths,
  msiEligibility,
  buildStripeAppearanceVariables
} from '../../shared/sites/paymentGateContract.js'
import { renderPublicSiteHtml } from '../src/services/sitesService.js'

test('MSI constants stay in lockstep with the runtime', () => {
  assert.deepEqual(MSI_INSTALLMENT_CHOICES, [3, 6, 9, 12, 18, 24])
  // La fila standalone (hosted-link) es solo Conekta / Mercado Pago; Stripe se
  // maneja aparte dentro del Payment Element.
  assert.ok(MSI_LINK_GATEWAYS.has('conekta') && MSI_LINK_GATEWAYS.has('mercadopago'))
  assert.ok(!MSI_LINK_GATEWAYS.has('stripe'))
  assert.equal(STRIPE_MSI_MIN_AMOUNT, 300)
  assert.ok(PAYMENT_GATEWAYS.has('stripe') && PAYMENT_GATEWAYS.has('conekta') && PAYMENT_GATEWAYS.has('mercadopago'))
})

test('isNormalizedPaymentGateEnabled mirrors backend/frontend predicate', () => {
  assert.equal(isNormalizedPaymentGateEnabled({ enabled: true, amount: 100, gateway: 'stripe' }), true)
  assert.equal(isNormalizedPaymentGateEnabled({ enabled: false, amount: 100, gateway: 'stripe' }), false)
  assert.equal(isNormalizedPaymentGateEnabled({ enabled: true, amount: 0, gateway: 'stripe' }), false)
  assert.equal(isNormalizedPaymentGateEnabled({ enabled: true, amount: 100, gateway: 'paypal' }), false)
})

test('conektaInstallmentMonths filters by max AND amount (>= months*100)', () => {
  // amount 250: ningún mes alcanza (3*100 = 300 > 250) -> fila oculta en vivo
  assert.deepEqual(conektaInstallmentMonths({ maxInstallments: 12, amount: 250 }), [])
  // amount 900: 3 y 6 (900>=600) pero no 9 (900<900? 900>=900 -> sí) -> 3,6,9
  assert.deepEqual(conektaInstallmentMonths({ maxInstallments: 12, amount: 900 }), [3, 6, 9])
  // tope del max: 6 meses -> solo 3 y 6 aunque el monto alcance más
  assert.deepEqual(conektaInstallmentMonths({ maxInstallments: 6, amount: 5000 }), [3, 6])
  // sin diferido (<=1)
  assert.deepEqual(conektaInstallmentMonths({ maxInstallments: 1, amount: 5000 }), [])
})

test('msiEligibility routes per gateway exactly like the live runtime', () => {
  const msi = { enabled: true, maxInstallments: 12 }
  // Conekta: fila standalone con meses filtrados
  assert.deepEqual(
    msiEligibility({ gateway: 'conekta', currency: 'MXN', amount: 900, msi }),
    { enabled: true, standaloneMonths: [3, 6, 9], insideElement: false, insideBrick: false }
  )
  // Mercado Pago: dentro del Brick, sin fila standalone
  assert.deepEqual(
    msiEligibility({ gateway: 'mercadopago', currency: 'MXN', amount: 900, msi }),
    { enabled: true, standaloneMonths: [], insideElement: false, insideBrick: true }
  )
  // Stripe MXN >= 300: dentro del Payment Element
  assert.deepEqual(
    msiEligibility({ gateway: 'stripe', currency: 'MXN', amount: 300, msi }),
    { enabled: true, standaloneMonths: [], insideElement: true, insideBrick: false }
  )
  // Stripe MXN < 300: no elegible
  assert.equal(msiEligibility({ gateway: 'stripe', currency: 'MXN', amount: 250, msi }).insideElement, false)
  // Stripe no-MXN: no elegible aunque el monto alcance
  assert.equal(msiEligibility({ gateway: 'stripe', currency: 'USD', amount: 1000, msi }).insideElement, false)
  // MSI apagado: nada en ninguna pasarela
  const off = msiEligibility({ gateway: 'conekta', currency: 'MXN', amount: 900, msi: { enabled: false } })
  assert.deepEqual(off, { enabled: false, standaloneMonths: [], insideElement: false, insideBrick: false })
})

test('buildStripeAppearanceVariables: night theme drops colorBackground, stripe theme keeps it', () => {
  const dark = buildStripeAppearanceVariables({ dark: true, accent: '#fff', fieldText: '#eee', muted: '#999', inputBg: '#111', radius: '10px' })
  assert.equal(dark.theme, 'night')
  assert.equal(dark.variables.colorPrimary, '#fff')
  assert.equal(dark.variables.colorText, '#eee')
  assert.equal('colorBackground' in dark.variables, false)

  const light = buildStripeAppearanceVariables({ dark: false, accent: '#000', fieldText: '#111', muted: '#777', inputBg: '#fff', radius: '8px' })
  assert.equal(light.theme, 'stripe')
  assert.equal(light.variables.colorBackground, '#fff')
})

function paymentSite(overrides = {}) {
  return {
    id: 'site_payment_contract',
    name: 'Pago',
    title: 'Pago',
    description: '',
    slug: 'pago-contract',
    siteType: 'landing_page',
    status: 'published',
    theme: { template: 'ristak', pages: [{ id: 'page-1', title: 'P', sortOrder: 0 }] },
    blocks: [
      {
        id: 'pay-1',
        siteId: 'site_payment_contract',
        blockType: 'payment',
        label: 'Pago',
        content: '',
        options: [],
        sortOrder: 0,
        settings: {
          pageId: 'page-1',
          paymentGate: { enabled: true, gateway: 'stripe', amount: 500, currency: 'MXN', productName: 'Curso', buttonText: 'Pagar' },
          ...overrides
        },
        createdAt: '',
        updatedAt: ''
      }
    ]
  }
}

test('E3: pay button renders the configured icon on the published page', async () => {
  const html = await renderPublicSiteHtml(paymentSite({ buttonIcon: 'arrowRight', buttonIconSide: 'right' }), {
    pageId: 'page-1', trackingEnabled: false, preview: true
  })
  // El icono vive fuera del label; el label conserva data-rstk-checkout-pay-label
  // para que el runtime reescriba SOLO el texto y no borre el icono.
  assert.match(html, /rstk-button-content rstk-button-icon-right/)
  assert.match(html, /<span class="rstk-button-label" data-rstk-checkout-pay-label>Pagar · /)
  assert.match(html, /<span class="rstk-button-icon" aria-hidden="true"><svg/)
})

test('E3: plain pay button (no icon) still carries the runtime label hook', async () => {
  const html = await renderPublicSiteHtml(paymentSite(), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /<span class="rstk-button-label" data-rstk-checkout-pay-label>Pagar · /)
  assert.doesNotMatch(html, /rstk-button-content rstk-button-icon-/)
})

test('payment #1: a disabled gate publishes nothing (no ghost wrapper)', async () => {
  const html = await renderPublicSiteHtml(paymentSite({ paymentGate: { enabled: false, gateway: 'stripe', amount: 500, currency: 'MXN' } }), {
    pageId: 'page-1', trackingEnabled: false, preview: true
  })
  // Tags de apertura que SOLO existen en el markup renderizado del bloque: ni la
  // hoja de estilos (reglas .rstk-checkout-*{}) ni el runtime ([data-rstk-checkout])
  // los contienen.
  assert.doesNotMatch(html, /<section class="rstk-payment-block/)
  assert.doesNotMatch(html, /<strong class="rstk-checkout-title">/)
})

test('payment #1 (control): an enabled gate DOES render the block markup', async () => {
  const html = await renderPublicSiteHtml(paymentSite(), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /<section class="rstk-payment-block/)
  assert.match(html, /<strong class="rstk-checkout-title">Curso<\/strong>/)
})

// Nota: el runtime embebido menciona los selectores [data-rstk-identity-*] y
// [data-rstk-checkout-identity], así que aserimos sobre el MARKUP renderizado
// (<div class="rstk-checkout-identity">, <input ... data-rstk-identity-*>) y sobre
// los atributos data-collect-* de la <section>, que solo existen en el bloque.
test('identity: Stripe checkout renders email/phone capture by default (to link the contact)', async () => {
  const html = await renderPublicSiteHtml(paymentSite(), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /<div class="rstk-checkout-identity"/)
  assert.match(html, /<input[^>]+data-rstk-identity-email/)
  assert.match(html, /<input[^>]+data-rstk-identity-phone/)
  assert.match(html, /data-collect-email="true"/)
  assert.match(html, /data-collect-phone="true"/)
})

test('identity: only the configured field renders (phone off => no phone input, ≥1 stays)', async () => {
  const html = await renderPublicSiteHtml(paymentSite({ paymentCollectPhone: false }), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.match(html, /<input[^>]+data-rstk-identity-email/)
  assert.doesNotMatch(html, /<input[^>]+data-rstk-identity-phone/)
  assert.match(html, /data-collect-email="true"/)
  assert.match(html, /data-collect-phone="false"/)
})

test('identity: CLIP/MercadoPago do NOT get the shared block (they collect identity in their own SDK)', async () => {
  const clip = await renderPublicSiteHtml(paymentSite({ paymentGate: { enabled: true, gateway: 'clip', amount: 500, currency: 'MXN', productName: 'Curso', buttonText: 'Pagar' } }), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.doesNotMatch(clip, /<div class="rstk-checkout-identity"/)
  assert.match(clip, /data-collect-email="false"/)
  const both = await renderPublicSiteHtml(paymentSite({ paymentCollectEmail: false, paymentCollectPhone: false }), { pageId: 'page-1', trackingEnabled: false, preview: true })
  assert.doesNotMatch(both, /<div class="rstk-checkout-identity"/)
})

test('E4: field text color sanitizer allows modern rgb(... / ...) values', async () => {
  const html = await renderPublicSiteHtml(paymentSite({ paymentFieldTextColor: 'rgb(0 0 0 / 50%)' }), {
    pageId: 'page-1', trackingEnabled: false, preview: true
  })
  assert.match(html, /--rstk-checkout-field-text:rgb\(0 0 0 \/ 50%\)/)
})

test('E4 guard: the checkout runtime builds the same Stripe appearance variable keys as the shared builder', async () => {
  const html = await renderPublicSiteHtml(paymentSite(), { pageId: 'page-1', trackingEnabled: false, preview: true })
  const keys = Object.keys(buildStripeAppearanceVariables({ dark: false, accent: 'x', fieldText: 'x', muted: 'x', inputBg: 'x', radius: 'x' }).variables)
  for (const key of keys) {
    assert.ok(html.includes(key), `runtime script debe declarar la variable de apariencia ${key}`)
  }
})
