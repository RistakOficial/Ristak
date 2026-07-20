import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { db } from '../src/config/database.js'
import {
  clearHighLevelMirrorDataForLocationChange,
  recordPayment as recordHighLevelInvoicePayment
} from '../src/controllers/highlevelController.js'
import {
  __transactionsControllerTestHooks,
  recordPayment as recordTransactionPayment
} from '../src/controllers/transactionsController.js'
import GHLClient from '../src/services/ghlClient.js'
import { handlePaymentWebhook } from '../src/controllers/webhooksController.js'
import {
  __invoicesSyncTestHooks,
  syncAllInvoices,
  syncLocalPaymentsToHighLevel,
  syncSingleInvoice
} from '../src/services/invoicesSyncService.js'
import { createInstallmentPaymentFlow } from '../src/services/paymentFlowService.js'

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

function idsFor(name) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    contactId: `pit_contact_${name}_${suffix}`,
    ghlContactId: `pit_ghl_contact_${name}_${suffix}`,
    manualPaymentId: `manual_payment_pit_${name}_${suffix}`,
    stripePaymentId: `stripe_payment_pit_${name}_${suffix}`,
    highLevelInvoiceId: `pit_ghl_invoice_${name}_${suffix}`,
    highLevelInvoiceId2: `pit_ghl_invoice2_${name}_${suffix}`,
    webhookPaymentId: `pit_ghl_payment_${name}_${suffix}`,
    productId: `pit_product_${name}_${suffix}`,
    priceId: `pit_price_${name}_${suffix}`
  }
}

function phoneFor(value) {
  let hash = 0n
  for (const character of String(value)) {
    hash = ((hash * 131n) + BigInt(character.codePointAt(0) || 0)) % 10_000_000_000n
  }
  return `+52${hash.toString().padStart(10, '0')}`
}

test('registro manual de invoice HighLevel persiste paymentDate como fecha local del pago', () => {
  const source = readFileSync(new URL('../src/controllers/highlevelController.js', import.meta.url), 'utf8')
  const start = source.indexOf('export const recordPayment = async')
  const end = source.indexOf('export const createInstallmentFlow = async')
  const recordPaymentSource = source.slice(start, end)

  assert.match(recordPaymentSource, /const accountTimezone = await getAccountTimezone\(\)\.catch\(\(\) => DEFAULT_PAYMENT_TIMEZONE\)/)
  assert.match(recordPaymentSource, /const resolvedPaymentDate = resolvePaymentTimestamp\(paymentDate, accountTimezone\)/)
  assert.match(recordPaymentSource, /fulfilledAt: resolvedPaymentDate/)
  assert.match(recordPaymentSource, /SET status = 'paid'.+date = \?/s)
})

async function cleanup(ids) {
  await db.run(
    `DELETE FROM installment_payments
     WHERE flow_id IN (SELECT id FROM payment_flows WHERE contact_id = ?)`,
    [ids.contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM payment_plans WHERE contact_id = ?', [ids.contactId]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE contact_id = ?', [ids.contactId]).catch(() => undefined)
  await db.run(
    `DELETE FROM payments
     WHERE id IN (?, ?, ?, ?, ?)
        OR contact_id = ?
        OR ghl_invoice_id IN (?, ?)`,
    [
      ids.manualPaymentId,
      ids.stripePaymentId,
      ids.highLevelInvoiceId,
      ids.highLevelInvoiceId2,
      ids.webhookPaymentId,
      ids.contactId,
      ids.highLevelInvoiceId,
      ids.highLevelInvoiceId2
    ]
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM contacts WHERE id IN (?, ?) OR ghl_contact_id = ?',
    [ids.contactId, ids.ghlContactId, ids.ghlContactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM product_prices WHERE product_id = ?', [ids.productId]).catch(() => undefined)
  await db.run('DELETE FROM products WHERE id = ?', [ids.productId]).catch(() => undefined)
}

async function replaceHighLevelConfigForTest(config, callback) {
  const columns = await db.all('PRAGMA table_info(highlevel_config)').then(rows => rows.map(row => row.name))
  const existingRows = await db.all('SELECT * FROM highlevel_config').catch(() => [])
  await db.run('DELETE FROM highlevel_config')

  try {
    await db.run(
      `INSERT INTO highlevel_config (
        location_id, api_token, location_data, ghl_invoice_mode, card_setup_amount, invoice_title, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        config.locationId,
        config.apiToken || 'test-ghl-token',
        JSON.stringify(config.locationData || {
          name: 'Ristak Test',
          domain: 'pay.example.test',
          timezone: 'America/Mexico_City',
          business: {
            name: 'Ristak Test',
            email: 'billing@example.test'
          }
        }),
        config.invoiceMode || 'test',
        config.cardSetupAmount || 25,
        config.invoiceTitle || 'PAGO'
      ]
    )

    return await callback()
  } finally {
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of existingRows) {
      const availableColumns = columns.filter(column => Object.prototype.hasOwnProperty.call(row, column))
      if (!availableColumns.length) continue
      const placeholders = availableColumns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO highlevel_config (${availableColumns.join(', ')}) VALUES (${placeholders})`,
        availableColumns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

async function seedContact(ids) {
  await db.run(
    `INSERT INTO contacts (id, ghl_contact_id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       ghl_contact_id = excluded.ghl_contact_id,
       full_name = excluded.full_name,
       email = excluded.email,
       phone = excluded.phone,
       updated_at = CURRENT_TIMESTAMP`,
    [
      ids.contactId,
      ids.ghlContactId,
      'Cliente Payment Hardening',
      `${ids.contactId}@example.test`,
      phoneFor(ids.contactId)
    ]
  )
}

async function seedLegacyHighLevelContactAlias(ids) {
  await db.run(
    `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
     VALUES (?, 'Alias legacy HighLevel', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
    [ids.ghlContactId]
  )
}

async function seedProductWebhookInvoice(ids, { status = 'draft' } = {}) {
  const webhookUrl = `https://example.test/product-payment/${ids.productId}`
  await db.run(
    `INSERT INTO products (
      id, ghl_product_id, name, description, product_type, currency, post_webhooks,
      source, sync_status, sync_origin, created_at, updated_at
    ) VALUES (?, ?, ?, 'Producto con webhook', 'SERVICE', 'MXN', ?, 'ristak', 'synced', 'ristak', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.productId,
      `ghl_${ids.productId}`,
      `Producto ${ids.productId}`,
      JSON.stringify([{ id: 'payment_hook', url: webhookUrl }])
    ]
  )
  await db.run(
    `INSERT INTO product_prices (
      id, product_id, ghl_price_id, ghl_product_id, name, type, currency, amount,
      source, sync_status, sync_origin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Precio base', 'one_time', 'MXN', 100, 'ristak', 'synced', 'ristak', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.priceId, ids.productId, `ghl_${ids.priceId}`, `ghl_${ids.productId}`]
  )
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id,
      invoice_number, metadata_json, created_at, updated_at
    ) VALUES (?, ?, 100, 'MXN', ?, NULL, 'test', 'highlevel', NULL, 'Pago', 'Precio base',
      CURRENT_TIMESTAMP, ?, 'PIT-WEBHOOK', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.highLevelInvoiceId,
      ids.contactId,
      status,
      ids.highLevelInvoiceId,
      JSON.stringify({
        lineItems: [
          {
            name: `Producto ${ids.productId}`,
            localProductId: ids.productId,
            productId: `ghl_${ids.productId}`,
            priceId: `ghl_${ids.priceId}`,
            amount: 100,
            currency: 'MXN'
          }
        ]
      })
    ]
  )
  return webhookUrl
}

async function waitForProductWebhookDelivery(paymentId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await db.get('SELECT metadata_json FROM payments WHERE id = ?', [paymentId])
    const metadata = JSON.parse(row?.metadata_json || '{}')
    const deliveries = Object.values(metadata.productPostWebhookDeliveries || {})
    if (deliveries.length > 0) return deliveries
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`El webhook del pago ${paymentId} no se despachó a tiempo`)
}

async function seedManualPayment(ids, overrides = {}) {
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'MXN', ?, 'cash', ?, 'manual', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.manualPaymentId,
      ids.contactId,
      overrides.amount ?? 500,
      overrides.status || 'paid',
      overrides.paymentMode || 'live',
      overrides.reference || 'Anticipo ortodoncia',
      overrides.title || 'Anticipo ortodoncia',
      overrides.description || 'Anticipo ortodoncia',
      overrides.ghlInvoiceId || null,
      overrides.invoiceNumber || null
    ]
  )
}

test('record-payment conserva modo test en pagos locales aunque HighLevel esté live', async () => {
  const ids = idsFor('recordmode')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids, {
    status: 'pending',
    paymentMode: 'test',
    title: 'Pago local test',
    description: 'Pago local test'
  })
  await db.run(
    `INSERT INTO highlevel_config (location_id, api_token, ghl_invoice_mode, created_at)
     VALUES (?, '', 'live', CURRENT_TIMESTAMP)
     ON CONFLICT(location_id) DO UPDATE SET ghl_invoice_mode = 'live'`,
    [`pit_location_${ids.contactId}`]
  )

  try {
    const res = createResponse()
    await recordTransactionPayment({
      params: { id: ids.manualPaymentId },
      body: {
        amount: 500,
        paymentMethod: 'cash',
        paymentDate: '2026-06-27T12:00:00.000Z'
      },
      headers: {},
      protocol: 'https',
      get: () => ''
    }, res)

    assert.equal(res.statusCode, 200)
    const payment = await db.get('SELECT status, payment_mode FROM payments WHERE id = ?', [ids.manualPaymentId])
    assert.equal(payment.status, 'paid')
    assert.equal(payment.payment_mode, 'test')
  } finally {
    await db.run('DELETE FROM highlevel_config WHERE location_id = ?', [`pit_location_${ids.contactId}`]).catch(() => undefined)
    await cleanup(ids)
  }
})

test('registro manual de invoice HighLevel dispara el webhook local del producto', async () => {
  const ids = idsFor('highlevel_manual_product_webhook')
  await cleanup(ids)
  await seedContact(ids)
  const webhookUrl = await seedProductWebhookInvoice(ids)
  const originalFetch = globalThis.fetch
  const calls = []

  mock.method(GHLClient.prototype, 'recordPayment', async function recordPayment() {
    return { success: true }
  })
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return { ok: true, status: 202, text: async () => 'accepted' }
  }

  try {
    await replaceHighLevelConfigForTest({
      locationId: `pit_location_${ids.contactId}`,
      invoiceMode: 'test'
    }, async () => {
      const res = createResponse()
      await recordHighLevelInvoicePayment({
        params: { invoiceId: ids.highLevelInvoiceId },
        body: {
          amount: 100,
          currency: 'MXN',
          paymentDate: '2026-07-20T21:11:36.238Z',
          paymentMethod: 'cash'
        }
      }, res)
      assert.equal(res.statusCode, 200)
    })

    const deliveries = await waitForProductWebhookDelivery(ids.highLevelInvoiceId)
    const webhookCalls = calls.filter(call => call.url === webhookUrl)
    assert.equal(webhookCalls.length, 1)
    const payload = JSON.parse(webhookCalls[0].options.body)
    assert.equal(payload.status, 'paid')
    assert.equal(payload.previousStatus, 'draft')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].ok, true)
    assert.equal(deliveries[0].event, 'payment.paid')
  } finally {
    globalThis.fetch = originalFetch
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('sincronización de invoice HighLevel dispara el webhook al detectar cambio de estado', async () => {
  const ids = idsFor('highlevel_sync_product_webhook')
  await cleanup(ids)
  await seedContact(ids)
  const webhookUrl = await seedProductWebhookInvoice(ids, { status: 'pending' })
  const originalFetch = globalThis.fetch
  const calls = []

  mock.method(GHLClient.prototype, 'getInvoice', async function getInvoice() {
    return {
      invoice: {
        id: ids.highLevelInvoiceId,
        contactId: ids.ghlContactId,
        invoiceNumber: 'PIT-WEBHOOK',
        title: 'Pago',
        description: 'Precio base',
        total: 100,
        currency: 'MXN',
        status: 'paid',
        paymentMode: 'cash',
        liveMode: false
      }
    }
  })
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return { ok: true, status: 202, text: async () => 'accepted' }
  }

  try {
    await replaceHighLevelConfigForTest({
      locationId: `pit_location_${ids.contactId}`,
      invoiceMode: 'test'
    }, async () => {
      const result = await syncSingleInvoice(ids.highLevelInvoiceId)
      assert.equal(result.status, 'paid')
    })

    const deliveries = await waitForProductWebhookDelivery(ids.highLevelInvoiceId)
    const webhookCalls = calls.filter(call => call.url === webhookUrl)
    assert.equal(webhookCalls.length, 1)
    const payload = JSON.parse(webhookCalls[0].options.body)
    assert.equal(payload.status, 'paid')
    assert.equal(payload.previousStatus, 'pending')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].status, 'paid')
  } finally {
    globalThis.fetch = originalFetch
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('enganche manual de plan HighLevel conserva modo test aunque el invoice remoto regrese live', async () => {
  const ids = idsFor('plan_enganche_test')
  await cleanup(ids)
  await seedContact(ids)

  const createdInvoices = []
  const recordedPayments = []

  mock.method(GHLClient.prototype, 'createInvoice', async function createInvoice(payload) {
    const invoiceId = `pit_plan_invoice_${ids.contactId}`
    createdInvoices.push(payload)
    return {
      invoice: {
        id: invoiceId,
        contactId: payload.contactDetails?.id,
        invoiceNumber: `PIT-${ids.contactId}`,
        title: payload.title || payload.name || 'PAGO',
        name: payload.name || payload.title || 'PAGO',
        currency: payload.currency || 'MXN',
        items: payload.items || [],
        issueDate: payload.issueDate,
        dueDate: payload.dueDate,
        liveMode: true
      }
    }
  })
  mock.method(GHLClient.prototype, 'recordPayment', async function recordPayment(invoiceId, payload) {
    recordedPayments.push({ invoiceId, payload })
    return { success: true }
  })

  try {
    await replaceHighLevelConfigForTest({
      locationId: `pit_location_${ids.contactId}`,
      invoiceMode: 'test'
    }, async () => {
      const result = await createInstallmentPaymentFlow({
        contact: {
          id: ids.contactId,
          name: 'Cliente Enganche Test',
          email: `${ids.contactId}@example.test`,
          phone: '+5215550001111'
        },
        totalAmount: 1000,
        description: 'Plan test con enganche',
        firstPayment: {
          enabled: true,
          amount: 200,
          method: 'cash',
          date: '2099-01-10',
          reference: 'ENG-TEST'
        },
        remainingPayments: [
          {
            sequence: 1,
            amount: 800,
            dueDate: '2099-02-10',
            frequency: 'monthly'
          }
        ],
        remainingAutomatic: false,
        invoicePayload: {
          title: 'PAGO',
          liveMode: true
        },
        source: 'test_payment_integrations_hardening'
      })

      assert.equal(result.paymentMode, 'test')
      assert.equal(result.currentState, 'installment_plan_active')
      assert.equal(createdInvoices[0]?.liveMode, false)
      assert.equal(recordedPayments[0]?.payload?.liveMode, false)

      const payment = await db.get(
        'SELECT status, payment_method, payment_mode, reference FROM payments WHERE ghl_invoice_id = ?',
        [result.firstPaymentInvoiceId]
      )
      assert.equal(payment.status, 'paid')
      assert.equal(payment.payment_method, 'cash')
      assert.equal(payment.payment_mode, 'test')
      assert.equal(payment.reference, 'ENG-TEST')
    })
  } finally {
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('listado de transacciones ordena pagos del mismo día por hora real aunque mezclen formatos de timestamp', async () => {
  const ids = idsFor('sortmix')
  const marker = `sortmix_${ids.manualPaymentId}`
  const paymentIds = {
    earlyIso: `${ids.manualPaymentId}_early_iso`,
    lateSql: `${ids.manualPaymentId}_late_sql`,
    middleIso: `${ids.manualPaymentId}_middle_iso`
  }

  await cleanup(ids)
  await seedContact(ids)

  try {
    const rows = [
      [paymentIds.earlyIso, '2099-04-04T17:30:00.000Z', '2099-04-04 17:30:01', `${marker} temprano ISO`],
      [paymentIds.lateSql, '2099-04-04 19:00:00', '2099-04-04 19:00:01', `${marker} tarde SQL`],
      [paymentIds.middleIso, '2099-04-04T18:00:00.000Z', '2099-04-04 18:00:01', `${marker} medio ISO`]
    ]

    for (const [paymentId, paymentDate, createdAt, title] of rows) {
      await db.run(
        `INSERT INTO payments (
          id, contact_id, amount, currency, status, payment_method, payment_mode,
          payment_provider, reference, title, description, date, created_at, updated_at
        ) VALUES (?, ?, 100, 'MXN', 'paid', 'cash', 'live', 'manual', ?, ?, ?, ?, ?, ?)`,
        [paymentId, ids.contactId, marker, title, title, paymentDate, createdAt, createdAt]
      )
    }

    const dateSortExpression = __transactionsControllerTestHooks.paymentTimestampSortExpression('p.date')
    const createdAtSortExpression = __transactionsControllerTestHooks.paymentTimestampSortExpression('p.created_at')
    const sortedPayments = await db.all(
      `SELECT p.id
       FROM payments p
       WHERE p.reference = ?
       ORDER BY ${dateSortExpression} DESC, ${createdAtSortExpression} DESC, p.id DESC`,
      [marker]
    )

    assert.deepEqual(
      sortedPayments.map(payment => payment.id),
      [paymentIds.lateSql, paymentIds.middleIso, paymentIds.earlyIso]
    )
  } finally {
    await cleanup(ids)
  }
})

async function seedHighLevelMirror(ids, overrides = {}) {
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'MXN', ?, 'card', 'live', 'highlevel', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      overrides.id || ids.highLevelInvoiceId,
      overrides.contactId || ids.contactId,
      overrides.amount ?? 500,
      overrides.status || 'paid',
      overrides.reference || 'Anticipo ortodoncia',
      overrides.title || 'Anticipo ortodoncia',
      overrides.description || 'Anticipo ortodoncia',
      overrides.ghlInvoiceId || overrides.id || ids.highLevelInvoiceId,
      overrides.invoiceNumber || 'INV-9988'
    ]
  )
}

test('sincronizar invoice HighLevel enlaza un pago manual local equivalente en vez de crear duplicado', async () => {
  const ids = idsFor('match')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids)

  try {
    const existing = await __invoicesSyncTestHooks.findExistingPaymentForInvoice({
      invoiceId: ids.highLevelInvoiceId,
      contactId: ids.contactId,
      invoiceNumber: 'INV-9988',
      amount: 500,
      reference: 'INV-9988',
      title: 'Anticipo ortodoncia',
      description: 'Anticipo ortodoncia'
    })

    assert.equal(existing?.id, ids.manualPaymentId)
  } finally {
    await cleanup(ids)
  }
})

test('exportar manual a HighLevel liga un espejo existente y elimina la fila duplicada local', async () => {
  const ids = idsFor('link')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids)
  await seedHighLevelMirror(ids)

  try {
    const manual = await db.get('SELECT * FROM payments WHERE id = ?', [ids.manualPaymentId])
    const mirror = await __invoicesSyncTestHooks.findHighLevelMirrorForLocalPayment(manual)
    assert.equal(mirror?.id, ids.highLevelInvoiceId)

    await __invoicesSyncTestHooks.linkLocalPaymentToHighLevelMirror({ payment: manual, mirror })

    const linkedManual = await db.get('SELECT payment_provider, ghl_invoice_id, invoice_number FROM payments WHERE id = ?', [ids.manualPaymentId])
    const deletedMirror = await db.get('SELECT id FROM payments WHERE id = ?', [ids.highLevelInvoiceId])

    assert.equal(linkedManual.payment_provider, 'manual')
    assert.equal(linkedManual.ghl_invoice_id, ids.highLevelInvoiceId)
    assert.equal(linkedManual.invoice_number, 'INV-9988')
    assert.equal(deletedMirror, null)
  } finally {
    await cleanup(ids)
  }
})

test('exportar manual a HighLevel liga espejo con contact_id legacy de GHL sin crear ni registrar otro pago', async () => {
  const ids = idsFor('legacy_ghl_contact_link')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids)
  await seedLegacyHighLevelContactAlias(ids)
  await seedHighLevelMirror(ids, { contactId: ids.ghlContactId })

  let createInvoiceCalls = 0
  let recordPaymentCalls = 0

  mock.method(GHLClient.prototype, 'createInvoice', async function createInvoice() {
    createInvoiceCalls += 1
    throw new Error('No debe crear invoice duplicada')
  })
  mock.method(GHLClient.prototype, 'recordPayment', async function recordPayment() {
    recordPaymentCalls += 1
    throw new Error('No debe registrar pago duplicado')
  })

  try {
    await replaceHighLevelConfigForTest({
      locationId: `pit_location_${ids.contactId}`,
      invoiceMode: 'live'
    }, async () => {
      const result = await syncLocalPaymentsToHighLevel({ paymentId: ids.manualPaymentId, limit: 1 })

      assert.equal(result.exported, 0)
      assert.equal(result.linkedDuplicates, 1)
      assert.equal(result.failed, 0)
      assert.equal(createInvoiceCalls, 0)
      assert.equal(recordPaymentCalls, 0)
    })

    const linkedManual = await db.get(
      'SELECT contact_id, payment_provider, ghl_invoice_id, invoice_number FROM payments WHERE id = ?',
      [ids.manualPaymentId]
    )
    const deletedMirror = await db.get('SELECT id FROM payments WHERE id = ?', [ids.highLevelInvoiceId])

    assert.equal(linkedManual.contact_id, ids.contactId)
    assert.equal(linkedManual.payment_provider, 'manual')
    assert.equal(linkedManual.ghl_invoice_id, ids.highLevelInvoiceId)
    assert.equal(linkedManual.invoice_number, 'INV-9988')
    assert.equal(deletedMirror, null)
  } finally {
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('sync de HighLevel no exporta pagos locales pendientes por defecto', async () => {
  const ids = idsFor('sync_import_only')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids)

  let createInvoiceCalls = 0
  let recordPaymentCalls = 0

  mock.method(GHLClient.prototype, 'listInvoices', async function listInvoices() {
    return { invoices: [] }
  })
  mock.method(GHLClient.prototype, 'createInvoice', async function createInvoice() {
    createInvoiceCalls += 1
    throw new Error('La sync de importación no debe crear invoices')
  })
  mock.method(GHLClient.prototype, 'recordPayment', async function recordPayment() {
    recordPaymentCalls += 1
    throw new Error('La sync de importación no debe registrar pagos')
  })

  try {
    await replaceHighLevelConfigForTest({
      locationId: `pit_location_${ids.contactId}`,
      invoiceMode: 'live'
    }, async () => {
      const result = await syncAllInvoices()

      assert.equal(result.totalFetched, 0)
      assert.equal(result.localExport, null)
      assert.equal(createInvoiceCalls, 0)
      assert.equal(recordPaymentCalls, 0)
    })

    const localPayment = await db.get(
      'SELECT ghl_invoice_id FROM payments WHERE id = ?',
      [ids.manualPaymentId]
    )
    assert.equal(localPayment.ghl_invoice_id, null)
  } finally {
    mock.restoreAll()
    await cleanup(ids)
  }
})

test('cambio de location HighLevel borra solo espejos y conserva pagos locales o Stripe desligados', async () => {
  const ids = idsFor('clear')
  await cleanup(ids)
  await seedContact(ids)
  await seedManualPayment(ids, { ghlInvoiceId: ids.highLevelInvoiceId, invoiceNumber: 'INV-1000' })
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
      public_payment_id, payment_url, created_at, updated_at
    ) VALUES (?, ?, 700, 'MXN', 'paid', 'stripe', 'live', 'stripe', 'stripe-ref', 'Pago Stripe', 'Pago Stripe',
      CURRENT_TIMESTAMP, ?, 'INV-2000', 'pub-clear', 'https://pay.example.test/clear', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.stripePaymentId, ids.contactId, ids.highLevelInvoiceId2]
  )
  await seedHighLevelMirror(ids)

  try {
    const result = await clearHighLevelMirrorDataForLocationChange()
    const manual = await db.get('SELECT id, ghl_invoice_id, invoice_number FROM payments WHERE id = ?', [ids.manualPaymentId])
    const stripe = await db.get('SELECT id, payment_provider, ghl_invoice_id, invoice_number FROM payments WHERE id = ?', [ids.stripePaymentId])
    const mirror = await db.get('SELECT id FROM payments WHERE id = ?', [ids.highLevelInvoiceId])

    assert.equal(result.deletedPaymentMirrors, 1)
    assert.equal(result.detachedLocalPayments, 2)
    assert.equal(manual.id, ids.manualPaymentId)
    assert.equal(manual.ghl_invoice_id, null)
    assert.equal(manual.invoice_number, null)
    assert.equal(stripe.id, ids.stripePaymentId)
    assert.equal(stripe.payment_provider, 'stripe')
    assert.equal(stripe.ghl_invoice_id, null)
    assert.equal(stripe.invoice_number, null)
    assert.equal(mirror, null)
  } finally {
    await cleanup(ids)
  }
})

test('webhook de pago HighLevel persiste payment_provider highlevel', async () => {
  const ids = idsFor('webhook')
  await cleanup(ids)
  await seedContact(ids)

  try {
    const res = createResponse()
    await handlePaymentWebhook({
      body: {
        payment: {
          id: ids.webhookPaymentId,
          contactId: ids.ghlContactId,
          invoiceId: ids.highLevelInvoiceId,
          invoiceNumber: 'INV-7777',
          amount: 300,
          currency: 'MXN',
          status: 'succeeded',
          gateway: 'card',
          invoice: {
            id: ids.highLevelInvoiceId,
            invoiceNumber: 'INV-7777',
            title: 'Anticipo ortodoncia',
            contactId: ids.ghlContactId
          }
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    const payment = await db.get('SELECT id, payment_provider, ghl_invoice_id FROM payments WHERE ghl_invoice_id = ?', [ids.highLevelInvoiceId])

    assert.equal(payment.payment_provider, 'highlevel')
    assert.equal(payment.ghl_invoice_id, ids.highLevelInvoiceId)
  } finally {
    await cleanup(ids)
  }
})

test('webhook de pago HighLevel prefiere fulfilledAt sobre created_at para payments.date', async () => {
  const ids = idsFor('webhookdate')
  const createdAt = '2026-05-01T08:00:00.000Z'
  const fulfilledAt = '2026-05-09T18:30:00.000Z'
  await cleanup(ids)
  await seedContact(ids)

  try {
    const res = createResponse()
    await handlePaymentWebhook({
      body: {
        payment: {
          id: ids.webhookPaymentId,
          contactId: ids.ghlContactId,
          invoiceId: ids.highLevelInvoiceId,
          invoiceNumber: 'INV-7788',
          amount: 300,
          currency: 'MXN',
          status: 'succeeded',
          gateway: 'cash',
          created_at: createdAt,
          fulfilledAt,
          invoice: {
            id: ids.highLevelInvoiceId,
            invoiceNumber: 'INV-7788',
            title: 'Pago con fecha real',
            contactId: ids.ghlContactId
          }
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    const payment = await db.get('SELECT date FROM payments WHERE ghl_invoice_id = ?', [ids.highLevelInvoiceId])

    assert.equal(payment.date, fulfilledAt)
  } finally {
    await cleanup(ids)
  }
})
