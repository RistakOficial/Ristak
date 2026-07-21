import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db, setAppConfig } from '../src/config/database.js'
import {
  processGigstackInvoiceJob,
  registerGigstackPaymentForTransaction,
  registerGigstackPaymentForTransactionInBackground,
  testGigstackConnection
} from '../src/services/gigstackInvoiceService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

const originalFetch = globalThis.fetch

function fakeGigstackToken(livemode) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    livemode,
    key_id: livemode ? 'sk_live_example' : 'sk_test_example',
    team: 'team_example'
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  await setAppConfig('payments_settings', null)
})

describe('Gigstack payment registration', () => {
  it('tests a Test key with a read-only request and never registers a payment', async () => {
    const testToken = fakeGigstackToken(false)
    let capturedRequest = null
    globalThis.fetch = async (url, options) => {
      capturedRequest = { url: String(url), options }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'payment_example', livemode: false }] })
      }
    }

    const result = await testGigstackConnection({ mode: 'test', token: testToken })

    assert.equal(result.connected, true)
    assert.equal(result.mode, 'test')
    assert.match(capturedRequest.url, /\/payments\?limit=1$/)
    assert.equal(capturedRequest.options.method, 'GET')
    assert.equal(capturedRequest.options.body, undefined)
    assert.equal(capturedRequest.options.headers.Authorization, `Bearer ${testToken}`)
  })

  it('builds the register payment payload with product fiscal mapping', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_${suffix}`
    const productId = `product_gigstack_${suffix}`
    const paymentId = `payment_gigstack_${suffix}`
    const testToken = fakeGigstackToken(false)
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
        gigstackTestApiToken: testToken,
        gigstackDefaultDescription: 'Servicios de consultoría en mercadotecnia',
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
        id, contact_id, amount, currency, status, payment_method, payment_mode, payment_provider,
        title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        contactId,
        1160,
        'MXN',
        'paid',
        'stripe',
        'test',
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
      if (String(url).includes('/invoices/income/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              uuid: 'invoice_test_1',
              status: 'stamped',
              livemode: false,
              verification_url: 'https://example.test/verify'
            }
          })
        }
      }
      capturedRequest = { url, options, body: JSON.parse(options.body) }
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { id: 'gigstack_payment_1', status: 'succeeded', livemode: false, invoices: ['invoice_test_1'] } })
      }
    }

    try {
      const result = await registerGigstackPaymentForTransaction(paymentId)

      assert.equal(result.registered, true)
      assert.match(capturedRequest.url, /\/payments\/register$/)
      assert.equal(capturedRequest.options.headers.Authorization, `Bearer ${testToken}`)
      assert.deepEqual(capturedRequest.body, {
        client: {
          search: {
            on_key: 'email',
            on_value: `cliente-${suffix}@example.com`,
            auto_create: true
          },
          name: 'Cliente Demo',
          email: `cliente-${suffix}@example.com`,
          phone: `+5200${suffix}`
        },
        automation_type: 'pue_invoice',
        currency: 'MXN',
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
          unit_price: 1160
        }],
        payment_form: '99',
        metadata: {
          ristak_payment_id: paymentId,
          ristak_payment_mode: 'test'
        },
        idempotency_key: `ristak-payment-${paymentId}`,
        send_email: true
      })
      const storedPayment = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
      const storedMetadata = JSON.parse(storedPayment.metadata_json)
      assert.equal(storedMetadata.gigstack.status, 'stamped')
      assert.equal(storedMetadata.gigstack.livemode, false)
      assert.equal(storedMetadata.gigstack.invoices[0].status, 'stamped')
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM products WHERE id = ?', [productId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })

  it('never uses the Test key for a Live payment', async () => {
    const suffix = Date.now().toString(36)
    const paymentId = `payment_gigstack_live_guard_${suffix}`
    let fetchCalls = 0

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        country: 'MX',
        calculationMode: 'inclusive',
        gigstackEnabled: true,
        gigstackTestApiToken: fakeGigstackToken(false)
      }
    })
    await db.run(
      `INSERT INTO payments (
        id, amount, currency, status, payment_method, payment_mode, payment_provider,
        metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        116,
        'MXN',
        'paid',
        'stripe',
        'live',
        'stripe',
        JSON.stringify({
          tax: {
            enabled: true,
            taxName: 'IVA',
            rateValue: 16,
            calculationMode: 'inclusive',
            subtotalAmount: 100,
            taxAmount: 16,
            totalAmount: 116
          }
        })
      ]
    )
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error('fetch must not be called')
    }

    try {
      await assert.rejects(
        () => registerGigstackPaymentForTransaction(paymentId),
        (error) => error.code === 'missing_live_token'
      )
      assert.equal(fetchCalls, 0)
      const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
      const metadata = JSON.parse(row.metadata_json)
      assert.equal(metadata.gigstack.status, 'blocked')
      assert.equal(metadata.gigstack.mode, 'live')
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    }
  })

  it('persists a retry job before retrying a temporary Gigstack failure', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_retry_${suffix}`
    const paymentId = `payment_gigstack_retry_${suffix}`
    let fetchCalls = 0

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        country: 'MX',
        calculationMode: 'inclusive',
        gigstackEnabled: true,
        gigstackTestApiToken: fakeGigstackToken(false),
        gigstackLiveApiToken: fakeGigstackToken(true)
      }
    })
    await db.run(
      `INSERT INTO contacts (id, email, full_name, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `retry-${suffix}@example.com`, 'Cliente Retry']
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        contactId,
        116,
        'MXN',
        'paid',
        'stripe',
        'test',
        'stripe',
        JSON.stringify({
          tax: {
            enabled: true,
            taxName: 'IVA',
            rateValue: 16,
            calculationMode: 'inclusive',
            subtotalAmount: 100,
            taxAmount: 16,
            totalAmount: 116
          }
        })
      ]
    )
    globalThis.fetch = async () => {
      fetchCalls += 1
      return {
        ok: false,
        status: 503,
        json: async () => ({ message: 'Temporary outage' })
      }
    }

    try {
      const result = await registerGigstackPaymentForTransactionInBackground(paymentId)
      assert.equal(result.error, true)
      assert.equal(result.retryable, true)
      const job = await db.get('SELECT * FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
      assert.equal(job.status, 'retry')
      assert.equal(Number(job.attempt_count), 1)
      assert.ok(Number(job.next_attempt_at_ms) > Date.now())

      const duplicateTrigger = await registerGigstackPaymentForTransactionInBackground(paymentId)
      assert.equal(duplicateTrigger.reason, 'not_claimed')
      const preservedJob = await db.get('SELECT * FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
      assert.equal(preservedJob.status, 'retry')
      assert.equal(Number(preservedJob.attempt_count), 1)

      await db.run('UPDATE payments SET payment_mode = ? WHERE id = ?', ['live', paymentId])
      await db.run('UPDATE gigstack_invoice_jobs SET next_attempt_at_ms = 0 WHERE payment_id = ?', [paymentId])
      fetchCalls = 0

      const changedModeResult = await processGigstackInvoiceJob(paymentId)
      assert.equal(changedModeResult.error, true)
      assert.equal(changedModeResult.retryable, false)
      assert.equal(changedModeResult.code, 'gigstack_payment_mode_changed')
      assert.equal(fetchCalls, 0)

      const blockedJob = await db.get('SELECT * FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
      assert.equal(blockedJob.payment_mode, 'test')
      assert.equal(blockedJob.status, 'blocked')
    } finally {
      await db.run('DELETE FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})
