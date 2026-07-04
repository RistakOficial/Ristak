import test from 'node:test'
import assert from 'node:assert/strict'

import { db, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  confirmPublicRebillPayment,
  createRebillPaymentLink,
  createRebillPaymentPlan,
  getRebillPaymentConfig,
  mapRebillStatus,
  processDueRebillPaymentPlanCharges,
  saveRebillPaymentConfig,
  setRebillFetchForTest,
  testRebillPaymentConfig
} from '../src/services/rebillPaymentService.js'

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

    let publicPaymentId = ''
    try {
      const link = await createRebillPaymentLink({
        amount: 499.5,
        currency: 'MXN',
        title: 'Pago Rebill test',
        description: 'Pago Rebill test',
        email: 'cliente@example.test',
        phone: '+525512345678',
        metadata: { testSource: 'rebillPaymentService.test' }
      }, {
        baseUrl: 'https://app.example.test',
        mode: 'test'
      })
      publicPaymentId = link.publicPaymentId

      assert.match(publicPaymentId, /^rstk_pay_[A-Za-z0-9]{20}$/)
      assert.equal(link.payment.provider, 'rebill')
      assert.equal(link.payment.publicKey, publicKey)
      assert.equal(link.payment.instantProduct.currency, 'MXN')
      assert.equal(link.payment.instantProduct.metadata.publicPaymentId, publicPaymentId)
      assert.deepEqual(link.payment.customerInformation.phoneNumber, {
        number: '5512345678',
        countryCode: 'MX'
      })

      const beforeConfirm = await db.get('SELECT status, rebill_payment_id FROM payments WHERE public_payment_id = ?', [publicPaymentId])
      assert.equal(beforeConfirm.status, 'sent')
      assert.equal(beforeConfirm.rebill_payment_id, null)

      const result = await confirmPublicRebillPayment(publicPaymentId, {
        rebillPaymentId: 'pay_rebill_service_test'
      }, {
        baseUrl: 'https://app.example.test'
      })

      assert.equal(result.rebillPaymentId, 'pay_rebill_service_test')
      assert.equal(result.status, 'approved')
      assert.equal(result.payment.status, 'paid')
      assert.equal(result.payment.rebillPaymentId, 'pay_rebill_service_test')

      const row = await db.get(
        `SELECT status, amount, currency, payment_provider, payment_method, rebill_payment_id,
                rebill_subscription_id, rebill_customer_id, rebill_card_id, paid_at
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

      const paymentFetch = calls.find((call) => call.path === '/v3/payments/pay_rebill_service_test')
      assert.ok(paymentFetch)
      assert.equal(paymentFetch.apiKey, secretKey)
    } finally {
      await cleanupPublicPayment(publicPaymentId)
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
