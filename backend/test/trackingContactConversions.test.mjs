import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  getContactConversionsByDate,
  getContactConversionsList
} from '../src/controllers/trackingController.js'

function createResponse() {
  const response = {
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

  return response
}

async function callController(handler, query) {
  const response = createResponse()
  await handler({ query }, response)
  assert.equal(response.statusCode, 200)
  return response.body
}

async function cleanupContacts(contactIds) {
  for (const contactId of contactIds) {
    await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

test('contact conversions count customers from real successful live payments', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-03-17'
  const createdAt = `${date}T18:00:00.000Z`
  const contactIds = [
    `analytics-valid-customer-${suffix}`,
    `analytics-stale-customer-${suffix}`,
    `analytics-test-payment-${suffix}`,
    `analytics-failed-payment-${suffix}`
  ]

  await cleanupContacts(contactIds)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactIds[0],
      `analytics-valid-${suffix}@local.invalid`,
      'Analytics Cliente Real',
      `visitor-valid-${suffix}`,
      0,
      0,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactIds[1],
      `analytics-stale-${suffix}@local.invalid`,
      'Analytics Cliente Stale',
      `visitor-stale-${suffix}`,
      999,
      2,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactIds[2],
      `analytics-test-${suffix}@local.invalid`,
      'Analytics Pago Test',
      `visitor-test-${suffix}`,
      0,
      0,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactIds[3],
      `analytics-failed-${suffix}@local.invalid`,
      'Analytics Pago Fallido',
      `visitor-failed-${suffix}`,
      0,
      0,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)
    `, [
      `analytics-valid-payment-${suffix}`,
      contactIds[0],
      1200,
      'succeeded',
      'live',
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)
    `, [
      `analytics-test-payment-${suffix}`,
      contactIds[2],
      800,
      'succeeded',
      'test',
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, date, created_at, updated_at
      )
      VALUES (?, ?, ?, 'MXN', ?, 'card', ?, ?, ?, ?)
    `, [
      `analytics-failed-payment-${suffix}`,
      contactIds[3],
      900,
      'failed',
      'live',
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`,
      `${date}T19:00:00.000Z`
    ])

    const conversionsResponse = await callController(getContactConversionsByDate, {
      start: date,
      end: date
    })
    const day = conversionsResponse.data.find(row => row.date === date)

    assert.ok(day)
    assert.equal(day.registrations, 4)
    assert.equal(day.customers, 1)
    assert.equal(day.prospects, 3)

    const customersResponse = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'customers'
    })

    assert.deepEqual(customersResponse.data.contacts.map(contact => contact.id), [contactIds[0]])
    assert.equal(customersResponse.data.contacts[0].ltv, 1200)
    assert.equal(customersResponse.data.contacts[0].purchases, 1)
  } finally {
    await cleanupContacts(contactIds)
  }
})
