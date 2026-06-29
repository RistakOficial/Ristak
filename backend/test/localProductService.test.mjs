import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db } from '../src/config/database.js'
import {
  createLocalProduct,
  updateLocalProduct
} from '../src/services/localProductService.js'

const cleanupProductIds = new Set()

afterEach(async () => {
  for (const productId of cleanupProductIds) {
    await db.run('DELETE FROM product_prices WHERE product_id = ?', [productId]).catch(() => undefined)
    await db.run('DELETE FROM products WHERE id = ?', [productId]).catch(() => undefined)
  }
  cleanupProductIds.clear()
})

describe('local product catalog', () => {
  it('creates and updates multiple prices with SKU without keeping removed prices', async () => {
    const product = await createLocalProduct({
      name: `Producto prueba catálogo ${Date.now()}`,
      description: 'Producto con varias opciones de precio',
      productType: 'service',
      currency: 'MXN',
      prices: [
        { name: 'Base', amount: 1000, currency: 'MXN', sku: 'BASE-001' },
        { name: 'Premium', amount: 1600, currency: 'MXN', sku: 'PREM-001' }
      ]
    }, { sync: false })

    cleanupProductIds.add(product.localId)

    assert.equal(product.productType, 'SERVICE')
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
      prices: [
        { localId: basePrice.localId, name: 'Base ajustado', amount: 1100, currency: 'MXN', sku: 'BASE-NEW' },
        { name: 'VIP', amount: 2500, currency: 'MXN', sku: 'VIP-001' }
      ]
    }, { sync: false })

    assert.equal(updated.productType, 'PACKAGE')
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
})
