import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import { registerGigstackPaymentForTransaction } from '../src/services/gigstackInvoiceService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await setAppConfig('payments_settings', null)
})

describe('Gigstack payment registration', () => {
  it('builds the register payment payload with product fiscal mapping', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_${suffix}`
    const productId = `product_gigstack_${suffix}`
    const paymentId = `payment_gigstack_${suffix}`
    let capturedRequest = null

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        taxName: 'IVA',
        country: 'MX',
        calculationMode: 'inclusive',
        fiscalId: 'AAA010101AAA',
        fiscalLegalName: 'Empresa Demo',
        fiscalPostalCode: '06600',
        fiscalRegime: '601',
        gigstackEnabled: true,
        gigstackApiToken: 'test-token',
        gigstackDefaultProductKey: '01010101',
        gigstackDefaultUnitKey: 'H87',
        gigstackDefaultUnitName: 'Pieza',
        gigstackDefaultPaymentMethod: '99',
        gigstackAutomateInvoiceOnComplete: true
      }
    })

    await db.run(
      `INSERT INTO contacts (id, email, full_name, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `cliente-${suffix}@example.com`, 'Cliente Demo', `+5200${suffix}`]
    )
    await db.run(
      `INSERT INTO products (
        id, name, description, currency, gigstack_product_key, gigstack_unit_key,
        gigstack_unit_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [productId, 'Consultoría marketing', 'Servicios de consultoría en mercadotecnia', 'MXN', '82101800', 'E48', 'Unidad de Servicio']
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_provider,
        title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        contactId,
        1160,
        'MXN',
        'paid',
        'stripe',
        'stripe',
        'Consultoría marketing',
        'Servicios de consultoría en mercadotecnia',
        JSON.stringify({
          lineItems: [{
            productId,
            description: 'Servicios de consultoría en mercadotecnia',
            quantity: 1,
            amount: 1000
          }],
          tax: {
            enabled: true,
            taxName: 'IVA',
            rateValue: 16,
            rateSource: 'automatic',
            calculationMode: 'inclusive',
            subtotalAmount: 1000,
            taxAmount: 160,
            totalAmount: 1160
          }
        })
      ]
    )

    globalThis.fetch = async (url, options) => {
      capturedRequest = { url, options, body: JSON.parse(options.body) }
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { id: 'gigstack_payment_1', status: 'registered' } })
      }
    }

    try {
      const result = await registerGigstackPaymentForTransaction(paymentId)

      assert.equal(result.registered, true)
      assert.match(capturedRequest.url, /\/payments\/register$/)
      assert.equal(capturedRequest.options.headers.Authorization, 'Bearer test-token')
      assert.deepEqual(capturedRequest.body, {
        paid: true,
        items: [{
          description: 'Servicios de consultoría en mercadotecnia',
          discount: 0,
          product_key: '82101800',
          unit_key: 'E48',
          unit_name: 'Unidad de Servicio',
          taxes: [{
            factor: 'Tasa',
            inclusive: true,
            rate: 0.16,
            type: 'IVA',
            withholding: false
          }],
          quantity: 1,
          amount: 1160
        }],
        currency: 'MXN',
        paymentMethod: '04',
        automateInvoiceOnComplete: true,
        clientId: '',
        email: `cliente-${suffix}@example.com`
      })
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM products WHERE id = ?', [productId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})
