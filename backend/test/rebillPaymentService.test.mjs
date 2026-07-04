import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  confirmPublicRebillPayment,
  createRebillPaymentLink,
  createRebillPaymentPlan,
  createRebillSavedCardPayment,
  getPublicRebillPayment,
  getRebillPaymentConfig,
  mapRebillStatus,
  processDueRebillPaymentPlanCharges,
  saveRebillPaymentConfig,
  setRebillFetchForTest,
  testRebillPaymentConfig
} from '../src/services/rebillPaymentService.js'
import {
  createPaymentGateLink,
  getPaymentGateStatus
} from '../src/services/publicPaymentGateService.js'

async function snapshotRebillConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'"
  )

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'rebill_%' OR config_key = 'payments_settings'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
    setRebillFetchForTest(null)
  }
}

function jsonTextResponse(payload, status = 200) {
  const text = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    },
    async json() {
      return payload
    }
  }
}

async function cleanupPublicPayment(publicPaymentId) {
  if (!publicPaymentId) return
  await db.run('DELETE FROM installment_payments WHERE payment_id IN (SELECT id FROM payments WHERE public_payment_id = ?)', [publicPaymentId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE public_payment_id = ?', [publicPaymentId]).catch(() => undefined)
}

function uniqueSuffix(label = 'rebill_plan') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function addDaysDateOnly(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

async function cleanupContact(contactId) {
  await db.run(
    `DELETE FROM installment_payments
     WHERE flow_id IN (SELECT id FROM payment_flows WHERE contact_id = ?)
        OR payment_id IN (SELECT id FROM payments WHERE contact_id = ?)`,
    [contactId, contactId]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM payment_plans
     WHERE contact_id = ?
        OR id IN (SELECT id FROM payment_flows WHERE contact_id = ?)`,
    [contactId, contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM rebill_payment_sources WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

function installRebillConfigFetchMock(calls = []) {
  setRebillFetchForTest(async (url, options = {}) => {
    const parsed = new URL(url)
    const method = options.method || 'GET'
    const body = options.body ? JSON.parse(String(options.body)) : null
    calls.push({
      method,
      path: parsed.pathname,
      apiKey: options.headers?.['x-api-key'],
      body
    })

    if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
      return jsonTextResponse({
        id: 'org_rebill_test',
        name: 'Rebill Test Org',
        status: 'active',
        environment: 'test'
      })
    }

    if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
      return jsonTextResponse({ records: [] })
    }

    if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
      assert.equal(body.url, 'https://app.example.test/api/rebill/webhook')
      assert.deepEqual(body.events, ['payment.created', 'payment.updated'])
      return jsonTextResponse({
        id: 'wh_rebill_test',
        url: body.url,
        events: body.events,
        active: true
      }, 201)
    }

    return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
  })
}

test('Rebill estados: cancelado o expirado queda reintentable y rechazo real falla', () => {
  assert.equal(mapRebillStatus('canceled'), 'pending')
  assert.equal(mapRebillStatus('cancelled'), 'pending')
  assert.equal(mapRebillStatus('expired'), 'pending')
  assert.equal(mapRebillStatus('rejected'), 'failed')
  assert.equal(mapRebillStatus('declined'), 'failed')
  assert.equal(mapRebillStatus('approved'), 'paid')
})

test('Rebill guarda llaves por modo cifradas, valida organización y configura webhook', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    installRebillConfigFetchMock(calls)

    const publicKey = 'pk_test_1234567890abcdef'
    const secretKey = 'sk_test_1234567890abcdef'
    const tested = await testRebillPaymentConfig({
      mode: 'test',
      publicKey,
      secretKey
    })

    assert.equal(tested.ok, true)
    assert.equal(tested.organization.id, 'org_rebill_test')
    assert.equal(calls.at(-1).apiKey, secretKey)

    const config = await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })

    assert.equal(config.configured, true)
    assert.equal(config.mode, 'test')
    assert.equal(config.publicKey, publicKey)
    assert.equal(config.hasSecretKey, true)
    assert.equal(config.secretKey, undefined)
    assert.equal(config.accountLabel, 'Rebill Test Org')
    assert.equal(config.webhookConfigured, true)
    assert.equal(config.webhookStatus, 'configured')

    const modeConnections = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['rebill_mode_connections']
    )
    assert.ok(modeConnections?.config_value)
    assert.equal(modeConnections.config_value.includes(secretKey), false)
    assert.equal(modeConnections.config_value.includes(publicKey), true)

    const selectedTest = await getRebillPaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(selectedTest.secretKey, secretKey)
    assert.equal(selectedTest.publicKey, publicKey)

    const legacyLabel = await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      accountLabel: 'Etiqueta vieja',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })
    assert.equal(legacyLabel.accountLabel, 'Etiqueta vieja')

    const refreshedLabel = await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })
    assert.equal(refreshedLabel.accountLabel, 'Rebill Test Org')
  })
})

test('Rebill confirma pago público consultando el paymentId en backend antes de marcarlo pagado', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    const publicKey = 'pk_test_abcdef1234567890'
    const secretKey = 'sk_test_abcdef1234567890'

    setRebillFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const method = options.method || 'GET'
      const body = options.body ? JSON.parse(String(options.body)) : null
      calls.push({
        method,
        path: parsed.pathname,
        apiKey: options.headers?.['x-api-key'],
        body
      })

      if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
        return jsonTextResponse({ id: 'org_rebill_charge', name: 'Rebill Charge Org', status: 'active' })
      }
      if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
        return jsonTextResponse({ records: [] })
      }
      if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
        return jsonTextResponse({ id: 'wh_rebill_charge', url: body.url, events: body.events, active: true }, 201)
      }
      if (parsed.pathname === '/v3/payment-links' && method === 'POST') {
        assert.deepEqual(body.paymentMethods, [{ methods: ['card'], currency: 'MXN' }])
        assert.deepEqual(body.installmentsSettings, [
          { currency: 'MXN', enabledInstallments: [1, 3, 6, 9, 12] }
        ])
        assert.equal(body.showCoupon, false)
        assert.equal(body.isSingleUse, true)
        assert.equal(body.prices[0].amount, 499.5)
        assert.equal(body.prices[0].currency, 'MXN')
        assert.equal(body.metadata.provider, 'rebill')
        assert.match(body.metadata.publicPaymentId, /^rstk_pay_[A-Za-z0-9]{20}$/)
        assert.match(body.metadata.localPaymentId, /^rstk_payment_/)
        assert.equal(body.metadata.businessName, 'Negocio Rebill Test')
        assert.equal(body.metadata.businessLogoUrl, 'https://cdn.example.test/ristak-logo.png')
        assert.equal(body.metadata.supportEmail, 'soporte@negocio.test')
        assert.equal(body.title[0].text, 'Pago Rebill test')
        assert.equal(body.description, undefined)
        assert.equal(body.prefilledFields.customer.email, 'cliente@example.test')
        assert.equal(body.prefilledFields.customer.phoneNumber, '5512345678')
        assert.equal(body.prefilledFields.customer.countryCode, '+52')
        assert.equal(body.redirectUrls.approved, `https://app.example.test/pay/${body.metadata.publicPaymentId}?rebill_return=approved`)
        assert.equal(body.redirectUrls.rejected, `https://app.example.test/pay/${body.metadata.publicPaymentId}?rebill_return=rejected`)
        assert.equal(body.redirectUrls.pending, `https://app.example.test/pay/${body.metadata.publicPaymentId}?rebill_return=pending`)
        return jsonTextResponse({
          id: 'pl_rebill_service_test',
          url: 'https://pay.rebill.com/acme/pl_rebill_service_test',
          status: 'active'
        }, 201)
      }
      if (parsed.pathname === '/v3/payments/pay_rebill_service_test' && method === 'GET') {
        return jsonTextResponse({
          id: 'pay_rebill_service_test',
          status: 'approved',
          amount: 499.5,
          currency: 'MXN',
          approvedAt: '2026-07-03T18:30:00.000Z',
          subscriptionId: 'sub_rebill_service_test',
          customer: { id: 'cus_rebill_service_test' },
          card: {
            id: 'card_rebill_service_test',
            brand: 'visa',
            lastFourDigits: '4242'
          },
          metadata: {
            publicPaymentId
          }
        })
      }

      return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
    })

    await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })
    await setAppConfig('payments_settings', {
      paymentMode: 'test',
      checkout: {
        useBusinessProfile: false,
        logoUrl: 'https://cdn.example.test/ristak-logo.png',
        supportEmail: 'soporte@negocio.test',
        supportPhone: '+52 656 000 0000'
      },
      receipt: {
        useBusinessProfile: false,
        logoUrl: 'https://cdn.example.test/receipt-logo.png',
        businessName: 'Negocio Rebill Test',
        businessEmail: 'ventas@negocio.test',
        businessPhone: '+52 656 111 1111',
        businessAddress: 'Av. Prueba 123, Juarez, Chihuahua',
        businessWebsite: 'https://negocio.example.test',
        showBusinessInfo: true
      }
    })

    let publicPaymentId = ''
    try {
      const link = await createRebillPaymentLink({
        amount: 499.5,
        currency: 'MXN',
        title: 'Pago Rebill test',
        description: 'Pago Rebill test',
        email: 'cliente@example.test',
        phone: '+525512345678',
        installments: { enabled: true, maxInstallments: 12 },
        metadata: { testSource: 'rebillPaymentService.test' }
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      })
      publicPaymentId = link.publicPaymentId

      assert.match(publicPaymentId, /^rstk_pay_[A-Za-z0-9]{20}$/)
      assert.equal(link.payment.provider, 'rebill')
      assert.equal(link.payment.publicKey, publicKey)
      assert.equal(link.paymentUrl, 'https://pay.rebill.com/acme/pl_rebill_service_test')
      assert.equal(link.payment.hostedPaymentUrl, 'https://pay.rebill.com/acme/pl_rebill_service_test')
      assert.equal(link.payment.rebillHostedPaymentLink.id, 'pl_rebill_service_test')
      assert.equal(link.payment.instantProduct.currency, 'MXN')
      assert.equal(link.payment.instantProduct.metadata.publicPaymentId, publicPaymentId)
      assert.equal(link.payment.instantProduct.metadata.rebillInstallmentsRequested, true)
      assert.equal(link.payment.instantProduct.metadata.rebillMaxInstallments, 12)
      assert.equal(Object.hasOwn(link.payment.instantProduct, 'installmentsSettings'), false)
      assert.deepEqual(link.payment.rebillInstallments, {
        enabled: true,
        selectionMode: 'rebill_checkout_configured',
        maxInstallments: 12,
        enabledInstallments: [1, 3, 6, 9, 12]
      })
      assert.deepEqual(link.payment.customerInformation.phoneNumber, {
        number: '5512345678',
        countryCode: 'MX'
      })
      assert.equal(link.payment.customerInformation.countryCode, 'MX')

      const beforeConfirm = await db.get('SELECT status, payment_method, rebill_payment_id, metadata_json FROM payments WHERE public_payment_id = ?', [publicPaymentId])
      assert.equal(beforeConfirm.status, 'sent')
      assert.equal(beforeConfirm.payment_method, 'rebill_payment_link')
      assert.equal(beforeConfirm.rebill_payment_id, null)
      const beforeMetadata = JSON.parse(beforeConfirm.metadata_json)
      assert.equal(beforeMetadata.rebillHostedPaymentLink.id, 'pl_rebill_service_test')
      assert.deepEqual(beforeMetadata.rebillHostedPaymentLink.paymentMethods, [{ methods: ['card'], currency: 'MXN' }])

      const publicPayment = await getPublicRebillPayment(publicPaymentId, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(publicPayment.hostedPaymentUrl, 'https://pay.rebill.com/acme/pl_rebill_service_test')

      const result = await confirmPublicRebillPayment(publicPaymentId, {
        rebillPaymentId: 'pay_rebill_service_test',
        installments: 3
      }, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(result.rebillPaymentId, 'pay_rebill_service_test')
      assert.equal(result.status, 'approved')
      assert.equal(result.payment.status, 'paid')
      assert.equal(result.payment.rebillPaymentId, 'pay_rebill_service_test')
      assert.equal(result.payment.rebillInstallments.selectedInstallments, 3)

      const row = await db.get(
        `SELECT status, amount, currency, payment_provider, payment_method, rebill_payment_id,
                rebill_subscription_id, rebill_customer_id, rebill_card_id, paid_at, metadata_json
           FROM payments
          WHERE public_payment_id = ?`,
        [publicPaymentId]
      )
      assert.equal(row.status, 'paid')
      assert.equal(row.amount, 499.5)
      assert.equal(row.currency, 'MXN')
      assert.equal(row.payment_provider, 'rebill')
      assert.equal(row.payment_method, 'rebill_checkout')
      assert.equal(row.rebill_payment_id, 'pay_rebill_service_test')
      assert.equal(row.rebill_subscription_id, 'sub_rebill_service_test')
      assert.equal(row.rebill_customer_id, 'cus_rebill_service_test')
      assert.equal(row.rebill_card_id, 'card_rebill_service_test')
      assert.equal(row.paid_at, '2026-07-03T18:30:00.000Z')
      const metadata = JSON.parse(row.metadata_json)
      assert.equal(metadata.rebillInstallments.enabled, true)
      assert.equal(metadata.rebillInstallments.selectedInstallments, 3)
      assert.equal(metadata.rebill.installments, 3)

      const paymentFetch = calls.find((call) => call.path === '/v3/payments/pay_rebill_service_test')
      assert.ok(paymentFetch)
      assert.equal(paymentFetch.apiKey, secretKey)
    } finally {
      await cleanupPublicPayment(publicPaymentId)
    }
  })
})

test('Payment Gate de Sites con Rebill devuelve checkout hospedado con MSI configurado', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    const publicKey = 'pk_test_sites_rebill'
    const secretKey = 'sk_test_sites_rebill'

    setRebillFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const method = options.method || 'GET'
      const body = options.body ? JSON.parse(String(options.body)) : null
      calls.push({ method, path: parsed.pathname, apiKey: options.headers?.['x-api-key'], body })

      if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
        return jsonTextResponse({ id: 'org_rebill_sites', name: 'Rebill Sites Org', status: 'active' })
      }
      if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
        return jsonTextResponse({ records: [] })
      }
      if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
        return jsonTextResponse({ id: 'wh_rebill_sites', url: body.url, events: body.events, active: true }, 201)
      }
      if (parsed.pathname === '/v3/payment-links' && method === 'POST') {
        assert.equal(body.metadata.source, 'site_checkout')
        assert.equal(body.metadata.rebillHostedCheckout, true)
        assert.equal(body.metadata.rebillInstallmentsRequested, true)
        assert.equal(body.metadata.rebillMaxInstallments, 6)
        assert.deepEqual(body.paymentMethods, [{ methods: ['card'], currency: 'MXN' }])
        assert.deepEqual(body.installmentsSettings, [
          { currency: 'MXN', enabledInstallments: [1, 3, 6] }
        ])
        assert.equal(body.showCoupon, false)
        assert.equal(body.isSingleUse, true)
        assert.equal(body.prices[0].amount, 3000)
        return jsonTextResponse({
          id: 'pl_sites_rebill',
          url: 'https://pay.rebill.com/sites/pl_sites_rebill',
          status: 'active'
        }, 201)
      }

      return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
    })

    await saveRebillPaymentConfig({
      enabled: true,
      mode: 'test',
      publicKey,
      secretKey
    }, {
      baseUrl: 'https://app.example.test'
    })

    let publicPaymentId = ''
    try {
      const link = await createPaymentGateLink({
        enabled: true,
        gateway: 'rebill',
        amount: 3000,
        currency: 'MXN',
        productName: 'Curso Sites',
        description: 'Curso Sites',
        buttonText: 'Pagar',
        mode: 'test',
        msi: { enabled: true, maxInstallments: 6 }
      }, {
        baseUrl: 'https://app.example.test',
        source: 'site_checkout',
        contact: {
          email: 'cliente@example.test',
          phone: '+526567426612'
        },
        metadata: {
          siteId: 'site_rebill_msi',
          paymentGate: {
            siteId: 'site_rebill_msi',
            paymentBlockId: 'block_pay_rebill'
          }
        }
      })
      publicPaymentId = link.publicPaymentId

      assert.match(publicPaymentId, /^rstk_pay_[A-Za-z0-9]{20}$/)
      assert.equal(link.paymentUrl, 'https://pay.rebill.com/sites/pl_sites_rebill')

      const status = await getPaymentGateStatus(publicPaymentId)
      assert.equal(status.paymentUrl, 'https://pay.rebill.com/sites/pl_sites_rebill')
      assert.equal(status.metadata.rebillHostedCheckout, true)
      assert.equal(status.metadata.paymentGate.gateway, 'rebill')
      assert.equal(status.metadata.paymentGate.msi.maxInstallments, 6)
      assert.equal(status.metadata.rebillInstallments.maxInstallments, 6)

      const paymentLinkCall = calls.find((call) => call.path === '/v3/payment-links')
      assert.ok(paymentLinkCall)
      assert.equal(paymentLinkCall.apiKey, secretKey)
    } finally {
      await cleanupPublicPayment(publicPaymentId)
    }
  })
})

test('Rebill cobra tarjeta guardada enviando customer como objeto en checkout', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    const publicKey = 'pk_test_saved_card_abcdef1234567890'
    const secretKey = 'sk_test_saved_card_abcdef1234567890'
    const suffix = uniqueSuffix('rebill_saved_card')
    const contactId = `contact_${suffix}`
    const customerId = `cus_${suffix}`
    const cardId = `card_${suffix}`

    setRebillFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const method = options.method || 'GET'
      const body = options.body ? JSON.parse(String(options.body)) : null
      calls.push({
        method,
        path: parsed.pathname,
        apiKey: options.headers?.['x-api-key'],
        idempotencyKey: options.headers?.['x-idempotency-key'],
        body
      })

      if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
        return jsonTextResponse({ id: 'org_rebill_saved_card', name: 'Rebill Saved Card Org', status: 'active' })
      }
      if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
        return jsonTextResponse({ records: [] })
      }
      if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
        return jsonTextResponse({ id: 'wh_rebill_saved_card', url: body.url, events: body.events, active: true }, 201)
      }
      if (parsed.pathname === '/v3/checkout' && method === 'POST') {
        assert.deepEqual(body.customer, {
          firstName: 'Cliente',
          lastName: 'Saved Rebill',
          email: `${contactId}@example.test`,
          phone: {
            number: '5563896389',
            countryCode: 'MX'
          }
        })
        assert.equal(body.cardId, cardId)
        assert.equal(body.transaction.amount, 100)
        assert.equal(body.transaction.currency, 'MXN')
        assert.equal(body.transaction.quantity, 1)
        return jsonTextResponse({
          traceId: 'trace_rebill_saved_card_direct',
          date: '2026-07-03T20:30:00.000Z',
          result: {
            paymentId: 'pay_rebill_saved_card_direct',
            status: 'approved',
            cardId,
            cardLastFour: '6389',
            customerId
          }
        }, 201)
      }

      return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
    })

    try {
      await cleanupContact(contactId)
      await saveRebillPaymentConfig({
        enabled: true,
        mode: 'test',
        publicKey,
        secretKey
      }, {
        baseUrl: 'https://app.example.test'
      })

      await db.run(
        `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contactId, 'Cliente 123 Saved Rebill', `${contactId}@example.test`, '+525563896389']
      )
      await db.run(
        `INSERT INTO rebill_payment_sources (
           id, contact_id, rebill_customer_id, rebill_card_id,
           brand, last4, name, mode, is_default, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'visa', '6389', 'Cliente Saved Rebill', 'test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [`rebill_source_${suffix}`, contactId, customerId, cardId]
      )

      const result = await createRebillSavedCardPayment({
        contactId,
        paymentSourceId: cardId,
        amount: 100,
        currency: 'MXN',
        title: 'Pago directo Rebill',
        description: 'Pago directo Rebill',
        contactName: 'Cliente 123 Saved Rebill',
        email: `${contactId}@example.test`,
        phone: '+525563896389'
      }, {
        mode: 'test'
      })

      assert.equal(result.payment.status, 'paid')
      assert.equal(result.payment.rebillPaymentId, 'pay_rebill_saved_card_direct')

      const row = await db.get(
        `SELECT status, payment_method, rebill_payment_id, rebill_customer_id, rebill_card_id, paid_at
           FROM payments
          WHERE contact_id = ? AND payment_method = 'rebill_saved_card'
          ORDER BY created_at DESC
          LIMIT 1`,
        [contactId]
      )
      assert.equal(row.status, 'paid')
      assert.equal(row.rebill_payment_id, 'pay_rebill_saved_card_direct')
      assert.equal(row.rebill_customer_id, customerId)
      assert.equal(row.rebill_card_id, cardId)
      assert.equal(row.paid_at, '2026-07-03T20:30:00.000Z')

      const checkoutCall = calls.find((call) => call.path === '/v3/checkout' && call.method === 'POST')
      assert.ok(checkoutCall)
      assert.match(checkoutCall.idempotencyKey, /^ristak:rebill:/)
      assert.equal(checkoutCall.apiKey, secretKey)
    } finally {
      await cleanupContact(contactId)
    }
  })
})

test('Rebill crea planes con reloj de Ristak, guarda tarjeta y cobra parcialidades con cardId', async () => {
  await initializeMasterKey()

  await snapshotRebillConfig(async () => {
    const calls = []
    const publicKey = 'pk_test_plan_abcdef1234567890'
    const secretKey = 'sk_test_plan_abcdef1234567890'
    const suffix = uniqueSuffix()
    const contactId = `contact_${suffix}`
    const contact = {
      id: contactId,
      name: 'Cliente Plan Rebill',
      email: `${contactId}@example.test`,
      phone: '+525512345678'
    }
    const today = addDaysDateOnly(0)
    const futureDate = addDaysDateOnly(8)
    let flowId = ''

    setRebillFetchForTest(async (url, options = {}) => {
      const parsed = new URL(url)
      const method = options.method || 'GET'
      const body = options.body ? JSON.parse(String(options.body)) : null
      calls.push({
        method,
        path: parsed.pathname,
        apiKey: options.headers?.['x-api-key'],
        idempotencyKey: options.headers?.['x-idempotency-key'],
        body
      })

      if (parsed.pathname === '/v3/organizations/me' && method === 'GET') {
        return jsonTextResponse({ id: 'org_rebill_plan', name: 'Rebill Plan Org', status: 'active' })
      }
      if (parsed.pathname === '/v3/webhooks/search' && method === 'POST') {
        return jsonTextResponse({ records: [] })
      }
      if (parsed.pathname === '/v3/webhooks' && method === 'POST') {
        return jsonTextResponse({ id: 'wh_rebill_plan', url: body.url, events: body.events, active: true }, 201)
      }
      if (parsed.pathname === '/v3/payments/pay_rebill_plan_first_test' && method === 'GET') {
        const row = await db.get(
          'SELECT public_payment_id FROM payments WHERE id = (SELECT first_payment_invoice_id FROM payment_flows WHERE id = ?)',
          [flowId]
        )
        return jsonTextResponse({
          id: 'pay_rebill_plan_first_test',
          status: 'approved',
          amount: 500,
          currency: 'MXN',
          approvedAt: '2026-07-03T18:30:00.000Z',
          customer: { id: 'cus_rebill_plan_saved' },
          card: {
            id: 'card_rebill_plan_saved',
            brand: 'visa',
            lastFourDigits: '4242'
          },
          metadata: {
            publicPaymentId: row?.public_payment_id
          }
        })
      }
      if (parsed.pathname === '/v3/checkout' && method === 'POST') {
        assert.deepEqual(body.customer, {
          firstName: 'Cliente',
          lastName: 'Plan Rebill',
          email: contact.email,
          phone: {
            number: '5512345678',
            countryCode: 'MX'
          }
        })
        assert.equal(body.cardId, 'card_rebill_plan_saved')
        assert.equal(body.transaction.amount, 800)
        assert.equal(body.transaction.currency, 'MXN')
        assert.equal(body.transaction.quantity, 1)
        return jsonTextResponse({
          traceId: 'trace_rebill_plan_installment',
          date: '2026-07-03T19:30:00.000Z',
          result: {
            paymentId: 'pay_rebill_plan_installment_test',
            status: 'approved',
            cardId: 'card_rebill_plan_saved',
            cardLastFour: '4242',
            customerId: 'cus_rebill_plan_saved'
          }
        }, 201)
      }
      if (parsed.pathname === '/v3/payments/pay_rebill_plan_installment_test' && method === 'GET') {
        const row = await db.get(
          `SELECT p.public_payment_id
             FROM installment_payments i
             JOIN payments p ON p.id = i.payment_id
            WHERE i.flow_id = ?
            ORDER BY i.sequence ASC
            LIMIT 1`,
          [flowId]
        )
        return jsonTextResponse({
          id: 'pay_rebill_plan_installment_test',
          status: 'approved',
          amount: 800,
          currency: 'MXN',
          approvedAt: '2026-07-03T18:30:00.000Z',
          metadata: {
            publicPaymentId: row?.public_payment_id
          }
        })
      }

      return jsonTextResponse({ message: `Ruta Rebill no esperada: ${method} ${parsed.pathname}` }, 404)
    })

    try {
      await cleanupContact(contactId)
      await setAppConfig('payments_settings', { paymentMode: 'test' })
      await saveRebillPaymentConfig({
        enabled: true,
        mode: 'test',
        publicKey,
        secretKey
      }, {
        baseUrl: 'https://app.example.test'
      })

      await db.run(
        `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [contact.id, contact.name, contact.email, contact.phone]
      )

      const plan = await createRebillPaymentPlan({
        contact,
        title: 'Plan Rebill con reloj propio',
        description: 'Plan Rebill con reloj propio',
        totalAmount: 1300,
        currency: 'MXN',
        firstPayment: {
          enabled: true,
          amount: 500,
          date: today,
          method: 'card',
          frequency: 'custom'
        },
        remainingFrequency: 'custom',
        remainingPayments: [
          { sequence: 1, amount: 800, dueDate: futureDate, frequency: 'custom' }
        ]
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      })
      flowId = plan.flowId

      assert.match(plan.firstPaymentLink, /^https:\/\/app\.example\.test\/pay\/rstk_pay_[A-Za-z0-9]{20}$/)
      assert.equal(plan.scheduledPayments.length, 1)
      assert.equal(plan.scheduledPayments[0].status, 'waiting_card_authorization')

      const firstPayment = await db.get('SELECT status, payment_url FROM payments WHERE id = ?', [plan.firstPaymentPaymentId])
      assert.equal(firstPayment.status, 'sent')
      assert.match(firstPayment.payment_url, /^https:\/\/app\.example\.test\/pay\//)

      const installment = await db.get(
        `SELECT i.status, i.payment_id, p.status AS payment_status, p.payment_url
           FROM installment_payments i
           JOIN payments p ON p.id = i.payment_id
          WHERE i.flow_id = ?`,
        [plan.flowId]
      )
      assert.equal(installment.status, 'waiting_card_authorization')
      assert.equal(installment.payment_status, 'pending')
      assert.equal(installment.payment_url, '')

      const mirror = await db.get('SELECT source, status, schedule_json FROM payment_plans WHERE id = ?', [plan.flowId])
      const schedule = JSON.parse(mirror.schedule_json)
      assert.equal(mirror.source, 'rebill')
      assert.equal(mirror.status, 'active')
      assert.equal(schedule.clockOwner, 'ristak')
      assert.equal(schedule.checkoutProvider, 'rebill')
      assert.equal(schedule.savedPaymentSource, null)

      const firstPaymentRow = await db.get('SELECT public_payment_id FROM payments WHERE id = ?', [plan.firstPaymentPaymentId])
      const firstConfirmation = await confirmPublicRebillPayment(firstPaymentRow.public_payment_id, {
        rebillPaymentId: 'pay_rebill_plan_first_test'
      }, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(firstConfirmation.payment.status, 'paid')

      const savedSource = await db.get('SELECT * FROM rebill_payment_sources WHERE contact_id = ?', [contactId])
      assert.equal(savedSource.rebill_customer_id, 'cus_rebill_plan_saved')
      assert.equal(savedSource.rebill_card_id, 'card_rebill_plan_saved')
      assert.equal(savedSource.last4, '4242')

      const authorizedFlow = await db.get(
        'SELECT current_state, rebill_customer_id, rebill_card_id, rebill_card_label FROM payment_flows WHERE id = ?',
        [plan.flowId]
      )
      assert.equal(authorizedFlow.current_state, 'installment_plan_active')
      assert.equal(authorizedFlow.rebill_customer_id, 'cus_rebill_plan_saved')
      assert.equal(authorizedFlow.rebill_card_id, 'card_rebill_plan_saved')
      assert.equal(authorizedFlow.rebill_card_label, 'VISA •••• 4242')

      await db.run('UPDATE installment_payments SET due_date = ? WHERE flow_id = ?', [today, plan.flowId])
      await db.run('UPDATE payments SET due_date = ? WHERE id = ?', [today, installment.payment_id])

      const charged = await processDueRebillPaymentPlanCharges({
        limit: 5,
        baseUrl: 'https://app.example.test'
      })
      assert.equal(charged.filter((item) => item.charged).length, 1)
      assert.equal(charged[0].type, 'installment')
      assert.equal(charged[0].status, 'paid')

      const releasedInstallment = await db.get(
        `SELECT i.status, i.rebill_payment_id, p.status AS payment_status, p.payment_url, p.public_payment_id, p.rebill_payment_id AS payment_rebill_payment_id
           FROM installment_payments i
           JOIN payments p ON p.id = i.payment_id
          WHERE i.flow_id = ?`,
        [plan.flowId]
      )
      assert.equal(releasedInstallment.status, 'paid')
      assert.equal(releasedInstallment.payment_status, 'paid')
      assert.equal(releasedInstallment.rebill_payment_id, 'pay_rebill_plan_installment_test')
      assert.equal(releasedInstallment.payment_rebill_payment_id, 'pay_rebill_plan_installment_test')
      assert.equal(releasedInstallment.payment_url, '')

      const checkoutCall = calls.find((call) => call.path === '/v3/checkout' && call.method === 'POST')
      assert.ok(checkoutCall)
      assert.match(checkoutCall.idempotencyKey, /^ristak:rebill:/)

      const refreshedMirror = await db.get('SELECT schedule_json FROM payment_plans WHERE id = ?', [plan.flowId])
      const refreshedSchedule = JSON.parse(refreshedMirror.schedule_json)
      assert.equal(refreshedSchedule.savedPaymentSource.cardId, 'card_rebill_plan_saved')
      assert.equal(refreshedSchedule.installments[0].status, 'paid')
      assert.equal(refreshedSchedule.installments[0].rebillPaymentId, 'pay_rebill_plan_installment_test')
    } finally {
      await cleanupContact(contactId)
    }
  })
})
