import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db } from '../src/config/database.js'
import {
  createLocalProduct,
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
          headers: { 'X-Product-Hook': 'catalog' }
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
          headers: { 'X-Product-Hook': 'updated' }
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
          headers: { 'X-Webhook-Test': 'ok' }
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
      assert.equal(calls[0].body.previousStatus, 'pending')
      assert.equal(calls[0].body.payment.id, paymentId)
      assert.equal(calls[0].body.payment.amount, 1500)
      assert.equal(calls[0].body.payment.metadata.source, 'test')
      assert.equal(calls[0].body.product.localId, product.localId)
      assert.equal(calls[0].body.product.name, product.name)
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
})
