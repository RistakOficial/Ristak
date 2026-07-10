import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { db } from '../src/config/database.js'
import { globalSearch } from '../src/controllers/searchController.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const frontendRoot = join(repoRoot, 'frontend')

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
      return this
    }
  }
}

async function cleanupFixtures(ids) {
  await db.run('DELETE FROM payment_plans WHERE id = ?', [ids.planId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE id = ?', [ids.paymentId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE id = ?', [ids.appointmentId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

test('global search returns detail results for contacts, appointments, payments and payment plans', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const token = `globalrouting${suffix.replace(/[^a-z0-9]/gi, '')}`
  const ids = {
    contactId: `contact-${token}`,
    appointmentId: `appointment-${token}`,
    paymentId: `payment-${token}`,
    planId: `plan-${token}`
  }
  const createdAt = '2026-06-15T18:00:00.000Z'

  await cleanupFixtures(ids)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, phone, email, full_name, first_name, last_name, source, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ids.contactId,
      `+521${String(Date.now()).slice(-10)}`,
      `${token}@local.invalid`,
      `Contacto ${token}`,
      'Contacto',
      token,
      'test',
      5000,
      1,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time, date_added, date_updated
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ids.appointmentId,
      `calendar-${token}`,
      ids.contactId,
      `Cita ${token}`,
      'confirmed',
      'confirmed',
      createdAt,
      '2026-06-15T19:00:00.000Z',
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode, reference, description, date, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ids.paymentId,
      ids.contactId,
      2500,
      'MXN',
      'succeeded',
      'card',
      'live',
      `ref-${token}`,
      `Pago ${token}`,
      createdAt,
      createdAt,
      createdAt
    ])

    await db.run(`
      INSERT INTO payment_plans (
        id, contact_id, contact_name, name, title, status, total, currency, description, recurrence_label,
        start_date, next_run_at, source, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      ids.planId,
      ids.contactId,
      `Contacto ${token}`,
      `Plan ${token}`,
      `Plan ${token}`,
      'active',
      5000,
      'MXN',
      `Plan de pago ${token}`,
      'Mensual',
      createdAt,
      createdAt,
      'stripe',
      createdAt,
      createdAt
    ])

    const response = createResponse()
    await globalSearch({ query: { q: token }, user: { role: 'admin' } }, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body?.success, true)

    const categories = response.body.data.categories
    const contacts = categories.find(category => category.id === 'contacts')?.items || []
    const appointments = categories.find(category => category.id === 'appointments')?.items || []
    const payments = categories.find(category => category.id === 'payments')?.items || []
    const paymentPlans = categories.find(category => category.id === 'payment_plans')?.items || []

    assert.ok(contacts.some(item => item.type === 'contact' && item.id === ids.contactId))
    assert.ok(appointments.some(item => item.type === 'appointment' && item.id === ids.appointmentId && item.metadata.contactId === ids.contactId))
    assert.ok(payments.some(item => item.type === 'payment' && item.id === ids.paymentId && item.metadata.contactId === ids.contactId))
    assert.ok(paymentPlans.some(item => item.type === 'payment_plan' && item.id === ids.planId && item.metadata.contactId === ids.contactId))
  } finally {
    await cleanupFixtures(ids)
  }
})

test('global search uses canonical modal routes for selectable detail results', async () => {
  const globalSearchSource = await readFile(
    join(frontendRoot, 'src/components/common/GlobalSearch/GlobalSearch.tsx'),
    'utf8'
  )
  const globalSearchServiceSource = await readFile(
    join(frontendRoot, 'src/services/globalSearchService.ts'),
    'utf8'
  )

  assert.match(globalSearchServiceSource, /'payment_plan'/)
  assert.match(globalSearchSource, /`\/contacts\/all\/all\/\$\{encodeRouteId\(item\.id\)\}`/)
  assert.match(globalSearchSource, /`\/appointments\/appointments\/\$\{encodeRouteId\(item\.id\)\}`/)
  assert.match(globalSearchSource, /`\/transactions\/transactions\/all\/\$\{encodeRouteId\(item\.id\)\}`/)
  assert.match(globalSearchSource, /`\/transactions\/payment-plans\/\$\{encodeRouteId\(item\.id\)\}`/)
  assert.doesNotMatch(globalSearchSource, /params\.set\('open', 'contact'\)/)
  assert.doesNotMatch(globalSearchSource, /params\.set\('open', 'appointment'\)/)
  assert.doesNotMatch(globalSearchSource, /params\.set\('open', 'payment'\)/)
})

test('detail deep links mark results as handled only after opening their modal state', async () => {
  const contactsSource = await readFile(join(frontendRoot, 'src/pages/Contacts/Contacts.tsx'), 'utf8')
  const transactionsSource = await readFile(join(frontendRoot, 'src/pages/Transactions/Transactions.tsx'), 'utf8')
  const appointmentsSource = await readFile(join(frontendRoot, 'src/pages/Appointments/Appointments.tsx'), 'utf8')

  assert.doesNotMatch(contactsSource, /handledOpenContactRef\.current = contactId\s+let isMounted/)
  assert.match(contactsSource, /handledOpenContactRef\.current = contactId\s+setSelectedContact\(contact\)/)

  assert.doesNotMatch(transactionsSource, /handledOpenPaymentRef\.current = paymentId\s+let isMounted/)
  assert.match(transactionsSource, /handledOpenPaymentRef\.current = paymentId\s+handleEdit\(transaction\)/)

  assert.doesNotMatch(appointmentsSource, /handledOpenAppointmentRef\.current = appointmentId\s+let isMounted/)
  assert.match(appointmentsSource, /handledOpenAppointmentRef\.current = appointmentId[\s\S]*setSelectedEvent\(normalizedEvent\)[\s\S]*setIsModalOpen\(true\)/)
})
