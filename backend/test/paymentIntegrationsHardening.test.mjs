import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { clearHighLevelMirrorDataForLocationChange } from '../src/controllers/highlevelController.js'
import { handlePaymentWebhook } from '../src/controllers/webhooksController.js'
import { __invoicesSyncTestHooks } from '../src/services/invoicesSyncService.js'

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
    webhookPaymentId: `pit_ghl_payment_${name}_${suffix}`
  }
}

async function cleanup(ids) {
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
    'DELETE FROM contacts WHERE id = ? OR ghl_contact_id = ?',
    [ids.contactId, ids.ghlContactId]
  ).catch(() => undefined)
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
      '+5215550001111'
    ]
  )
}

async function seedManualPayment(ids, overrides = {}) {
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'MXN', ?, 'cash', 'live', 'manual', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.manualPaymentId,
      ids.contactId,
      overrides.amount ?? 500,
      overrides.status || 'paid',
      overrides.reference || 'Anticipo ortodoncia',
      overrides.title || 'Anticipo ortodoncia',
      overrides.description || 'Anticipo ortodoncia',
      overrides.ghlInvoiceId || null,
      overrides.invoiceNumber || null
    ]
  )
}

async function seedHighLevelMirror(ids, overrides = {}) {
  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, date, ghl_invoice_id, invoice_number,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'MXN', ?, 'card', 'live', 'highlevel', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      overrides.id || ids.highLevelInvoiceId,
      ids.contactId,
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
