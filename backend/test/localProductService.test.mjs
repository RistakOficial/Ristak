import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'

import { db } from '../src/config/database.js'
import GHLClient from '../src/services/ghlClient.js'
import {
  createLocalProduct,
  syncHighLevelProductsToLocal,
  updateLocalProduct
} from '../src/services/localProductService.js'
import {
  dispatchProductPostWebhooksForPayment
} from '../src/services/productPostWebhookService.js'

const cleanupProductIds = new Set()
const cleanupPaymentIds = new Set()

afterEach(async () => {
  for (const paymentId of cleanupPaymentIds) {
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
  }
  for (const productId of cleanupProductIds) {
    await db.run('DELETE FROM product_prices WHERE product_id = ?', [productId]).catch(() => undefined)
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => undefined)
  }
  cleanupPaymentIds.clear()
  cleanupProductIds.clear()
})

describe('local product catalog', () => {
  it('creates and updates multiple prices with SKU without keeping removed prices', async () => {
    const product = await createLocalProduct({
      name: `Producto prueba catálogo ${Date.now()}`,
      description: 'Producto con varias opciones de precio',
      productType: 'service',
      currency: 'MXN',
      gigstackProductKey: '82101800',
      gigstackUnitKey: 'E48',
      gigstackUnitName: 'Unidad de Servicio',
      postWebhooks: [
        {
          id: 'primary_webhook',
          url: 'https://example.test/ristak/product-paid',
          authorization: 'Bearer product-secret',
          headers: { 'X-Product-Hook': 'catalog' },
          bodyMode: 'fields',
          bodyFields: [
            { key: 'campaign', value: 'catalog-launch' },
            { key: 'source', value: 'product-modal' }
          ]
        }
      ],
      prices: [
        { name: 'Base', amount: 1000, currency: 'MXN', sku: 'BASE-001' },
        { name: 'Premium', amount: 1600, currency: 'MXN', sku: 'PREM-001' }
      ]
    }, { sync: false })

    cleanupProductIds.add(product.localId)

    assert.equal(product.productType, 'SERVICE')
    assert.equal(product.gigstackProductKey, '82101800')
    assert.equal(product.gigstackUnitKey, 'E48')
    assert.equal(product.gigstackUnitName, 'Unidad de Servicio')
    assert.equal(product.postWebhooks.length, 1)
    assert.equal(product.postWebhooks[0].url, 'https://example.test/ristak/product-paid')
    assert.equal(product.postWebhooks[0].authorization, 'Bearer product-secret')
    assert.deepEqual(product.postWebhooks[0].headers, { 'X-Product-Hook': 'catalog' })
    assert.equal(product.postWebhooks[0].bodyMode, 'fields')
    assert.deepEqual(product.postWebhooks[0].bodyFields, [
      { key: 'campaign', value: 'catalog-launch' },
      { key: 'source', value: 'product-modal' }
    ])
    assert.deepEqual(product.postWebhooks[0].body, {
      campaign: 'catalog-launch',
      source: 'product-modal'
    })
    assert.equal(product.prices.length, 2)
    assert.deepEqual(
      product.prices.map((price) => price.sku).sort(),
      ['BASE-001', 'PREM-001']
    )

    const basePrice = product.prices.find((price) => price.name === 'Base')
    assert.ok(basePrice?.localId)

    const updated = await updateLocalProduct(product.localId, {
      name: product.name,
      description: product.description,
      productType: 'package',
      currency: 'MXN',
      gigstackProductKey: '80101500',
      gigstackUnitKey: 'H87',
      gigstackUnitName: 'Pieza',
      postWebhooks: [
        {
          id: 'updated_webhook',
          url: 'https://example.test/ristak/product-updated',
          headers: { 'X-Product-Hook': 'updated' },
          bodyMode: 'json',
          body: {
            channel: 'crm',
            nested: { tier: 'vip' }
          }
        }
      ],
      prices: [
        { localId: basePrice.localId, name: 'Base ajustado', amount: 1100, currency: 'MXN', sku: 'BASE-NEW' },
        { name: 'VIP', amount: 2500, currency: 'MXN', sku: 'VIP-001' }
      ]
    }, { sync: false })

    assert.equal(updated.productType, 'PACKAGE')
    assert.equal(updated.gigstackProductKey, '80101500')
    assert.equal(updated.gigstackUnitKey, 'H87')
    assert.equal(updated.gigstackUnitName, 'Pieza')
    assert.equal(updated.postWebhooks.length, 1)
    assert.equal(updated.postWebhooks[0].url, 'https://example.test/ristak/product-updated')
    assert.deepEqual(updated.postWebhooks[0].headers, { 'X-Product-Hook': 'updated' })
    assert.equal(updated.postWebhooks[0].bodyMode, 'json')
    assert.deepEqual(updated.postWebhooks[0].body, {
      channel: 'crm',
      nested: { tier: 'vip' }
    })
    assert.equal(updated.prices.length, 2)
    assert.deepEqual(
      updated.prices.map((price) => price.name).sort(),
      ['Base ajustado', 'VIP']
    )
    assert.deepEqual(
      updated.prices.map((price) => price.sku).sort(),
      ['BASE-NEW', 'VIP-001']
    )

    const rows = await db.all(
      'SELECT name, sku, amount FROM product_prices WHERE product_id = ? ORDER BY name ASC',
      [product.localId]
    )

    assert.deepEqual(rows, [
      { name: 'Base ajustado', sku: 'BASE-NEW', amount: 1100 },
      { name: 'VIP', sku: 'VIP-001', amount: 2500 }
    ])
  })

  it('dispatches product POST webhooks with payment and product payload once per status', async () => {
    const product = await createLocalProduct({
      name: `Producto webhook ${Date.now()}`,
      description: 'Producto con webhook POST',
      productType: 'digital',
      currency: 'MXN',
      postWebhooks: [
        {
          id: 'payment_status_hook',
          url: 'https://example.test/ristak/payment-status',
          authorization: 'Bearer webhook-token',
          headers: { 'X-Webhook-Test': 'ok' },
          bodyMode: 'json',
          body: {
            campaign: 'paid-product',
            nested: { source: 'product-modal' },
            product: { shouldNotOverrideCoreProduct: true }
          }
        }
      ],
      prices: [
        { name: 'Base', amount: 1500, currency: 'MXN', sku: 'HOOK-BASE' }
      ]
    }, { sync: false })
    cleanupProductIds.add(product.localId)

    const price = product.prices[0]
    const paymentId = `payment_webhook_${Date.now()}`
    cleanupPaymentIds.add(paymentId)

    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_provider,
        title, description, date, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        null,
        1500,
        'MXN',
        'paid',
        'stripe',
        'stripe',
        product.name,
        product.description,
        JSON.stringify({
          lineItems: [
            {
              name: product.name,
              productId: product.localId,
              localProductId: product.localId,
              priceId: price.localId,
              amount: 1500,
              currency: 'MXN',
              sku: 'HOOK-BASE'
            }
          ],
          source: 'test'
        })
      ]
    )

    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, options = {}) => {
      calls.push({
        url,
        options,
        body: JSON.parse(options.body)
      })
      return {
        ok: true,
        status: 202,
        text: async () => 'accepted'
      }
    }

    try {
      const result = await dispatchProductPostWebhooksForPayment(paymentId, {
        status: 'paid',
        previousStatus: 'pending'
      })

      assert.equal(result.sent, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://example.test/ristak/payment-status')
      assert.equal(calls[0].options.method, 'POST')
      assert.equal(calls[0].options.headers.Authorization, 'Bearer webhook-token')
      assert.equal(calls[0].options.headers['X-Webhook-Test'], 'ok')
      assert.equal(calls[0].body.event, 'payment.paid')
      assert.equal(calls[0].body.campaign, 'paid-product')
      assert.deepEqual(calls[0].body.nested, { source: 'product-modal' })
      assert.equal(calls[0].body.previousStatus, 'pending')
      assert.equal(calls[0].body.payment.id, paymentId)
      assert.equal(calls[0].body.payment.amount, 1500)
      assert.equal(calls[0].body.payment.metadata.source, 'test')
      assert.equal(Object.hasOwn(calls[0].body.payment, 'mercadoPagoPaymentId'), false)
      assert.equal(Object.hasOwn(calls[0].body.payment, 'clipPaymentId'), false)
      assert.equal(Object.hasOwn(calls[0].body.payment, 'rebillPaymentId'), false)
      assert.equal(calls[0].body.product.localId, product.localId)
      assert.equal(calls[0].body.product.name, product.name)
      assert.equal(calls[0].body.product.shouldNotOverrideCoreProduct, undefined)
      assert.equal(calls[0].body.product.postWebhooks, undefined)
      assert.equal(calls[0].body.lineItem.localProductId, product.localId)

      const second = await dispatchProductPostWebhooksForPayment(paymentId, {
        status: 'paid',
        previousStatus: 'pending'
      })
      assert.equal(second.attempted, 0)
      assert.equal(calls.length, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends only populated fields for the payment gateway that actually processed the charge', async () => {
    const suffix = Date.now()
    const product = await createLocalProduct({
      name: `Producto webhook por pasarela ${suffix}`,
      description: 'Producto para validar payloads simples por pasarela',
      productType: 'digital',
      currency: 'MXN',
      postWebhooks: [
        {
          id: 'gateway_specific_hook',
          url: 'https://example.test/ristak/gateway-specific'
        }
      ],
      prices: [
        { name: 'Base', amount: 100, currency: 'MXN', sku: `GATEWAY-${suffix}` }
      ]
    }, { sync: false })
    cleanupProductIds.add(product.localId)

    const price = product.prices[0]
    const providerFields = [
      'stripePaymentIntentId',
      'stripeChargeId',
      'mercadoPagoPaymentId',
      'mercadoPagoPreferenceId',
      'conektaOrderId',
      'conektaChargeId',
      'clipPaymentId',
      'clipReceiptNo',
      'rebillPaymentId',
      'rebillSubscriptionId',
      'rebillCustomerId',
      'rebillCardId'
    ]
    const cases = [
      {
        provider: 'stripe',
        metadataKey: 'stripe',
        expectedFields: ['stripePaymentIntentId', 'stripeChargeId']
      },
      {
        provider: 'mercadopago',
        metadataKey: 'mercadoPago',
        expectedFields: ['mercadoPagoPaymentId', 'mercadoPagoPreferenceId']
      },
      {
        provider: 'conekta',
        metadataKey: 'conekta',
        expectedFields: ['conektaOrderId', 'conektaChargeId']
      },
      {
        provider: 'clip',
        metadataKey: 'clip',
        expectedFields: ['clipPaymentId', 'clipReceiptNo']
      },
      {
        provider: 'rebill',
        metadataKey: 'rebill',
        expectedFields: ['rebillPaymentId', 'rebillSubscriptionId', 'rebillCustomerId', 'rebillCardId']
      }
    ]

    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return {
        ok: true,
        status: 202,
        text: async () => 'accepted'
      }
    }

    try {
      for (const [index, testCase] of cases.entries()) {
        const paymentId = `payment_gateway_${testCase.provider}_${suffix}`
        cleanupPaymentIds.add(paymentId)
        const metadata = {
          lineItems: [
            {
              name: product.name,
              localProductId: product.localId,
              priceId: price.localId,
              amount: 100,
              currency: 'MXN'
            }
          ],
          source: 'gateway-matrix-test',
          keepZero: 0,
          keepFalse: false,
          emptyText: '',
          emptyObject: {},
          gatewayContext: {
            stripe: { id: 'pi_metadata' },
            mercadoPago: { id: 'mp_metadata' },
            conekta: { id: 'ord_metadata' },
            clip: { id: 'clip_metadata' },
            rebill: { id: 'rebill_metadata' },
            highLevel: { id: 'ghl_metadata' }
          },
          productPostWebhookDeliveries: {
            historical: { attemptedAt: '2026-01-01T00:00:00.000Z', ok: true }
          }
        }

        await db.run(
          `INSERT INTO payments (
            id, amount, currency, status, payment_method, payment_mode, payment_provider,
            title, date, stripe_payment_intent_id, stripe_charge_id,
            mercadopago_payment_id, mercadopago_preference_id,
            conekta_order_id, conekta_charge_id, clip_payment_id, clip_receipt_no,
            rebill_payment_id, rebill_subscription_id, rebill_customer_id, rebill_card_id,
            metadata_json, created_at, updated_at
          ) VALUES (
            ?, 100, 'MXN', 'paid', ?, 'live', ?, ?, CURRENT_TIMESTAMP,
            'pi_actual', 'ch_actual', 'mp_actual', 'pref_actual',
            'ord_actual', 'charge_actual', 'clip_actual', 'receipt_actual',
            'rebill_actual', 'rebill_sub_actual', 'rebill_customer_actual', 'rebill_card_actual',
            ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )`,
          [paymentId, testCase.provider, testCase.provider, product.name, JSON.stringify(metadata)]
        )

        const result = await dispatchProductPostWebhooksForPayment(paymentId, { status: 'paid' })
        assert.equal(result.sent, 1)

        const payload = calls[index].body
        assert.equal(payload.payment.paymentProvider, testCase.provider)
        assert.equal(payload.payment.metadata.source, 'gateway-matrix-test')
        assert.equal(payload.payment.metadata.keepZero, 0)
        assert.equal(payload.payment.metadata.keepFalse, false)
        assert.equal(Object.hasOwn(payload.payment.metadata, 'emptyText'), false)
        assert.equal(Object.hasOwn(payload.payment.metadata, 'emptyObject'), false)
        assert.equal(Object.hasOwn(payload.payment.metadata, 'productPostWebhookDeliveries'), false)
        assert.deepEqual(Object.keys(payload.payment.metadata.gatewayContext), [testCase.metadataKey])

        for (const field of providerFields) {
          assert.equal(
            Object.hasOwn(payload.payment, field),
            testCase.expectedFields.includes(field),
            `${field} no corresponde al pago procesado por ${testCase.provider}`
          )
        }
      }

      assert.equal(calls.length, cases.length)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves Ristak-only webhooks when HighLevel refreshes the product mirror', async () => {
    const locationId = `location_product_webhook_${Date.now()}`
    const remoteProductId = `ghl_product_webhook_${Date.now()}`
    const product = await createLocalProduct({
      name: `Producto webhook sincronizado ${Date.now()}`,
      description: 'El espejo remoto no debe borrar configuración local',
      productType: 'service',
      currency: 'MXN',
      gigstackProductKey: '80141600',
      postWebhooks: [
        {
          id: 'preserved_webhook',
          url: 'https://example.test/ristak/preserved-webhook',
          headers: { 'X-Preserved': 'yes' }
        }
      ],
      prices: [
        { name: 'Base', amount: 100, currency: 'MXN', sku: 'PRESERVE-100' }
      ]
    }, { sync: false })
    cleanupProductIds.add(product.localId)

    await db.run(
      `UPDATE products
       SET ghl_product_id = ?, location_id = ?, sync_status = 'synced', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [remoteProductId, locationId, product.localId]
    )

    mock.method(GHLClient.prototype, 'listProducts', async function listProducts() {
      return {
        products: [
          {
            _id: remoteProductId,
            name: product.name,
            description: 'Descripción actualizada desde HighLevel',
            productType: 'SERVICE',
            currency: 'MXN',
            locationId
          }
        ]
      }
    })
    mock.method(GHLClient.prototype, 'listPrices', async function listPrices() {
      return { prices: [] }
    })

    try {
      const result = await syncHighLevelProductsToLocal(locationId, 'test-token')
      assert.equal(result.savedProducts, 1)

      const refreshed = await db.get('SELECT * FROM products WHERE id = ?', [product.localId])
      const webhooks = JSON.parse(refreshed.post_webhooks)
      assert.equal(refreshed.description, 'Descripción actualizada desde HighLevel')
      assert.equal(refreshed.gigstack_product_key, '80141600')
      assert.equal(webhooks.length, 1)
      assert.equal(webhooks[0].id, 'preserved_webhook')
      assert.equal(webhooks[0].url, 'https://example.test/ristak/preserved-webhook')
    } finally {
      mock.restoreAll()
    }
  })
})
