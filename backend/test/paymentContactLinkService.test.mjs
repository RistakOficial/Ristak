import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  extractPaymentContactIdentity,
  resolvePaymentContactForGatewayPayment
} from '../src/services/paymentContactLinkService.js'

function suffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function cleanup(ids = {}) {
  const paymentIds = [ids.paymentId, ids.secondPaymentId].filter(Boolean)
  for (const paymentId of paymentIds) {
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId]).catch(() => undefined)
  }

  const contactIds = [ids.contactId, ids.createdContactId].filter(Boolean)
  for (const contactId of contactIds) {
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }

  if (ids.email) {
    const rows = await db.all('SELECT id FROM contacts WHERE email = ?', [ids.email]).catch(() => [])
    for (const row of rows || []) {
      await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [row.id]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [row.id]).catch(() => undefined)
    }
  }
}

async function insertPayment({ paymentId, provider = 'rebill', metadata = {} }) {
  await db.run(
    `INSERT INTO payments (
      id, amount, currency, status, payment_method, payment_provider,
      reference, title, public_payment_id, metadata_json, date, created_at, updated_at
    ) VALUES (?, 500, 'MXN', 'paid', ?, ?, ?, 'Pago Sites', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      paymentId,
      provider,
      provider,
      `ref-${paymentId}`,
      `pub-${paymentId}`,
      JSON.stringify(metadata)
    ]
  )
}

test('extractPaymentContactIdentity lee identidad desde Stripe, Conekta, Mercado Pago, CLIP y Rebill', () => {
  const baseRow = { metadata_json: '{}' }

  assert.deepEqual(
    extractPaymentContactIdentity({
      row: baseRow,
      provider: 'stripe',
      providerPayload: {
        receipt_email: 'stripe@example.test',
        payment_method: { billing_details: { name: 'Stripe Cliente', phone: '+52 656 742 6612' } }
      }
    }),
    {
      contactId: '',
      email: 'stripe@example.test',
      phone: '+526567426612',
      fullName: 'Stripe Cliente',
      provider: 'stripe'
    }
  )

  assert.deepEqual(
    extractPaymentContactIdentity({
      row: baseRow,
      provider: 'conekta',
      providerPayload: {
        customer_info: { name: 'Conekta Cliente', email: 'conekta@example.test', phone: '+52 656 742 6613' }
      }
    }),
    {
      contactId: '',
      email: 'conekta@example.test',
      phone: '+526567426613',
      fullName: 'Conekta Cliente',
      provider: 'conekta'
    }
  )

  assert.deepEqual(
    extractPaymentContactIdentity({
      row: baseRow,
      provider: 'mercadopago',
      providerPayload: {
        payer: {
          email: 'mp@example.test',
          first_name: 'Mercado',
          last_name: 'Pago',
          phone: { country_code: '52', area_code: '656', number: '7426614' }
        }
      }
    }),
    {
      contactId: '',
      email: 'mp@example.test',
      phone: '+526567426614',
      fullName: 'Mercado Pago',
      provider: 'mercadopago'
    }
  )

  assert.deepEqual(
    extractPaymentContactIdentity({
      row: baseRow,
      provider: 'clip',
      providerPayload: {
        customer: { email: 'clip@example.test', phone: '+52 656 742 6615', name: 'CLIP Cliente' }
      }
    }),
    {
      contactId: '',
      email: 'clip@example.test',
      phone: '+526567426615',
      fullName: 'Clip Cliente',
      provider: 'clip'
    }
  )

  assert.deepEqual(
    extractPaymentContactIdentity({
      row: baseRow,
      provider: 'rebill',
      providerPayload: {
        customer: { email: 'rebill@example.test', phoneNumber: '+52 656 742 6616', firstName: 'Rebill', lastName: 'Cliente' }
      }
    }),
    {
      contactId: '',
      email: 'rebill@example.test',
      phone: '+526567426616',
      fullName: 'Rebill Cliente',
      provider: 'rebill'
    }
  )
})

test('resolvePaymentContactForGatewayPayment liga un pago al contacto existente por email guardado en metadata', async () => {
  const id = suffix()
  const contactId = `contact-payment-link-${id}`
  const paymentId = `payment-link-existing-${id}`
  const email = `payment-link-existing-${id}@example.test`

  await cleanup({ contactId, paymentId, email })

  try {
    await db.run(
      `INSERT INTO contacts (id, email, full_name, source, created_at, updated_at)
       VALUES (?, ?, 'Cliente Existente', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, email]
    )
    await insertPayment({
      paymentId,
      provider: 'rebill',
      metadata: {
        contactEmail: email,
        contactName: 'Cliente Existente',
        paymentGate: { source: 'site_checkout' }
      }
    })

    const row = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
    const linkedContactId = await resolvePaymentContactForGatewayPayment(row, { provider: 'rebill', providerPayload: {} })

    assert.equal(linkedContactId, contactId)
    const updated = await db.get('SELECT contact_id, metadata_json FROM payments WHERE id = ?', [paymentId])
    assert.equal(updated.contact_id, contactId)
    const metadata = JSON.parse(updated.metadata_json)
    assert.equal(metadata.paymentContactResolution.matchedBy, 'email')
    assert.equal(metadata.paymentContactResolution.created, false)
  } finally {
    await cleanup({ contactId, paymentId, email })
  }
})

test('resolvePaymentContactForGatewayPayment crea contacto nuevo desde payload del provider cuando no existe', async () => {
  const id = suffix()
  const paymentId = `payment-link-created-${id}`
  const email = `payment-link-created-${id}@example.test`

  await cleanup({ paymentId, email })

  try {
    await insertPayment({
      paymentId,
      provider: 'mercadopago',
      metadata: {
        paymentGate: { source: 'site_checkout' }
      }
    })

    const row = await db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
    const linkedContactId = await resolvePaymentContactForGatewayPayment(row, {
      provider: 'mercadopago',
      providerPayload: {
        payer: {
          email,
          first_name: 'Nuevo',
          last_name: 'Cliente',
          phone: { country_code: '52', area_code: '656', number: '7426617' }
        }
      }
    })

    assert.ok(linkedContactId)
    const contact = await db.get('SELECT id, email, phone, full_name FROM contacts WHERE id = ?', [linkedContactId])
    assert.equal(contact.email, email)
    assert.equal(contact.phone, '+526567426617')
    assert.equal(contact.full_name, 'Nuevo Cliente')
    const updated = await db.get('SELECT contact_id FROM payments WHERE id = ?', [paymentId])
    assert.equal(updated.contact_id, linkedContactId)

    await cleanup({ paymentId, createdContactId: linkedContactId, email })
  } finally {
    await cleanup({ paymentId, email })
  }
})
