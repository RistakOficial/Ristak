import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import JSZip from 'jszip'

import { db, setAppConfig } from '../src/config/database.js'
import {
  enqueueGigstackInvoiceDeliveryJobs,
  getGigstackFiscalProfile,
  getGigstackInvoiceDeliveryPublicFile,
  getGigstackInvoiceFileDownload,
  inspectGigstackPaymentForTransaction,
  reconcileGigstackPaymentForTransaction,
  processDueGigstackInvoiceDeliveryJobs,
  processGigstackInvoiceDeliveryJob,
  processGigstackInvoiceJob,
  registerGigstackPaymentForTransaction,
  registerGigstackPaymentForTransactionInBackground,
  setGigstackInvoiceDeliveryDependenciesForTest,
  testGigstackConnection
} from '../src/services/gigstackInvoiceService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { signPublicContextClaims } from '../src/services/publicContextTokenService.js'
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

async function withInvoiceRecoveryPayment(run, { metadata, taxes = {} } = {}) {
  const paymentId = `recovery_${crypto.randomUUID()}`
  const contactId = `contact_${paymentId}`
  await initializeMasterKey()
  await savePaymentSettings({ taxes: {
    enabled: true,
    gigstackEnabled: true,
    gigstackTestApiToken: fakeGigstackToken(false),
    gigstackSendEmail: false,
    gigstackSendWhatsapp: false,
    ...taxes
  } }, { allowGigstackFiscalOverride: true })
  await db.run('INSERT INTO contacts (id, email, full_name) VALUES (?, ?, ?)', [contactId, `${paymentId}@example.com`, 'Invoice recovery test'])
  await db.run(
    "INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, metadata_json) VALUES (?, ?, 116, 'MXN', 'paid', 'test', ?)",
    [paymentId, contactId, JSON.stringify(metadata ?? { tax: {
      enabled: true, taxName: 'IVA', rateValue: 16, calculationMode: 'inclusive',
      subtotalAmount: 100, taxAmount: 16, totalAmount: 116
    } })]
  )
  const readFiscal = async () => JSON.parse((await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])).metadata_json).gigstack
  const readJob = () => db.get('SELECT * FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
  const retry = async () => {
    await db.run('UPDATE gigstack_invoice_jobs SET next_attempt_at_ms = 0 WHERE payment_id = ?', [paymentId])
    return processGigstackInvoiceJob(paymentId)
  }
  try {
    await run({ paymentId, readFiscal, readJob, retry })
  } finally {
    await db.run('DELETE FROM gigstack_invoice_delivery_jobs WHERE payment_id = ?', [paymentId])
    await db.run('DELETE FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

function gigstackResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  setGigstackInvoiceDeliveryDependenciesForTest(null)
  await setAppConfig('payments_settings', null)
})

describe('Gigstack payment registration', () => {
  it('previews and reconciles a blocked legacy job without registering or delivering anything', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, readJob }) => {
      await db.run("INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode, status, attempt_count, last_error) VALUES (?, 'test', 'blocked', 2, 'gigstack_http_400: [object Object]')", [paymentId])
      const before = await readFiscal()
      globalThis.fetch = async (url, options) => {
        assert.equal(options.method, 'GET')
        return String(url).includes('/invoices/income/')
          ? gigstackResponse({ data: { status: 'stamped', livemode: false } })
          : gigstackResponse({ data: { id: 'payment_blocked', status: 'succeeded', invoices: ['invoice_existing'], livemode: false } })
      }
      const preview = await reconcileGigstackPaymentForTransaction(paymentId)
      assert.equal(preview.dryRun, true)
      assert.equal(preview.canReconcile, true)
      assert.deepEqual(await readFiscal(), before)
      assert.equal((await readJob()).attempt_count, 2)
      assert.equal((await reconcileGigstackPaymentForTransaction(paymentId, { dryRun: false })).registered, true)
      assert.equal((await readFiscal()).status, 'stamped')
      assert.equal((await readJob()).status, 'registered')
      assert.equal((await readFiscal()).reconcileOnly, true)
      assert.equal((await registerGigstackPaymentForTransaction(paymentId)).registered, true)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM gigstack_invoice_delivery_jobs WHERE payment_id = ?', [paymentId])).count, 0)
    }, {
      metadata: { gigstack: { mode: 'test', status: 'error', pendingRemotePaymentId: 'payment_blocked', pendingInvoiceIds: [] } },
      taxes: { gigstackSendEmail: true, gigstackSendWhatsapp: true }
    })
  })

  it('manual reconciliation never queues automatic retries or accepts a payment without a remote identity', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readJob }) => {
      globalThis.fetch = async () => { throw new Error('No provider call allowed') }
      await assert.rejects(() => inspectGigstackPaymentForTransaction(paymentId), { code: 'gigstack_remote_payment_required' })
      await assert.rejects(() => reconcileGigstackPaymentForTransaction(paymentId, { dryRun: false }), { code: 'gigstack_remote_payment_required' })
      assert.equal(await readJob(), null)
    })
    await withInvoiceRecoveryPayment(async ({ paymentId, readJob }) => {
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.method, 'GET')
        return gigstackResponse({ data: { id: 'payment_pending', status: 'succeeded', invoices: [], livemode: false } })
      }
      const preview = await inspectGigstackPaymentForTransaction(paymentId)
      assert.equal(preview.canReconcile, false)
      assert.equal(preview.verificationError.code, 'gigstack_invoice_pending')
      const result = await reconcileGigstackPaymentForTransaction(paymentId, { dryRun: false })
      assert.equal(result.code, 'gigstack_invoice_pending')
      assert.equal(result.retryable, false)
      assert.equal((await readJob()).status, 'blocked')
    }, { metadata: { gigstack: { mode: 'test', pendingRemotePaymentId: 'payment_pending' } } })
  })

  it('registers once and reconciles a pending PUE with GET, preserving intent when settings change', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, readJob, retry }) => {
      const requests = []
      let ready = false
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname
        requests.push([options.method, path])
        if (options.method === 'POST') {
          assert.equal(JSON.parse(options.body).idempotency_key, `ristak-payment-${paymentId}`)
          assert.equal((await readJob()).status, 'processing')
          return gigstackResponse({ data: { id: 'payment_recovery', status: 'succeeded', livemode: false, invoices: [] } })
        }
        if (path === '/v2/payments/payment_recovery') {
          return gigstackResponse({ data: { id: 'payment_recovery', status: 'succeeded', livemode: false, invoices: ready ? ['invoice_recovery'] : [] } })
        }
        assert.equal(path, '/v2/invoices/income/invoice_recovery')
        assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_recovery')
        return gigstackResponse({ data: { status: 'stamped', uuid: 'uuid_recovery', livemode: false } })
      }

      const first = await registerGigstackPaymentForTransactionInBackground(paymentId)
      assert.equal(first.code, 'gigstack_invoice_pending')
      assert.equal(first.retryable, true)
      assert.equal((await readJob()).remote_payment_id, 'payment_recovery')
      assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_recovery')
      assert.equal((await retry()).code, 'gigstack_invoice_pending')

      await savePaymentSettings({ taxes: { enabled: false, gigstackAutomationType: 'none', gigstackAutomateInvoiceOnComplete: false } }, { allowGigstackFiscalOverride: true })
      ready = true
      assert.equal((await retry()).registered, true)
      const fiscal = await readFiscal()
      assert.equal(fiscal.status, 'stamped')
      assert.equal(fiscal.automationType, 'pue_invoice')
      assert.equal(fiscal.id, 'payment_recovery')
      assert.equal(fiscal.pendingRemotePaymentId, null)
      assert.deepEqual(fiscal.pendingInvoiceIds, [])
      assert.equal((await readJob()).status, 'registered')
      assert.equal((await registerGigstackPaymentForTransaction(paymentId)).reason, 'already_registered')
      assert.deepEqual(requests, [
        ['POST', '/v2/payments/register'],
        ['GET', '/v2/payments/payment_recovery'],
        ['GET', '/v2/payments/payment_recovery'],
        ['GET', '/v2/invoices/income/invoice_recovery']
      ])
    })
  })

  it('reconciles an existing legacy remote payment without adding a missing tax snapshot', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal }) => {
      const requests = []
      globalThis.fetch = async (url, options) => {
        assert.equal(options.method, 'GET')
        requests.push(new URL(url).pathname)
        if (requests.length === 1) return gigstackResponse({ data: { id: 'payment_legacy', status: 'succeeded', invoices: [] } })
        return gigstackResponse({ data: { status: 'valid', uuid: 'legacy_uuid', livemode: false } })
      }
      assert.equal((await registerGigstackPaymentForTransactionInBackground(paymentId)).registered, true)
      assert.equal((await readFiscal()).status, 'stamped')
      const metadata = JSON.parse((await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])).metadata_json)
      assert.equal(Object.hasOwn(metadata, 'tax'), false)
      assert.deepEqual(requests, ['/v2/payments/payment_legacy', '/v2/invoices/income/invoice_legacy'])
    }, { metadata: { gigstack: {
      mode: 'test', status: 'error', pendingRemotePaymentId: 'payment_legacy',
      pendingInvoiceIds: ['invoice_legacy'], error: '[object Object]'
    } } })
  })

  it('never falls back to registering again when the remote payment lookup fails', async () => {
    for (const status of [400, 404, 429, 503]) {
      await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, readJob }) => {
        let calls = 0
        globalThis.fetch = async (url, options) => {
          calls += 1
          assert.equal(options.method, 'GET')
          assert.match(String(url), /\/payments\/payment_existing$/)
          return gigstackResponse({ error: { code: 'PROVIDER_ERROR', message: 'Consulta fallida' } }, status)
        }
        const result = await registerGigstackPaymentForTransactionInBackground(paymentId)
        assert.equal(result.code, `gigstack_http_${status}`)
        assert.equal(result.retryable, status === 429 || status === 503)
        assert.equal(calls, 1)
        assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_existing')
        assert.equal((await readJob()).remote_payment_id, 'payment_existing')
      }, { metadata: { gigstack: { mode: 'test', pendingRemotePaymentId: 'payment_existing' } } })
    }
  })

  it('saves the remote acknowledgement before invoice lookup fails', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, retry }) => {
      let posts = 0
      let invoiceReady = false
      globalThis.fetch = async (url, options) => {
        if (options.method === 'POST') posts += 1
        if (String(url).includes('/invoices/income/')) {
          assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_ack')
          if (!invoiceReady) throw new TypeError('fetch failed')
          return gigstackResponse({ data: { status: 'stamped', livemode: false } })
        }
        return gigstackResponse({ data: { id: 'payment_ack', status: 'succeeded', invoices: ['invoice_ack'], livemode: false } })
      }
      assert.equal((await registerGigstackPaymentForTransactionInBackground(paymentId)).code, 'gigstack_network_error')
      invoiceReady = true
      assert.equal((await retry()).registered, true)
      assert.equal(posts, 1)
    })
  })

  it('keeps a remote identity even when its first response has an unexpected status', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, retry }) => {
      let posts = 0
      globalThis.fetch = async (url, options) => {
        if (options.method === 'POST') posts += 1
        return gigstackResponse({ data: { id: 'payment_processing', status: 'processing', invoices: [], livemode: false } })
      }
      assert.equal((await registerGigstackPaymentForTransactionInBackground(paymentId)).code, 'gigstack_unexpected_status')
      assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_processing')
      assert.equal((await retry()).code, 'gigstack_unexpected_status')
      assert.equal(posts, 1)
    })
  })

  it('blocks mismatched payment identities and environments without replacing the saved reference', async () => {
    for (const remote of [
      { id: 'payment_wrong', livemode: false },
      { id: 'payment_expected', livemode: true }
    ]) {
      await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal }) => {
        let calls = 0
        globalThis.fetch = async (url, options) => {
          calls += 1
          assert.equal(options.method, 'GET')
          return gigstackResponse({ data: { ...remote, status: 'succeeded', invoices: ['invoice_wrong'] } })
        }
        const result = await registerGigstackPaymentForTransactionInBackground(paymentId)
        assert.equal(result.retryable, false)
        assert.equal(result.code, remote.livemode ? 'gigstack_response_mode_mismatch' : 'gigstack_payment_identity_mismatch')
        assert.equal((await readFiscal()).pendingRemotePaymentId, 'payment_expected')
        assert.equal(calls, 1)
      }, { metadata: { gigstack: { mode: 'test', pendingRemotePaymentId: 'payment_expected' } } })
    }
  })

  it('rejects a changed historical mode before any reconciliation request', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId }) => {
      let calls = 0
      globalThis.fetch = async () => { calls += 1; throw new Error('Unexpected request') }
      const result = await registerGigstackPaymentForTransactionInBackground(paymentId)
      assert.equal(result.code, 'gigstack_payment_mode_changed')
      assert.equal(calls, 0)
    }, { metadata: { gigstack: { mode: 'live', pendingRemotePaymentId: 'payment_live' } } })
  })

  it('preserves structured provider errors in payment metadata and the durable job', async () => {
    await withInvoiceRecoveryPayment(async ({ paymentId, readFiscal, readJob }) => {
      globalThis.fetch = async () => gigstackResponse({
        message: 'No se pudo facturar',
        error: {
          code: 'INVALID_FISCAL_DATA', message: 'Datos fiscales inválidos',
          details: [{ field: 'tax_id', message: 'RFC inválido' }, { postal_code: ['Falta código postal'] }],
          request: { token: 'must-not-be-stored' }
        }
      }, 400)
      assert.equal((await registerGigstackPaymentForTransactionInBackground(paymentId)).code, 'gigstack_http_400')
      const fiscal = await readFiscal()
      assert.match(fiscal.error, /No se pudo facturar/)
      assert.match(fiscal.error, /INVALID_FISCAL_DATA/)
      assert.match(fiscal.error, /RFC inválido/)
      assert.match(fiscal.error, /postal_code: Falta código postal/)
      assert.doesNotMatch(fiscal.error, /\[object Object\]|must-not-be-stored/)
      assert.match((await readJob()).last_error, /RFC inválido/)
    })
  })

  it('never queues or sends an untaxed payment, even with global taxes and Gigstack enabled', async () => {
    await savePaymentSettings({ taxes: { enabled: true, gigstackEnabled: true, rateValue: 16 } }, { allowGigstackFiscalOverride: true })
    let requests = 0
    globalThis.fetch = async () => { requests += 1; throw new Error('No debe llamar al proveedor') }

    for (const metadata of [{}, { tax: { enabled: false } }, { tax: null }, { applyTax: false, tax: { enabled: true, rateValue: 16 } }]) {
      const paymentId = `untaxed_${crypto.randomUUID()}`
      try {
        await db.run(
          `INSERT INTO payments (id, amount, currency, status, payment_mode, metadata_json)
           VALUES (?, 6000, 'MXN', 'paid', 'live', ?)`,
          [paymentId, JSON.stringify(metadata)]
        )
        assert.deepEqual(await registerGigstackPaymentForTransactionInBackground(paymentId), { skipped: true, reason: 'missing_tax' })
        assert.deepEqual(await registerGigstackPaymentForTransaction(paymentId), { skipped: true, reason: 'missing_tax' })
        assert.equal(await db.get('SELECT payment_id FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId]), null)
      } finally {
        await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      }
    }
    assert.equal(requests, 0)
  })

  it('rechecks a previously queued payment before contacting Gigstack', async () => {
    await savePaymentSettings({ taxes: { enabled: true, gigstackEnabled: true } }, { allowGigstackFiscalOverride: true })
    const paymentId = `untaxed_retry_${crypto.randomUUID()}`
    let requests = 0
    globalThis.fetch = async () => { requests += 1; throw new Error('No debe llamar al proveedor') }
    try {
      await db.run("INSERT INTO payments (id, amount, currency, status, payment_mode, metadata_json) VALUES (?, 20000, 'MXN', 'paid', 'live', ?)", [paymentId, JSON.stringify({ tax: { enabled: false } })])
      await db.run("INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode, status) VALUES (?, 'live', 'retry')", [paymentId])
      const result = await processGigstackInvoiceJob(paymentId)
      assert.equal(result.reason, 'missing_tax')
      assert.equal((await db.get('SELECT status FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])).status, 'skipped')
      assert.equal(requests, 0)
    } finally {
      await db.run('DELETE FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    }
  })

  it('imports the fiscal profile and tax rate from the Gigstack team', async () => {
    const testToken = fakeGigstackToken(false)
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/teams\/team_example$/)
      assert.equal(options.headers.Authorization, `Bearer ${testToken}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            id: 'team_example',
            legal_name: 'Clínica Ejemplo SA de CV',
            tax_id: 'CEE010101AAA',
            tax_system: '601',
            address: { country: 'MEX', zip: '06600' },
            sat: { completed: true },
            settings: {
              default_description: 'Consulta médica',
              product_key: '85121600',
              unit_key: 'E48',
              taxes: [{ type: 'IVA', rate: 0.16, inclusive: true, withholding: false }]
            }
          }
        })
      }
    }

    const profile = await getGigstackFiscalProfile({ mode: 'test', token: testToken })
    assert.deepEqual(profile, {
      teamId: 'team_example',
      satConnected: true,
      fiscalId: 'CEE010101AAA',
      fiscalLegalName: 'Clínica Ejemplo SA de CV',
      fiscalPostalCode: '06600',
      fiscalRegime: '601',
      taxName: 'IVA',
      rateValue: 16,
      taxFactor: 'Tasa',
      calculationMode: 'inclusive',
      country: 'MX',
      defaultDescription: 'Consulta médica',
      productKey: '85121600',
      unitKey: 'E48',
      unitName: 'Unidad de servicio'
    })
  })

  it('refuses to activate a Gigstack team with an incomplete fiscal profile', async () => {
    const testToken = fakeGigstackToken(false)
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          id: 'team_example',
          legal_name: 'Negocio incompleto',
          tax_id: '',
          tax_system: '601',
          address: { country: 'MEX', zip: '06600' },
          sat: { completed: true },
          settings: {
            product_key: '01010101',
            unit_key: 'E48',
            taxes: [{ type: 'IVA', rate: 0, factor: 'Exento', withholding: false }]
          }
        }
      })
    })

    await assert.rejects(
      () => getGigstackFiscalProfile({ mode: 'test', token: testToken }),
      (error) => error.code === 'gigstack_fiscal_profile_incomplete' && error.status === 409
    )
  })

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
    }, { allowGigstackFiscalOverride: true })

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
            update: false
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
        send_email: false,
        ignore_emails: true
      })
      const storedPayment = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
      const storedMetadata = JSON.parse(storedPayment.metadata_json)
      assert.equal(storedMetadata.gigstack.status, 'stamped')
      assert.equal(storedMetadata.gigstack.livemode, false)
      assert.equal(storedMetadata.gigstack.invoices[0].status, 'stamped')
      const deliveryJobs = await db.all(
        `SELECT channel, document_format, status
         FROM gigstack_invoice_delivery_jobs
         WHERE payment_id = ?
         ORDER BY channel, document_format`,
        [paymentId]
      )
      assert.deepEqual(deliveryJobs, [
        { channel: 'email', document_format: 'bundle', status: 'pending' },
        { channel: 'whatsapp', document_format: 'pdf', status: 'pending' },
        { channel: 'whatsapp', document_format: 'xml', status: 'pending' }
      ])
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
    }, { allowGigstackFiscalOverride: true })
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
    }, { allowGigstackFiscalOverride: true })
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

  it('downloads the stamped Test invoice as a ZIP with PDF and XML', async () => {
    const suffix = Date.now().toString(36)
    const paymentId = `payment_gigstack_files_${suffix}`
    const testToken = fakeGigstackToken(false)
    const apiAuthorizations = []
    const storageAuthorizations = []

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackTestApiToken: testToken,
        rateValue: 16,
        gigstackSatConnected: true
      }
    }, { allowGigstackFiscalOverride: true })
    await db.run(
      `INSERT INTO payments (
        id, amount, currency, status, payment_mode, payment_provider, metadata_json,
        date, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        116,
        'MXN',
        'paid',
        'test',
        'stripe',
        JSON.stringify({
          gigstack: {
            status: 'stamped',
            mode: 'test',
            invoices: [{ id: 'invoice_files_1', uuid: 'UUID-FILES-1', status: 'stamped' }]
          }
        })
      ]
    )

    const pdf = Buffer.from('%PDF-1.4 test invoice')
    const xml = Buffer.from('<?xml version="1.0"?><cfdi/>')
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url)
      if (href.startsWith('https://api.gigstack.io/')) {
        apiAuthorizations.push(options.headers?.Authorization)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              pdf_url: 'https://storage.googleapis.com/gigstack-test/invoice.pdf',
              xml_url: 'https://storage.googleapis.com/gigstack-test/invoice.xml'
            }
          })
        }
      }
      storageAuthorizations.push(options.headers?.Authorization)
      const buffer = href.endsWith('.pdf') ? pdf : xml
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(buffer.length) },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
    }

    try {
      const download = await getGigstackInvoiceFileDownload(paymentId, 'zip')
      assert.equal(download.contentType, 'application/zip')
      assert.equal(download.fileName, 'factura-UUID-FILES-1.zip')
      assert.deepEqual(apiAuthorizations, [`Bearer ${testToken}`, `Bearer ${testToken}`])
      assert.deepEqual(storageAuthorizations, [undefined, undefined])
      const archive = await JSZip.loadAsync(download.buffer)
      assert.deepEqual(Object.keys(archive.files).sort(), [
        'factura-UUID-FILES-1.pdf',
        'factura-UUID-FILES-1.xml'
      ])
      assert.equal(await archive.file('factura-UUID-FILES-1.pdf').async('string'), pdf.toString())
      assert.equal(await archive.file('factura-UUID-FILES-1.xml').async('string'), xml.toString())
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    }
  })

  it('delivers PDF and XML through the current QR conversation and attaches both by email', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_delivery_${suffix}`
    const paymentId = `payment_gigstack_delivery_${suffix}`
    const invoiceId = `invoice_delivery_${suffix}`
    const testToken = fakeGigstackToken(false)
    const whatsappDocuments = []
    const emails = []
    const pdf = Buffer.from('%PDF-1.4 fiscal delivery')
    const xml = Buffer.from('<?xml version="1.0"?><cfdi/>')

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackSatConnected: true,
        gigstackTestApiToken: testToken,
        gigstackSendWhatsapp: true,
        gigstackSendEmail: true
      }
    }, { allowGigstackFiscalOverride: true })
    await db.run(
      `INSERT INTO contacts (
         id, email, full_name, first_name, phone,
         preferred_whatsapp_phone_number_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        contactId,
        `delivery-${suffix}@example.com`,
        'Cliente Fiscal',
        'Cliente',
        '+5215512345678',
        'phone_qr_delivery'
      ]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         metadata_json, date, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'paid', 'test', 'stripe', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, 1160, 'MXN', '{}']
    )

    globalThis.fetch = async (url) => {
      assert.match(String(url), new RegExp(`/invoices/${invoiceId}/files`))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            pdf: `data:application/pdf;base64,${pdf.toString('base64')}`,
            xml: xml.toString('utf8')
          }
        })
      }
    }
    setGigstackInvoiceDeliveryDependenciesForTest({
      resolvePaymentWhatsAppRoute: async (contact) => {
        assert.equal(contact.preferredWhatsAppPhoneNumberId, 'phone_qr_delivery')
        return {
          available: true,
          transport: 'qr',
          fromPhone: '+526561111111',
          phoneNumberId: 'phone_qr_delivery'
        }
      },
      paymentWhatsAppRouteArgs: (route) => ({
        from: route.fromPhone,
        phoneNumberId: route.phoneNumberId,
        transport: 'qr',
        allowQrFallback: false
      }),
      sendWhatsAppApiDocumentMessage: async (payload) => {
        whatsappDocuments.push(payload)
        return {
          id: `qr-doc-${whatsappDocuments.length}`,
          status: 'delivered',
          transport: 'qr',
          to: payload.to
        }
      },
      sendWhatsAppApiTextMessage: async () => {
        throw new Error('QR debe enviar el XML como documento, no como enlace')
      },
      sendEmailToContact: async (payload) => {
        emails.push(payload)
        return { messageId: 'smtp-fiscal-1', status: 'sent', to: payload.to }
      }
    })

    try {
      const queued = await enqueueGigstackInvoiceDeliveryJobs(paymentId, {
        mode: 'test',
        invoices: [{ id: invoiceId, uuid: 'UUID-DELIVERY', status: 'stamped' }],
        taxes: { gigstackSendWhatsapp: true, gigstackSendEmail: true }
      })
      assert.equal(queued.queued, 3)

      const results = await processDueGigstackInvoiceDeliveryJobs()
      assert.equal(results.filter(result => result.sent).length, 3)
      assert.deepEqual(
        whatsappDocuments.map(message => message.filename).sort(),
        ['factura-UUID-DELIVERY.pdf', 'factura-UUID-DELIVERY.xml']
      )
      assert.equal(whatsappDocuments.every(message => message.sensitive === true), true)
      const sentPdf = whatsappDocuments.find(message => message.filename.endsWith('.pdf'))
      const sentXml = whatsappDocuments.find(message => message.filename.endsWith('.xml'))
      assert.equal(
        Buffer.from(sentPdf.documentDataUrl.split(',')[1], 'base64').toString(),
        pdf.toString()
      )
      assert.equal(
        Buffer.from(sentXml.documentDataUrl.split(',')[1], 'base64').toString(),
        xml.toString()
      )
      assert.equal(emails.length, 1)
      assert.deepEqual(emails[0].attachments.map(attachment => attachment.filename), [
        'factura-UUID-DELIVERY.pdf',
        'factura-UUID-DELIVERY.xml'
      ])
      assert.equal(emails[0].attachments[0].content.toString(), pdf.toString())
      assert.equal(emails[0].attachments[1].content.toString(), xml.toString())

      const jobs = await db.all(
        `SELECT channel, document_format, status
         FROM gigstack_invoice_delivery_jobs
         WHERE payment_id = ?
         ORDER BY channel, document_format`,
        [paymentId]
      )
      assert.deepEqual(jobs, [
        { channel: 'email', document_format: 'bundle', status: 'sent' },
        { channel: 'whatsapp', document_format: 'pdf', status: 'sent' },
        { channel: 'whatsapp', document_format: 'xml', status: 'sent' }
      ])
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })

  it('uses an expiring private link for XML on the official WhatsApp API', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_api_xml_${suffix}`
    const paymentId = `payment_gigstack_api_xml_${suffix}`
    const invoiceId = `invoice_api_xml_${suffix}`
    const sentTexts = []

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackSatConnected: true,
        gigstackTestApiToken: fakeGigstackToken(false),
        gigstackSendWhatsapp: true,
        gigstackSendEmail: false
      }
    }, { allowGigstackFiscalOverride: true })
    await db.run(
      `INSERT INTO contacts (id, full_name, first_name, phone, created_at, updated_at)
       VALUES (?, 'Cliente API', 'Cliente', '+5215512345679', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         payment_url, metadata_json, date, created_at, updated_at
       ) VALUES (?, ?, 1160, 'MXN', 'paid', 'test', 'stripe', ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId, `https://pagos.example.test/pay/${paymentId}`]
    )
    setGigstackInvoiceDeliveryDependenciesForTest({
      resolvePaymentWhatsAppRoute: async () => ({
        available: true,
        transport: 'api',
        fromPhone: '+526561111111',
        phoneNumberId: 'phone_api_delivery'
      }),
      paymentWhatsAppRouteArgs: () => ({
        from: '+526561111111',
        phoneNumberId: 'phone_api_delivery',
        allowQrFallback: true
      }),
      signPublicContextClaims: async ({ purpose, claims, ttlSeconds }) => {
        assert.equal(purpose, 'gigstack.invoice.delivery')
        assert.equal(claims.invoiceId, invoiceId)
        assert.equal(claims.format, 'xml')
        assert.equal(ttlSeconds, 24 * 60 * 60)
        return 'signed-xml-token'
      },
      sendWhatsAppApiTextMessage: async (payload) => {
        sentTexts.push(payload)
        return { id: 'wamid-xml-link', status: 'sent', transport: 'api', to: payload.to }
      },
      sendWhatsAppApiDocumentMessage: async () => {
        throw new Error('La API oficial no debe intentar adjuntar XML')
      }
    })

    try {
      await enqueueGigstackInvoiceDeliveryJobs(paymentId, {
        mode: 'test',
        invoices: [{ id: invoiceId, uuid: 'UUID-API-XML', status: 'stamped' }],
        taxes: { gigstackSendWhatsapp: true, gigstackSendEmail: false }
      })
      const xmlJob = await db.get(
        `SELECT id FROM gigstack_invoice_delivery_jobs
         WHERE payment_id = ? AND channel = 'whatsapp' AND document_format = 'xml'`,
        [paymentId]
      )
      const result = await processGigstackInvoiceDeliveryJob(xmlJob.id)
      assert.equal(result.sent, true)
      assert.equal(sentTexts.length, 1)
      assert.match(sentTexts[0].text, /enlace privado vence en 24 horas/i)
      assert.match(
        sentTexts[0].text,
        /https:\/\/pagos\.example\.test\/api\/settings\/payments\/gigstack-invoice-file\/signed-xml-token/
      )
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })

  it('serves the XML only through a valid signed delivery capability', async () => {
    const suffix = Date.now().toString(36)
    const contactId = `contact_gigstack_private_xml_${suffix}`
    const paymentId = `payment_gigstack_private_xml_${suffix}`
    const invoiceId = `invoice_private_xml_${suffix}`
    const xml = Buffer.from('<?xml version="1.0"?><cfdi:Comprobante/>')

    await initializeMasterKey()
    await savePaymentSettings({
      taxes: {
        enabled: true,
        gigstackEnabled: true,
        gigstackSatConnected: true,
        gigstackTestApiToken: fakeGigstackToken(false),
        gigstackSendWhatsapp: true,
        gigstackSendEmail: false
      }
    }, { allowGigstackFiscalOverride: true })
    await db.run(
      `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
       VALUES (?, 'Cliente XML privado', '+5215512345680', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_mode, payment_provider,
         metadata_json, date, created_at, updated_at
       ) VALUES (?, ?, 1160, 'MXN', 'paid', 'test', 'stripe', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    globalThis.fetch = async (url) => {
      assert.match(String(url), new RegExp(`/invoices/${invoiceId}/files`))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { xml: xml.toString('utf8') } })
      }
    }

    try {
      await enqueueGigstackInvoiceDeliveryJobs(paymentId, {
        mode: 'test',
        invoices: [{ id: invoiceId, uuid: 'UUID-PRIVATE-XML', status: 'stamped' }],
        taxes: { gigstackSendWhatsapp: true, gigstackSendEmail: false }
      })
      const xmlJob = await db.get(
        `SELECT id FROM gigstack_invoice_delivery_jobs
         WHERE payment_id = ? AND channel = 'whatsapp' AND document_format = 'xml'`,
        [paymentId]
      )
      const capability = await signPublicContextClaims({
        purpose: 'gigstack.invoice.delivery',
        claims: {
          jobId: xmlJob.id,
          paymentId,
          invoiceId,
          format: 'xml'
        },
        ttlSeconds: 24 * 60 * 60
      })

      const result = await getGigstackInvoiceDeliveryPublicFile(capability)
      assert.equal(result.contentType, 'application/xml')
      assert.equal(result.fileName, 'factura-UUID-PRIVATE-XML.xml')
      assert.equal(result.buffer.toString(), xml.toString())
      await assert.rejects(
        () => getGigstackInvoiceDeliveryPublicFile(`${capability}alterado`),
        /Firma pública inválida/
      )
    } finally {
      await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})
