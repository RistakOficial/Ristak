import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  getContactById,
  getContacts,
  getContactStats
} from '../src/controllers/contactsController.js'

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function callController(handler, req = {}) {
  const response = createResponse()
  await handler({
    params: {},
    query: {},
    body: {},
    ...req
  }, response)
  assert.equal(response.statusCode, 200)
  return response.body
}

async function cleanupContact(contactId) {
  await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('Contactos clasifica como cliente a un contacto con pago test exitoso sin inflar LTV', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const contactId = `contact-test-customer-${suffix}`
  const paymentId = `payment-test-customer-${suffix}`
  const date = '2099-12-31'
  const createdAt = `${date}T18:00:00.000Z`
  const paidAt = `${date}T19:00:00.000Z`

  await cleanupContact(contactId)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, source, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'test_fixture', 0, 0, ?, ?)
    `, [
      contactId,
      `contact-test-customer-${suffix}@local.invalid`,
      'Contacto Pago Test Cliente',
      `visitor-test-customer-${suffix}`,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, paid_at, created_at, updated_at
      )
      VALUES (?, ?, 999, 'MXN', 'paid', 'card', 'test', ?, ?, ?, ?)
    `, [paymentId, contactId, paidAt, paidAt, paidAt, paidAt])

    const listResponse = await callController(getContacts, {
      query: {
        filter: 'customers',
        limit: '20',
        warmProfilePictures: 'false'
      }
    })
    const listedContact = listResponse.data.find(contact => contact.id === contactId)

    assert.ok(listedContact, 'el contacto con pago test debe aparecer en el filtro Clientes')
    assert.equal(listedContact.status, 'customer')
    assert.equal(listedContact.purchases, 1)
    assert.equal(listedContact.successfulPaymentsCount, 1)
    assert.equal(listedContact.ltv, 0)

    const detailResponse = await callController(getContactById, {
      params: { id: contactId },
      query: {
        warmProfilePictures: 'false',
        refreshExternalAppointments: 'false'
      }
    })

    assert.equal(detailResponse.data.status, 'customer')
    assert.equal(detailResponse.data.purchases, 1)
    assert.equal(detailResponse.data.successfulPaymentsCount, 1)
    assert.equal(detailResponse.data.ltv, 0)

    const statsResponse = await callController(getContactStats, {
      query: {
        startDate: date,
        endDate: date
      }
    })

    assert.equal(statsResponse.data.customers, 1)
    assert.equal(statsResponse.data.ltvTotal, 0)
  } finally {
    await cleanupContact(contactId)
  }
})
